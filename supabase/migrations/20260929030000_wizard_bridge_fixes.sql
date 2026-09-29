-- Wizard / bridge fixes after the round-2 adversarial review (audit theme J).
-- TEST first; production only on the owner's say-so.
--
-- 1. bridge_utility_account (latest body: 20260929020000), identical except:
--    in the unnamed candidate path (wizard, import) an account whose
--    non-empty account_number differs from the new row's non-empty
--    account_number is never adopted. Removing a meter and adding a new one
--    of the same provider re-pointed the OLD account at the new row, moved
--    its number and history, and -- through the responsibility flip --
--    created a bogus owner final bill.
--
-- 2. commit_property_wizard (latest body: 20260928140000), identical except:
--    * new ciphertext writes the payload's credential_key_fp as-is, NULL
--      included (it used to keep the old fingerprint when the payload had
--      none);
--    * hoa_payments.encryption_salt is written whenever ANY of the three
--      login sets arrives, not only the association one.
--
-- 3. property_taxes is staff-only, as property_loans / property_insurance are
--    since 20260929020000: tenants and owners could read every tax record of
--    the company, and the write policies still admitted the 'owner' role. The
--    tenant and owner portals do not read this table.
--
-- Signatures, SECURITY and grants unchanged; CREATE OR REPLACE keeps ACLs.

-- ─── 1. bridge ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bridge_utility_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE
  v_acct_id int;
  v_prior_resp text;
  v_flip boolean := false;
  v_creds_changed boolean;
  v_named text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The Accounts tab NAMES the account a new utilities row belongs to
    -- (save_utility_line_for_account). Consumed once, so the closeout INSERT
    -- below, which re-enters this trigger, never inherits it.
    v_named := NULLIF(current_setting('app.utility_named_account', true), '');
    IF v_named IS NOT NULL THEN
      PERFORM set_config('app.utility_named_account', '', true);
    END IF;
    IF NEW.archived_at IS NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.utility_accounts a WHERE a.legacy_utility_id = NEW.id) THEN
        IF v_named = 'new' THEN
          -- A brand-new account: create it; never adopt someone else's.
          v_acct_id := NULL;
        ELSIF v_named IS NOT NULL THEN
          -- Exactly the account the app named -- no candidate matching.
          SELECT a.id, a.responsibility INTO v_acct_id, v_prior_resp
            FROM public.utility_accounts a
           WHERE a.id = v_named::int AND a.company_id = NEW.company_id;
          IF v_acct_id IS NULL THEN
            RAISE EXCEPTION 'utility account % is not in this company', v_named USING ERRCODE = '42501';
          END IF;
          -- Never give a named account a SECOND live line: a concurrent save
          -- would otherwise leave an orphan live utilities row behind.
          IF EXISTS (SELECT 1 FROM public.utility_accounts a
                       JOIN public.utilities x ON x.id = a.legacy_utility_id
                      WHERE a.id = v_acct_id AND x.id <> NEW.id AND x.archived_at IS NULL) THEN
            RAISE EXCEPTION 'utility account % already has a live utility line', v_acct_id USING ERRCODE = '23505';
          END IF;
        ELSE
        -- Nothing named (the wizard, imports): match a candidate.
        SELECT a.id, a.responsibility INTO v_acct_id, v_prior_resp
          FROM public.utility_accounts a
         WHERE a.company_id = NEW.company_id AND a.property = NEW.property
           AND lower(btrim(a.provider)) = lower(btrim(NEW.provider))
           AND a.is_final_bill = COALESCE(NEW.is_final_bill, false)
           -- A person deleted this account: do not bring it back.
           AND a.archived_reason IS DISTINCT FROM 'user_deleted'
           -- A DIFFERENT meter is a different account: never adopt one whose
           -- account number differs from the new row's. (Removing a meter and
           -- adding another of the same provider used to re-point the old
           -- account -- its number, bill history and a bogus final bill -- at
           -- the new row.) The wizard's own archive+reinsert keeps the same
           -- number, and a blank number on either side still matches.
           AND (NULLIF(btrim(a.account_number), '') IS NULL
                OR NULLIF(btrim(NEW.account_number), '') IS NULL
                OR lower(btrim(a.account_number)) = lower(btrim(NEW.account_number)))
           -- Never take an account away from another LIVE utilities row.
           AND (a.legacy_utility_id IS NULL
                OR NOT EXISTS (SELECT 1 FROM public.utilities x
                                WHERE x.id = a.legacy_utility_id AND x.archived_at IS NULL))
         ORDER BY (a.archived_at IS NULL) DESC,
                  (COALESCE(a.account_number,'') = COALESCE(NEW.account_number,'')) DESC,
                  a.id DESC
         LIMIT 1;
        END IF;
        IF v_acct_id IS NOT NULL THEN
          UPDATE public.utility_accounts a
             SET legacy_utility_id = NEW.id, archived_at = NULL, archived_reason = NULL,
                 property = NEW.property, property_id = COALESCE(NEW.property_id, a.property_id),
                 responsibility = COALESCE(NEW.responsibility, a.responsibility),
                 provider = NEW.provider,
                 account_number = COALESCE(NULLIF(NEW.account_number,''), a.account_number, ''),
                 username_encrypted     = CASE WHEN NEW.username_encrypted IS NOT NULL THEN NEW.username_encrypted     ELSE a.username_encrypted END,
                 password_encrypted     = CASE WHEN NEW.username_encrypted IS NOT NULL THEN NEW.password_encrypted     ELSE a.password_encrypted END,
                 encryption_iv          = CASE WHEN NEW.username_encrypted IS NOT NULL THEN NEW.encryption_iv          ELSE a.encryption_iv END,
                 encryption_iv_username = CASE WHEN NEW.username_encrypted IS NOT NULL THEN NEW.encryption_iv_username ELSE a.encryption_iv_username END,
                 encryption_salt        = CASE WHEN NEW.username_encrypted IS NOT NULL THEN NEW.encryption_salt        ELSE a.encryption_salt END,
                 credential_key_fp      = CASE WHEN NEW.username_encrypted IS NOT NULL THEN NEW.credential_key_fp      ELSE a.credential_key_fp END,
                 updated_at = now()
           WHERE a.id = v_acct_id;
        ELSE
          INSERT INTO public.utility_accounts (
            company_id, property, provider, provider_display, account_number,
            responsibility, is_final_bill, website, account_type, legacy_utility_id,
            username_encrypted, password_encrypted, encryption_iv, encryption_iv_username,
            encryption_salt, credential_key_fp, property_id)
          VALUES (NEW.company_id, NEW.property, NEW.provider, NEW.provider,
            COALESCE(NEW.account_number,''), COALESCE(NEW.responsibility,'owner'), COALESCE(NEW.is_final_bill,false),
            COALESCE(NEW.website,''), public.util_account_type(NEW.type, NEW.provider), NEW.id,
            NEW.username_encrypted, NEW.password_encrypted, NEW.encryption_iv, NEW.encryption_iv_username,
            NEW.encryption_salt, NEW.credential_key_fp, NEW.property_id);
        END IF;
      END IF;
      -- Flip on INSERT (wizard archive+reinsert): the prior account was the
      -- owner's, the new row is the tenant's.
      IF COALESCE(NEW.is_final_bill,false) = false
         AND COALESCE(NEW.responsibility,'owner') = 'tenant'
         AND v_prior_resp IN ('owner','condo_fee') THEN
        v_flip := true;
      END IF;
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
      UPDATE public.utility_accounts SET archived_at = NEW.archived_at, updated_at = now()
       WHERE legacy_utility_id = NEW.id AND archived_at IS NULL;
    END IF;

    -- Sync what changed on the live utilities row to its live account.
    IF NEW.archived_at IS NULL THEN
      v_creds_changed := (NEW.username_encrypted     IS DISTINCT FROM OLD.username_encrypted
                       OR NEW.password_encrypted     IS DISTINCT FROM OLD.password_encrypted
                       OR NEW.encryption_iv          IS DISTINCT FROM OLD.encryption_iv
                       OR NEW.encryption_iv_username IS DISTINCT FROM OLD.encryption_iv_username
                       OR NEW.encryption_salt        IS DISTINCT FROM OLD.encryption_salt
                       OR NEW.credential_key_fp      IS DISTINCT FROM OLD.credential_key_fp);
      IF v_creds_changed
         OR NEW.account_number IS DISTINCT FROM OLD.account_number
         OR NEW.provider       IS DISTINCT FROM OLD.provider
         OR NEW.property       IS DISTINCT FROM OLD.property
         OR NEW.responsibility IS DISTINCT FROM OLD.responsibility THEN
        UPDATE public.utility_accounts a SET
          account_number = CASE WHEN NEW.account_number IS DISTINCT FROM OLD.account_number
                                THEN COALESCE(NEW.account_number,'') ELSE a.account_number END,
          provider = CASE WHEN NEW.provider IS DISTINCT FROM OLD.provider THEN NEW.provider ELSE a.provider END,
          provider_display = CASE WHEN NEW.provider IS DISTINCT FROM OLD.provider
                                   AND (a.provider_display IS NULL OR lower(btrim(a.provider_display)) = lower(btrim(COALESCE(OLD.provider,''))))
                                  THEN NEW.provider ELSE a.provider_display END,
          property = CASE WHEN NEW.property IS DISTINCT FROM OLD.property THEN NEW.property ELSE a.property END,
          property_id = CASE WHEN NEW.property IS DISTINCT FROM OLD.property THEN NEW.property_id ELSE a.property_id END,
          responsibility = CASE WHEN NEW.responsibility IS DISTINCT FROM OLD.responsibility
                                THEN COALESCE(NEW.responsibility,'owner') ELSE a.responsibility END,
          username_encrypted     = CASE WHEN v_creds_changed THEN NEW.username_encrypted     ELSE a.username_encrypted END,
          password_encrypted     = CASE WHEN v_creds_changed THEN NEW.password_encrypted     ELSE a.password_encrypted END,
          encryption_iv          = CASE WHEN v_creds_changed THEN NEW.encryption_iv          ELSE a.encryption_iv END,
          encryption_iv_username = CASE WHEN v_creds_changed THEN NEW.encryption_iv_username ELSE a.encryption_iv_username END,
          encryption_salt        = CASE WHEN v_creds_changed THEN NEW.encryption_salt        ELSE a.encryption_salt END,
          credential_key_fp      = CASE WHEN v_creds_changed THEN NEW.credential_key_fp      ELSE a.credential_key_fp END,
          updated_at = now()
         WHERE a.legacy_utility_id = NEW.id AND a.archived_at IS NULL
           -- Only when something actually differs: the app writes the same
           -- values to both rows, and that must not bounce.
           AND ((NEW.account_number IS DISTINCT FROM OLD.account_number AND a.account_number IS DISTINCT FROM COALESCE(NEW.account_number,''))
             OR (NEW.provider IS DISTINCT FROM OLD.provider AND a.provider IS DISTINCT FROM NEW.provider)
             OR (NEW.property IS DISTINCT FROM OLD.property AND a.property IS DISTINCT FROM NEW.property)
             OR (NEW.responsibility IS DISTINCT FROM OLD.responsibility AND a.responsibility IS DISTINCT FROM COALESCE(NEW.responsibility,'owner'))
             OR (v_creds_changed AND (a.username_encrypted IS DISTINCT FROM NEW.username_encrypted
                                   OR a.password_encrypted IS DISTINCT FROM NEW.password_encrypted
                                   OR a.encryption_iv IS DISTINCT FROM NEW.encryption_iv
                                   OR a.encryption_iv_username IS DISTINCT FROM NEW.encryption_iv_username
                                   OR a.encryption_salt IS DISTINCT FROM NEW.encryption_salt
                                   OR a.credential_key_fp IS DISTINCT FROM NEW.credential_key_fp)));
      END IF;
    END IF;

    -- Flip on UPDATE (Accounts-tab Edit sets responsibility directly on the
    -- live row): owner/condo -> tenant on a non-final, non-archived row.
    IF NEW.archived_at IS NULL
       AND COALESCE(NEW.is_final_bill,false) = false
       AND COALESCE(OLD.responsibility,'owner') IN ('owner','condo_fee')
       AND COALESCE(NEW.responsibility,'owner') = 'tenant' THEN
      v_flip := true;
    END IF;
  END IF;

  -- Create the owner final-bill closeout line once, if a flip happened and no
  -- active final-bill line already exists for this property+provider. Its own
  -- INSERT re-enters this trigger and creates the matching closeout account.
  IF v_flip
     AND NOT EXISTS (SELECT 1 FROM public.utilities u
                      WHERE u.company_id = NEW.company_id AND u.property = NEW.property
                        AND lower(btrim(u.provider)) = lower(btrim(NEW.provider))
                        AND u.is_final_bill = true AND u.archived_at IS NULL) THEN
    INSERT INTO public.utilities (
      company_id, property, provider, type, account_number, amount, due,
      responsibility, is_final_bill, status, website,
      username_encrypted, password_encrypted, encryption_iv,
      encryption_iv_username, encryption_salt, credential_key_fp)
    VALUES (
      NEW.company_id, NEW.property, NEW.provider, NEW.type,
      NEW.account_number, 0, NEW.due,
      'owner', true, 'pending', COALESCE(NEW.website,''),
      NEW.username_encrypted, NEW.password_encrypted, NEW.encryption_iv,
      NEW.encryption_iv_username, NEW.encryption_salt, NEW.credential_key_fp);
  END IF;

  RETURN NEW;
END $$;

-- A trigger function: never an RPC. Firing a trigger does not check EXECUTE.
REVOKE ALL ON FUNCTION public.bridge_utility_account() FROM PUBLIC, anon, authenticated;


-- ─── 2. commit_property_wizard ──────────────────────────────────────
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
        -- New ciphertext carries its own key fingerprint, NULL included: a
        -- stale fingerprint would claim a key the login was not encrypted with.
        credential_key_fp = CASE WHEN NULLIF(v_u->>'username_encrypted','') IS NOT NULL
          THEN NULLIF(v_u->>'credential_key_fp','') ELSE credential_key_fp END
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
        -- ONE salt serves all three login sets on the row. Written whenever
        -- ANY set arrives (the client reuses the stored salt, or mints the
        -- row's first one) -- it used to follow the association set only, so
        -- a management / pay-portal login added to a row with no salt was
        -- stored without the salt it was encrypted under.
        encryption_salt = CASE WHEN (NULLIF(v_h->>'username_encrypted','') IS NOT NULL
                                     OR NULLIF(v_h->>'mgmt_username_encrypted','') IS NOT NULL
                                     OR NULLIF(v_h->>'pay_username_encrypted','') IS NOT NULL)
                                    AND NULLIF(v_h->>'encryption_salt','') IS NOT NULL
          THEN v_h->>'encryption_salt' ELSE encryption_salt END,
        credential_key_fp = CASE WHEN NULLIF(v_h->>'username_encrypted','') IS NOT NULL
                                   OR NULLIF(v_h->>'mgmt_username_encrypted','') IS NOT NULL
                                   OR NULLIF(v_h->>'pay_username_encrypted','') IS NOT NULL
          THEN NULLIF(v_h->>'credential_key_fp','') ELSE credential_key_fp END,
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
          THEN NULLIF(v_loan->>'credential_key_fp','') ELSE credential_key_fp END,
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
          THEN NULLIF(v_insurance->>'credential_key_fp','') ELSE credential_key_fp END
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

-- ─── 3. property_taxes: staff only ──────────────────────────────────
DROP POLICY IF EXISTS property_taxes_select ON public.property_taxes;
DROP POLICY IF EXISTS property_taxes_insert ON public.property_taxes;
DROP POLICY IF EXISTS property_taxes_update ON public.property_taxes;
DROP POLICY IF EXISTS property_taxes_company_isolation ON public.property_taxes;
DROP POLICY IF EXISTS property_taxes_staff ON public.property_taxes;
CREATE POLICY property_taxes_staff ON public.property_taxes
  FOR ALL TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));
