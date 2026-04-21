-- rename_tenant_cascade: add p_property so the cascade only touches rows
-- belonging to this tenant's property. Previously the function updated
-- every table by name only, so two tenants named "John Smith" at
-- different addresses would have each other's payments/leases/docs/etc.
-- rewritten when either was renamed. Scoping by (name AND property)
-- closes that bleed.
--
-- Dropping the old 3-arg signature explicitly because the client is
-- switching to the 4-arg call in the same deploy; leaving both around
-- would make PostgREST pick arbitrarily between them.

DROP FUNCTION IF EXISTS rename_tenant_cascade(text, text, text);

CREATE OR REPLACE FUNCTION rename_tenant_cascade(
  p_company_id text,
  p_old_name text,
  p_new_name text,
  p_property text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_caller_email text;
  v_caller_role text;
BEGIN
  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
  WHERE company_id = p_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Unauthorized: only admins/owners can rename tenants';
  END IF;

  UPDATE payments          SET tenant = p_new_name      WHERE company_id = p_company_id AND tenant = p_old_name      AND property = p_property;
  UPDATE leases            SET tenant_name = p_new_name WHERE company_id = p_company_id AND tenant_name = p_old_name AND property = p_property;
  UPDATE work_orders       SET tenant = p_new_name      WHERE company_id = p_company_id AND tenant = p_old_name      AND property = p_property;
  UPDATE documents         SET tenant = p_new_name      WHERE company_id = p_company_id AND tenant = p_old_name      AND property = p_property;
  UPDATE ledger_entries    SET tenant = p_new_name      WHERE company_id = p_company_id AND tenant = p_old_name      AND property = p_property;
  UPDATE messages          SET tenant = p_new_name      WHERE company_id = p_company_id AND tenant = p_old_name      AND property = p_property;
  UPDATE autopay_schedules SET tenant = p_new_name      WHERE company_id = p_company_id AND tenant = p_old_name      AND property = p_property;
  UPDATE properties        SET tenant = p_new_name      WHERE company_id = p_company_id AND tenant = p_old_name      AND address  = p_property;
END;
$$;
