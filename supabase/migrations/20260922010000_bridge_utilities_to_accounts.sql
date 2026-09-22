-- Bridge legacy `utilities` -> `utility_accounts`.
--
-- The Utilities module and the sweep both read `utility_accounts`, but the
-- property-setup wizard writes only `utilities`, and nothing connected the two.
-- So a wizard-added utility (e.g. "city of bowie" on 4229 Crosswick Turn) had a
-- utilities row but no account row, and never appeared in the Utilities module.
--
-- This adds a trigger that creates the account row on insert and archives it
-- when the utility is archived (the wizard's replace-all path), plus a one-time
-- backfill for utilities that already lack one. Idempotent: it never creates a
-- second account for the same utility, nor beside an existing active account
-- for the same property+provider. Verified on test: insert creates one account,
-- a duplicate insert creates none, archiving the utility archives its account.
CREATE OR REPLACE FUNCTION public.bridge_utility_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.archived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.utility_accounts a WHERE a.legacy_utility_id = NEW.id)
       AND NOT EXISTS (SELECT 1 FROM public.utility_accounts a
                        WHERE a.company_id = NEW.company_id AND a.property = NEW.property
                          AND lower(a.provider) = lower(NEW.provider) AND a.archived_at IS NULL) THEN
      INSERT INTO public.utility_accounts (
        company_id, property, provider, provider_display, account_number,
        responsibility, website, account_type, legacy_utility_id,
        username_encrypted, password_encrypted, encryption_iv,
        encryption_iv_username, encryption_salt, property_id)
      VALUES (
        NEW.company_id, NEW.property, NEW.provider, NEW.provider,
        COALESCE(NEW.account_number,''), COALESCE(NEW.responsibility,'owner'),
        COALESCE(NEW.website,''), 'electric', NEW.id,
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
END $$;

DROP TRIGGER IF EXISTS bridge_utility_account_ins ON public.utilities;
DROP TRIGGER IF EXISTS bridge_utility_account_upd ON public.utilities;
CREATE TRIGGER bridge_utility_account_ins AFTER INSERT ON public.utilities FOR EACH ROW EXECUTE FUNCTION public.bridge_utility_account();
CREATE TRIGGER bridge_utility_account_upd AFTER UPDATE ON public.utilities FOR EACH ROW EXECUTE FUNCTION public.bridge_utility_account();

INSERT INTO public.utility_accounts (
  company_id, property, provider, provider_display, account_number,
  responsibility, website, account_type, legacy_utility_id,
  username_encrypted, password_encrypted, encryption_iv,
  encryption_iv_username, encryption_salt, property_id)
SELECT u.company_id, u.property, u.provider, u.provider, COALESCE(u.account_number,''),
       COALESCE(u.responsibility,'owner'), COALESCE(u.website,''), 'electric', u.id,
       u.username_encrypted, u.password_encrypted, u.encryption_iv,
       u.encryption_iv_username, u.encryption_salt, u.property_id
FROM public.utilities u
WHERE u.archived_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.utility_accounts a WHERE a.legacy_utility_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM public.utility_accounts a
                   WHERE a.company_id = u.company_id AND a.property = u.property
                     AND lower(a.provider) = lower(u.provider) AND a.archived_at IS NULL);
