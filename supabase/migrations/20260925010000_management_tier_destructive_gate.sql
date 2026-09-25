-- Wave 2 #1: enforce Admin/Owner/Manager (+pm) on destructive & financial
-- actions AT THE DATABASE, not just the UI. office_assistant (and any lower
-- role) is blocked from Delete/Void/Terminate/Pay/Archive/Disable.
--
-- Mechanism: a BEFORE trigger that
--   (1) fires only on DIRECT client writes -- current_user = 'authenticated'.
--       SECURITY DEFINER RPCs run as the function owner and service crons as
--       service_role, so legitimate server paths (the property wizard, batch
--       jobs) are exempt and keep working for every role that may invoke them.
--   (2) detects the specific destructive TRANSITION (not benign edits), and
--   (3) rejects it unless the caller is management tier for that row's company.
-- Benign writes (recording a payment, editing a field) are untouched.

CREATE OR REPLACE FUNCTION public.is_management_tier(p_company_id text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.company_members cm
     WHERE cm.company_id = p_company_id
       AND lower(cm.user_email) = lower(current_setting('request.jwt.claims', true)::json->>'email')
       AND cm.status = 'active'
       AND cm.role IN ('admin','owner','pm','manager')
  );
$$;

CREATE OR REPLACE FUNCTION public.enforce_management_tier_destructive()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public','pg_temp' AS $$
DECLARE
  v_destructive boolean := false;
  v_action text;
  v_cid text;
BEGIN
  -- Only gate direct browser writes. RPCs (owner) and crons (service_role) pass.
  IF current_user = 'authenticated' THEN
    v_cid := COALESCE(NEW.company_id, OLD.company_id);

    IF TG_TABLE_NAME = 'acct_accounts' AND TG_OP = 'DELETE' THEN
      v_destructive := true; v_action := 'delete a GL account';
    ELSIF TG_TABLE_NAME = 'owner_distributions' AND TG_OP = 'INSERT' THEN
      v_destructive := true; v_action := 'record an owner payout';
    ELSIF TG_OP = 'UPDATE' THEN
      IF TG_TABLE_NAME = 'properties' THEN
        IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
          v_destructive := true; v_action := 'delete this property';
        ELSIF OLD.status IS DISTINCT FROM 'inactive' AND NEW.status = 'inactive' THEN
          v_destructive := true; v_action := 'deactivate this property';
        END IF;
      ELSIF TG_TABLE_NAME = 'acct_journal_entries' THEN
        IF OLD.status IS DISTINCT FROM 'voided' AND NEW.status = 'voided' THEN
          v_destructive := true; v_action := 'void a journal entry';
        END IF;
      ELSIF TG_TABLE_NAME = 'leases' THEN
        IF OLD.status IS DISTINCT FROM 'terminated' AND NEW.status = 'terminated' THEN
          v_destructive := true; v_action := 'terminate a lease';
        END IF;
      ELSIF TG_TABLE_NAME = 'autopay_schedules' THEN
        IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
          v_destructive := true; v_action := 'delete an autopay schedule';
        ELSIF COALESCE(OLD.enabled, true) AND NOT COALESCE(NEW.enabled, true) THEN
          v_destructive := true; v_action := 'disable an autopay schedule';
        END IF;
      ELSIF TG_TABLE_NAME IN ('owners','vendors','tenants','utility_accounts','work_orders') THEN
        IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
          v_destructive := true; v_action := 'archive or delete this record';
        END IF;
      END IF;
    END IF;

    IF v_destructive AND NOT public.is_management_tier(v_cid) THEN
      RAISE EXCEPTION 'Your role cannot % — only a manager, owner, or admin can.', v_action
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

-- Attach. Separate names per table so they are easy to see/drop individually.
DROP TRIGGER IF EXISTS trg_mgmt_gate ON public.properties;
CREATE TRIGGER trg_mgmt_gate BEFORE UPDATE ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.enforce_management_tier_destructive();
DROP TRIGGER IF EXISTS trg_mgmt_gate ON public.acct_journal_entries;
CREATE TRIGGER trg_mgmt_gate BEFORE UPDATE ON public.acct_journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_management_tier_destructive();
DROP TRIGGER IF EXISTS trg_mgmt_gate ON public.leases;
CREATE TRIGGER trg_mgmt_gate BEFORE UPDATE ON public.leases
  FOR EACH ROW EXECUTE FUNCTION public.enforce_management_tier_destructive();
DROP TRIGGER IF EXISTS trg_mgmt_gate ON public.autopay_schedules;
CREATE TRIGGER trg_mgmt_gate BEFORE UPDATE ON public.autopay_schedules
  FOR EACH ROW EXECUTE FUNCTION public.enforce_management_tier_destructive();
DROP TRIGGER IF EXISTS trg_mgmt_gate ON public.owners;
CREATE TRIGGER trg_mgmt_gate BEFORE UPDATE ON public.owners
  FOR EACH ROW EXECUTE FUNCTION public.enforce_management_tier_destructive();
DROP TRIGGER IF EXISTS trg_mgmt_gate ON public.vendors;
CREATE TRIGGER trg_mgmt_gate BEFORE UPDATE ON public.vendors
  FOR EACH ROW EXECUTE FUNCTION public.enforce_management_tier_destructive();
DROP TRIGGER IF EXISTS trg_mgmt_gate ON public.tenants;
CREATE TRIGGER trg_mgmt_gate BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.enforce_management_tier_destructive();
DROP TRIGGER IF EXISTS trg_mgmt_gate ON public.utility_accounts;
CREATE TRIGGER trg_mgmt_gate BEFORE UPDATE ON public.utility_accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_management_tier_destructive();
DROP TRIGGER IF EXISTS trg_mgmt_gate ON public.work_orders;
CREATE TRIGGER trg_mgmt_gate BEFORE UPDATE ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_management_tier_destructive();
DROP TRIGGER IF EXISTS trg_mgmt_gate_del ON public.acct_accounts;
CREATE TRIGGER trg_mgmt_gate_del BEFORE DELETE ON public.acct_accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_management_tier_destructive();
DROP TRIGGER IF EXISTS trg_mgmt_gate_ins ON public.owner_distributions;
CREATE TRIGGER trg_mgmt_gate_ins BEFORE INSERT ON public.owner_distributions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_management_tier_destructive();
