-- Archive-on-disable: turning OFF a Loan/Insurance/Tax toggle, or clearing the
-- recurring rent, in the wizard now archives the existing record so the module
-- reflects it (previously the block was skipped and the record lingered). Safe
-- because loadLiveWizardData loads all four live on every edit-open, so a
-- disabled toggle is a real user action, not a stale-form artifact. Only fires
-- in edit mode. (Also carries the earlier true replace-all + recurring tenant_id
-- fix.)
--
-- The old edit path archived a removed row only if its provider name was in a
-- client-sent "utilities_seen" list AND absent from the saved set. That list is
-- populated on only one of three wizard open-paths, and it matches by exact
-- provider string (whitespace-sensitive: "BGE " != "BGE"). So a utility a user
-- removed frequently was never archived -- it stayed live, and reopening the
-- wizard (which reloads the form from the live table) resurrected it. 2502 Kent
-- Village's "BGE Sigma" was stuck in exactly this loop.
--
-- The form now mirrors the live table on every edit-open (loadLiveWizardData /
-- direct table load), so the saved set IS the complete intended state. We can
-- therefore archive EVERY active row for the property and re-insert the saved
-- set -- deterministic, no name-matching, no path-dependence. Credentials are
-- still carried forward: v_util_creds / v_hoa_creds are captured BEFORE the
-- archive, and the inserts below fall back to them when the payload sends none.
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
  v_class_id text;
  v_tenant_id bigint;
  v_tenant_name text;
  v_all_tenants text;
  v_lease_id uuid;
  v_existing_tenant_id bigint;
  v_existing_lease_id uuid;
  v_existing_loan_id uuid;
  v_existing_ins_id uuid;
  v_existing_tax_id uuid;
  v_existing_recur_id uuid;
  v_existing_mort_id uuid;
  v_u jsonb;
  v_h jsonb;
  v_tenant_ar_id uuid;
  v_revenue_id uuid;
  v_mortgage_id uuid;
  v_checking_id uuid;
  v_next_post_date date;
  v_day int;
  v_is_occupied boolean;
  -- Credentials already on file, captured BEFORE the archive-all, so a
  -- payload that carries none can fall back to them instead of writing null.
  v_util_creds jsonb := '{}'::jsonb;
  v_hoa_creds  jsonb := '{}'::jsonb;
  v_loan_has_creds boolean := false;
  v_ins_has_creds  boolean := false;
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
  IF v_caller_role NOT IN ('admin','owner','pm','manager','office_assistant') THEN
    RAISE EXCEPTION 'Role % cannot commit a property wizard', v_caller_role;
  END IF;

  v_prop := p_payload->'property';
  v_tenant := p_payload->'tenant';
  v_utilities := COALESCE(p_payload->'utilities', '[]'::jsonb);
  v_hoas := COALESCE(p_payload->'hoas', '[]'::jsonb);
  v_loan := p_payload->'loan';
  v_insurance := p_payload->'insurance';
  v_taxes := p_payload->'taxes';
  v_recurring := p_payload->'recurring';

  v_is_occupied := (v_prop->>'status') = 'occupied';

  -- compute_property_address is what the sync_addr triggers call, and
  -- those triggers own properties.address. Composing it a second way here
  -- is how the wizard came to file a property's utilities and documents
  -- under an address the Properties page never queries.
  v_address := compute_property_address(
    v_prop->>'address_line_1', v_prop->>'address_line_2',
    v_prop->>'city', v_prop->>'state', v_prop->>'zip');

  IF v_mode = 'edit' AND v_property_id_in IS NOT NULL THEN
    UPDATE properties SET
      address_line_1 = v_prop->>'address_line_1',
      address_line_2 = v_prop->>'address_line_2',
      city = v_prop->>'city',
      state = v_prop->>'state',
      zip = v_prop->>'zip',
      county = v_prop->>'county',
      type = v_prop->>'type',
      status = v_prop->>'status',
      notes = v_prop->>'notes'
    WHERE id = v_property_id_in AND company_id = v_company_id;
    v_property_id := v_property_id_in;
    SELECT address INTO v_address FROM properties
    WHERE id = v_property_id AND company_id = v_company_id;
  ELSE
    IF EXISTS (SELECT 1 FROM properties WHERE company_id = v_company_id AND address = v_address AND archived_at IS NULL) THEN
      RAISE EXCEPTION 'A property with this address already exists';
    END IF;
    INSERT INTO properties (
      address, address_line_1, address_line_2, city, state, zip, county,
      type, status, notes, company_id
    ) VALUES (
      v_address, v_prop->>'address_line_1', v_prop->>'address_line_2',
      v_prop->>'city', v_prop->>'state', v_prop->>'zip', v_prop->>'county',
      v_prop->>'type', v_prop->>'status', v_prop->>'notes', v_company_id
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
    END IF;
    IF v_existing_tenant_id IS NULL THEN
      SELECT id INTO v_existing_tenant_id FROM tenants
      WHERE company_id = v_company_id AND property = v_address
        AND lease_status = 'active' AND archived_at IS NULL
      LIMIT 1;
    END IF;

    IF v_existing_tenant_id IS NOT NULL THEN
      UPDATE tenants SET
        name = v_tenant_name,
        first_name = v_tenant->>'tenant_first',
        middle_initial = v_tenant->>'tenant_mi',
        last_name = v_tenant->>'tenant_last',
        email = lower(v_tenant->>'tenant_email'),
        phone = v_tenant->>'tenant_phone',
        rent = (v_tenant->>'rent')::numeric,
        late_fee_amount = NULLIF(v_tenant->>'late_fee_amount','')::numeric,
        late_fee_type = COALESCE(v_tenant->>'late_fee_type','flat'),
        lease_status = 'active',
        lease_start = NULLIF(v_tenant->>'lease_start','')::date,
        lease_end_date = NULLIF(v_tenant->>'lease_end','')::date,
        move_in = NULLIF(v_tenant->>'lease_start','')::date,
        is_voucher = COALESCE((v_tenant->>'is_voucher')::boolean, false),
        voucher_number = NULLIF(v_tenant->>'voucher_number',''),
        reexam_date = NULLIF(v_tenant->>'reexam_date','')::date,
        case_manager_name = NULLIF(v_tenant->>'case_manager_name',''),
        case_manager_email = NULLIF(v_tenant->>'case_manager_email',''),
        case_manager_phone = NULLIF(v_tenant->>'case_manager_phone',''),
        voucher_portion = NULLIF(v_tenant->>'voucher_portion','')::numeric,
        tenant_portion = NULLIF(v_tenant->>'tenant_portion','')::numeric,
        co_tenants = ARRAY(SELECT x FROM unnest(ARRAY[
          NULLIF(btrim(v_tenant->>'tenant_2'),''), NULLIF(btrim(v_tenant->>'tenant_3'),''),
          NULLIF(btrim(v_tenant->>'tenant_4'),''), NULLIF(btrim(v_tenant->>'tenant_5'),'')
        ]) AS x WHERE x IS NOT NULL)
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
        (v_tenant->>'rent')::numeric,
        NULLIF(v_tenant->>'late_fee_amount','')::numeric,
        COALESCE(v_tenant->>'late_fee_type','flat'),
        'active',
        NULLIF(v_tenant->>'lease_start','')::date,
        NULLIF(v_tenant->>'lease_end','')::date,
        NULLIF(v_tenant->>'lease_start','')::date,
        0,
        COALESCE((v_tenant->>'is_voucher')::boolean, false),
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

    UPDATE properties SET
      status = 'occupied',
      tenant = v_tenant_name,
      tenant_2 = COALESCE(v_tenant->>'tenant_2',''),
      tenant_2_email = COALESCE(v_tenant->>'tenant_2_email',''),
      tenant_2_phone = COALESCE(v_tenant->>'tenant_2_phone',''),
      tenant_3 = COALESCE(v_tenant->>'tenant_3',''),
      tenant_3_email = COALESCE(v_tenant->>'tenant_3_email',''),
      tenant_3_phone = COALESCE(v_tenant->>'tenant_3_phone',''),
      tenant_4 = COALESCE(v_tenant->>'tenant_4',''),
      tenant_4_email = COALESCE(v_tenant->>'tenant_4_email',''),
      tenant_4_phone = COALESCE(v_tenant->>'tenant_4_phone',''),
      tenant_5 = COALESCE(v_tenant->>'tenant_5',''),
      tenant_5_email = COALESCE(v_tenant->>'tenant_5_email',''),
      tenant_5_phone = COALESCE(v_tenant->>'tenant_5_phone',''),
      rent = (v_tenant->>'rent')::numeric,
      security_deposit = COALESCE(NULLIF(v_tenant->>'security_deposit','')::numeric, 0),
      lease_start = NULLIF(v_tenant->>'lease_start','')::date,
      lease_end = NULLIF(v_tenant->>'lease_end','')::date
    WHERE id = v_property_id AND company_id = v_company_id;

    IF (v_tenant->>'lease_start') IS NOT NULL AND (v_tenant->>'lease_start') <> ''
       AND (v_tenant->>'lease_end') IS NOT NULL AND (v_tenant->>'lease_end') <> '' THEN
      v_all_tenants := concat_ws(' / ',
        NULLIF(v_tenant->>'tenant',''),
        NULLIF(v_tenant->>'tenant_2',''),
        NULLIF(v_tenant->>'tenant_3',''),
        NULLIF(v_tenant->>'tenant_4','')
      );
      SELECT id INTO v_existing_lease_id FROM leases
      WHERE company_id = v_company_id AND property = v_address AND status = 'active'
      LIMIT 1;
      IF v_existing_lease_id IS NOT NULL THEN
        UPDATE leases SET
          tenant_name = v_all_tenants,
          tenant_id = v_tenant_id,
          start_date = (v_tenant->>'lease_start')::date,
          end_date = (v_tenant->>'lease_end')::date,
          rent_amount = (v_tenant->>'rent')::numeric,
          security_deposit = COALESCE(NULLIF(v_tenant->>'security_deposit','')::numeric, 0),
          payment_due_day = 1
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
          (v_tenant->>'rent')::numeric,
          COALESCE(NULLIF(v_tenant->>'security_deposit','')::numeric, 0),
          'active', 1
        ) RETURNING id INTO v_lease_id;
      END IF;
    END IF;
  END IF;

  -- ─── UTILITIES — true replace-all in edit mode ───────────────────
  -- utilities has archived_at but not archived_by (unlike its siblings).
  IF v_mode = 'edit' THEN
    SELECT COALESCE(jsonb_object_agg(provider, c), '{}'::jsonb) INTO v_util_creds
    FROM (
      SELECT DISTINCT ON (provider) provider,
        jsonb_build_object('u', username_encrypted, 'p', password_encrypted,
          'iv', encryption_iv, 'ivu', encryption_iv_username,
          'salt', encryption_salt) AS c
      FROM utilities
      WHERE company_id = v_company_id AND property = v_address
        AND archived_at IS NULL AND NULLIF(username_encrypted, '') IS NOT NULL
      ORDER BY provider
    ) s;
    -- The form mirrors the live table on edit-open, so the saved set is the
    -- complete intended state: archive every active row, re-insert below.
    UPDATE utilities SET archived_at = now()
    WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL;
  END IF;
  FOR v_u IN SELECT * FROM jsonb_array_elements(v_utilities) LOOP
    IF COALESCE(trim(v_u->>'provider'),'') = '' THEN CONTINUE; END IF;
    v_day := LEAST(28, GREATEST(1, COALESCE(NULLIF(v_u->>'due_day','')::int, 1)));
    INSERT INTO utilities (
      company_id, property, provider, type, account_number, amount, due,
      responsibility, status, website,
      username_encrypted, password_encrypted,
      encryption_iv, encryption_iv_username, encryption_salt
    ) VALUES (
      v_company_id, v_address, v_u->>'provider', COALESCE(NULLIF(v_u->>'type',''),'Electric'), NULLIF(v_u->>'account_number',''), 0,
      make_date(
        extract(year from current_date)::int,
        extract(month from current_date)::int,
        v_day
      ),
      CASE v_u->>'responsibility' WHEN 'owner_pays' THEN 'owner' WHEN 'condo_fee' THEN 'condo_fee' ELSE 'tenant' END,
      'pending',
      COALESCE(v_u->>'website',''),
      CASE WHEN NULLIF(v_u->>'username_encrypted','') IS NOT NULL
        THEN v_u->>'username_encrypted' ELSE v_util_creds->(v_u->>'provider')->>'u' END,
      CASE WHEN NULLIF(v_u->>'username_encrypted','') IS NOT NULL
        THEN v_u->>'password_encrypted' ELSE v_util_creds->(v_u->>'provider')->>'p' END,
      CASE WHEN NULLIF(v_u->>'username_encrypted','') IS NOT NULL
        THEN v_u->>'encryption_iv' ELSE v_util_creds->(v_u->>'provider')->>'iv' END,
      CASE WHEN NULLIF(v_u->>'username_encrypted','') IS NOT NULL
        THEN v_u->>'encryption_iv_username' ELSE v_util_creds->(v_u->>'provider')->>'ivu' END,
      CASE WHEN NULLIF(v_u->>'username_encrypted','') IS NOT NULL
        THEN v_u->>'encryption_salt' ELSE v_util_creds->(v_u->>'provider')->>'salt' END
    );
  END LOOP;

  -- ─── HOAs — true replace-all in edit mode ────────────────────────
  IF v_mode = 'edit' THEN
    SELECT COALESCE(jsonb_object_agg(hoa_name, c), '{}'::jsonb) INTO v_hoa_creds
    FROM (
      SELECT DISTINCT ON (hoa_name) hoa_name,
        jsonb_build_object('u', username_encrypted, 'p', password_encrypted,
          'iv', encryption_iv, 'ivu', encryption_iv_username,
          'salt', encryption_salt,
          'mu', mgmt_username_encrypted, 'mp', mgmt_password_encrypted,
          'miv', mgmt_encryption_iv, 'mivu', mgmt_encryption_iv_username,
          'pu', pay_username_encrypted, 'pp', pay_password_encrypted,
          'piv', pay_encryption_iv, 'pivu', pay_encryption_iv_username) AS c
      FROM hoa_payments
      WHERE company_id = v_company_id AND property = v_address
        AND archived_at IS NULL AND hoa_name IS NOT NULL
        AND (NULLIF(username_encrypted, '') IS NOT NULL
          OR NULLIF(mgmt_username_encrypted, '') IS NOT NULL
          OR NULLIF(pay_username_encrypted, '') IS NOT NULL)
      ORDER BY hoa_name
    ) s;
    UPDATE hoa_payments SET archived_at = now(), archived_by = v_caller_email
    WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL;
  END IF;
  FOR v_h IN SELECT * FROM jsonb_array_elements(v_hoas) LOOP
    IF COALESCE(trim(v_h->>'hoa_name'),'') = '' THEN CONTINUE; END IF;
    v_day := LEAST(28, GREATEST(1, COALESCE(NULLIF(v_h->>'due_day','')::int, 1)));
    INSERT INTO hoa_payments (
      company_id, property, hoa_name, amount, due_date,
      frequency, status, notes, website,
      username_encrypted, password_encrypted,
      encryption_iv, encryption_iv_username, encryption_salt,
      management_company, mgmt_website,
      mgmt_username_encrypted, mgmt_password_encrypted,
      mgmt_encryption_iv, mgmt_encryption_iv_username,
      pay_portal_website,
      pay_username_encrypted, pay_password_encrypted,
      pay_encryption_iv, pay_encryption_iv_username,
      contact_name, contact_email, contact_phone
    ) VALUES (
      v_company_id, v_address, v_h->>'hoa_name',
      (v_h->>'amount')::numeric,
      make_date(
        extract(year from current_date)::int,
        extract(month from current_date)::int,
        v_day
      ),
      COALESCE(v_h->>'frequency','Monthly'),
      'pending',
      COALESCE(v_h->>'notes',''),
      COALESCE(v_h->>'website',''),
      CASE WHEN NULLIF(v_h->>'username_encrypted','') IS NOT NULL
        THEN v_h->>'username_encrypted' ELSE v_hoa_creds->(v_h->>'hoa_name')->>'u' END,
      CASE WHEN NULLIF(v_h->>'username_encrypted','') IS NOT NULL
        THEN v_h->>'password_encrypted' ELSE v_hoa_creds->(v_h->>'hoa_name')->>'p' END,
      CASE WHEN NULLIF(v_h->>'username_encrypted','') IS NOT NULL
        THEN v_h->>'encryption_iv' ELSE v_hoa_creds->(v_h->>'hoa_name')->>'iv' END,
      CASE WHEN NULLIF(v_h->>'username_encrypted','') IS NOT NULL
        THEN v_h->>'encryption_iv_username' ELSE v_hoa_creds->(v_h->>'hoa_name')->>'ivu' END,
      CASE WHEN NULLIF(v_h->>'username_encrypted','') IS NOT NULL
        THEN v_h->>'encryption_salt' ELSE v_hoa_creds->(v_h->>'hoa_name')->>'salt' END,
      NULLIF(v_h->>'management_company',''), COALESCE(v_h->>'mgmt_website',''),
      CASE WHEN NULLIF(v_h->>'mgmt_username_encrypted','') IS NOT NULL
        THEN v_h->>'mgmt_username_encrypted' ELSE v_hoa_creds->(v_h->>'hoa_name')->>'mu' END,
      CASE WHEN NULLIF(v_h->>'mgmt_username_encrypted','') IS NOT NULL
        THEN v_h->>'mgmt_password_encrypted' ELSE v_hoa_creds->(v_h->>'hoa_name')->>'mp' END,
      CASE WHEN NULLIF(v_h->>'mgmt_username_encrypted','') IS NOT NULL
        THEN v_h->>'mgmt_encryption_iv' ELSE v_hoa_creds->(v_h->>'hoa_name')->>'miv' END,
      CASE WHEN NULLIF(v_h->>'mgmt_username_encrypted','') IS NOT NULL
        THEN v_h->>'mgmt_encryption_iv_username' ELSE v_hoa_creds->(v_h->>'hoa_name')->>'mivu' END,
      COALESCE(v_h->>'pay_portal_website',''),
      CASE WHEN NULLIF(v_h->>'pay_username_encrypted','') IS NOT NULL
        THEN v_h->>'pay_username_encrypted' ELSE v_hoa_creds->(v_h->>'hoa_name')->>'pu' END,
      CASE WHEN NULLIF(v_h->>'pay_username_encrypted','') IS NOT NULL
        THEN v_h->>'pay_password_encrypted' ELSE v_hoa_creds->(v_h->>'hoa_name')->>'pp' END,
      CASE WHEN NULLIF(v_h->>'pay_username_encrypted','') IS NOT NULL
        THEN v_h->>'pay_encryption_iv' ELSE v_hoa_creds->(v_h->>'hoa_name')->>'piv' END,
      CASE WHEN NULLIF(v_h->>'pay_username_encrypted','') IS NOT NULL
        THEN v_h->>'pay_encryption_iv_username' ELSE v_hoa_creds->(v_h->>'hoa_name')->>'pivu' END,
      NULLIF(v_h->>'contact_name',''), NULLIF(v_h->>'contact_email',''), NULLIF(v_h->>'contact_phone','')
    );
  END LOOP;

  IF v_loan IS NOT NULL AND COALESCE((v_loan->>'enabled')::boolean, false) THEN
    v_loan_has_creds := NULLIF(v_loan->>'username_encrypted','') IS NOT NULL
                    AND NULLIF(v_loan->>'password_encrypted','') IS NOT NULL;
    SELECT id INTO v_existing_loan_id FROM property_loans
    WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL
    LIMIT 1;
    IF v_existing_loan_id IS NOT NULL THEN
      UPDATE property_loans SET
        lender_name = v_loan->>'lender_name',
        loan_type = COALESCE(v_loan->>'loan_type','Conventional'),
        original_amount = NULLIF(v_loan->>'original_amount','')::numeric,
        current_balance = NULLIF(v_loan->>'current_balance','')::numeric,
        interest_rate = NULLIF(v_loan->>'interest_rate','')::numeric,
        monthly_payment = NULLIF(v_loan->>'monthly_payment','')::numeric,
        escrow_included = COALESCE((v_loan->>'escrow_included')::boolean, false),
        escrow_amount = NULLIF(v_loan->>'escrow_amount','')::numeric,
        loan_start_date = NULLIF(v_loan->>'loan_start_date','')::date,
        maturity_date = NULLIF(v_loan->>'maturity_date','')::date,
        account_number = v_loan->>'account_number',
        username_encrypted = CASE WHEN v_loan_has_creds THEN v_loan->>'username_encrypted' ELSE username_encrypted END,
        password_encrypted = CASE WHEN v_loan_has_creds THEN v_loan->>'password_encrypted' ELSE password_encrypted END,
        encryption_iv_username = CASE WHEN v_loan_has_creds THEN v_loan->>'encryption_iv_username' ELSE encryption_iv_username END,
        encryption_iv = CASE WHEN v_loan_has_creds THEN v_loan->>'encryption_iv' ELSE encryption_iv END,
        encryption_salt = CASE WHEN v_loan_has_creds THEN v_loan->>'encryption_salt' ELSE encryption_salt END,
        website = COALESCE(v_loan->>'website',''),
        notes = COALESCE(v_loan->>'notes','')
      WHERE id = v_existing_loan_id AND company_id = v_company_id;
    ELSE
      INSERT INTO property_loans (
        company_id, property, property_id, lender_name, loan_type,
        original_amount, current_balance, interest_rate, monthly_payment,
        escrow_included, escrow_amount, loan_start_date, maturity_date,
        account_number,
        username_encrypted, password_encrypted,
        encryption_iv_username, encryption_iv, encryption_salt,
        website, notes
      ) VALUES (
        v_company_id, v_address, v_property_id::text,
        v_loan->>'lender_name',
        COALESCE(v_loan->>'loan_type','Conventional'),
        NULLIF(v_loan->>'original_amount','')::numeric,
        NULLIF(v_loan->>'current_balance','')::numeric,
        NULLIF(v_loan->>'interest_rate','')::numeric,
        NULLIF(v_loan->>'monthly_payment','')::numeric,
        COALESCE((v_loan->>'escrow_included')::boolean, false),
        NULLIF(v_loan->>'escrow_amount','')::numeric,
        NULLIF(v_loan->>'loan_start_date','')::date,
        NULLIF(v_loan->>'maturity_date','')::date,
        v_loan->>'account_number',
        v_loan->>'username_encrypted', v_loan->>'password_encrypted',
        v_loan->>'encryption_iv_username', v_loan->>'encryption_iv',
        v_loan->>'encryption_salt',
        COALESCE(v_loan->>'website',''),
        COALESCE(v_loan->>'notes','')
      );
    END IF;

    IF NULLIF(v_loan->>'monthly_payment','')::numeric IS NOT NULL
       AND COALESCE((v_loan->>'setup_recurring')::boolean, false) THEN
      v_mortgage_id := _wizard_resolve_account(v_company_id, '5600');
      v_checking_id := _wizard_resolve_account(v_company_id, '1000');
      v_day := LEAST(28, GREATEST(1, COALESCE(NULLIF(v_loan->>'payment_day','')::int, 1)));
      v_next_post_date := make_date(
        extract(year from current_date)::int,
        extract(month from current_date)::int + 1,
        v_day
      );
      SELECT id INTO v_existing_mort_id FROM recurring_journal_entries
      WHERE company_id = v_company_id AND property = v_address
        AND status = 'active' AND archived_at IS NULL
        AND description LIKE 'Mortgage/Loan%'
      LIMIT 1;
      IF v_existing_mort_id IS NOT NULL THEN
        UPDATE recurring_journal_entries SET
          amount = (v_loan->>'monthly_payment')::numeric,
          day_of_month = v_day,
          debit_account_id = v_mortgage_id,
          credit_account_id = v_checking_id,
          next_post_date = v_next_post_date
        WHERE id = v_existing_mort_id AND company_id = v_company_id;
      ELSE
        INSERT INTO recurring_journal_entries (
          company_id, description, frequency, day_of_month, amount,
          property,
          debit_account_id, debit_account_name,
          credit_account_id, credit_account_name,
          status, next_post_date, created_by
        ) VALUES (
          v_company_id,
          'Mortgage/Loan Payment — ' || split_part(v_address, ',', 1),
          'monthly', v_day, (v_loan->>'monthly_payment')::numeric,
          v_address,
          v_mortgage_id, 'Mortgage/Loan Payment', v_checking_id, 'Checking Account',
          'active', v_next_post_date, v_caller_email
        );
      END IF;
    END IF;
  ELSIF v_mode = 'edit' THEN
    UPDATE property_loans SET archived_at = now()
     WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL;
    UPDATE recurring_journal_entries SET status = 'inactive', archived_at = now()
     WHERE company_id = v_company_id AND property = v_address AND status = 'active'
       AND archived_at IS NULL AND description LIKE 'Mortgage/Loan%';
  END IF;

  IF v_insurance IS NOT NULL AND COALESCE((v_insurance->>'enabled')::boolean, false) THEN
    v_ins_has_creds := NULLIF(v_insurance->>'username_encrypted','') IS NOT NULL
                   AND NULLIF(v_insurance->>'password_encrypted','') IS NOT NULL;
    SELECT id INTO v_existing_ins_id FROM property_insurance
    WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL
    LIMIT 1;
    IF v_existing_ins_id IS NOT NULL THEN
      UPDATE property_insurance SET
        provider = v_insurance->>'provider',
        policy_number = v_insurance->>'policy_number',
        premium_amount = NULLIF(v_insurance->>'premium_amount','')::numeric,
        premium_frequency = COALESCE(v_insurance->>'premium_frequency','annual'),
        coverage_amount = NULLIF(v_insurance->>'coverage_amount','')::numeric,
        expiration_date = NULLIF(v_insurance->>'expiration_date','')::date,
        notes = COALESCE(v_insurance->>'notes',''),
        website = COALESCE(v_insurance->>'website',''),
        username_encrypted = CASE WHEN v_ins_has_creds THEN v_insurance->>'username_encrypted' ELSE username_encrypted END,
        password_encrypted = CASE WHEN v_ins_has_creds THEN v_insurance->>'password_encrypted' ELSE password_encrypted END,
        encryption_iv_username = CASE WHEN v_ins_has_creds THEN v_insurance->>'encryption_iv_username' ELSE encryption_iv_username END,
        encryption_iv = CASE WHEN v_ins_has_creds THEN v_insurance->>'encryption_iv' ELSE encryption_iv END,
        encryption_salt = CASE WHEN v_ins_has_creds THEN v_insurance->>'encryption_salt' ELSE encryption_salt END
      WHERE id = v_existing_ins_id AND company_id = v_company_id;
    ELSE
      INSERT INTO property_insurance (
        company_id, property, property_id,
        provider, policy_number, premium_amount, premium_frequency,
        coverage_amount, expiration_date, notes, website,
        username_encrypted, password_encrypted,
        encryption_iv_username, encryption_iv, encryption_salt
      ) VALUES (
        v_company_id, v_address, v_property_id::text,
        v_insurance->>'provider', v_insurance->>'policy_number',
        NULLIF(v_insurance->>'premium_amount','')::numeric,
        COALESCE(v_insurance->>'premium_frequency','annual'),
        NULLIF(v_insurance->>'coverage_amount','')::numeric,
        NULLIF(v_insurance->>'expiration_date','')::date,
        COALESCE(v_insurance->>'notes',''),
        COALESCE(v_insurance->>'website',''),
        v_insurance->>'username_encrypted', v_insurance->>'password_encrypted',
        v_insurance->>'encryption_iv_username', v_insurance->>'encryption_iv',
        v_insurance->>'encryption_salt'
      );
    END IF;
  ELSIF v_mode = 'edit' THEN
    UPDATE property_insurance SET archived_at = now()
     WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL;
  END IF;

  IF v_taxes IS NOT NULL AND COALESCE((v_taxes->>'enabled')::boolean, false) THEN
    SELECT id INTO v_existing_tax_id FROM property_taxes
    WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL
    LIMIT 1;
    IF v_existing_tax_id IS NOT NULL THEN
      UPDATE property_taxes SET
        parcel_id = NULLIF(v_taxes->>'parcel_id',''),
        assessed_value = NULLIF(v_taxes->>'assessed_value','')::numeric,
        tax_year = NULLIF(v_taxes->>'tax_year','')::int,
        annual_tax_amount = NULLIF(v_taxes->>'annual_tax_amount','')::numeric,
        billing_frequency = COALESCE(v_taxes->>'billing_frequency','semi_annual'),
        next_due_date = NULLIF(v_taxes->>'next_due_date','')::date,
        exemptions = NULLIF(v_taxes->>'exemptions',''),
        escrow_paid_by_lender = COALESCE((v_taxes->>'escrow_paid_by_lender')::boolean, false),
        records_url = NULLIF(v_taxes->>'records_url',''),
        notes = NULLIF(v_taxes->>'notes','')
      WHERE id = v_existing_tax_id AND company_id = v_company_id;
    ELSE
      INSERT INTO property_taxes (
        company_id, property, property_id,
        parcel_id, assessed_value, tax_year, annual_tax_amount,
        billing_frequency, next_due_date, exemptions,
        escrow_paid_by_lender, records_url, notes
      ) VALUES (
        v_company_id, v_address, v_property_id,
        NULLIF(v_taxes->>'parcel_id',''),
        NULLIF(v_taxes->>'assessed_value','')::numeric,
        NULLIF(v_taxes->>'tax_year','')::int,
        NULLIF(v_taxes->>'annual_tax_amount','')::numeric,
        COALESCE(v_taxes->>'billing_frequency','semi_annual'),
        NULLIF(v_taxes->>'next_due_date','')::date,
        NULLIF(v_taxes->>'exemptions',''),
        COALESCE((v_taxes->>'escrow_paid_by_lender')::boolean, false),
        NULLIF(v_taxes->>'records_url',''),
        NULLIF(v_taxes->>'notes','')
      );
    END IF;
  ELSIF v_mode = 'edit' THEN
    UPDATE property_taxes SET archived_at = now()
     WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL;
  END IF;

  IF v_is_occupied AND v_tenant_id IS NOT NULL
     AND v_recurring IS NOT NULL AND NULLIF(v_recurring->>'amount','')::numeric IS NOT NULL THEN
    v_tenant_ar_id := _wizard_get_tenant_ar(v_company_id, v_tenant_name, v_tenant_id);
    v_revenue_id := _wizard_resolve_account(v_company_id, '4000');
    v_day := GREATEST(1, LEAST(31, COALESCE(NULLIF(v_recurring->>'day_of_month','')::int, 1)));
    DECLARE
      v_default_next date := NULL;
      v_user_next    date := NULLIF(v_recurring->>'start_date','')::date;
    BEGIN
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
          WHEN v_user_next IS NOT NULL AND v_default_next IS NOT NULL
            THEN GREATEST(v_user_next, v_default_next)
          ELSE COALESCE(v_user_next, v_default_next)
        END,
        make_date(
          extract(year from current_date)::int,
          extract(month from current_date)::int + 1,
          v_day
        )
      );
    END;
    -- Match the guard's uniqueness key (company_id + tenant_id), NOT tenant_name +
    -- description. The old name-based lookup missed an existing schedule whose
    -- stored tenant_name differed from the recomputed v_all_tenants, so the RPC
    -- INSERTed a second active schedule and guard_one_active_recurring_per_tenant
    -- rejected the whole atomic commit (4620 Deepwood / tenant 1346).
    SELECT id INTO v_existing_recur_id FROM recurring_journal_entries
    WHERE company_id = v_company_id
      AND tenant_id = v_tenant_id
      AND status = 'active' AND archived_at IS NULL
    LIMIT 1;
    IF v_existing_recur_id IS NOT NULL THEN
      UPDATE recurring_journal_entries SET
        description = 'Monthly rent — ' || v_all_tenants || ' — ' || split_part(v_address, ',', 1),
        frequency = COALESCE(v_recurring->>'frequency','monthly'),
        day_of_month = v_day,
        amount = (v_recurring->>'amount')::numeric,
        tenant_name = v_all_tenants,
        tenant_id = v_tenant_id,
        property = v_address,
        debit_account_id = v_tenant_ar_id,
        debit_account_name = 'AR - ' || v_all_tenants,
        credit_account_id = v_revenue_id,
        credit_account_name = 'Rental Income',
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
  ELSIF v_mode = 'edit' AND v_tenant_id IS NOT NULL THEN
    -- Recurring rent cleared on an occupied property: stop future posts.
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
END;
$fn$;
