-- Stage 3: freeze closed periods so an as-of report stops re-summing
-- the whole book.
--
-- Stages 1 and 2 moved the arithmetic into the database and stopped the
-- page waiting on data it never read. Both are bounded improvements:
-- a Trial Balance as of today still sums every line since the company
-- opened. That is fine at 16,548 lines and will not be at 200,000.
--
-- This is how a ledger stays fast at any age: once a period is closed
-- it cannot change, so its closing balance per account is recorded, and
-- an as-of figure becomes
--     last snapshot on or before the date  +  movement since
-- which reads a handful of rows plus the current period, regardless of
-- how many years came before.
--
-- The hook already exists: accounting_period_lock is what declares a
-- period closed, and it is now enforced (apl_write, admin/manager only).

CREATE TABLE IF NOT EXISTS public.acct_period_balances (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   text NOT NULL,
  account_id   uuid NOT NULL REFERENCES public.acct_accounts(id) ON DELETE CASCADE,
  -- The last day of the closed period this balance is the closing
  -- figure for.
  as_of        date NOT NULL,
  debit_total  numeric NOT NULL DEFAULT 0,
  credit_total numeric NOT NULL DEFAULT 0,
  -- Cumulative from the beginning of the ledger to as_of, so a single
  -- row answers "balance as at this date" without needing its
  -- predecessors.
  net_balance  numeric NOT NULL DEFAULT 0,
  built_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, account_id, as_of)
);

CREATE INDEX IF NOT EXISTS idx_period_balances_lookup
  ON public.acct_period_balances (company_id, as_of DESC);

ALTER TABLE public.acct_period_balances ENABLE ROW LEVEL SECURITY;

-- Read for staff, write only through the SECURITY DEFINER builder
-- below. A snapshot that anyone could edit would be worse than no
-- snapshot: every as-of figure in the system would inherit the lie.
CREATE POLICY period_balances_read ON public.acct_period_balances
  FOR SELECT USING (public.is_company_staff(company_id));

-- Build (or rebuild) the snapshot for one closing date.
CREATE OR REPLACE FUNCTION public.build_period_balances(
  p_company_id text, p_as_of date
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_rows integer;
BEGIN
  IF NOT public.is_company_admin_or_manager(p_company_id) THEN
    RAISE EXCEPTION 'Only an admin or manager can close a period';
  END IF;

  INSERT INTO acct_period_balances (company_id, account_id, as_of, debit_total, credit_total, net_balance)
  SELECT p_company_id, l.account_id, p_as_of,
         SUM(COALESCE(l.debit,0)), SUM(COALESCE(l.credit,0)),
         SUM(COALESCE(l.debit,0) - COALESCE(l.credit,0))
    FROM acct_journal_lines l
    JOIN acct_journal_entries je ON je.id = l.journal_entry_id
   WHERE l.company_id = p_company_id
     AND je.status = 'posted'
     AND je.date <= p_as_of
   GROUP BY l.account_id
  ON CONFLICT (company_id, account_id, as_of) DO UPDATE
    SET debit_total = EXCLUDED.debit_total,
        credit_total = EXCLUDED.credit_total,
        net_balance = EXCLUDED.net_balance,
        built_at = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$function$;

-- Trial balance that starts from the newest snapshot at or before the
-- date and adds only what happened after it.
--
-- Falls back to summing from the beginning when no snapshot exists, so
-- it returns the same answer on a company that has never closed a
-- period -- which is every company today.
CREATE OR REPLACE FUNCTION public.report_trial_balance_fast(
  p_company_id text, p_end date
) RETURNS TABLE (
  account_id uuid, code text, name text, type text,
  debit_balance numeric, credit_balance numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_snap date;
BEGIN
  IF NOT public.is_member_of_company(p_company_id) THEN
    RAISE EXCEPTION 'Not a member of %', p_company_id;
  END IF;

  SELECT max(pb.as_of) INTO v_snap
    FROM acct_period_balances pb
   WHERE pb.company_id = p_company_id AND pb.as_of <= p_end;

  RETURN QUERY
  WITH base AS (
    SELECT pb.account_id AS aid, pb.net_balance AS n
      FROM acct_period_balances pb
     WHERE v_snap IS NOT NULL AND pb.company_id = p_company_id AND pb.as_of = v_snap
  ),
  delta AS (
    SELECT l.account_id AS aid,
           SUM(COALESCE(l.debit,0) - COALESCE(l.credit,0)) AS n
      FROM acct_journal_lines l
      JOIN acct_journal_entries je ON je.id = l.journal_entry_id
     WHERE l.company_id = p_company_id
       AND je.status = 'posted'
       AND je.date <= p_end
       AND (v_snap IS NULL OR je.date > v_snap)
     GROUP BY l.account_id
  ),
  net AS (
    SELECT COALESCE(b.aid, d.aid) AS aid,
           COALESCE(b.n, 0) + COALESCE(d.n, 0) AS n
      FROM base b FULL OUTER JOIN delta d ON d.aid = b.aid
  )
  SELECT a.id, a.code, a.name, a.type,
         CASE WHEN net.n > 0 THEN net.n ELSE 0 END,
         CASE WHEN net.n < 0 THEN abs(net.n) ELSE 0 END
    FROM acct_accounts a
    JOIN net ON net.aid = a.id
   WHERE a.company_id = p_company_id
     AND a.is_active
     AND abs(net.n) >= 0.005
   ORDER BY a.code;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.build_period_balances(text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_trial_balance_fast(text, date) TO authenticated;
