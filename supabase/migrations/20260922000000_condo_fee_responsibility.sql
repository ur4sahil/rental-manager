-- "Covered by condo fee" as a third utility responsibility (beside owner and
-- tenant). The property-setup wizard sends responsibility 'condo_fee', but
-- commit_property_wizard mapped ANYTHING that wasn't 'owner_pays' to 'tenant',
-- which would misfile a condo-fee utility as the tenant's. Patch only that one
-- mapping line, in place, without retyping the 400-line function.
--
-- A condo-fee utility has no separate bill to fetch or pay: the sweep excludes
-- it (api/ai.js sweep-targets), the Pay buttons are hidden, and it is dropped
-- from the dashboard's To-pay / Overdue / Outstanding counts.
DO $$
DECLARE src text;
BEGIN
  SELECT pg_get_functiondef('public.commit_property_wizard(jsonb)'::regprocedure) INTO src;
  IF position('CASE WHEN v_u->>''responsibility'' = ''owner_pays'' THEN ''owner'' ELSE ''tenant'' END' IN src) = 0 THEN
    RAISE EXCEPTION 'commit_property_wizard responsibility mapping not found — aborting';
  END IF;
  src := replace(src,
    'CASE WHEN v_u->>''responsibility'' = ''owner_pays'' THEN ''owner'' ELSE ''tenant'' END',
    'CASE v_u->>''responsibility'' WHEN ''owner_pays'' THEN ''owner'' WHEN ''condo_fee'' THEN ''condo_fee'' ELSE ''tenant'' END');
  EXECUTE src;
END $$;
