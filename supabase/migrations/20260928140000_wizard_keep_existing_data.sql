-- Property setup wizard: saving must never lose or change what the user did
-- not touch. Edit mode is a true MERGE, and a stale form cannot overwrite a
-- newer edit made elsewhere.
--
-- Audit theme J (owner-approved). What commit_property_wizard did on an EDIT
-- save before this migration, even when nothing was changed:
--   * Utilities and HOA dues were archived wholesale and re-inserted: new ids,
--     status 'pending' (a PAID HOA bill became unpaid), utility amount 0, and
--     every due date moved to the 1st.
--   * Insurance / tax (and a single loan) were archived when the step was not
--     enabled in the payload -- skipped, failed to load, stale draft.
--   * Websites the form never loaded were wiped; lease payment_due_day forced
--     to 1; tenant late fee blanked; move_in overwritten; 'notice' tenants
--     flipped to 'active'; rent next_post_date recomputed every save.
--   * Whatever the form held was written back, so an edit made on another
--     page while the wizard was open was silently reverted.
--
-- The rules now:
--   * Every loaded record in an edit payload carries `_orig` (its fields as the
--     form loaded them) and `_db` (its stored columns as read). A field equal
--     to `_orig` is NOT written -- the database value stands. A field the user
--     changed is written, unless its column has changed since `_db` was read,
--     in which case the save is refused: "changed by someone else since you
--     opened the wizard". (_wizard_chg / _wizard_guard)
--   * An edit from a client that does not send this (payload_version < 2) is
--     refused with "Please reload the app".
--   * Utilities / HOA: matched by id only; a row with no id is always new. A
--     row is archived only when the form saw it (utilities_seen_ids /
--     hoas_seen_ids) and it is gone from the payload -- archived FIRST, so a
--     replacement with the same provider and account number can be inserted.
--     status / paid_date / amount / readings of an existing row are never
--     written by the wizard.
--   * Loan / insurance / tax: looked up by id AND this property (an id from
--     another property is ignored), archived only when the payload names the
--     one record the user switched off, never resurrected once archived.
--   * Blank never erases: websites, contacts, county, account number, notes
--     (owner-approved). Due days: an unchanged day keeps the stored date, a new
--     day moves it within the same month. Rent day changes move next_post_date
--     within its month the same way.
--   * credential_key_fp is persisted with every credential write.
--   * Address components are required in edit mode; a malformed value is
--     reported as such instead of as a raw cast error.
--   * Only admin / manager / office_assistant may commit (owner and pm
--     removed).
--   * Owner decision (audit theme K): no Mortgage/Loan recurring schedule is
--     created or updated (setup_recurring is ignored). Switching off a
--     property's LAST loan still deactivates an existing one.
--
-- Import create path (fresh mode): utility amount, full due date and
-- 'owner'/'tenant' responsibility accepted; blank responsibility / due date
-- left NULL; tax county / jurisdiction stored.
--
-- Signature, SECURITY DEFINER, (absent) search_path and grants of
-- commit_property_wizard are unchanged; CREATE OR REPLACE keeps the ACL. The
-- helpers are plain SECURITY INVOKER functions with no table access,
-- executable by authenticated / service_role only.

CREATE OR REPLACE FUNCTION public._wizard_safe_date(p text)
 RETURNS date
 LANGUAGE plpgsql
 IMMUTABLE
AS $f$
BEGIN
  IF p IS NULL OR p !~ '^\d{4}-\d{2}-\d{2}' THEN RETURN NULL; END IF;
  RETURN left(p, 10)::date;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$f$;

-- A day-of-month from a payload value: '15' / 15 -> 15, a full date -> its day,
-- blank or junk -> NULL (meaning "not given").
CREATE OR REPLACE FUNCTION public._wizard_day(p text)
 RETURNS int
 LANGUAGE plpgsql
 IMMUTABLE
AS $f$
BEGIN
  IF p IS NULL OR btrim(p) = '' THEN RETURN NULL; END IF;
  IF btrim(p) ~ '^\d{1,2}$' THEN
    RETURN CASE WHEN btrim(p)::int BETWEEN 1 AND 31 THEN btrim(p)::int END;
  END IF;
  RETURN extract(day from public._wizard_safe_date(p))::int;
END;
$f$;

-- The due date to store. A full date wins; no day keeps what is stored; the
-- stored day unchanged keeps the stored date; a different day moves it within
-- the stored (or, for a new row, the current) month.
CREATE OR REPLACE FUNCTION public._wizard_merge_due(p_existing date, p_full date, p_day int)
 RETURNS date
 LANGUAGE plpgsql
 STABLE
AS $f$
DECLARE
  v_base date;
  v_last int;
BEGIN
  IF p_full IS NOT NULL THEN RETURN p_full; END IF;
  IF p_day IS NULL THEN RETURN p_existing; END IF;
  IF p_existing IS NOT NULL AND extract(day from p_existing)::int = p_day THEN
    RETURN p_existing;
  END IF;
  v_base := date_trunc('month', COALESCE(p_existing, current_date))::date;
  v_last := extract(day from (v_base + interval '1 month - 1 day'))::int;
  RETURN v_base + (LEAST(GREATEST(p_day, 1), v_last) - 1);
END;
$f$;

-- Rows written by OTHER pages often hold NULL where the wizard's form holds
-- '' / 0 / false. When a field IS written, these keep the stored value if both
-- sides are "empty", else take the new one.
CREATE OR REPLACE FUNCTION public._wizard_txt(p_new text, p_old text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $f$
  SELECT CASE WHEN NULLIF(p_new, '') IS NULL AND NULLIF(p_old, '') IS NULL THEN p_old ELSE p_new END;
$f$;

-- p_blank is what an empty payload value meant before (0 for a deposit, NULL
-- for a loan amount), kept so this changes nothing but the NULL-vs-0 case.
CREATE OR REPLACE FUNCTION public._wizard_num(p_new text, p_old numeric, p_blank numeric DEFAULT NULL)
 RETURNS numeric
 LANGUAGE plpgsql
 IMMUTABLE
AS $f$
DECLARE
  v numeric := COALESCE(NULLIF(p_new, '')::numeric, p_blank);
BEGIN
  IF p_old IS NULL AND COALESCE(v, 0) = 0 THEN RETURN NULL; END IF;
  RETURN v;
END;
$f$;

CREATE OR REPLACE FUNCTION public._wizard_bool(p_new text, p_old boolean)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $f$
  SELECT CASE WHEN p_old IS NULL AND COALESCE(NULLIF(p_new, '')::boolean, false) = false
              THEN NULL ELSE COALESCE(NULLIF(p_new, '')::boolean, false) END;
$f$;

-- Did the user change this field? A record without `_orig` (new, or typed in
-- rather than loaded) counts every field as changed.
CREATE OR REPLACE FUNCTION public._wizard_chg(p_row jsonb, p_key text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $f$
  SELECT CASE WHEN p_row IS NULL OR jsonb_typeof(p_row->'_orig') IS DISTINCT FROM 'object' THEN true
              ELSE COALESCE(p_row->>p_key, '') IS DISTINCT FROM COALESCE(p_row->'_orig'->>p_key, '') END;
$f$;

-- For each (payload key, column) pair the user changed: refuse if the column
-- no longer holds what the form read (`p_db`) -- someone else edited it.
CREATE OR REPLACE FUNCTION public._wizard_guard(p_row jsonb, p_db jsonb, p_cur jsonb, p_map text[], p_label text)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
AS $f$
DECLARE
  i int;
BEGIN
  IF p_row IS NULL OR p_cur IS NULL OR jsonb_typeof(p_db) IS DISTINCT FROM 'object' THEN RETURN; END IF;
  FOR i IN 1 .. COALESCE(array_length(p_map, 1), 0) BY 2 LOOP
    IF public._wizard_chg(p_row, p_map[i]) AND p_db ? p_map[i + 1]
       AND (p_cur -> p_map[i + 1]) IS DISTINCT FROM (p_db -> p_map[i + 1]) THEN
      RAISE EXCEPTION '% was changed by someone else since you opened the wizard (%). Close the wizard, reopen the property and make your change again.',
        p_label, p_map[i + 1];
    END IF;
  END LOOP;
END;
$f$;

REVOKE ALL ON FUNCTION public._wizard_safe_date(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._wizard_day(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._wizard_merge_due(date, date, int) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._wizard_txt(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._wizard_num(text, numeric, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._wizard_bool(text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._wizard_chg(jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._wizard_guard(jsonb, jsonb, jsonb, text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._wizard_safe_date(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._wizard_day(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._wizard_merge_due(date, date, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._wizard_txt(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._wizard_num(text, numeric, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._wizard_bool(text, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._wizard_chg(jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._wizard_guard(jsonb, jsonb, jsonb, text[], text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commit_property_wizard(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $fn$
DECLARE
  v_company_id text;
  v_wizard_id uuid;
  v_mode text;
  v_caller_email text;
  v_caller_role text;

  v_prop jsonb;
  v_tenant jsonb;
  v_utilities jsonb;
  v_hoas jsonb;
  v_loan jsonb;
  v_insurance jsonb;
  v_taxes jsonb;
  v_recurring jsonb;

  v_property_id bigint;
  v_property_id_in bigint;
  v_property_id_raw text;
  v_address text;
  v_old_address text;
  v_class_id text;
  v_tenant_id bigint;
  v_tenant_name text;
  v_all_tenants text;
  v_lease_id uuid;
  v_existing_tenant_id bigint;
  v_existing_lease_id uuid;
  v_existing_loan_id uuid;
  v_loan_id text;
  v_existing_ins_id uuid;
  v_existing_tax_id uuid;
  v_existing_recur_id uuid;
  v_u jsonb;
  v_h jsonb;
  v_tenant_ar_id uuid;
  v_revenue_id uuid;
  v_next_post_date date;
  v_day int;
  v_is_occupied boolean;
  v_loan_has_creds boolean := false;
  v_ins_has_creds  boolean := false;
  v_row_id bigint;
  v_row_gone boolean;
  v_resp text;
  v_ins_id text;
  v_tax_id text;
  v_skip boolean;
  v_old_day int;
  v_old_next date;
  v_cur jsonb;
  v_prop_cur jsonb;
  v_names_chg boolean := true;
  v_rec_chg boolean;
  v_user_next date;
  v_default_next date;
BEGIN
 BEGIN
  v_company_id := p_payload->>'company_id';
  v_wizard_id  := NULLIF(p_payload->>'wizard_id','')::uuid;
  v_mode       := COALESCE(p_payload->>'mode', 'fresh');

  v_property_id_raw := p_payload->>'property_id_for_edit';
  IF v_mode = 'edit' AND v_property_id_raw IS NOT NULL AND v_property_id_raw ~ '^\d+$' THEN
    v_property_id_in := v_property_id_raw::bigint;
  ELSE
    v_property_id_in := NULL;
    v_mode := 'fresh';
  END IF;

  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
  WHERE company_id = v_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';
  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: not a member of this company';
  END IF;
  -- Staff only. 'owner' is the property-owner portal role and 'pm' is not a
  -- staff role this app assigns; neither may rewrite a property.
  IF v_caller_role NOT IN ('admin','manager','office_assistant') THEN
    RAISE EXCEPTION 'Role % cannot commit a property wizard', v_caller_role;
  END IF;

  -- A client that does not send what each record looked like when loaded
  -- cannot be merged safely: refuse rather than guess.
  IF v_mode = 'edit' AND COALESCE(NULLIF(p_payload->>'payload_version','')::int, 0) < 2 THEN
    RAISE EXCEPTION 'This page is out of date. Please reload the app and try again.';
  END IF;

  v_prop := p_payload->'property';
  v_tenant := p_payload->'tenant';
  v_utilities := COALESCE(p_payload->'utilities', '[]'::jsonb);
  v_hoas := COALESCE(p_payload->'hoas', '[]'::jsonb);
  v_loan := p_payload->'loan';
  v_insurance := p_payload->'insurance';
  v_taxes := p_payload->'taxes';
  v_recurring := p_payload->'recurring';
  IF jsonb_typeof(v_tenant) IS DISTINCT FROM 'object' THEN v_tenant := NULL; END IF;
  IF jsonb_typeof(v_loan) IS DISTINCT FROM 'object' THEN v_loan := NULL; END IF;
  IF jsonb_typeof(v_insurance) IS DISTINCT FROM 'object' THEN v_insurance := NULL; END IF;
  IF jsonb_typeof(v_taxes) IS DISTINCT FROM 'object' THEN v_taxes := NULL; END IF;
  IF jsonb_typeof(v_recurring) IS DISTINCT FROM 'object' THEN v_recurring := NULL; END IF;
  IF jsonb_typeof(v_utilities) <> 'array' THEN v_utilities := '[]'::jsonb; END IF;
  IF jsonb_typeof(v_hoas) <> 'array' THEN v_hoas := '[]'::jsonb; END IF;

  IF jsonb_typeof(v_prop) IS DISTINCT FROM 'object' OR COALESCE(btrim(v_prop->>'address_line_1'), '') = '' THEN
    RAISE EXCEPTION 'The property needs a street address.';
  END IF;
  IF v_mode = 'edit' AND (COALESCE(btrim(v_prop->>'city'), '') = '' OR COALESCE(btrim(v_prop->>'state'), '') = ''
                          OR COALESCE(btrim(v_prop->>'zip'), '') = '') THEN
    RAISE EXCEPTION 'Street address, city, state and ZIP are all required.';
  END IF;

  -- compute_property_address is what the sync_addr triggers call, and
  -- those triggers own properties.address.
  v_address := compute_property_address(
    v_prop->>'address_line_1', v_prop->>'address_line_2',
    v_prop->>'city', v_prop->>'state', v_prop->>'zip');

  IF v_mode = 'edit' AND v_property_id_in IS NOT NULL THEN
    -- Row-locked read BEFORE the components change: the address a rename is
    -- cascaded from, and what the guard compares against.
    SELECT address, to_jsonb(p) INTO v_old_address, v_prop_cur FROM properties p
    WHERE id = v_property_id_in AND company_id = v_company_id
    FOR UPDATE;
    IF v_prop_cur IS NULL THEN
      RAISE EXCEPTION 'This property no longer exists. Close the wizard and reload.';
    END IF;
    PERFORM public._wizard_guard(v_prop, v_prop->'_db', v_prop_cur, ARRAY[
      'address_line_1','address_line_1', 'address_line_2','address_line_2', 'city','city', 'state','state',
      'zip','zip', 'county','county', 'type','type', 'status','status', 'notes','notes', 'year_built','year_built'],
      'This property');
    -- Occupancy follows what the user chose, else what is stored.
    v_is_occupied := CASE WHEN public._wizard_chg(v_prop, 'status') THEN (v_prop->>'status') = 'occupied'
                          ELSE (v_prop_cur->>'status') = 'occupied' END;
    UPDATE properties SET
      address_line_1 = CASE WHEN public._wizard_chg(v_prop,'address_line_1') THEN v_prop->>'address_line_1' ELSE address_line_1 END,
      address_line_2 = CASE WHEN public._wizard_chg(v_prop,'address_line_2') THEN public._wizard_txt(v_prop->>'address_line_2', address_line_2) ELSE address_line_2 END,
      city = CASE WHEN public._wizard_chg(v_prop,'city') THEN v_prop->>'city' ELSE city END,
      state = CASE WHEN public._wizard_chg(v_prop,'state') THEN v_prop->>'state' ELSE state END,
      zip = CASE WHEN public._wizard_chg(v_prop,'zip') THEN v_prop->>'zip' ELSE zip END,
      county = CASE WHEN public._wizard_chg(v_prop,'county') THEN COALESCE(NULLIF(v_prop->>'county',''), county) ELSE county END,
      type = CASE WHEN public._wizard_chg(v_prop,'type') THEN v_prop->>'type' ELSE type END,
      status = CASE WHEN public._wizard_chg(v_prop,'status') THEN v_prop->>'status' ELSE status END,
      notes = CASE WHEN public._wizard_chg(v_prop,'notes') THEN public._wizard_txt(v_prop->>'notes', notes) ELSE notes END,
      year_built = CASE WHEN public._wizard_chg(v_prop,'year_built') AND COALESCE(v_prop->>'year_built','') ~ '^\d{4}$'
                        THEN (v_prop->>'year_built')::int ELSE year_built END
    WHERE id = v_property_id_in AND company_id = v_company_id;
    v_property_id := v_property_id_in;
    SELECT address INTO v_address FROM properties
    WHERE id = v_property_id AND company_id = v_company_id;
    -- The address changed: move every row keyed on the old text address to the
    -- new one NOW, before any lookup below keys on v_address.
    IF v_old_address IS NOT NULL AND v_address IS NOT NULL
       AND v_old_address IS DISTINCT FROM v_address THEN
      PERFORM public._cascade_property_rename(v_company_id, v_old_address, v_address);
    END IF;
  ELSE
    v_is_occupied := (v_prop->>'status') = 'occupied';
    IF EXISTS (SELECT 1 FROM properties WHERE company_id = v_company_id AND address = v_address AND archived_at IS NULL) THEN
      RAISE EXCEPTION 'A property with this address already exists';
    END IF;
    INSERT INTO properties (
      address, address_line_1, address_line_2, city, state, zip, county,
      type, status, notes, year_built, company_id
    ) VALUES (
      v_address, v_prop->>'address_line_1', v_prop->>'address_line_2',
      v_prop->>'city', v_prop->>'state', v_prop->>'zip', v_prop->>'county',
      v_prop->>'type', v_prop->>'status', v_prop->>'notes',
      CASE WHEN COALESCE(v_prop->>'year_built','') ~ '^\d{4}$' THEN (v_prop->>'year_built')::int END,
      v_company_id
    ) RETURNING id INTO v_property_id;
    SELECT address INTO v_address FROM properties
    WHERE id = v_property_id AND company_id = v_company_id;
  END IF;

  INSERT INTO acct_classes (id, name, description, color, is_active, company_id)
  VALUES (
    gen_random_uuid()::text, v_address,
    (v_prop->>'type') || ' · $' || COALESCE(v_tenant->>'rent','0') || '/mo',
    '#6366f1', true, v_company_id
  )
  ON CONFLICT (company_id, name) DO UPDATE SET
    description = EXCLUDED.description,
    is_active = true
  RETURNING id INTO v_class_id;
  UPDATE properties SET class_id = v_class_id WHERE id = v_property_id AND company_id = v_company_id;

  IF v_is_occupied AND v_tenant IS NOT NULL AND (v_tenant->>'tenant') IS NOT NULL AND (v_tenant->>'tenant') <> '' THEN
    v_tenant_name := v_tenant->>'tenant';
    v_names_chg := public._wizard_chg(v_tenant,'tenant') OR public._wizard_chg(v_tenant,'tenant_2')
                OR public._wizard_chg(v_tenant,'tenant_3') OR public._wizard_chg(v_tenant,'tenant_4');

    SELECT id INTO v_existing_tenant_id FROM tenants
    WHERE company_id = v_company_id AND name = v_tenant_name AND property = v_address AND archived_at IS NULL
    LIMIT 1;
    IF v_existing_tenant_id IS NULL THEN
      SELECT id INTO v_existing_tenant_id FROM tenants
      WHERE company_id = v_company_id AND property = v_address
        AND lower(COALESCE(email,'')) = lower(COALESCE(v_tenant->>'tenant_email',''))
        AND archived_at IS NULL
      LIMIT 1;
    END IF;
    IF v_existing_tenant_id IS NULL THEN
      SELECT id INTO v_existing_tenant_id FROM tenants
      WHERE company_id = v_company_id AND property = v_address
        AND lease_status = 'active' AND archived_at IS NULL
      LIMIT 1;
    END IF;

    IF v_existing_tenant_id IS NOT NULL THEN
      SELECT to_jsonb(t) INTO v_cur FROM tenants t WHERE id = v_existing_tenant_id FOR UPDATE;
      PERFORM public._wizard_guard(v_tenant, v_tenant->'_db', v_cur, ARRAY[
        'tenant','name', 'tenant_first','first_name', 'tenant_mi','middle_initial', 'tenant_last','last_name',
        'tenant_email','email', 'tenant_phone','phone', 'rent','rent', 'late_fee_amount','late_fee_amount',
        'late_fee_type','late_fee_type', 'lease_start','lease_start', 'lease_end','lease_end_date',
        'is_voucher','is_voucher', 'voucher_number','voucher_number', 'reexam_date','reexam_date',
        'case_manager_name','case_manager_name', 'case_manager_email','case_manager_email',
        'case_manager_phone','case_manager_phone', 'voucher_portion','voucher_portion', 'tenant_portion','tenant_portion'],
        'This tenant');
      UPDATE tenants SET
        name = CASE WHEN public._wizard_chg(v_tenant,'tenant') THEN v_tenant_name ELSE name END,
        first_name = CASE WHEN public._wizard_chg(v_tenant,'tenant_first') THEN public._wizard_txt(v_tenant->>'tenant_first', first_name) ELSE first_name END,
        middle_initial = CASE WHEN public._wizard_chg(v_tenant,'tenant_mi') THEN public._wizard_txt(v_tenant->>'tenant_mi', middle_initial) ELSE middle_initial END,
        last_name = CASE WHEN public._wizard_chg(v_tenant,'tenant_last') THEN public._wizard_txt(v_tenant->>'tenant_last', last_name) ELSE last_name END,
        email = CASE WHEN public._wizard_chg(v_tenant,'tenant_email') THEN public._wizard_txt(lower(v_tenant->>'tenant_email'), email) ELSE email END,
        phone = CASE WHEN public._wizard_chg(v_tenant,'tenant_phone') THEN public._wizard_txt(v_tenant->>'tenant_phone', phone) ELSE phone END,
        rent = CASE WHEN public._wizard_chg(v_tenant,'rent') THEN NULLIF(v_tenant->>'rent','')::numeric ELSE rent END,
        -- The wizard has no late-fee field: blank keeps the stored terms.
        late_fee_amount = CASE WHEN public._wizard_chg(v_tenant,'late_fee_amount')
          THEN COALESCE(NULLIF(v_tenant->>'late_fee_amount','')::numeric, late_fee_amount) ELSE late_fee_amount END,
        late_fee_type = CASE WHEN public._wizard_chg(v_tenant,'late_fee_type')
          THEN COALESCE(NULLIF(v_tenant->>'late_fee_type',''), late_fee_type, 'flat') ELSE late_fee_type END,
        -- A tenant the form loaded keeps their status (notice stays notice);
        -- one the form did not load is (re)activated, as before.
        lease_status = CASE WHEN jsonb_typeof(v_tenant->'_orig') = 'object' OR lease_status = 'notice'
                            THEN lease_status ELSE 'active' END,
        lease_start = CASE WHEN public._wizard_chg(v_tenant,'lease_start') THEN NULLIF(v_tenant->>'lease_start','')::date ELSE lease_start END,
        lease_end_date = CASE WHEN public._wizard_chg(v_tenant,'lease_end') THEN NULLIF(v_tenant->>'lease_end','')::date ELSE lease_end_date END,
        -- move_in is not on the form: only filled when empty, and only when the
        -- lease start is being written.
        move_in = CASE WHEN public._wizard_chg(v_tenant,'lease_start') THEN COALESCE(move_in, NULLIF(v_tenant->>'lease_start','')::date) ELSE move_in END,
        is_voucher = CASE WHEN public._wizard_chg(v_tenant,'is_voucher') THEN public._wizard_bool(v_tenant->>'is_voucher', is_voucher) ELSE is_voucher END,
        voucher_number = CASE WHEN public._wizard_chg(v_tenant,'voucher_number') THEN NULLIF(v_tenant->>'voucher_number','') ELSE voucher_number END,
        reexam_date = CASE WHEN public._wizard_chg(v_tenant,'reexam_date') THEN NULLIF(v_tenant->>'reexam_date','')::date ELSE reexam_date END,
        case_manager_name = CASE WHEN public._wizard_chg(v_tenant,'case_manager_name') THEN NULLIF(v_tenant->>'case_manager_name','') ELSE case_manager_name END,
        case_manager_email = CASE WHEN public._wizard_chg(v_tenant,'case_manager_email') THEN NULLIF(v_tenant->>'case_manager_email','') ELSE case_manager_email END,
        case_manager_phone = CASE WHEN public._wizard_chg(v_tenant,'case_manager_phone') THEN NULLIF(v_tenant->>'case_manager_phone','') ELSE case_manager_phone END,
        voucher_portion = CASE WHEN public._wizard_chg(v_tenant,'voucher_portion') THEN NULLIF(v_tenant->>'voucher_portion','')::numeric ELSE voucher_portion END,
        tenant_portion = CASE WHEN public._wizard_chg(v_tenant,'tenant_portion') THEN NULLIF(v_tenant->>'tenant_portion','')::numeric ELSE tenant_portion END,
        co_tenants = CASE WHEN public._wizard_chg(v_tenant,'tenant_2') OR public._wizard_chg(v_tenant,'tenant_3')
                            OR public._wizard_chg(v_tenant,'tenant_4') OR public._wizard_chg(v_tenant,'tenant_5')
          THEN ARRAY(SELECT x FROM unnest(ARRAY[
            NULLIF(btrim(v_tenant->>'tenant_2'),''), NULLIF(btrim(v_tenant->>'tenant_3'),''),
            NULLIF(btrim(v_tenant->>'tenant_4'),''), NULLIF(btrim(v_tenant->>'tenant_5'),'')
          ]) AS x WHERE x IS NOT NULL)
          ELSE co_tenants END
      WHERE id = v_existing_tenant_id AND company_id = v_company_id;
      v_tenant_id := v_existing_tenant_id;
    ELSE
      INSERT INTO tenants (
        company_id, name, first_name, middle_initial, last_name,
        email, phone, property, rent,
        late_fee_amount, late_fee_type, lease_status,
        lease_start, lease_end_date, move_in, balance,
        is_voucher, voucher_number, reexam_date,
        case_manager_name, case_manager_email, case_manager_phone,
        voucher_portion, tenant_portion, co_tenants
      ) VALUES (
        v_company_id, v_tenant_name,
        v_tenant->>'tenant_first', v_tenant->>'tenant_mi', v_tenant->>'tenant_last',
        lower(v_tenant->>'tenant_email'), v_tenant->>'tenant_phone', v_address,
        NULLIF(v_tenant->>'rent','')::numeric,
        NULLIF(v_tenant->>'late_fee_amount','')::numeric,
        COALESCE(NULLIF(v_tenant->>'late_fee_type',''),'flat'),
        'active',
        NULLIF(v_tenant->>'lease_start','')::date,
        NULLIF(v_tenant->>'lease_end','')::date,
        NULLIF(v_tenant->>'lease_start','')::date,
        0,
        COALESCE(NULLIF(v_tenant->>'is_voucher','')::boolean, false),
        NULLIF(v_tenant->>'voucher_number',''),
        NULLIF(v_tenant->>'reexam_date','')::date,
        NULLIF(v_tenant->>'case_manager_name',''),
        NULLIF(v_tenant->>'case_manager_email',''),
        NULLIF(v_tenant->>'case_manager_phone',''),
        NULLIF(v_tenant->>'voucher_portion','')::numeric,
        NULLIF(v_tenant->>'tenant_portion','')::numeric,
        ARRAY(SELECT x FROM unnest(ARRAY[
          NULLIF(btrim(v_tenant->>'tenant_2'),''), NULLIF(btrim(v_tenant->>'tenant_3'),''),
          NULLIF(btrim(v_tenant->>'tenant_4'),''), NULLIF(btrim(v_tenant->>'tenant_5'),'')
        ]) AS x WHERE x IS NOT NULL)
      ) RETURNING id INTO v_tenant_id;
    END IF;

    -- The property's copy of the tenancy (co-tenant slots, rent, deposit,
    -- dates): written per field, guarded against the property row as read.
    PERFORM public._wizard_guard(v_tenant, v_prop->'_db', v_prop_cur, ARRAY[
      'tenant_2','tenant_2', 'tenant_2_email','tenant_2_email', 'tenant_2_phone','tenant_2_phone',
      'tenant_3','tenant_3', 'tenant_3_email','tenant_3_email', 'tenant_3_phone','tenant_3_phone',
      'tenant_4','tenant_4', 'tenant_4_email','tenant_4_email', 'tenant_4_phone','tenant_4_phone',
      'tenant_5','tenant_5', 'tenant_5_email','tenant_5_email', 'tenant_5_phone','tenant_5_phone',
      'rent','rent', 'security_deposit','security_deposit', 'lease_start','lease_start', 'lease_end','lease_end'],
      'This property''s tenancy');
    UPDATE properties SET
      status = 'occupied',
      tenant = CASE WHEN public._wizard_chg(v_tenant,'tenant') OR COALESCE(tenant,'') = '' THEN v_tenant_name ELSE tenant END,
      tenant_2 = CASE WHEN public._wizard_chg(v_tenant,'tenant_2') THEN public._wizard_txt(v_tenant->>'tenant_2', tenant_2) ELSE tenant_2 END,
      tenant_2_email = CASE WHEN public._wizard_chg(v_tenant,'tenant_2_email') THEN public._wizard_txt(v_tenant->>'tenant_2_email', tenant_2_email) ELSE tenant_2_email END,
      tenant_2_phone = CASE WHEN public._wizard_chg(v_tenant,'tenant_2_phone') THEN public._wizard_txt(v_tenant->>'tenant_2_phone', tenant_2_phone) ELSE tenant_2_phone END,
      tenant_3 = CASE WHEN public._wizard_chg(v_tenant,'tenant_3') THEN public._wizard_txt(v_tenant->>'tenant_3', tenant_3) ELSE tenant_3 END,
      tenant_3_email = CASE WHEN public._wizard_chg(v_tenant,'tenant_3_email') THEN public._wizard_txt(v_tenant->>'tenant_3_email', tenant_3_email) ELSE tenant_3_email END,
      tenant_3_phone = CASE WHEN public._wizard_chg(v_tenant,'tenant_3_phone') THEN public._wizard_txt(v_tenant->>'tenant_3_phone', tenant_3_phone) ELSE tenant_3_phone END,
      tenant_4 = CASE WHEN public._wizard_chg(v_tenant,'tenant_4') THEN public._wizard_txt(v_tenant->>'tenant_4', tenant_4) ELSE tenant_4 END,
      tenant_4_email = CASE WHEN public._wizard_chg(v_tenant,'tenant_4_email') THEN public._wizard_txt(v_tenant->>'tenant_4_email', tenant_4_email) ELSE tenant_4_email END,
      tenant_4_phone = CASE WHEN public._wizard_chg(v_tenant,'tenant_4_phone') THEN public._wizard_txt(v_tenant->>'tenant_4_phone', tenant_4_phone) ELSE tenant_4_phone END,
      tenant_5 = CASE WHEN public._wizard_chg(v_tenant,'tenant_5') THEN public._wizard_txt(v_tenant->>'tenant_5', tenant_5) ELSE tenant_5 END,
      tenant_5_email = CASE WHEN public._wizard_chg(v_tenant,'tenant_5_email') THEN public._wizard_txt(v_tenant->>'tenant_5_email', tenant_5_email) ELSE tenant_5_email END,
      tenant_5_phone = CASE WHEN public._wizard_chg(v_tenant,'tenant_5_phone') THEN public._wizard_txt(v_tenant->>'tenant_5_phone', tenant_5_phone) ELSE tenant_5_phone END,
      rent = CASE WHEN public._wizard_chg(v_tenant,'rent') THEN NULLIF(v_tenant->>'rent','')::numeric ELSE rent END,
      security_deposit = CASE WHEN public._wizard_chg(v_tenant,'security_deposit')
        THEN public._wizard_num(v_tenant->>'security_deposit', security_deposit, 0) ELSE security_deposit END,
      -- properties.lease_start is TEXT (lease_end is a date).
      lease_start = CASE WHEN public._wizard_chg(v_tenant,'lease_start') THEN NULLIF(v_tenant->>'lease_start','')::date::text ELSE lease_start END,
      lease_end = CASE WHEN public._wizard_chg(v_tenant,'lease_end') THEN NULLIF(v_tenant->>'lease_end','')::date ELSE lease_end END
    WHERE id = v_property_id AND company_id = v_company_id;

    IF (v_tenant->>'lease_start') IS NOT NULL AND (v_tenant->>'lease_start') <> ''
       AND (v_tenant->>'lease_end') IS NOT NULL AND (v_tenant->>'lease_end') <> '' THEN
      v_all_tenants := concat_ws(' / ',
        NULLIF(v_tenant->>'tenant',''),
        NULLIF(v_tenant->>'tenant_2',''),
        NULLIF(v_tenant->>'tenant_3',''),
        NULLIF(v_tenant->>'tenant_4','')
      );
      SELECT id, to_jsonb(l) INTO v_existing_lease_id, v_cur FROM leases l
      WHERE company_id = v_company_id AND property = v_address AND status = 'active'
      LIMIT 1;
      IF v_existing_lease_id IS NOT NULL THEN
        PERFORM public._wizard_guard(v_tenant, v_tenant->'_db_lease', v_cur, ARRAY[
          'lease_start','start_date', 'lease_end','end_date', 'rent','rent_amount', 'security_deposit','security_deposit'],
          'This lease');
        -- payment_due_day is not on the wizard form: never written here.
        UPDATE leases SET
          tenant_name = CASE WHEN v_names_chg THEN v_all_tenants ELSE tenant_name END,
          tenant_id = CASE WHEN tenant_id IS NULL OR v_names_chg THEN v_tenant_id ELSE tenant_id END,
          start_date = CASE WHEN public._wizard_chg(v_tenant,'lease_start') THEN (v_tenant->>'lease_start')::date ELSE start_date END,
          end_date = CASE WHEN public._wizard_chg(v_tenant,'lease_end') THEN (v_tenant->>'lease_end')::date ELSE end_date END,
          rent_amount = CASE WHEN public._wizard_chg(v_tenant,'rent') THEN NULLIF(v_tenant->>'rent','')::numeric ELSE rent_amount END,
          security_deposit = CASE WHEN public._wizard_chg(v_tenant,'security_deposit')
            THEN public._wizard_num(v_tenant->>'security_deposit', security_deposit, 0) ELSE security_deposit END
        WHERE id = v_existing_lease_id AND company_id = v_company_id;
        v_lease_id := v_existing_lease_id;
      ELSE
        INSERT INTO leases (
          company_id, tenant_name, tenant_id, property,
          start_date, end_date, rent_amount, security_deposit,
          status, payment_due_day
        ) VALUES (
          v_company_id, v_all_tenants, v_tenant_id, v_address,
          (v_tenant->>'lease_start')::date,
          (v_tenant->>'lease_end')::date,
          NULLIF(v_tenant->>'rent','')::numeric,
          COALESCE(NULLIF(v_tenant->>'security_deposit','')::numeric, 0),
          'active', 1
        ) RETURNING id INTO v_lease_id;
      END IF;
    END IF;
  END IF;

  -- ─── UTILITIES ────────────────────────────────────────────────────
  -- Removal FIRST: only rows the form saw when it opened and that are gone
  -- from the payload (the user removed them). Final bills are never archived
  -- here. Doing it first lets a replacement row with the same provider and
  -- account number be inserted below.
  IF v_mode = 'edit' AND jsonb_typeof(p_payload->'utilities_seen_ids') = 'array' THEN
    UPDATE utilities SET archived_at = now()
     WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL
       AND is_final_bill IS NOT TRUE
       AND id::text IN (SELECT jsonb_array_elements_text(p_payload->'utilities_seen_ids'))
       AND id::text NOT IN (SELECT e->>'id' FROM jsonb_array_elements(v_utilities) e WHERE COALESCE(e->>'id','') <> '');
  END IF;
  FOR v_u IN SELECT * FROM jsonb_array_elements(v_utilities) LOOP
    IF jsonb_typeof(v_u) <> 'object' OR COALESCE(btrim(v_u->>'provider'),'') = '' THEN CONTINUE; END IF;
    v_resp := CASE lower(COALESCE(v_u->>'responsibility',''))
      WHEN 'owner_pays' THEN 'owner' WHEN 'owner' THEN 'owner'
      WHEN 'tenant_pays' THEN 'tenant' WHEN 'tenant' THEN 'tenant'
      WHEN 'condo_fee' THEN 'condo_fee'
      ELSE NULL END;
    v_row_id := NULL;
    v_row_gone := false;
    -- Matched by id only. A row with no id is new: it is never merged into an
    -- existing row that happens to share its name.
    IF v_mode = 'edit' AND COALESCE(v_u->>'id','') <> '' THEN
      SELECT id, to_jsonb(x) INTO v_row_id, v_cur FROM utilities x
       WHERE id::text = v_u->>'id' AND company_id = v_company_id
         AND property = v_address AND archived_at IS NULL
       FOR UPDATE;
      -- Removed elsewhere since the form loaded it (or not this property's):
      -- do not bring it back.
      v_row_gone := v_row_id IS NULL;
    END IF;
    IF v_row_gone THEN CONTINUE; END IF;

    IF v_row_id IS NOT NULL THEN
      PERFORM public._wizard_guard(v_u, v_u->'_db', v_cur, ARRAY[
        'provider','provider', 'type','type', 'account_number','account_number', 'due_day','due',
        'responsibility','responsibility', 'website','website'], 'Utility "' || (v_cur->>'provider') || '"');
      UPDATE utilities SET
        provider = CASE WHEN public._wizard_chg(v_u,'provider') THEN v_u->>'provider' ELSE provider END,
        type = CASE WHEN public._wizard_chg(v_u,'type') THEN COALESCE(NULLIF(v_u->>'type',''), type) ELSE type END,
        account_number = CASE WHEN public._wizard_chg(v_u,'account_number') THEN COALESCE(NULLIF(v_u->>'account_number',''), account_number) ELSE account_number END,
        amount = CASE WHEN public._wizard_chg(v_u,'amount') THEN COALESCE(NULLIF(v_u->>'amount','')::numeric, amount) ELSE amount END,
        due = CASE WHEN public._wizard_chg(v_u,'due_day') OR public._wizard_chg(v_u,'due_date')
          THEN public._wizard_merge_due(due, public._wizard_safe_date(v_u->>'due_date'), public._wizard_day(v_u->>'due_day'))
          ELSE due END,
        responsibility = CASE WHEN public._wizard_chg(v_u,'responsibility') THEN COALESCE(v_resp, responsibility) ELSE responsibility END,
        website = CASE WHEN public._wizard_chg(v_u,'website') THEN COALESCE(NULLIF(v_u->>'website',''), website) ELSE website END,
        username_encrypted = CASE WHEN NULLIF(v_u->>'username_encrypted','') IS NOT NULL
          THEN v_u->>'username_encrypted' ELSE username_encrypted END,
        password_encrypted = CASE WHEN NULLIF(v_u->>'username_encrypted','') IS NOT NULL
          THEN v_u->>'password_encrypted' ELSE password_encrypted END,
        encryption_iv = CASE WHEN NULLIF(v_u->>'username_encrypted','') IS NOT NULL
          THEN v_u->>'encryption_iv' ELSE encryption_iv END,
        encryption_iv_username = CASE WHEN NULLIF(v_u->>'username_encrypted','') IS NOT NULL
          THEN v_u->>'encryption_iv_username' ELSE encryption_iv_username END,
        encryption_salt = CASE WHEN NULLIF(v_u->>'username_encrypted','') IS NOT NULL
          THEN v_u->>'encryption_salt' ELSE encryption_salt END,
        credential_key_fp = CASE WHEN NULLIF(v_u->>'username_encrypted','') IS NOT NULL
          THEN COALESCE(NULLIF(v_u->>'credential_key_fp',''), credential_key_fp) ELSE credential_key_fp END
      WHERE id = v_row_id AND company_id = v_company_id;
    ELSE
      INSERT INTO utilities (
        company_id, property, provider, type, account_number, amount, due,
        responsibility, status, website,
        username_encrypted, password_encrypted,
        encryption_iv, encryption_iv_username, encryption_salt, credential_key_fp
      ) VALUES (
        v_company_id, v_address, btrim(v_u->>'provider'), COALESCE(NULLIF(v_u->>'type',''),'Electric'), NULLIF(v_u->>'account_number',''),
        COALESCE(NULLIF(v_u->>'amount','')::numeric, 0),
        -- No date and no day given (a blank import cell): left blank rather
        -- than invented. The wizard always sends a day for a new row.
        public._wizard_merge_due(NULL, public._wizard_safe_date(v_u->>'due_date'), public._wizard_day(v_u->>'due_day')),
        v_resp,
        'pending',
        COALESCE(v_u->>'website',''),
        NULLIF(v_u->>'username_encrypted',''), NULLIF(v_u->>'password_encrypted',''),
        NULLIF(v_u->>'encryption_iv',''), NULLIF(v_u->>'encryption_iv_username',''),
        NULLIF(v_u->>'encryption_salt',''), NULLIF(v_u->>'credential_key_fp','')
      );
    END IF;
  END LOOP;

  -- ─── HOAs ─────────────────────────────────────────────────────────
  -- Same rules. status and paid_date are never written on an existing row:
  -- a paid bill stays paid.
  IF v_mode = 'edit' AND jsonb_typeof(p_payload->'hoas_seen_ids') = 'array' THEN
    UPDATE hoa_payments SET archived_at = now(), archived_by = v_caller_email
     WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL
       AND id::text IN (SELECT jsonb_array_elements_text(p_payload->'hoas_seen_ids'))
       AND id::text NOT IN (SELECT e->>'id' FROM jsonb_array_elements(v_hoas) e WHERE COALESCE(e->>'id','') <> '');
  END IF;
  FOR v_h IN SELECT * FROM jsonb_array_elements(v_hoas) LOOP
    IF jsonb_typeof(v_h) <> 'object' OR COALESCE(btrim(v_h->>'hoa_name'),'') = '' THEN CONTINUE; END IF;
    v_row_id := NULL;
    v_row_gone := false;
    IF v_mode = 'edit' AND COALESCE(v_h->>'id','') <> '' THEN
      SELECT id, to_jsonb(x) INTO v_row_id, v_cur FROM hoa_payments x
       WHERE id::text = v_h->>'id' AND company_id = v_company_id
         AND property = v_address AND archived_at IS NULL
       FOR UPDATE;
      v_row_gone := v_row_id IS NULL;
    END IF;
    IF v_row_gone THEN CONTINUE; END IF;

    IF v_row_id IS NOT NULL THEN
      PERFORM public._wizard_guard(v_h, v_h->'_db', v_cur, ARRAY[
        'hoa_name','hoa_name', 'amount','amount', 'due_day','due_date', 'frequency','frequency', 'notes','notes',
        'website','website', 'management_company','management_company', 'mgmt_website','mgmt_website',
        'pay_portal_website','pay_portal_website', 'contact_name','contact_name', 'contact_email','contact_email',
        'contact_phone','contact_phone'], 'HOA "' || (v_cur->>'hoa_name') || '"');
      UPDATE hoa_payments SET
        hoa_name = CASE WHEN public._wizard_chg(v_h,'hoa_name') THEN btrim(v_h->>'hoa_name') ELSE hoa_name END,
        amount = CASE WHEN public._wizard_chg(v_h,'amount') THEN COALESCE(NULLIF(v_h->>'amount','')::numeric, amount) ELSE amount END,
        due_date = CASE WHEN NOT (public._wizard_chg(v_h,'due_day') OR public._wizard_chg(v_h,'due_date')) THEN due_date
          WHEN public._wizard_merge_due(public._wizard_safe_date(due_date),
                 public._wizard_safe_date(v_h->>'due_date'), public._wizard_day(v_h->>'due_day'))
               IS NOT DISTINCT FROM public._wizard_safe_date(due_date)
            THEN due_date
          ELSE COALESCE(public._wizard_merge_due(public._wizard_safe_date(due_date),
                 public._wizard_safe_date(v_h->>'due_date'), public._wizard_day(v_h->>'due_day'))::text, due_date)
        END,
        frequency = CASE WHEN public._wizard_chg(v_h,'frequency') THEN COALESCE(NULLIF(v_h->>'frequency',''), frequency) ELSE frequency END,
        notes = CASE WHEN public._wizard_chg(v_h,'notes') THEN COALESCE(NULLIF(v_h->>'notes',''), notes) ELSE notes END,
        website = CASE WHEN public._wizard_chg(v_h,'website') THEN COALESCE(NULLIF(v_h->>'website',''), website) ELSE website END,
        username_encrypted = CASE WHEN NULLIF(v_h->>'username_encrypted','') IS NOT NULL
          THEN v_h->>'username_encrypted' ELSE username_encrypted END,
        password_encrypted = CASE WHEN NULLIF(v_h->>'username_encrypted','') IS NOT NULL
          THEN v_h->>'password_encrypted' ELSE password_encrypted END,
        encryption_iv = CASE WHEN NULLIF(v_h->>'username_encrypted','') IS NOT NULL
          THEN v_h->>'encryption_iv' ELSE encryption_iv END,
        encryption_iv_username = CASE WHEN NULLIF(v_h->>'username_encrypted','') IS NOT NULL
          THEN v_h->>'encryption_iv_username' ELSE encryption_iv_username END,
        encryption_salt = CASE WHEN NULLIF(v_h->>'username_encrypted','') IS NOT NULL
          THEN v_h->>'encryption_salt' ELSE encryption_salt END,
        credential_key_fp = COALESCE(NULLIF(v_h->>'credential_key_fp',''), credential_key_fp),
        management_company = CASE WHEN public._wizard_chg(v_h,'management_company') THEN COALESCE(NULLIF(v_h->>'management_company',''), management_company) ELSE management_company END,
        mgmt_website = CASE WHEN public._wizard_chg(v_h,'mgmt_website') THEN COALESCE(NULLIF(v_h->>'mgmt_website',''), mgmt_website) ELSE mgmt_website END,
        mgmt_username_encrypted = CASE WHEN NULLIF(v_h->>'mgmt_username_encrypted','') IS NOT NULL
          THEN v_h->>'mgmt_username_encrypted' ELSE mgmt_username_encrypted END,
        mgmt_password_encrypted = CASE WHEN NULLIF(v_h->>'mgmt_username_encrypted','') IS NOT NULL
          THEN v_h->>'mgmt_password_encrypted' ELSE mgmt_password_encrypted END,
        mgmt_encryption_iv = CASE WHEN NULLIF(v_h->>'mgmt_username_encrypted','') IS NOT NULL
          THEN v_h->>'mgmt_encryption_iv' ELSE mgmt_encryption_iv END,
        mgmt_encryption_iv_username = CASE WHEN NULLIF(v_h->>'mgmt_username_encrypted','') IS NOT NULL
          THEN v_h->>'mgmt_encryption_iv_username' ELSE mgmt_encryption_iv_username END,
        pay_portal_website = CASE WHEN public._wizard_chg(v_h,'pay_portal_website') THEN COALESCE(NULLIF(v_h->>'pay_portal_website',''), pay_portal_website) ELSE pay_portal_website END,
        pay_username_encrypted = CASE WHEN NULLIF(v_h->>'pay_username_encrypted','') IS NOT NULL
          THEN v_h->>'pay_username_encrypted' ELSE pay_username_encrypted END,
        pay_password_encrypted = CASE WHEN NULLIF(v_h->>'pay_username_encrypted','') IS NOT NULL
          THEN v_h->>'pay_password_encrypted' ELSE pay_password_encrypted END,
        pay_encryption_iv = CASE WHEN NULLIF(v_h->>'pay_username_encrypted','') IS NOT NULL
          THEN v_h->>'pay_encryption_iv' ELSE pay_encryption_iv END,
        pay_encryption_iv_username = CASE WHEN NULLIF(v_h->>'pay_username_encrypted','') IS NOT NULL
          THEN v_h->>'pay_encryption_iv_username' ELSE pay_encryption_iv_username END,
        contact_name = CASE WHEN public._wizard_chg(v_h,'contact_name') THEN COALESCE(NULLIF(v_h->>'contact_name',''), contact_name) ELSE contact_name END,
        contact_email = CASE WHEN public._wizard_chg(v_h,'contact_email') THEN COALESCE(NULLIF(v_h->>'contact_email',''), contact_email) ELSE contact_email END,
        contact_phone = CASE WHEN public._wizard_chg(v_h,'contact_phone') THEN COALESCE(NULLIF(v_h->>'contact_phone',''), contact_phone) ELSE contact_phone END
      WHERE id = v_row_id AND company_id = v_company_id;
    ELSE
      IF NULLIF(btrim(COALESCE(v_h->>'amount','')), '') IS NULL THEN
        RAISE EXCEPTION 'Enter an amount for the new HOA "%" before saving.', btrim(v_h->>'hoa_name');
      END IF;
      INSERT INTO hoa_payments (
        company_id, property, hoa_name, amount, due_date,
        frequency, status, notes, website,
        username_encrypted, password_encrypted,
        encryption_iv, encryption_iv_username, encryption_salt, credential_key_fp,
        management_company, mgmt_website,
        mgmt_username_encrypted, mgmt_password_encrypted,
        mgmt_encryption_iv, mgmt_encryption_iv_username,
        pay_portal_website,
        pay_username_encrypted, pay_password_encrypted,
        pay_encryption_iv, pay_encryption_iv_username,
        contact_name, contact_email, contact_phone
      ) VALUES (
        v_company_id, v_address, btrim(v_h->>'hoa_name'),
        (v_h->>'amount')::numeric,
        COALESCE(public._wizard_merge_due(NULL, public._wizard_safe_date(v_h->>'due_date'),
          public._wizard_day(v_h->>'due_day'))::text, ''),
        COALESCE(NULLIF(v_h->>'frequency',''),'Monthly'),
        'pending',
        COALESCE(v_h->>'notes',''),
        COALESCE(v_h->>'website',''),
        NULLIF(v_h->>'username_encrypted',''), NULLIF(v_h->>'password_encrypted',''),
        NULLIF(v_h->>'encryption_iv',''), NULLIF(v_h->>'encryption_iv_username',''),
        NULLIF(v_h->>'encryption_salt',''), NULLIF(v_h->>'credential_key_fp',''),
        NULLIF(v_h->>'management_company',''), COALESCE(v_h->>'mgmt_website',''),
        NULLIF(v_h->>'mgmt_username_encrypted',''), NULLIF(v_h->>'mgmt_password_encrypted',''),
        NULLIF(v_h->>'mgmt_encryption_iv',''), NULLIF(v_h->>'mgmt_encryption_iv_username',''),
        COALESCE(v_h->>'pay_portal_website',''),
        NULLIF(v_h->>'pay_username_encrypted',''), NULLIF(v_h->>'pay_password_encrypted',''),
        NULLIF(v_h->>'pay_encryption_iv',''), NULLIF(v_h->>'pay_encryption_iv_username',''),
        NULLIF(v_h->>'contact_name',''), NULLIF(v_h->>'contact_email',''), NULLIF(v_h->>'contact_phone','')
      );
    END IF;
  END LOOP;

  -- ─── LOAN ─────────────────────────────────────────────────────────
  IF v_loan IS NOT NULL AND COALESCE(NULLIF(v_loan->>'enabled','')::boolean, false) THEN
    v_loan_has_creds := NULLIF(v_loan->>'username_encrypted','') IS NOT NULL
                    AND NULLIF(v_loan->>'password_encrypted','') IS NOT NULL;
    v_loan_id := NULLIF(v_loan->>'id','');
    v_skip := false;
    v_existing_loan_id := NULL;
    IF v_loan_id IS NOT NULL THEN
      -- By id AND this property: an id belonging to another property is not
      -- this wizard's to write.
      SELECT id, to_jsonb(x) INTO v_existing_loan_id, v_cur FROM property_loans x
       WHERE id::text = v_loan_id AND company_id = v_company_id AND property = v_address AND archived_at IS NULL
       FOR UPDATE;
      -- Archived since the form loaded it, or not this property's: never
      -- resurrect or overwrite it.
      v_skip := v_existing_loan_id IS NULL;
    END IF;
    IF v_skip THEN
      NULL;
    ELSIF v_existing_loan_id IS NOT NULL THEN
      PERFORM public._wizard_guard(v_loan, v_loan->'_db', v_cur, ARRAY[
        'lender_name','lender_name', 'loan_type','loan_type', 'original_amount','original_amount',
        'current_balance','current_balance', 'interest_rate','interest_rate', 'monthly_payment','monthly_payment',
        'escrow_included','escrow_included', 'escrow_amount','escrow_amount', 'loan_start_date','loan_start_date',
        'maturity_date','maturity_date', 'account_number','account_number', 'notes','notes', 'website','website'],
        'Loan "' || (v_cur->>'lender_name') || '"');
      UPDATE property_loans SET
        lender_name = CASE WHEN public._wizard_chg(v_loan,'lender_name') THEN v_loan->>'lender_name' ELSE lender_name END,
        loan_type = CASE WHEN public._wizard_chg(v_loan,'loan_type') THEN COALESCE(NULLIF(v_loan->>'loan_type',''), loan_type, 'Conventional') ELSE loan_type END,
        original_amount = CASE WHEN public._wizard_chg(v_loan,'original_amount') THEN public._wizard_num(v_loan->>'original_amount', original_amount) ELSE original_amount END,
        current_balance = CASE WHEN public._wizard_chg(v_loan,'current_balance') THEN public._wizard_num(v_loan->>'current_balance', current_balance) ELSE current_balance END,
        interest_rate = CASE WHEN public._wizard_chg(v_loan,'interest_rate') THEN public._wizard_num(v_loan->>'interest_rate', interest_rate) ELSE interest_rate END,
        monthly_payment = CASE WHEN public._wizard_chg(v_loan,'monthly_payment') THEN public._wizard_num(v_loan->>'monthly_payment', monthly_payment) ELSE monthly_payment END,
        escrow_included = CASE WHEN public._wizard_chg(v_loan,'escrow_included') THEN public._wizard_bool(v_loan->>'escrow_included', escrow_included) ELSE escrow_included END,
        escrow_amount = CASE WHEN public._wizard_chg(v_loan,'escrow_amount') THEN public._wizard_num(v_loan->>'escrow_amount', escrow_amount) ELSE escrow_amount END,
        loan_start_date = CASE WHEN public._wizard_chg(v_loan,'loan_start_date') THEN NULLIF(v_loan->>'loan_start_date','')::date ELSE loan_start_date END,
        maturity_date = CASE WHEN public._wizard_chg(v_loan,'maturity_date') THEN NULLIF(v_loan->>'maturity_date','')::date ELSE maturity_date END,
        account_number = CASE WHEN public._wizard_chg(v_loan,'account_number') THEN COALESCE(NULLIF(v_loan->>'account_number',''), account_number) ELSE account_number END,
        username_encrypted = CASE WHEN v_loan_has_creds THEN v_loan->>'username_encrypted' ELSE username_encrypted END,
        password_encrypted = CASE WHEN v_loan_has_creds THEN v_loan->>'password_encrypted' ELSE password_encrypted END,
        encryption_iv_username = CASE WHEN v_loan_has_creds THEN v_loan->>'encryption_iv_username' ELSE encryption_iv_username END,
        encryption_iv = CASE WHEN v_loan_has_creds THEN v_loan->>'encryption_iv' ELSE encryption_iv END,
        encryption_salt = CASE WHEN v_loan_has_creds THEN v_loan->>'encryption_salt' ELSE encryption_salt END,
        credential_key_fp = CASE WHEN v_loan_has_creds
          THEN COALESCE(NULLIF(v_loan->>'credential_key_fp',''), credential_key_fp) ELSE credential_key_fp END,
        website = CASE WHEN public._wizard_chg(v_loan,'website') THEN COALESCE(NULLIF(v_loan->>'website',''), website) ELSE website END,
        notes = CASE WHEN public._wizard_chg(v_loan,'notes') THEN COALESCE(NULLIF(v_loan->>'notes',''), notes) ELSE notes END
      WHERE id = v_existing_loan_id AND company_id = v_company_id;
    ELSE
      INSERT INTO property_loans (
        company_id, property, property_id, lender_name, loan_type,
        original_amount, current_balance, interest_rate, monthly_payment,
        escrow_included, escrow_amount, loan_start_date, maturity_date,
        account_number,
        username_encrypted, password_encrypted,
        encryption_iv_username, encryption_iv, encryption_salt, credential_key_fp,
        website, notes
      ) VALUES (
        v_company_id, v_address, v_property_id::text,
        v_loan->>'lender_name',
        COALESCE(NULLIF(v_loan->>'loan_type',''),'Conventional'),
        NULLIF(v_loan->>'original_amount','')::numeric,
        NULLIF(v_loan->>'current_balance','')::numeric,
        NULLIF(v_loan->>'interest_rate','')::numeric,
        NULLIF(v_loan->>'monthly_payment','')::numeric,
        COALESCE(NULLIF(v_loan->>'escrow_included','')::boolean, false),
        NULLIF(v_loan->>'escrow_amount','')::numeric,
        NULLIF(v_loan->>'loan_start_date','')::date,
        NULLIF(v_loan->>'maturity_date','')::date,
        v_loan->>'account_number',
        v_loan->>'username_encrypted', v_loan->>'password_encrypted',
        v_loan->>'encryption_iv_username', v_loan->>'encryption_iv',
        v_loan->>'encryption_salt', NULLIF(v_loan->>'credential_key_fp',''),
        COALESCE(v_loan->>'website',''),
        COALESCE(v_loan->>'notes','')
      );
    END IF;
    -- Owner decision (audit theme K, double expenses): no Mortgage/Loan
    -- recurring journal schedule is created or updated here.
    -- setup_recurring / payment_day are ignored.
  ELSIF v_mode = 'edit' AND v_loan IS NOT NULL AND NULLIF(v_loan->>'id','') IS NOT NULL THEN
    -- The user switched off THIS loan (or moved the property to a portfolio
    -- loan). Only that loan, and only if it is this property's.
    UPDATE property_loans SET archived_at = now()
     WHERE id::text = v_loan->>'id' AND company_id = v_company_id
       AND property = v_address AND archived_at IS NULL;
    IF FOUND AND NOT EXISTS (SELECT 1 FROM property_loans
                    WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL) THEN
      UPDATE recurring_journal_entries SET status = 'inactive', archived_at = now()
       WHERE company_id = v_company_id AND property = v_address AND status = 'active'
         AND archived_at IS NULL AND description LIKE 'Mortgage/Loan%';
    END IF;
  END IF;

  -- ─── INSURANCE ────────────────────────────────────────────────────
  IF v_insurance IS NOT NULL AND COALESCE(NULLIF(v_insurance->>'enabled','')::boolean, false) THEN
    v_ins_has_creds := NULLIF(v_insurance->>'username_encrypted','') IS NOT NULL
                   AND NULLIF(v_insurance->>'password_encrypted','') IS NOT NULL;
    v_ins_id := NULLIF(v_insurance->>'id','');
    v_skip := false;
    v_existing_ins_id := NULL;
    IF v_ins_id IS NOT NULL THEN
      SELECT id, to_jsonb(x) INTO v_existing_ins_id, v_cur FROM property_insurance x
      WHERE id::text = v_ins_id AND company_id = v_company_id AND property = v_address AND archived_at IS NULL
      FOR UPDATE;
      v_skip := v_existing_ins_id IS NULL;   -- archived meanwhile / another property's
    END IF;
    IF v_skip THEN
      NULL;
    ELSIF v_existing_ins_id IS NOT NULL THEN
      PERFORM public._wizard_guard(v_insurance, v_insurance->'_db', v_cur, ARRAY[
        'provider','provider', 'policy_number','policy_number', 'premium_amount','premium_amount',
        'premium_frequency','premium_frequency', 'coverage_amount','coverage_amount',
        'expiration_date','expiration_date', 'notes','notes', 'website','website'],
        'Insurance policy "' || COALESCE(v_cur->>'provider','') || '"');
      UPDATE property_insurance SET
        provider = CASE WHEN public._wizard_chg(v_insurance,'provider') THEN v_insurance->>'provider' ELSE provider END,
        policy_number = CASE WHEN public._wizard_chg(v_insurance,'policy_number') THEN public._wizard_txt(v_insurance->>'policy_number', policy_number) ELSE policy_number END,
        premium_amount = CASE WHEN public._wizard_chg(v_insurance,'premium_amount') THEN public._wizard_num(v_insurance->>'premium_amount', premium_amount) ELSE premium_amount END,
        premium_frequency = CASE WHEN public._wizard_chg(v_insurance,'premium_frequency') THEN COALESCE(NULLIF(v_insurance->>'premium_frequency',''), premium_frequency) ELSE premium_frequency END,
        coverage_amount = CASE WHEN public._wizard_chg(v_insurance,'coverage_amount') THEN public._wizard_num(v_insurance->>'coverage_amount', coverage_amount) ELSE coverage_amount END,
        expiration_date = CASE WHEN public._wizard_chg(v_insurance,'expiration_date') THEN NULLIF(v_insurance->>'expiration_date','')::date ELSE expiration_date END,
        notes = CASE WHEN public._wizard_chg(v_insurance,'notes') THEN COALESCE(NULLIF(v_insurance->>'notes',''), notes) ELSE notes END,
        website = CASE WHEN public._wizard_chg(v_insurance,'website') THEN COALESCE(NULLIF(v_insurance->>'website',''), website) ELSE website END,
        username_encrypted = CASE WHEN v_ins_has_creds THEN v_insurance->>'username_encrypted' ELSE username_encrypted END,
        password_encrypted = CASE WHEN v_ins_has_creds THEN v_insurance->>'password_encrypted' ELSE password_encrypted END,
        encryption_iv_username = CASE WHEN v_ins_has_creds THEN v_insurance->>'encryption_iv_username' ELSE encryption_iv_username END,
        encryption_iv = CASE WHEN v_ins_has_creds THEN v_insurance->>'encryption_iv' ELSE encryption_iv END,
        encryption_salt = CASE WHEN v_ins_has_creds THEN v_insurance->>'encryption_salt' ELSE encryption_salt END,
        credential_key_fp = CASE WHEN v_ins_has_creds
          THEN COALESCE(NULLIF(v_insurance->>'credential_key_fp',''), credential_key_fp) ELSE credential_key_fp END
      WHERE id = v_existing_ins_id AND company_id = v_company_id;
    ELSE
      INSERT INTO property_insurance (
        company_id, property, property_id,
        provider, policy_number, premium_amount, premium_frequency,
        coverage_amount, expiration_date, notes, website,
        username_encrypted, password_encrypted,
        encryption_iv_username, encryption_iv, encryption_salt, credential_key_fp
      ) VALUES (
        v_company_id, v_address, v_property_id::text,
        v_insurance->>'provider', v_insurance->>'policy_number',
        NULLIF(v_insurance->>'premium_amount','')::numeric,
        COALESCE(NULLIF(v_insurance->>'premium_frequency',''),'annual'),
        NULLIF(v_insurance->>'coverage_amount','')::numeric,
        NULLIF(v_insurance->>'expiration_date','')::date,
        COALESCE(v_insurance->>'notes',''),
        COALESCE(v_insurance->>'website',''),
        v_insurance->>'username_encrypted', v_insurance->>'password_encrypted',
        v_insurance->>'encryption_iv_username', v_insurance->>'encryption_iv',
        v_insurance->>'encryption_salt', NULLIF(v_insurance->>'credential_key_fp','')
      );
    END IF;
  ELSIF v_mode = 'edit' AND v_insurance IS NOT NULL AND NULLIF(v_insurance->>'id','') IS NOT NULL THEN
    -- The user switched off THIS policy; a skipped or unloaded insurance step
    -- (no id) leaves every policy alone.
    UPDATE property_insurance SET archived_at = now()
     WHERE id::text = v_insurance->>'id' AND company_id = v_company_id
       AND property = v_address AND archived_at IS NULL;
  END IF;

  -- ─── PROPERTY TAX ─────────────────────────────────────────────────
  IF v_taxes IS NOT NULL AND COALESCE(NULLIF(v_taxes->>'enabled','')::boolean, false) THEN
    v_tax_id := NULLIF(v_taxes->>'id','');
    v_skip := false;
    v_existing_tax_id := NULL;
    IF v_tax_id IS NOT NULL THEN
      SELECT id, to_jsonb(x) INTO v_existing_tax_id, v_cur FROM property_taxes x
      WHERE id::text = v_tax_id AND company_id = v_company_id AND property = v_address AND archived_at IS NULL
      FOR UPDATE;
      v_skip := v_existing_tax_id IS NULL;
    END IF;
    IF v_skip THEN
      NULL;
    ELSIF v_existing_tax_id IS NOT NULL THEN
      PERFORM public._wizard_guard(v_taxes, v_taxes->'_db', v_cur, ARRAY[
        'parcel_id','parcel_id', 'assessed_value','assessed_value', 'tax_year','tax_year',
        'annual_tax_amount','annual_tax_amount', 'billing_frequency','billing_frequency',
        'next_due_date','next_due_date', 'exemptions','exemptions', 'escrow_paid_by_lender','escrow_paid_by_lender',
        'records_url','records_url', 'notes','notes'], 'The property tax record');
      UPDATE property_taxes SET
        county = CASE WHEN public._wizard_chg(v_taxes,'county') THEN COALESCE(NULLIF(v_taxes->>'county',''), county) ELSE county END,
        jurisdiction = CASE WHEN public._wizard_chg(v_taxes,'jurisdiction') THEN COALESCE(NULLIF(v_taxes->>'jurisdiction',''), jurisdiction) ELSE jurisdiction END,
        parcel_id = CASE WHEN public._wizard_chg(v_taxes,'parcel_id') THEN public._wizard_txt(NULLIF(v_taxes->>'parcel_id',''), parcel_id) ELSE parcel_id END,
        assessed_value = CASE WHEN public._wizard_chg(v_taxes,'assessed_value') THEN NULLIF(v_taxes->>'assessed_value','')::numeric ELSE assessed_value END,
        tax_year = CASE WHEN public._wizard_chg(v_taxes,'tax_year') THEN NULLIF(v_taxes->>'tax_year','')::int ELSE tax_year END,
        annual_tax_amount = CASE WHEN public._wizard_chg(v_taxes,'annual_tax_amount') THEN COALESCE(NULLIF(v_taxes->>'annual_tax_amount','')::numeric, annual_tax_amount) ELSE annual_tax_amount END,
        billing_frequency = CASE WHEN public._wizard_chg(v_taxes,'billing_frequency') THEN COALESCE(NULLIF(v_taxes->>'billing_frequency',''), billing_frequency) ELSE billing_frequency END,
        next_due_date = CASE WHEN public._wizard_chg(v_taxes,'next_due_date') THEN COALESCE(NULLIF(v_taxes->>'next_due_date','')::date, next_due_date) ELSE next_due_date END,
        exemptions = CASE WHEN public._wizard_chg(v_taxes,'exemptions') THEN NULLIF(v_taxes->>'exemptions','') ELSE exemptions END,
        escrow_paid_by_lender = CASE WHEN public._wizard_chg(v_taxes,'escrow_paid_by_lender') THEN public._wizard_bool(v_taxes->>'escrow_paid_by_lender', escrow_paid_by_lender) ELSE escrow_paid_by_lender END,
        records_url = CASE WHEN public._wizard_chg(v_taxes,'records_url') THEN COALESCE(NULLIF(v_taxes->>'records_url',''), records_url) ELSE records_url END,
        notes = CASE WHEN public._wizard_chg(v_taxes,'notes') THEN COALESCE(NULLIF(v_taxes->>'notes',''), notes) ELSE notes END
      WHERE id = v_existing_tax_id AND company_id = v_company_id;
    ELSE
      INSERT INTO property_taxes (
        company_id, property, property_id, county, jurisdiction,
        parcel_id, assessed_value, tax_year, annual_tax_amount,
        billing_frequency, next_due_date, exemptions,
        escrow_paid_by_lender, records_url, notes
      ) VALUES (
        v_company_id, v_address, v_property_id,
        NULLIF(v_taxes->>'county',''), NULLIF(v_taxes->>'jurisdiction',''),
        NULLIF(v_taxes->>'parcel_id',''),
        NULLIF(v_taxes->>'assessed_value','')::numeric,
        NULLIF(v_taxes->>'tax_year','')::int,
        NULLIF(v_taxes->>'annual_tax_amount','')::numeric,
        COALESCE(NULLIF(v_taxes->>'billing_frequency',''),'semi_annual'),
        NULLIF(v_taxes->>'next_due_date','')::date,
        NULLIF(v_taxes->>'exemptions',''),
        COALESCE(NULLIF(v_taxes->>'escrow_paid_by_lender','')::boolean, false),
        NULLIF(v_taxes->>'records_url',''),
        NULLIF(v_taxes->>'notes','')
      );
    END IF;
  ELSIF v_mode = 'edit' AND v_taxes IS NOT NULL AND NULLIF(v_taxes->>'id','') IS NOT NULL THEN
    -- The user switched off THIS tax record; nothing else is archived.
    UPDATE property_taxes SET archived_at = now()
     WHERE id::text = v_taxes->>'id' AND company_id = v_company_id
       AND property = v_address AND archived_at IS NULL;
  END IF;

  -- ─── RECURRING RENT ───────────────────────────────────────────────
  IF v_is_occupied AND v_tenant_id IS NOT NULL
     AND v_recurring IS NOT NULL AND NULLIF(v_recurring->>'amount','')::numeric IS NOT NULL THEN
    v_day := GREATEST(1, LEAST(31, COALESCE(NULLIF(v_recurring->>'day_of_month','')::int, 1)));
    v_user_next := NULLIF(v_recurring->>'start_date','')::date;
    -- Match the guard's uniqueness key (company_id + tenant_id).
    SELECT id, day_of_month, next_post_date, to_jsonb(r) INTO v_existing_recur_id, v_old_day, v_old_next, v_cur
      FROM recurring_journal_entries r
    WHERE company_id = v_company_id AND tenant_id = v_tenant_id
      AND status = 'active' AND archived_at IS NULL
    LIMIT 1;
    v_rec_chg := public._wizard_chg(v_recurring,'amount') OR public._wizard_chg(v_recurring,'frequency')
              OR public._wizard_chg(v_recurring,'day_of_month') OR public._wizard_chg(v_recurring,'start_date')
              OR v_names_chg;

    IF v_existing_recur_id IS NOT NULL AND NOT v_rec_chg THEN
      NULL;   -- nothing about the schedule changed: leave it exactly as it is
    ELSE
      v_tenant_ar_id := _wizard_get_tenant_ar(v_company_id, v_tenant_name, v_tenant_id);
      v_revenue_id := _wizard_resolve_account(v_company_id, '4000');
      v_default_next := NULL;
      IF NULLIF(v_tenant->>'lease_start','') IS NOT NULL THEN
        v_default_next :=
          (date_trunc('month', (v_tenant->>'lease_start')::date) +
           (CASE COALESCE(v_recurring->>'frequency','monthly')
             WHEN 'quarterly'   THEN '3 months'::interval
             WHEN 'semi-annual' THEN '6 months'::interval
             WHEN 'annual'      THEN '12 months'::interval
             ELSE '1 month'::interval
            END) +
           make_interval(days => v_day - 1)
          )::date;
      END IF;
      v_next_post_date := COALESCE(
        CASE
          WHEN v_user_next IS NOT NULL AND v_default_next IS NOT NULL THEN GREATEST(v_user_next, v_default_next)
          ELSE COALESCE(v_user_next, v_default_next)
        END,
        make_date(extract(year from current_date)::int, extract(month from current_date)::int, 1) + interval '1 month'
          + make_interval(days => LEAST(v_day, 28) - 1)
      );
      IF v_existing_recur_id IS NOT NULL AND v_old_next IS NOT NULL
         AND (v_user_next IS NULL OR v_user_next <= v_old_next) THEN
        -- An existing schedule keeps its next posting; a new rent day moves it
        -- within that same month rather than back to the lease start.
        v_next_post_date := CASE WHEN v_old_day IS NOT DISTINCT FROM v_day THEN v_old_next
                                 ELSE public._wizard_merge_due(v_old_next, NULL, v_day) END;
      END IF;
      IF v_existing_recur_id IS NOT NULL THEN
        PERFORM public._wizard_guard(v_recurring, v_recurring->'_db', v_cur, ARRAY[
          'amount','amount', 'frequency','frequency', 'day_of_month','day_of_month'], 'The recurring rent schedule');
        UPDATE recurring_journal_entries SET
          description = CASE WHEN v_names_chg THEN 'Monthly rent — ' || v_all_tenants || ' — ' || split_part(v_address, ',', 1) ELSE description END,
          frequency = CASE WHEN public._wizard_chg(v_recurring,'frequency') THEN COALESCE(NULLIF(v_recurring->>'frequency',''), frequency) ELSE frequency END,
          day_of_month = CASE WHEN public._wizard_chg(v_recurring,'day_of_month') THEN v_day ELSE day_of_month END,
          amount = CASE WHEN public._wizard_chg(v_recurring,'amount') THEN (v_recurring->>'amount')::numeric ELSE amount END,
          tenant_name = CASE WHEN v_names_chg THEN v_all_tenants ELSE tenant_name END,
          tenant_id = v_tenant_id,
          property = v_address,
          debit_account_id = CASE WHEN v_names_chg OR debit_account_id IS NULL THEN v_tenant_ar_id::text ELSE debit_account_id END,
          debit_account_name = CASE WHEN v_names_chg THEN 'AR - ' || v_all_tenants ELSE debit_account_name END,
          credit_account_id = COALESCE(credit_account_id, v_revenue_id::text),
          next_post_date = v_next_post_date
        WHERE id = v_existing_recur_id AND company_id = v_company_id;
      ELSE
        INSERT INTO recurring_journal_entries (
          company_id, description, frequency, day_of_month, amount,
          tenant_name, tenant_id, property,
          debit_account_id, debit_account_name,
          credit_account_id, credit_account_name,
          status, next_post_date, created_by
        ) VALUES (
          v_company_id,
          'Monthly rent — ' || v_all_tenants || ' — ' || split_part(v_address, ',', 1),
          COALESCE(v_recurring->>'frequency','monthly'),
          v_day,
          (v_recurring->>'amount')::numeric,
          v_all_tenants, v_tenant_id, v_address,
          v_tenant_ar_id, 'AR - ' || v_all_tenants,
          v_revenue_id, 'Rental Income',
          'active', v_next_post_date, v_caller_email
        );
      END IF;
    END IF;
  ELSIF v_mode = 'edit' AND v_tenant_id IS NOT NULL
        AND COALESCE(NULLIF(p_payload->>'recurring_cleared','')::boolean, false) THEN
    -- The user cleared recurring rent on an occupied property: stop future
    -- posts. A payload that merely omits recurring changes nothing.
    UPDATE recurring_journal_entries SET status = 'inactive', archived_at = now()
     WHERE company_id = v_company_id AND status = 'active' AND archived_at IS NULL
       AND tenant_id = v_tenant_id AND description LIKE 'Monthly rent%';
  END IF;

  IF v_wizard_id IS NOT NULL THEN
    UPDATE property_setup_wizard SET
      property_address = v_address,
      property_id = v_property_id::text,
      status = 'completed',
      updated_at = now()
    WHERE id = v_wizard_id AND company_id = v_company_id;
  END IF;

  RETURN jsonb_build_object(
    'property_id', v_property_id,
    'tenant_id', v_tenant_id,
    'lease_id', v_lease_id,
    'class_id', v_class_id,
    'address', v_address
  );
 EXCEPTION
  -- A malformed value reads as what it is, not as a raw cast error.
  WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow
       OR numeric_value_out_of_range OR invalid_parameter_value THEN
    RAISE EXCEPTION 'A value in the form could not be read (%). Check the numbers and dates and save again.', SQLERRM;
  WHEN unique_violation THEN
    RAISE EXCEPTION 'That would duplicate a record that already exists (%). A utility with the same provider and account number may already be on this property.', SQLERRM;
  WHEN check_violation THEN
    RAISE EXCEPTION 'A value is outside what is allowed (%).', SQLERRM;
 END;
END;
$fn$;
