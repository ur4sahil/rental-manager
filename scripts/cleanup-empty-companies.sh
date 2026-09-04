#!/usr/bin/env bash
# Remove companies that were created and never used.
#
# The safe set is COMPUTED, never a hardcoded list of ids: a company
# qualifies only if it has no properties, no tenants and no journal
# entries, AND no members, users, bank connection, bank transactions or
# error log rows. In practice that leaves signups whose only trace is the
# chart of accounts the app creates automatically.
#
# Deliberately NOT deleted, because "unused" is not the same as "junk":
#   - anything with a bank connection (one such company has 277 transactions)
#   - anything with a member or an app_users row — a real person is attached
#   - archived companies, which are already soft-deleted
#
# Every affected row is dumped to a restore file before anything is
# removed, so the operation is reversible.
#
# Usage:
#   DB_URL='postgresql://...' ./scripts/cleanup-empty-companies.sh --dry-run
#   DB_URL='postgresql://...' ./scripts/cleanup-empty-companies.sh --commit

set -euo pipefail
: "${DB_URL:?set DB_URL}"
MODE="${1:---dry-run}"
BACKUP_DIR="${BACKUP_DIR:-./company-cleanup-backup}"

SAFE_SET="
  select c.id from companies c
   where c.archived_at is null
     and not exists (select 1 from properties           where company_id=c.id)
     and not exists (select 1 from tenants              where company_id=c.id)
     and not exists (select 1 from acct_journal_entries where company_id=c.id)
     and not exists (select 1 from company_members      where company_id=c.id)
     and not exists (select 1 from app_users            where company_id=c.id)
     and not exists (select 1 from bank_connection      where company_id=c.id)
     and not exists (select 1 from bank_feed_transaction where company_id=c.id)
     and not exists (select 1 from error_log            where company_id=c.id)
"

COUNT=$(psql "$DB_URL" -tAc "select count(*) from ($SAFE_SET) s")
echo "companies matching the safe set: $COUNT"

if [ "$MODE" = "--dry-run" ]; then
  echo
  echo "--- would delete (first 15) ---"
  psql "$DB_URL" -c "select c.id, c.name, c.created_at::date,
      (select count(*) from acct_accounts where company_id=c.id) accounts
     from companies c where c.id in ($SAFE_SET) order by c.created_at limit 15;"
  echo
  echo "--- held back, and why ---"
  psql "$DB_URL" -c "
    select c.name, c.id,
      (select count(*) from bank_feed_transaction where company_id=c.id) bank_txns,
      (select count(*) from company_members where company_id=c.id) members,
      (select count(*) from app_users where company_id=c.id) users,
      (select count(*) from error_log where company_id=c.id) errors
    from companies c
    where c.archived_at is null
      and not exists (select 1 from properties where company_id=c.id)
      and not exists (select 1 from tenants where company_id=c.id)
      and not exists (select 1 from acct_journal_entries where company_id=c.id)
      and c.id not in ($SAFE_SET)
    order by bank_txns desc;"
  echo
  echo "Dry run only. Re-run with --commit to apply."
  exit 0
fi

[ "$MODE" = "--commit" ] || { echo "unknown mode: $MODE (use --dry-run or --commit)" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$BACKUP_DIR/deleted-companies-$STAMP.sql"

echo "==> backing up every affected row to $BACKUP"
psql "$DB_URL" -tAc "select string_agg(quote_literal(id), ',') from ($SAFE_SET) s" > /tmp/.cleanup_ids.$$
IDS=$(cat /tmp/.cleanup_ids.$$); rm -f /tmp/.cleanup_ids.$$
[ -z "$IDS" ] && { echo "nothing to do"; exit 0; }

: > "$BACKUP"
for tbl in $(psql "$DB_URL" -tAc "
  select c.table_name from information_schema.columns c
    join information_schema.tables tb on tb.table_schema=c.table_schema and tb.table_name=c.table_name
   where c.table_schema='public' and c.column_name='company_id' and tb.table_type='BASE TABLE'"); do
  psql "$DB_URL" -tAc "copy (select * from public.$tbl where company_id in ($IDS)) to stdout" \
    | awk -v t="$tbl" 'NF{print "-- " t "\t" $0}' >> "$BACKUP" 2>/dev/null || true
done
psql "$DB_URL" -tAc "copy (select * from companies where id in ($IDS)) to stdout" \
  | awk 'NF{print "-- companies\t" $0}' >> "$BACKUP"
echo "   backup: $(wc -l < "$BACKUP") rows"

echo "==> deleting"
psql "$DB_URL" -q -v ON_ERROR_STOP=1 <<SQL
begin;
create temp table doomed as $SAFE_SET;
do \$\$
declare t record; n bigint; total bigint := 0;
begin
  for t in select c.table_name from information_schema.columns c
      join information_schema.tables tb on tb.table_schema=c.table_schema and tb.table_name=c.table_name
     where c.table_schema='public' and c.column_name='company_id'
       and tb.table_type='BASE TABLE' and c.table_name<>'companies'
  loop
    execute format('delete from public.%I where company_id in (select id from doomed)', t.table_name);
    get diagnostics n = row_count; total := total + n;
  end loop;
  raise notice 'child rows deleted: %', total;
end \$\$;
delete from companies where id in (select id from doomed);
commit;
SQL

echo
psql "$DB_URL" -c "select count(*) as companies_remaining from companies;"
echo "Done. Restore data is in $BACKUP"
