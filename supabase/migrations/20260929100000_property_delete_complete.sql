-- Property delete is complete, and restore brings back exactly what it took.
--
-- Audit theme L. Deleting (archiving) a property ran ~15 separate client
-- requests and still left live:
--   * utility_accounts and pending utility_bills  -> the portal sweep kept
--     reading the deleted property's accounts
--   * property_taxes and pending property_tax_bills -> the daily tax cron kept
--     emailing reminders for a property the app reports as gone
--   * property_licenses                          -> licence-expiry reminders
--   * portfolio_loan_properties                  -> the loan still listed it
--
-- archive_property_cascade() does the whole operational archive in ONE
-- transaction. Every row it archives gets the same archived_at as the
-- property itself (now() is fixed for the transaction), which is how
-- restore_property_cascade() tells "archived by the property delete" from
-- "archived separately by the user": only rows stamped with the property's
-- own archived_at come back. utility_accounts additionally carries
-- archived_reason = 'property_deleted' (the column already exists there).
--
-- Not touched here, deliberately:
--   * money history: paid utility bills, paid/skipped/voided tax bills and
--     partially paid utility bills stay live; journal entries / ledger / AR
--     accounts / classes are still handled by the client exactly as before
--   * security deposits: property delete does NOT forfeit them (owner decision)
--
-- portfolio_loan_properties had no archived_at; it gains one (the only new
-- column). Readers in Loans.js / Properties.js filter on it.

ALTER TABLE public.portfolio_loan_properties
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- ─── archive ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.archive_property_cascade(
  p_company_id text, p_property_id bigint, p_user_email text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_claims text := current_setting('request.jwt.claims', true);
  v_trusted boolean;
  v_ts timestamptz := now();
  v_by text;
  v_addr text;
  v_use_addr boolean;
  v_pid text := p_property_id::text;
  v_counts jsonb := '{}'::jsonb;
  n int;
BEGIN
  -- Caller check. SECURITY DEFINER runs as the owner, so the
  -- enforce_management_tier_destructive trigger (keyed on current_user =
  -- 'authenticated') does not fire in here; the same rule is applied
  -- explicitly: staff of this company AND management tier.
  v_trusted := v_claims IS NULL OR v_claims = '' OR (v_claims::jsonb ->> 'role') = 'service_role';
  IF NOT v_trusted THEN
    PERFORM public._assert_company_staff(p_company_id);
    IF NOT public.is_management_tier(p_company_id) THEN
      RAISE EXCEPTION 'Your role cannot delete this property — only a manager, owner, or admin can.'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  v_by := COALESCE(NULLIF(btrim(p_user_email), ''),
                   CASE WHEN v_trusted THEN 'system' ELSE v_claims::jsonb ->> 'email' END, 'system');

  SELECT address INTO v_addr FROM properties
   WHERE company_id = p_company_id AND id = p_property_id AND archived_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Property % is not a live property of this company', p_property_id USING ERRCODE = 'P0002';
  END IF;
  -- Children are keyed by address text (most have no property_id). If a
  -- second LIVE property carries the same address, matching by address would
  -- archive its records too -- fall back to property_id only.
  v_use_addr := NOT EXISTS (SELECT 1 FROM properties
                             WHERE company_id = p_company_id AND address = v_addr
                               AND id <> p_property_id AND archived_at IS NULL);

  UPDATE properties SET archived_at = v_ts, archived_by = v_by
   WHERE company_id = p_company_id AND id = p_property_id;

  -- Tenants (the client captured their names/ids first for the ledger work).
  UPDATE tenants SET archived_at = v_ts, archived_by = v_by, balance = NULL, lease_status = 'past'
   WHERE company_id = p_company_id AND archived_at IS NULL
     AND ((v_use_addr AND property = v_addr) OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('tenants', n);

  UPDATE leases SET status = 'terminated', updated_at = now()
   WHERE company_id = p_company_id AND archived_at IS NULL AND status = 'active'
     AND ((v_use_addr AND property = v_addr) OR property_id = p_property_id);
  UPDATE leases SET archived_at = v_ts, archived_by = v_by
   WHERE company_id = p_company_id AND archived_at IS NULL
     AND ((v_use_addr AND property = v_addr) OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('leases', n);

  UPDATE autopay_schedules SET enabled = false, archived_at = v_ts, archived_by = v_by
   WHERE company_id = p_company_id AND archived_at IS NULL
     AND ((v_use_addr AND property = v_addr) OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('autopay_schedules', n);
  -- An already-archived schedule left enabled must not charge either.
  UPDATE autopay_schedules SET enabled = false
   WHERE company_id = p_company_id AND enabled
     AND ((v_use_addr AND property = v_addr) OR property_id = p_property_id);

  UPDATE recurring_journal_entries SET status = 'inactive', archived_at = v_ts, archived_by = v_by, updated_at = now()
   WHERE company_id = p_company_id AND archived_at IS NULL AND v_use_addr AND property = v_addr;
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('recurring_journal_entries', n);

  UPDATE work_orders SET archived_at = v_ts, archived_by = v_by
   WHERE company_id = p_company_id AND archived_at IS NULL
     AND ((v_use_addr AND property = v_addr) OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('work_orders', n);

  UPDATE vendor_invoices SET archived_at = v_ts, archived_by = v_by
   WHERE company_id = p_company_id AND archived_at IS NULL AND v_use_addr AND property = v_addr;
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('vendor_invoices', n);

  UPDATE documents SET archived_at = v_ts, archived_by = v_by
   WHERE company_id = p_company_id AND archived_at IS NULL
     AND ((v_use_addr AND property = v_addr) OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('documents', n);

  UPDATE inspections SET archived_at = v_ts, archived_by = v_by
   WHERE company_id = p_company_id AND archived_at IS NULL AND v_use_addr AND property = v_addr;
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('inspections', n);

  UPDATE payments SET archived_at = v_ts
   WHERE company_id = p_company_id AND archived_at IS NULL
     AND ((v_use_addr AND property = v_addr) OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('payments', n);

  UPDATE hoa_payments SET archived_at = v_ts, archived_by = v_by
   WHERE company_id = p_company_id AND archived_at IS NULL
     AND ((v_use_addr AND property = v_addr) OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('hoa_payments', n);

  UPDATE property_loans SET archived_at = v_ts, archived_by = v_by, updated_at = now()
   WHERE company_id = p_company_id AND archived_at IS NULL
     AND ((v_use_addr AND property = v_addr) OR property_id = v_pid);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('property_loans', n);

  UPDATE property_insurance SET archived_at = v_ts, archived_by = v_by
   WHERE company_id = p_company_id AND archived_at IS NULL
     AND ((v_use_addr AND property = v_addr) OR property_id = v_pid);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('property_insurance', n);

  -- ── previously missed ──
  UPDATE property_licenses SET archived_at = v_ts, archived_by = v_by
   WHERE company_id = p_company_id AND archived_at IS NULL AND property_id = p_property_id;
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('property_licenses', n);

  UPDATE property_taxes SET archived_at = v_ts, archived_by = v_by, updated_at = now()
   WHERE company_id = p_company_id AND archived_at IS NULL
     AND ((v_use_addr AND property = v_addr) OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('property_taxes', n);

  -- Pending instalments only. Paid / skipped / voided bills are history.
  UPDATE property_tax_bills SET archived_at = v_ts, archived_by = v_by
   WHERE company_id = p_company_id AND archived_at IS NULL AND status = 'pending' AND paid_date IS NULL
     AND ((v_use_addr AND property = v_addr) OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('property_tax_bills_pending', n);

  -- utility_accounts BEFORE utilities: the bridge trigger on utilities would
  -- otherwise archive the linked account with no reason, and restore could
  -- not tell it from a user delete.
  UPDATE utility_accounts SET archived_at = v_ts, archived_reason = 'property_deleted', updated_at = now()
   WHERE company_id = p_company_id AND archived_at IS NULL
     AND ((v_use_addr AND property = v_addr) OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('utility_accounts', n);

  UPDATE utilities SET archived_at = v_ts, archived_by = v_by
   WHERE company_id = p_company_id AND archived_at IS NULL
     AND ((v_use_addr AND property = v_addr) OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('utilities', n);

  -- Unpaid bills only: nothing paid, nothing partially paid.
  UPDATE utility_bills b SET archived_at = v_ts, updated_at = now()
   WHERE b.company_id = p_company_id AND b.archived_at IS NULL
     AND b.paid_at IS NULL AND COALESCE(b.amount_paid, 0) = 0
     AND COALESCE(b.status, '') NOT IN ('paid', 'partial', 'settled')
     AND ((v_use_addr AND b.property = v_addr)
          OR b.utility_account_id IN (SELECT a.id FROM utility_accounts a
                                       WHERE a.company_id = p_company_id AND a.property_id = p_property_id));
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('utility_bills_pending', n);

  UPDATE portfolio_loan_properties SET archived_at = v_ts
   WHERE company_id = p_company_id AND archived_at IS NULL
     AND ((v_use_addr AND property = v_addr) OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('portfolio_loan_links', n);

  UPDATE property_setup_wizard SET status = 'dismissed', updated_at = now()
   WHERE company_id = p_company_id AND status = 'in_progress'
     AND ((v_use_addr AND property_address = v_addr) OR property_id::text = v_pid);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('setup_wizard_dismissed', n);

  RETURN jsonb_build_object('success', true, 'archived_at', v_ts, 'address', v_addr,
                            'matched_by_address', v_use_addr, 'archived', v_counts);
END;
$function$;

-- ─── restore ────────────────────────────────────────────────────────────
-- Brings back only rows stamped with the property's own archived_at.
-- Anything that moves money comes back PAUSED: autopay stays disabled and
-- recurring entries stay inactive until a person turns them back on.
-- Tenants (and their leases) come back only when p_restore_tenants.
CREATE OR REPLACE FUNCTION public.restore_property_cascade(
  p_company_id text, p_property_id bigint, p_restore_tenants boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_claims text := current_setting('request.jwt.claims', true);
  v_ts timestamptz;
  v_addr text;
  v_pid text := p_property_id::text;
  v_counts jsonb := '{}'::jsonb;
  v_tenant_ids int[] := '{}';
  n int;
BEGIN
  IF NOT (v_claims IS NULL OR v_claims = '' OR (v_claims::jsonb ->> 'role') = 'service_role') THEN
    PERFORM public._assert_company_staff(p_company_id);
    IF NOT public.is_management_tier(p_company_id) THEN
      RAISE EXCEPTION 'Your role cannot restore this property — only a manager, owner, or admin can.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT address, archived_at INTO v_addr, v_ts FROM properties
   WHERE company_id = p_company_id AND id = p_property_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Property % not found in this company', p_property_id USING ERRCODE = 'P0002';
  END IF;
  IF v_ts IS NULL THEN
    RETURN jsonb_build_object('success', true, 'already_live', true);
  END IF;
  IF EXISTS (SELECT 1 FROM properties WHERE company_id = p_company_id AND address = v_addr
               AND id <> p_property_id AND archived_at IS NULL) THEN
    RAISE EXCEPTION 'A live property already has the address "%". Rename or delete it before restoring this one.', v_addr
      USING ERRCODE = '23505';
  END IF;

  UPDATE properties SET archived_at = NULL, archived_by = NULL WHERE company_id = p_company_id AND id = p_property_id;

  IF p_restore_tenants THEN
    WITH r AS (
      UPDATE tenants SET archived_at = NULL, archived_by = NULL
       WHERE company_id = p_company_id AND archived_at = v_ts
         AND (property = v_addr OR property_id = p_property_id)
      RETURNING id)
    SELECT COALESCE(array_agg(id), '{}') INTO v_tenant_ids FROM r;
    v_counts := v_counts || jsonb_build_object('tenants', COALESCE(array_length(v_tenant_ids, 1), 0));

    UPDATE leases SET archived_at = NULL, archived_by = NULL
     WHERE company_id = p_company_id AND archived_at = v_ts
       AND (property = v_addr OR property_id = p_property_id);
    GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('leases', n);
    -- Reactivate only the leases of tenants that just came back -- not a
    -- lease terminated long ago for someone who moved out.
    UPDATE leases SET status = 'active', updated_at = now()
     WHERE company_id = p_company_id AND status = 'terminated' AND archived_at IS NULL
       AND tenant_id = ANY (v_tenant_ids)
       AND (property = v_addr OR property_id = p_property_id)
       AND (end_date IS NULL OR end_date >= CURRENT_DATE);
    -- The delete set every tenant to 'past'. A restored tenant is current
    -- again only if a lease of theirs is active again; a tenant who had
    -- already moved out (lease ended) stays 'past'.
    UPDATE tenants t SET lease_status = 'active'
     WHERE t.company_id = p_company_id AND t.id = ANY (v_tenant_ids)
       AND EXISTS (SELECT 1 FROM leases l WHERE l.company_id = p_company_id
                     AND l.tenant_id = t.id AND l.status = 'active' AND l.archived_at IS NULL);

    UPDATE autopay_schedules SET archived_at = NULL, archived_by = NULL      -- enabled stays false
     WHERE company_id = p_company_id AND archived_at = v_ts
       AND (property = v_addr OR property_id = p_property_id);
    GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('autopay_schedules_paused', n);

    UPDATE recurring_journal_entries SET archived_at = NULL, archived_by = NULL, updated_at = now()  -- stays inactive
     WHERE company_id = p_company_id AND archived_at = v_ts AND property = v_addr;
    GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('recurring_journal_entries_paused', n);

    UPDATE payments SET archived_at = NULL
     WHERE company_id = p_company_id AND archived_at = v_ts
       AND (property = v_addr OR property_id = p_property_id);
    GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('payments', n);
  END IF;

  UPDATE work_orders SET archived_at = NULL, archived_by = NULL
   WHERE company_id = p_company_id AND archived_at = v_ts AND (property = v_addr OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('work_orders', n);
  UPDATE vendor_invoices SET archived_at = NULL, archived_by = NULL
   WHERE company_id = p_company_id AND archived_at = v_ts AND property = v_addr;
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('vendor_invoices', n);
  UPDATE documents SET archived_at = NULL, archived_by = NULL
   WHERE company_id = p_company_id AND archived_at = v_ts AND (property = v_addr OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('documents', n);
  UPDATE inspections SET archived_at = NULL, archived_by = NULL
   WHERE company_id = p_company_id AND archived_at = v_ts AND property = v_addr;
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('inspections', n);
  UPDATE hoa_payments SET archived_at = NULL, archived_by = NULL
   WHERE company_id = p_company_id AND archived_at = v_ts AND (property = v_addr OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('hoa_payments', n);
  UPDATE property_loans SET archived_at = NULL, archived_by = NULL, updated_at = now()
   WHERE company_id = p_company_id AND archived_at = v_ts AND (property = v_addr OR property_id = v_pid);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('property_loans', n);
  UPDATE property_insurance SET archived_at = NULL, archived_by = NULL
   WHERE company_id = p_company_id AND archived_at = v_ts AND (property = v_addr OR property_id = v_pid);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('property_insurance', n);
  UPDATE property_licenses SET archived_at = NULL, archived_by = NULL
   WHERE company_id = p_company_id AND archived_at = v_ts AND property_id = p_property_id;
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('property_licenses', n);
  UPDATE property_taxes SET archived_at = NULL, archived_by = NULL, updated_at = now()
   WHERE company_id = p_company_id AND archived_at = v_ts AND (property = v_addr OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('property_taxes', n);
  UPDATE property_tax_bills SET archived_at = NULL, archived_by = NULL
   WHERE company_id = p_company_id AND archived_at = v_ts AND (property = v_addr OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('property_tax_bills', n);
  UPDATE utility_accounts SET archived_at = NULL, archived_reason = NULL, updated_at = now()
   WHERE company_id = p_company_id AND archived_at = v_ts AND archived_reason = 'property_deleted'
     AND (property = v_addr OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('utility_accounts', n);
  UPDATE utilities SET archived_at = NULL, archived_by = NULL
   WHERE company_id = p_company_id AND archived_at = v_ts AND (property = v_addr OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('utilities', n);
  UPDATE utility_bills b SET archived_at = NULL, updated_at = now()
   WHERE b.company_id = p_company_id AND b.archived_at = v_ts
     AND (b.property = v_addr OR b.utility_account_id IN (SELECT a.id FROM utility_accounts a
                                   WHERE a.company_id = p_company_id AND a.property_id = p_property_id));
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('utility_bills', n);
  UPDATE portfolio_loan_properties SET archived_at = NULL
   WHERE company_id = p_company_id AND archived_at = v_ts AND (property = v_addr OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('portfolio_loan_links', n);

  RETURN jsonb_build_object('success', true, 'address', v_addr, 'restored', v_counts);
END;
$function$;

REVOKE ALL ON FUNCTION public.archive_property_cascade(text, bigint, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.restore_property_cascade(text, bigint, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.archive_property_cascade(text, bigint, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.restore_property_cascade(text, bigint, boolean) TO authenticated, service_role;
