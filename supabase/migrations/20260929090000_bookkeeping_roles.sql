-- Bookkeeping actions open to the whole accounting tier (admin, owner, pm,
-- manager, office_assistant, accountant -- is_accounting_tier, 20260929080000),
-- not just managers. Follows the JE void change: office assistants and
-- accountants keep the books, so they also need to
--   * delete a $0 GL account (was trg_mgmt_gate_del -> is_management_tier), and
--   * set / remove the accounting period lock (was admin/manager only by RLS).
-- Re-opening a reconciliation and adding journal entries were only hidden in
-- the UI; RLS already allowed staff.
--
-- Separate trigger for the same reason as trg_je_void_gate: the shared
-- enforce_management_tier_destructive is redefined by in-flight migrations,
-- so dropping acct_accounts from it here would not stick. With the old
-- trigger gone its acct_accounts branch is never reached.

CREATE OR REPLACE FUNCTION public.enforce_acct_delete_role()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public','pg_temp' AS $$
BEGIN
  IF current_user = 'authenticated' AND NOT public.is_accounting_tier(OLD.company_id) THEN
    RAISE EXCEPTION 'Your role cannot delete a GL account — only accounting staff can.'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_mgmt_gate_del ON public.acct_accounts;
DROP TRIGGER IF EXISTS trg_acct_delete_gate ON public.acct_accounts;
CREATE TRIGGER trg_acct_delete_gate BEFORE DELETE ON public.acct_accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_acct_delete_role();

-- Permissive policies are OR'd: this widens apl_write (admin/manager) to the
-- accounting tier for insert/update/delete. Reads stay apl_read (members).
DROP POLICY IF EXISTS apl_write_accounting ON public.accounting_period_lock;
CREATE POLICY apl_write_accounting ON public.accounting_period_lock
  FOR ALL TO authenticated
  USING (public.is_accounting_tier(company_id))
  WITH CHECK (public.is_accounting_tier(company_id));
