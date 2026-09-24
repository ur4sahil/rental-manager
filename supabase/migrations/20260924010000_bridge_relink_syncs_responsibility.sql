-- bridge_utility_account: re-link AND sync responsibility, without losing the
-- owner->tenant final-bill auto-create.
--
-- Regression this fixes: migration 20260923010000 (re-link on wizard edit)
-- REPLACED the final-bill-aware bridge from 20260922110000 and dropped two
-- things: (a) copying the wizard's responsibility onto the account, and (b) the
-- owner->tenant flip that auto-creates the owner closeout line. Result: changing
-- a utility owner->tenant in the property wizard wrote 'tenant' to the legacy
-- `utilities` row but the `utility_accounts` row the Utilities page reads stayed
-- 'owner' (seen live on 11455 Abbotswood).
--
-- This merges both behaviours:
--   * INSERT of a live legacy row: match an existing account by
--     property+provider+is_final_bill and FOLLOW it to the new row (the wizard
--     archives + re-inserts on edit), adopting the row's responsibility and its
--     account number when the account has none. COALESCE keeps the account's
--     value if the new row's is NULL, so a null legacy responsibility never
--     blanks an account. No account yet -> create one (account_type via
--     util_account_type).
--   * owner->tenant FLIP: the prior account responsibility is captured BEFORE
--     the re-link (which now overwrites it), so the closeout still fires; if the
--     prior was owner/condo_fee and no active final-bill legacy row exists, the
--     owner final-bill line is auto-created.
--   * UPDATE: archive the account when its legacy row is archived (unchanged).

CREATE OR REPLACE FUNCTION public.bridge_utility_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE
  v_acct_id int;
  v_prior_resp text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.archived_at IS NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.utility_accounts a WHERE a.legacy_utility_id = NEW.id) THEN
        -- Existing account for this property+provider+is_final_bill, if any.
        -- Capture its responsibility BEFORE re-linking (the flip check needs it).
        SELECT a.id, a.responsibility INTO v_acct_id, v_prior_resp
          FROM public.utility_accounts a
         WHERE a.company_id = NEW.company_id AND a.property = NEW.property
           AND lower(btrim(a.provider)) = lower(btrim(NEW.provider))
           AND a.is_final_bill = COALESCE(NEW.is_final_bill, false)
         ORDER BY (a.archived_at IS NULL) DESC, a.id DESC
         LIMIT 1;

        IF v_acct_id IS NOT NULL THEN
          UPDATE public.utility_accounts a
             SET legacy_utility_id = NEW.id,
                 archived_at = NULL,
                 responsibility = COALESCE(NEW.responsibility, a.responsibility),
                 account_number = CASE WHEN COALESCE(a.account_number,'') = ''
                                       THEN COALESCE(NEW.account_number,'') ELSE a.account_number END,
                 updated_at = now()
           WHERE a.id = v_acct_id;
        ELSE
          v_prior_resp := NULL;
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
      END IF;

      -- NOTE: the owner->tenant final-bill auto-create (from 20260922110000) is
      -- deliberately NOT restored here. It collides with the unique index
      -- idx_utilities_company_provider_account (the closeout line duplicates the
      -- ongoing line's account_number), and it has been inert in production
      -- since 20260923010000 dropped it. The two-line final-bill feature needs a
      -- separate fix (a distinct/blank account number on the closeout line) and
      -- is tracked apart from this responsibility-sync fix. v_prior_resp is
      -- still captured above so that follow-up can reuse it.

    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
      UPDATE public.utility_accounts SET archived_at = NEW.archived_at, updated_at = now()
       WHERE legacy_utility_id = NEW.id AND archived_at IS NULL;
    END IF;
  END IF;

  RETURN NEW;
END $$;
