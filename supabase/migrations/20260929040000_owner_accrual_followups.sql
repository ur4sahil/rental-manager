-- Owner accrual follow-ups (QA round 4). TEST first; production only with
-- Sahil's explicit approval for THIS migration (it is database-wide).
-- No data is backfilled and no existing journal entry is changed.
--
--  1. Deleting journal lines now queues the tenant (AFTER DELETE statement
--     trigger over the old rows). update_journal_entry replaces a receipt's
--     lines by delete + insert; when the tenant-AR line was removed, the
--     accrual stayed live because only INSERT/UPDATE queued.
--  2. JE numbers under parallel posting. next_je_number reads MAX over
--     COMMITTED rows, so parallel receipts pick the same number and all but
--     one wait for the winner's commit, fail the unique index and retry; five
--     retries were not enough (8-11 of 24 parallel receipts failed).
--     post_je_and_ledger and the owner sync now CLAIM a number with
--     _je_number_claim(): a per-(company, number) advisory lock, taken with
--     try-lock and held to commit, on the first number above MAX that no one
--     else holds. Parallel callers take distinct numbers without waiting on
--     each other, so nothing is serialised (a single per-company lock held to
--     commit was measured too: it serialised every receipt INCLUDING its
--     commit-time owner sync, and 14/72 owner-managed receipts then hit the
--     8s statement timeout). A claimed number whose transaction rolls back
--     leaves a gap in the JE sequence; numbers are unique, not gap-free.
--     post_je_and_ledger keeps a retry (10, jittered backoff) for races with
--     the callers that still use bare next_je_number (post_bank_transaction,
--     batch_post_late_fees, _stripe_post_reversal_core, _repair_post --
--     unchanged here).
--  3. owner_accrual_sync_pending processes a bounded batch (p_max tenants,
--     ~4s) and returns how many remain; the Owners page and the nightly
--     integrity cron loop until none remain (or a batch makes no progress).
--  4. No NEEDS_SYNC markers (and no sync work) for tenants no owner is
--     involved with: _owner_accrual_tenant_relevant().

-- ── 4: is any owner involved with this tenant? ───────────────────────────
CREATE OR REPLACE FUNCTION public._owner_accrual_tenant_relevant(p_company_id text, p_tenant_id integer)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v_props integer[]; v_classes text[]; v_addrs text[]; v_ar uuid[];
BEGIN
  -- live accrual rows (they may need voiding or reversing)
  IF EXISTS (SELECT 1 FROM owner_distributions d
              WHERE d.company_id = p_company_id AND d.tenant_id = p_tenant_id
                AND d.kind = 'accrual' AND d.voided_at IS NULL) THEN RETURN true; END IF;
  -- the company's properties that have (had) an owner: usually a handful
  SELECT array_agg(DISTINCT h.property_id) INTO v_props FROM property_owner_history h WHERE h.company_id = p_company_id;
  IF v_props IS NULL THEN RETURN false; END IF;
  SELECT array_agg(p.class_id) FILTER (WHERE p.class_id IS NOT NULL), array_agg(p.address) FILTER (WHERE coalesce(p.address, '') <> '')
    INTO v_classes, v_addrs FROM properties p WHERE p.id = ANY (v_props);
  -- the tenant's current property
  IF EXISTS (SELECT 1 FROM tenants t WHERE t.company_id = p_company_id AND t.id = p_tenant_id AND t.property = ANY (v_addrs)) THEN RETURN true; END IF;
  -- a property one of the tenant's AR entries is keyed to (line class, or the entry's property)
  SELECT array_agg(a.id) INTO v_ar FROM acct_accounts a WHERE a.company_id = p_company_id AND a.tenant_id = p_tenant_id;
  IF v_ar IS NULL THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM acct_journal_lines l
                  WHERE l.company_id = p_company_id AND l.account_id = ANY (v_ar) AND l.class_id = ANY (v_classes))
      OR EXISTS (SELECT 1 FROM acct_journal_lines l JOIN acct_journal_entries j ON j.id = l.journal_entry_id
                  WHERE l.company_id = p_company_id AND l.account_id = ANY (v_ar) AND j.property = ANY (v_addrs));
END $$;
REVOKE ALL ON FUNCTION public._owner_accrual_tenant_relevant(text, integer) FROM PUBLIC, anon, authenticated;

-- ── 2: JE number claims ──────────────────────────────────────────────────
-- 'JE-' + at least 4 digits. (next_je_number's lpad(.., 4) TRUNCATES a
-- 5-digit number -- JE-10000 would come out as JE-1000 -- so it is not
-- reused here.)
CREATE OR REPLACE FUNCTION public._je_number_text(p_n bigint)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT 'JE-' || CASE WHEN length(p_n::text) >= 4 THEN p_n::text ELSE lpad(p_n::text, 4, '0') END
$$;
REVOKE ALL ON FUNCTION public._je_number_text(bigint) FROM PUBLIC, anon, authenticated;

-- The first free number above MAX (or above p_after, for a caller claiming
-- several in one transaction), held by a transaction-level advisory lock on
-- (hash of the company, number) until commit. try-lock only: never waits.
CREATE OR REPLACE FUNCTION public._je_number_claim(p_company_id text, p_after bigint DEFAULT 0)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v_n bigint; v_key integer := hashtext('je_number:' || p_company_id); v_num text; v_i integer := 0;
BEGIN
  IF coalesce(p_after, 0) > 0 THEN
    v_n := p_after + 1;
  ELSE
    SELECT coalesce(max(CAST(substring(number FROM 'JE-(\d+)$') AS bigint)), 0) + 1 INTO v_n
      FROM acct_journal_entries WHERE company_id = p_company_id AND number ~ '^JE-\d+$';
  END IF;
  LOOP
    v_num := public._je_number_text(v_n);
    IF pg_try_advisory_xact_lock(v_key, (v_n % 2147483647)::integer)
       AND NOT EXISTS (SELECT 1 FROM acct_journal_entries WHERE company_id = p_company_id AND number = v_num) THEN
      RETURN v_num;
    END IF;
    v_n := v_n + 1; v_i := v_i + 1;
    IF v_i > 10000 THEN RAISE EXCEPTION 'Could not claim a JE number for company %', p_company_id; END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public._je_number_claim(text, bigint) FROM PUBLIC, anon, authenticated;

-- ── 2: the allocation, numbering its entries with _je_number_claim ───────
-- (body identical to 20260928170000 apart from the header numbering)
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
  v_je_base bigint; v_try int; v_ok boolean; p_num text[] := '{}'; v_prev bigint := 0; v_num text;
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
    -- headers: numbers claimed like post_je_and_ledger's (_je_number_claim:
    -- a per-number advisory lock held to commit, so a parallel receipt never
    -- takes the same number and nobody waits); a very large batch numbers
    -- from one MAX instead (bounded lock count), retried on a number race
    v_try := 0; v_ok := false;
    WHILE NOT v_ok AND v_try < 6 LOOP
      v_try := v_try + 1;
      p_num := '{}';
      IF array_length(p_ref, 1) <= 64 THEN
        FOR k IN 1 .. array_length(p_ref, 1) LOOP
          v_num := public._je_number_claim(p_company_id, v_prev);
          p_num := p_num || v_num;
          v_prev := CAST(substring(v_num FROM 'JE-(\d+)$') AS bigint);
        END LOOP;
      ELSE
        v_je_base := greatest(coalesce((SELECT max(CAST(substring(number FROM 'JE-(\d+)$') AS bigint)) FROM acct_journal_entries
                                         WHERE company_id = p_company_id AND number ~ '^JE-\d+$'), 0), v_prev);
        SELECT array_agg(public._je_number_text(v_je_base + g) ORDER BY g) INTO p_num
          FROM generate_series(1, array_length(p_ref, 1)) g;
        v_prev := v_je_base + array_length(p_ref, 1);
      END IF;
      BEGIN
        INSERT INTO acct_journal_entries (company_id, number, date, description, reference, property, status)
        SELECT p_company_id, u.num, u.dt, u.dsc, u.ref,
               coalesce((SELECT address FROM properties WHERE id = u.prop), v_tenant.property, ''), 'posted'
          FROM unnest(p_ref, p_date, p_desc, p_prop, p_num) AS u(ref, dt, dsc, prop, num);
        v_ok := true;
      EXCEPTION WHEN unique_violation THEN
        IF v_try >= 6 THEN RAISE; END IF;
        PERFORM pg_sleep(random() * 0.05 * v_try);
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

-- ── 4: markers only for tenants an owner is involved with ────────────────
CREATE OR REPLACE FUNCTION public._owner_accrual_mark_pending(p_company_id text, p_tenant_id integer, p_error text, p_log boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
BEGIN
  BEGIN
    IF NOT public._owner_accrual_tenant_relevant(p_company_id, p_tenant_id) THEN RETURN; END IF;
  EXCEPTION WHEN OTHERS THEN NULL;   -- cannot tell: record it
  END;
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

-- ── 3: bounded drain ─────────────────────────────────────────────────────
-- Up to p_max tenants or ~4 seconds, least-attempted first (a tenant that
-- keeps failing moves to the back instead of starving the rest). Returns
-- {synced, failed, skipped, remaining}; callers loop while remaining > 0
-- and the batch made progress.
DROP FUNCTION IF EXISTS public.owner_accrual_sync_pending(text);
CREATE OR REPLACE FUNCTION public.owner_accrual_sync_pending(p_company_id text DEFAULT NULL, p_max integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE q record; v_done int := 0; v_failed int := 0; v_skipped int := 0; v_remaining int;
  v_claims text := current_setting('request.jwt.claims', true);
  v_old text := current_setting('lock_timeout');
  v_start timestamptz := clock_timestamp();
  v_max int := least(greatest(coalesce(p_max, 50), 1), 500);
BEGIN
  IF p_company_id IS NULL THEN
    IF v_claims IS NOT NULL AND v_claims <> '' AND coalesce(v_claims::jsonb ->> 'role', '') <> 'service_role' THEN
      RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
    END IF;
  ELSE
    PERFORM public._assert_company_staff(p_company_id);
  END IF;
  FOR q IN SELECT company_id, tenant_id, min(attempts) AS att FROM owner_accrual_queue
            WHERE needs_sync AND (p_company_id IS NULL OR company_id = p_company_id)
            GROUP BY company_id, tenant_id
            ORDER BY min(attempts), company_id, tenant_id LIMIT v_max
  LOOP
    EXIT WHEN clock_timestamp() - v_start > interval '4 seconds';
    IF NOT public._owner_accrual_tenant_relevant(q.company_id, q.tenant_id) THEN
      DELETE FROM owner_accrual_queue WHERE company_id = q.company_id AND tenant_id = q.tenant_id AND needs_sync;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
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
  SELECT count(*) INTO v_remaining FROM (
    SELECT DISTINCT company_id, tenant_id FROM owner_accrual_queue
     WHERE needs_sync AND (p_company_id IS NULL OR company_id = p_company_id)) s;
  RETURN jsonb_build_object('synced', v_done, 'failed', v_failed, 'skipped', v_skipped, 'remaining', v_remaining);
END $$;
REVOKE ALL ON FUNCTION public.owner_accrual_sync_pending(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_accrual_sync_pending(text, integer) TO authenticated, service_role;

-- ── 1: deleting lines queues the tenant too ──────────────────────────────
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
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO owner_accrual_queue (company_id, tenant_id)
    SELECT DISTINCT a.company_id, a.tenant_id::integer
      FROM old_rows o JOIN acct_accounts a ON a.id = o.account_id
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

DROP TRIGGER IF EXISTS trg_owner_accrual_enqueue_del ON public.acct_journal_lines;
CREATE TRIGGER trg_owner_accrual_enqueue_del AFTER DELETE ON public.acct_journal_lines
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public._owner_accrual_enqueue_lines();

-- ── 4: the commit-time runner skips tenants no owner is involved with ────
CREATE OR REPLACE FUNCTION public._owner_accrual_queue_run()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE q record; v_old text := current_setting('lock_timeout'); v_deferred int := 0; v_rel boolean;
BEGIN
  IF NEW.needs_sync THEN RETURN NULL; END IF;
  FOR q IN SELECT company_id, tenant_id FROM owner_accrual_queue
            WHERE txid = NEW.txid AND NOT needs_sync ORDER BY company_id, tenant_id
  LOOP
    DELETE FROM owner_accrual_queue WHERE company_id = q.company_id AND tenant_id = q.tenant_id AND txid = NEW.txid;
    BEGIN
      v_rel := public._owner_accrual_tenant_relevant(q.company_id, q.tenant_id);
    EXCEPTION WHEN OTHERS THEN v_rel := true;
    END;
    CONTINUE WHEN NOT v_rel;
    -- Time budget: a bulk write touching many owner tenants must not run the
    -- request into the 8s statement timeout. Past 4s into the transaction
    -- the remaining tenants become NEEDS_SYNC markers (drained by the Owners
    -- page, the pending RPC and the nightly integrity cron).
    IF clock_timestamp() - transaction_timestamp() > interval '4 seconds' THEN
      PERFORM public._owner_accrual_mark_pending(q.company_id, q.tenant_id, 'deferred: commit time budget (bulk write)', v_deferred = 0);
      v_deferred := v_deferred + 1;
      CONTINUE;
    END IF;
    BEGIN
      PERFORM set_config('lock_timeout', '3s', true);
      PERFORM public._owner_accrual_sync_core(q.company_id, q.tenant_id);
      PERFORM set_config('lock_timeout', v_old, true);
    EXCEPTION WHEN OTHERS THEN
      PERFORM public._owner_accrual_mark_pending(q.company_id, q.tenant_id, SQLSTATE || ' ' || SQLERRM);
      RAISE WARNING 'owner_accrual_sync(%, %) deferred: %', q.company_id, q.tenant_id, SQLERRM;
    END;
  END LOOP;
  PERFORM set_config('lock_timeout', v_old, true);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._owner_accrual_queue_run() FROM PUBLIC, anon, authenticated;

-- ── 2: post_je_and_ledger claims its number ──────────────────────────────
-- Also: a duplicate REFERENCE (idx_je_company_reference_unique) is raised as
-- the unique violation it is instead of being retried five times and
-- reported as "Could not generate unique JE number". The one app caller
-- (atomicPostJEAndLedger) treats every RPC error the same way -- it falls back
-- to autoPostJournalEntry, which recognises the duplicate reference as the
-- idempotent no-op it is -- so the app behaves as before.
CREATE OR REPLACE FUNCTION public.post_je_and_ledger(p_company_id text, p_date text, p_description text, p_reference text DEFAULT ''::text, p_property text DEFAULT ''::text, p_status text DEFAULT 'posted'::text, p_lines jsonb DEFAULT '[]'::jsonb, p_ledger_tenant text DEFAULT NULL::text, p_ledger_tenant_id bigint DEFAULT NULL::bigint, p_ledger_property text DEFAULT NULL::text, p_ledger_amount numeric DEFAULT 0, p_ledger_type text DEFAULT NULL::text, p_ledger_description text DEFAULT NULL::text, p_balance_change numeric DEFAULT 0)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE
  v_je_id uuid; v_je_number text; v_attempt int := 0; v_line jsonb;
  v_hit_tenant_ar boolean := false;
BEGIN
  PERFORM public._assert_company_staff(p_company_id);
  LOOP
    -- a number no parallel caller holds (see _je_number_claim)
    v_je_number := public._je_number_claim(p_company_id);
    BEGIN
      INSERT INTO acct_journal_entries (company_id, number, date, description, reference, property, status, transaction_type)
      VALUES (p_company_id, v_je_number, p_date::date, p_description, p_reference, p_property, p_status, COALESCE(p_ledger_type, 'charge'))
      RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      -- a duplicate reference is not a number race: report it as before
      IF SQLERRM NOT LIKE '%unique_je_number_per_company%' THEN RAISE; END IF;
      v_attempt := v_attempt + 1;
      IF v_attempt >= 10 THEN RAISE EXCEPTION 'Could not generate unique JE number after 10 attempts'; END IF;
      PERFORM pg_sleep(random() * 0.05 * v_attempt);   -- a caller without the lock: back off, re-read MAX
    END;
  END LOOP;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO acct_journal_lines (journal_entry_id, company_id, account_id, account_name, debit, credit, class_id, memo)
    VALUES (v_je_id, p_company_id, (v_line->>'account_id')::uuid, COALESCE(v_line->>'account_name', ''),
      COALESCE((v_line->>'debit')::numeric, 0), COALESCE((v_line->>'credit')::numeric, 0),
      NULLIF(v_line->>'class_id', ''), COALESCE(v_line->>'memo', ''));

    IF p_ledger_tenant_id IS NOT NULL AND NOT v_hit_tenant_ar THEN
      SELECT true INTO v_hit_tenant_ar
        FROM acct_accounts a
       WHERE a.id = (v_line->>'account_id')::uuid
         AND a.tenant_id = p_ledger_tenant_id;
      v_hit_tenant_ar := COALESCE(v_hit_tenant_ar, false);
    END IF;
  END LOOP;

  -- Only where the trigger did not already recompute it.
  IF p_ledger_tenant_id IS NOT NULL
     AND COALESCE(p_balance_change, 0) <> 0
     AND NOT v_hit_tenant_ar THEN
    UPDATE tenants
       SET balance = COALESCE(balance, 0) + p_balance_change
     WHERE id = p_ledger_tenant_id
       AND company_id = p_company_id;
  END IF;

  RETURN v_je_id;
END $$;
REVOKE ALL ON FUNCTION public.post_je_and_ledger(text, text, text, text, text, text, jsonb, text, bigint, text, numeric, text, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_je_and_ledger(text, text, text, text, text, text, jsonb, text, bigint, text, numeric, text, text, numeric) TO authenticated, service_role;
