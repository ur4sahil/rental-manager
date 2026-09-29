-- Owner accruals: one SQL function, allocated oldest-first, kept in step with
-- every receipt, charge and void.
--
-- Replaces the per-receipt JavaScript accrual (ownerRules.runOwnerDistribution-
-- Accrual), which an adversarial QA pass broke in several ways:
--   * it keyed on the receipt's CALENDAR MONTH, so a late payer, a prepayer,
--     a payment posted before the rent charge, or rent paid on the 30th/31st
--     for next month accrued nothing (S3, S4, S4b, S5);
--   * it read and wrote in separate requests with no lock, so two tabs, two
--     paths (app + Stripe) or two spellings of the tenant's name over-accrued
--     (S8a, S10), and name slugs collided (S2, S7, S10b);
--   * voiding / refunding the receipt left the accrual live (S9);
--   * "rent" was a reference prefix, so a RECUR- pet fee counted as rent (S13).
--
-- owner_accrual_sync(company, tenant) now does the whole thing in one
-- transaction under a per-tenant advisory lock:
--   1. Every posted entry touching the tenant's own AR, oldest first.
--      CASH entries (the entry has a cash-like ASSET leg that is not AR:
--      bank, Stripe receivable): the part of the AR debit that bills income
--      is a charge; the rest of the AR movement is money in (a receipt) or
--      out (a refund / NSF / Stripe refund or dispute reversal).
--      NON-CASH entries: a net AR debit is a CHARGE; a net AR credit (credit
--      note, deposit applied, write-off) settles charges without cash.
--      Voided entries are ignored entirely, so a voided receipt simply stops
--      counting.
--   2. The RENT part of a charge = least(charge, net credit to a rent-income
--      account: owner_is_rent_income_account -- code 4000 / 4000-xx or an
--      account named "Rental Income"/"Rent Income"). A RECUR- pet fee to
--      4100 is not rent. Deposits, late fees and other charges are the
--      non-rent part: they consume money but never accrue.
--   3. ALLOCATION, oldest-first: refunds first take back the most recent
--      cash receipts (LIFO); then credits are applied to charges in date
--      order (FIFO) whatever month either is in -- within a charge the rent
--      part first. Money left over waits for the next charge, so rent charged
--      onto an existing credit balance accrues when the charge posts. Only
--      CASH paying the RENT part of a charge accrues.
--   4. Only charges POSTED WHILE THE PROPERTY HAD AN OWNER accrue
--      (je.created_at >= properties.owner_accrual_since, stamped when
--      owner_id goes from NULL to a value). History before the link is never
--      accrued retroactively. Charges still consume receipts in order.
--      Each accrual belongs to WHOEVER OWNED THE PROPERTY WHEN THE RENT WAS
--      CHARGED (owner decision 8, 2026-09-29): the owner is looked up in
--      property_owner_history at the charge date and stamped on the accrual
--      row (owner_id). A reassignment never moves past accruals.
--   5. RECONCILE: each (receipt entry, charge entry, rent amount) pair is one
--      accrual: DR the rent account / CR 4200 fee / CR 2200 net, and an
--      owner_distributions row of kind 'accrual' carrying tenant_id,
--      receipt_je_id, charge_je_id, charge_month and rent_amount. Its
--      reference is ODIST-<tenant id>-<receipt entry id>-<charge entry id>:
--      unique by construction, no names. Live accruals no longer backed by
--      the allocation (receipt voided or refunded, amount changed) are voided
--      and re-posted. Accruals dated inside a locked period are left as they
--      are (frozen) and new ones are dated after the lock.
--   Fee: the owner's management_fee_pct (0 means 0, NULL means 0 -- "not
--   set"); archived owners and unlinked properties accrue nothing.
--
-- Triggers keep it in step: a DEFERRED constraint trigger on journal lines
-- (insert / change touching a tenant's AR) and on journal-entry status
-- changes (void / un-void) run the sync at commit, once per tenant per
-- transaction, for tenants on owner-managed properties. A failure there is a
-- WARNING and never blocks the receipt, charge or void itself. The app also
-- calls the RPC directly after each receipt path (idempotent).
--
-- Ownership history (decision 8): property_owner_history (property_id,
-- owner_id, from_date inclusive, to_date exclusive; NULL = open), written by a
-- trigger whenever properties.owner_id changes. properties has no created
-- date, so the FIRST owner of a property (and the backfill of today's
-- owners) covers the property from the start (from_date NULL); a later owner
-- starts on the change date and the previous row ends that day. Statements
-- read it to give each month's billed rent to whoever owned the property then.
--
-- Also here:
--   * owner_distributions: tenant_id, receipt_je_id, charge_je_id (FKs),
--     charge_month, rent_amount.
--   * The management-tier gate now covers UPDATE (kind / amount / voided_at /
--     owner / rent_amount) and DELETE of owner_distributions, and refuses
--     client inserts of accruals outright (only the sync writes them). kind
--     is immutable.
--   * owners.management_fee_pct CHECK 0..100 (TEST had no violators).
-- New SECURITY DEFINER functions: REVOKE ALL FROM PUBLIC, anon; the sync
-- checks the caller is company staff (_assert_company_staff).

-- ── columns ────────────────────────────────────────────────────────────────
ALTER TABLE public.owner_distributions
  ADD COLUMN IF NOT EXISTS tenant_id integer REFERENCES public.tenants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS receipt_je_id text REFERENCES public.acct_journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS charge_je_id text REFERENCES public.acct_journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS charge_month date,
  ADD COLUMN IF NOT EXISTS rent_amount numeric;
CREATE INDEX IF NOT EXISTS idx_owner_distributions_tenant_accrual
  ON public.owner_distributions (company_id, tenant_id) WHERE kind = 'accrual';

ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS owner_accrual_since timestamptz;
-- Already-linked properties: from now on (never retroactive).
UPDATE public.properties SET owner_accrual_since = now()
 WHERE owner_id IS NOT NULL AND owner_accrual_since IS NULL;

CREATE OR REPLACE FUNCTION public.properties_owner_accrual_since()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public','pg_temp' AS $$
BEGIN
  -- The first time the property ever gets an owner. Never reset: charges
  -- posted before it are never accrued (no retroactive history); a later
  -- unlink / relink / reassignment keeps it.
  IF NEW.owner_id IS NOT NULL AND NEW.owner_accrual_since IS NULL THEN
    NEW.owner_accrual_since := now();
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.properties_owner_accrual_since() FROM PUBLIC, anon;
DROP TRIGGER IF EXISTS trg_properties_owner_accrual_since ON public.properties;
CREATE TRIGGER trg_properties_owner_accrual_since BEFORE INSERT OR UPDATE OF owner_id ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.properties_owner_accrual_since();

-- ── ownership history (decision 8) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.property_owner_history (
  id          bigserial PRIMARY KEY,
  company_id  text NOT NULL,
  property_id integer NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  owner_id    uuid NOT NULL REFERENCES public.owners(id) ON DELETE CASCADE,
  from_date   date,          -- inclusive; NULL = from the start
  to_date     date,          -- exclusive; NULL = current
  created_at  timestamptz NOT NULL DEFAULT now()
);
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
-- (no write policies: only the trigger below writes it)

INSERT INTO public.property_owner_history (company_id, property_id, owner_id, from_date, to_date)
SELECT p.company_id, p.id, p.owner_id, NULL, NULL FROM public.properties p
 WHERE p.owner_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.property_owner_history h WHERE h.property_id = p.id);

CREATE OR REPLACE FUNCTION public.properties_owner_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v_first boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.owner_id IS NOT NULL THEN
    UPDATE property_owner_history SET to_date = current_date
     WHERE property_id = NEW.id AND to_date IS NULL;
  END IF;
  IF NEW.owner_id IS NOT NULL THEN
    SELECT NOT EXISTS (SELECT 1 FROM property_owner_history WHERE property_id = NEW.id) INTO v_first;
    INSERT INTO property_owner_history (company_id, property_id, owner_id, from_date, to_date)
    VALUES (NEW.company_id, NEW.id, NEW.owner_id, CASE WHEN v_first THEN NULL ELSE current_date END, NULL);
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

-- ── the sync ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.owner_accrual_sync(p_company_id text, p_tenant_id integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE
  v_tenant   tenants%ROWTYPE;
  v_prop     properties%ROWTYPE;
  v_owner    owners%ROWTYPE;
  v_ar       uuid[];
  v_lock     date;
  r          record;
  -- charges (every AR debit: rent part first, then the rest)
  ch_id text[] := '{}'; ch_date date[] := '{}'; ch_rent bigint[] := '{}'; ch_other bigint[] := '{}';
  ch_acct uuid[] := '{}'; ch_ok boolean[] := '{}'; ch_owner uuid[] := '{}';
  v_ch_owner uuid;
  -- credits (cash receipts net of refunds, and non-cash credits)
  cr_id text[] := '{}'; cr_date date[] := '{}'; cr_rem bigint[] := '{}'; cr_cash boolean[] := '{}';
  -- desired accruals
  d_rc text[] := '{}'; d_ch text[] := '{}'; d_amt bigint[] := '{}'; d_date date[] := '{}'; d_month date[] := '{}';
  d_acct uuid[] := '{}'; d_done boolean[] := '{}'; d_owner uuid[] := '{}';
  i int; j int; k int; take bigint; neg bigint; amt bigint; chg bigint; rent_part bigint; income_net bigint;
  v_pct numeric; v_fee bigint; v_net bigint;
  v_posted int := 0; v_voided int := 0; v_kept int := 0;
  v_ref text; v_je text; v_num text; v_date date; v_try int;
  a4200 uuid; a2200 uuid; v_rent_name text;
  v_found int;
BEGIN
  PERFORM public._assert_company_staff(p_company_id);
  IF p_company_id IS NULL OR p_tenant_id IS NULL THEN
    RETURN jsonb_build_object('skipped', 'missing input');
  END IF;
  -- One allocation per tenant at a time: two tabs, the app and Stripe, or a
  -- bank deposit and a manual receipt cannot both claim the same rent.
  PERFORM pg_advisory_xact_lock(hashtext('owner_accrual:' || p_company_id), p_tenant_id);

  SELECT * INTO v_tenant FROM tenants WHERE company_id = p_company_id AND id = p_tenant_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('skipped', 'no tenant'); END IF;
  SELECT * INTO v_prop FROM properties
   WHERE company_id = p_company_id AND address = v_tenant.property AND archived_at IS NULL
   ORDER BY id LIMIT 1;
  -- Never had an owner: nothing to do. (A property unlinked since keeps its
  -- earlier owner's accruals in step for charges from that time.)
  IF NOT FOUND OR v_prop.owner_accrual_since IS NULL THEN RETURN jsonb_build_object('skipped', 'no owner'); END IF;
  SELECT array_agg(id) INTO v_ar FROM acct_accounts WHERE company_id = p_company_id AND tenant_id = p_tenant_id;
  IF v_ar IS NULL THEN RETURN jsonb_build_object('skipped', 'tenant has no AR account'); END IF;
  SELECT lock_date INTO v_lock FROM accounting_period_lock WHERE company_id = p_company_id;

  -- 1 + 2: every posted entry touching the tenant's AR, oldest first. Within
  -- an entry the charge comes before the receipt.
  FOR r IN
    WITH ar_jes AS (
      SELECT DISTINCT l.journal_entry_id AS id FROM acct_journal_lines l
       WHERE l.company_id = p_company_id AND l.account_id = ANY (v_ar)
    ), lines AS (
      SELECT j.id, j.date, j.created_at, l.account_id, coalesce(l.debit, 0) AS dr, coalesce(l.credit, 0) AS cr,
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
    SELECT id, date, created_at,
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
      -- CASH entry (bank, Stripe receivable): the part of the AR debit that
      -- bills income is a charge; the rest of the AR movement is money in
      -- (a receipt) or out (a refund / NSF / dispute).
      income_net := greatest(round(r.income_net * 100)::bigint, 0);
      chg := least(round(r.ar_dr * 100)::bigint, income_net);
      amt := round(r.ar_cr * 100)::bigint - (round(r.ar_dr * 100)::bigint - chg);
    ELSE
      -- NON-CASH entry: net AR debit is a charge; a net AR credit (credit
      -- note, deposit applied, write-off) settles charges without cash.
      chg := greatest(round((r.ar_dr - r.ar_cr) * 100)::bigint, 0);
      amt := least(round((r.ar_dr - r.ar_cr) * 100)::bigint, 0);   -- <= 0
      amt := -amt;
    END IF;
    IF chg > 0 THEN
      rent_part := least(chg, greatest(round(r.rent_net * 100)::bigint, 0));
      ch_id := ch_id || r.id; ch_date := ch_date || r.date; ch_acct := ch_acct || r.rent_acct;
      ch_rent := ch_rent || rent_part; ch_other := ch_other || (chg - rent_part);
      -- whoever owned the property when the rent was charged; charges
      -- posted before the property first had an owner are never accrued (no
      -- retroactive history). An ARCHIVED owner's existing accruals are kept
      -- in step, but nothing new is posted for them (see the posting loop).
      v_ch_owner := NULL;
      IF rent_part > 0 THEN
        v_ch_owner := public.property_owner_on(v_prop.id, r.date);
      END IF;
      ch_owner := ch_owner || v_ch_owner;
      ch_ok := ch_ok || (v_ch_owner IS NOT NULL AND r.created_at >= v_prop.owner_accrual_since);
    END IF;
    IF r.has_cash THEN
      IF amt > 0 THEN
        cr_id := cr_id || r.id; cr_date := cr_date || r.date; cr_rem := cr_rem || amt; cr_cash := cr_cash || true;
      ELSIF amt < 0 THEN
        -- refund: take back the most recent cash receipts first
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

  -- 3: credits against charges, oldest first (FIFO), any month; within a
  -- charge the rent part is paid first. Only CASH paying the RENT part of an
  -- accruable charge accrues.
  i := 1; j := 1;
  WHILE i <= coalesce(array_length(ch_id, 1), 0) AND j <= coalesce(array_length(cr_id, 1), 0) LOOP
    IF cr_rem[j] <= 0 THEN j := j + 1; CONTINUE; END IF;
    IF ch_rent[i] > 0 THEN
      take := least(ch_rent[i], cr_rem[j]);
      IF ch_ok[i] AND cr_cash[j] THEN
        d_rc := d_rc || cr_id[j]; d_ch := d_ch || ch_id[i]; d_amt := d_amt || take;
        d_date := d_date || greatest(ch_date[i], cr_date[j]);
        d_month := d_month || date_trunc('month', ch_date[i])::date;
        d_acct := d_acct || ch_acct[i]; d_done := d_done || false; d_owner := d_owner || ch_owner[i];
      END IF;
      ch_rent[i] := ch_rent[i] - take; cr_rem[j] := cr_rem[j] - take;
    ELSIF ch_other[i] > 0 THEN
      take := least(ch_other[i], cr_rem[j]);
      ch_other[i] := ch_other[i] - take; cr_rem[j] := cr_rem[j] - take;
    ELSE
      i := i + 1;
    END IF;
  END LOOP;

  -- 5: reconcile the live accruals with the allocation.
  FOR r IN
    SELECT d.id, d.reference, d.receipt_je_id, d.charge_je_id, d.rent_amount, d.owner_id,
           je.id AS je_id, je.date AS je_date
      FROM owner_distributions d
      LEFT JOIN acct_journal_entries je
        ON je.company_id = d.company_id AND je.reference = d.reference AND je.status <> 'voided'
     WHERE d.company_id = p_company_id AND d.tenant_id = p_tenant_id
       AND d.kind = 'accrual' AND d.voided_at IS NULL
  LOOP
    v_found := NULL;
    FOR k IN 1 .. coalesce(array_length(d_rc, 1), 0) LOOP
      IF NOT d_done[k] AND d_rc[k] = r.receipt_je_id AND d_ch[k] = r.charge_je_id THEN v_found := k; EXIT; END IF;
    END LOOP;
    IF v_found IS NOT NULL AND round(coalesce(r.rent_amount, 0) * 100)::bigint = d_amt[v_found]
       AND r.owner_id IS NOT DISTINCT FROM d_owner[v_found] THEN
      d_done[v_found] := true; v_kept := v_kept + 1;
    ELSIF v_lock IS NOT NULL AND r.je_date IS NOT NULL AND r.je_date <= v_lock THEN
      -- inside a locked period: frozen as posted
      IF v_found IS NOT NULL THEN d_done[v_found] := true; END IF;
      v_kept := v_kept + 1;
    ELSE
      IF r.je_id IS NOT NULL THEN
        UPDATE acct_journal_entries SET status = 'voided' WHERE id = r.je_id;
      END IF;
      UPDATE owner_distributions SET voided_at = now() WHERE id = r.id AND voided_at IS NULL;
      v_voided := v_voided + 1;
    END IF;
  END LOOP;

  FOR k IN 1 .. coalesce(array_length(d_rc, 1), 0) LOOP
    CONTINUE WHEN d_done[k];
    SELECT * INTO v_owner FROM owners WHERE id = d_owner[k];
    CONTINUE WHEN v_owner.archived_at IS NOT NULL;   -- archived owners stop accruing
    v_pct := least(greatest(coalesce(v_owner.management_fee_pct, 0), 0), 100);
    v_ref := 'ODIST-' || p_tenant_id || '-' || d_rc[k] || '-' || d_ch[k];
    PERFORM 1 FROM acct_journal_entries WHERE company_id = p_company_id AND reference = v_ref AND status <> 'voided';
    CONTINUE WHEN FOUND;
    v_fee := round(d_amt[k] * v_pct / 100)::bigint;
    v_net := d_amt[k] - v_fee;
    v_date := greatest(d_date[k], coalesce(v_lock + 1, d_date[k]));
    IF a4200 IS NULL THEN
      a4200 := public._owner_accrual_account(p_company_id, '4200', 'Management Fee Income', 'Revenue');
      a2200 := public._owner_accrual_account(p_company_id, '2200', 'Owner Distributions Payable', 'Liability');
    END IF;
    SELECT name INTO v_rent_name FROM acct_accounts WHERE id = d_acct[k];
    v_je := NULL; v_try := 0;
    WHILE v_je IS NULL AND v_try < 5 LOOP
      v_try := v_try + 1;
      v_num := public.next_je_number(p_company_id);
      BEGIN
        INSERT INTO acct_journal_entries (company_id, number, date, description, reference, property, status)
        VALUES (p_company_id, v_num, v_date,
                'Owner distribution accrual — ' || v_owner.name || ' — ' || v_tenant.name || ' — rent ' || to_char(d_month[k], 'YYYY-MM'),
                v_ref, v_prop.address, 'posted')
        RETURNING id INTO v_je;
      EXCEPTION WHEN unique_violation THEN
        v_je := NULL;  -- JE number race: try the next number
      END;
    END LOOP;
    IF v_je IS NULL THEN RAISE EXCEPTION 'owner_accrual_sync: could not number the accrual entry'; END IF;
    INSERT INTO acct_journal_lines (company_id, journal_entry_id, account_id, account_name, debit, credit, class_id, memo)
    VALUES (p_company_id, v_je, d_acct[k], coalesce(v_rent_name, 'Rental Income'), d_amt[k] / 100.0, 0, v_prop.class_id,
            'Reclassify rent to owner — ' || v_tenant.name);
    IF v_fee > 0 THEN
      INSERT INTO acct_journal_lines (company_id, journal_entry_id, account_id, account_name, debit, credit, class_id, memo)
      VALUES (p_company_id, v_je, a4200, 'Management Fee Income', 0, v_fee / 100.0, v_prop.class_id,
              'Mgmt fee ' || v_pct || '% of rent — ' || v_owner.name);
    END IF;
    IF v_net > 0 THEN
      INSERT INTO acct_journal_lines (company_id, journal_entry_id, account_id, account_name, debit, credit, class_id, memo)
      VALUES (p_company_id, v_je, a2200, 'Owner Distributions Payable', 0, v_net / 100.0, v_prop.class_id,
              'Net to ' || v_owner.name);
    END IF;
    INSERT INTO owner_distributions (company_id, owner_id, kind, amount, rent_amount, date, reference, method,
                                     tenant_id, receipt_je_id, charge_je_id, charge_month, notes)
    VALUES (p_company_id, v_owner.id, 'accrual', v_net / 100.0, d_amt[k] / 100.0, v_date, v_ref, 'accrual',
            p_tenant_id, d_rc[k], d_ch[k], d_month[k],
            'Rent ' || to_char(d_month[k], 'YYYY-MM') || ' from ' || v_tenant.name || ' — rent ' || to_char(d_amt[k] / 100.0, 'FM999999990.00')
              || ' · mgmt fee ' || v_pct || '% of rent' || CASE WHEN v_owner.management_fee_pct IS NULL THEN ' (not set)' ELSE '' END
              || ' (' || to_char(v_fee / 100.0, 'FM999999990.00') || ') · net ' || to_char(v_net / 100.0, 'FM999999990.00'));
    v_posted := v_posted + 1;
  END LOOP;

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
REVOKE ALL ON FUNCTION public.owner_accrual_sync(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_accrual_sync(text, integer) TO authenticated, service_role;

-- ── keep it in step: deferred triggers ────────────────────────────────────
-- Runs the sync for a tenant at most once per transaction, only when the
-- tenant's property has ever had an owner, and never lets a failure block
-- the write (a WARNING is raised instead).
CREATE OR REPLACE FUNCTION public._owner_accrual_sync_quiet(p_company_id text, p_tenant_id integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v_key text := ',' || p_company_id || ':' || p_tenant_id || ',';
BEGIN
  IF p_company_id IS NULL OR p_tenant_id IS NULL THEN RETURN; END IF;
  IF position(v_key IN coalesce(current_setting('owner_accrual.synced', true), '')) > 0 THEN RETURN; END IF;
  PERFORM 1 FROM tenants t JOIN properties p
      ON p.company_id = t.company_id AND p.address = t.property AND p.archived_at IS NULL AND p.owner_accrual_since IS NOT NULL
   WHERE t.company_id = p_company_id AND t.id = p_tenant_id;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM set_config('owner_accrual.synced', coalesce(current_setting('owner_accrual.synced', true), '') || v_key, true);
  BEGIN
    PERFORM public.owner_accrual_sync(p_company_id, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'owner_accrual_sync(%, %) failed: %', p_company_id, p_tenant_id, SQLERRM;
  END;
END $$;
REVOKE ALL ON FUNCTION public._owner_accrual_sync_quiet(text, integer) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.owner_accrual_after_line()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v_tid integer; v_co text;
BEGIN
  BEGIN
    SELECT a.tenant_id::integer, a.company_id INTO v_tid, v_co FROM acct_accounts a WHERE a.id = NEW.account_id;
    IF v_tid IS NOT NULL THEN PERFORM public._owner_accrual_sync_quiet(v_co, v_tid); END IF;
    IF TG_OP = 'UPDATE' AND OLD.account_id IS DISTINCT FROM NEW.account_id THEN
      SELECT a.tenant_id::integer, a.company_id INTO v_tid, v_co FROM acct_accounts a WHERE a.id = OLD.account_id;
      IF v_tid IS NOT NULL THEN PERFORM public._owner_accrual_sync_quiet(v_co, v_tid); END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'owner accrual trigger (line) failed: %', SQLERRM;
  END;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.owner_accrual_after_line() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.owner_accrual_after_je_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE r record;
BEGIN
  IF coalesce(NEW.reference, '') LIKE 'ODIST-%' THEN RETURN NULL; END IF;
  BEGIN
    FOR r IN SELECT DISTINCT a.tenant_id::integer AS tenant_id, a.company_id
               FROM acct_journal_lines l JOIN acct_accounts a ON a.id = l.account_id
              WHERE l.journal_entry_id = NEW.id AND a.tenant_id IS NOT NULL LOOP
      PERFORM public._owner_accrual_sync_quiet(r.company_id, r.tenant_id);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'owner accrual trigger (entry status) failed: %', SQLERRM;
  END;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.owner_accrual_after_je_status() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_owner_accrual_after_line ON public.acct_journal_lines;
CREATE CONSTRAINT TRIGGER trg_owner_accrual_after_line
  AFTER INSERT OR UPDATE OF debit, credit, account_id ON public.acct_journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.owner_accrual_after_line();

DROP TRIGGER IF EXISTS trg_owner_accrual_after_je_status ON public.acct_journal_entries;
CREATE CONSTRAINT TRIGGER trg_owner_accrual_after_je_status
  AFTER UPDATE OF status ON public.acct_journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.owner_accrual_after_je_status();

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
        -- Accruals are written only by owner_accrual_sync (SECURITY DEFINER).
        RAISE EXCEPTION 'Owner accruals are recorded automatically from rent receipts and cannot be entered by hand.'
          USING ERRCODE = '42501';
      END IF;
      v_destructive := true; v_action := 'record an owner payout';
    ELSIF TG_TABLE_NAME = 'owner_distributions' AND TG_OP = 'DELETE' THEN
      v_destructive := true; v_action := 'delete an owner distribution';
    ELSIF TG_OP = 'UPDATE' THEN
      IF TG_TABLE_NAME = 'owner_distributions' THEN
        IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.amount IS DISTINCT FROM OLD.amount
           OR NEW.voided_at IS DISTINCT FROM OLD.voided_at OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
           OR NEW.rent_amount IS DISTINCT FROM OLD.rent_amount THEN
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
