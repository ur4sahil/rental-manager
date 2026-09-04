#!/usr/bin/env bash
# Rebuild the TEST database from a copy of PRODUCTION, reduced to one company.
#
# Production is only ever READ (pg_dump). Everything that writes targets the
# test database, behind three guards: the two URLs must differ, the
# destination must not be any known production project, and the source must
# be rental-manager production.
#
# Uses pg_dump/psql directly rather than `supabase db dump`, which requires
# a running Docker daemon.
#
# Usage:
#   export PROD_DB_URL='postgresql://postgres:<pw>@db.hoymytpyaudjvsgiiibn.supabase.co:5432/postgres'
#   export TEST_DB_URL='postgresql://postgres.vpeewlplgxthckpidhxo:<pw>@aws-0-us-east-1.pooler.supabase.com:5432/postgres'
#   ./scripts/clone-prod-to-test.sh
#
# Passwords: Supabase dashboard -> Project Settings -> Database. URL-encode
# them ('#' becomes %23, '!' becomes %21).

set -euo pipefail

: "${PROD_DB_URL:?set PROD_DB_URL (read-only source)}"
: "${TEST_DB_URL:?set TEST_DB_URL (destination — will be OVERWRITTEN)}"

# Which company survives the prune. Sahil LLC by default: it carries the
# full QuickBooks import, which is where the interesting bugs live.
KEEP_COMPANY="${KEEP_COMPANY:-f56be35c-c80d-4f47-8624-cbb317f85461}"
PROD_REF="hoymytpyaudjvsgiiibn"
TEST_REF="vpeewlplgxthckpidhxo"

[ "$PROD_DB_URL" = "$TEST_DB_URL" ] && { echo "REFUSING: source and destination are identical." >&2; exit 1; }

# This script drops the public schema on its destination, so every known
# production database is named here and refused outright.
for ref in hoymytpyaudjvsgiiibn ifjzvwvuxkdcdqqhtadl kaaofehjinxvmjcfumjx axifjxeiaghpevpmdymg; do
  if [[ "$TEST_DB_URL" == *"$ref"* ]]; then
    echo "REFUSING: TEST_DB_URL points at a PRODUCTION project ($ref)." >&2
    echo "This script drops and recreates the public schema on its target." >&2
    exit 1
  fi
done
[[ "$TEST_DB_URL" == *"$TEST_REF"* ]] || { echo "REFUSING: TEST_DB_URL is not the test project ($TEST_REF)." >&2; exit 1; }
[[ "$PROD_DB_URL" == *"$PROD_REF"* ]] || { echo "REFUSING: PROD_DB_URL is not rental-manager production." >&2; exit 1; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
echo "==> staging dumps in $WORK"

# --no-owner keeps roles out of it, but privileges MUST be kept: without the
# GRANTs to anon/authenticated/service_role, PostgREST can read nothing and
# the app comes up empty with no obvious cause.
echo "==> 1/6 schema from production (read-only)"
pg_dump "$PROD_DB_URL" --schema=public --schema-only --no-owner --quote-all-identifiers -f "$WORK/schema.sql"

echo "==> 2/6 data from production (read-only)"
pg_dump "$PROD_DB_URL" --schema=public --data-only --no-owner --disable-triggers --quote-all-identifiers -f "$WORK/data.sql"

echo "==> 3/6 auth users (so existing logins keep working)"
pg_dump "$PROD_DB_URL" --data-only --no-owner --quote-all-identifiers \
  --table=auth.users --table=auth.identities -f "$WORK/auth.sql"

echo "==> 4/6 resetting the test database"
psql "$TEST_DB_URL" -q -v ON_ERROR_STOP=1 -c \
  "drop schema if exists public cascade; create schema public;
   grant usage on schema public to anon, authenticated, service_role;"
psql "$TEST_DB_URL" -q -c "truncate auth.identities, auth.users cascade;" >/dev/null 2>&1 || true

# session_replication_role=replica suppresses BOTH foreign keys and the app's
# own triggers during load. Without it the audit and tenant-balance triggers
# fire once per row: slow, and it manufactures audit history that never
# happened. ON_ERROR_STOP stays off — the dump's own DISABLE TRIGGER lines
# fail harmlessly on system FK triggers, which we are not superuser for.
echo "==> 5/6 restoring into test"
psql "$TEST_DB_URL" -q -c "set session_replication_role=replica;" -f "$WORK/schema.sql" >/dev/null 2>&1
psql "$TEST_DB_URL" -q -c "set session_replication_role=replica;" -f "$WORK/data.sql"   >/dev/null 2>&1
psql "$TEST_DB_URL" -q -c "set session_replication_role=replica;" -f "$WORK/auth.sql"   >/dev/null 2>&1

echo "==> 6/6 pruning to a single company, and restoring access to it"
psql "$TEST_DB_URL" -q -v ON_ERROR_STOP=1 <<SQL
set session_replication_role = replica;
do \$\$
declare t record; n bigint; total bigint := 0;
begin
  -- BASE TABLE only: public.ledger_entries is a view over a window
  -- function and cannot be deleted from.
  for t in
    select c.table_name from information_schema.columns c
      join information_schema.tables tb
        on tb.table_schema=c.table_schema and tb.table_name=c.table_name
     where c.table_schema='public' and c.column_name='company_id'
       and tb.table_type='BASE TABLE'
     order by c.table_name
  loop
    execute format('delete from public.%I where company_id is distinct from %L', t.table_name, '${KEEP_COMPANY}');
    get diagnostics n = row_count; total := total + n;
  end loop;
  raise notice 'pruned % rows', total;
end \$\$;

-- companies keys on id, not company_id, so it escapes the sweep above.
delete from companies where id <> '${KEEP_COMPANY}';

-- Access is granted by company_members, NOT app_users: every RLS policy
-- routes through get_user_company_ids(), which reads company_members by
-- the JWT email. Prune it and nobody can open the company at all.
insert into company_members (company_id, user_email, user_name, role, status, auth_user_id, invited_by)
select '${KEEP_COMPANY}', u.email, split_part(u.email,'@',1), 'admin', 'active', u.id, 'clone-prod-to-test'
  from auth.users u
 where lower(u.email) in ('aggarwalsahil66@gmail.com','admin@propmanager.com')
   and not exists (select 1 from company_members m
                    where m.company_id='${KEEP_COMPANY}' and lower(m.user_email)=lower(u.email));

insert into app_users (id, email, name, role, company_id, user_type, preferences, password_set_at, created_at)
select u.id, u.email, split_part(u.email,'@',1), 'admin', '${KEEP_COMPANY}', 'pm', '{}'::jsonb, now(), now()
  from auth.users u
 where lower(u.email) in ('aggarwalsahil66@gmail.com','admin@propmanager.com')
on conflict (id) do nothing;
SQL

echo
echo "==> verifying"
psql "$TEST_DB_URL" -t -A -F' | ' -c "
  select 'companies', count(*) from companies
  union all select 'properties', count(*) from properties
  union all select 'tenants', count(*) from tenants
  union all select 'journal entries', count(*) from acct_journal_entries
  union all select 'journal lines', count(*) from acct_journal_lines
  union all select 'members with access', count(*) from company_members where status='active'
  union all select 'debits', coalesce(round(sum(debit)::numeric,2),0)::text from acct_journal_lines
  union all select 'credits', coalesce(round(sum(credit)::numeric,2),0)::text from acct_journal_lines
  union all select 'ORPHANED class ids (must be 0)',
    (select count(*) from acct_journal_lines l left join acct_classes c on c.id=l.class_id
      where l.class_id is not null and c.id is null);"

echo
echo "Done — test database rebuilt from production as of $(date '+%Y-%m-%d %H:%M')."
echo "It holds real tenant data, so the test site must keep NOTIFICATIONS_PAUSED=true,"
echo "dead Stripe keys and PLAID_ENV=sandbox. Those are set on the 'staging' branch."
