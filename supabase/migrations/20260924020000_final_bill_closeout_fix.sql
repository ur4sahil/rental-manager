-- Fix the owner->tenant final-bill closeout (the two-line model from
-- 20260922110000), which broke two ways:
--   1. My 20260923010000 re-link migration dropped the closeout auto-create.
--   2. The closeout line shares the ongoing line's account number, which the
--      unique index idx_utilities_company_provider_account forbids among live
--      rows -- so restoring the auto-create hit a duplicate-key error.
--
-- Fixes here:
--   A. Widen that unique index to include is_final_bill, so one ongoing
--      (is_final_bill=false) and one closeout (is_final_bill=true) can share an
--      account number while true duplicates within each are still blocked.
--   B. Restore the closeout auto-create in bridge_utility_account, and fire it
--      from BOTH flip paths: the wizard (archive + INSERT of a tenant row) AND
--      the Accounts-tab Edit (a direct UPDATE of responsibility owner->tenant).
--      One INSERT, guarded so at most one active closeout exists per
--      property+provider. The re-link + responsibility sync (from the prior
--      migrations) is preserved.

-- A. index
DROP INDEX IF EXISTS public.idx_utilities_company_provider_account;
CREATE UNIQUE INDEX idx_utilities_company_provider_account
  ON public.utilities (company_id, provider, account_number, is_final_bill)
  WHERE account_number IS NOT NULL AND archived_at IS NULL;

-- B. trigger
CREATE OR REPLACE FUNCTION public.bridge_utility_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE
  v_acct_id int;
  v_prior_resp text;
  v_flip boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.archived_at IS NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.utility_accounts a WHERE a.legacy_utility_id = NEW.id) THEN
        SELECT a.id, a.responsibility INTO v_acct_id, v_prior_resp
          FROM public.utility_accounts a
         WHERE a.company_id = NEW.company_id AND a.property = NEW.property
           AND lower(btrim(a.provider)) = lower(btrim(NEW.provider))
           AND a.is_final_bill = COALESCE(NEW.is_final_bill, false)
         ORDER BY (a.archived_at IS NULL) DESC, a.id DESC
         LIMIT 1;
        IF v_acct_id IS NOT NULL THEN
          UPDATE public.utility_accounts a
             SET legacy_utility_id = NEW.id, archived_at = NULL,
                 responsibility = COALESCE(NEW.responsibility, a.responsibility),
                 account_number = CASE WHEN COALESCE(a.account_number,'') = '' THEN COALESCE(NEW.account_number,'') ELSE a.account_number END,
                 updated_at = now()
           WHERE a.id = v_acct_id;
        ELSE
          INSERT INTO public.utility_accounts (
            company_id, property, provider, provider_display, account_number,
            responsibility, is_final_bill, website, account_type, legacy_utility_id,
            username_encrypted, password_encrypted, encryption_iv, encryption_iv_username, encryption_salt, property_id)
          VALUES (NEW.company_id, NEW.property, NEW.provider, NEW.provider,
            COALESCE(NEW.account_number,''), COALESCE(NEW.responsibility,'owner'), COALESCE(NEW.is_final_bill,false),
            COALESCE(NEW.website,''), public.util_account_type(NEW.type, NEW.provider), NEW.id,
            NEW.username_encrypted, NEW.password_encrypted, NEW.encryption_iv, NEW.encryption_iv_username, NEW.encryption_salt, NEW.property_id);
        END IF;
      END IF;
      -- Flip on INSERT (wizard archive+reinsert): the prior account was the
      -- owner's, the new row is the tenant's.
      IF COALESCE(NEW.is_final_bill,false) = false
         AND COALESCE(NEW.responsibility,'owner') = 'tenant'
         AND v_prior_resp IN ('owner','condo_fee') THEN
        v_flip := true;
      END IF;
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
      UPDATE public.utility_accounts SET archived_at = NEW.archived_at, updated_at = now()
       WHERE legacy_utility_id = NEW.id AND archived_at IS NULL;
    END IF;
    -- Flip on UPDATE (Accounts-tab Edit sets responsibility directly on the
    -- live row): owner/condo -> tenant on a non-final, non-archived row.
    IF NEW.archived_at IS NULL
       AND COALESCE(NEW.is_final_bill,false) = false
       AND COALESCE(OLD.responsibility,'owner') IN ('owner','condo_fee')
       AND COALESCE(NEW.responsibility,'owner') = 'tenant' THEN
      v_flip := true;
    END IF;
  END IF;

  -- Create the owner final-bill closeout line once, if a flip happened and no
  -- active final-bill line already exists for this property+provider. Its own
  -- INSERT re-enters this trigger and creates the matching closeout account.
  IF v_flip
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

  RETURN NEW;
END $$;
