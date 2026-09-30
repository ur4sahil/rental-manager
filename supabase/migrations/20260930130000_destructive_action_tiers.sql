-- Security audit 2026-09-30, finding #4 — who may do what (Sahil's decisions):
--   (1) the company row: admin only
--   (2) posted journal entries: nobody hard-deletes them; void/reverse only
--   (3) deleting leases, owners, tenants, autopay rows outright, archiving a
--       property and running move-out: management tier (admin, pm, manager).
--       Other staff REQUEST it through the approval queue; the approver
--       (management) carries it out, except move-out, which the requester
--       runs themselves once approved.

-- ────────────────────────────────────────────────────────────────────────
-- (1) companies: members read; only an admin changes or removes the row
-- ────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS companies_member_access ON public.companies;
CREATE POLICY companies_member_select ON public.companies FOR SELECT
  USING (id IN (SELECT public.get_user_company_ids()));
CREATE POLICY companies_admin_update ON public.companies FOR UPDATE
  USING (public.is_company_admin(id)) WITH CHECK (public.is_company_admin(id));
CREATE POLICY companies_admin_delete ON public.companies FOR DELETE
  USING (public.is_company_admin(id));

-- ────────────────────────────────────────────────────────────────────────
-- (2) journal entries: staff read/insert/update; DELETE only drafts, and a
--     posted entry with lines can never be deleted from the browser.
-- ────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS acct_journal_entries_staff ON public.acct_journal_entries;
CREATE POLICY acct_journal_entries_select ON public.acct_journal_entries FOR SELECT
  USING (company_id IN (SELECT public.get_staff_company_ids()));
CREATE POLICY acct_journal_entries_insert ON public.acct_journal_entries FOR INSERT
  WITH CHECK (company_id IN (SELECT public.get_staff_company_ids()));
CREATE POLICY acct_journal_entries_update ON public.acct_journal_entries FOR UPDATE
  USING (company_id IN (SELECT public.get_staff_company_ids()))
  WITH CHECK (company_id IN (SELECT public.get_staff_company_ids()));
CREATE POLICY acct_journal_entries_delete ON public.acct_journal_entries FOR DELETE
  USING (company_id IN (SELECT public.get_staff_company_ids()) AND status IS DISTINCT FROM 'posted');

-- Belt and braces: a posted entry that has lines is immutable history. An
-- orphan header (posted, zero lines -- a crashed post) may still be cleaned
-- up, which is what the app's orphan-cleanup and post_bank_transaction's
-- retry path do. SECURITY INVOKER: current_user is 'authenticated' for a
-- browser call and the function owner inside a definer / service path.
CREATE OR REPLACE FUNCTION public.trg_je_no_hard_delete()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_user = 'authenticated' AND OLD.status = 'posted'
     AND EXISTS (SELECT 1 FROM acct_journal_lines l WHERE l.journal_entry_id = OLD.id) THEN
    RAISE EXCEPTION 'Posted journal entry % cannot be deleted. Void or reverse it instead.', COALESCE(OLD.number, OLD.id::text)
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $function$;
DROP TRIGGER IF EXISTS trg_je_no_hard_delete ON public.acct_journal_entries;
CREATE TRIGGER trg_je_no_hard_delete BEFORE DELETE ON public.acct_journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.trg_je_no_hard_delete();

-- ────────────────────────────────────────────────────────────────────────
-- (3) leases / owners / tenants / autopay: staff read+insert+update,
--     management tier deletes. The UPDATE-side archive/terminate gates
--     (trg_mgmt_gate) already exist; DELETE was the way around them.
-- ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['leases','owners','tenants','autopay_schedules'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_staff', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write', t);
    -- autopay_schedules used a shorter name for its staff policy.
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'autopay_staff', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (public.is_company_staff(company_id))', t || '_staff_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (public.is_company_staff(company_id))', t || '_staff_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id))', t || '_staff_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (public.is_management_tier(company_id))', t || '_management_delete', t);
  END LOOP;
END $$;

-- ────────────────────────────────────────────────────────────────────────
-- Approval queue: a request is filed by its requester and decided by
-- management. has_write_access FOR ALL let the requester approve their own.
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE public.property_change_requests
  ADD COLUMN IF NOT EXISTS target_id text,
  ADD COLUMN IF NOT EXISTS executed_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pcr_one_pending_per_target
  ON public.property_change_requests (company_id, request_type, target_id)
  WHERE status = 'pending' AND target_id IS NOT NULL;

DROP POLICY IF EXISTS property_change_requests_write ON public.property_change_requests;
CREATE POLICY property_change_requests_insert ON public.property_change_requests FOR INSERT
  WITH CHECK (public.is_company_staff(company_id)
              AND lower(requested_by) = lower(auth.email())
              AND status = 'pending');
CREATE POLICY property_change_requests_review ON public.property_change_requests FOR UPDATE
  USING (public.is_management_tier(company_id)) WITH CHECK (public.is_management_tier(company_id));
CREATE POLICY property_change_requests_delete ON public.property_change_requests FOR DELETE
  USING (public.is_management_tier(company_id));

-- Management tier, or the requester of an APPROVED, not-yet-executed request
-- for exactly this target. Consuming it is the caller's job (see below) so a
-- single approval covers a single action.
CREATE OR REPLACE FUNCTION public._approved_request_id(p_company_id text, p_request_type text, p_target_id text)
 RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT r.id FROM property_change_requests r
   WHERE r.company_id = p_company_id AND r.request_type = p_request_type
     AND r.target_id = p_target_id AND r.status = 'approved' AND r.executed_at IS NULL
     AND lower(r.requested_by) = lower(COALESCE(auth.email(), current_setting('request.jwt.claims', true)::json->>'email'))
   ORDER BY r.reviewed_at DESC NULLS LAST LIMIT 1
$function$;
REVOKE EXECUTE ON FUNCTION public._approved_request_id(text, text, text) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public._assert_management_or_approved(p_company_id text, p_request_type text, p_target_id text, p_what text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_claims text := current_setting('request.jwt.claims', true); v_req integer;
BEGIN
  -- Service key and definer-internal callers pass, as in _assert_company_staff.
  IF v_claims IS NULL OR v_claims = '' OR (v_claims::jsonb ->> 'role') = 'service_role' THEN RETURN; END IF;
  IF p_company_id IS NULL OR NOT public.is_company_staff(p_company_id) THEN
    RAISE EXCEPTION 'Not authorized for this company' USING ERRCODE = '42501';
  END IF;
  IF public.is_management_tier(p_company_id) THEN RETURN; END IF;
  v_req := public._approved_request_id(p_company_id, p_request_type, p_target_id);
  IF v_req IS NULL THEN
    RAISE EXCEPTION 'Your role cannot % — request it and a manager or admin will approve.', p_what USING ERRCODE = '42501';
  END IF;
  UPDATE property_change_requests SET executed_at = now() WHERE id = v_req;
END $function$;
REVOKE EXECUTE ON FUNCTION public._assert_management_or_approved(text, text, text, text) FROM PUBLIC, anon;

-- archive_property(5): staff-only check became management-or-approved.
CREATE OR REPLACE FUNCTION public.archive_property(p_company_id text, p_property_id text, p_address text, p_archive_tenant boolean DEFAULT false, p_user_email text DEFAULT 'system'::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_prop_id INT;
BEGIN
  PERFORM public._assert_management_or_approved(p_company_id, 'archive_property', p_property_id, 'archive a property');
  v_prop_id := p_property_id::INT;
  UPDATE properties SET archived_at = NOW(), archived_by = p_user_email
    WHERE company_id = p_company_id AND id = v_prop_id AND archived_at IS NULL;
  UPDATE work_orders SET archived_at = NOW()
    WHERE company_id = p_company_id AND (property = p_address OR property_id = v_prop_id) AND archived_at IS NULL;
  UPDATE utilities SET archived_at = NOW()
    WHERE company_id = p_company_id AND property = p_address AND archived_at IS NULL;
  UPDATE hoa_payments SET archived_at = NOW()
    WHERE company_id = p_company_id AND property = p_address AND archived_at IS NULL;
  UPDATE autopay_schedules SET archived_at = NOW()
    WHERE company_id = p_company_id AND property = p_address AND archived_at IS NULL;
  IF p_archive_tenant THEN
    UPDATE tenants SET archived_at = NOW(), archived_by = p_user_email
      WHERE company_id = p_company_id AND property = p_address AND archived_at IS NULL;
    UPDATE leases SET archived_at = NOW()
      WHERE company_id = p_company_id AND property = p_address AND archived_at IS NULL;
  END IF;
  RETURN jsonb_build_object('success', true);
END;
$function$;

-- move_out_commit_state: same gate, keyed on the tenant.
CREATE OR REPLACE FUNCTION public.move_out_commit_state(p_company_id text, p_lease_id uuid, p_tenant_id bigint, p_tenant_name text, p_property text, p_move_out_date date, p_archived_by text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_lease_rows integer := 0; v_tenant_rows integer := 0; v_property_rows integer := 0;
  v_autopay_rows integer := 0; v_recur_rows integer := 0;
BEGIN
  PERFORM public._assert_management_or_approved(p_company_id, 'move_out', p_tenant_id::text, 'complete a move-out');
  IF p_company_id IS NULL OR p_company_id = '' THEN RAISE EXCEPTION 'company_id required'; END IF;
  IF p_tenant_id IS NULL THEN RAISE EXCEPTION 'tenant_id required'; END IF;
  IF p_property IS NULL OR p_property = '' THEN RAISE EXCEPTION 'property required'; END IF;
  IF p_move_out_date IS NULL THEN RAISE EXCEPTION 'move_out_date required'; END IF;
  IF p_lease_id IS NOT NULL THEN
    UPDATE leases SET status='terminated', end_date=p_move_out_date WHERE id=p_lease_id AND company_id=p_company_id;
    GET DIAGNOSTICS v_lease_rows = ROW_COUNT;
    IF v_lease_rows = 0 THEN RAISE EXCEPTION 'lease not found or not owned by company'; END IF;
  END IF;
  UPDATE tenants SET lease_status='inactive', move_out=p_move_out_date, archived_at=now(), archived_by=COALESCE(p_archived_by,'system')
   WHERE id=p_tenant_id AND company_id=p_company_id;
  GET DIAGNOSTICS v_tenant_rows = ROW_COUNT;
  IF v_tenant_rows = 0 THEN RAISE EXCEPTION 'tenant not found or not owned by company'; END IF;
  UPDATE properties SET status='vacant', tenant='', lease_end=NULL WHERE company_id=p_company_id AND address=p_property;
  GET DIAGNOSTICS v_property_rows = ROW_COUNT;
  UPDATE autopay_schedules SET active=false WHERE company_id=p_company_id AND tenant=p_tenant_name AND property=p_property;
  GET DIAGNOSTICS v_autopay_rows = ROW_COUNT;
  UPDATE recurring_journal_entries SET status='inactive', archived_at=now()
   WHERE company_id=p_company_id AND property=p_property AND status='active' AND (tenant_id=p_tenant_id OR tenant_name=p_tenant_name);
  GET DIAGNOSTICS v_recur_rows = ROW_COUNT;
  RETURN jsonb_build_object('ok',true,'lease_rows',v_lease_rows,'tenant_rows',v_tenant_rows,
    'property_rows',v_property_rows,'autopay_rows',v_autopay_rows,'recur_rows',v_recur_rows);
END;
$function$;
