-- record_utility_reading must attribute a reading to the LIVE utilities row.
--
-- A property+provider can carry several `utilities` rows over time -- every
-- wizard edit archives the old one and inserts a new one, and the same account
-- number rides along on each. The RPC matched by account number (or property)
-- with LIMIT 1 and NO archived filter, so it could pick an ARCHIVED duplicate.
-- Only the live row's account is kept linked (see bridge_utility_account), so a
-- reading that matched an archived row found no account and reported
-- "utility N has no utility_accounts row" even though the live account existed.
--
-- Fix: both match queries now require archived_at IS NULL. An archived utility
-- is a removed one; a fresh reading should never be recorded against it. The
-- rest of the function is unchanged.

CREATE OR REPLACE FUNCTION public.record_utility_reading(
  p_company_id text, p_provider text, p_account text, p_outcome text,
  p_amount numeric DEFAULT NULL::numeric, p_due date DEFAULT NULL::date,
  p_error text DEFAULT NULL::text, p_property text DEFAULT NULL::text)
 RETURNS TABLE(utility_id integer, updated boolean, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id int; v_hits int; v_acct_id int; v_period text; v_resp text; v_bill_id int;
BEGIN
  IF p_account IS NOT NULL AND btrim(p_account) <> '' THEN
    SELECT u.id INTO v_id FROM public.utilities u
     WHERE u.company_id = p_company_id AND lower(u.provider) = lower(p_provider)
       AND u.account_number = p_account AND u.archived_at IS NULL LIMIT 1;
  END IF;

  IF v_id IS NULL AND p_property IS NOT NULL AND btrim(p_property) <> '' THEN
    SELECT count(*), min(u.id) INTO v_hits, v_id FROM public.utilities u
     WHERE u.company_id = p_company_id AND lower(u.provider) = lower(p_provider)
       AND u.archived_at IS NULL
       AND lower(coalesce(u.property, '')) LIKE '%' || lower(btrim(p_property)) || '%';
    -- Ambiguity is refused, never resolved by picking one: a bill recorded
    -- against the wrong property poisons every figure after it.
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

  -- No account row means no bill can be recorded. Saying so is better than
  -- silently succeeding against a registry entry nothing reads.
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
