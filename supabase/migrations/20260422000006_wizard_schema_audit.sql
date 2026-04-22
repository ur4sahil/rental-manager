-- commit_property_wizard: full schema-vs-RPC audit fix.
--
-- Why another migration: yesterday's client-side wizard wrote to each
-- table in separate per-step calls — schema/variable mismatches were
-- absorbed per-table or never exercised. Today's atomic RPC commits
-- everything in one PL/pgSQL body, so every dormant mismatch surfaces
-- at once. I've been patching them one-by-one; this migration does a
-- full column-by-column audit against the live schema and fixes the
-- remaining collisions in one go.
--
-- Live schema (verified via probe):
--   acct_accounts.tenant_id   UUID (all 556 rows currently NULL)
--   acct_classes.id           TEXT (not UUID — older rows are "PROP-1" style)
--   tenants.id                bigint
--   leases.tenant_id          bigint
--   properties.class_id       TEXT
--
-- Fixes in this migration:
--
-- 1) _wizard_get_tenant_ar: stop writing bigint tenants.id into
--    acct_accounts.tenant_id (uuid). The column is unused in this DB
--    (556/556 NULL), so dropping it from the INSERT is safe. That was
--    the "column tenant_id is of type uuid but expression is of type
--    bigint" crash.
--
-- 2) commit_property_wizard: declare v_class_id as text (not uuid).
--    acct_classes.id is TEXT. RETURNING id INTO a uuid variable would
--    blow up for any company whose acct_classes row was created in
--    the old "PROP-1" flavor (ON CONFLICT path returns the existing
--    id). Latent bug; fixing now so it can't surface later.

CREATE OR REPLACE FUNCTION _wizard_get_tenant_ar(p_company_id text, p_tenant_name text, p_tenant_id bigint)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
  v_parent uuid;
  v_next_seq int;
  v_code text;
BEGIN
  IF p_tenant_name IS NULL OR p_tenant_name = '' THEN
    RETURN _wizard_resolve_account(p_company_id, '1100');
  END IF;
  SELECT id INTO v_id FROM acct_accounts
  WHERE company_id = p_company_id AND type = 'Asset' AND name = 'AR - ' || p_tenant_name
  LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  v_parent := _wizard_resolve_account(p_company_id, '1100');
  SELECT COALESCE(MAX(CAST(split_part(code, '-', 2) AS int)), 0) + 1 INTO v_next_seq
  FROM acct_accounts
  WHERE company_id = p_company_id AND code LIKE '1100-%';
  v_code := '1100-' || lpad(v_next_seq::text, 3, '0');
  -- acct_accounts.tenant_id is uuid; tenants.id is bigint. Don't write
  -- it — the AR account is identified by name "AR - <tenant_name>"
  -- everywhere else, and the column is NULL across every live row.
  INSERT INTO acct_accounts (company_id, code, name, type, is_active, old_text_id, parent_id)
  VALUES (p_company_id, v_code, 'AR - ' || p_tenant_name, 'Asset', true,
          p_company_id || '-' || v_code, v_parent)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;


CREATE OR REPLACE FUNCTION commit_property_wizard(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
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
  v_class_id text;                 -- acct_classes.id is TEXT
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

  -- ─── Authorization ───────────────────────────────────────────────
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

  v_address := TRIM(BOTH ', ' FROM COALESCE(v_prop->>'address_line_1','') ||
    CASE WHEN COALESCE(v_prop->>'address_line_2','') <> '' THEN ', ' || (v_prop->>'address_line_2') ELSE '' END ||
    ', ' || COALESCE(v_prop->>'city','') ||
    ', ' || COALESCE(v_prop->>'state','') ||
    ' ' || COALESCE(v_prop->>'zip',''));

  -- ─── 1. PROPERTY ────────────────────────────────────────────────
  IF v_mode = 'edit' AND v_property_id_in IS NOT NULL THEN
    UPDATE properties SET
      address = v_address,
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
  END IF;

  -- ─── 2. ACCOUNTING CLASS (upsert one per address) ───────────────
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

  -- ─── 3. TENANT + LEASE (when occupied and name given) ───────────
  IF v_is_occupied AND v_tenant IS NOT NULL AND (v_tenant->>'tenant') IS NOT NULL AND (v_tenant->>'tenant') <> '' THEN
    v_tenant_name := v_tenant->>'tenant';

    SELECT id INTO v_existing_tenant_id FROM tenants
    WHERE company_id = v_company_id
      AND property = v_address
      AND lower(COALESCE(email,'')) = lower(COALESCE(v_tenant->>'tenant_email',''))
      AND archived_at IS NULL
    LIMIT 1;
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
        tenant_portion = NULLIF(v_tenant->>'tenant_portion','')::numeric
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
        voucher_portion, tenant_portion
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
        NULLIF(v_tenant->>'tenant_portion','')::numeric
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

  -- ─── 4. UTILITIES — replace-all ──────────────────────────────────
  IF v_mode = 'edit' THEN
    UPDATE utilities SET archived_at = now(), archived_by = v_caller_email
    WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL;
  END IF;
  FOR v_u IN SELECT * FROM jsonb_array_elements(v_utilities) LOOP
    IF COALESCE(trim(v_u->>'provider'),'') = '' THEN CONTINUE; END IF;
    v_day := LEAST(28, GREATEST(1, COALESCE(NULLIF(v_u->>'due_day','')::int, 1)));
    INSERT INTO utilities (
      company_id, property, provider, amount, due,
      responsibility, status, website,
      username_encrypted, password_encrypted,
      encryption_iv, encryption_iv_username, encryption_salt
    ) VALUES (
      v_company_id, v_address, v_u->>'provider', 0,
      make_date(
        extract(year from current_date)::int,
        extract(month from current_date)::int,
        v_day
      ),
      CASE WHEN v_u->>'responsibility' = 'owner_pays' THEN 'owner' ELSE 'tenant' END,
      'pending',
      COALESCE(v_u->>'website',''),
      v_u->>'username_encrypted', v_u->>'password_encrypted',
      v_u->>'encryption_iv', v_u->>'encryption_iv_username', v_u->>'encryption_salt'
    );
  END LOOP;

  -- ─── 5. HOA — replace-all ────────────────────────────────────────
  IF v_mode = 'edit' THEN
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
      encryption_iv, encryption_iv_username, encryption_salt
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
      v_h->>'username_encrypted', v_h->>'password_encrypted',
      v_h->>'encryption_iv', v_h->>'encryption_iv_username', v_h->>'encryption_salt'
    );
  END LOOP;

  -- ─── 6. LOAN — upsert by (company_id, property) ─────────────────
  IF v_loan IS NOT NULL AND COALESCE((v_loan->>'enabled')::boolean, false) THEN
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
        account_number_encrypted = v_loan->>'account_number_encrypted',
        account_number_iv = v_loan->>'account_number_iv',
        account_number_salt = v_loan->>'account_number_salt',
        username_encrypted = v_loan->>'username_encrypted',
        password_encrypted = v_loan->>'password_encrypted',
        encryption_iv_username = v_loan->>'encryption_iv_username',
        encryption_iv = v_loan->>'encryption_iv',
        encryption_salt = v_loan->>'encryption_salt',
        website = COALESCE(v_loan->>'website',''),
        notes = COALESCE(v_loan->>'notes','')
      WHERE id = v_existing_loan_id AND company_id = v_company_id;
    ELSE
      INSERT INTO property_loans (
        company_id, property, property_id, lender_name, loan_type,
        original_amount, current_balance, interest_rate, monthly_payment,
        escrow_included, escrow_amount, loan_start_date, maturity_date,
        account_number_encrypted, account_number_iv, account_number_salt,
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
        v_loan->>'account_number_encrypted',
        v_loan->>'account_number_iv',
        v_loan->>'account_number_salt',
        v_loan->>'username_encrypted', v_loan->>'password_encrypted',
        v_loan->>'encryption_iv_username', v_loan->>'encryption_iv',
        v_loan->>'encryption_salt',
        COALESCE(v_loan->>'website',''),
        COALESCE(v_loan->>'notes','')
      );
    END IF;

    -- Mortgage recurring (only when monthly_payment present)
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
  END IF;

  -- ─── 7. INSURANCE — upsert by (company_id, property) ────────────
  IF v_insurance IS NOT NULL AND COALESCE((v_insurance->>'enabled')::boolean, false) THEN
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
        username_encrypted = v_insurance->>'username_encrypted',
        password_encrypted = v_insurance->>'password_encrypted',
        encryption_iv_username = v_insurance->>'encryption_iv_username',
        encryption_iv = v_insurance->>'encryption_iv',
        encryption_salt = v_insurance->>'encryption_salt'
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
  END IF;

  -- ─── 8. TAXES — upsert by (company_id, property) ────────────────
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
  END IF;

  -- ─── 9. RECURRING RENT (only when occupied) ─────────────────────
  IF v_is_occupied AND v_tenant_id IS NOT NULL
     AND v_recurring IS NOT NULL AND NULLIF(v_recurring->>'amount','')::numeric IS NOT NULL THEN
    v_tenant_ar_id := _wizard_get_tenant_ar(v_company_id, v_tenant_name, v_tenant_id);
    v_revenue_id := _wizard_resolve_account(v_company_id, '4000');
    v_day := LEAST(28, GREATEST(1, COALESCE(NULLIF(v_recurring->>'day_of_month','')::int, 1)));
    v_next_post_date := COALESCE(
      NULLIF(v_recurring->>'start_date','')::date,
      make_date(
        extract(year from current_date)::int,
        extract(month from current_date)::int + 1,
        v_day
      )
    );
    SELECT id INTO v_existing_recur_id FROM recurring_journal_entries
    WHERE company_id = v_company_id AND property = v_address
      AND status = 'active' AND archived_at IS NULL
      AND description LIKE 'Monthly rent%'
    LIMIT 1;
    IF v_existing_recur_id IS NOT NULL THEN
      UPDATE recurring_journal_entries SET
        description = 'Monthly rent — ' || v_all_tenants || ' — ' || split_part(v_address, ',', 1),
        frequency = COALESCE(v_recurring->>'frequency','monthly'),
        day_of_month = v_day,
        amount = (v_recurring->>'amount')::numeric,
        tenant_name = v_all_tenants,
        debit_account_id = v_tenant_ar_id,
        debit_account_name = 'AR - ' || v_all_tenants,
        credit_account_id = v_revenue_id,
        credit_account_name = 'Rental Income',
        next_post_date = v_next_post_date
      WHERE id = v_existing_recur_id AND company_id = v_company_id;
    ELSE
      INSERT INTO recurring_journal_entries (
        company_id, description, frequency, day_of_month, amount,
        tenant_name, property,
        debit_account_id, debit_account_name,
        credit_account_id, credit_account_name,
        status, next_post_date, created_by
      ) VALUES (
        v_company_id,
        'Monthly rent — ' || v_all_tenants || ' — ' || split_part(v_address, ',', 1),
        COALESCE(v_recurring->>'frequency','monthly'),
        v_day,
        (v_recurring->>'amount')::numeric,
        v_all_tenants, v_address,
        v_tenant_ar_id, 'AR - ' || v_all_tenants,
        v_revenue_id, 'Rental Income',
        'active', v_next_post_date, v_caller_email
      );
    END IF;
  END IF;

  -- ─── 10. WIZARD ROW — mark completed ────────────────────────────
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
$$;
