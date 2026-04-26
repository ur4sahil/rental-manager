-- Auto-sync tenants.balance from acct_journal_lines.
--
-- Background: tenants.balance is a denormalized cache of the running
-- balance on the tenant's per-tenant AR sub-account. The Ledger UI
-- computes from JE lines on read (always correct), but the
-- tenant-portal "Balance Due" tile and admin views read tenants.balance
-- directly, so it has to be kept in sync.
--
-- Until now the cache was updated ad-hoc by whichever module posted
-- the JE — and many didn't (Stripe webhook, recurring engine,
-- manual JE editor, etc.). Audit on 2026-04-26 found 38 of 107 active
-- tenants drifted, with deltas ranging $150 to $200k. This trigger
-- removes the ad-hoc burden — any code path that writes to
-- acct_journal_lines (or flips an acct_journal_entries.status to/from
-- 'voided') triggers a balance recompute for every per-tenant AR
-- account touched.
--
-- Performance note: each line insert/update fires one tenant recompute.
-- For a recurring-engine batch of 100 charges across 100 tenants
-- that's 100 small SUMs — acceptable. For a single multi-line JE
-- on the same tenant (e.g. rent + late fee), the lines insert is
-- usually one batch which fires per-row but each computes the same
-- tenant. If this becomes a hot path we can add a debounce or move
-- to a deferred-after-statement trigger.

-- Recompute for a specific tenant_id from posted lines on its AR.
CREATE OR REPLACE FUNCTION recompute_tenant_balance(p_tenant_id bigint)
RETURNS void AS $$
DECLARE
  v_balance numeric;
BEGIN
  IF p_tenant_id IS NULL THEN
    RETURN;
  END IF;
  SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)
  INTO v_balance
  FROM acct_journal_lines jl
  JOIN acct_journal_entries je ON je.id = jl.journal_entry_id
  JOIN acct_accounts a ON a.id = jl.account_id
  WHERE a.tenant_id = p_tenant_id
    AND je.status = 'posted';
  UPDATE tenants SET balance = v_balance WHERE id = p_tenant_id;
END;
$$ LANGUAGE plpgsql;

-- Trigger fn: on a journal_lines write, find the tenant_id from the
-- account (if any) and recompute.
CREATE OR REPLACE FUNCTION trg_sync_balance_from_je_lines()
RETURNS TRIGGER AS $$
DECLARE
  v_old_tenant_id bigint;
  v_new_tenant_id bigint;
BEGIN
  -- DELETE: recompute the (former) account's tenant
  IF TG_OP = 'DELETE' THEN
    SELECT tenant_id INTO v_old_tenant_id FROM acct_accounts WHERE id = OLD.account_id;
    PERFORM recompute_tenant_balance(v_old_tenant_id);
    RETURN OLD;
  END IF;

  -- INSERT: recompute the new account's tenant
  IF TG_OP = 'INSERT' THEN
    SELECT tenant_id INTO v_new_tenant_id FROM acct_accounts WHERE id = NEW.account_id;
    PERFORM recompute_tenant_balance(v_new_tenant_id);
    RETURN NEW;
  END IF;

  -- UPDATE: recompute both old and new account tenants if the
  -- account_id changed; otherwise just the one.
  IF OLD.account_id IS DISTINCT FROM NEW.account_id THEN
    SELECT tenant_id INTO v_old_tenant_id FROM acct_accounts WHERE id = OLD.account_id;
    SELECT tenant_id INTO v_new_tenant_id FROM acct_accounts WHERE id = NEW.account_id;
    PERFORM recompute_tenant_balance(v_old_tenant_id);
    IF v_new_tenant_id IS DISTINCT FROM v_old_tenant_id THEN
      PERFORM recompute_tenant_balance(v_new_tenant_id);
    END IF;
  ELSE
    SELECT tenant_id INTO v_new_tenant_id FROM acct_accounts WHERE id = NEW.account_id;
    PERFORM recompute_tenant_balance(v_new_tenant_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sync_tenant_balance_lines ON acct_journal_lines;
CREATE TRIGGER sync_tenant_balance_lines
AFTER INSERT OR UPDATE OR DELETE ON acct_journal_lines
FOR EACH ROW
EXECUTE FUNCTION trg_sync_balance_from_je_lines();

-- Trigger fn: on a journal_entries status change (post → voided or
-- voided → posted), recompute balance for every tenant whose AR is
-- on a line of this JE.
CREATE OR REPLACE FUNCTION trg_sync_balance_from_je_status()
RETURNS TRIGGER AS $$
DECLARE
  v_tenant_id bigint;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;
  FOR v_tenant_id IN
    SELECT DISTINCT a.tenant_id
    FROM acct_journal_lines jl
    JOIN acct_accounts a ON a.id = jl.account_id
    WHERE jl.journal_entry_id = NEW.id AND a.tenant_id IS NOT NULL
  LOOP
    PERFORM recompute_tenant_balance(v_tenant_id);
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sync_tenant_balance_status ON acct_journal_entries;
CREATE TRIGGER sync_tenant_balance_status
AFTER UPDATE ON acct_journal_entries
FOR EACH ROW
EXECUTE FUNCTION trg_sync_balance_from_je_status();
