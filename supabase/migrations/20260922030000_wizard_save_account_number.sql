-- Persist the utility account number from the property wizard. Same gap as the
-- utility type: the wizard collected "Account #" but the save payload dropped it
-- and commit_property_wizard never wrote it, so it was always blank (and the
-- bridged utility_accounts row had no number to fetch/pay with). Patch the
-- utilities INSERT in place to write account_number.
DO $mig$
DECLARE src text;
BEGIN
  SELECT pg_get_functiondef('public.commit_property_wizard(jsonb)'::regprocedure) INTO src;
  IF position('company_id, property, provider, type, account_number, amount, due,' IN src) > 0 THEN RETURN; END IF;
  IF position('company_id, property, provider, type, amount, due,' IN src) = 0 THEN
    RAISE EXCEPTION 'utilities INSERT column list not found'; END IF;
  src := replace(src, 'company_id, property, provider, type, amount, due,',
                      'company_id, property, provider, type, account_number, amount, due,');
  src := replace(src, 'v_u->>''provider'', COALESCE(NULLIF(v_u->>''type'',''''),''Electric''), 0,',
                      'v_u->>''provider'', COALESCE(NULLIF(v_u->>''type'',''''),''Electric''), COALESCE(v_u->>''account_number'',''''), 0,');
  EXECUTE src;
END $mig$;
