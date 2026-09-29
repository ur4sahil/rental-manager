-- Utility logins, hardening after an adversarial pass (theme I, round 2).
--
-- 1. Accounts-tab save hijacked another account. An account with no linked
--    utilities row got one INSERTed for it, and the bridge's candidate match
--    (same property + provider) adopted a DIFFERENT unlinked account. Now the
--    app calls save_utility_line_for_account(company, account_id | NULL, row):
--    it names the account (NULL = a brand-new one) in a transaction-local
--    setting and inserts the row in the same transaction; the bridge links
--    exactly that account and skips candidate matching. Callers that name
--    nothing (the wizard, imports) keep the old matching.
-- 2. RLS: utility_accounts_company / utility_bills_company let ANY company
--    member (tenants and owners included) read and write every row -- a
--    tenant could flip an account to owner and read login ciphertext.
--    Permissive policies are OR'd, so they are DROPPED; staff-only policies
--    remain (is_company_staff: active member, role not tenant/owner). No
--    tenant or owner portal reads either table.
-- 3. claim_utility_payment also refuses condo-fee utilities, and compares
--    responsibility case-insensitively.

-- ─── bridge (named account) ────────────────────────────────────────
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

-- ─── 1. the named-account insert ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.save_utility_line_for_account(p_company_id text, p_account_id int, p_row jsonb)
RETURNS int
LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public','pg_temp' AS $$
DECLARE
  v_id int;
  v_linked int;
BEGIN
  IF p_account_id IS NOT NULL THEN
    -- Runs as the caller, so RLS decides what "this company's account" is.
    SELECT a.legacy_utility_id INTO v_linked FROM public.utility_accounts a
     WHERE a.id = p_account_id AND a.company_id = p_company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'utility account % is not available', p_account_id USING ERRCODE = '42501';
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
  -- Belt and braces: never leave the name set for a later statement.
  PERFORM set_config('app.utility_named_account', '', true);
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.save_utility_line_for_account(text, int, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_utility_line_for_account(text, int, jsonb) TO authenticated, service_role;

-- ─── 2. RLS: staff only ─────────────────────────────────────────────
DROP POLICY IF EXISTS utility_accounts_company ON public.utility_accounts;
DROP POLICY IF EXISTS utility_bills_company ON public.utility_bills;
DROP POLICY IF EXISTS utility_bills_staff ON public.utility_bills;
CREATE POLICY utility_bills_staff ON public.utility_bills
  FOR ALL USING (public.is_company_staff(company_id)) WITH CHECK (public.is_company_staff(company_id));
-- util_accts_staff (FOR ALL USING is_company_staff(company_id)) stays as the
-- one policy on utility_accounts.

-- ─── 3. claim: condo fee + case-insensitive ─────────────────────────
CREATE OR REPLACE FUNCTION public.claim_utility_payment(p_company_id text, p_id uuid, p_worker text)
 RETURNS TABLE(ok boolean, reason text, payment_id uuid, amount numeric, provider text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pay        public.utility_payments%ROWTYPE;
  v_set        public.utility_payment_settings%ROWTYPE;
  v_today      numeric;
  v_resp       text;
  v_bill_total numeric;
  v_already    numeric;
BEGIN
  SELECT * INTO v_set FROM public.utility_payment_settings WHERE company_id = p_company_id;
  IF NOT FOUND OR NOT v_set.enabled THEN
    RETURN QUERY SELECT false, 'payment is not enabled for this company', NULL::uuid, NULL::numeric, NULL::text; RETURN;
  END IF;

  SELECT * INTO v_pay FROM public.utility_payments
    WHERE id = p_id AND company_id = p_company_id
    FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'no such payment, or another runner holds it', NULL::uuid, NULL::numeric, NULL::text; RETURN;
  END IF;

  IF v_pay.status <> 'approved' THEN
    RETURN QUERY SELECT false, format('payment is %s, not approved', v_pay.status), NULL::uuid, NULL::numeric, NULL::text; RETURN;
  END IF;
  IF v_set.require_per_payment_approval AND v_pay.approved_by IS NULL THEN
    RETURN QUERY SELECT false, 'no person approved this payment', NULL::uuid, NULL::numeric, NULL::text; RETURN;
  END IF;

  -- The tenant's bill is not ours to pay. The ACCOUNT's current
  -- responsibility is the truth (the bill only holds a snapshot from when it
  -- was read); the snapshot is the fallback when the account has none.
  IF v_pay.bill_id IS NOT NULL THEN
    SELECT COALESCE(a.responsibility, b.responsibility), b.amount
      INTO v_resp, v_bill_total
      FROM public.utility_bills b
      LEFT JOIN public.utility_accounts a ON a.id = b.utility_account_id
     WHERE b.id = v_pay.bill_id AND b.company_id = p_company_id;

    v_resp := lower(btrim(v_resp));
    -- Covered by the condo fee: there is no separate bill of ours to pay.
    IF v_resp = 'condo_fee' THEN
      UPDATE public.utility_payments
         SET status = 'cancelled',
             error  = 'this utility is covered by the condo fee — there is no separate bill to pay'
       WHERE id = v_pay.id;
      RETURN QUERY SELECT false, 'this utility is covered by the condo fee', NULL::uuid, NULL::numeric, NULL::text; RETURN;
    END IF;

    IF v_resp = 'tenant' THEN
      UPDATE public.utility_payments
         SET status = 'cancelled',
             error  = 'the tenant is responsible for this utility — it is not ours to pay'
       WHERE id = v_pay.id;
      RETURN QUERY SELECT false, 'the tenant is responsible for this utility', NULL::uuid, NULL::numeric, NULL::text; RETURN;
    END IF;

    -- THE TOTAL MAY NEVER EXCEED THE BILL.
    SELECT COALESCE(sum(approved_amount), 0) INTO v_already
      FROM public.utility_payments
     WHERE company_id = p_company_id
       AND bill_id = v_pay.bill_id
       AND id <> v_pay.id
       AND status IN ('submitting','paid','unknown','partial');

    IF v_bill_total IS NOT NULL AND v_bill_total > 0
       AND v_already + v_pay.approved_amount > v_bill_total + 0.005 THEN
      UPDATE public.utility_payments
         SET status = 'cancelled',
             error  = format('would pay %s of a %s bill that already has %s against it',
                             v_pay.approved_amount, v_bill_total, v_already)
       WHERE id = v_pay.id;
      RETURN QUERY SELECT false,
        format('total would exceed the bill: %s already, %s requested, bill is %s',
               v_already, v_pay.approved_amount, v_bill_total),
        NULL::uuid, NULL::numeric, NULL::text; RETURN;
    END IF;
  END IF;

  IF v_pay.approved_amount > v_set.max_payment_amount THEN
    RETURN QUERY SELECT false, format('%s is over the per-payment cap of %s', v_pay.approved_amount, v_set.max_payment_amount), NULL::uuid, NULL::numeric, NULL::text; RETURN;
  END IF;

  SELECT COALESCE(sum(approved_amount), 0) INTO v_today
    FROM public.utility_payments
   WHERE company_id = p_company_id
     AND status IN ('submitting','paid','unknown','partial')
     AND submitted_at >= date_trunc('day', now());
  IF v_today + v_pay.approved_amount > v_set.max_daily_total THEN
    RETURN QUERY SELECT false, format('would exceed the daily cap of %s (already %s)', v_set.max_daily_total, v_today), NULL::uuid, NULL::numeric, NULL::text; RETURN;
  END IF;

  UPDATE public.utility_payments
     SET status = 'submitting', submitted_at = now(), error = NULL
   WHERE id = v_pay.id;

  RETURN QUERY SELECT true, 'ok', v_pay.id, v_pay.approved_amount, v_pay.provider;
END;
$function$;
REVOKE ALL ON FUNCTION public.claim_utility_payment(text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_utility_payment(text, uuid, text) TO service_role;
