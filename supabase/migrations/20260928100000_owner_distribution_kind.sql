-- Owner distributions: tell accruals from payouts, and follow voids.
--
-- owner_distributions holds two different things, both as positive amounts:
--   * the fee ACCRUAL posted when rent is received (autoOwnerDistribution /
--     the Stripe webhook; journal reference ODIST-...; DR 4000 / CR 4200 /
--     CR 2200) -- what the owner is owed, and
--   * the PAYOUT recorded by "Pay Owner" (journal reference DIST-... or,
--     before this change, whatever the user typed as the reference; DR 2200 /
--     CR Checking) -- what was actually paid.
-- "Distributed (YTD)" summed both, so every dollar paid counted twice.
--
-- 1. kind ('accrual' | 'payout'). Writers set it. Rows written without it
--    (an older client) get it from the reference by the trigger below, the
--    same rule used to backfill: ODIST- = accrual, anything else = payout.
--    Backfill on TEST: every existing row. At the time of writing TEST had
--    two rows, both hand-recorded payouts with an empty reference -> payout.
-- 2. voided_at. Voiding the linked journal entry (same company, same
--    reference) stamps it; un-voiding clears it. Readers exclude voided rows
--    from totals. The row itself is kept (no delete) so history survives.
-- 3. The management-tier gate (20260925010000 / 20260925050000) gated EVERY
--    insert into owner_distributions as "record an owner payout". An accrual
--    is not a payout -- it is booked automatically when an office assistant
--    records a tenant's rent -- so the gate now applies to payouts only.
-- 4. owners.management_fee_pct DEFAULT 10 -> DEFAULT NULL. The one fee rule
--    (src/utils/ownerRules.js#resolveMgmtFeePct) is: 0 means 0, NULL means
--    "not set" (0%, flagged in the UI). A default of 10 silently set a fee
--    nobody chose on any insert that omitted the column. Existing rows are
--    not changed.
-- SECURITY INVOKER throughout: nothing here needs to bypass RLS.

ALTER TABLE public.owner_distributions ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE public.owner_distributions ADD COLUMN IF NOT EXISTS voided_at timestamptz;

UPDATE public.owner_distributions
   SET kind = CASE WHEN reference LIKE 'ODIST-%' THEN 'accrual' ELSE 'payout' END
 WHERE kind IS NULL;

ALTER TABLE public.owner_distributions ALTER COLUMN kind SET NOT NULL;
ALTER TABLE public.owner_distributions DROP CONSTRAINT IF EXISTS owner_distributions_kind_check;
ALTER TABLE public.owner_distributions ADD CONSTRAINT owner_distributions_kind_check CHECK (kind IN ('accrual','payout'));

CREATE INDEX IF NOT EXISTS idx_owner_distributions_company_reference
  ON public.owner_distributions (company_id, reference);

-- Rows whose journal entry is already voided (and has no live twin).
UPDATE public.owner_distributions d
   SET voided_at = now()
 WHERE d.voided_at IS NULL AND COALESCE(d.reference, '') <> ''
   AND EXISTS (SELECT 1 FROM public.acct_journal_entries j
                WHERE j.company_id = d.company_id AND j.reference = d.reference AND j.status = 'voided')
   AND NOT EXISTS (SELECT 1 FROM public.acct_journal_entries j
                WHERE j.company_id = d.company_id AND j.reference = d.reference AND j.status IS DISTINCT FROM 'voided');

-- kind from the reference when a writer does not send one. Runs BEFORE the
-- CHECK / NOT NULL are evaluated.
CREATE OR REPLACE FUNCTION public.owner_distribution_default_kind()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public','pg_temp' AS $$
BEGIN
  IF NEW.kind IS NULL THEN
    NEW.kind := CASE WHEN COALESCE(NEW.reference, '') LIKE 'ODIST-%' THEN 'accrual' ELSE 'payout' END;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.owner_distribution_default_kind() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_owner_distribution_default_kind ON public.owner_distributions;
CREATE TRIGGER trg_owner_distribution_default_kind BEFORE INSERT ON public.owner_distributions
  FOR EACH ROW EXECUTE FUNCTION public.owner_distribution_default_kind();

-- Void / un-void of the linked journal entry.
CREATE OR REPLACE FUNCTION public.owner_distribution_follow_je_void()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public','pg_temp' AS $$
BEGIN
  IF COALESCE(NEW.reference, '') = '' THEN RETURN NEW; END IF;
  IF NEW.status = 'voided' AND OLD.status IS DISTINCT FROM 'voided' THEN
    UPDATE public.owner_distributions SET voided_at = now()
     WHERE company_id = NEW.company_id AND reference = NEW.reference AND voided_at IS NULL;
  ELSIF OLD.status = 'voided' AND NEW.status IS DISTINCT FROM 'voided' THEN
    UPDATE public.owner_distributions SET voided_at = NULL
     WHERE company_id = NEW.company_id AND reference = NEW.reference AND voided_at IS NOT NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.owner_distribution_follow_je_void() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_owner_distribution_follow_je_void ON public.acct_journal_entries;
CREATE TRIGGER trg_owner_distribution_follow_je_void
  AFTER UPDATE OF status ON public.acct_journal_entries
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.owner_distribution_follow_je_void();

-- The management-tier gate: payouts only. Identical to 20260925050000 except
-- the owner_distributions branch. Fires before the default-kind trigger
-- (alphabetical), so it derives the kind the same way when it is not sent.
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
      IF COALESCE(NEW.kind, CASE WHEN COALESCE(NEW.reference, '') LIKE 'ODIST-%' THEN 'accrual' ELSE 'payout' END) = 'payout' THEN
        v_destructive := true; v_action := 'record an owner payout';
      END IF;
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

ALTER TABLE public.owners ALTER COLUMN management_fee_pct SET DEFAULT NULL;
