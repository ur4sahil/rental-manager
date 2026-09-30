-- Security audit 2026-09-30: database and storage fixes.
--
-- Findings fixed here (numbering from the audit summary):
--   1. storage `documents` bucket open to every signed-in user; no MIME limit
--   2. the owner-PORTAL role treated as an administrator in definers/policies
--   3. join requests could ask for the admin role; approval only flipped status
--   5. anonymous / tenant-callable functions that forge, demote or leak
--
-- Not here (needs Sahil's decision on who may do what): company row
-- update/delete, hard-delete of posted journal entries / leases / owners /
-- tenants / autopay, archive_property(5) and move_out_commit_state tiers.

-- ────────────────────────────────────────────────────────────────────────
-- 1. STORAGE
-- ────────────────────────────────────────────────────────────────────────
-- The three dashboard-made policies checked only `bucket_id = 'documents'`.
-- Paths are `<company_id>/...`, so scope by the first folder. Staff of the
-- company get everything; other members (tenants, owners) may upload into
-- their company's folder and may read exactly the objects that a documents
-- or messages row visible to them points at (those subqueries run under the
-- caller's own RLS).
DROP POLICY IF EXISTS "Allow authenticated reads from documents"   ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated uploads to documents"   ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated deletes from documents" ON storage.objects;
DROP POLICY IF EXISTS documents_staff_all      ON storage.objects;
DROP POLICY IF EXISTS documents_member_insert  ON storage.objects;
DROP POLICY IF EXISTS documents_member_read    ON storage.objects;
DROP POLICY IF EXISTS maint_photos_staff_all   ON storage.objects;
DROP POLICY IF EXISTS maint_photos_member_insert ON storage.objects;
DROP POLICY IF EXISTS maint_photos_member_read ON storage.objects;

CREATE POLICY documents_staff_all ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'documents'
         AND (storage.foldername(name))[1] IN (SELECT public.get_staff_company_ids()))
  WITH CHECK (bucket_id = 'documents'
         AND (storage.foldername(name))[1] IN (SELECT public.get_staff_company_ids()));

CREATE POLICY documents_member_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'documents'
         AND public.is_company_member((storage.foldername(name))[1]));

CREATE POLICY documents_member_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'documents'
         AND (EXISTS (SELECT 1 FROM public.documents d WHERE d.url = storage.objects.name)
              OR EXISTS (SELECT 1 FROM public.messages m WHERE m.attachment_url = storage.objects.name)));

-- maintenance-photos had NO policies (uploads there were failing under RLS).
-- Its object names carry no company prefix, so ownership is resolved through
-- the work_order_photos row that references the object.
CREATE POLICY maint_photos_staff_all ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'maintenance-photos'
         AND EXISTS (SELECT 1 FROM public.work_order_photos p
                      WHERE p.url = storage.objects.name AND public.is_company_staff(p.company_id)))
  WITH CHECK (bucket_id = 'maintenance-photos'
         AND EXISTS (SELECT 1 FROM public.company_members cm
                      WHERE (cm.auth_user_id = auth.uid() OR lower(cm.user_email) = lower(auth.email()))
                        AND cm.status = 'active' AND cm.role NOT IN ('tenant','owner')));

CREATE POLICY maint_photos_member_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'maintenance-photos'
         AND EXISTS (SELECT 1 FROM public.company_members cm
                      WHERE (cm.auth_user_id = auth.uid() OR lower(cm.user_email) = lower(auth.email()))
                        AND cm.status = 'active'));

CREATE POLICY maint_photos_member_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'maintenance-photos'
         AND EXISTS (SELECT 1 FROM public.work_order_photos p WHERE p.url = storage.objects.name));

-- Server-enforced file types. The browser checks (helpers.js ALLOWED_DOC_TYPES
-- + magic bytes) are bypassable; without this a tenant could store an HTML
-- file and have it served from the app's own origin through /docs/.
UPDATE storage.buckets SET
  allowed_mime_types = ARRAY['application/pdf','image/jpeg','image/png','image/gif','image/webp',
    'image/heic','image/heif','application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain','text/csv'],
  file_size_limit = 26214400
WHERE id = 'documents';

UPDATE storage.buckets SET
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/gif','image/webp','image/heic','image/heif'],
  file_size_limit = 15728640
WHERE id = 'maintenance-photos';

UPDATE storage.buckets SET allowed_mime_types = ARRAY['application/pdf'] WHERE id = 'signed-documents';

-- ────────────────────────────────────────────────────────────────────────
-- 2. `owner` IS THE OWNER-PORTAL ROLE, NOT AN ADMINISTRATOR
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.caller_admin_company_ids()
 RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT company_id FROM company_members
   WHERE (auth_user_id = auth.uid() OR lower(user_email) = lower(auth.email()))
     AND status = 'active' AND role = 'admin'
$function$;

CREATE OR REPLACE FUNCTION public.hard_delete_company(p_company_id text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caller_email text; v_caller_role text; v_table record; v_deleted bigint;
  v_total bigint := 0; v_per_table jsonb := '{}'::jsonb;
BEGIN
  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
   WHERE company_id = p_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';
  -- Only an ADMIN. 'owner' is the owner-portal role; it used to pass here.
  IF v_caller_role IS NULL OR v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'Unauthorized: only an admin can hard-delete a company';
  END IF;
  FOR v_table IN
    SELECT c.table_schema, c.table_name FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.column_name = 'company_id' AND c.table_name NOT IN ('companies')
     ORDER BY c.table_name
  LOOP
    EXECUTE format('DELETE FROM %I.%I WHERE company_id = $1', v_table.table_schema, v_table.table_name) USING p_company_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted > 0 THEN
      v_per_table := v_per_table || jsonb_build_object(v_table.table_name, v_deleted);
      v_total := v_total + v_deleted;
    END IF;
  END LOOP;
  DELETE FROM companies WHERE id = p_company_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted = 0 THEN RAISE EXCEPTION 'Company % not found or already deleted', p_company_id; END IF;
  v_per_table := v_per_table || jsonb_build_object('companies', v_deleted);
  v_total := v_total + v_deleted;
  RETURN jsonb_build_object('company_id', p_company_id, 'total_rows_deleted', v_total, 'per_table', v_per_table);
END;
$function$;

CREATE OR REPLACE FUNCTION public.approve_member_request(p_member_id bigint, p_role text DEFAULT 'tenant'::text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_company_id text; v_caller_email text; v_caller_role text;
BEGIN
  SELECT company_id INTO v_company_id FROM company_members WHERE id = p_member_id;
  IF v_company_id IS NULL THEN RAISE EXCEPTION 'Member request not found'; END IF;
  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
   WHERE company_id = v_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'Unauthorized: only admins can approve members';
  END IF;
  IF COALESCE(p_role, 'tenant') NOT IN ('admin','pm','manager','office_assistant','accountant','maintenance','tenant','owner') THEN
    RAISE EXCEPTION 'Unknown role %', p_role;
  END IF;
  UPDATE company_members SET status = 'active', role = COALESCE(p_role, 'tenant') WHERE id = p_member_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.handle_membership_request(p_member_id bigint, p_action text, p_role text DEFAULT 'tenant'::text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_company_id text; v_caller_email text; v_caller_role text;
BEGIN
  SELECT company_id INTO v_company_id FROM company_members WHERE id = p_member_id;
  IF v_company_id IS NULL THEN RAISE EXCEPTION 'Member request not found'; END IF;
  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
   WHERE company_id = v_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'Unauthorized: only admins can manage membership requests';
  END IF;
  IF p_action = 'approve' THEN
    IF COALESCE(p_role, 'tenant') NOT IN ('admin','pm','manager','office_assistant','accountant','maintenance','tenant','owner') THEN
      RAISE EXCEPTION 'Unknown role %', p_role;
    END IF;
    UPDATE company_members SET status = 'active', role = COALESCE(p_role, 'tenant') WHERE id = p_member_id;
  ELSIF p_action = 'reject' THEN
    UPDATE company_members SET status = 'rejected' WHERE id = p_member_id;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.accept_pm_assignment(p_request_id uuid, p_pm_company_id text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.is_management_tier(p_pm_company_id) THEN
    RAISE EXCEPTION 'Unauthorized: only admins/managers can accept PM assignments';
  END IF;
  UPDATE pm_assignment_requests SET status = 'accepted', accepted_at = now()
   WHERE id = p_request_id AND pm_company_id = p_pm_company_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.archive_property(p_property_id bigint, p_company_id text, p_archived_by text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.is_management_tier(p_company_id) THEN
    RAISE EXCEPTION 'Unauthorized: only admins/managers can archive properties';
  END IF;
  UPDATE properties SET archived_at = now(), archived_by = p_archived_by
   WHERE id = p_property_id AND company_id = p_company_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rename_property_from_components(p_company_id text, p_property_id bigint, p_line1 text, p_line2 text, p_city text, p_state text, p_zip text)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_old text; v_new text;
BEGIN
  IF NOT public.is_management_tier(p_company_id) THEN
    RAISE EXCEPTION 'Unauthorized: only admins/managers can rename properties';
  END IF;
  SELECT address INTO v_old FROM properties WHERE id = p_property_id AND company_id = p_company_id;
  IF v_old IS NULL THEN RETURN NULL; END IF;
  UPDATE properties
     SET address_line_1 = COALESCE(p_line1, address_line_1),
         address_line_2 = COALESCE(p_line2, address_line_2),
         city           = COALESCE(p_city,  city),
         state          = COALESCE(p_state, state),
         zip            = COALESCE(p_zip,   zip)
   WHERE id = p_property_id AND company_id = p_company_id;
  SELECT address INTO v_new FROM properties WHERE id = p_property_id AND company_id = p_company_id;
  PERFORM public._cascade_property_rename(p_company_id, v_old, v_new);
  RETURN v_new;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rename_tenant_cascade(p_company_id text, p_old_name text, p_new_name text, p_property text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.is_management_tier(p_company_id) THEN
    RAISE EXCEPTION 'Unauthorized: only admins/managers can rename tenants';
  END IF;
  IF p_old_name IS NULL OR p_new_name IS NULL OR p_old_name = p_new_name THEN RETURN; END IF;
  UPDATE payments          SET tenant      = p_new_name WHERE company_id = p_company_id AND tenant      = p_old_name AND property = p_property;
  UPDATE leases            SET tenant_name = p_new_name WHERE company_id = p_company_id AND tenant_name = p_old_name AND property = p_property;
  UPDATE work_orders       SET tenant      = p_new_name WHERE company_id = p_company_id AND tenant      = p_old_name AND property = p_property;
  UPDATE documents         SET tenant      = p_new_name WHERE company_id = p_company_id AND tenant      = p_old_name AND property = p_property;
  UPDATE messages          SET tenant      = p_new_name WHERE company_id = p_company_id AND tenant      = p_old_name AND property = p_property;
  UPDATE autopay_schedules SET tenant      = p_new_name WHERE company_id = p_company_id AND tenant      = p_old_name AND property = p_property;
  UPDATE properties        SET tenant      = p_new_name WHERE company_id = p_company_id AND tenant      = p_old_name AND address  = p_property;
  UPDATE doc_generated            SET tenant_name = p_new_name WHERE company_id = p_company_id AND tenant_name = p_old_name;
  UPDATE doc_exception_requests   SET tenant_name = p_new_name WHERE company_id = p_company_id AND tenant_name = p_old_name;
  UPDATE eviction_cases           SET tenant_name = p_new_name WHERE company_id = p_company_id AND tenant_name = p_old_name;
  UPDATE recurring_journal_entries SET tenant_name = p_new_name WHERE company_id = p_company_id AND tenant_name = p_old_name;
  UPDATE tenant_invite_codes      SET tenant_name = p_new_name WHERE company_id = p_company_id AND tenant_name = p_old_name;
  UPDATE property_change_requests SET tenant     = p_new_name WHERE company_id = p_company_id AND tenant      = p_old_name;
END;
$function$;

-- create_doc_envelope: same body, staff roles only (owner removed, manager added).
CREATE OR REPLACE FUNCTION public.create_doc_envelope(p_doc_id uuid, p_signers jsonb)
 RETURNS TABLE(signer_id uuid, signer_email text, access_token text, sign_order integer, status text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_company_id text; v_template_id uuid; v_signing_mode text; v_user_email text;
  v_now timestamptz := now(); v_expiry timestamptz := now() + interval '30 days';
  v_doc_hash text; s jsonb; v_min_order int;
BEGIN
  v_user_email := auth.jwt() ->> 'email';
  IF v_user_email IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  SELECT d.company_id, d.template_id INTO v_company_id, v_template_id FROM doc_generated d WHERE d.id = p_doc_id;
  IF v_company_id IS NULL THEN RAISE EXCEPTION 'doc not found'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM company_members cm
     WHERE cm.company_id = v_company_id AND cm.user_email ILIKE v_user_email
       AND cm.status = 'active' AND cm.role IN ('admin','pm','manager','office_assistant')
  ) THEN RAISE EXCEPTION 'not authorized for this company'; END IF;
  SELECT encode(digest(COALESCE(d.rendered_body,''), 'sha256'), 'hex') INTO v_doc_hash FROM doc_generated d WHERE d.id = p_doc_id;
  SELECT COALESCE(t.signing_mode, 'parallel') INTO v_signing_mode FROM doc_templates t WHERE t.id = v_template_id;
  v_signing_mode := COALESCE(v_signing_mode, 'parallel');
  IF v_signing_mode = 'none' THEN v_signing_mode := 'parallel'; END IF;
  DELETE FROM doc_signatures WHERE doc_id = p_doc_id AND status IN ('pending','sent','viewed');
  FOR s IN SELECT * FROM jsonb_array_elements(p_signers) LOOP
    INSERT INTO doc_signatures (company_id, doc_id, signer_role, signer_name, signer_email, sign_order, status, access_token, token_expires_at, sent_at)
    VALUES (v_company_id, p_doc_id, COALESCE(s->>'role', 'signer'), s->>'name', lower(s->>'email'),
            COALESCE((s->>'order')::int, 1), 'pending', _gen_signing_token(), v_expiry, v_now);
  END LOOP;
  IF v_signing_mode = 'sequential' THEN
    SELECT MIN(ds.sign_order) INTO v_min_order FROM doc_signatures ds WHERE ds.doc_id = p_doc_id AND ds.status = 'pending';
    UPDATE doc_signatures SET status = 'sent' WHERE doc_id = p_doc_id AND status = 'pending' AND sign_order = v_min_order;
  ELSE
    UPDATE doc_signatures SET status = 'sent' WHERE doc_id = p_doc_id AND status = 'pending';
  END IF;
  UPDATE doc_generated SET envelope_status = 'out_for_signature', envelope_sent_at = v_now, doc_hash_at_send = v_doc_hash WHERE id = p_doc_id;
  RETURN QUERY SELECT ds.id, ds.signer_email, ds.access_token, ds.sign_order, ds.status
    FROM doc_signatures ds WHERE ds.doc_id = p_doc_id ORDER BY ds.sign_order, ds.created_at;
END; $function$;

-- Policies that listed 'owner' among the writer roles (and forgot 'manager').
DROP POLICY IF EXISTS "Admins can update errors" ON public.error_log;
CREATE POLICY "Admins can update errors" ON public.error_log FOR UPDATE
  USING (public.is_company_admin_or_manager(company_id));

DROP POLICY IF EXISTS doc_signatures_insert ON public.doc_signatures;
CREATE POLICY doc_signatures_insert ON public.doc_signatures FOR INSERT TO authenticated
  WITH CHECK (company_id IN (SELECT cm.company_id FROM company_members cm
    WHERE cm.user_email ILIKE (auth.jwt() ->> 'email') AND cm.status = 'active'
      AND cm.role IN ('admin','pm','manager','office_assistant')));
DROP POLICY IF EXISTS doc_signatures_update ON public.doc_signatures;
CREATE POLICY doc_signatures_update ON public.doc_signatures FOR UPDATE TO authenticated
  USING (company_id IN (SELECT cm.company_id FROM company_members cm
    WHERE cm.user_email ILIKE (auth.jwt() ->> 'email') AND cm.status = 'active'
      AND cm.role IN ('admin','pm','manager','office_assistant')));

DROP POLICY IF EXISTS property_licenses_insert ON public.property_licenses;
CREATE POLICY property_licenses_insert ON public.property_licenses FOR INSERT TO authenticated
  WITH CHECK (company_id IN (SELECT cm.company_id FROM company_members cm
    WHERE cm.user_email ILIKE (auth.jwt() ->> 'email') AND cm.status = 'active'
      AND cm.role IN ('admin','pm','manager','office_assistant')));
DROP POLICY IF EXISTS property_licenses_update ON public.property_licenses;
CREATE POLICY property_licenses_update ON public.property_licenses FOR UPDATE TO authenticated
  USING (company_id IN (SELECT cm.company_id FROM company_members cm
    WHERE cm.user_email ILIKE (auth.jwt() ->> 'email') AND cm.status = 'active'
      AND cm.role IN ('admin','pm','manager','office_assistant')));

DROP POLICY IF EXISTS property_tax_bills_insert ON public.property_tax_bills;
CREATE POLICY property_tax_bills_insert ON public.property_tax_bills FOR INSERT TO authenticated
  WITH CHECK (company_id IN (SELECT cm.company_id FROM company_members cm
    WHERE cm.user_email ILIKE (auth.jwt() ->> 'email') AND cm.status = 'active'
      AND cm.role IN ('admin','pm','manager','office_assistant')));
DROP POLICY IF EXISTS property_tax_bills_update ON public.property_tax_bills;
CREATE POLICY property_tax_bills_update ON public.property_tax_bills FOR UPDATE TO authenticated
  USING (company_id IN (SELECT cm.company_id FROM company_members cm
    WHERE cm.user_email ILIKE (auth.jwt() ->> 'email') AND cm.status = 'active'
      AND cm.role IN ('admin','pm','manager','office_assistant')));

-- ────────────────────────────────────────────────────────────────────────
-- 3. JOIN REQUESTS CANNOT ASK FOR A PRIVILEGED ROLE
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.request_join_company(p_company_id text, p_role text DEFAULT 'office_assistant'::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_user_id uuid; v_email text; v_existing record;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_email := LOWER(auth.jwt()->>'email');
  -- A requester names a working role only. Admin/manager/pm are granted by
  -- an admin in Team & Roles after approval, never self-selected: the
  -- approval card showed no role, so an "admin" request approved as admin.
  IF COALESCE(p_role, 'office_assistant') NOT IN ('office_assistant','accountant','maintenance','tenant') THEN
    RAISE EXCEPTION 'You can request to join as office assistant, accountant, maintenance or tenant';
  END IF;
  SELECT status INTO v_existing FROM company_members WHERE company_id = p_company_id AND LOWER(user_email) = v_email;
  IF v_existing.status = 'active' THEN RAISE EXCEPTION 'Already a member of this company';
  ELSIF v_existing.status = 'pending' THEN RAISE EXCEPTION 'Request already pending';
  ELSIF v_existing.status = 'rejected' THEN RAISE EXCEPTION 'Previous request was rejected — contact the company admin';
  ELSIF v_existing.status = 'removed' THEN RAISE EXCEPTION 'Previously removed — contact the company admin';
  END IF;
  INSERT INTO company_members (company_id, user_email, user_name, role, status, invited_by, auth_user_id)
  VALUES (p_company_id, v_email, SPLIT_PART(v_email, '@', 1), COALESCE(p_role, 'office_assistant'), 'pending', 'self-request', v_user_id)
  ON CONFLICT (company_id, user_email) DO UPDATE SET status = 'pending', role = EXCLUDED.role, auth_user_id = v_user_id;
  RETURN jsonb_build_object('success', true);
END;
$function$;

-- Same rule on the direct-insert path.
DROP POLICY IF EXISTS members_manage ON public.company_members;
CREATE POLICY members_manage ON public.company_members FOR INSERT
  WITH CHECK (
    (lower(user_email) = lower(auth.jwt() ->> 'email') AND status = 'pending'
       AND role IN ('office_assistant','accountant','maintenance','tenant'))
    OR (lower(user_email) = lower(auth.jwt() ->> 'email') AND role = 'admin' AND invited_by = 'self' AND public.is_company_creator(company_id))
    OR public.is_company_admin(company_id)
  );

-- ────────────────────────────────────────────────────────────────────────
-- 5. ANONYMOUS / TENANT-CALLABLE FUNCTIONS THAT FORGE, DEMOTE OR LEAK
-- ────────────────────────────────────────────────────────────────────────
-- Dead or dangerous overloads. sign_lease(uuid,text) marked ANY signature row
-- signed with any name, anonymously. redeem_invite_code(text,text) and
-- tenant_make_payment referenced columns/views that no longer exist.
DROP FUNCTION IF EXISTS public.sign_lease(uuid, text);
DROP FUNCTION IF EXISTS public.redeem_invite_code(text, text);
DROP FUNCTION IF EXISTS public.tenant_make_payment(text, integer, numeric, text);

-- validate_invite_code referenced a column that does not exist (redeemed_at),
-- so the tenant invite-code sign-up has been failing. Codes now expire after
-- 30 days. Still anonymous by design (called before sign-up).
CREATE OR REPLACE FUNCTION public.validate_invite_code(p_code text)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_result json;
BEGIN
  SELECT json_build_object('valid', true, 'company_id', company_id, 'property', property)
    INTO v_result FROM tenant_invite_codes
   WHERE code = UPPER(p_code) AND used = false AND created_at > now() - interval '30 days';
  IF v_result IS NULL THEN RETURN json_build_object('valid', false); END IF;
  RETURN v_result;
END;
$function$;

-- redeem_invite_code took the target email from the caller and rewrote whatever
-- account had it: an office assistant's membership became 'tenant', their
-- app_users row was overwritten, and the tenant record's login email changed.
-- Now: the code must be unexpired; the email must match the one the code (or
-- the tenant record) was issued for; and a staff account is never demoted.
CREATE OR REPLACE FUNCTION public.redeem_invite_code(p_code text, p_email text, p_name text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_code_row record; v_tenant_email text; v_existing_role text;
BEGIN
  IF p_email IS NULL OR p_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'A valid email is required');
  END IF;
  SELECT * INTO v_code_row FROM tenant_invite_codes
   WHERE code = UPPER(p_code) AND used = false AND created_at > now() - interval '30 days'
   FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid or expired invite code');
  END IF;
  IF COALESCE(btrim(v_code_row.tenant_email), '') <> '' AND lower(v_code_row.tenant_email) <> lower(p_email) THEN
    RETURN jsonb_build_object('success', false, 'error', 'This invite code was issued for a different email address');
  END IF;
  IF v_code_row.tenant_id IS NOT NULL THEN
    SELECT email INTO v_tenant_email FROM tenants WHERE id = v_code_row.tenant_id;
    IF COALESCE(btrim(v_tenant_email), '') <> '' AND lower(v_tenant_email) <> lower(p_email) THEN
      RETURN jsonb_build_object('success', false, 'error', 'This invite code was issued for a different email address');
    END IF;
  END IF;
  SELECT role INTO v_existing_role FROM company_members
   WHERE company_id = v_code_row.company_id AND lower(user_email) = lower(p_email);
  IF v_existing_role IS NOT NULL AND v_existing_role <> 'tenant' THEN
    RETURN jsonb_build_object('success', false, 'error', 'This email already belongs to a staff account in this company');
  END IF;

  UPDATE tenant_invite_codes SET used = true, used_by = LOWER(p_email), used_at = NOW() WHERE id = v_code_row.id;
  INSERT INTO company_members (company_id, user_email, user_name, role, status, invited_by)
  VALUES (v_code_row.company_id, LOWER(p_email), p_name, 'tenant', 'active', v_code_row.created_by)
  ON CONFLICT (company_id, user_email) DO UPDATE SET status = 'active', role = 'tenant';
  IF v_code_row.tenant_id IS NOT NULL THEN
    UPDATE tenants SET email = LOWER(p_email) WHERE id = v_code_row.tenant_id AND COALESCE(btrim(email), '') = '';
  END IF;
  INSERT INTO app_users (email, name, role, user_type, company_id)
  VALUES (LOWER(p_email), p_name, 'tenant', 'tenant', v_code_row.company_id)
  ON CONFLICT (email) DO UPDATE SET role = 'tenant', user_type = 'tenant', company_id = v_code_row.company_id
    WHERE app_users.role IS NULL OR app_users.role = 'tenant';
  RETURN jsonb_build_object('success', true, 'company_id', v_code_row.company_id,
                            'property', v_code_row.property, 'tenant_id', v_code_row.tenant_id);
END;
$function$;

-- A redeemer could flip their own code back to unused and redeem it again
-- for another address. Codes are managed by staff only.
DROP POLICY IF EXISTS invite_codes_update ON public.tenant_invite_codes;
CREATE POLICY invite_codes_update ON public.tenant_invite_codes FOR UPDATE
  USING (company_id IN (SELECT public.get_staff_company_ids()));

-- Financial reports and staff broadcast: staff only, not any member.
CREATE OR REPLACE FUNCTION public.report_profit_and_loss(p_company_id text, p_start date, p_end date)
 RETURNS TABLE(account_id uuid, code text, name text, type text, subtype text, amount numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.is_company_staff(p_company_id) THEN RAISE EXCEPTION 'Not staff of %', p_company_id; END IF;
  RETURN QUERY
  SELECT a.id, a.code, a.name, a.type, a.subtype,
         CASE WHEN a.type IN ('Revenue','Income') THEN SUM(COALESCE(l.credit,0) - COALESCE(l.debit,0))
              ELSE SUM(COALESCE(l.debit,0) - COALESCE(l.credit,0)) END
    FROM acct_journal_lines l
    JOIN acct_journal_entries je ON je.id = l.journal_entry_id
    JOIN acct_accounts a ON a.id = l.account_id
   WHERE l.company_id = p_company_id AND je.status = 'posted' AND je.date BETWEEN p_start AND p_end
     AND a.is_active AND a.type IN ('Revenue','Income','Expense','COGS','Other Income','Other Expense')
   GROUP BY a.id, a.code, a.name, a.type, a.subtype
  HAVING abs(SUM(COALESCE(l.debit,0) - COALESCE(l.credit,0))) >= 0.005
   ORDER BY a.code;
END;
$function$;

CREATE OR REPLACE FUNCTION public.report_trial_balance(p_company_id text, p_end date)
 RETURNS TABLE(account_id uuid, code text, name text, type text, debit_balance numeric, credit_balance numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.is_company_staff(p_company_id) THEN RAISE EXCEPTION 'Not staff of %', p_company_id; END IF;
  RETURN QUERY
  WITH net AS (
    SELECT l.account_id AS aid, SUM(COALESCE(l.debit,0) - COALESCE(l.credit,0)) AS n
      FROM acct_journal_lines l JOIN acct_journal_entries je ON je.id = l.journal_entry_id
     WHERE l.company_id = p_company_id AND je.status = 'posted' AND je.date <= p_end
     GROUP BY l.account_id)
  SELECT a.id, a.code, a.name, a.type,
         CASE WHEN net.n > 0 THEN net.n ELSE 0 END, CASE WHEN net.n < 0 THEN abs(net.n) ELSE 0 END
    FROM acct_accounts a JOIN net ON net.aid = a.id
   WHERE a.company_id = p_company_id AND a.is_active AND abs(net.n) >= 0.005
   ORDER BY a.code;
END;
$function$;

CREATE OR REPLACE FUNCTION public.report_trial_balance_fast(p_company_id text, p_end date)
 RETURNS TABLE(account_id uuid, code text, name text, type text, debit_balance numeric, credit_balance numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_snap date;
BEGIN
  IF NOT public.is_company_staff(p_company_id) THEN RAISE EXCEPTION 'Not staff of %', p_company_id; END IF;
  SELECT max(pb.as_of) INTO v_snap FROM acct_period_balances pb WHERE pb.company_id = p_company_id AND pb.as_of <= p_end;
  RETURN QUERY
  WITH base AS (
    SELECT pb.account_id AS aid, pb.net_balance AS n FROM acct_period_balances pb
     WHERE v_snap IS NOT NULL AND pb.company_id = p_company_id AND pb.as_of = v_snap),
  delta AS (
    SELECT l.account_id AS aid, SUM(COALESCE(l.debit,0) - COALESCE(l.credit,0)) AS n
      FROM acct_journal_lines l JOIN acct_journal_entries je ON je.id = l.journal_entry_id
     WHERE l.company_id = p_company_id AND je.status = 'posted' AND je.date <= p_end
       AND (v_snap IS NULL OR je.date > v_snap)
     GROUP BY l.account_id),
  net AS (
    SELECT COALESCE(b.aid, d.aid) AS aid, COALESCE(b.n, 0) + COALESCE(d.n, 0) AS n
      FROM base b FULL OUTER JOIN delta d ON d.aid = b.aid)
  SELECT a.id, a.code, a.name, a.type,
         CASE WHEN net.n > 0 THEN net.n ELSE 0 END, CASE WHEN net.n < 0 THEN abs(net.n) ELSE 0 END
    FROM acct_accounts a JOIN net ON net.aid = a.id
   WHERE a.company_id = p_company_id AND a.is_active AND abs(net.n) >= 0.005
   ORDER BY a.code;
END;
$function$;

CREATE OR REPLACE FUNCTION public.report_general_ledger(p_company_id text, p_account_id uuid, p_start date, p_end date)
 RETURNS TABLE(line_id text, entry_id text, entry_number text, entry_date date, description text, reference text, memo text, debit numeric, credit numeric, running_balance numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_normal text;
BEGIN
  IF NOT public.is_company_staff(p_company_id) THEN RAISE EXCEPTION 'Not staff of %', p_company_id; END IF;
  SELECT CASE WHEN a.type IN ('Asset','Expense','COGS','Other Expense') THEN 'debit' ELSE 'credit' END
    INTO v_normal FROM acct_accounts a WHERE a.id = p_account_id AND a.company_id = p_company_id;
  RETURN QUERY
  SELECT l.id::text, je.id::text, COALESCE(je.number,''), je.date,
         COALESCE(je.description,''), COALESCE(je.reference,''), COALESCE(l.memo,''),
         COALESCE(l.debit,0), COALESCE(l.credit,0),
         SUM(CASE WHEN v_normal = 'debit' THEN COALESCE(l.debit,0) - COALESCE(l.credit,0)
                  ELSE COALESCE(l.credit,0) - COALESCE(l.debit,0) END)
           OVER (ORDER BY je.date, je.created_at, l.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    FROM acct_journal_lines l JOIN acct_journal_entries je ON je.id = l.journal_entry_id
   WHERE l.company_id = p_company_id AND l.account_id = p_account_id AND je.status = 'posted'
     AND je.date BETWEEN p_start AND p_end
   ORDER BY je.date, je.created_at, l.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_company_staff(p_company_id text, p_type text, p_data jsonb)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_rows integer;
BEGIN
  IF NOT public.is_company_staff(p_company_id) THEN RAISE EXCEPTION 'Not staff of %', p_company_id; END IF;
  INSERT INTO notification_queue (company_id, type, recipient_email, data, status, cc, bcc)
  SELECT p_company_id, p_type, lower(cm.user_email), p_data, 'pending', '[]'::jsonb, '[]'::jsonb
    FROM company_members cm
   WHERE cm.company_id = p_company_id AND cm.status = 'active'
     AND cm.role NOT IN ('tenant', 'owner') AND coalesce(btrim(cm.user_email),'') <> '';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$function$;

-- A tenant could add or subtract any amount from any tenant's balance.
CREATE OR REPLACE FUNCTION public.update_tenant_balance(p_tenant_id bigint, p_amount_change numeric)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_company_id text;
BEGIN
  SELECT company_id INTO v_company_id FROM tenants WHERE id = p_tenant_id;
  IF v_company_id IS NULL THEN RAISE EXCEPTION 'Tenant not found'; END IF;
  IF NOT public.is_company_staff(v_company_id) THEN
    RAISE EXCEPTION 'Unauthorized: only staff can adjust a tenant balance';
  END IF;
  UPDATE tenants SET balance = COALESCE(balance, 0) + p_amount_change WHERE id = p_tenant_id;
END;
$function$;

-- Tenants never write payment rows themselves; card payments arrive through
-- the Stripe route, which records them with the service key.
DROP POLICY IF EXISTS payments_tenant_insert ON public.payments;

-- Anonymous financial metadata: staff only, and not for anon at all.
CREATE OR REPLACE FUNCTION public.find_unbalanced_jes(p_company_id text)
 RETURNS TABLE(id text, number text, difference numeric, date date)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.is_company_staff(p_company_id) THEN RAISE EXCEPTION 'Not staff of %', p_company_id; END IF;
  RETURN QUERY
  SELECT je.id, je.number,
         ABS(COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0))::numeric, MAX(je.date)
    FROM acct_journal_entries je LEFT JOIN acct_journal_lines jl ON jl.journal_entry_id = je.id
   WHERE je.company_id = p_company_id AND je.status = 'posted'
   GROUP BY je.id, je.number
  HAVING ABS(COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)) > 0.01
   ORDER BY MAX(je.date) DESC LIMIT 50;
END;
$function$;

CREATE OR REPLACE FUNCTION public.next_journal_number(p_company_id text)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE next_num bigint;
BEGIN
  IF NOT public.is_company_staff(p_company_id) THEN RAISE EXCEPTION 'Not staff of %', p_company_id; END IF;
  SELECT COALESCE(MAX(n), 0) + 1 INTO next_num
    FROM (SELECT CAST(REPLACE(number, 'JE-', '') AS bigint) AS n FROM acct_journal_entries
           WHERE company_id = p_company_id AND number IS NOT NULL
             AND REPLACE(number, 'JE-', '') ~ '^[0-9]{1,9}$') s;
  RETURN 'JE-' || LPAD(next_num::text, 4, '0');
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.find_unbalanced_jes(text)  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.next_journal_number(text)  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.next_je_number(text)       FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.update_tenant_balance(bigint, numeric) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.report_profit_and_loss(text, date, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.report_trial_balance(text, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.report_trial_balance_fast(text, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.report_general_ledger(text, uuid, date, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.notify_company_staff(text, text, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.hard_delete_company(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_unbalanced_jes(text), public.next_journal_number(text), public.next_je_number(text),
  public.update_tenant_balance(bigint, numeric), public.report_profit_and_loss(text, date, date),
  public.report_trial_balance(text, date), public.report_trial_balance_fast(text, date),
  public.report_general_ledger(text, uuid, date, date), public.notify_company_staff(text, text, jsonb),
  public.hard_delete_company(text) TO authenticated, service_role;
