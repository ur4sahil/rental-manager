-- Phase 1 of phasing out the parallel ledger_entries table.
--
-- Goal: stop new drift between ledger_entries and the GL
-- (acct_journal_lines). After this migration, every JE that posts a
-- line on a per-tenant AR account is guaranteed to have a matching
-- ledger_entries row — whether the caller went through the canonical
-- post_je_and_ledger RPC, the safeLedgerInsert helper, or a direct
-- INSERT (Banking.js, Stripe webhook, auto-rent-charges).
--
-- Approach:
--   1. Link the two tables via a new ledger_entries.journal_entry_id
--      column. Backfill the link for existing rows by matching
--      (company_id, tenant_id, date, amount).
--   2. Stamp transaction_type onto acct_journal_entries from the
--      RPC's p_ledger_type, so a trigger downstream can derive
--      ledger_entries.type without heuristics.
--   3. Mirror trigger on acct_journal_lines INSERT: if the line is
--      on a per-tenant AR account AND no ledger_entries row exists
--      for that journal_entry_id, insert one. The RPC's existing
--      Step 3 still fires too — the trigger only fills gaps left
--      by paths that bypass the RPC.
--   4. Backfill: for every existing AR-account JE line with no
--      ledger_entries link, insert the missing row. Solves the 21
--      orphans in Smith Properties (and equivalents in other LLCs).

-- ── 1. Schema additions ───────────────────────────────────────────
-- text not uuid: acct_journal_lines.journal_entry_id is text in this
-- DB even though acct_journal_entries.id is uuid (legacy migration
-- left the FK column un-cast). Match the FK side so joins don't
-- require casts on every read.
ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS journal_entry_id text;

CREATE INDEX IF NOT EXISTS idx_ledger_entries_je_id
  ON ledger_entries (journal_entry_id) WHERE journal_entry_id IS NOT NULL;

ALTER TABLE acct_journal_entries
  ADD COLUMN IF NOT EXISTS transaction_type text;

-- ── 2. Backfill links for existing ledger_entries rows ────────────
-- Match each unlinked ledger_entries row to the JE with the same
-- (company_id, tenant_id, date, amount). Most rows will match
-- exactly one JE; the few that don't (multi-line JEs, stale rows)
-- stay unlinked and are harmless.
WITH candidates AS (
  SELECT
    le.id AS le_id,
    je.id::text AS je_id,
    ROW_NUMBER() OVER (PARTITION BY le.id ORDER BY je.created_at) AS rn
  FROM ledger_entries le
  JOIN acct_journal_entries je
    ON je.company_id = le.company_id
    AND je.date::date = le.date::date
    AND je.status = 'posted'
  JOIN acct_journal_lines jl ON jl.journal_entry_id::text = je.id::text
  JOIN acct_accounts a ON a.id = jl.account_id
  WHERE le.journal_entry_id IS NULL
    AND a.tenant_id = le.tenant_id
    AND ABS((COALESCE(jl.debit, 0) + COALESCE(jl.credit, 0)) - le.amount) < 0.01
)
UPDATE ledger_entries le
SET journal_entry_id = c.je_id
FROM candidates c
WHERE le.id = c.le_id AND c.rn = 1;

-- ── 3. Stamp transaction_type on existing JEs heuristically so the
--    mirror trigger has a value to copy. New writes go through the
--    updated RPC (next migration step) which sets it explicitly.
UPDATE acct_journal_entries
SET transaction_type = CASE
  WHEN reference LIKE 'STRIPE-%' OR reference LIKE 'PAYMENT-%' OR description ILIKE '%payment%' THEN 'payment'
  WHEN reference LIKE 'RECUR-%' OR description ILIKE '%rent%' THEN 'charge'
  WHEN reference LIKE 'LATE-%' OR description ILIKE '%late fee%' THEN 'late_fee'
  WHEN description ILIKE '%deposit%return%' OR description ILIKE '%refund%' THEN 'deposit_return'
  WHEN description ILIKE '%deposit%' THEN 'deposit'
  WHEN description ILIKE '%credit%' OR description ILIKE '%adjust%' THEN 'credit'
  WHEN reference LIKE 'BANK-%' THEN 'bank'
  ELSE 'charge'
END
WHERE transaction_type IS NULL;

-- ── 4. Update post_je_and_ledger to stamp transaction_type ────────
-- The RPC continues to do its own ledger_entries insert (Step 3) but
-- now also sets transaction_type on the JE header AND the
-- journal_entry_id link on the ledger_entries row. This keeps the
-- existing call sites' precise type values flowing while the mirror
-- trigger handles paths that bypass the RPC entirely.
CREATE OR REPLACE FUNCTION post_je_and_ledger(
  p_company_id text,
  p_date text,
  p_description text,
  p_reference text DEFAULT '',
  p_property text DEFAULT '',
  p_status text DEFAULT 'posted',
  p_lines jsonb DEFAULT '[]'::jsonb,
  p_ledger_tenant text DEFAULT NULL,
  p_ledger_tenant_id bigint DEFAULT NULL,
  p_ledger_property text DEFAULT NULL,
  p_ledger_amount numeric DEFAULT 0,
  p_ledger_type text DEFAULT NULL,
  p_ledger_description text DEFAULT NULL,
  p_balance_change numeric DEFAULT 0
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_je_id uuid;
  v_je_number text;
  v_last_num int;
  v_attempt int := 0;
  v_prev_balance numeric := 0;
  v_new_balance numeric := 0;
  v_line jsonb;
BEGIN
  LOOP
    SELECT COALESCE(
      (SELECT regexp_replace(number, '\D', '', 'g')::int
       FROM acct_journal_entries
       WHERE company_id = p_company_id
       ORDER BY created_at DESC LIMIT 1), 0
    ) INTO v_last_num;

    v_je_number := 'JE-' || lpad((v_last_num + 1 + v_attempt)::text, 4, '0');

    BEGIN
      INSERT INTO acct_journal_entries (company_id, number, date, description, reference, property, status, transaction_type)
      VALUES (p_company_id, v_je_number, p_date, p_description, p_reference, p_property, p_status, COALESCE(p_ledger_type, 'charge'))
      RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_attempt := v_attempt + 1;
      IF v_attempt >= 5 THEN
        RAISE EXCEPTION 'Could not generate unique JE number after 5 attempts';
      END IF;
    END;
  END LOOP;

  -- Insert JE lines. The mirror trigger on acct_journal_lines fires
  -- after each line and will create a ledger_entries row IF Step 3
  -- below doesn't write one (i.e., when the caller didn't pass
  -- p_ledger_type and p_ledger_tenant — the bypass path).
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    INSERT INTO acct_journal_lines (
      journal_entry_id, company_id, account_id, account_name,
      debit, credit, class_id, memo
    ) VALUES (
      v_je_id, p_company_id,
      v_line->>'account_id', COALESCE(v_line->>'account_name', ''),
      COALESCE((v_line->>'debit')::numeric, 0),
      COALESCE((v_line->>'credit')::numeric, 0),
      NULLIF(v_line->>'class_id', ''),
      COALESCE(v_line->>'memo', '')
    );
  END LOOP;

  -- Step 3: explicit ledger_entries insert when the caller provided
  -- a tenant + type. Now linked via journal_entry_id so the mirror
  -- trigger knows this row was already written and skips.
  IF p_ledger_type IS NOT NULL AND (p_ledger_tenant_id IS NOT NULL OR p_ledger_tenant IS NOT NULL) THEN
    IF p_ledger_tenant_id IS NOT NULL THEN
      SELECT COALESCE(balance, 0) INTO v_prev_balance
      FROM ledger_entries
      WHERE company_id = p_company_id AND tenant_id = p_ledger_tenant_id
      ORDER BY date DESC, created_at DESC LIMIT 1;
    ELSE
      SELECT COALESCE(balance, 0) INTO v_prev_balance
      FROM ledger_entries
      WHERE company_id = p_company_id AND lower(tenant) = lower(p_ledger_tenant)
      ORDER BY date DESC, created_at DESC LIMIT 1;
    END IF;

    IF p_ledger_type IN ('charge', 'late_fee', 'expense', 'deposit_deduction', 'deposit') THEN
      v_new_balance := COALESCE(v_prev_balance, 0) + p_ledger_amount;
    ELSIF p_ledger_type IN ('payment', 'credit', 'deposit_return', 'void') THEN
      v_new_balance := COALESCE(v_prev_balance, 0) - p_ledger_amount;
    ELSE
      v_new_balance := COALESCE(v_prev_balance, 0) + p_ledger_amount;
    END IF;

    INSERT INTO ledger_entries (
      company_id, tenant, tenant_id, property, date,
      description, amount, type, balance, journal_entry_id
    ) VALUES (
      p_company_id, p_ledger_tenant, p_ledger_tenant_id, p_ledger_property, p_date,
      COALESCE(p_ledger_description, p_description), p_ledger_amount, p_ledger_type,
      v_new_balance, v_je_id::text
    );
  END IF;

  RETURN v_je_id;
END;
$$;

-- ── 5. Mirror trigger ─────────────────────────────────────────────
-- Fires after each acct_journal_lines INSERT. If the line is on a
-- per-tenant AR account AND no ledger_entries row exists for this
-- journal_entry_id (RPC's Step 3 hasn't run, OR the caller bypassed
-- the RPC entirely — Banking.js, Stripe webhook, auto-rent-charges),
-- insert a mirrored ledger_entries row.
--
-- type comes from acct_journal_entries.transaction_type. amount sign
-- follows the existing ledger_entries convention (always positive,
-- type field disambiguates direction). The running balance is
-- computed from the previous row for that tenant.
CREATE OR REPLACE FUNCTION trg_mirror_je_line_to_ledger()
RETURNS TRIGGER AS $$
DECLARE
  v_tenant_id bigint;
  v_tenant_name text;
  v_je RECORD;
  v_amount numeric;
  v_type text;
  v_prev_balance numeric := 0;
  v_new_balance numeric := 0;
  v_already_exists boolean;
BEGIN
  -- 1. Is this line on a per-tenant AR account?
  SELECT a.tenant_id INTO v_tenant_id
  FROM acct_accounts a WHERE a.id = NEW.account_id;
  IF v_tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- 2. Has a ledger_entries row already been written for this JE +
  --    tenant? (RPC Step 3 path, or app code that already wrote it).
  SELECT EXISTS (
    SELECT 1 FROM ledger_entries
    WHERE journal_entry_id = NEW.journal_entry_id::text
      AND tenant_id = v_tenant_id
  ) INTO v_already_exists;
  IF v_already_exists THEN
    RETURN NEW;
  END IF;

  -- 3. Pull header context.
  SELECT je.date, je.description, je.transaction_type, je.property
    INTO v_je
  FROM acct_journal_entries je
  WHERE je.id::text = NEW.journal_entry_id::text;

  -- 4. Tenant display name.
  SELECT name INTO v_tenant_name FROM tenants WHERE id = v_tenant_id;

  -- 5. Amount + type. Prefer JE.transaction_type; fall back to
  --    direction-based guess if unset.
  v_amount := COALESCE(NEW.debit, 0) + COALESCE(NEW.credit, 0);
  v_type := COALESCE(
    v_je.transaction_type,
    CASE WHEN COALESCE(NEW.debit, 0) > 0 THEN 'charge' ELSE 'payment' END
  );

  -- 6. Running balance.
  SELECT COALESCE(balance, 0) INTO v_prev_balance
  FROM ledger_entries
  WHERE company_id = NEW.company_id AND tenant_id = v_tenant_id
  ORDER BY date DESC, created_at DESC LIMIT 1;
  IF v_type IN ('charge', 'late_fee', 'expense', 'deposit_deduction', 'deposit') THEN
    v_new_balance := COALESCE(v_prev_balance, 0) + v_amount;
  ELSIF v_type IN ('payment', 'credit', 'deposit_return', 'void') THEN
    v_new_balance := COALESCE(v_prev_balance, 0) - v_amount;
  ELSE
    v_new_balance := COALESCE(v_prev_balance, 0) + v_amount;
  END IF;

  -- 7. Insert the mirrored row.
  INSERT INTO ledger_entries (
    company_id, tenant, tenant_id, property, date,
    description, amount, type, balance, journal_entry_id
  ) VALUES (
    NEW.company_id, v_tenant_name, v_tenant_id, COALESCE(v_je.property, ''),
    v_je.date::text::date,
    COALESCE(v_je.description, ''), v_amount, v_type, v_new_balance, NEW.journal_entry_id::text
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mirror_je_line_to_ledger ON acct_journal_lines;
CREATE TRIGGER mirror_je_line_to_ledger
AFTER INSERT ON acct_journal_lines
FOR EACH ROW
EXECUTE FUNCTION trg_mirror_je_line_to_ledger();

-- ── 6. Backfill missing ledger_entries rows from historical GL ───
-- For every existing AR-account GL line whose JE has no
-- ledger_entries row for that tenant, insert one. Uses the same
-- logic as the trigger but in bulk.
INSERT INTO ledger_entries (
  company_id, tenant, tenant_id, property, date,
  description, amount, type, balance, journal_entry_id
)
SELECT
  jl.company_id,
  t.name,
  a.tenant_id,
  COALESCE(je.property, ''),
  je.date::text::date,
  COALESCE(je.description, ''),
  COALESCE(jl.debit, 0) + COALESCE(jl.credit, 0),
  COALESCE(je.transaction_type,
    CASE WHEN COALESCE(jl.debit, 0) > 0 THEN 'charge' ELSE 'payment' END),
  -- Backfilled rows get balance=0; the integrity sweep is now off
  -- ledger_entries (it reads the GL directly), and the per-row
  -- balance is only used for the tenant payment-history view, which
  -- can recompute on-the-fly. A future migration can recompute these
  -- once all existing rows have a journal_entry_id link.
  0,
  je.id::text
FROM acct_journal_lines jl
JOIN acct_journal_entries je ON je.id::text = jl.journal_entry_id::text
JOIN acct_accounts a ON a.id = jl.account_id
JOIN tenants t ON t.id = a.tenant_id
WHERE a.tenant_id IS NOT NULL
  AND je.status = 'posted'
  AND NOT EXISTS (
    SELECT 1 FROM ledger_entries le
    WHERE le.journal_entry_id = je.id::text
      AND le.tenant_id = a.tenant_id
  );
