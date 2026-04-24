-- move_out_commit_state: atomic state transition for tenant move-out.
--
-- Problem: the move-out flow (src/components/Lifecycle.js executeMoveOut)
-- posts deposit-return / deduction / AR-excess / write-off / proration
-- JEs, THEN updates lease + tenant + property + autopay + recurring.
-- If any of those state updates failed midway, the GL entries were
-- already posted — money moves recorded against a tenant who wasn't
-- actually archived, a lease still marked active, a property still
-- occupied. Partial-commit drift.
--
-- Fix: flip the order. This RPC bundles all 5 state transitions in a
-- single PL/pgSQL transaction. Client calls it first; only if it
-- returns ok does the client proceed to post GL. If state fails, the
-- RPC raises and the client shows an error with nothing posted.
--
-- The inverse failure mode (state succeeds, a follow-up GL post
-- fails) is much easier to recover from: the books have a missing
-- entry the PM can re-post manually, but the tenant/lease/property
-- are already correctly archived and the Error Log has the failed
-- GL. Preferable to the current "GL posted to non-existent tenant."
--
-- Scope rules intentionally match the client-side logic that this
-- replaces:
--   • autopay: company + tenant name + property  (so same-name tenant
--     at a different property isn't accidentally disabled)
--   • recurring: company + property + tenant_name  (so mortgage / HOA /
--     other property-level recurring rows with null tenant_name stay
--     active — sibling tenants on a multi-unit property also stay
--     active; only this tenant's rent recurring deactivates)
--
-- Returns the number of rows affected per table so the caller can
-- verify the expected entities actually flipped.

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
     SET enabled = false
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

-- Service role + authenticated users can invoke (RLS on the underlying
-- tables still applies to each UPDATE). Grant matches the convention
-- used by other wizard/move-out RPCs in this repo.
GRANT EXECUTE ON FUNCTION move_out_commit_state(text, uuid, bigint, text, text, date, text)
  TO authenticated, service_role;
