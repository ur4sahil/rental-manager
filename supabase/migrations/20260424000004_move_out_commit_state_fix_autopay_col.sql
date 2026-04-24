-- Fix: 20260424000003 used autopay_schedules.enabled, but the real column
-- is autopay_schedules.active. The whole RPC raised and rolled back, so
-- no state changes + no GL entries — the Move-Out Wizard surfaced this
-- as "column \"enabled\" of relation \"autopay_schedules\" does not exist".
--
-- Only the autopay UPDATE is wrong. Republish the full function
-- byte-for-byte from 20260424000003 with just that one column name
-- patched, so CREATE OR REPLACE keeps a clean single definition.

CREATE OR REPLACE FUNCTION move_out_commit_state(
  p_company_id     text,
  p_lease_id       uuid,
  p_tenant_id      bigint,
  p_tenant_name    text,
  p_property       text,
  p_move_out_date  date,
  p_archived_by    text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_lease_rows    integer := 0;
  v_tenant_rows   integer := 0;
  v_property_rows integer := 0;
  v_autopay_rows  integer := 0;
  v_recur_rows    integer := 0;
BEGIN
  IF p_company_id IS NULL OR p_company_id = '' THEN
    RAISE EXCEPTION 'company_id required';
  END IF;
  IF p_lease_id IS NULL THEN
    RAISE EXCEPTION 'lease_id required';
  END IF;
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id required';
  END IF;
  IF p_property IS NULL OR p_property = '' THEN
    RAISE EXCEPTION 'property required';
  END IF;
  IF p_move_out_date IS NULL THEN
    RAISE EXCEPTION 'move_out_date required';
  END IF;

  -- 1. Terminate lease
  UPDATE leases
     SET status = 'terminated',
         end_date = p_move_out_date
   WHERE id = p_lease_id
     AND company_id = p_company_id;
  GET DIAGNOSTICS v_lease_rows = ROW_COUNT;
  IF v_lease_rows = 0 THEN
    RAISE EXCEPTION 'lease not found or not owned by company';
  END IF;

  -- 2. Archive tenant
  UPDATE tenants
     SET lease_status = 'inactive',
         move_out = p_move_out_date,
         archived_at = now(),
         archived_by = COALESCE(p_archived_by, 'system')
   WHERE id = p_tenant_id
     AND company_id = p_company_id;
  GET DIAGNOSTICS v_tenant_rows = ROW_COUNT;
  IF v_tenant_rows = 0 THEN
    RAISE EXCEPTION 'tenant not found or not owned by company';
  END IF;

  -- 3. Property → vacant (primary tenant cleared + lease_end nulled)
  UPDATE properties
     SET status = 'vacant',
         tenant = '',
         lease_end = NULL
   WHERE company_id = p_company_id
     AND address = p_property;
  GET DIAGNOSTICS v_property_rows = ROW_COUNT;

  -- 4. Deactivate this tenant's autopay on this property.
  --    Scoped by tenant name to avoid disabling a same-named tenant
  --    at a different property; also scoped by property so a tenant
  --    moving out of Address A doesn't stop their autopay at Address B.
  UPDATE autopay_schedules
     SET active = false
   WHERE company_id = p_company_id
     AND tenant = p_tenant_name
     AND property = p_property;
  GET DIAGNOSTICS v_autopay_rows = ROW_COUNT;

  -- 5. Deactivate rent-style recurring for THIS tenant only.
  --    Mortgage / HOA / other property-level recurrings have a
  --    null/empty tenant_name and stay untouched.
  UPDATE recurring_journal_entries
     SET status = 'inactive',
         archived_at = now()
   WHERE company_id = p_company_id
     AND property = p_property
     AND tenant_name = p_tenant_name
     AND status = 'active';
  GET DIAGNOSTICS v_recur_rows = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok',           true,
    'lease_rows',   v_lease_rows,
    'tenant_rows',  v_tenant_rows,
    'property_rows', v_property_rows,
    'autopay_rows', v_autopay_rows,
    'recur_rows',   v_recur_rows
  );
END;
$$;

GRANT EXECUTE ON FUNCTION move_out_commit_state(text, uuid, bigint, text, text, date, text)
  TO authenticated, service_role;
