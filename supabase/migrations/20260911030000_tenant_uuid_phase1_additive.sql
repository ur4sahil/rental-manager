-- Tenant renumbering, PHASE 1 of 2: additive mapping only.
--
-- Goal: tenants.id becomes uuid, matching vendors.id and owners.id, so
-- there is one id style across the app.
--
-- This phase is ADDITIVE and INERT. It adds a uuid beside every existing
-- integer tenant reference and backfills it. Nothing reads the new
-- columns, no constraint depends on them, the app is unaffected, and the
-- whole phase reverses by dropping the added columns.
--
-- It is separated from the cutover deliberately. Phase 1 is where DATA
-- can be lost; phase 2 is where the schema changes. Proving the mapping
-- before touching a single constraint is what distinguishes this from
-- the acct_classes incident of 2026-09-04, where a primary-key rewrite
-- silently detached 13,947 journal lines and had to be repaired by
-- matching on address text.
--
-- VERIFIED on the test project (vpeewlplgxthckpidhxo) 2026-09-11:
--   218 tenants mapped
--   412 references across 12 tables, every one mapped, zero orphans
--   total tenant balance $432,247.66 unchanged
--
-- PHASE 2 (not in this file) still to do, and it must all happen in one
-- window with the app quiet:
--   * drop and recreate the ledger_entries view, which selects tenant_id
--   * drop 11 foreign keys, swap the columns, recreate the keys and PK
--   * DROP and CREATE 16 functions whose signatures declare the tenant id
--     as bigint/integer -- Postgres cannot change an argument type in
--     place. These are the money-posting functions: post_je_and_ledger,
--     insert_ledger_entry_with_balance, update_tenant_balance,
--     recompute_tenant_balance(_bulk), tenant_make_payment,
--     move_out_commit_state, delete_tenant_cascade, get_tenant_ledger,
--     get_tenant_id (returns bigint, used by RLS), _wizard_get_tenant_ar,
--     batch_post_rent_charges, commit_property_wizard (597 lines), the
--     two balance-sync triggers and derive_tenant_id_from_name.
--     NOTE: insert_ledger_entry_with_balance RETURNS bigint is the LEDGER
--     ENTRY id, not a tenant id. It must NOT be changed. A blind
--     bigint->uuid substitution across these bodies is wrong.
--   * recreate the RLS policies that call get_tenant_id
--
-- No app changes are needed: nothing in src/ coerces a tenant id to a
-- number (no Number(), parseInt() or safeNum() on one), so the ids are
-- already treated as opaque values.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS id_new uuid;
UPDATE tenants SET id_new = gen_random_uuid() WHERE id_new IS NULL;
ALTER TABLE tenants ALTER COLUMN id_new SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tenants_id_new_uq ON tenants(id_new);

ALTER TABLE acct_accounts               ADD COLUMN IF NOT EXISTS tenant_id_new uuid;
ALTER TABLE autopay_schedules           ADD COLUMN IF NOT EXISTS tenant_id_new uuid;
ALTER TABLE doc_generated               ADD COLUMN IF NOT EXISTS tenant_id_new uuid;
ALTER TABLE documents                   ADD COLUMN IF NOT EXISTS tenant_id_new uuid;
ALTER TABLE eviction_cases              ADD COLUMN IF NOT EXISTS tenant_id_new uuid;
ALTER TABLE leases                      ADD COLUMN IF NOT EXISTS tenant_id_new uuid;
ALTER TABLE ledger_entries_legacy_table ADD COLUMN IF NOT EXISTS tenant_id_new uuid;
ALTER TABLE messages                    ADD COLUMN IF NOT EXISTS tenant_id_new uuid;
ALTER TABLE payments                    ADD COLUMN IF NOT EXISTS tenant_id_new uuid;
ALTER TABLE recurring_journal_entries   ADD COLUMN IF NOT EXISTS tenant_id_new uuid;
ALTER TABLE tenant_invite_codes         ADD COLUMN IF NOT EXISTS tenant_id_new uuid;
ALTER TABLE work_orders                 ADD COLUMN IF NOT EXISTS tenant_id_new uuid;

UPDATE acct_accounts               c SET tenant_id_new = t.id_new FROM tenants t WHERE t.id = c.tenant_id;
UPDATE autopay_schedules           c SET tenant_id_new = t.id_new FROM tenants t WHERE t.id = c.tenant_id;
UPDATE doc_generated               c SET tenant_id_new = t.id_new FROM tenants t WHERE t.id = c.tenant_id;
UPDATE documents                   c SET tenant_id_new = t.id_new FROM tenants t WHERE t.id = c.tenant_id;
UPDATE eviction_cases              c SET tenant_id_new = t.id_new FROM tenants t WHERE t.id = c.tenant_id;
UPDATE leases                      c SET tenant_id_new = t.id_new FROM tenants t WHERE t.id = c.tenant_id;
UPDATE ledger_entries_legacy_table c SET tenant_id_new = t.id_new FROM tenants t WHERE t.id = c.tenant_id;
UPDATE messages                    c SET tenant_id_new = t.id_new FROM tenants t WHERE t.id = c.tenant_id;
UPDATE payments                    c SET tenant_id_new = t.id_new FROM tenants t WHERE t.id = c.tenant_id;
UPDATE recurring_journal_entries   c SET tenant_id_new = t.id_new FROM tenants t WHERE t.id = c.tenant_id;
UPDATE tenant_invite_codes         c SET tenant_id_new = t.id_new FROM tenants t WHERE t.id = c.tenant_id;
UPDATE work_orders                 c SET tenant_id_new = t.id_new FROM tenants t WHERE t.id = c.tenant_id;

-- Verification, which is the point of splitting the phases. Every table's
-- mapped count must equal its non-null count; a shortfall is a reference
-- pointing at a tenant that does not exist, and is the failure that
-- detaches rows silently.
DO $$
DECLARE r record; bad int := 0;
BEGIN
  FOR r IN
    SELECT 'acct_accounts' t, count(*) FILTER (WHERE tenant_id IS NOT NULL) o, count(*) FILTER (WHERE tenant_id_new IS NOT NULL) n FROM acct_accounts
    UNION ALL SELECT 'autopay_schedules', count(*) FILTER (WHERE tenant_id IS NOT NULL), count(*) FILTER (WHERE tenant_id_new IS NOT NULL) FROM autopay_schedules
    UNION ALL SELECT 'doc_generated', count(*) FILTER (WHERE tenant_id IS NOT NULL), count(*) FILTER (WHERE tenant_id_new IS NOT NULL) FROM doc_generated
    UNION ALL SELECT 'documents', count(*) FILTER (WHERE tenant_id IS NOT NULL), count(*) FILTER (WHERE tenant_id_new IS NOT NULL) FROM documents
    UNION ALL SELECT 'eviction_cases', count(*) FILTER (WHERE tenant_id IS NOT NULL), count(*) FILTER (WHERE tenant_id_new IS NOT NULL) FROM eviction_cases
    UNION ALL SELECT 'leases', count(*) FILTER (WHERE tenant_id IS NOT NULL), count(*) FILTER (WHERE tenant_id_new IS NOT NULL) FROM leases
    UNION ALL SELECT 'ledger_entries_legacy_table', count(*) FILTER (WHERE tenant_id IS NOT NULL), count(*) FILTER (WHERE tenant_id_new IS NOT NULL) FROM ledger_entries_legacy_table
    UNION ALL SELECT 'messages', count(*) FILTER (WHERE tenant_id IS NOT NULL), count(*) FILTER (WHERE tenant_id_new IS NOT NULL) FROM messages
    UNION ALL SELECT 'payments', count(*) FILTER (WHERE tenant_id IS NOT NULL), count(*) FILTER (WHERE tenant_id_new IS NOT NULL) FROM payments
    UNION ALL SELECT 'recurring_journal_entries', count(*) FILTER (WHERE tenant_id IS NOT NULL), count(*) FILTER (WHERE tenant_id_new IS NOT NULL) FROM recurring_journal_entries
    UNION ALL SELECT 'tenant_invite_codes', count(*) FILTER (WHERE tenant_id IS NOT NULL), count(*) FILTER (WHERE tenant_id_new IS NOT NULL) FROM tenant_invite_codes
    UNION ALL SELECT 'work_orders', count(*) FILTER (WHERE tenant_id IS NOT NULL), count(*) FILTER (WHERE tenant_id_new IS NOT NULL) FROM work_orders
  LOOP
    IF r.o <> r.n THEN
      RAISE WARNING 'tenant remap shortfall on %: % old refs, % mapped', r.t, r.o, r.n;
      bad := bad + 1;
    END IF;
  END LOOP;
  IF bad > 0 THEN
    RAISE EXCEPTION 'tenant remap incomplete on % table(s) — phase 2 must NOT run', bad;
  END IF;
END $$;
