-- Follow-up to 20260922030000: writing the account number as an empty string ''
-- collided with the unique index idx_utilities_company_provider_account (which
-- treats '' as a real value), so a property with a number-less utility -- or an
-- archived one -- failed the whole wizard commit ("duplicate key ...
-- idx_utilities_company_provider_account"). Write NULL instead of '' so
-- number-less utilities never collide.
DO $mig$
DECLARE src text;
BEGIN
  SELECT pg_get_functiondef('public.commit_property_wizard(jsonb)'::regprocedure) INTO src;
  IF position('COALESCE(v_u->>''account_number'','''')' IN src) = 0 THEN RETURN; END IF;
  src := replace(src, 'COALESCE(v_u->>''account_number'','''')', 'NULLIF(v_u->>''account_number'','''')');
  EXECUTE src;
END $mig$;
