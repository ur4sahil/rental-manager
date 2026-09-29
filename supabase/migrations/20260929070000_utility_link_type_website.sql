-- Utility type and website now follow a wizard edit to the Utilities page.
--
-- Each utility is stored twice: the `utilities` row (what the setup wizard
-- and the bill sweep use) and its `utility_accounts` row (what the Utilities
-- page shows). bridge_utility_account copies an edit of the utilities row to
-- its account, but only provider, account number, property, responsibility
-- and the login -- not the utility TYPE or the WEBSITE, both of which the
-- Utilities page displays from the account. Changing "Electric" to "Gas" or a
-- portal URL in the wizard left the Utilities page showing the old value
-- (reported 2026-09-29; reproduced on TEST).
--
-- Body identical to 20260929030000 except: type -> account_type (through the
-- same util_account_type() the INSERT path uses) and website are synced on
-- UPDATE, only when they changed and the account differs (no ping-pong: no
-- trigger on utility_accounts writes utilities).

CREATE OR REPLACE FUNCTION public.bridge_utility_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE
  v_acct_id int;
  v_prior_resp text;
  v_flip boolean := false;
  v_creds_changed boolean;
  v_named text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The Accounts tab NAMES the account a new utilities row belongs to
    -- (save_utility_line_for_account). Consumed once, so the closeout INSERT
    -- below, which re-enters this trigger, never inherits it.
    v_named := NULLIF(current_setting('app.utility_named_account', true), '');
    IF v_named IS NOT NULL THEN
      PERFORM set_config('app.utility_named_account', '', true);
    END IF;
    IF NEW.archived_at IS NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.utility_accounts a WHERE a.legacy_utility_id = NEW.id) THEN
        IF v_named = 'new' THEN
          -- A brand-new account: create it; never adopt someone else's.
          v_acct_id := NULL;
        ELSIF v_named IS NOT NULL THEN
          -- Exactly the account the app named -- no candidate matching.
          SELECT a.id, a.responsibility INTO v_acct_id, v_prior_resp
            FROM public.utility_accounts a
           WHERE a.id = v_named::int AND a.company_id = NEW.company_id;
          IF v_acct_id IS NULL THEN
            RAISE EXCEPTION 'utility account % is not in this company', v_named USING ERRCODE = '42501';
          END IF;
          -- Never give a named account a SECOND live line: a concurrent save
          -- would otherwise leave an orphan live utilities row behind.
          IF EXISTS (SELECT 1 FROM public.utility_accounts a
                       JOIN public.utilities x ON x.id = a.legacy_utility_id
                      WHERE a.id = v_acct_id AND x.id <> NEW.id AND x.archived_at IS NULL) THEN
            RAISE EXCEPTION 'utility account % already has a live utility line', v_acct_id USING ERRCODE = '23505';
          END IF;
        ELSE
        -- Nothing named (the wizard, imports): match a candidate.
        SELECT a.id, a.responsibility INTO v_acct_id, v_prior_resp
          FROM public.utility_accounts a
         WHERE a.company_id = NEW.company_id AND a.property = NEW.property
           AND lower(btrim(a.provider)) = lower(btrim(NEW.provider))
           AND a.is_final_bill = COALESCE(NEW.is_final_bill, false)
           -- A person deleted this account: do not bring it back.
           AND a.archived_reason IS DISTINCT FROM 'user_deleted'
           -- A DIFFERENT meter is a different account: never adopt one whose
           -- account number differs from the new row's. (Removing a meter and
           -- adding another of the same provider used to re-point the old
           -- account -- its number, bill history and a bogus final bill -- at
           -- the new row.) The wizard's own archive+reinsert keeps the same
           -- number, and a blank number on either side still matches.
           AND (NULLIF(btrim(a.account_number), '') IS NULL
                OR NULLIF(btrim(NEW.account_number), '') IS NULL
                OR lower(btrim(a.account_number)) = lower(btrim(NEW.account_number)))
           -- Never take an account away from another LIVE utilities row.
           AND (a.legacy_utility_id IS NULL
                OR NOT EXISTS (SELECT 1 FROM public.utilities x
                                WHERE x.id = a.legacy_utility_id AND x.archived_at IS NULL))
         ORDER BY (a.archived_at IS NULL) DESC,
                  (COALESCE(a.account_number,'') = COALESCE(NEW.account_number,'')) DESC,
                  a.id DESC
         LIMIT 1;
        END IF;
        IF v_acct_id IS NOT NULL THEN
          UPDATE public.utility_accounts a
             SET legacy_utility_id = NEW.id, archived_at = NULL, archived_reason = NULL,
                 property = NEW.property, property_id = COALESCE(NEW.property_id, a.property_id),
                 responsibility = COALESCE(NEW.responsibility, a.responsibility),
                 provider = NEW.provider,
                 account_number = COALESCE(NULLIF(NEW.account_number,''), a.account_number, ''),
                 username_encrypted     = CASE WHEN NEW.username_encrypted IS NOT NULL THEN NEW.username_encrypted     ELSE a.username_encrypted END,
                 password_encrypted     = CASE WHEN NEW.username_encrypted IS NOT NULL THEN NEW.password_encrypted     ELSE a.password_encrypted END,
                 encryption_iv          = CASE WHEN NEW.username_encrypted IS NOT NULL THEN NEW.encryption_iv          ELSE a.encryption_iv END,
                 encryption_iv_username = CASE WHEN NEW.username_encrypted IS NOT NULL THEN NEW.encryption_iv_username ELSE a.encryption_iv_username END,
                 encryption_salt        = CASE WHEN NEW.username_encrypted IS NOT NULL THEN NEW.encryption_salt        ELSE a.encryption_salt END,
                 credential_key_fp      = CASE WHEN NEW.username_encrypted IS NOT NULL THEN NEW.credential_key_fp      ELSE a.credential_key_fp END,
                 updated_at = now()
           WHERE a.id = v_acct_id;
        ELSE
          INSERT INTO public.utility_accounts (
            company_id, property, provider, provider_display, account_number,
            responsibility, is_final_bill, website, account_type, legacy_utility_id,
            username_encrypted, password_encrypted, encryption_iv, encryption_iv_username,
            encryption_salt, credential_key_fp, property_id)
          VALUES (NEW.company_id, NEW.property, NEW.provider, NEW.provider,
            COALESCE(NEW.account_number,''), COALESCE(NEW.responsibility,'owner'), COALESCE(NEW.is_final_bill,false),
            COALESCE(NEW.website,''), public.util_account_type(NEW.type, NEW.provider), NEW.id,
            NEW.username_encrypted, NEW.password_encrypted, NEW.encryption_iv, NEW.encryption_iv_username,
            NEW.encryption_salt, NEW.credential_key_fp, NEW.property_id);
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

    -- Sync what changed on the live utilities row to its live account.
    IF NEW.archived_at IS NULL THEN
      v_creds_changed := (NEW.username_encrypted     IS DISTINCT FROM OLD.username_encrypted
                       OR NEW.password_encrypted     IS DISTINCT FROM OLD.password_encrypted
                       OR NEW.encryption_iv          IS DISTINCT FROM OLD.encryption_iv
                       OR NEW.encryption_iv_username IS DISTINCT FROM OLD.encryption_iv_username
                       OR NEW.encryption_salt        IS DISTINCT FROM OLD.encryption_salt
                       OR NEW.credential_key_fp      IS DISTINCT FROM OLD.credential_key_fp);
      IF v_creds_changed
         OR NEW.account_number IS DISTINCT FROM OLD.account_number
         OR NEW.provider       IS DISTINCT FROM OLD.provider
         OR NEW.property       IS DISTINCT FROM OLD.property
         OR NEW.responsibility IS DISTINCT FROM OLD.responsibility
         OR NEW.type           IS DISTINCT FROM OLD.type
         OR NEW.website        IS DISTINCT FROM OLD.website THEN
        UPDATE public.utility_accounts a SET
          account_number = CASE WHEN NEW.account_number IS DISTINCT FROM OLD.account_number
                                THEN COALESCE(NEW.account_number,'') ELSE a.account_number END,
          provider = CASE WHEN NEW.provider IS DISTINCT FROM OLD.provider THEN NEW.provider ELSE a.provider END,
          provider_display = CASE WHEN NEW.provider IS DISTINCT FROM OLD.provider
                                   AND (a.provider_display IS NULL OR lower(btrim(a.provider_display)) = lower(btrim(COALESCE(OLD.provider,''))))
                                  THEN NEW.provider ELSE a.provider_display END,
          property = CASE WHEN NEW.property IS DISTINCT FROM OLD.property THEN NEW.property ELSE a.property END,
          property_id = CASE WHEN NEW.property IS DISTINCT FROM OLD.property THEN NEW.property_id ELSE a.property_id END,
          responsibility = CASE WHEN NEW.responsibility IS DISTINCT FROM OLD.responsibility
                                THEN COALESCE(NEW.responsibility,'owner') ELSE a.responsibility END,
          account_type = CASE WHEN NEW.type IS DISTINCT FROM OLD.type
                              THEN public.util_account_type(NEW.type, NEW.provider) ELSE a.account_type END,
          website = CASE WHEN NEW.website IS DISTINCT FROM OLD.website THEN COALESCE(NEW.website, '') ELSE a.website END,
          username_encrypted     = CASE WHEN v_creds_changed THEN NEW.username_encrypted     ELSE a.username_encrypted END,
          password_encrypted     = CASE WHEN v_creds_changed THEN NEW.password_encrypted     ELSE a.password_encrypted END,
          encryption_iv          = CASE WHEN v_creds_changed THEN NEW.encryption_iv          ELSE a.encryption_iv END,
          encryption_iv_username = CASE WHEN v_creds_changed THEN NEW.encryption_iv_username ELSE a.encryption_iv_username END,
          encryption_salt        = CASE WHEN v_creds_changed THEN NEW.encryption_salt        ELSE a.encryption_salt END,
          credential_key_fp      = CASE WHEN v_creds_changed THEN NEW.credential_key_fp      ELSE a.credential_key_fp END,
          updated_at = now()
         WHERE a.legacy_utility_id = NEW.id AND a.archived_at IS NULL
           -- Only when something actually differs: the app writes the same
           -- values to both rows, and that must not bounce.
           AND ((NEW.account_number IS DISTINCT FROM OLD.account_number AND a.account_number IS DISTINCT FROM COALESCE(NEW.account_number,''))
             OR (NEW.provider IS DISTINCT FROM OLD.provider AND a.provider IS DISTINCT FROM NEW.provider)
             OR (NEW.property IS DISTINCT FROM OLD.property AND a.property IS DISTINCT FROM NEW.property)
             OR (NEW.responsibility IS DISTINCT FROM OLD.responsibility AND a.responsibility IS DISTINCT FROM COALESCE(NEW.responsibility,'owner'))
             OR (NEW.type IS DISTINCT FROM OLD.type AND a.account_type IS DISTINCT FROM public.util_account_type(NEW.type, NEW.provider))
             OR (NEW.website IS DISTINCT FROM OLD.website AND a.website IS DISTINCT FROM COALESCE(NEW.website, ''))
             OR (v_creds_changed AND (a.username_encrypted IS DISTINCT FROM NEW.username_encrypted
                                   OR a.password_encrypted IS DISTINCT FROM NEW.password_encrypted
                                   OR a.encryption_iv IS DISTINCT FROM NEW.encryption_iv
                                   OR a.encryption_iv_username IS DISTINCT FROM NEW.encryption_iv_username
                                   OR a.encryption_salt IS DISTINCT FROM NEW.encryption_salt
                                   OR a.credential_key_fp IS DISTINCT FROM NEW.credential_key_fp)));
      END IF;
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
      encryption_iv_username, encryption_salt, credential_key_fp)
    VALUES (
      NEW.company_id, NEW.property, NEW.provider, NEW.type,
      NEW.account_number, 0, NEW.due,
      'owner', true, 'pending', COALESCE(NEW.website,''),
      NEW.username_encrypted, NEW.password_encrypted, NEW.encryption_iv,
      NEW.encryption_iv_username, NEW.encryption_salt, NEW.credential_key_fp);
  END IF;

  RETURN NEW;
END $$;

-- A trigger function: never an RPC. Firing a trigger does not check EXECUTE.
REVOKE ALL ON FUNCTION public.bridge_utility_account() FROM PUBLIC, anon, authenticated;
