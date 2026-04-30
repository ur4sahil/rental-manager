-- Phase 4: replace the ledger_entries table with the GL-derived view.
-- After this migration:
--   - ledger_entries is a VIEW that derives every row from the GL
--     (acct_journal_lines + acct_journal_entries + acct_accounts +
--     tenants). One source of truth, drift impossible.
--   - The old physical table is preserved as
--     ledger_entries_legacy_table for one release cycle so we can
--     read historical rows that didn't backfill cleanly. Drop it
--     in a follow-up migration once we're confident.
--   - The mirror trigger and the RPC's Step 3 ledger_entries insert
--     are removed; nothing writes to the table anymore.
--
-- Reads in app code (~10 sites in src/components/) continue working
-- unchanged — they SELECT from `ledger_entries` and now hit the view.
-- Writes that bypass the canonical RPC will fail loudly (which is
-- the desired safety: pre-Phase 4 those would silently double-write).

-- 1. Drop the mirror trigger. View derives live; no need to mirror.
DROP TRIGGER IF EXISTS mirror_je_line_to_ledger ON acct_journal_lines;
DROP FUNCTION IF EXISTS trg_mirror_je_line_to_ledger();

-- 2. Update post_je_and_ledger to not write to ledger_entries.
--    The Step 3 insert is removed; the view sources its rows from
--    the lines we already inserted in Step 2. Caller params for
--    p_ledger_* are kept for back-compat with existing JS code
--    (they're now ignored).
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
      VALUES (p_company_id, v_je_number, p_date::date, p_description, p_reference, p_property, p_status, COALESCE(p_ledger_type, 'charge'))
      RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_attempt := v_attempt + 1;
      IF v_attempt >= 5 THEN
        RAISE EXCEPTION 'Could not generate unique JE number after 5 attempts';
      END IF;
    END;
  END LOOP;

  -- Step 2 (only). Lines on per-tenant AR accounts are
  -- automatically reflected in the ledger_entries view via the
  -- aggregate-window join.
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

  RETURN v_je_id;
END;
$$;

-- 3. insert_ledger_entry_with_balance RPC: kept as a no-op shim so
--    any legacy app code that still calls it doesn't crash. Returns
--    null (matching the "skip" branch behavior).
CREATE OR REPLACE FUNCTION insert_ledger_entry_with_balance(
  p_company_id text,
  p_tenant text DEFAULT NULL,
  p_tenant_id bigint DEFAULT NULL,
  p_property text DEFAULT NULL,
  p_date text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_amount numeric DEFAULT 0,
  p_type text DEFAULT NULL
)
RETURNS bigint LANGUAGE plpgsql AS $$
BEGIN
  -- ledger_entries is now a view — there's nothing to insert into.
  -- The legacy callers haven't been removed from the JS yet but
  -- their writes are redundant (the JE on the AR account that
  -- preceded this call already determines the row in the view).
  RETURN NULL;
END;
$$;

-- 4. Rename the physical table out of the way and create the view
--    in its place. Done in a single transaction so reads see no
--    gap.
ALTER TABLE ledger_entries RENAME TO ledger_entries_legacy_table;

CREATE VIEW ledger_entries AS
SELECT
  jl.id,
  jl.company_id,
  t.name                                         AS tenant,
  a.tenant_id,
  COALESCE(je.property, '')                      AS property,
  NULL::bigint                                   AS property_id,
  je.date::text::date                            AS date,
  COALESCE(je.description, '')                   AS description,
  COALESCE(jl.debit, 0) + COALESCE(jl.credit, 0) AS amount,
  COALESCE(
    je.transaction_type,
    CASE WHEN COALESCE(jl.debit, 0) > 0 THEN 'charge' ELSE 'payment' END
  )                                              AS type,
  SUM(
    CASE WHEN COALESCE(je.transaction_type,
                        CASE WHEN COALESCE(jl.debit, 0) > 0 THEN 'charge' ELSE 'payment' END)
              IN ('charge', 'late_fee', 'expense', 'deposit_deduction', 'deposit')
         THEN  (COALESCE(jl.debit, 0) + COALESCE(jl.credit, 0))
         WHEN COALESCE(je.transaction_type,
                        CASE WHEN COALESCE(jl.debit, 0) > 0 THEN 'charge' ELSE 'payment' END)
              IN ('payment', 'credit', 'deposit_return', 'void')
         THEN -(COALESCE(jl.debit, 0) + COALESCE(jl.credit, 0))
         ELSE  (COALESCE(jl.debit, 0) + COALESCE(jl.credit, 0))
    END
  ) OVER (
    PARTITION BY a.tenant_id
    ORDER BY je.date::text::date, je.created_at, jl.id
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  )                                              AS balance,
  je.id::text                                    AS journal_entry_id,
  je.created_at                                  AS created_at
FROM acct_journal_lines jl
JOIN acct_journal_entries je ON je.id::text = jl.journal_entry_id::text
JOIN acct_accounts a ON a.id = jl.account_id
JOIN tenants t ON t.id = a.tenant_id
WHERE a.tenant_id IS NOT NULL
  AND je.status = 'posted';

GRANT SELECT ON ledger_entries TO anon, authenticated, service_role;

-- 5. Drop the helper that depended on ledger_entries_v, drop the
--    Phase-3 alias view, then re-create the helper pointing at the
--    canonical name `ledger_entries`.
DROP FUNCTION IF EXISTS get_tenant_ledger(text, bigint);
DROP VIEW IF EXISTS ledger_entries_v;

CREATE OR REPLACE FUNCTION get_tenant_ledger(p_company_id text, p_tenant_id bigint)
RETURNS SETOF ledger_entries
LANGUAGE sql STABLE AS $$
  SELECT * FROM ledger_entries
  WHERE company_id = p_company_id AND tenant_id = p_tenant_id
  ORDER BY date DESC, created_at DESC;
$$;
