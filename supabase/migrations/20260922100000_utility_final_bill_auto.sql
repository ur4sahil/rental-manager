-- FIX 1: auto-arm final_bill_status when a utility flips owner->tenant.
-- The flip happens in the wizard (utilities table -> bridge -> utility_accounts).
-- The bridge now sets final_bill_status on the NEW tenant account:
--   prior account was tenant  -> carry its status forward (preserve pending/settled across re-saves)
--   prior account was owner/condo (a real flip) -> 'pending' (the closeout bill is the owner's)
--   no prior account (brand-new tenant utility) -> 'none' (nothing was ever in the owner's name)
CREATE OR REPLACE FUNCTION public.bridge_utility_account()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_new_resp text;
  v_prior_resp text;
  v_prior_final text;
  v_final text := 'none';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.archived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.utility_accounts a WHERE a.legacy_utility_id = NEW.id)
       AND NOT EXISTS (SELECT 1 FROM public.utility_accounts a
                        WHERE a.company_id = NEW.company_id AND a.property = NEW.property
                          AND lower(btrim(a.provider)) = lower(btrim(NEW.provider)) AND a.archived_at IS NULL) THEN
      v_new_resp := COALESCE(NEW.responsibility,'owner');
      IF v_new_resp = 'tenant' THEN
        SELECT a.responsibility, a.final_bill_status
          INTO v_prior_resp, v_prior_final
          FROM public.utility_accounts a
         WHERE a.company_id = NEW.company_id AND a.property = NEW.property
           AND lower(btrim(a.provider)) = lower(btrim(NEW.provider))
           AND (a.legacy_utility_id IS DISTINCT FROM NEW.id)
         ORDER BY (a.archived_at IS NULL) DESC, a.created_at DESC
         LIMIT 1;
        IF v_prior_resp = 'tenant' THEN
          v_final := COALESCE(v_prior_final,'none');   -- carry forward
        ELSIF v_prior_resp IS NOT NULL THEN
          v_final := 'pending';                        -- flip owner/condo -> tenant
        ELSE
          v_final := 'none';                           -- brand-new tenant utility
        END IF;
      END IF;
      INSERT INTO public.utility_accounts (
        company_id, property, provider, provider_display, account_number,
        responsibility, final_bill_status, website, account_type, legacy_utility_id,
        username_encrypted, password_encrypted, encryption_iv,
        encryption_iv_username, encryption_salt, property_id)
      VALUES (
        NEW.company_id, NEW.property, NEW.provider, NEW.provider,
        COALESCE(NEW.account_number,''), v_new_resp, v_final,
        COALESCE(NEW.website,''), public.util_account_type(NEW.type, NEW.provider), NEW.id,
        NEW.username_encrypted, NEW.password_encrypted, NEW.encryption_iv,
        NEW.encryption_iv_username, NEW.encryption_salt, NEW.property_id);
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
      UPDATE public.utility_accounts SET archived_at = NEW.archived_at, updated_at = now()
       WHERE legacy_utility_id = NEW.id AND archived_at IS NULL;
    END IF;
  END IF;
  RETURN NEW;
END $function$;

-- FIX 2: settle the owner's pending final bill whenever ANY path marks the bill
-- paid (in-app record, streamed "Pay by card", or portal) -- they all set
-- utility_bills.status='paid'/'settled'. Housy captured the payment either way,
-- so the closeout completes itself; no "Settle final bill" click needed.
CREATE OR REPLACE FUNCTION public.settle_final_bill_on_paid()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  IF NEW.status IN ('paid','settled')
     AND COALESCE(OLD.status,'') NOT IN ('paid','settled')
     AND NEW.utility_account_id IS NOT NULL THEN
    UPDATE public.utility_accounts
       SET final_bill_status='settled', updated_at=now()
     WHERE id = NEW.utility_account_id AND company_id = NEW.company_id
       AND responsibility='tenant' AND final_bill_status='pending';
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS settle_final_bill_after_paid ON public.utility_bills;
CREATE TRIGGER settle_final_bill_after_paid
  AFTER UPDATE ON public.utility_bills
  FOR EACH ROW EXECUTE FUNCTION public.settle_final_bill_on_paid();
