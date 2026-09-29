-- Property delete, round 2 (independent QA of 20260929100000).
--
--  1. Journal entries are voided SERVER-side, in chunks, before the archive
--     (property_delete_begin -> property_delete_void_chunk* ->
--     archive_property_cascade). A delete is refused up front when any of the
--     property's live entries sits in a LOCKED period, and the refusal lists
--     them. Every entry the delete voids is recorded (property_deletion_voids)
--     so restore un-voids exactly those and nothing else.
--  2. _cascade_property_rename no longer rewrites a DELETED property's rows
--     (rows stamped by a deletion at the old address, and entries it voided).
--  3. The delete/restore sets app.property_cascade = on for its transaction;
--     _vpay_follow_void and the owner-accrual enqueue skip while it is on, so
--     deleting a property no longer reopens paid vendor invoices or rewrites
--     owner accruals. Tenant balances are recomputed once per chunk.
--  4. Restore skips (and names) a utility whose provider + account number was
--     re-added live elsewhere, instead of failing forever on the unique index.
--  5. (company_id, property) indexes on every child table the cascade touches.
--     A function-level statement_timeout does NOT extend the caller's timeout
--     (verified on TEST), so the heavy part -- voiding -- is chunked instead.
--  6. is_management_tier: one membership row must carry both the identity
--     (auth_user_id, else lower(email)) and a management role; portal roles
--     (tenant/owner) are not management. Case-insensitive unique membership
--     index, created only if no duplicates exist.
--  7. utility_accounts are matched by property_id, address OR a legacy link to
--     one of the property's utilities.
--  8. Address comparisons in the delete/restore are lower(btrim()); a
--     case-insensitive live-address unique index is created if no duplicates.
-- 10. A second delete re-stamps rows still archived from an earlier delete of
--     the same property (e.g. tenants left behind by a restore without them).
-- 11. Restored tenants get their balance recomputed from the ledger.
-- 12. archived_by comes from the caller's JWT, not a parameter.
-- 13. auto_fill_property_id ignores archived properties.

-- ─── bookkeeping ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.property_deletions (
  id           bigserial PRIMARY KEY,
  company_id   text NOT NULL,
  property_id  integer NOT NULL,
  address      text NOT NULL,
  stamp        timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'voiding'
               CHECK (status IN ('voiding', 'archived', 'restored', 'aborted')),
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived     jsonb,
  restored_at  timestamptz,
  restored_tenants boolean,
  restored     jsonb
);
CREATE INDEX IF NOT EXISTS idx_property_deletions_prop ON public.property_deletions (company_id, property_id, status);
CREATE INDEX IF NOT EXISTS idx_property_deletions_addr ON public.property_deletions (company_id, lower(btrim(address)));

CREATE TABLE IF NOT EXISTS public.property_deletion_voids (
  deletion_id  bigint NOT NULL REFERENCES public.property_deletions(id) ON DELETE CASCADE,
  je_id        text NOT NULL,
  prior_status text NOT NULL,
  restored_at  timestamptz,
  note         text,
  PRIMARY KEY (deletion_id, je_id)
);
CREATE INDEX IF NOT EXISTS idx_property_deletion_voids_je ON public.property_deletion_voids (je_id);

ALTER TABLE public.property_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_deletion_voids ENABLE ROW LEVEL SECURITY;
-- Staff may READ their company's deletion log; all writes go through the
-- SECURITY DEFINER functions below.
DROP POLICY IF EXISTS property_deletions_staff_read ON public.property_deletions;
CREATE POLICY property_deletions_staff_read ON public.property_deletions
  FOR SELECT TO authenticated USING (public.is_company_staff(company_id));
REVOKE ALL ON public.property_deletions, public.property_deletion_voids FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.property_deletions, public.property_deletion_voids FROM authenticated;
REVOKE ALL ON public.property_deletion_voids FROM authenticated;
GRANT SELECT ON public.property_deletions TO authenticated;
GRANT ALL ON public.property_deletions, public.property_deletion_voids TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.property_deletions_id_seq TO service_role;

-- ─── indexes the cascade needs ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tenants_company_property          ON public.tenants (company_id, property);
CREATE INDEX IF NOT EXISTS idx_leases_company_property           ON public.leases (company_id, property);
CREATE INDEX IF NOT EXISTS idx_autopay_company_property          ON public.autopay_schedules (company_id, property);
CREATE INDEX IF NOT EXISTS idx_rje_company_property              ON public.recurring_journal_entries (company_id, property);
CREATE INDEX IF NOT EXISTS idx_work_orders_company_property      ON public.work_orders (company_id, property);
CREATE INDEX IF NOT EXISTS idx_vendor_invoices_company_property  ON public.vendor_invoices (company_id, property);
CREATE INDEX IF NOT EXISTS idx_documents_company_property        ON public.documents (company_id, property);
CREATE INDEX IF NOT EXISTS idx_inspections_company_property      ON public.inspections (company_id, property);
CREATE INDEX IF NOT EXISTS idx_payments_company_property         ON public.payments (company_id, property);
CREATE INDEX IF NOT EXISTS idx_hoa_payments_company_property     ON public.hoa_payments (company_id, property);
CREATE INDEX IF NOT EXISTS idx_property_insurance_company_property ON public.property_insurance (company_id, property);
CREATE INDEX IF NOT EXISTS idx_property_tax_bills_company_property_all ON public.property_tax_bills (company_id, property);
CREATE INDEX IF NOT EXISTS idx_utilities_company_property        ON public.utilities (company_id, property);
CREATE INDEX IF NOT EXISTS idx_utility_accounts_company_property ON public.utility_accounts (company_id, property);
CREATE INDEX IF NOT EXISTS idx_utility_accounts_property_id      ON public.utility_accounts (property_id);
CREATE INDEX IF NOT EXISTS idx_utility_bills_company_property    ON public.utility_bills (company_id, property);
CREATE INDEX IF NOT EXISTS idx_utility_bills_account             ON public.utility_bills (utility_account_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_loan_props_company_property ON public.portfolio_loan_properties (company_id, property);
CREATE INDEX IF NOT EXISTS idx_acct_je_company_property          ON public.acct_journal_entries (company_id, property);

-- ─── 6. management tier on ONE membership row ────────────────────────────
CREATE OR REPLACE FUNCTION public.is_management_tier(p_company_id text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.company_members cm
     WHERE cm.company_id = p_company_id
       AND cm.status = 'active'
       -- 'owner' in company_members is the OWNER PORTAL role (see ROLES in
       -- App.js and is_company_staff), not a company principal.
       AND cm.role IN ('admin', 'pm', 'manager')
       AND ((auth.uid() IS NOT NULL AND cm.auth_user_id = auth.uid())
            OR (cm.auth_user_id IS NULL
                AND lower(cm.user_email) = lower(COALESCE(auth.email(),
                      current_setting('request.jwt.claims', true)::json->>'email'))))
  );
$function$;

DO $do$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM (SELECT 1 FROM public.company_members
                                 GROUP BY company_id, lower(user_email) HAVING count(*) > 1) d;
  IF n = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS company_members_company_lower_email_unique
      ON public.company_members (company_id, lower(user_email));
  ELSE
    RAISE NOTICE 'company_members: % case-duplicate (company, email) groups; unique index NOT created', n;
  END IF;
  SELECT count(*) INTO n FROM (SELECT 1 FROM public.properties WHERE archived_at IS NULL
                                 GROUP BY company_id, lower(btrim(address)) HAVING count(*) > 1) d;
  IF n = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_unique_address_ci
      ON public.properties (company_id, lower(btrim(address))) WHERE archived_at IS NULL;
  ELSE
    RAISE NOTICE 'properties: % case-duplicate live addresses; case-insensitive unique index NOT created', n;
  END IF;
END
$do$;

-- ─── 3. cascade flag in the follow-triggers (inserted, bodies otherwise untouched)
-- Each patch is skipped (with a NOTICE) when the function is not installed.
-- _owner_accrual_enqueue_entries comes with the owners work (20260928170000);
-- if a later migration redefines it, it must keep the same first line --
--   IF current_setting('app.property_cascade', true) = 'on' THEN RETURN NULL; END IF;
-- -- or a property delete applied after it would rewrite owner accruals.
DO $do$
DECLARE src text; n int;
BEGIN
  src := (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public._vpay_follow_void()'));
  IF src IS NULL THEN
    RAISE NOTICE 'public._vpay_follow_void() is not installed here; cascade flag not added';
  ELSIF position('app.property_cascade' IN src) = 0 THEN
    n := length(src);
    src := regexp_replace(src, '\mBEGIN\M', E'BEGIN\n  -- A property delete/restore voids and un-voids its own entries; the\n  -- invoice is archived with the property and must stay as it was.\n  IF current_setting(''app.property_cascade'', true) = ''on'' THEN RETURN NEW; END IF;', '');
    IF length(src) = n THEN RAISE EXCEPTION '_vpay_follow_void: BEGIN not found'; END IF;
    EXECUTE format('CREATE OR REPLACE FUNCTION public._vpay_follow_void() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'', ''pg_temp'' AS %L', src);
  END IF;

  src := (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public._owner_accrual_enqueue_entries()'));
  IF src IS NULL THEN
    RAISE NOTICE 'public._owner_accrual_enqueue_entries() is not installed here; cascade flag not added';
  ELSIF position('app.property_cascade' IN src) = 0 THEN
    n := length(src);
    src := regexp_replace(src, '\mBEGIN\M', E'BEGIN\n  IF current_setting(''app.property_cascade'', true) = ''on'' THEN RETURN NULL; END IF;', '');
    IF length(src) = n THEN RAISE EXCEPTION '_owner_accrual_enqueue_entries: BEGIN not found'; END IF;
    EXECUTE format('CREATE OR REPLACE FUNCTION public._owner_accrual_enqueue_entries() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'', ''pg_temp'' AS %L', src);
  END IF;

  src := (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.trg_sync_balance_from_je_status()'));
  IF src IS NULL THEN
    RAISE NOTICE 'public.trg_sync_balance_from_je_status() is not installed here; cascade flag not added';
  ELSIF position('app.property_cascade' IN src) = 0 THEN
    n := length(src);
    src := regexp_replace(src, '\mBEGIN\M', E'BEGIN\n  -- The property cascade recomputes each affected tenant once per chunk.\n  IF current_setting(''app.property_cascade'', true) = ''on'' THEN RETURN NEW; END IF;', '');
    IF length(src) = n THEN RAISE EXCEPTION 'trg_sync_balance_from_je_status: BEGIN not found'; END IF;
    EXECUTE format('CREATE OR REPLACE FUNCTION public.trg_sync_balance_from_je_status() RETURNS trigger LANGUAGE plpgsql AS %L', src);
  END IF;

  -- Tenant rows archived/restored by the cascade re-derive the property's
  -- occupancy once at the end, not twice per row (4,000 tenants timed out).
  src := (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.trg_tenants_sync_property()'));
  IF src IS NULL THEN
    RAISE NOTICE 'public.trg_tenants_sync_property() is not installed here; cascade flag not added';
  ELSIF position('app.property_cascade' IN src) = 0 THEN
    n := length(src);
    src := regexp_replace(src, '\mBEGIN\M', E'BEGIN\n  IF current_setting(''app.property_cascade'', true) = ''on'' THEN RETURN NULL; END IF;', '');
    IF length(src) = n THEN RAISE EXCEPTION 'trg_tenants_sync_property: BEGIN not found'; END IF;
    EXECUTE format('CREATE OR REPLACE FUNCTION public.trg_tenants_sync_property() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'', ''pg_temp'' AS %L', src);
  END IF;
END
$do$;

-- ─── 13. auto_fill_property_id: live properties only ─────────────────────
CREATE OR REPLACE FUNCTION public.auto_fill_property_id()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.property_id IS NULL AND NEW.property IS NOT NULL AND NEW.company_id IS NOT NULL THEN
    -- Never attach a new row to a DELETED property that shared the address.
    SELECT id INTO NEW.property_id FROM properties
    WHERE address = NEW.property AND company_id = NEW.company_id AND archived_at IS NULL LIMIT 1;
  END IF;
  RETURN NEW;
END;
$function$;

-- ─── 2. rename cascade leaves a deleted property's rows alone ────────────
CREATE OR REPLACE FUNCTION public._cascade_property_rename(p_company_id text, p_old text, p_new text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- Stamps of deleted properties that carried the old address. Rows archived
  -- with one of these belong to that deleted property, not to the property
  -- being renamed (a deleted address is commonly re-added and then renamed).
  s timestamptz[];
BEGIN
  IF p_old IS NULL OR p_new IS NULL OR p_old = p_new THEN RETURN; END IF;
  s := ARRAY(
    SELECT d.stamp FROM property_deletions d
     WHERE d.company_id = p_company_id AND lower(btrim(d.address)) = lower(btrim(p_old))
       AND d.status IN ('archived', 'restored')
    UNION
    SELECT p.archived_at FROM properties p
     WHERE p.company_id = p_company_id AND p.address = p_old AND p.archived_at IS NOT NULL);

  UPDATE tenants               SET property = p_new WHERE company_id = p_company_id AND property = p_old AND (archived_at IS NULL OR archived_at <> ALL (s));
  UPDATE payments              SET property = p_new WHERE company_id = p_company_id AND property = p_old AND (archived_at IS NULL OR archived_at <> ALL (s));
  UPDATE leases                SET property = p_new WHERE company_id = p_company_id AND property = p_old AND (archived_at IS NULL OR archived_at <> ALL (s));
  UPDATE work_orders           SET property = p_new WHERE company_id = p_company_id AND property = p_old AND (archived_at IS NULL OR archived_at <> ALL (s));
  UPDATE documents             SET property = p_new WHERE company_id = p_company_id AND property = p_old AND (archived_at IS NULL OR archived_at <> ALL (s));
  UPDATE utilities             SET property = p_new WHERE company_id = p_company_id AND property = p_old AND (archived_at IS NULL OR archived_at <> ALL (s));
  -- Entries a delete voided belong to the deleted property.
  UPDATE acct_journal_entries  SET property = p_new WHERE company_id = p_company_id AND property = p_old
     AND NOT EXISTS (SELECT 1 FROM property_deletion_voids v JOIN property_deletions d ON d.id = v.deletion_id
                      WHERE v.je_id = acct_journal_entries.id AND v.restored_at IS NULL
                        AND d.company_id = p_company_id AND d.status = 'archived');

  UPDATE autopay_schedules         SET property = p_new WHERE company_id = p_company_id AND property = p_old AND (archived_at IS NULL OR archived_at <> ALL (s));
  UPDATE doc_exception_requests    SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE eviction_cases            SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE hoa_payments              SET property = p_new WHERE company_id = p_company_id AND property = p_old AND (archived_at IS NULL OR archived_at <> ALL (s));
  UPDATE inspections               SET property = p_new WHERE company_id = p_company_id AND property = p_old AND (archived_at IS NULL OR archived_at <> ALL (s));
  UPDATE property_insurance        SET property = p_new WHERE company_id = p_company_id AND property = p_old AND (archived_at IS NULL OR archived_at <> ALL (s));
  UPDATE property_loans            SET property = p_new WHERE company_id = p_company_id AND property = p_old AND (archived_at IS NULL OR archived_at <> ALL (s));
  UPDATE property_taxes            SET property = p_new WHERE company_id = p_company_id AND property = p_old AND (archived_at IS NULL OR archived_at <> ALL (s));
  UPDATE property_tax_bills        SET property = p_new WHERE company_id = p_company_id AND property = p_old AND (archived_at IS NULL OR archived_at <> ALL (s));
  UPDATE recurring_journal_entries SET property = p_new WHERE company_id = p_company_id AND property = p_old AND (archived_at IS NULL OR archived_at <> ALL (s));
  UPDATE tenant_invite_codes       SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE utility_accounts          SET property = p_new WHERE company_id = p_company_id AND property = p_old AND (archived_at IS NULL OR archived_at <> ALL (s));
  UPDATE utility_audit             SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE utility_bills             SET property = p_new WHERE company_id = p_company_id AND property = p_old AND (archived_at IS NULL OR archived_at <> ALL (s));
  UPDATE vendor_invoices           SET property = p_new WHERE company_id = p_company_id AND property = p_old AND (archived_at IS NULL OR archived_at <> ALL (s));
  UPDATE work_order_photos         SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE portfolio_loan_properties SET property = p_new WHERE company_id = p_company_id AND property = p_old AND (archived_at IS NULL OR archived_at <> ALL (s));
  UPDATE messages                  SET property = p_new WHERE company_id = p_company_id AND property = p_old;

  IF NOT EXISTS (SELECT 1 FROM acct_classes
                  WHERE company_id = p_company_id AND name = p_new) THEN
    UPDATE acct_classes SET name = p_new
     WHERE company_id = p_company_id AND name = p_old;
  END IF;

  UPDATE property_setup_wizard SET property_address = p_new
   WHERE company_id = p_company_id AND property_address = p_old;
END;
$function$;
REVOKE ALL ON FUNCTION public._cascade_property_rename(text, text, text) FROM PUBLIC, anon, authenticated;

-- ─── caller check shared by every function below ─────────────────────────
-- Returns the caller's email (the audit identity), 'system' for a trusted
-- server call (no JWT, or the service role).
CREATE OR REPLACE FUNCTION public._assert_property_manager(p_company_id text)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_claims text := current_setting('request.jwt.claims', true);
BEGIN
  IF v_claims IS NULL OR v_claims = '' OR (v_claims::jsonb ->> 'role') = 'service_role' THEN
    RETURN 'system';
  END IF;
  PERFORM public._assert_company_staff(p_company_id);
  IF NOT public.is_management_tier(p_company_id) THEN
    RAISE EXCEPTION 'Your role cannot delete or restore a property — only a manager or admin can.'
      USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(v_claims::jsonb ->> 'email', 'unknown');
END;
$function$;
REVOKE ALL ON FUNCTION public._assert_property_manager(text) FROM PUBLIC, anon, authenticated;

-- Entries of this property that a delete would void but cannot (locked period).
CREATE OR REPLACE FUNCTION public._property_locked_entries(p_company_id text, p_address text)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', j.id, 'number', j.number, 'date', j.date,
                                               'description', j.description) ORDER BY j.date, j.number), '[]'::jsonb)
    FROM (SELECT je.id, je.number, je.date, je.description
            FROM acct_journal_entries je
            JOIN accounting_period_lock l ON l.company_id = je.company_id
           WHERE je.company_id = p_company_id AND je.property = p_address
             AND je.date <= l.lock_date
             AND je.status <> 'voided'
           ORDER BY je.date, je.number
           LIMIT 50) j;
$function$;
REVOKE ALL ON FUNCTION public._property_locked_entries(text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._recompute_live_tenants_for_entries(p_je_ids text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t bigint;
BEGIN
  FOR t IN SELECT DISTINCT a.tenant_id
             FROM acct_journal_lines jl JOIN acct_accounts a ON a.id = jl.account_id
             JOIN tenants tt ON tt.id = a.tenant_id AND tt.archived_at IS NULL
            WHERE jl.journal_entry_id = ANY (p_je_ids) AND a.tenant_id IS NOT NULL
  LOOP
    PERFORM public.recompute_tenant_balance(t);
  END LOOP;
END;
$function$;
REVOKE ALL ON FUNCTION public._recompute_live_tenants_for_entries(text[]) FROM PUBLIC, anon, authenticated;

-- ─── 1. begin: checks, locked-period refusal, a deletion row ─────────────
CREATE OR REPLACE FUNCTION public.property_delete_begin(p_company_id text, p_property_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_by text;
  v_addr text;
  v_locked jsonb;
  v_n int;
  v_del property_deletions%ROWTYPE;
BEGIN
  v_by := public._assert_property_manager(p_company_id);
  SELECT address INTO v_addr FROM properties
   WHERE company_id = p_company_id AND id = p_property_id AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Property % is not a live property of this company', p_property_id USING ERRCODE = 'P0002';
  END IF;

  v_locked := public._property_locked_entries(p_company_id, v_addr);
  IF jsonb_array_length(v_locked) > 0 THEN
    SELECT count(*) INTO v_n FROM acct_journal_entries je JOIN accounting_period_lock l ON l.company_id = je.company_id
     WHERE je.company_id = p_company_id AND je.property = v_addr AND je.status <> 'voided' AND je.date <= l.lock_date;
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = format('This property has %s journal entr%s in a locked accounting period, which cannot be voided. Nothing was deleted. Unlock the period or move those entries first.',
                       v_n, CASE WHEN v_n = 1 THEN 'y' ELSE 'ies' END),
      DETAIL = v_locked::text;
  END IF;

  -- Resume an interrupted delete of this property rather than start another.
  SELECT * INTO v_del FROM property_deletions
   WHERE company_id = p_company_id AND property_id = p_property_id AND status = 'voiding'
   ORDER BY id DESC LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO property_deletions (company_id, property_id, address, created_by)
    VALUES (p_company_id, p_property_id, v_addr, v_by) RETURNING * INTO v_del;
  END IF;

  SELECT count(*) INTO v_n FROM acct_journal_entries
   WHERE company_id = p_company_id AND property = v_addr AND status <> 'voided';
  RETURN jsonb_build_object('deletion_id', v_del.id, 'stamp', v_del.stamp, 'address', v_addr,
                            'entries_to_void', v_n);
END;
$function$;

-- ─── 1. void a chunk of this property's entries ──────────────────────────
CREATE OR REPLACE FUNCTION public.property_delete_void_chunk(p_deletion_id bigint, p_limit int DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_del property_deletions%ROWTYPE;
  v_addr text;
  v_ids text[];
  v_left int;
BEGIN
  SELECT * INTO v_del FROM property_deletions WHERE id = p_deletion_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown deletion %', p_deletion_id USING ERRCODE = 'P0002'; END IF;
  PERFORM public._assert_property_manager(v_del.company_id);
  IF v_del.status <> 'voiding' THEN
    RAISE EXCEPTION 'Deletion % is %, not in progress', p_deletion_id, v_del.status USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.property_cascade', 'on', true);

  -- A rename between chunks moves the entries to the new address; follow it.
  -- FOR UPDATE also keeps a rename from running while this chunk works.
  SELECT address INTO v_addr FROM properties
   WHERE company_id = v_del.company_id AND id = v_del.property_id AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Property % is no longer live', v_del.property_id USING ERRCODE = 'P0002';
  END IF;
  IF v_addr IS DISTINCT FROM v_del.address THEN
    UPDATE property_deletions SET address = v_addr WHERE id = p_deletion_id;
    v_del.address := v_addr;
  END IF;

  v_ids := ARRAY(SELECT id FROM acct_journal_entries
                  WHERE company_id = v_del.company_id AND property = v_del.address AND status <> 'voided'
                  ORDER BY id LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 500))
                  FOR UPDATE);
  IF array_length(v_ids, 1) > 0 THEN
    INSERT INTO property_deletion_voids (deletion_id, je_id, prior_status)
    SELECT p_deletion_id, id, status FROM acct_journal_entries WHERE id = ANY (v_ids)
    ON CONFLICT (deletion_id, je_id) DO NOTHING;
    -- The period-lock trigger still runs: an entry locked since begin raises
    -- here and this chunk rolls back whole.
    UPDATE acct_journal_entries SET status = 'voided' WHERE id = ANY (v_ids);
    PERFORM public._recompute_live_tenants_for_entries(v_ids);
  END IF;

  SELECT count(*) INTO v_left FROM acct_journal_entries
   WHERE company_id = v_del.company_id AND property = v_del.address AND status <> 'voided';
  RETURN jsonb_build_object('voided', COALESCE(array_length(v_ids, 1), 0), 'remaining', v_left);
END;
$function$;

-- ─── un-void a chunk: abort of an unfinished delete, or restore ──────────
CREATE OR REPLACE FUNCTION public.property_delete_unvoid_chunk(p_deletion_id bigint, p_limit int DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_del property_deletions%ROWTYPE;
  v_lock date;
  v_ids text[];
  v_done text[];
  v_left int;
  v_skipped jsonb;
  v_blocked jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_del FROM property_deletions WHERE id = p_deletion_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown deletion %', p_deletion_id USING ERRCODE = 'P0002'; END IF;
  PERFORM public._assert_property_manager(v_del.company_id);
  -- voiding  = cancelling an unfinished delete (property still live)
  -- archived = before a restore; restored = finishing a restore's backlog
  IF v_del.status NOT IN ('voiding', 'archived', 'restored') THEN
    RAISE EXCEPTION 'Deletion % is %; nothing to un-void', p_deletion_id, v_del.status USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.property_cascade', 'on', true);
  SELECT lock_date INTO v_lock FROM accounting_period_lock WHERE company_id = v_del.company_id;

  v_ids := ARRAY(SELECT v.je_id FROM property_deletion_voids v
                  WHERE v.deletion_id = p_deletion_id AND v.restored_at IS NULL
                  ORDER BY v.je_id LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 500)));

  -- Left voided, and said so: an entry now in a locked period, one whose
  -- reference a live entry has since taken, or one someone else un-voided.
  -- Cancelling an unfinished delete must not give up on an entry because its
  -- period was locked meanwhile: that would leave a LIVE property with half its
  -- books voided. Locked entries stay pending (reported as blocked) so a later
  -- cancel -- after unlocking -- re-posts them. A restore, by contrast, leaves
  -- them voided for good: the closed period already reflects the void.
  IF v_del.status = 'voiding' AND v_lock IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', je.id, 'number', je.number, 'date', je.date)), '[]'::jsonb)
      INTO v_blocked
      FROM property_deletion_voids v JOIN acct_journal_entries je ON je.id = v.je_id
     WHERE v.deletion_id = p_deletion_id AND v.restored_at IS NULL AND je.status = 'voided' AND je.date <= v_lock;
    v_ids := ARRAY(SELECT x FROM unnest(v_ids) x
                    WHERE NOT EXISTS (SELECT 1 FROM acct_journal_entries je
                                       WHERE je.id = x AND je.status = 'voided' AND je.date <= v_lock));
  END IF;

  -- Entries that cannot be re-posted are marked done-with-a-note, in one pass
  -- over THIS chunk's rows only. (This used to join the voids table to itself
  -- and test the reference clash without the `reference <> ''` predicate, so
  -- the partial unique index on (company_id, reference) could not be used and
  -- every row scanned the company's entries: 10-14s for a 200-row chunk.)
  WITH cand AS (
    SELECT v.je_id, je.id AS jid, je.status, je.date, je.reference, je.company_id
      FROM property_deletion_voids v
      LEFT JOIN acct_journal_entries je ON je.id = v.je_id
     WHERE v.deletion_id = p_deletion_id AND v.je_id = ANY (v_ids) AND v.restored_at IS NULL),
  bad AS (
    SELECT c.je_id,
           CASE WHEN c.jid IS NULL THEN 'entry no longer exists'
                WHEN c.status <> 'voided' THEN 'already live'
                WHEN v_lock IS NOT NULL AND c.date <= v_lock THEN 'locked period'
                ELSE 'reference now used by another live entry' END AS why
      FROM cand c
     WHERE c.jid IS NULL OR c.status <> 'voided'
        OR (v_lock IS NOT NULL AND c.date <= v_lock)
        OR (COALESCE(c.reference, '') <> '' AND EXISTS (
              SELECT 1 FROM acct_journal_entries o
               WHERE o.company_id = c.company_id AND o.reference = c.reference
                 AND o.status <> 'voided' AND o.reference <> ''   -- = idx_je_company_reference_unique's predicate
                 AND o.id <> c.jid))),
  s AS (
    UPDATE property_deletion_voids v SET restored_at = now(), note = b.why
      FROM bad b
     WHERE v.deletion_id = p_deletion_id AND v.je_id = b.je_id
    RETURNING v.je_id, v.note)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', je_id, 'why', note)), '[]'::jsonb) INTO v_skipped FROM s;

  v_done := ARRAY(SELECT v.je_id FROM property_deletion_voids v
                   WHERE v.deletion_id = p_deletion_id AND v.je_id = ANY (v_ids) AND v.restored_at IS NULL);
  UPDATE acct_journal_entries je SET status = v.prior_status
    FROM property_deletion_voids v
   WHERE v.deletion_id = p_deletion_id AND v.je_id = je.id AND je.id = ANY (v_done);
  UPDATE property_deletion_voids SET restored_at = now()
   WHERE deletion_id = p_deletion_id AND je_id = ANY (v_done);
  IF array_length(v_done, 1) > 0 THEN PERFORM public._recompute_live_tenants_for_entries(v_done); END IF;

  SELECT count(*) INTO v_left FROM property_deletion_voids WHERE deletion_id = p_deletion_id AND restored_at IS NULL;
  IF v_left = 0 AND v_del.status = 'voiding' THEN
    UPDATE property_deletions SET status = 'aborted' WHERE id = p_deletion_id;
  END IF;
  -- 'blocked' entries are still pending: remaining > 0 with nothing done
  -- means stop and ask for the period to be unlocked.
  RETURN jsonb_build_object('unvoided', COALESCE(array_length(v_done, 1), 0), 'remaining', v_left,
                            'left_voided', v_skipped, 'blocked_by_lock', v_blocked);
END;
$function$;

-- ─── archive (now takes the deletion; the old 3-arg form is dropped) ─────
DROP FUNCTION IF EXISTS public.archive_property_cascade(text, bigint, text);

CREATE OR REPLACE FUNCTION public.archive_property_cascade(
  p_company_id text, p_property_id bigint, p_deletion_id bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_by text;
  v_del property_deletions%ROWTYPE;
  v_ts timestamptz;
  v_addr text;
  v_use_addr boolean;
  v_pid text := p_property_id::text;
  v_prior timestamptz[];
  v_left int;
  v_counts jsonb := '{}'::jsonb;
  v_tenant_ids int[];
  v_class text;
  r jsonb;
  n int;
BEGIN
  v_by := public._assert_property_manager(p_company_id);
  SELECT address, class_id INTO v_addr, v_class FROM properties
   WHERE company_id = p_company_id AND id = p_property_id AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Property % is not a live property of this company', p_property_id USING ERRCODE = 'P0002';
  END IF;

  IF p_deletion_id IS NULL THEN
    r := public.property_delete_begin(p_company_id, p_property_id);
    p_deletion_id := (r->>'deletion_id')::bigint;
  END IF;
  SELECT * INTO v_del FROM property_deletions WHERE id = p_deletion_id FOR UPDATE;
  IF NOT FOUND OR v_del.company_id <> p_company_id OR v_del.property_id <> p_property_id OR v_del.status <> 'voiding' THEN
    RAISE EXCEPTION 'Deletion % does not belong to this property or is not in progress', p_deletion_id USING ERRCODE = 'P0001';
  END IF;

  -- Void whatever is left (a small remainder, or an entry posted meanwhile).
  -- A large remainder means the caller skipped the chunked void.
  SELECT count(*) INTO v_left FROM acct_journal_entries
   WHERE company_id = p_company_id AND property = v_addr AND status <> 'voided';
  IF v_left > 300 THEN
    RAISE EXCEPTION '% journal entries still to void; call property_delete_void_chunk first', v_left USING ERRCODE = 'P0001';
  END IF;
  WHILE v_left > 0 LOOP
    r := public.property_delete_void_chunk(p_deletion_id, 300);
    v_left := (r->>'remaining')::int;
  END LOOP;
  PERFORM set_config('app.property_cascade', 'on', true);

  v_ts := v_del.stamp;
  v_use_addr := NOT EXISTS (SELECT 1 FROM properties
                             WHERE company_id = p_company_id AND lower(btrim(address)) = lower(btrim(v_addr))
                               AND id <> p_property_id AND archived_at IS NULL);

  UPDATE properties SET archived_at = v_ts, archived_by = v_by
   WHERE company_id = p_company_id AND id = p_property_id;

  -- 10. Rows an earlier delete of THIS property archived and a restore left
  -- archived (e.g. tenants when restored without them) join this delete, so
  -- the next restore can bring them back.
  v_prior := ARRAY(SELECT stamp FROM property_deletions
                    WHERE company_id = p_company_id AND property_id = p_property_id
                      AND status = 'restored' AND id <> p_deletion_id);
  IF array_length(v_prior, 1) > 0 THEN
    UPDATE tenants SET archived_at = v_ts WHERE company_id = p_company_id AND archived_at = ANY (v_prior) AND (property = v_addr OR property_id = p_property_id);
    UPDATE leases SET archived_at = v_ts WHERE company_id = p_company_id AND archived_at = ANY (v_prior) AND (property = v_addr OR property_id = p_property_id);
    UPDATE autopay_schedules SET archived_at = v_ts WHERE company_id = p_company_id AND archived_at = ANY (v_prior) AND (property = v_addr OR property_id = p_property_id);
    UPDATE recurring_journal_entries SET archived_at = v_ts WHERE company_id = p_company_id AND archived_at = ANY (v_prior) AND property = v_addr;
    UPDATE payments SET archived_at = v_ts WHERE company_id = p_company_id AND archived_at = ANY (v_prior) AND (property = v_addr OR property_id = p_property_id);
    UPDATE utilities SET archived_at = v_ts WHERE company_id = p_company_id AND archived_at = ANY (v_prior) AND (property = v_addr OR property_id = p_property_id);
    UPDATE utility_accounts SET archived_at = v_ts WHERE company_id = p_company_id AND archived_at = ANY (v_prior) AND archived_reason = 'property_deleted';
    UPDATE utility_bills SET archived_at = v_ts WHERE company_id = p_company_id AND archived_at = ANY (v_prior) AND property = v_addr;
  END IF;

  WITH t AS (
    UPDATE tenants SET archived_at = v_ts, archived_by = v_by, balance = NULL, lease_status = 'past'
     WHERE company_id = p_company_id AND archived_at IS NULL
       AND ((v_use_addr AND property = v_addr) OR property_id = p_property_id)
    RETURNING id)
  SELECT COALESCE(array_agg(id), '{}') INTO v_tenant_ids FROM t;
  v_counts := v_counts || jsonb_build_object('tenants', COALESCE(array_length(v_tenant_ids, 1), 0));
  -- Their AR sub-accounts leave the pickers; restore re-activates them.
  -- guard_no_deactivate_nonzero_ledger refuses to hide a ledger that still
  -- holds a posted balance (for instance from an entry not tagged to this
  -- property, so not voided here). That must not make the property
  -- undeletable: such a ledger stays active and is reported.
  WITH bal AS (
    SELECT a.id, a.name, COALESCE((SELECT sum(COALESCE(l.debit,0) - COALESCE(l.credit,0))
                                     FROM acct_journal_lines l JOIN acct_journal_entries je ON je.id::text = l.journal_entry_id::text
                                    WHERE l.account_id::text = a.id::text AND l.company_id = a.company_id
                                      AND je.status = 'posted'), 0) AS b
      FROM acct_accounts a
     WHERE a.company_id = p_company_id AND a.tenant_id = ANY (v_tenant_ids::bigint[]) AND a.is_active)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('account', name, 'balance', round(b, 2))) FILTER (WHERE abs(b) > 0.005), '[]'::jsonb)
    INTO r FROM bal;
  v_counts := v_counts || jsonb_build_object('ar_accounts_left_active', r);
  UPDATE acct_accounts a SET is_active = false
   WHERE a.company_id = p_company_id AND a.tenant_id = ANY (v_tenant_ids::bigint[]) AND a.is_active
     AND abs(COALESCE((SELECT sum(COALESCE(l.debit,0) - COALESCE(l.credit,0))
                         FROM acct_journal_lines l JOIN acct_journal_entries je ON je.id::text = l.journal_entry_id::text
                        WHERE l.account_id::text = a.id::text AND l.company_id = a.company_id
                          AND je.status = 'posted'), 0)) <= 0.005;

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

  UPDATE property_licenses SET archived_at = v_ts, archived_by = v_by
   WHERE company_id = p_company_id AND archived_at IS NULL AND property_id = p_property_id;
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('property_licenses', n);

  UPDATE property_taxes SET archived_at = v_ts, archived_by = v_by, updated_at = now()
   WHERE company_id = p_company_id AND archived_at IS NULL
     AND ((v_use_addr AND property = v_addr) OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('property_taxes', n);

  UPDATE property_tax_bills SET archived_at = v_ts, archived_by = v_by
   WHERE company_id = p_company_id AND archived_at IS NULL AND status = 'pending' AND paid_date IS NULL
     AND ((v_use_addr AND property = v_addr) OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('property_tax_bills_pending', n);

  -- 7. By id, by address, or linked to one of this property's utilities (an
  -- account whose own address drifted). Before utilities: the bridge trigger
  -- would otherwise archive linked accounts with no reason.
  UPDATE utility_accounts a SET archived_at = v_ts, archived_reason = 'property_deleted', updated_at = now()
   WHERE a.company_id = p_company_id AND a.archived_at IS NULL
     AND ((v_use_addr AND a.property = v_addr) OR a.property_id = p_property_id
          OR a.legacy_utility_id IN (SELECT u.id FROM utilities u
                                      WHERE u.company_id = p_company_id AND u.archived_at IS NULL
                                        AND ((v_use_addr AND u.property = v_addr) OR u.property_id = p_property_id)));
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('utility_accounts', n);

  UPDATE utilities SET archived_at = v_ts, archived_by = v_by
   WHERE company_id = p_company_id AND archived_at IS NULL
     AND ((v_use_addr AND property = v_addr) OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('utilities', n);

  UPDATE utility_bills b SET archived_at = v_ts, updated_at = now()
   WHERE b.company_id = p_company_id AND b.archived_at IS NULL
     AND b.paid_at IS NULL AND COALESCE(b.amount_paid, 0) = 0
     AND COALESCE(b.status, '') NOT IN ('paid', 'partial', 'settled')
     AND ((v_use_addr AND b.property = v_addr)
          OR b.utility_account_id IN (SELECT a.id FROM utility_accounts a
                                       WHERE a.company_id = p_company_id AND a.archived_at = v_ts
                                         AND a.archived_reason = 'property_deleted'));
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('utility_bills_pending', n);

  UPDATE portfolio_loan_properties SET archived_at = v_ts
   WHERE company_id = p_company_id AND archived_at IS NULL
     AND ((v_use_addr AND property = v_addr) OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('portfolio_loan_links', n);

  UPDATE property_setup_wizard SET status = 'dismissed', updated_at = now()
   WHERE company_id = p_company_id AND status = 'in_progress'
     AND ((v_use_addr AND property_address = v_addr) OR property_id::text = v_pid);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('setup_wizard_dismissed', n);

  -- The accounting class leaves class tracking; restore re-activates it.
  UPDATE acct_classes SET is_active = false
   WHERE company_id = p_company_id AND (id = v_class OR (v_class IS NULL AND name = v_addr));
  -- Once, instead of twice per tenant row (the per-row sync is skipped while
  -- app.property_cascade is on).
  PERFORM public.derive_property_occupancy(p_company_id, v_addr);

  SELECT count(*) INTO n FROM property_deletion_voids WHERE deletion_id = p_deletion_id;
  v_counts := v_counts || jsonb_build_object('journal_entries_voided', n);
  UPDATE property_deletions SET status = 'archived', archived = v_counts, address = v_addr WHERE id = p_deletion_id;

  RETURN jsonb_build_object('success', true, 'deletion_id', p_deletion_id, 'archived_at', v_ts, 'address', v_addr,
                            'matched_by_address', v_use_addr, 'archived', v_counts);
END;
$function$;

-- ─── restore preview: what restore will and will not do ──────────────────
CREATE OR REPLACE FUNCTION public.property_restore_preview(p_company_id text, p_property_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_addr text; v_ts timestamptz;
  v_del property_deletions%ROWTYPE;
BEGIN
  PERFORM public._assert_property_manager(p_company_id);
  SELECT address, archived_at INTO v_addr, v_ts FROM properties WHERE company_id = p_company_id AND id = p_property_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Property % not found in this company', p_property_id USING ERRCODE = 'P0002'; END IF;
  IF v_ts IS NULL THEN RETURN jsonb_build_object('already_live', true); END IF;
  SELECT * INTO v_del FROM property_deletions
   WHERE company_id = p_company_id AND property_id = p_property_id AND stamp = v_ts AND status = 'archived'
   ORDER BY id DESC LIMIT 1;
  RETURN jsonb_build_object(
    'legacy', v_del.id IS NULL,
    'deletion_id', v_del.id,
    'address', v_addr,
    'address_clash', EXISTS (SELECT 1 FROM properties WHERE company_id = p_company_id AND archived_at IS NULL
                               AND lower(btrim(address)) = lower(btrim(v_addr)) AND id <> p_property_id),
    'tenants', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY name) FROM tenants
                          WHERE company_id = p_company_id AND archived_at = v_ts
                            AND (property = v_addr OR property_id = p_property_id)), '[]'::jsonb),
    'entries_to_unvoid', (SELECT count(*) FROM property_deletion_voids WHERE deletion_id = v_del.id AND restored_at IS NULL),
    -- Entries this delete voided that now sit in a locked period: restore
    -- leaves them voided (the closed period already reflects that).
    'locked_entries', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', je.id, 'number', je.number, 'date', je.date,
                                        'description', je.description) ORDER BY je.date, je.number)
                           FROM property_deletion_voids v
                           JOIN acct_journal_entries je ON je.id = v.je_id
                           JOIN accounting_period_lock l ON l.company_id = je.company_id
                          WHERE v.deletion_id = v_del.id AND v.restored_at IS NULL AND je.date <= l.lock_date), '[]'::jsonb),
    'utility_clashes', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'provider', u.provider,
                                        'account_number', u.account_number, 'live_at', o.property))
                           FROM utilities u JOIN utilities o
                             ON o.company_id = u.company_id AND o.archived_at IS NULL AND o.id <> u.id
                            AND o.provider = u.provider AND o.account_number = u.account_number
                            AND o.is_final_bill IS NOT DISTINCT FROM u.is_final_bill
                          WHERE u.company_id = p_company_id AND u.archived_at = v_ts AND u.account_number IS NOT NULL
                            AND (u.property = v_addr OR u.property_id = p_property_id)), '[]'::jsonb));
END;
$function$;

-- ─── restore ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.restore_property_cascade(
  p_company_id text, p_property_id bigint, p_restore_tenants boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ts timestamptz;
  v_addr text;
  v_class text;
  v_pid text := p_property_id::text;
  v_del property_deletions%ROWTYPE;
  v_counts jsonb := '{}'::jsonb;
  v_tenant_ids int[] := '{}';
  v_skip_utils int[] := '{}';
  v_accts int[] := '{}';
  v_skipped jsonb := '[]'::jsonb;
  v_left int;
  r jsonb;
  n int;
BEGIN
  PERFORM public._assert_property_manager(p_company_id);

  SELECT address, archived_at, class_id INTO v_addr, v_ts, v_class FROM properties
   WHERE company_id = p_company_id AND id = p_property_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Property % not found in this company', p_property_id USING ERRCODE = 'P0002';
  END IF;
  IF v_ts IS NULL THEN
    RETURN jsonb_build_object('success', true, 'already_live', true);
  END IF;
  IF EXISTS (SELECT 1 FROM properties WHERE company_id = p_company_id
               AND lower(btrim(address)) = lower(btrim(v_addr))
               AND id <> p_property_id AND archived_at IS NULL) THEN
    RAISE EXCEPTION 'A live property already has the address "%". Rename or delete it before restoring this one.', v_addr
      USING ERRCODE = '23505';
  END IF;

  SELECT * INTO v_del FROM property_deletions
   WHERE company_id = p_company_id AND property_id = p_property_id AND stamp = v_ts AND status = 'archived'
   ORDER BY id DESC LIMIT 1 FOR UPDATE;

  -- Un-void what the delete voided. Large sets are un-voided first by the
  -- caller in chunks; a small remainder is finished here.
  -- The books: up to 300 entries are re-posted here, in this transaction; a
  -- busier property's remainder is re-posted by property_delete_unvoid_chunk
  -- AFTER this commits (the property is live by then, so a failure half-way
  -- leaves a live property with some entries still voided -- listed by
  -- property_deletions_pending and resumable -- never a deleted property with
  -- live books).
  IF v_del.id IS NOT NULL THEN
    SELECT count(*) INTO v_left FROM property_deletion_voids WHERE deletion_id = v_del.id AND restored_at IS NULL;
    IF v_left > 0 AND v_left <= 300 THEN
      r := public.property_delete_unvoid_chunk(v_del.id, 300);
      v_left := (r->>'remaining')::int;
    END IF;
    v_counts := v_counts || jsonb_build_object('journal_entries_pending', v_left,
      'journal_entries_left_voided',
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id', je_id, 'why', note)) FROM property_deletion_voids
                 WHERE deletion_id = v_del.id AND note IS NOT NULL), '[]'::jsonb));
  END IF;
  PERFORM set_config('app.property_cascade', 'on', true);

  UPDATE properties SET archived_at = NULL, archived_by = NULL WHERE company_id = p_company_id AND id = p_property_id;
  UPDATE acct_classes SET is_active = true
   WHERE company_id = p_company_id AND (id = v_class OR (v_class IS NULL AND name = v_addr));

  -- 4. A utility whose provider + account number is live elsewhere now (the
  -- account was re-added at a corrected address) stays archived, and is named.
  SELECT COALESCE(array_agg(u.id), '{}'),
         COALESCE(jsonb_agg(jsonb_build_object('provider', u.provider, 'account_number', u.account_number, 'live_at', o.property)), '[]'::jsonb)
    INTO v_skip_utils, v_skipped
    FROM utilities u JOIN utilities o
      ON o.company_id = u.company_id AND o.archived_at IS NULL AND o.id <> u.id
     AND o.provider = u.provider AND o.account_number = u.account_number
     AND o.is_final_bill IS NOT DISTINCT FROM u.is_final_bill
   WHERE u.company_id = p_company_id AND u.archived_at = v_ts AND u.account_number IS NOT NULL
     AND (u.property = v_addr OR u.property_id = p_property_id);
  v_counts := v_counts || jsonb_build_object('utilities_left_archived', v_skipped);

  IF p_restore_tenants THEN
    WITH t AS (
      UPDATE tenants SET archived_at = NULL, archived_by = NULL
       WHERE company_id = p_company_id AND archived_at = v_ts
         AND (property = v_addr OR property_id = p_property_id)
      RETURNING id)
    SELECT COALESCE(array_agg(id), '{}') INTO v_tenant_ids FROM t;
    v_counts := v_counts || jsonb_build_object('tenants', COALESCE(array_length(v_tenant_ids, 1), 0));
    UPDATE acct_accounts SET is_active = true
     WHERE company_id = p_company_id AND tenant_id = ANY (v_tenant_ids::bigint[]) AND NOT is_active;

    UPDATE leases SET archived_at = NULL, archived_by = NULL
     WHERE company_id = p_company_id AND archived_at = v_ts
       AND (property = v_addr OR property_id = p_property_id);
    GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('leases', n);
    UPDATE leases SET status = 'active', updated_at = now()
     WHERE company_id = p_company_id AND status = 'terminated' AND archived_at IS NULL
       AND tenant_id = ANY (v_tenant_ids)
       AND (property = v_addr OR property_id = p_property_id)
       AND (end_date IS NULL OR end_date >= CURRENT_DATE);
    UPDATE tenants t SET lease_status = 'active'
     WHERE t.company_id = p_company_id AND t.id = ANY (v_tenant_ids)
       AND EXISTS (SELECT 1 FROM leases l WHERE l.company_id = p_company_id
                     AND l.tenant_id = t.id AND l.status = 'active' AND l.archived_at IS NULL);
    -- 11. The delete blanked their balances; recompute from the ledger.
    FOR n IN SELECT unnest(v_tenant_ids) LOOP PERFORM public.recompute_tenant_balance(n); END LOOP;

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
  -- An auto-generated instalment re-created meanwhile wins over the archived one.
  UPDATE property_tax_bills b SET archived_at = NULL, archived_by = NULL
   WHERE b.company_id = p_company_id AND b.archived_at = v_ts AND (b.property = v_addr OR b.property_id = p_property_id)
     AND NOT (b.auto_generated AND EXISTS (SELECT 1 FROM property_tax_bills o WHERE o.company_id = b.company_id
                AND o.property = b.property AND o.tax_year = b.tax_year AND o.installment_label = b.installment_label
                AND o.auto_generated AND o.archived_at IS NULL));
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('property_tax_bills', n);

  -- The stamp identifies this delete's accounts even when their own address
  -- drifted (they were matched by id / legacy link at delete time).
  WITH a AS (
    UPDATE utility_accounts a SET archived_at = NULL, archived_reason = NULL, updated_at = now()
     WHERE a.company_id = p_company_id AND a.archived_at = v_ts AND a.archived_reason = 'property_deleted'
       AND (a.legacy_utility_id IS NULL OR NOT (a.legacy_utility_id = ANY (v_skip_utils)))
    RETURNING a.id)
  SELECT COALESCE(array_agg(id), '{}') INTO v_accts FROM a;
  v_counts := v_counts || jsonb_build_object('utility_accounts', COALESCE(array_length(v_accts, 1), 0));
  UPDATE utilities SET archived_at = NULL, archived_by = NULL
   WHERE company_id = p_company_id AND archived_at = v_ts AND (property = v_addr OR property_id = p_property_id)
     AND NOT (id = ANY (v_skip_utils));
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('utilities', n);
  UPDATE utility_bills b SET archived_at = NULL, updated_at = now()
   WHERE b.company_id = p_company_id AND b.archived_at = v_ts
     AND (b.utility_account_id = ANY (v_accts)
          OR (b.property = v_addr AND NOT EXISTS (SELECT 1 FROM utility_accounts x WHERE x.id = b.utility_account_id
                                                    AND x.legacy_utility_id = ANY (v_skip_utils))));
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('utility_bills', n);
  UPDATE portfolio_loan_properties SET archived_at = NULL
   WHERE company_id = p_company_id AND archived_at = v_ts AND (property = v_addr OR property_id = p_property_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('portfolio_loan_links', n);

  PERFORM public.derive_property_occupancy(p_company_id, v_addr);
  IF v_del.id IS NOT NULL THEN
    UPDATE property_deletions SET status = 'restored', restored_at = now(), restored_tenants = p_restore_tenants,
           restored = v_counts WHERE id = v_del.id;
  END IF;
  RETURN jsonb_build_object('success', true, 'address', v_addr, 'legacy', v_del.id IS NULL, 'restored', v_counts);
END;
$function$;

-- ─── 3e. unfinished deletes / restores, surfaced on the Properties page ──
-- A dropped connection between chunks leaves a delete half-voided (status
-- 'voiding', property live) or a restore with entries still to re-post
-- (status 'restored', pending voids). Both are resumable; this lists them.
CREATE OR REPLACE FUNCTION public.property_deletions_pending(p_company_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public._assert_company_staff(p_company_id);
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'deletion_id', d.id, 'property_id', d.property_id, 'address', d.address,
             'kind', CASE WHEN d.status = 'voiding' THEN 'delete' ELSE 'restore' END,
             'started_by', d.created_by, 'started_at', d.created_at,
             'voided', (SELECT count(*) FROM property_deletion_voids v WHERE v.deletion_id = d.id),
             'pending', (SELECT count(*) FROM property_deletion_voids v WHERE v.deletion_id = d.id AND v.restored_at IS NULL))
           ORDER BY d.id)
      FROM property_deletions d
     WHERE d.company_id = p_company_id
       AND ((d.status = 'voiding' AND EXISTS (SELECT 1 FROM property_deletion_voids v WHERE v.deletion_id = d.id AND v.restored_at IS NULL))
         OR (d.status = 'restored' AND EXISTS (SELECT 1 FROM property_deletion_voids v WHERE v.deletion_id = d.id AND v.restored_at IS NULL)))), '[]'::jsonb);
END;
$function$;
REVOKE ALL ON FUNCTION public.property_deletions_pending(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.property_deletions_pending(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.property_delete_begin(text, bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.property_delete_void_chunk(bigint, int) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.property_delete_unvoid_chunk(bigint, int) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.archive_property_cascade(text, bigint, bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.property_restore_preview(text, bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.restore_property_cascade(text, bigint, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.property_delete_begin(text, bigint) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.property_delete_void_chunk(bigint, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.property_delete_unvoid_chunk(bigint, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.archive_property_cascade(text, bigint, bigint) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.property_restore_preview(text, bigint) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.restore_property_cascade(text, bigint, boolean) TO authenticated, service_role;

-- ─── owner decision (2026-09-29): 'owner' is the owner-PORTAL login ──────
-- It gets no destructive or bookkeeping rights. is_management_tier above
-- already excludes it; is_accounting_tier (20260929080000) did not.
CREATE OR REPLACE FUNCTION public.is_accounting_tier(p_company_id text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.company_members cm
     WHERE cm.company_id = p_company_id
       AND lower(cm.user_email) = lower(current_setting('request.jwt.claims', true)::json->>'email')
       AND cm.status = 'active'
       AND cm.role IN ('admin','pm','manager','office_assistant','accountant')
  );
$function$;
REVOKE ALL ON FUNCTION public.is_accounting_tier(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_accounting_tier(text) TO authenticated, service_role;
