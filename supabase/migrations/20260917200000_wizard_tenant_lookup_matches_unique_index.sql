-- The wizard could not save a property whose tenant's lease had ended.
--
-- 1 Barberry Ct 40-1 showed "Pamela Jones" on the wizard's Tenant & Lease
-- card, showed TENANT "—" on the Properties list, and refused to save with:
--
--   duplicate key value violates unique constraint
--   "idx_tenants_unique_name_property"
--
-- All three are one bug. commit_property_wizard looks for the existing tenant
-- two ways before deciding between UPDATE and INSERT:
--
--   1. property + email
--   2. property + lease_status = 'active'
--
-- but the constraint it can violate is
--
--   UNIQUE (company_id, name, property) WHERE archived_at IS NULL
--
-- and NEITHER lookup matches on name. Pamela's lease ran 2024-08-15 to
-- 2025-07-31, so her row is not 'active' (lookup 2 misses), and the email in
-- the wizard differs from the one stored (lookup 1 misses). The function
-- therefore took the INSERT branch against a row that already existed, the
-- index refused it, and -- because the commit is one atomic transaction --
-- the entire save rolled back. The "UPDATE properties SET tenant = ..." that
-- makes the tenant appear on the Properties list runs inside that same
-- transaction, which is why the list column stayed empty: nothing was ever
-- committed, only the wizard's own form still showed her.
--
-- Reproduced on the test database before writing this: with an unarchived,
-- non-active tenant row present, lookup 1 returned NULL, lookup 2 returned
-- NULL, and a lookup on (company_id, name, property) returned the row the
-- index would collide with.
--
-- THE FIX: look up the tenant by exactly what the unique index constrains,
-- and do it FIRST.
--
-- Order matters and is not arbitrary. The UPDATE sets name = v_tenant_name,
-- so it is only guaranteed not to violate the index if it targets the row
-- that already holds that name at that property. If such a row exists we
-- must update it; if it does not, then no unarchived row holds that
-- (name, property) and every other branch -- including INSERT -- is safe.
-- Putting the name lookup anywhere other than first leaves a case where the
-- function renames some other row INTO the duplicate and fails again.
--
-- The existing email and active-lease lookups are kept, in order, as the
-- fallbacks that handle a renamed tenant.
--
-- Patched in place from pg_get_functiondef rather than restated: no migration
-- in this repo holds the current body (the portal-credential work was applied
-- directly to the database), so re-declaring the whole function here would
-- silently revert whatever the repo copy is missing. This edits what is
-- actually deployed and raises if the text it expects is not there.
DO $mig$
DECLARE
  v_def text;
  v_anchor text;
  v_replacement text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'commit_property_wizard';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'commit_property_wizard not found';
  END IF;

  v_anchor := $a$    SELECT id INTO v_existing_tenant_id FROM tenants
    WHERE company_id = v_company_id
      AND property = v_address
      AND lower(COALESCE(email,'')) = lower(COALESCE(v_tenant->>'tenant_email',''))
      AND archived_at IS NULL
    LIMIT 1;$a$;

  v_replacement := $b$    -- Match what idx_tenants_unique_name_property constrains, FIRST.
    -- If a row already holds this name at this property, it is the only row
    -- the UPDATE can safely target; if none does, the INSERT cannot collide.
    SELECT id INTO v_existing_tenant_id FROM tenants
    WHERE company_id = v_company_id
      AND name = v_tenant_name
      AND property = v_address
      AND archived_at IS NULL
    LIMIT 1;

    IF v_existing_tenant_id IS NULL THEN
    SELECT id INTO v_existing_tenant_id FROM tenants
    WHERE company_id = v_company_id
      AND property = v_address
      AND lower(COALESCE(email,'')) = lower(COALESCE(v_tenant->>'tenant_email',''))
      AND archived_at IS NULL
    LIMIT 1;
    END IF;$b$;

  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'commit_property_wizard: expected tenant email lookup not found -- the function has changed, re-derive this patch';
  END IF;

  EXECUTE replace(v_def, v_anchor, v_replacement);
END $mig$;

-- Prove the new lookup is present and the old one survives as the fallback.
DO $verify$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'commit_property_wizard';

  IF position('AND name = v_tenant_name' IN v_def) = 0 THEN
    RAISE EXCEPTION 'name lookup did not land';
  END IF;
  IF position($c$lower(COALESCE(v_tenant->>'tenant_email','')$c$ IN v_def) = 0 THEN
    RAISE EXCEPTION 'email fallback was lost';
  END IF;
  IF position($d$AND lease_status = 'active' AND archived_at IS NULL$d$ IN v_def) = 0 THEN
    RAISE EXCEPTION 'active-lease fallback was lost';
  END IF;
END $verify$;
