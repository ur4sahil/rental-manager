-- Utility logins, round 3 (theme I). TEST only until approved.
--
-- 1. property_loans / portfolio_loans / portfolio_loan_properties /
--    property_insurance: the *_company_isolation policies let ANY active
--    member (tenants and owners included) read and UPDATE every row, login
--    ciphertext included. Dropped (permissive policies are OR'd) and replaced
--    by staff-only policies. Owners -- whose role has the Loans page -- get a
--    read-only, credential-free, own-properties-only path:
--    owner_loans_readonly(company).
-- 2. Utility logins/bills: maintenance has no Utilities page, so
--    is_utility_staff() (staff minus maintenance, unless a maintenance
--    member's custom pages include 'utilities') now gates utilities,
--    utility_accounts and utility_bills.
-- 3. save_utility_line_for_account locks the account (FOR UPDATE) and refuses
--    an archived / user-deleted one; the bridge's named path refuses an
--    account that already has a live line (no orphan line from a race).
-- 4. responsibility: known variants normalised (tenant_pays -> tenant,
--    owner_pays -> owner, 'Condo Fee' -> condo_fee, case/space), '' -> NULL,
--    then CHECK (NULL or owner/tenant/condo_fee/shared) added NOT VALID and
--    VALIDATEd on utilities, utility_accounts and utility_bills.

-- owner_loans_readonly reads portfolio_loan_properties.archived_at. That column
-- arrives with the property-delete work (20260929010000, same IF NOT EXISTS);
-- added here too so this migration stands alone (production lacked it).
ALTER TABLE public.portfolio_loan_properties ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- ─── 2. who may touch utility logins / bills ────────────────────────
-- Policies are TO authenticated: anon never evaluates them (and so never
-- needs EXECUTE on these helpers, which are revoked from anon).
CREATE OR REPLACE FUNCTION public.is_utility_staff(p_company_id text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE
  v_role text; v_pages text;
BEGIN
  SELECT cm.role, cm.custom_pages INTO v_role, v_pages
    FROM public.company_members cm
   WHERE cm.company_id = p_company_id
     AND (cm.auth_user_id = auth.uid() OR lower(cm.user_email) = lower(auth.email()))
     AND cm.status = 'active'
     AND cm.role NOT IN ('tenant', 'owner')
   ORDER BY (cm.role <> 'maintenance') DESC
   LIMIT 1;
  IF v_role IS NULL THEN RETURN false; END IF;
  IF v_role <> 'maintenance' THEN RETURN true; END IF;
  -- Maintenance only when someone gave that member the Utilities page.
  BEGIN
    RETURN v_pages IS NOT NULL AND v_pages::jsonb ? 'utilities';
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
END $$;
REVOKE ALL ON FUNCTION public.is_utility_staff(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_utility_staff(text) TO authenticated, service_role;

DROP POLICY IF EXISTS utilities_read ON public.utilities;
DROP POLICY IF EXISTS utilities_write ON public.utilities;
DROP POLICY IF EXISTS utilities_staff ON public.utilities;
CREATE POLICY utilities_staff ON public.utilities
  FOR ALL TO authenticated USING (public.is_utility_staff(company_id)) WITH CHECK (public.is_utility_staff(company_id));
DROP POLICY IF EXISTS util_accts_staff ON public.utility_accounts;
CREATE POLICY util_accts_staff ON public.utility_accounts
  FOR ALL TO authenticated USING (public.is_utility_staff(company_id)) WITH CHECK (public.is_utility_staff(company_id));
DROP POLICY IF EXISTS utility_bills_staff ON public.utility_bills;
CREATE POLICY utility_bills_staff ON public.utility_bills
  FOR ALL TO authenticated USING (public.is_utility_staff(company_id)) WITH CHECK (public.is_utility_staff(company_id));

-- ─── 1. loans / insurance: staff only ───────────────────────────────
DROP POLICY IF EXISTS property_loans_company_isolation ON public.property_loans;
DROP POLICY IF EXISTS property_loans_staff ON public.property_loans;
CREATE POLICY property_loans_staff ON public.property_loans
  FOR ALL TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));
DROP POLICY IF EXISTS portfolio_loans_company_isolation ON public.portfolio_loans;
DROP POLICY IF EXISTS portfolio_loans_staff ON public.portfolio_loans;
CREATE POLICY portfolio_loans_staff ON public.portfolio_loans
  FOR ALL TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));
DROP POLICY IF EXISTS portfolio_loan_properties_company_isolation ON public.portfolio_loan_properties;
DROP POLICY IF EXISTS portfolio_loan_properties_staff ON public.portfolio_loan_properties;
CREATE POLICY portfolio_loan_properties_staff ON public.portfolio_loan_properties
  FOR ALL TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));
DROP POLICY IF EXISTS property_insurance_company_isolation ON public.property_insurance;
DROP POLICY IF EXISTS property_insurance_staff ON public.property_insurance;
CREATE POLICY property_insurance_staff ON public.property_insurance
  FOR ALL TO authenticated USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));

-- Owners: their own properties' loans, read-only, no credential columns.
CREATE OR REPLACE FUNCTION public.owner_loans_readonly(p_company_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE
  v_owner uuid := public.get_owner_id(p_company_id);  -- NULL unless the caller is an active owner member
  v_addrs text[];
BEGIN
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('loans', '[]'::jsonb, 'portfolio_loans', '[]'::jsonb, 'portfolio_props', '[]'::jsonb);
  END IF;
  SELECT array_agg(p.address) INTO v_addrs FROM public.properties p
   WHERE p.company_id = p_company_id AND p.owner_id = v_owner AND p.archived_at IS NULL;
  v_addrs := COALESCE(v_addrs, ARRAY[]::text[]);
  RETURN jsonb_build_object(
    'loans', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM (
       SELECT l.id, l.company_id, l.property, l.property_id, l.lender_name, l.loan_type, l.original_amount,
              l.current_balance, l.interest_rate, l.monthly_payment, l.escrow_included, l.escrow_amount,
              l.escrow_covers, l.loan_start_date, l.maturity_date, l.account_number, l.status, l.notes,
              l.website, l.created_at, l.updated_at
         FROM public.property_loans l
        WHERE l.company_id = p_company_id AND l.archived_at IS NULL AND l.property = ANY (v_addrs)) x), '[]'::jsonb),
    'portfolio_props', COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (
       SELECT pp.id, pp.portfolio_loan_id, pp.property, pp.property_id
         FROM public.portfolio_loan_properties pp
        WHERE pp.company_id = p_company_id AND pp.archived_at IS NULL AND pp.property = ANY (v_addrs)) x), '[]'::jsonb),
    'portfolio_loans', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM (
       SELECT pl.id, pl.company_id, pl.lender_name, pl.loan_type, pl.original_amount, pl.current_balance,
              pl.interest_rate, pl.monthly_payment, pl.account_number, pl.loan_start_date, pl.maturity_date,
              pl.escrow_included, pl.escrow_amount, pl.status, pl.notes, pl.website, pl.created_at, pl.updated_at
         FROM public.portfolio_loans pl
        WHERE pl.company_id = p_company_id AND pl.archived_at IS NULL
          AND EXISTS (SELECT 1 FROM public.portfolio_loan_properties pp
                       WHERE pp.portfolio_loan_id = pl.id AND pp.company_id = p_company_id
                         AND pp.archived_at IS NULL AND pp.property = ANY (v_addrs))) x), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.owner_loans_readonly(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_loans_readonly(text) TO authenticated, service_role;

-- ─── 3. named-line save: lock, refuse archived ──────────────────────
CREATE OR REPLACE FUNCTION public.save_utility_line_for_account(p_company_id text, p_account_id int, p_row jsonb)
RETURNS int
LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public','pg_temp' AS $$
DECLARE
  v_id int;
  v_linked int;
  v_archived timestamptz;
BEGIN
  IF p_account_id IS NOT NULL THEN
    -- Runs as the caller, so RLS decides what "this company's account" is.
    -- FOR UPDATE: a second concurrent save waits here, then sees the line
    -- the first one linked and is refused below.
    SELECT a.legacy_utility_id, a.archived_at INTO v_linked, v_archived FROM public.utility_accounts a
     WHERE a.id = p_account_id AND a.company_id = p_company_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'utility account % is not available', p_account_id USING ERRCODE = '42501';
    END IF;
    IF v_archived IS NOT NULL THEN
      RAISE EXCEPTION 'utility account % was deleted or archived', p_account_id USING ERRCODE = '42501';
    END IF;
    IF v_linked IS NOT NULL AND EXISTS (SELECT 1 FROM public.utilities u WHERE u.id = v_linked AND u.archived_at IS NULL) THEN
      RAISE EXCEPTION 'utility account % already has a live utility line (%)', p_account_id, v_linked USING ERRCODE = '23505';
    END IF;
  END IF;

  PERFORM set_config('app.utility_named_account', COALESCE(p_account_id::text, 'new'), true);
  INSERT INTO public.utilities (
    company_id, property, provider, type, account_number, amount, status, website, responsibility,
    username_encrypted, password_encrypted, encryption_iv, encryption_iv_username, encryption_salt, credential_key_fp)
  VALUES (
    p_company_id, p_row->>'property', p_row->>'provider', COALESCE(NULLIF(p_row->>'type',''), 'Electric'),
    NULLIF(p_row->>'account_number',''), COALESCE(NULLIF(p_row->>'amount','')::numeric, 0),
    COALESCE(NULLIF(p_row->>'status',''), 'pending'), COALESCE(p_row->>'website',''),
    COALESCE(NULLIF(p_row->>'responsibility',''), 'owner'),
    NULLIF(p_row->>'username_encrypted',''), NULLIF(p_row->>'password_encrypted',''),
    NULLIF(p_row->>'encryption_iv',''), NULLIF(p_row->>'encryption_iv_username',''),
    NULLIF(p_row->>'encryption_salt',''), NULLIF(p_row->>'credential_key_fp',''))
  RETURNING id INTO v_id;
  PERFORM set_config('app.utility_named_account', '', true);
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.save_utility_line_for_account(text, int, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_utility_line_for_account(text, int, jsonb) TO authenticated, service_role;

-- ─── bridge: the named path refuses a second live line ──────────────
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

-- ─── 4. responsibility: normalise, then constrain ───────────────────
CREATE OR REPLACE FUNCTION public.normalize_utility_responsibility(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path TO 'public','pg_temp' AS $$
  SELECT CASE
    WHEN p IS NULL OR btrim(p) = '' THEN NULL
    ELSE CASE regexp_replace(lower(btrim(p)), '[\s-]+', '_', 'g')
      WHEN 'tenant_pays' THEN 'tenant'
      WHEN 'tenants' THEN 'tenant'
      WHEN 'owner_pays' THEN 'owner'
      WHEN 'condo' THEN 'condo_fee'
      WHEN 'condofee' THEN 'condo_fee'
      ELSE regexp_replace(lower(btrim(p)), '[\s-]+', '_', 'g') END
  END $$;

UPDATE public.utility_bills SET responsibility = public.normalize_utility_responsibility(responsibility)
 WHERE responsibility IS DISTINCT FROM public.normalize_utility_responsibility(responsibility);
UPDATE public.utility_accounts SET responsibility = COALESCE(public.normalize_utility_responsibility(responsibility), 'owner')
 WHERE responsibility IS DISTINCT FROM COALESCE(public.normalize_utility_responsibility(responsibility), 'owner');
UPDATE public.utilities SET responsibility = public.normalize_utility_responsibility(responsibility)
 WHERE responsibility IS DISTINCT FROM public.normalize_utility_responsibility(responsibility);

ALTER TABLE public.utilities DROP CONSTRAINT IF EXISTS chk_utilities_responsibility;
ALTER TABLE public.utilities ADD CONSTRAINT chk_utilities_responsibility
  CHECK (responsibility IS NULL OR responsibility IN ('owner','tenant','condo_fee','shared')) NOT VALID;
ALTER TABLE public.utilities VALIDATE CONSTRAINT chk_utilities_responsibility;
ALTER TABLE public.utility_accounts DROP CONSTRAINT IF EXISTS chk_utility_accounts_responsibility;
ALTER TABLE public.utility_accounts ADD CONSTRAINT chk_utility_accounts_responsibility
  CHECK (responsibility IS NULL OR responsibility IN ('owner','tenant','condo_fee','shared')) NOT VALID;
ALTER TABLE public.utility_accounts VALIDATE CONSTRAINT chk_utility_accounts_responsibility;
ALTER TABLE public.utility_bills DROP CONSTRAINT IF EXISTS chk_utility_bills_responsibility;
ALTER TABLE public.utility_bills ADD CONSTRAINT chk_utility_bills_responsibility
  CHECK (responsibility IS NULL OR responsibility IN ('owner','tenant','condo_fee','shared')) NOT VALID;
ALTER TABLE public.utility_bills VALIDATE CONSTRAINT chk_utility_bills_responsibility;
