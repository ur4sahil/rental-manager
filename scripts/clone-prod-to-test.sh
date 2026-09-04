#!/usr/bin/env bash
# Refresh the TEST database from a copy of PRODUCTION.
#
# Safe by construction: production is only ever READ. Everything that
# writes targets the test database, and the script refuses to run if the
# two URLs are the same.
#
# Usage:
#   export PROD_DB_URL='postgresql://postgres.<prod-ref>:<pw>@<host>:5432/postgres'
#   export TEST_DB_URL='postgresql://postgres.<test-ref>:<pw>@<host>:5432/postgres'
#   ./scripts/clone-prod-to-test.sh
#
# Connection strings: Supabase dashboard -> Project Settings -> Database
# -> Connection string -> URI (use the Session pooler, port 5432).

set -euo pipefail

: "${PROD_DB_URL:?set PROD_DB_URL (read-only source)}"
: "${TEST_DB_URL:?set TEST_DB_URL (destination — will be OVERWRITTEN)}"

if [ "$PROD_DB_URL" = "$TEST_DB_URL" ]; then
  echo "REFUSING: PROD_DB_URL and TEST_DB_URL are identical." >&2
  exit 1
fi

# Guard against a fat-fingered swap. This script DROPS the public schema
# on its destination, so every known production database is named here
# and refused outright -- not just this app's. A misdirected run against
# any of them would be unrecoverable without a backup.
PROTECTED_REFS=(
  "hoymytpyaudjvsgiiibn"   # rental-manager  (PropManager production)
  "ifjzvwvuxkdcdqqhtadl"   # tradelog        (LogStocks production)
  "kaaofehjinxvmjcfumjx"   # flipradar       (FlipRadar production)
  "axifjxeiaghpevpmdymg"   # taskforge       (TaskForge production)
)
for ref in "${PROTECTED_REFS[@]}"; do
  if [[ "$TEST_DB_URL" == *"$ref"* ]]; then
    echo "REFUSING: TEST_DB_URL points at a PRODUCTION project ($ref)." >&2
    echo "This script drops and recreates the public schema on its target." >&2
    exit 1
  fi
done

# The source must be this app's production database, not another app's.
if [[ "$PROD_DB_URL" != *"hoymytpyaudjvsgiiibn"* ]]; then
  echo "REFUSING: PROD_DB_URL is not the rental-manager production project." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "==> Working in $WORK"

echo "==> 1/5 Dumping production roles"
npx supabase db dump --db-url "$PROD_DB_URL" --role-only -f "$WORK/roles.sql"

echo "==> 2/5 Dumping production schema"
npx supabase db dump --db-url "$PROD_DB_URL" -f "$WORK/schema.sql"

echo "==> 3/5 Dumping production data (public + auth, so logins still work)"
npx supabase db dump --db-url "$PROD_DB_URL" --data-only --schema public,auth -f "$WORK/data.sql"

echo "==> 4/5 Resetting the test database"
# Drop and recreate public so a re-run is repeatable rather than additive.
psql "$TEST_DB_URL" -v ON_ERROR_STOP=1 -c \
  "drop schema if exists public cascade; create schema public;
   grant usage on schema public to anon, authenticated, service_role;
   grant all on schema public to postgres;"
psql "$TEST_DB_URL" -v ON_ERROR_STOP=1 -c "truncate auth.users cascade;" || true

echo "==> 5/5 Restoring into test"
psql "$TEST_DB_URL" -v ON_ERROR_STOP=1 -f "$WORK/roles.sql"  || true
psql "$TEST_DB_URL" -v ON_ERROR_STOP=1 -f "$WORK/schema.sql"
psql "$TEST_DB_URL" -v ON_ERROR_STOP=1 -f "$WORK/data.sql"

echo
echo "==> Verifying the copy"
psql "$TEST_DB_URL" -t -A -F' | ' -c "
  select 'companies', count(*) from companies
  union all select 'properties', count(*) from properties
  union all select 'journal lines', count(*) from acct_journal_lines
  union all select 'orphaned class ids',
    (select count(*) from acct_journal_lines l
       left join acct_classes c on c.id=l.class_id
      where l.class_id is not null and c.id is null);"

echo
echo "Done. The test database is now a copy of production as of $(date '+%Y-%m-%d %H:%M')."
echo "Reminder: the test site must keep NOTIFICATIONS_PAUSED=true, Stripe TEST keys,"
echo "and sandbox bank credentials — a data copy includes real tenant emails."
