-- post_je_and_ledger accepts p_ledger_tenant_id and p_balance_change --
-- and ignored both. It wrote the JE header and lines and returned. So
-- the "atomic" post never moved tenants.balance, despite its signature
-- promising exactly that.
--
-- This was masked until today. Callers pass bare GL CODES ("1100"), the
-- function casts account_id to uuid, so every one of those calls 400'd
-- and atomicPostJEAndLedger fell back to the sequential writer -- which
-- WAS the only path that ever called update_tenant_balance. Resolving
-- codes to uuids earlier today made the RPC start succeeding, which
-- silently removed the balance update for every caller whose AR leg is
-- the shared 1100 account: late fees, the maintenance tenant billback,
-- and the non-per-tenant-AR branches in Tenants.js. A late fee posted a
-- correct, balanced journal entry and left the tenant's balance
-- untouched.
--
-- The trigger check is the load-bearing part. sync_tenant_balance_lines
-- recomputes tenants.balance as SUM(debit)-SUM(credit) over the tenant's
-- own AR sub-account whenever a line lands on it. Where that fires, the
-- balance is already authoritative and adding p_balance_change on top
-- would DOUBLE-COUNT the charge. So the increment is applied only when
-- no inserted line hit a per-tenant AR account for this tenant -- which
-- is precisely the shared-1100 case that lost its update.
CREATE OR REPLACE FUNCTION public.post_je_and_ledger(
  p_company_id text, p_date text, p_description text,
  p_reference text DEFAULT ''::text, p_property text DEFAULT ''::text,
  p_status text DEFAULT 'posted'::text, p_lines jsonb DEFAULT '[]'::jsonb,
  p_ledger_tenant text DEFAULT NULL::text, p_ledger_tenant_id bigint DEFAULT NULL::bigint,
  p_ledger_property text DEFAULT NULL::text, p_ledger_amount numeric DEFAULT 0,
  p_ledger_type text DEFAULT NULL::text, p_ledger_description text DEFAULT NULL::text,
  p_balance_change numeric DEFAULT 0
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_je_id uuid; v_je_number text; v_attempt int := 0; v_line jsonb;
  v_hit_tenant_ar boolean := false;
BEGIN
  LOOP
    v_je_number := next_je_number(p_company_id);
    BEGIN
      INSERT INTO acct_journal_entries (company_id, number, date, description, reference, property, status, transaction_type)
      VALUES (p_company_id, v_je_number, p_date::date, p_description, p_reference, p_property, p_status, COALESCE(p_ledger_type, 'charge'))
      RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_attempt := v_attempt + 1;
      IF v_attempt >= 5 THEN RAISE EXCEPTION 'Could not generate unique JE number after 5 attempts'; END IF;
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
END;
$function$;
