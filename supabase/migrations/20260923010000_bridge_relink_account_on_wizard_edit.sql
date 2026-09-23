-- Keep a property's utility_account attached to its LIVE legacy utilities row.
--
-- THE BUG THIS FIXES
--
-- commit_property_wizard, in edit mode, archives every one of a property's
-- `utilities` rows and then inserts fresh ones (archive-first, insert-second).
-- The old bridge trigger only ever CREATED an account when none existed for a
-- property+provider, and never re-pointed an existing one. So after a wizard
-- edit the account was left linked (legacy_utility_id) to the now-archived
-- row, while the new live row had no account pointing at it.
--
-- Everything downstream is keyed on that link -- record_utility_reading finds
-- the account via legacy_utility_id, sweep-targets' skip-if-current walks it,
-- and api/ai.js resolves the bill to attach a statement through it. So a
-- reading matched the live legacy row by account number, found no account, and
-- reported "utility N has no utility_accounts row -- re-run the phase 1
-- backfill". The backfill could not help: its dedup guard skips any
-- property+provider that already has an account. Three Sigma Pepco accounts
-- (10204 Prince Pl, 1041 Saint Michaels, 30 Joyceton) were stranded this way.
--
-- THE FIX
--
-- On INSERT of a live legacy row, if an account already exists for this
-- property+provider, FOLLOW it to the new row instead of creating a second
-- account (which would fragment the bill history across two account ids).
-- Prefer an active account; otherwise revive the most recent archived one --
-- because the wizard archives before it re-inserts, the account we must keep
-- may have just been archived in this same transaction. Adopt the new row's
-- account number only when the account has none, so a number corrected in the
-- Utilities module is not clobbered by a stale wizard value.
--
-- The UPDATE (archive-on-archive) branch is unchanged: a genuinely removed
-- utility (archived with no matching re-insert) still archives its account.
-- The legacy_utility_id UNIQUE index guarantees at most one account per legacy
-- row, so re-pointing is safe.

CREATE OR REPLACE FUNCTION public.bridge_utility_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE
  v_acct_id int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.archived_at IS NULL THEN
      -- Already linked to this exact legacy row: nothing to do.
      IF EXISTS (SELECT 1 FROM public.utility_accounts a WHERE a.legacy_utility_id = NEW.id) THEN
        RETURN NEW;
      END IF;

      -- Follow an existing account for this property+provider to the new live
      -- row. Active first; else the most recently archived (id desc).
      SELECT a.id INTO v_acct_id
        FROM public.utility_accounts a
       WHERE a.company_id = NEW.company_id
         AND a.property = NEW.property
         AND lower(a.provider) = lower(NEW.provider)
       ORDER BY (a.archived_at IS NULL) DESC, a.id DESC
       LIMIT 1;

      IF v_acct_id IS NOT NULL THEN
        UPDATE public.utility_accounts a
           SET legacy_utility_id = NEW.id,
               archived_at = NULL,
               account_number = CASE WHEN COALESCE(a.account_number,'') = ''
                                     THEN COALESCE(NEW.account_number,'')
                                     ELSE a.account_number END,
               updated_at = now()
         WHERE a.id = v_acct_id;
        RETURN NEW;
      END IF;

      -- No account for this property+provider yet: create one (original path).
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
