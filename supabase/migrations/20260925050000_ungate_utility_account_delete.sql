-- Utility-account delete/archive is routine ops work delegated to whoever runs
-- utilities (often an office_assistant), unlike void/pay/terminate. Remove
-- utility_accounts from the management-tier destructive gate: drop its trigger
-- and drop it from the trigger function's table list. The financial gates
-- (JE void, owner payout, lease terminate, etc.) are unchanged.
DROP TRIGGER IF EXISTS trg_mgmt_gate ON public.utility_accounts;

CREATE OR REPLACE FUNCTION public.enforce_management_tier_destructive()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public','pg_temp' AS $$
DECLARE
  v_destructive boolean := false;
  v_action text;
  v_cid text;
BEGIN
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
      ELSIF TG_TABLE_NAME IN ('owners','vendors','tenants','work_orders') THEN
        IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
          v_destructive := true; v_action := 'archive or delete this record';
        END IF;
      END IF;
    END IF;
    IF v_destructive AND NOT public.is_management_tier(v_cid) THEN
      RAISE EXCEPTION 'Your role cannot % — only a manager, owner, or admin can.', v_action USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
