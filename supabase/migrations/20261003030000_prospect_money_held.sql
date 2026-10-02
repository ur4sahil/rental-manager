-- Money a prospect pays before they are a tenant.
--
-- An applicant often pays the deposit (and sometimes the first month) when
-- they sign, weeks before move-in. Until now the books had nowhere to put
-- it: a prospect has no ledger, and conversion is refused while the old
-- tenant still lives there. Staff kept it on paper.
--
-- It is held as a LIABILITY (it is not the company's money yet, and not yet
-- a tenant's payment either), in an account of the prospect's own under one
-- parent, "Prospect Money Held". Their own account, exactly as each tenant
-- has their own receivable account, so that:
--   * the Banking page can categorise a deposit straight to the prospect;
--   * what is held is read off the ledger, not typed into a second place;
--   * conversion moves precisely that balance onto the tenant's ledger
--     (src/utils/prospectMoney.js), and a refund takes it back to zero.
ALTER TABLE public.acct_accounts
  ADD COLUMN IF NOT EXISTS prospect_id uuid REFERENCES public.prospects(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_acct_accounts_one_per_prospect
  ON public.acct_accounts (prospect_id) WHERE prospect_id IS NOT NULL;

-- Find or make the prospect's held-money account. One transaction and one
-- lock per company, so two people recording money at the same moment cannot
-- mint two accounts or the same code twice.
CREATE OR REPLACE FUNCTION public.prospect_held_account(p_prospect_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_p prospects%ROWTYPE;
  v_id uuid; v_parent uuid; v_parent_code text; v_n integer; v_code text;
BEGIN
  SELECT * INTO v_p FROM prospects WHERE id = p_prospect_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That prospect no longer exists.' USING ERRCODE = 'P0002'; END IF;
  -- auth.role() is empty for the database owner and the service key; a
  -- browser request is 'authenticated' and must be staff of this company.
  IF COALESCE(NULLIF(auth.role(), ''), 'postgres') NOT IN ('service_role', 'postgres')
     AND NOT public.is_company_staff(v_p.company_id) THEN
    RAISE EXCEPTION 'You do not have access to this company.' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_id FROM acct_accounts WHERE prospect_id = p_prospect_id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('prospect_held:' || v_p.company_id));
  SELECT id INTO v_id FROM acct_accounts WHERE prospect_id = p_prospect_id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  -- The parent. Found by what it is, not by a fixed code: a company's chart
  -- may already use 2150 for something else.
  SELECT id, code INTO v_parent, v_parent_code FROM acct_accounts
   WHERE company_id = v_p.company_id AND type = 'Liability' AND name = 'Prospect Money Held' AND prospect_id IS NULL
   ORDER BY code LIMIT 1;
  IF v_parent IS NULL THEN
    SELECT g::text INTO v_parent_code FROM generate_series(2150, 2199) g
     WHERE NOT EXISTS (SELECT 1 FROM acct_accounts a WHERE a.company_id = v_p.company_id AND (a.code = g::text OR a.code LIKE g::text || '-%'))
     ORDER BY g LIMIT 1;
    IF v_parent_code IS NULL THEN RAISE EXCEPTION 'No free account number between 2150 and 2199 for "Prospect Money Held". Add that account in the chart of accounts first.'; END IF;
    INSERT INTO acct_accounts (company_id, code, name, type, subtype, description, is_active, old_text_id)
    VALUES (v_p.company_id, v_parent_code, 'Prospect Money Held', 'Liability', 'Other Current Liability',
            'Money received from prospects before they become tenants. Moves to the tenant''s ledger when they are converted.',
            true, v_p.company_id || '-' || v_parent_code)
    RETURNING id INTO v_parent;
  END IF;

  SELECT COALESCE(MAX((substring(code from '-(\d+)$'))::integer), 0) + 1 INTO v_n
    FROM acct_accounts WHERE company_id = v_p.company_id AND code ~ ('^' || v_parent_code || '-\d+$');
  v_code := v_parent_code || '-' || lpad(v_n::text, 3, '0');
  INSERT INTO acct_accounts (company_id, code, name, type, subtype, is_active, old_text_id, parent_id, prospect_id)
  VALUES (v_p.company_id, v_code, 'Held - ' || v_p.name, 'Liability', 'Other Current Liability', true,
          v_p.company_id || '-' || v_code, v_parent, p_prospect_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.prospect_held_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prospect_held_account(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
