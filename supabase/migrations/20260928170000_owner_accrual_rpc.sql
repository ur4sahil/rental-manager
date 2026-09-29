-- Owner accruals: one SQL allocation, kept in step with every receipt, charge
-- and void; ownership history; statement support. (TEST first; production
-- only with explicit approval.)
--
-- Why: the per-receipt JavaScript accrual (ownerRules.runOwnerDistribution-
-- Accrual) was broken by adversarial QA in several ways -- keyed on the
-- receipt's calendar month (late payers, prepayers, payment before the
-- charge, month-end payments lost), no lock (two tabs / app + Stripe over-
-- accrued), names in references (collisions), voids left accruals live, and
-- "rent" was a reference prefix. A second QA round then found: a tenant who
-- moved re-owned all history (H5), a mistaken first owner kept backdated rent
-- (H1), a locked period double-accrued (L2), office assistants could edit
-- owner_accrual_since and distribution dates/links, archived properties
-- stopped syncing (H6), a deadlock with undo_bank_transaction, 2,000-line
-- inserts were slow (row trigger per line), and a lock-wait failure was
-- silent. This file is the complete, final form.
--
-- ═══ THE ALLOCATION: _owner_accrual_sync_core(company, tenant) ══════════
-- One transaction, under a per-tenant advisory lock.
--   1. Every posted entry touching the tenant's own AR, oldest first (date,
--      created_at, id). CASH entries (a cash-like ASSET leg that is not AR:
--      bank, Stripe receivable): the part of the AR debit that bills income
--      is a charge; the rest of the AR movement is money in (a receipt) or
--      out (refund / NSF / Stripe refund or dispute reversal). NON-CASH
--      entries: a net AR debit is a charge; a net AR credit (credit note,
--      write-off, SECURITY DEPOSIT APPLIED) settles charges without cash.
--      Voided entries are ignored, so a voided receipt simply stops counting.
--   2. RENT part of a charge = least(charge, net credit to a rent-income
--      account: owner_is_rent_income_account -- code 4000 / 4000-xx or an
--      account named "Rental Income"/"Rent Income"). Deposits, late fees and
--      other charges are the non-rent part: they consume money, never accrue.
--   3. Each charge belongs to the PROPERTY ON ITS OWN ENTRY (the class of its
--      AR line, else the entry's property text; the tenant's current property
--      only for a legacy charge that names neither) -- a tenant who moves
--      does not take history with them. Its OWNER is whoever owned that
--      property on the charge date (property_owner_history); a charge dated
--      before the property's first link belongs to whoever owned it when the
--      charge was POSTED (history created_at / closed_at).
--      Only charges POSTED after the property's first owner link accrue
--      (created_at >= properties.owner_accrual_since): linking never accrues
--      the past.
--   4. ALLOCATION, oldest-first: refunds take back the most recent cash
--      receipts (LIFO); then credits pay charges in date order (FIFO), any
--      month, rent part first. Money left over waits for the next charge, so
--      rent charged onto a credit balance accrues when the charge posts. Only
--      CASH paying the RENT part accrues. Rent settled by applying the
--      security deposit at move-out is NOT collected (owner decision
--      2026-09-29): it settles the charge but never accrues.
--   5. RECONCILE per (receipt entry, charge entry) pair against the live
--      accrual rows: equal -> kept (an accrual's owner is NEVER re-stamped by
--      a sync; only correct_property_owner re-stamps). Different -> unlocked
--      rows are voided; rows inside a LOCKED period stay (they count as
--      covering their charge) and, if they no longer match, are reversed by an
--      exact negative accrual dated the day after the lock; then the new
--      amount is posted (dated after the lock if needed). So a period lock
--      never causes a second accrual (L2).
--   Posting: DR the rent account / CR 4200 fee / CR 2200 net; an
--   owner_distributions 'accrual' row with owner_id (the owner then),
--   property_id, tenant_id, receipt_je_id, charge_je_id, charge_month,
--   rent_amount; reference ODIST-<tenant id>-<receipt entry>-<charge entry>
--   (no names). Fee = owner's management_fee_pct (NULL = 0, clamped 0..100).
--   Archived owners get no NEW accruals; existing ones are still reconciled.
--   Archived properties keep syncing (voids / reversals) (H6).
--   New rows are written in a handful of set-based statements per tenant.
--
-- ═══ KEEPING IT IN STEP: queue + one deferred runner ════════════════════
-- Statement-level triggers (transition tables) on acct_journal_lines INSERT /
-- UPDATE and acct_journal_entries UPDATE (status) put each affected tenant
-- ONCE per transaction into owner_accrual_queue (only in companies that have
-- ever linked an owner). A deferred constraint trigger on the queue runs at
-- commit: the first firing syncs every queued tenant of the transaction in a
-- fixed (company, tenant) order -- so two transactions never take tenant
-- locks in opposite orders -- with lock_timeout 3s per tenant. A failure (a
-- lock-wait timeout included) never blocks the write: the queue row stays as
-- a NEEDS_SYNC marker, an error_log row is written, and the next sync of that
-- tenant, owner_accrual_sync_pending() (Owners page + nightly integrity
-- cron) picks it up.
-- Deadlock with undo_bank_transaction (which holds FOR UPDATE on the receipt
-- entry while it waits for the tenant lock at commit): receipt_je_id /
-- charge_je_id carry NO foreign key, so posting an accrual never takes a key
-- lock on the receipt entry; existence is checked by the allocation itself.
--
-- ═══ OWNERSHIP HISTORY: property_owner_history ═══════════════════════════
-- (property_id, owner_id, from_date inclusive, to_date exclusive; NULL
-- to_date = current; NULL from_date = from the start). Written by trigger
-- whenever properties.owner_id changes; dates are America/New_York. The FIRST
-- row starts at the link date (not "from the start"). correct_property_owner
-- (manager tier) rewrites a range when the wrong owner was picked and re-
-- stamps that property's accruals (void + re-post, or reverse after a lock).
--
-- Also: owner_accrual_since is writable only by its trigger or the management
-- tier; the management-tier gate covers every owner_distributions column but
-- notes on UPDATE, and DELETE; hand-entered accruals are refused; kind is
-- immutable; owners.management_fee_pct CHECK 0..100.
-- New SECURITY DEFINER functions: REVOKE ALL FROM PUBLIC, anon (and
-- authenticated where only triggers / service use them).

-- ── owner_distributions columns ───────────────────────────────────────────
ALTER TABLE public.owner_distributions
  ADD COLUMN IF NOT EXISTS tenant_id integer REFERENCES public.tenants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS receipt_je_id text,
  ADD COLUMN IF NOT EXISTS charge_je_id text,
  ADD COLUMN IF NOT EXISTS charge_month date,
  ADD COLUMN IF NOT EXISTS rent_amount numeric,
  ADD COLUMN IF NOT EXISTS property_id integer REFERENCES public.properties(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reverses_id uuid REFERENCES public.owner_distributions(id) ON DELETE SET NULL;
-- No FK on the entry links (see "Deadlock" above).
ALTER TABLE public.owner_distributions DROP CONSTRAINT IF EXISTS owner_distributions_receipt_je_id_fkey;
ALTER TABLE public.owner_distributions DROP CONSTRAINT IF EXISTS owner_distributions_charge_je_id_fkey;
CREATE INDEX IF NOT EXISTS idx_owner_distributions_tenant_accrual
  ON public.owner_distributions (company_id, tenant_id) WHERE kind = 'accrual';

-- ── properties.owner_accrual_since: set once by trigger, guarded ──────────
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS owner_accrual_since timestamptz;
UPDATE public.properties SET owner_accrual_since = now()
 WHERE owner_id IS NOT NULL AND owner_accrual_since IS NULL;

DROP TRIGGER IF EXISTS trg_properties_owner_accrual_since ON public.properties;
CREATE OR REPLACE FUNCTION public.properties_owner_accrual_since()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public','pg_temp' AS $$
BEGIN
  -- Only the trigger below or the management tier may move it: an earlier
  -- value makes old rent accrue, NULL stops new accruals.
  IF TG_OP = 'UPDATE' AND NEW.owner_accrual_since IS DISTINCT FROM OLD.owner_accrual_since
     AND current_user = 'authenticated' AND NOT public.is_management_tier(NEW.company_id) THEN
    RAISE EXCEPTION 'Your role cannot change when a property''s owner accruals start — only a manager, owner, or admin can.'
      USING ERRCODE = '42501';
  END IF;
  -- The first time the property ever gets an owner. Never reset.
  IF NEW.owner_id IS NOT NULL AND NEW.owner_accrual_since IS NULL
     AND (TG_OP = 'INSERT' OR OLD.owner_accrual_since IS NULL) THEN
    NEW.owner_accrual_since := now();
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.properties_owner_accrual_since() FROM PUBLIC, anon;
CREATE TRIGGER trg_properties_owner_accrual_since BEFORE INSERT OR UPDATE ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.properties_owner_accrual_since();

-- ── ownership history ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.property_owner_history (
  id          bigserial PRIMARY KEY,
  company_id  text NOT NULL,
  property_id integer NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  owner_id    uuid NOT NULL REFERENCES public.owners(id) ON DELETE CASCADE,
  from_date   date,          -- inclusive; NULL = from the start (only via correct_property_owner)
  to_date     date,          -- exclusive; NULL = current
  created_at  timestamptz NOT NULL DEFAULT now(),   -- when this owner was linked
  closed_at   timestamptz                            -- when the link ended (NULL = current)
);
ALTER TABLE public.property_owner_history ADD COLUMN IF NOT EXISTS closed_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_property_owner_history_prop ON public.property_owner_history (property_id, from_date);
CREATE INDEX IF NOT EXISTS idx_property_owner_history_owner ON public.property_owner_history (company_id, owner_id);
ALTER TABLE public.property_owner_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.property_owner_history FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.property_owner_history TO authenticated;
GRANT ALL ON TABLE public.property_owner_history TO service_role;
GRANT USAGE ON SEQUENCE public.property_owner_history_id_seq TO service_role;
DROP POLICY IF EXISTS property_owner_history_staff ON public.property_owner_history;
CREATE POLICY property_owner_history_staff ON public.property_owner_history FOR SELECT USING (is_company_staff(company_id));
DROP POLICY IF EXISTS property_owner_history_self ON public.property_owner_history;
CREATE POLICY property_owner_history_self ON public.property_owner_history FOR SELECT USING (owner_id = get_owner_id(company_id));
-- (no write policies: only the trigger / correct_property_owner write it)

-- Backfill: today's links start today (link time unknown -> never retroactive).
INSERT INTO public.property_owner_history (company_id, property_id, owner_id, from_date, to_date)
SELECT p.company_id, p.id, p.owner_id, (now() AT TIME ZONE 'America/New_York')::date, NULL FROM public.properties p
 WHERE p.owner_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.property_owner_history h WHERE h.property_id = p.id);
-- Rows written by an earlier draft of this file started "from the start".
UPDATE public.property_owner_history SET from_date = (created_at AT TIME ZONE 'America/New_York')::date
 WHERE from_date IS NULL;
UPDATE public.property_owner_history SET closed_at = now() WHERE to_date IS NOT NULL AND closed_at IS NULL;

CREATE OR REPLACE FUNCTION public.properties_owner_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v_today date := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  IF coalesce(current_setting('owner_history.skip', true), '') = 'on' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.owner_id IS NOT NULL THEN
    UPDATE property_owner_history SET to_date = v_today, closed_at = now()
     WHERE property_id = NEW.id AND to_date IS NULL;
  END IF;
  IF NEW.owner_id IS NOT NULL THEN
    INSERT INTO property_owner_history (company_id, property_id, owner_id, from_date, to_date)
    VALUES (NEW.company_id, NEW.id, NEW.owner_id, v_today, NULL);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.properties_owner_history() FROM PUBLIC, anon;
DROP TRIGGER IF EXISTS trg_properties_owner_history ON public.properties;
CREATE TRIGGER trg_properties_owner_history AFTER INSERT OR UPDATE OF owner_id ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.properties_owner_history();

-- The owner of a property on a date (half-open ranges; the latest start wins).
CREATE OR REPLACE FUNCTION public.property_owner_on(p_property_id integer, p_date date)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
  SELECT owner_id FROM property_owner_history
   WHERE property_id = p_property_id
     AND (from_date IS NULL OR from_date <= p_date)
     AND (to_date IS NULL OR p_date < to_date)
   ORDER BY from_date DESC NULLS LAST, id DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.property_owner_on(integer, date) FROM PUBLIC, anon, authenticated;

-- The owner a CHARGE belongs to: whoever owned the property on the charge
-- date. A charge dated BEFORE the property's first link (typically this
-- month's rent, dated the 1st, linked mid-month) belongs to whoever was the
-- owner at the moment the charge was POSTED -- so a same-day mistaken pick
-- corrected before the rent was posted never gets it (H1), and one posted
-- before a same-day reassignment stays with the owner then (never moves).
CREATE OR REPLACE FUNCTION public.owner_for_charge(p_property_id integer, p_date date, p_posted_at timestamptz)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v uuid; v_open boolean; v_min date;
BEGIN
  v := public.property_owner_on(p_property_id, p_date);
  IF v IS NOT NULL THEN RETURN v; END IF;
  SELECT bool_or(from_date IS NULL), min(from_date) INTO v_open, v_min
    FROM property_owner_history WHERE property_id = p_property_id;
  -- after the first link with no owner that day (unlinked): nobody
  IF v_open OR v_min IS NULL OR p_date >= v_min THEN RETURN NULL; END IF;
  SELECT owner_id INTO v FROM property_owner_history
   WHERE property_id = p_property_id AND created_at <= p_posted_at
     AND (closed_at IS NULL OR closed_at > p_posted_at)
   ORDER BY created_at DESC, id DESC LIMIT 1;
  RETURN v;
END $$;
DROP FUNCTION IF EXISTS public.owner_for_charge(integer, date);
REVOKE ALL ON FUNCTION public.owner_for_charge(integer, date, timestamptz) FROM PUBLIC, anon, authenticated;

-- ── fee check ─────────────────────────────────────────────────────────────
ALTER TABLE public.owners DROP CONSTRAINT IF EXISTS owners_management_fee_pct_range;
ALTER TABLE public.owners ADD CONSTRAINT owners_management_fee_pct_range
  CHECK (management_fee_pct IS NULL OR (management_fee_pct >= 0 AND management_fee_pct <= 100));

-- ── rent-income account rule (same as ownerRules.isRentIncomeAccount) ─────
CREATE OR REPLACE FUNCTION public.owner_is_rent_income_account(p_code text, p_name text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path TO 'public','pg_temp' AS $$
  SELECT btrim(coalesce(p_code, '')) = '4000'
      OR btrim(coalesce(p_code, '')) ~ '^4000[-.]'
      OR coalesce(p_name, '') ~* '\mrent(al)?\s+income\M';
$$;

-- An account-by-code lookup that creates the standard account when missing
-- (mirrors resolveAccountId in the browser).
CREATE OR REPLACE FUNCTION public._owner_accrual_account(p_company_id text, p_code text, p_name text, p_type text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v uuid;
BEGIN
  SELECT id INTO v FROM acct_accounts WHERE company_id = p_company_id AND code = p_code
   ORDER BY is_active DESC NULLS LAST, id LIMIT 1;
  IF v IS NULL THEN
    INSERT INTO acct_accounts (company_id, code, name, type, is_active, old_text_id)
    VALUES (p_company_id, p_code, p_name, p_type, true, p_company_id || '-' || p_code)
    RETURNING id INTO v;
  END IF;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public._owner_accrual_account(text, text, text, text) FROM PUBLIC, anon, authenticated;

-- ── queue (NEEDS_SYNC markers live here too) ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.owner_accrual_queue (
  company_id  text    NOT NULL,
  tenant_id   integer NOT NULL,
  txid        bigint  NOT NULL DEFAULT txid_current(),
  needs_sync  boolean NOT NULL DEFAULT false,
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, tenant_id, txid)
);
CREATE INDEX IF NOT EXISTS idx_owner_accrual_queue_pending ON public.owner_accrual_queue (company_id, tenant_id) WHERE needs_sync;
ALTER TABLE public.owner_accrual_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.owner_accrual_queue FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.owner_accrual_queue TO service_role;
DROP POLICY IF EXISTS owner_accrual_queue_staff ON public.owner_accrual_queue;
CREATE POLICY owner_accrual_queue_staff ON public.owner_accrual_queue FOR SELECT USING (is_company_staff(company_id));
GRANT SELECT ON TABLE public.owner_accrual_queue TO authenticated;

-- ── the allocation ────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public._owner_accrual_sync_quiet(text, integer);
CREATE OR REPLACE FUNCTION public._owner_accrual_sync_core(p_company_id text, p_tenant_id integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE
  v_tenant   tenants%ROWTYPE;
  v_owner    owners%ROWTYPE;
  v_ar       uuid[];
  v_lock     date;
  v_restamp  text := coalesce(current_setting('owner_accrual.restamp_property', true), '');
  v_cur_prop integer;
  v_prop     integer;
  r          record;
  k int; i int; j int; x int;
  -- property cache: id, class, address, since, class id, archived owner flag
  pc_id integer[] := '{}'; pc_class text[] := '{}'; pc_addr text[] := '{}'; pc_since timestamptz[] := '{}';
  -- charges
  ch_id text[] := '{}'; ch_date date[] := '{}'; ch_rent bigint[] := '{}'; ch_other bigint[] := '{}';
  ch_acct uuid[] := '{}'; ch_ok boolean[] := '{}'; ch_owner uuid[] := '{}'; ch_prop integer[] := '{}';
  -- credits (cash receipts net of refunds; non-cash credits)
  cr_id text[] := '{}'; cr_date date[] := '{}'; cr_rem bigint[] := '{}'; cr_cash boolean[] := '{}';
  -- desired accruals, one per (receipt, charge) pair
  d_rc text[] := '{}'; d_ch text[] := '{}'; d_amt bigint[] := '{}'; d_date date[] := '{}'; d_month date[] := '{}';
  d_acct uuid[] := '{}'; d_owner uuid[] := '{}'; d_prop integer[] := '{}';
  -- existing live accrual rows
  e_id uuid[] := '{}'; e_rc text[] := '{}'; e_ch text[] := '{}'; e_rent bigint[] := '{}'; e_net bigint[] := '{}';
  e_owner uuid[] := '{}'; e_rev uuid[] := '{}'; e_ref text[] := '{}'; e_je text[] := '{}'; e_locked boolean[] := '{}';
  e_prop integer[] := '{}'; e_done boolean[] := '{}';
  -- to void / to post
  v_void_ids uuid[] := '{}'; v_void_refs text[] := '{}';
  p_ref text[] := '{}'; p_date date[] := '{}'; p_rent bigint[] := '{}'; p_fee bigint[] := '{}'; p_net bigint[] := '{}';
  p_owner uuid[] := '{}'; p_rc text[] := '{}'; p_ch text[] := '{}'; p_month date[] := '{}'; p_acct uuid[] := '{}';
  p_prop integer[] := '{}'; p_rev uuid[] := '{}'; p_desc text[] := '{}'; p_notes text[] := '{}';
  take bigint; neg bigint; amt bigint; chg bigint; rent_part bigint; income_net bigint;
  v_d bigint; v_net_e bigint; v_lnet bigint; v_owner_ok boolean; v_lowner_ok boolean;
  v_pct numeric; v_fee bigint; v_rent_acct uuid; v_base_ref text; v_ref text; v_n int; v_dt date;
  v_pairs_rc text[] := '{}'; v_pairs_ch text[] := '{}';
  v_je_base bigint; v_try int; v_ok boolean;
  a4000 uuid; a4200 uuid; a2200 uuid;
  v_addr text; v_class text;
  v_kept int := 0; v_voided int := 0; v_posted int := 0;
  v_live_refs text[] := '{}';
BEGIN
  IF p_company_id IS NULL OR p_tenant_id IS NULL THEN RETURN jsonb_build_object('skipped', 'missing input'); END IF;
  -- One allocation per tenant at a time (app + Stripe + bank + two tabs).
  PERFORM pg_advisory_xact_lock(hashtext('owner_accrual:' || p_company_id), p_tenant_id);
  -- This run brings the tenant up to date: clear any NEEDS_SYNC marker (a
  -- failure below rolls this back with the rest, so the marker survives).
  DELETE FROM owner_accrual_queue WHERE company_id = p_company_id AND tenant_id = p_tenant_id AND needs_sync;

  SELECT * INTO v_tenant FROM tenants WHERE company_id = p_company_id AND id = p_tenant_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('skipped', 'no tenant'); END IF;
  SELECT array_agg(id) INTO v_ar FROM acct_accounts WHERE company_id = p_company_id AND tenant_id = p_tenant_id;
  IF v_ar IS NULL THEN RETURN jsonb_build_object('skipped', 'tenant has no AR account'); END IF;
  SELECT id INTO v_cur_prop FROM properties WHERE company_id = p_company_id AND address = v_tenant.property
   ORDER BY (archived_at IS NULL) DESC, id DESC LIMIT 1;
  SELECT lock_date INTO v_lock FROM accounting_period_lock WHERE company_id = p_company_id;

  -- 1 + 2 + 3: every posted entry on the tenant's AR, oldest first.
  FOR r IN
    WITH ar_jes AS (
      SELECT DISTINCT l.journal_entry_id AS id FROM acct_journal_lines l
       WHERE l.company_id = p_company_id AND l.account_id = ANY (v_ar)
    ), lines AS (
      SELECT j.id, j.date, j.created_at, j.property AS je_property, l.account_id, l.class_id,
             coalesce(l.debit, 0) AS dr, coalesce(l.credit, 0) AS cr,
             (l.account_id = ANY (v_ar)) AS mine,
             coalesce(a.tenant_id IS NOT NULL OR btrim(coalesce(a.code, '')) = '1100' OR btrim(coalesce(a.code, '')) ~ '^1100[-.]', false) AS ar_like,
             coalesce(a.type = 'Asset', false) AS is_asset,
             coalesce(lower(a.type) IN ('revenue', 'income', 'other income'), false) AS is_income,
             (a.id IS NOT NULL AND public.owner_is_rent_income_account(a.code, a.name)) AS is_rent
        FROM acct_journal_entries j
        JOIN ar_jes x ON x.id = j.id
        JOIN acct_journal_lines l ON l.journal_entry_id = j.id
        LEFT JOIN acct_accounts a ON a.id = l.account_id
       WHERE j.company_id = p_company_id AND j.status = 'posted'
         AND coalesce(j.reference, '') NOT LIKE 'ODIST-%'
    )
    SELECT id, date, created_at, max(je_property) AS je_property,
           (array_agg(class_id ORDER BY dr DESC) FILTER (WHERE mine AND dr > 0 AND class_id IS NOT NULL))[1] AS ar_class,
           coalesce(sum(dr) FILTER (WHERE mine), 0) AS ar_dr,
           coalesce(sum(cr) FILTER (WHERE mine), 0) AS ar_cr,
           coalesce(sum(cr - dr) FILTER (WHERE is_rent), 0) AS rent_net,
           coalesce(sum(cr - dr) FILTER (WHERE is_income), 0) AS income_net,
           (array_agg(account_id ORDER BY cr DESC) FILTER (WHERE is_rent AND cr > 0))[1] AS rent_acct,
           coalesce(bool_or(NOT ar_like AND is_asset), false) AS has_cash
      FROM lines GROUP BY id, date, created_at
     ORDER BY date, created_at, id
  LOOP
    IF r.has_cash THEN
      income_net := greatest(round(r.income_net * 100)::bigint, 0);
      chg := least(round(r.ar_dr * 100)::bigint, income_net);
      amt := round(r.ar_cr * 100)::bigint - (round(r.ar_dr * 100)::bigint - chg);
    ELSE
      chg := greatest(round((r.ar_dr - r.ar_cr) * 100)::bigint, 0);
      amt := -least(round((r.ar_dr - r.ar_cr) * 100)::bigint, 0);
    END IF;
    IF chg > 0 THEN
      rent_part := least(chg, greatest(round(r.rent_net * 100)::bigint, 0));
      -- the property on the charge's own entry (cached)
      v_prop := NULL; x := NULL;
      IF r.ar_class IS NOT NULL THEN
        x := array_position(pc_class, r.ar_class);
        IF x IS NULL THEN
          SELECT id INTO v_prop FROM properties WHERE company_id = p_company_id AND class_id = r.ar_class
           ORDER BY (archived_at IS NULL) DESC, id DESC LIMIT 1;
        ELSE v_prop := pc_id[x]; END IF;
      END IF;
      IF v_prop IS NULL AND coalesce(r.je_property, '') <> '' THEN
        x := array_position(pc_addr, r.je_property);
        IF x IS NULL THEN
          SELECT id INTO v_prop FROM properties WHERE company_id = p_company_id AND address = r.je_property
           ORDER BY (archived_at IS NULL) DESC, id DESC LIMIT 1;
        ELSE v_prop := pc_id[x]; END IF;
      END IF;
      IF v_prop IS NULL THEN v_prop := v_cur_prop; END IF;
      x := CASE WHEN v_prop IS NULL THEN NULL ELSE array_position(pc_id, v_prop) END;
      IF v_prop IS NOT NULL AND x IS NULL THEN
        pc_id := pc_id || v_prop;
        SELECT class_id, address INTO v_class, v_addr FROM properties WHERE id = v_prop;
        pc_class := pc_class || v_class; pc_addr := pc_addr || v_addr;
        pc_since := pc_since || (SELECT owner_accrual_since FROM properties WHERE id = v_prop);
        x := array_length(pc_id, 1);
      END IF;
      ch_id := ch_id || r.id; ch_date := ch_date || r.date; ch_acct := ch_acct || r.rent_acct;
      ch_rent := ch_rent || rent_part; ch_other := ch_other || (chg - rent_part);
      ch_prop := ch_prop || v_prop;
      IF rent_part > 0 AND v_prop IS NOT NULL THEN
        ch_owner := ch_owner || public.owner_for_charge(v_prop, r.date, r.created_at);
        ch_ok := ch_ok || (pc_since[x] IS NOT NULL AND r.created_at >= pc_since[x]);
      ELSE
        ch_owner := ch_owner || NULL::uuid; ch_ok := ch_ok || false;
      END IF;
    END IF;
    IF r.has_cash THEN
      IF amt > 0 THEN
        cr_id := cr_id || r.id; cr_date := cr_date || r.date; cr_rem := cr_rem || amt; cr_cash := cr_cash || true;
      ELSIF amt < 0 THEN
        neg := -amt; k := coalesce(array_length(cr_rem, 1), 0);
        WHILE neg > 0 AND k >= 1 LOOP
          IF cr_cash[k] THEN
            take := least(neg, cr_rem[k]); cr_rem[k] := cr_rem[k] - take; neg := neg - take;
          END IF;
          k := k - 1;
        END LOOP;
      END IF;
    ELSIF amt > 0 THEN
      cr_id := cr_id || r.id; cr_date := cr_date || r.date; cr_rem := cr_rem || amt; cr_cash := cr_cash || false;
    END IF;
  END LOOP;

  -- 4: credits against charges, oldest first; rent part first.
  i := 1; j := 1;
  WHILE i <= coalesce(array_length(ch_id, 1), 0) AND j <= coalesce(array_length(cr_id, 1), 0) LOOP
    IF cr_rem[j] <= 0 THEN j := j + 1; CONTINUE; END IF;
    IF ch_rent[i] > 0 THEN
      take := least(ch_rent[i], cr_rem[j]);
      IF ch_ok[i] AND cr_cash[j] AND ch_owner[i] IS NOT NULL THEN
        d_rc := d_rc || cr_id[j]; d_ch := d_ch || ch_id[i]; d_amt := d_amt || take;
        d_date := d_date || greatest(ch_date[i], cr_date[j]);
        d_month := d_month || date_trunc('month', ch_date[i])::date;
        d_acct := d_acct || ch_acct[i]; d_owner := d_owner || ch_owner[i]; d_prop := d_prop || ch_prop[i];
      END IF;
      ch_rent[i] := ch_rent[i] - take; cr_rem[j] := cr_rem[j] - take;
    ELSIF ch_other[i] > 0 THEN
      take := least(ch_other[i], cr_rem[j]);
      ch_other[i] := ch_other[i] - take; cr_rem[j] := cr_rem[j] - take;
    ELSE
      i := i + 1;
    END IF;
  END LOOP;

  -- 5: existing live accrual rows of this tenant.
  FOR r IN
    SELECT d.id, d.receipt_je_id, d.charge_je_id, round(coalesce(d.rent_amount, 0) * 100)::bigint AS rent,
           round(coalesce(d.amount, 0) * 100)::bigint AS net, d.owner_id, d.reverses_id, d.reference, d.property_id,
           je.id AS je_id, je.date AS je_date
      FROM owner_distributions d
      LEFT JOIN acct_journal_entries je
        ON je.company_id = d.company_id AND je.reference = d.reference AND je.status <> 'voided'
     WHERE d.company_id = p_company_id AND d.tenant_id = p_tenant_id
       AND d.kind = 'accrual' AND d.voided_at IS NULL
     ORDER BY d.created_at, d.id
  LOOP
    e_id := e_id || r.id; e_rc := e_rc || r.receipt_je_id; e_ch := e_ch || r.charge_je_id;
    e_rent := e_rent || r.rent; e_net := e_net || r.net; e_owner := e_owner || r.owner_id;
    e_rev := e_rev || r.reverses_id; e_ref := e_ref || r.reference; e_je := e_je || r.je_id;
    e_locked := e_locked || (v_lock IS NOT NULL AND r.je_date IS NOT NULL AND r.je_date <= v_lock);
    e_prop := e_prop || r.property_id; e_done := e_done || false;
    IF r.je_id IS NOT NULL THEN v_live_refs := v_live_refs || r.reference; END IF;
  END LOOP;

  -- the pairs: desired ones, then existing ones not desired
  FOR k IN 1 .. coalesce(array_length(d_rc, 1), 0) LOOP
    v_pairs_rc := v_pairs_rc || d_rc[k]; v_pairs_ch := v_pairs_ch || d_ch[k];
  END LOOP;
  FOR k IN 1 .. coalesce(array_length(e_id, 1), 0) LOOP
    v_ok := false;
    FOR i IN 1 .. coalesce(array_length(v_pairs_rc, 1), 0) LOOP
      IF v_pairs_rc[i] IS NOT DISTINCT FROM e_rc[k] AND v_pairs_ch[i] IS NOT DISTINCT FROM e_ch[k] THEN v_ok := true; EXIT; END IF;
    END LOOP;
    IF NOT v_ok THEN v_pairs_rc := v_pairs_rc || e_rc[k]; v_pairs_ch := v_pairs_ch || e_ch[k]; END IF;
  END LOOP;

  FOR i IN 1 .. coalesce(array_length(v_pairs_rc, 1), 0) LOOP
    -- desired
    x := NULL; v_d := 0;
    FOR k IN 1 .. coalesce(array_length(d_rc, 1), 0) LOOP
      IF d_rc[k] = v_pairs_rc[i] AND d_ch[k] = v_pairs_ch[i] THEN x := k; v_d := d_amt[k]; EXIT; END IF;
    END LOOP;
    -- existing
    v_net_e := 0; v_owner_ok := true;
    FOR k IN 1 .. coalesce(array_length(e_id, 1), 0) LOOP
      IF e_rc[k] IS NOT DISTINCT FROM v_pairs_rc[i] AND e_ch[k] IS NOT DISTINCT FROM v_pairs_ch[i] THEN
        v_net_e := v_net_e + e_rent[k];
        IF x IS NOT NULL AND e_rent[k] > 0 AND e_owner[k] IS DISTINCT FROM d_owner[x]
           AND v_restamp <> '' AND v_restamp = coalesce(d_prop[x]::text, '') THEN
          v_owner_ok := false;   -- correct_property_owner: re-stamp this pair
        END IF;
      END IF;
    END LOOP;
    IF v_net_e = v_d AND v_owner_ok THEN v_kept := v_kept + 1; CONTINUE; END IF;

    -- void the unlocked rows of the pair; keep the locked ones
    v_lnet := 0; v_lowner_ok := true;
    FOR k IN 1 .. coalesce(array_length(e_id, 1), 0) LOOP
      IF e_rc[k] IS NOT DISTINCT FROM v_pairs_rc[i] AND e_ch[k] IS NOT DISTINCT FROM v_pairs_ch[i] THEN
        IF e_locked[k] THEN
          v_lnet := v_lnet + e_rent[k];
          IF x IS NOT NULL AND e_rent[k] > 0 AND e_owner[k] IS DISTINCT FROM d_owner[x]
             AND v_restamp <> '' AND v_restamp = coalesce(d_prop[x]::text, '') THEN v_lowner_ok := false; END IF;
        ELSE
          v_void_ids := v_void_ids || e_id[k]; v_void_refs := v_void_refs || e_ref[k]; v_voided := v_voided + 1;
          e_done[k] := true;
        END IF;
      END IF;
    END LOOP;
    IF v_lnet = v_d AND v_lowner_ok AND (v_lnet <> 0 OR v_d = 0) THEN CONTINUE; END IF;

    -- locked rows that no longer match: exact reversal dated after the lock
    IF v_lnet <> 0 OR NOT v_lowner_ok THEN
      FOR k IN 1 .. coalesce(array_length(e_id, 1), 0) LOOP
        CONTINUE WHEN e_done[k] OR NOT e_locked[k] OR e_rent[k] <= 0;
        CONTINUE WHEN NOT (e_rc[k] IS NOT DISTINCT FROM v_pairs_rc[i] AND e_ch[k] IS NOT DISTINCT FROM v_pairs_ch[i]);
        -- already reversed by a locked reversal row?
        v_ok := false;
        FOR j IN 1 .. coalesce(array_length(e_id, 1), 0) LOOP
          IF e_rev[j] = e_id[k] AND e_locked[j] THEN v_ok := true; EXIT; END IF;
        END LOOP;
        CONTINUE WHEN v_ok;
        SELECT l.account_id INTO v_rent_acct FROM acct_journal_lines l WHERE l.journal_entry_id = e_je[k] AND coalesce(l.debit, 0) > 0 LIMIT 1;
        IF v_rent_acct IS NULL THEN
          IF a4000 IS NULL THEN a4000 := public._owner_accrual_account(p_company_id, '4000', 'Rental Income', 'Revenue'); END IF;
          v_rent_acct := a4000;
        END IF;
        p_ref := p_ref || ('ODIST-' || p_tenant_id || '-R-' || e_id[k]::text);
        p_date := p_date || (v_lock + 1); p_rent := p_rent || (-e_rent[k]); p_net := p_net || (-e_net[k]);
        p_fee := p_fee || (-(e_rent[k] - e_net[k])); p_owner := p_owner || e_owner[k];
        p_rc := p_rc || e_rc[k]; p_ch := p_ch || e_ch[k];
        p_month := p_month || (SELECT charge_month FROM owner_distributions WHERE id = e_id[k]);
        p_acct := p_acct || v_rent_acct; p_prop := p_prop || e_prop[k]; p_rev := p_rev || e_id[k];
        p_desc := p_desc || ('Owner accrual reversal (after period lock) — ' || v_tenant.name);
        p_notes := p_notes || ('Reverses an accrual inside the locked period: receipt or allocation changed after the lock — rent '
                               || to_char(-e_rent[k] / 100.0, 'FM999999990.00'));
      END LOOP;
    END IF;

    -- post the amount now due for the pair
    IF v_d > 0 AND x IS NOT NULL THEN
      SELECT * INTO v_owner FROM owners WHERE id = d_owner[x];
      IF v_owner.id IS NULL OR v_owner.archived_at IS NOT NULL THEN CONTINUE; END IF;   -- archived owners: nothing new
      v_pct := least(greatest(coalesce(v_owner.management_fee_pct, 0), 0), 100);
      v_fee := round(v_d * v_pct / 100)::bigint;
      v_base_ref := 'ODIST-' || p_tenant_id || '-' || d_rc[x] || '-' || d_ch[x];
      v_ref := v_base_ref; v_n := 1;
      -- live ODIST references of this tenant are exactly its live rows' (a
      -- stray one would fail the unique index -> NEEDS_SYNC, never a duplicate)
      WHILE (v_ref = ANY (v_live_refs) AND NOT (v_ref = ANY (v_void_refs))) OR v_ref = ANY (p_ref) LOOP
        v_n := v_n + 1; v_ref := v_base_ref || '-' || v_n;
      END LOOP;
      p_ref := p_ref || v_ref;
      p_date := p_date || CASE WHEN v_lock IS NOT NULL THEN greatest(d_date[x], v_lock + 1) ELSE d_date[x] END;
      p_rent := p_rent || v_d; p_fee := p_fee || v_fee; p_net := p_net || (v_d - v_fee);
      p_owner := p_owner || v_owner.id; p_rc := p_rc || d_rc[x]; p_ch := p_ch || d_ch[x]; p_month := p_month || d_month[x];
      IF d_acct[x] IS NULL THEN
        IF a4000 IS NULL THEN a4000 := public._owner_accrual_account(p_company_id, '4000', 'Rental Income', 'Revenue'); END IF;
        p_acct := p_acct || a4000;
      ELSE p_acct := p_acct || d_acct[x]; END IF;
      p_prop := p_prop || d_prop[x]; p_rev := p_rev || NULL::uuid;
      p_desc := p_desc || ('Owner distribution accrual — ' || v_owner.name || ' — ' || v_tenant.name || ' — rent ' || to_char(d_month[x], 'YYYY-MM'));
      p_notes := p_notes || ('Rent ' || to_char(d_month[x], 'YYYY-MM') || ' from ' || v_tenant.name || ' — rent ' || to_char(v_d / 100.0, 'FM999999990.00')
              || ' · mgmt fee ' || v_pct || '% of rent' || CASE WHEN v_owner.management_fee_pct IS NULL THEN ' (not set)' ELSE '' END
              || ' (' || to_char(v_fee / 100.0, 'FM999999990.00') || ') · net ' || to_char((v_d - v_fee) / 100.0, 'FM999999990.00'));
    END IF;
  END LOOP;

  -- write: voids first (frees references), then posts in set-based statements
  IF array_length(v_void_ids, 1) > 0 THEN
    UPDATE acct_journal_entries SET status = 'voided'
     WHERE company_id = p_company_id AND reference = ANY (v_void_refs) AND status <> 'voided';
    UPDATE owner_distributions SET voided_at = now() WHERE id = ANY (v_void_ids) AND voided_at IS NULL;
  END IF;

  IF array_length(p_ref, 1) > 0 THEN
    a4200 := public._owner_accrual_account(p_company_id, '4200', 'Management Fee Income', 'Revenue');
    a2200 := public._owner_accrual_account(p_company_id, '2200', 'Owner Distributions Payable', 'Liability');
    -- headers: numbered from one MAX, retried on a number race
    v_try := 0; v_ok := false;
    WHILE NOT v_ok AND v_try < 6 LOOP
      v_try := v_try + 1;
      v_je_base := coalesce((SELECT max(CAST(substring(number FROM 'JE-(\d+)$') AS bigint)) FROM acct_journal_entries
                              WHERE company_id = p_company_id AND number ~ '^JE-\d+$'), 0);
      BEGIN
        INSERT INTO acct_journal_entries (company_id, number, date, description, reference, property, status)
        SELECT p_company_id, 'JE-' || lpad((v_je_base + u.ord)::text, 4, '0'), u.dt, u.dsc, u.ref,
               coalesce((SELECT address FROM properties WHERE id = u.prop), v_tenant.property, ''), 'posted'
          FROM unnest(p_ref, p_date, p_desc, p_prop) WITH ORDINALITY AS u(ref, dt, dsc, prop, ord);
        v_ok := true;
      EXCEPTION WHEN unique_violation THEN
        IF v_try >= 6 THEN RAISE; END IF;
        PERFORM pg_sleep(0.02 * v_try);
      END;
    END LOOP;
    -- lines (rent / fee / net; signs follow a reversal)
    INSERT INTO acct_journal_lines (company_id, journal_entry_id, account_id, account_name, debit, credit, class_id, memo)
    SELECT p_company_id, je.id, u.acct, coalesce(a.name, 'Rental Income'),
           greatest(u.rent, 0) / 100.0, greatest(-u.rent, 0) / 100.0,
           (SELECT class_id FROM properties WHERE id = u.prop),
           CASE WHEN u.rent < 0 THEN 'Reverse owner accrual — ' ELSE 'Reclassify rent to owner — ' END || v_tenant.name
      FROM unnest(p_ref, p_acct, p_rent, p_prop) AS u(ref, acct, rent, prop)
      JOIN acct_journal_entries je ON je.company_id = p_company_id AND je.reference = u.ref AND je.status <> 'voided'
      LEFT JOIN acct_accounts a ON a.id = u.acct
    UNION ALL
    SELECT p_company_id, je.id, a4200, 'Management Fee Income', greatest(-u.fee, 0) / 100.0, greatest(u.fee, 0) / 100.0,
           (SELECT class_id FROM properties WHERE id = u.prop), 'Mgmt fee — ' || coalesce(o.name, '')
      FROM unnest(p_ref, p_fee, p_prop, p_owner) AS u(ref, fee, prop, own)
      JOIN acct_journal_entries je ON je.company_id = p_company_id AND je.reference = u.ref AND je.status <> 'voided'
      LEFT JOIN owners o ON o.id = u.own
     WHERE u.fee <> 0
    UNION ALL
    SELECT p_company_id, je.id, a2200, 'Owner Distributions Payable', greatest(-u.net, 0) / 100.0, greatest(u.net, 0) / 100.0,
           (SELECT class_id FROM properties WHERE id = u.prop), 'Net to ' || coalesce(o.name, '')
      FROM unnest(p_ref, p_net, p_prop, p_owner) AS u(ref, net, prop, own)
      JOIN acct_journal_entries je ON je.company_id = p_company_id AND je.reference = u.ref AND je.status <> 'voided'
      LEFT JOIN owners o ON o.id = u.own
     WHERE u.net <> 0;
    -- distribution rows
    INSERT INTO owner_distributions (company_id, owner_id, kind, amount, rent_amount, date, reference, method,
                                     tenant_id, receipt_je_id, charge_je_id, charge_month, property_id, reverses_id, notes)
    SELECT p_company_id, u.own, 'accrual', u.net / 100.0, u.rent / 100.0, u.dt, u.ref, 'accrual',
           p_tenant_id, u.rc, u.ch, u.mon, u.prop, u.rev, u.notes
      FROM unnest(p_owner, p_net, p_rent, p_date, p_ref, p_rc, p_ch, p_month, p_prop, p_rev, p_notes)
           AS u(own, net, rent, dt, ref, rc, ch, mon, prop, rev, notes);
    v_posted := array_length(p_ref, 1);
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'posted', v_posted, 'voided', v_voided, 'kept', v_kept,
      'accrued_rent', coalesce(sum(d.rent_amount), 0),
      'accrued_net', coalesce(sum(d.amount), 0),
      'accrued_fee', coalesce(sum(d.rent_amount - d.amount), 0),
      'accruals', count(*))
      FROM owner_distributions d
     WHERE d.company_id = p_company_id AND d.tenant_id = p_tenant_id AND d.kind = 'accrual' AND d.voided_at IS NULL);
END $$;
REVOKE ALL ON FUNCTION public._owner_accrual_sync_core(text, integer) FROM PUBLIC, anon, authenticated;

-- Record a tenant whose sync could not run (lock-wait timeout, error): a
-- NEEDS_SYNC queue row + an error_log row. Never raises.
DROP FUNCTION IF EXISTS public._owner_accrual_mark_pending(text, integer, text);
CREATE OR REPLACE FUNCTION public._owner_accrual_mark_pending(p_company_id text, p_tenant_id integer, p_error text, p_log boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
BEGIN
  BEGIN
    INSERT INTO owner_accrual_queue (company_id, tenant_id, needs_sync, attempts, last_error)
    VALUES (p_company_id, p_tenant_id, true, 1, left(p_error, 500))
    ON CONFLICT (company_id, tenant_id, txid) DO UPDATE
      SET needs_sync = true, attempts = owner_accrual_queue.attempts + 1, last_error = left(p_error, 500), updated_at = now();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'owner accrual: could not record a pending sync for %/%: %', p_company_id, p_tenant_id, SQLERRM;
  END;
  IF NOT p_log THEN RETURN; END IF;
  BEGIN
    INSERT INTO error_log (company_id, error_code, message, raw_message, severity, module, context, meta, user_email, user_role, reported_by_user)
    VALUES (p_company_id, 'PM-6004', 'Owner accrual could not be brought up to date for a tenant; it will be retried.',
            left(p_error, 1000), 'warning', 'owners', 'owner_accrual_sync (deferred)',
            jsonb_build_object('tenant_id', p_tenant_id), 'system', 'system', false);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;
REVOKE ALL ON FUNCTION public._owner_accrual_mark_pending(text, integer, text, boolean) FROM PUBLIC, anon, authenticated;

-- The RPC the app and the Stripe webhook call (staff of the company, or the
-- service role). Idempotent. A lock-wait timeout returns needs_sync instead
-- of failing.
DROP FUNCTION IF EXISTS public.owner_accrual_sync(text, integer);
CREATE OR REPLACE FUNCTION public.owner_accrual_sync(p_company_id text, p_tenant_id integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v jsonb; v_old text := current_setting('lock_timeout');
BEGIN
  PERFORM public._assert_company_staff(p_company_id);
  BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    v := public._owner_accrual_sync_core(p_company_id, p_tenant_id);
    PERFORM set_config('lock_timeout', v_old, true);
    RETURN v;
  EXCEPTION WHEN lock_not_available THEN
    PERFORM set_config('lock_timeout', v_old, true);
    PERFORM public._owner_accrual_mark_pending(p_company_id, p_tenant_id, 'lock wait timeout (RPC)');
    RETURN jsonb_build_object('needs_sync', true, 'posted', 0);
  END;
END $$;
REVOKE ALL ON FUNCTION public.owner_accrual_sync(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_accrual_sync(text, integer) TO authenticated, service_role;

-- Drain NEEDS_SYNC markers: one company (its staff), or every company (the
-- service role -- the nightly integrity cron). Fixed order, one tenant at a time.
CREATE OR REPLACE FUNCTION public.owner_accrual_sync_pending(p_company_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE q record; v_done int := 0; v_failed int := 0;
  v_claims text := current_setting('request.jwt.claims', true);
  v_old text := current_setting('lock_timeout');
BEGIN
  IF p_company_id IS NULL THEN
    IF v_claims IS NOT NULL AND v_claims <> '' AND coalesce(v_claims::jsonb ->> 'role', '') <> 'service_role' THEN
      RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
    END IF;
  ELSE
    PERFORM public._assert_company_staff(p_company_id);
  END IF;
  FOR q IN SELECT DISTINCT company_id, tenant_id FROM owner_accrual_queue
            WHERE needs_sync AND (p_company_id IS NULL OR company_id = p_company_id)
            ORDER BY company_id, tenant_id LIMIT 500
  LOOP
    BEGIN
      PERFORM set_config('lock_timeout', '3s', true);
      PERFORM public._owner_accrual_sync_core(q.company_id, q.tenant_id);
      PERFORM set_config('lock_timeout', v_old, true);
      v_done := v_done + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      UPDATE owner_accrual_queue SET attempts = attempts + 1, last_error = left(SQLERRM, 500), updated_at = now()
       WHERE company_id = q.company_id AND tenant_id = q.tenant_id AND needs_sync;
    END;
  END LOOP;
  PERFORM set_config('lock_timeout', v_old, true);
  RETURN jsonb_build_object('synced', v_done, 'failed', v_failed);
END $$;
REVOKE ALL ON FUNCTION public.owner_accrual_sync_pending(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_accrual_sync_pending(text) TO authenticated, service_role;

-- ── keep it in step: statement triggers -> queue -> one deferred runner ───
DROP TRIGGER IF EXISTS trg_owner_accrual_after_line ON public.acct_journal_lines;
DROP TRIGGER IF EXISTS trg_owner_accrual_after_je_status ON public.acct_journal_entries;
DROP FUNCTION IF EXISTS public.owner_accrual_after_line();
DROP FUNCTION IF EXISTS public.owner_accrual_after_je_status();

CREATE OR REPLACE FUNCTION public._owner_accrual_enqueue_lines()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO owner_accrual_queue (company_id, tenant_id)
    SELECT DISTINCT a.company_id, a.tenant_id::integer
      FROM new_rows n JOIN acct_accounts a ON a.id = n.account_id
     WHERE a.tenant_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM property_owner_history h WHERE h.company_id = a.company_id)
    ON CONFLICT (company_id, tenant_id, txid) DO NOTHING;
  ELSE
    INSERT INTO owner_accrual_queue (company_id, tenant_id)
    SELECT DISTINCT a.company_id, a.tenant_id::integer
      FROM new_rows n JOIN old_rows o ON o.id = n.id
      JOIN acct_accounts a ON a.id IN (n.account_id, o.account_id)
     WHERE a.tenant_id IS NOT NULL
       AND (n.debit IS DISTINCT FROM o.debit OR n.credit IS DISTINCT FROM o.credit OR n.account_id IS DISTINCT FROM o.account_id
            OR n.journal_entry_id IS DISTINCT FROM o.journal_entry_id OR n.class_id IS DISTINCT FROM o.class_id)
       AND EXISTS (SELECT 1 FROM property_owner_history h WHERE h.company_id = a.company_id)
    ON CONFLICT (company_id, tenant_id, txid) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._owner_accrual_enqueue_lines() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._owner_accrual_enqueue_entries()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
BEGIN
  INSERT INTO owner_accrual_queue (company_id, tenant_id)
  SELECT DISTINCT a.company_id, a.tenant_id::integer
    FROM new_rows n JOIN old_rows o ON o.id = n.id
    JOIN acct_journal_lines l ON l.journal_entry_id = n.id
    JOIN acct_accounts a ON a.id = l.account_id
   WHERE (n.status IS DISTINCT FROM o.status OR n.date IS DISTINCT FROM o.date OR n.property IS DISTINCT FROM o.property)
     AND coalesce(n.reference, '') NOT LIKE 'ODIST-%'
     AND a.tenant_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM property_owner_history h WHERE h.company_id = a.company_id)
  ON CONFLICT (company_id, tenant_id, txid) DO NOTHING;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._owner_accrual_enqueue_entries() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_owner_accrual_enqueue_ins ON public.acct_journal_lines;
CREATE TRIGGER trg_owner_accrual_enqueue_ins AFTER INSERT ON public.acct_journal_lines
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public._owner_accrual_enqueue_lines();
DROP TRIGGER IF EXISTS trg_owner_accrual_enqueue_upd ON public.acct_journal_lines;
CREATE TRIGGER trg_owner_accrual_enqueue_upd AFTER UPDATE ON public.acct_journal_lines
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public._owner_accrual_enqueue_lines();
DROP TRIGGER IF EXISTS trg_owner_accrual_enqueue_je ON public.acct_journal_entries;
CREATE TRIGGER trg_owner_accrual_enqueue_je AFTER UPDATE ON public.acct_journal_entries
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public._owner_accrual_enqueue_entries();

-- At commit: the first queue row of the transaction syncs ALL its tenants, in
-- (company, tenant) order, each in its own subtransaction with lock_timeout
-- 3s. Failures become NEEDS_SYNC markers + error_log rows; the write that
-- caused them always commits.
CREATE OR REPLACE FUNCTION public._owner_accrual_queue_run()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE q record; v_old text := current_setting('lock_timeout'); v_deferred int := 0;
BEGIN
  IF NEW.needs_sync THEN RETURN NULL; END IF;
  FOR q IN SELECT company_id, tenant_id FROM owner_accrual_queue
            WHERE txid = NEW.txid AND NOT needs_sync ORDER BY company_id, tenant_id
  LOOP
    -- Time budget: a bulk import touching many owner tenants must not run
    -- the request into the 8s statement timeout. Past 4s into the transaction, the remaining
    -- tenants become NEEDS_SYNC markers (drained by the Owners page, the
    -- pending RPC and the nightly integrity cron).
    IF clock_timestamp() - transaction_timestamp() > interval '4 seconds' THEN
      DELETE FROM owner_accrual_queue WHERE company_id = q.company_id AND tenant_id = q.tenant_id AND txid = NEW.txid;
      PERFORM public._owner_accrual_mark_pending(q.company_id, q.tenant_id, 'deferred: commit time budget (bulk write)', v_deferred = 0);
      v_deferred := v_deferred + 1;
      CONTINUE;
    END IF;
    BEGIN
      PERFORM set_config('lock_timeout', '3s', true);
      PERFORM public._owner_accrual_sync_core(q.company_id, q.tenant_id);
      PERFORM set_config('lock_timeout', v_old, true);
      DELETE FROM owner_accrual_queue WHERE company_id = q.company_id AND tenant_id = q.tenant_id AND txid = NEW.txid;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM owner_accrual_queue WHERE company_id = q.company_id AND tenant_id = q.tenant_id AND txid = NEW.txid;
      PERFORM public._owner_accrual_mark_pending(q.company_id, q.tenant_id, SQLSTATE || ' ' || SQLERRM);
      RAISE WARNING 'owner_accrual_sync(%, %) deferred: %', q.company_id, q.tenant_id, SQLERRM;
    END;
  END LOOP;
  PERFORM set_config('lock_timeout', v_old, true);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._owner_accrual_queue_run() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_owner_accrual_queue_run ON public.owner_accrual_queue;
CREATE CONSTRAINT TRIGGER trg_owner_accrual_queue_run AFTER INSERT ON public.owner_accrual_queue
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public._owner_accrual_queue_run();

-- ── correct the owner of a property from a date (manager tier) ────────────
-- For a wrong owner pick: from p_from (NULL = from the start) the property
-- belongs to p_owner_id; history is rewritten for that range and the
-- property's accruals in that range are re-stamped (voided and re-posted, or
-- reversed after a period lock). Past accruals are otherwise never re-stamped.
CREATE OR REPLACE FUNCTION public.correct_property_owner(p_company_id text, p_property_id integer, p_owner_id uuid, p_from date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE
  v_claims text := current_setting('request.jwt.claims', true);
  v_prop properties%ROWTYPE; v_owner owners%ROWTYPE; t record; v_n int := 0;
BEGIN
  IF v_claims IS NOT NULL AND v_claims <> '' AND coalesce(v_claims::jsonb ->> 'role', '') <> 'service_role' THEN
    PERFORM public._assert_company_staff(p_company_id);
    IF NOT public.is_management_tier(p_company_id) THEN
      RAISE EXCEPTION 'Your role cannot correct a property''s owner — only a manager, owner, or admin can.' USING ERRCODE = '42501';
    END IF;
  END IF;
  SELECT * INTO v_prop FROM properties WHERE id = p_property_id AND company_id = p_company_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Property not found in this company.'; END IF;
  SELECT * INTO v_owner FROM owners WHERE id = p_owner_id AND company_id = p_company_id AND archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Owner not found in this company.'; END IF;

  -- history: p_owner_id from p_from onward
  DELETE FROM property_owner_history
   WHERE property_id = p_property_id AND (p_from IS NULL OR (from_date IS NOT NULL AND from_date >= p_from));
  IF p_from IS NOT NULL THEN
    UPDATE property_owner_history SET to_date = p_from, closed_at = coalesce(closed_at, now())
     WHERE property_id = p_property_id AND (from_date IS NULL OR from_date < p_from) AND (to_date IS NULL OR to_date > p_from);
  END IF;
  INSERT INTO property_owner_history (company_id, property_id, owner_id, from_date, to_date)
  VALUES (p_company_id, p_property_id, p_owner_id, p_from, NULL);

  PERFORM set_config('owner_history.skip', 'on', true);
  UPDATE properties SET owner_id = p_owner_id, owner_name = v_owner.name WHERE id = p_property_id;
  PERFORM set_config('owner_history.skip', '', true);

  -- re-stamp: every tenant with entries on this property (fixed order)
  PERFORM set_config('owner_accrual.restamp_property', p_property_id::text, true);
  FOR t IN
    SELECT DISTINCT tid FROM (
      SELECT a.tenant_id::integer AS tid FROM acct_journal_lines l
        JOIN acct_accounts a ON a.id = l.account_id
        JOIN acct_journal_entries j ON j.id = l.journal_entry_id
       WHERE l.company_id = p_company_id AND a.tenant_id IS NOT NULL
         AND ((v_prop.class_id IS NOT NULL AND l.class_id = v_prop.class_id) OR j.property = v_prop.address)
      UNION
      SELECT id FROM tenants WHERE company_id = p_company_id AND property = v_prop.address) s
     ORDER BY tid
  LOOP
    PERFORM public._owner_accrual_sync_core(p_company_id, t.tid);
    v_n := v_n + 1;
  END LOOP;
  PERFORM set_config('owner_accrual.restamp_property', '', true);
  RETURN jsonb_build_object('property_id', p_property_id, 'owner_id', p_owner_id, 'from', p_from, 'tenants_resynced', v_n);
END $$;
REVOKE ALL ON FUNCTION public.correct_property_owner(text, integer, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_property_owner(text, integer, uuid, date) TO authenticated, service_role;

-- ── owner_distributions: kind immutable; gate on UPDATE / DELETE ──────────
CREATE OR REPLACE FUNCTION public.owner_distribution_kind_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public','pg_temp' AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'An owner distribution''s kind cannot be changed.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.owner_distribution_kind_immutable() FROM PUBLIC, anon;
DROP TRIGGER IF EXISTS trg_owner_distribution_kind_immutable ON public.owner_distributions;
CREATE TRIGGER trg_owner_distribution_kind_immutable BEFORE UPDATE OF kind ON public.owner_distributions
  FOR EACH ROW EXECUTE FUNCTION public.owner_distribution_kind_immutable();

CREATE OR REPLACE FUNCTION public.enforce_management_tier_destructive()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public','pg_temp' AS $$
DECLARE
  v_destructive boolean := false;
  v_action text;
  v_cid text;
BEGIN
  IF current_user = 'authenticated' THEN
    v_cid := COALESCE(NEW.company_id, OLD.company_id);
    IF TG_TABLE_NAME = 'acct_accounts' AND TG_OP = 'DELETE' THEN
      v_destructive := true; v_action := 'delete a GL account';
    ELSIF TG_TABLE_NAME = 'owner_distributions' AND TG_OP = 'INSERT' THEN
      IF COALESCE(NEW.kind, CASE WHEN COALESCE(NEW.reference, '') LIKE 'ODIST-%' THEN 'accrual' ELSE 'payout' END) = 'accrual' THEN
        -- Accruals are written only by the SQL allocation (SECURITY DEFINER).
        RAISE EXCEPTION 'Owner accruals are recorded automatically from rent receipts and cannot be entered by hand.'
          USING ERRCODE = '42501';
      END IF;
      v_destructive := true; v_action := 'record an owner payout';
    ELSIF TG_TABLE_NAME = 'owner_distributions' AND TG_OP = 'DELETE' THEN
      v_destructive := true; v_action := 'delete an owner distribution';
    ELSIF TG_OP = 'UPDATE' THEN
      IF TG_TABLE_NAME = 'owner_distributions' THEN
        -- Everything but the notes is money or its links.
        IF (to_jsonb(NEW) - 'notes') IS DISTINCT FROM (to_jsonb(OLD) - 'notes') THEN
          v_destructive := true; v_action := 'change or void an owner distribution';
        END IF;
      ELSIF TG_TABLE_NAME = 'properties' THEN
        IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
          v_destructive := true; v_action := 'delete this property';
        ELSIF OLD.status IS DISTINCT FROM 'inactive' AND NEW.status = 'inactive' THEN
          v_destructive := true; v_action := 'deactivate this property';
        END IF;
      ELSIF TG_TABLE_NAME = 'acct_journal_entries' THEN
        IF OLD.status IS DISTINCT FROM 'voided' AND NEW.status = 'voided' THEN
          v_destructive := true; v_action := 'void a journal entry';
        END IF;
      ELSIF TG_TABLE_NAME = 'leases' THEN
        IF OLD.status IS DISTINCT FROM 'terminated' AND NEW.status = 'terminated' THEN
          v_destructive := true; v_action := 'terminate a lease';
        END IF;
      ELSIF TG_TABLE_NAME = 'autopay_schedules' THEN
        IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
          v_destructive := true; v_action := 'delete an autopay schedule';
        ELSIF COALESCE(OLD.enabled, true) AND NOT COALESCE(NEW.enabled, true) THEN
          v_destructive := true; v_action := 'disable an autopay schedule';
        END IF;
      ELSIF TG_TABLE_NAME IN ('owners','vendors','tenants','work_orders') THEN
        IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
          v_destructive := true; v_action := 'archive or delete this record';
        END IF;
      END IF;
    END IF;
    IF v_destructive AND NOT public.is_management_tier(v_cid) THEN
      RAISE EXCEPTION 'Your role cannot % — only a manager, owner, or admin can.', v_action USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS trg_mgmt_gate_upd ON public.owner_distributions;
CREATE TRIGGER trg_mgmt_gate_upd BEFORE UPDATE ON public.owner_distributions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_management_tier_destructive();
DROP TRIGGER IF EXISTS trg_mgmt_gate_del ON public.owner_distributions;
CREATE TRIGGER trg_mgmt_gate_del BEFORE DELETE ON public.owner_distributions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_management_tier_destructive();
