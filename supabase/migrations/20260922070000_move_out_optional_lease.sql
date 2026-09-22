-- Move-out failed for any tenant without an active `leases` row (imported /
-- legacy / wizard-without-lease). The client synthesises a lease with id=null
-- for them (Lifecycle.js), but move_out_commit_state hard-required p_lease_id
-- and raised 'lease_id required', rolling back with nothing posted (Beatriz
-- Argria Vera / 6950 Hawthorne). Make lease termination conditional: skip it
-- when there's no lease, still archive the tenant + vacate the property +
-- disable autopay/recurring. Also match recurring by tenant_id OR name so a
-- normalised tenant_name still deactivates.
CREATE OR REPLACE FUNCTION public.move_out_commit_state(p_company_id text, p_lease_id uuid, p_tenant_id bigint, p_tenant_name text, p_property text, p_move_out_date date, p_archived_by text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE
  v_lease_rows integer := 0; v_tenant_rows integer := 0; v_property_rows integer := 0;
  v_autopay_rows integer := 0; v_recur_rows integer := 0;
BEGIN
  IF p_company_id IS NULL OR p_company_id = '' THEN RAISE EXCEPTION 'company_id required'; END IF;
  IF p_tenant_id IS NULL THEN RAISE EXCEPTION 'tenant_id required'; END IF;
  IF p_property IS NULL OR p_property = '' THEN RAISE EXCEPTION 'property required'; END IF;
  IF p_move_out_date IS NULL THEN RAISE EXCEPTION 'move_out_date required'; END IF;

  IF p_lease_id IS NOT NULL THEN
    UPDATE leases SET status='terminated', end_date=p_move_out_date
     WHERE id=p_lease_id AND company_id=p_company_id;
    GET DIAGNOSTICS v_lease_rows = ROW_COUNT;
    IF v_lease_rows = 0 THEN RAISE EXCEPTION 'lease not found or not owned by company'; END IF;
  END IF;

  UPDATE tenants SET lease_status='inactive', move_out=p_move_out_date, archived_at=now(),
    archived_by=COALESCE(p_archived_by,'system')
   WHERE id=p_tenant_id AND company_id=p_company_id;
  GET DIAGNOSTICS v_tenant_rows = ROW_COUNT;
  IF v_tenant_rows = 0 THEN RAISE EXCEPTION 'tenant not found or not owned by company'; END IF;

  UPDATE properties SET status='vacant', tenant='', lease_end=NULL
   WHERE company_id=p_company_id AND address=p_property;
  GET DIAGNOSTICS v_property_rows = ROW_COUNT;

  UPDATE autopay_schedules SET active=false
   WHERE company_id=p_company_id AND tenant=p_tenant_name AND property=p_property;
  GET DIAGNOSTICS v_autopay_rows = ROW_COUNT;

  UPDATE recurring_journal_entries SET status='inactive', archived_at=now()
   WHERE company_id=p_company_id AND property=p_property AND status='active'
     AND (tenant_id=p_tenant_id OR tenant_name=p_tenant_name);
  GET DIAGNOSTICS v_recur_rows = ROW_COUNT;

  RETURN jsonb_build_object('ok',true,'lease_rows',v_lease_rows,'tenant_rows',v_tenant_rows,
    'property_rows',v_property_rows,'autopay_rows',v_autopay_rows,'recur_rows',v_recur_rows);
END;
$function$;
