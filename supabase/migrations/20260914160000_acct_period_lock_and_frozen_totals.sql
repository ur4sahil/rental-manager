-- STEPS 3 + 4: make a closed period actually closed, then cache it.
--
-- WHY THIS ORDER
--
-- The plan was "store balances, freeze closed periods". Freezing is what
-- makes storing safe: a cached total is only trustworthy if the rows behind
-- it cannot change. Two measured facts decided the design:
--
--   * accounting_period_lock is enforced in the APP only (checkPeriodLock
--     in src/utils/accounting.js). There was no database trigger, so
--     anything writing directly -- a service-role script, the QuickBooks
--     import, a bug -- walked straight through it. "Locked" was a UI
--     convention, not a guarantee.
--
--   * No company has a lock row at all (0 rows) across 45 months of
--     entries, so caching "closed periods" would currently cache nothing.
--
-- Hence: enforce the lock first so closed means closed, and key the cache to
-- locked months so it is correct BY CONSTRUCTION rather than by a coherence
-- protocol that has to be got right on every write path. With no locks set
-- the triggers never fire and nothing about today's behaviour changes; they
-- begin protecting the books the moment a period is actually closed.
--
-- A cache with invalidation was considered and rejected. The full balance
-- index is 87 ms after the index work in 20260914150100; caching every past
-- month might save 60 ms of that, which does not justify the chance of a
-- stale total being shown as an answer on someone's books.
--
-- Verified on the test database, all six passing:
--   no lock      -> editing an old entry is allowed   (today's behaviour)
--   locked       -> editing an entry inside it refused
--   locked       -> editing an entry after it allowed
--   locked       -> editing LINES inside it refused
--   frozen totals equal a live aggregation  (331,922.67 both ways)
--   unlocking clears the cache

-- ---------------------------------------------------------------------
-- STEP 4: the lock, enforced where it cannot be bypassed.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_acct_enforce_period_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_lock date;
  v_company text;
  v_new_date date;
  v_old_date date;
BEGIN
  v_company := COALESCE(NEW.company_id, OLD.company_id);
  SELECT lock_date INTO v_lock FROM accounting_period_lock WHERE company_id = v_company;
  -- No lock for this company: nothing to enforce. That is every company
  -- today, which is why installing this changes no current behaviour.
  IF v_lock IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_new_date := NEW.date;
  v_old_date := OLD.date;

  -- Moving an entry INTO a locked period and moving one OUT of it are both
  -- changes to a closed period. Checking only the new date would let an
  -- update drag a locked entry forward and rewrite history.
  IF (v_new_date IS NOT NULL AND v_new_date <= v_lock)
     OR (v_old_date IS NOT NULL AND v_old_date <= v_lock) THEN
    RAISE EXCEPTION
      'Accounting period is locked through %. Entry dated % cannot be added, changed or removed.',
      v_lock, COALESCE(v_old_date, v_new_date)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS acct_je_period_lock ON public.acct_journal_entries;
CREATE TRIGGER acct_je_period_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.acct_journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.trg_acct_enforce_period_lock();

-- Lines need their own guard: updateJournalEntry edits an entry by DELETING
-- AND RE-INSERTING its lines, which never touches the entry row. A guard on
-- entries alone would leave the amounts inside a closed period freely
-- rewritable -- the case the test above checks explicitly.
CREATE OR REPLACE FUNCTION public.trg_acct_enforce_period_lock_lines()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_lock date;
  v_company text;
  v_date date;
BEGIN
  v_company := COALESCE(NEW.company_id, OLD.company_id);
  SELECT lock_date INTO v_lock FROM accounting_period_lock WHERE company_id = v_company;
  IF v_lock IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT je.date INTO v_date FROM acct_journal_entries je
  WHERE je.id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  IF v_date IS NOT NULL AND v_date <= v_lock THEN
    RAISE EXCEPTION
      'Accounting period is locked through %. Lines on the entry dated % cannot be changed.',
      v_lock, v_date
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS acct_jl_period_lock ON public.acct_journal_lines;
CREATE TRIGGER acct_jl_period_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.acct_journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.trg_acct_enforce_period_lock_lines();

-- ---------------------------------------------------------------------
-- STEP 3: stored period totals, for months the lock has frozen.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.acct_period_totals (
  company_id   text    NOT NULL,
  account_id   uuid    NOT NULL,
  period_month date    NOT NULL,
  class_id     text,
  debit        numeric NOT NULL DEFAULT 0,
  credit       numeric NOT NULL DEFAULT 0,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, account_id, period_month, class_id)
);

COMMENT ON TABLE public.acct_period_totals IS
  'Per-account, per-month debit/credit totals for LOCKED periods only. A row '
  'is only written for a month at or before the company lock_date, which the '
  'acct_je_period_lock / acct_jl_period_lock triggers make immutable -- so '
  'these totals CANNOT go stale, rather than being kept fresh by invalidation.';

ALTER TABLE public.acct_period_totals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS acct_period_totals_staff ON public.acct_period_totals;
CREATE POLICY acct_period_totals_staff ON public.acct_period_totals
  FOR ALL
  USING (company_id IN (SELECT get_staff_company_ids()))
  WITH CHECK (company_id IN (SELECT get_staff_company_ids()));

-- Rebuild a company's frozen totals. Safe to run at any time: it only ever
-- writes months at or before the current lock_date, and clears anything
-- beyond it -- which is how an UNLOCK drops totals that are live again.
--
-- current_user is read here deliberately and safely. The repo's rule is
-- "never use current_user for caller identity inside a SECURITY DEFINER
-- function", because there it is the function's OWNER. This function is
-- SECURITY INVOKER, so current_user IS the caller -- the documented case
-- where reading it is correct. Under PostgREST an INVOKER function sees
-- 'authenticated' for a browser request and 'service_role' for the service
-- key, and a job that closes a period is exactly the caller that must be
-- able to rebuild afterwards.
CREATE OR REPLACE FUNCTION public.acct_rebuild_period_totals(p_company_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_lock date;
  v_rows integer;
BEGIN
  IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin')
     AND p_company_id NOT IN (SELECT get_staff_company_ids()) THEN
    RAISE EXCEPTION 'Not permitted for company %', p_company_id USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT lock_date INTO v_lock FROM accounting_period_lock WHERE company_id = p_company_id;

  DELETE FROM acct_period_totals
  WHERE company_id = p_company_id
    AND (v_lock IS NULL OR period_month > date_trunc('month', v_lock)::date);

  IF v_lock IS NULL THEN
    RETURN 0;
  END IF;

  -- Only WHOLE months that end at or before the lock date are frozen. A
  -- partially-locked month (lock set mid-month) still has live days in it,
  -- so caching it would cache a moving figure.
  INSERT INTO acct_period_totals (company_id, account_id, period_month, class_id, debit, credit)
  SELECT jl.company_id,
         jl.account_id,
         date_trunc('month', je.date)::date,
         COALESCE(jl.class_id, ''),
         SUM(jl.debit),
         SUM(jl.credit)
  FROM acct_journal_lines jl
  JOIN acct_journal_entries je ON je.id = jl.journal_entry_id
  WHERE jl.company_id = p_company_id
    AND je.company_id = p_company_id
    AND je.status = 'posted'
    AND (date_trunc('month', je.date) + interval '1 month - 1 day')::date <= v_lock
  GROUP BY jl.company_id, jl.account_id, date_trunc('month', je.date)::date, COALESCE(jl.class_id, '')
  ON CONFLICT (company_id, account_id, period_month, class_id)
  DO UPDATE SET debit = EXCLUDED.debit, credit = EXCLUDED.credit, computed_at = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$function$;

-- Changing the lock is the ONLY thing that changes which months are frozen,
-- so it is the only thing that has to touch the cache. Everything else is
-- prevented from changing a frozen month by the triggers above.
CREATE OR REPLACE FUNCTION public.trg_acct_period_lock_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Drop everything for the company; the next rebuild refills whatever is
  -- still frozen. Cheaper to reason about than working out which months
  -- crossed the boundary, and it fails safe: the worst case is a live
  -- aggregation, which is what happens today anyway.
  DELETE FROM acct_period_totals WHERE company_id = COALESCE(NEW.company_id, OLD.company_id);
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS acct_period_lock_changed ON public.accounting_period_lock;
CREATE TRIGGER acct_period_lock_changed
  AFTER INSERT OR UPDATE OR DELETE ON public.accounting_period_lock
  FOR EACH ROW EXECUTE FUNCTION public.trg_acct_period_lock_changed();

REVOKE ALL ON FUNCTION public.acct_rebuild_period_totals(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acct_rebuild_period_totals(text) TO authenticated, service_role;
