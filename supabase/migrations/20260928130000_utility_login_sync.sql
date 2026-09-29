-- Utility logins and automation (audit theme I).
--
-- Logins live in TWO tables: `utilities` (what the daily bill sweep and the
-- portal worker read) and `utility_accounts` (the Utilities page "Accounts"
-- tab). bridge_utility_account copies utilities -> utility_accounts, but only
-- on INSERT, so a login changed on a live utilities row never reached the
-- account, and the account tab's own edits never reached the sweep. The app
-- side now writes BOTH rows on an Accounts-tab save (owner decision); this
-- migration makes the database side agree.
--
--   A. utility_accounts.archived_reason -- 'user_deleted' when a person
--      deleted the account on the Accounts tab. The bridge's re-link (the
--      wizard archives + re-inserts utilities on every edit) no longer
--      resurrects such an account. Accounts archived BY the bridge (because
--      their utilities row was archived) keep a NULL reason and still re-link.
--   B. bridge_utility_account:
--      - INSERT re-link skips user-deleted accounts and never steals an
--        account that is still linked to a different LIVE utilities row;
--        among candidates it prefers the same account number. It now also
--        carries the login (incl. credential_key_fp), provider and account
--        number from the new utilities row onto the re-linked account.
--      - UPDATE syncs account_number, provider, property, responsibility and
--        the login (all six credential columns as one group) to the linked
--        live account -- only columns that CHANGED in this UPDATE, and only
--        where the account differs (IS DISTINCT FROM), so an identical write
--        coming back from the app is a no-op.
--      - Ping-pong: there is no trigger on utility_accounts that writes
--        utilities, so the two tables cannot loop. The only re-entry is the
--        existing closeout INSERT (depth 2), unchanged.
--   C. utility_accounts responsibility change -> open (unpaid) bills'
--      responsibility snapshot follows. Paid / part-paid / recharged bills
--      are history and are left alone.
--   D. claim_utility_payment: the ACCOUNT's current responsibility wins over
--      the bill snapshot (one rule, the same one the UI uses).
--   E. record_utility_reading: never matches the owner->tenant final-bill
--      closeout line (it shares the ongoing line's account number).
--   F. Backfill: Accounts-tab rows that stored the utility_providers id in
--      `provider` get the provider NAME (what everything else stores and what
--      the re-link matches on).

-- ─── A ─────────────────────────────────────────────────────────────
ALTER TABLE public.utility_accounts ADD COLUMN IF NOT EXISTS archived_reason text;
COMMENT ON COLUMN public.utility_accounts.archived_reason IS
  'Why the account was archived. ''user_deleted'' = deleted on the Accounts tab; the utilities bridge will not re-link it.';

-- ─── F ─────────────────────────────────────────────────────────────
UPDATE public.utility_accounts a
   SET provider = p.display_name, updated_at = now()
  FROM public.utility_providers p
 WHERE a.provider = p.id AND p.display_name IS NOT NULL AND a.provider <> p.display_name;

-- ─── B ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bridge_utility_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE
  v_acct_id int;
  v_prior_resp text;
  v_flip boolean := false;
  v_creds_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.archived_at IS NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.utility_accounts a WHERE a.legacy_utility_id = NEW.id) THEN
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
        IF v_acct_id IS NOT NULL THEN
          UPDATE public.utility_accounts a
             SET legacy_utility_id = NEW.id, archived_at = NULL, archived_reason = NULL,
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

-- ─── C ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sync_open_bill_responsibility() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
BEGIN
  IF NEW.responsibility IS DISTINCT FROM OLD.responsibility THEN
    UPDATE public.utility_bills b
       SET responsibility = COALESCE(NEW.responsibility, 'owner'), updated_at = now()
     WHERE b.utility_account_id = NEW.id
       AND b.company_id = NEW.company_id
       AND b.archived_at IS NULL
       -- Paid, part-paid and recharged bills are history: leave them.
       AND COALESCE(b.status, '') NOT IN ('paid', 'partial', 'settled')
       AND b.responsibility IS DISTINCT FROM COALESCE(NEW.responsibility, 'owner');
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.sync_open_bill_responsibility() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sync_open_bill_responsibility ON public.utility_accounts;
CREATE TRIGGER trg_sync_open_bill_responsibility
  AFTER UPDATE OF responsibility ON public.utility_accounts
  FOR EACH ROW EXECUTE FUNCTION public.sync_open_bill_responsibility();

-- ─── D ─────────────────────────────────────────────────────────────
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

-- ─── E ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_utility_reading(p_company_id text, p_provider text, p_account text, p_outcome text, p_amount numeric DEFAULT NULL::numeric, p_due date DEFAULT NULL::date, p_error text DEFAULT NULL::text, p_property text DEFAULT NULL::text)
 RETURNS TABLE(utility_id integer, updated boolean, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id int; v_hits int; v_acct_id int; v_period text; v_resp text; v_bill_id int;
BEGIN
  -- The owner->tenant final-bill closeout line shares the ongoing line's
  -- account number; a reading is always the ONGOING line's, never the
  -- closeout's, so both lookups skip is_final_bill rows.
  IF p_account IS NOT NULL AND btrim(p_account) <> '' THEN
    SELECT u.id INTO v_id FROM public.utilities u
     WHERE u.company_id = p_company_id AND lower(u.provider) = lower(p_provider)
       AND u.account_number = p_account AND u.archived_at IS NULL
       AND u.is_final_bill IS NOT TRUE LIMIT 1;
  END IF;

  IF v_id IS NULL AND p_property IS NOT NULL AND btrim(p_property) <> '' THEN
    SELECT count(*), min(u.id) INTO v_hits, v_id FROM public.utilities u
     WHERE u.company_id = p_company_id AND lower(u.provider) = lower(p_provider)
       AND u.archived_at IS NULL
       AND u.is_final_bill IS NOT TRUE
       AND lower(coalesce(u.property, '')) LIKE '%' || lower(btrim(p_property)) || '%';
    IF v_hits > 1 THEN
      RETURN QUERY SELECT NULL::int, false,
        format('"%s" matches %s utility rows — too ambiguous to record', p_property, v_hits);
      RETURN;
    END IF;
  END IF;

  IF v_id IS NULL THEN
    RETURN QUERY SELECT NULL::int, false,
      format('no %s utility row matches %s', p_provider,
             coalesce(nullif(p_account, ''), p_property, '(nothing to match on)'));
    RETURN;
  END IF;

  SELECT a.id, a.responsibility INTO v_acct_id, v_resp
    FROM public.utility_accounts a WHERE a.legacy_utility_id = v_id;

  IF v_acct_id IS NULL THEN
    RETURN QUERY SELECT v_id, false,
      format('utility %s has no utility_accounts row — re-run the phase 1 backfill', v_id);
    RETURN;
  END IF;

  IF p_outcome = 'ok' AND p_amount IS NOT NULL THEN
    v_period := to_char(coalesce(p_due, current_date), 'YYYY-MM');

    INSERT INTO public.utility_bills (
      company_id, utility_account_id, property, provider, provider_display,
      amount, due_date, statement_period, responsibility, status, source,
      read_at, created_at, updated_at)
    SELECT a.company_id, v_acct_id, a.property, a.provider, coalesce(a.provider_display, a.provider),
           p_amount, p_due, v_period, coalesce(v_resp, 'owner'),
           'pending_review', 'scraper', now(), now(), now()
      FROM public.utility_accounts a WHERE a.id = v_acct_id
    ON CONFLICT (company_id, utility_account_id, statement_period)
      WHERE archived_at is null and utility_account_id is not null and statement_period is not null
    DO UPDATE SET
      amount   = EXCLUDED.amount,
      due_date = COALESCE(EXCLUDED.due_date, public.utility_bills.due_date),
      read_at  = now(),
      updated_at = now(),
      status = CASE WHEN public.utility_bills.status IN ('pending_review','error')
                    THEN 'pending_review' ELSE public.utility_bills.status END
    RETURNING id INTO v_bill_id;

    UPDATE public.utility_accounts
       SET last_checked_at = now(), last_check_status = 'ok', last_check_error = NULL
     WHERE id = v_acct_id;

    RETURN QUERY SELECT v_id, true, format('recorded bill %s for %s', v_bill_id, v_period);
  ELSE
    UPDATE public.utility_accounts
       SET last_checked_at = now(), last_check_status = p_outcome,
           last_check_error = left(coalesce(p_error, p_outcome), 300)
     WHERE id = v_acct_id;

    RETURN QUERY SELECT v_id, false, format('outcome %s — previous figures left untouched', p_outcome);
  END IF;
END; $function$;
REVOKE ALL ON FUNCTION public.record_utility_reading(text, text, text, text, numeric, date, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_utility_reading(text, text, text, text, numeric, date, text, text) TO service_role;
