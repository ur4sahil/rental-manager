-- Voiding a journal entry is day-to-day bookkeeping, not a management-only
-- action. The Sep 25 destructive gate (20260925010000) put JE void behind
-- is_management_tier, which blocked office assistants AND accountants --
-- the people who actually keep the books -- from voiding an entry, from the
-- Void button and from bank Undo (undo_bank_transaction / void_journal_entry
-- are SECURITY INVOKER, so the gate fired for them too).
--
-- New rule: any active member whose role can open Accounting may void.
-- That is admin, owner, pm, manager, office_assistant, accountant -- the
-- roles whose page lists include "accounting" in App.js ROLES. Anyone else
-- (maintenance, tenant, owner-portal users) is still refused.
--
-- A SEPARATE trigger rather than an edit to enforce_management_tier_destructive:
-- that shared function is redefined by other in-flight migrations (owners,
-- property delete), and editing it here would be silently undone by
-- whichever of them applies later. With trg_mgmt_gate gone from
-- acct_journal_entries, its JE branch is simply never reached.

CREATE OR REPLACE FUNCTION public.is_accounting_tier(p_company_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.company_members cm
     WHERE cm.company_id = p_company_id
       AND lower(cm.user_email) = lower(current_setting('request.jwt.claims', true)::json->>'email')
       AND cm.status = 'active'
       AND cm.role IN ('admin','owner','pm','manager','office_assistant','accountant')
  );
$$;
REVOKE ALL ON FUNCTION public.is_accounting_tier(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_accounting_tier(text) TO authenticated, service_role;

-- SECURITY INVOKER on purpose: current_user must be the caller for the
-- 'authenticated' check (DEFINER would make it the owner and disable the gate).
CREATE OR REPLACE FUNCTION public.enforce_je_void_role()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public','pg_temp' AS $$
BEGIN
  IF current_user = 'authenticated'
     AND OLD.status IS DISTINCT FROM 'voided' AND NEW.status = 'voided'
     AND NOT public.is_accounting_tier(NEW.company_id) THEN
    RAISE EXCEPTION 'Your role cannot void a journal entry — only accounting staff can.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_mgmt_gate ON public.acct_journal_entries;
DROP TRIGGER IF EXISTS trg_je_void_gate ON public.acct_journal_entries;
CREATE TRIGGER trg_je_void_gate BEFORE UPDATE ON public.acct_journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_je_void_role();
