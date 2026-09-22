-- Persist the utility TYPE (Gas/Water/Electric) end to end.
--
-- The wizard collected a utility type but the utilities table had no column for
-- it and the commit RPC never wrote it, so every utility reloaded as "Electric".
-- The utilities->utility_accounts bridge then hardcoded account_type='electric',
-- making the Utilities module show everything as Electric too. This adds the
-- column, saves it from the wizard, derives account_type from the real type, and
-- backfills existing rows by type/provider. Verified on test.
ALTER TABLE public.utilities ADD COLUMN IF NOT EXISTS type text;

CREATE OR REPLACE FUNCTION public.util_account_type(p_type text, p_provider text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    CASE lower(replace(coalesce(p_type,''),'-','_'))
      WHEN 'electric' THEN 'electric' WHEN 'gas' THEN 'gas'
      WHEN 'water_sewer' THEN 'water_sewer' WHEN 'water' THEN 'water_sewer'
      WHEN 'trash' THEN 'trash' WHEN 'internet' THEN 'internet' WHEN 'other' THEN 'other'
      ELSE NULL END,
    CASE
      WHEN p_provider ILIKE '%wssc%' OR p_provider ILIKE '%water%' THEN 'water_sewer'
      WHEN p_provider ILIKE '%gas%' THEN 'gas'
      WHEN p_provider ILIKE '%trash%' OR p_provider ILIKE '%waste%' THEN 'trash'
      ELSE 'electric' END);
$$;

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
END $$;

UPDATE public.utilities SET type = CASE
    WHEN provider ILIKE '%wssc%' OR provider ILIKE '%water%' THEN 'Water-Sewer'
    WHEN provider ILIKE '%gas%' THEN 'Gas'
    WHEN provider ILIKE '%trash%' OR provider ILIKE '%waste%' THEN 'Trash'
    ELSE 'Electric' END
  WHERE type IS NULL;

UPDATE public.utility_accounts a
   SET account_type = public.util_account_type(u.type, a.provider), updated_at = now()
  FROM public.utilities u
 WHERE a.legacy_utility_id = u.id AND a.archived_at IS NULL;

-- commit_property_wizard: write the type into utilities (patched in place).
DO $mig$
DECLARE src text;
BEGIN
  SELECT pg_get_functiondef('public.commit_property_wizard(jsonb)'::regprocedure) INTO src;
  IF position('company_id, property, provider, type, amount, due,' IN src) > 0 THEN RETURN; END IF;
  src := replace(src, 'company_id, property, provider, amount, due,', 'company_id, property, provider, type, amount, due,');
  src := replace(src, 'v_company_id, v_address, v_u->>''provider'', 0,', 'v_company_id, v_address, v_u->>''provider'', COALESCE(NULLIF(v_u->>''type'',''''),''Electric''), 0,');
  EXECUTE src;
END $mig$;
