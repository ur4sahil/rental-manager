-- Replace the "final bill pending" TOGGLE with a TWO-LINE model: when a utility
-- flips owner->tenant, keep the ongoing tenant line and AUTO-CREATE a separate
-- owner-responsible line flagged is_final_bill for the closeout. That line is a
-- normal owner utility -- shown, swept, payable, receipt-captured -- and the
-- user archives it once paid. No pending/settled state, no toggle.
--
-- final_bill_status (from 20260922090000/100000) is left in place but unused.

ALTER TABLE public.utilities        ADD COLUMN IF NOT EXISTS is_final_bill boolean NOT NULL DEFAULT false;
ALTER TABLE public.utility_accounts ADD COLUMN IF NOT EXISTS is_final_bill boolean NOT NULL DEFAULT false;

-- The auto-settle trigger belonged to the toggle model -- gone.
DROP TRIGGER IF EXISTS settle_final_bill_after_paid ON public.utility_bills;
DROP FUNCTION IF EXISTS public.settle_final_bill_on_paid();

-- Bridge: mirror a utilities row into a utility_account (carrying is_final_bill,
-- so a final-bill owner account coexists with the regular one for the same
-- provider), and on an owner->tenant FLIP auto-create the owner final-bill line.
CREATE OR REPLACE FUNCTION public.bridge_utility_account()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_prior_resp text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.archived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.utility_accounts a WHERE a.legacy_utility_id = NEW.id)
       AND NOT EXISTS (SELECT 1 FROM public.utility_accounts a
                        WHERE a.company_id = NEW.company_id AND a.property = NEW.property
                          AND lower(btrim(a.provider)) = lower(btrim(NEW.provider))
                          AND a.is_final_bill = COALESCE(NEW.is_final_bill,false)
                          AND a.archived_at IS NULL) THEN
      INSERT INTO public.utility_accounts (
        company_id, property, provider, provider_display, account_number,
        responsibility, is_final_bill, website, account_type, legacy_utility_id,
        username_encrypted, password_encrypted, encryption_iv,
        encryption_iv_username, encryption_salt, property_id)
      VALUES (
        NEW.company_id, NEW.property, NEW.provider, NEW.provider,
        COALESCE(NEW.account_number,''), COALESCE(NEW.responsibility,'owner'),
        COALESCE(NEW.is_final_bill,false),
        COALESCE(NEW.website,''), public.util_account_type(NEW.type, NEW.provider), NEW.id,
        NEW.username_encrypted, NEW.password_encrypted, NEW.encryption_iv,
        NEW.encryption_iv_username, NEW.encryption_salt, NEW.property_id);
    END IF;

    IF NEW.archived_at IS NULL
       AND COALESCE(NEW.is_final_bill,false) = false
       AND COALESCE(NEW.responsibility,'owner') = 'tenant' THEN
      SELECT a.responsibility INTO v_prior_resp
        FROM public.utility_accounts a
       WHERE a.company_id = NEW.company_id AND a.property = NEW.property
         AND lower(btrim(a.provider)) = lower(btrim(NEW.provider))
         AND a.is_final_bill = false
         AND (a.legacy_utility_id IS DISTINCT FROM NEW.id)
       ORDER BY (a.archived_at IS NULL) DESC, a.created_at DESC
       LIMIT 1;
      IF v_prior_resp IN ('owner','condo_fee')
         AND NOT EXISTS (SELECT 1 FROM public.utilities u
                          WHERE u.company_id = NEW.company_id AND u.property = NEW.property
                            AND lower(btrim(u.provider)) = lower(btrim(NEW.provider))
                            AND u.is_final_bill = true AND u.archived_at IS NULL) THEN
        INSERT INTO public.utilities (
          company_id, property, provider, type, account_number, amount, due,
          responsibility, is_final_bill, status, website,
          username_encrypted, password_encrypted, encryption_iv,
          encryption_iv_username, encryption_salt)
        VALUES (
          NEW.company_id, NEW.property, NEW.provider, NEW.type,
          NEW.account_number, 0, NEW.due,
          'owner', true, 'pending', COALESCE(NEW.website,''),
          NEW.username_encrypted, NEW.password_encrypted, NEW.encryption_iv,
          NEW.encryption_iv_username, NEW.encryption_salt);
      END IF;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
      UPDATE public.utility_accounts SET archived_at = NEW.archived_at, updated_at = now()
       WHERE legacy_utility_id = NEW.id AND archived_at IS NULL;
    END IF;
  END IF;
  RETURN NEW;
END $function$;

-- commit_property_wizard's utilities archive-all (edit mode) must EXCLUDE final-
-- bill lines, so a wizard re-save never wipes or re-duplicates them. The only
-- change to that function is adding `AND is_final_bill IS NOT TRUE` to:
--   UPDATE utilities SET archived_at=now()
--     WHERE company_id=v_company_id AND property=v_address AND archived_at IS NULL;
-- The full CREATE OR REPLACE with that clause was applied to the database (it is
-- otherwise byte-for-byte the 20260922080000 body); see that migration for the body.
