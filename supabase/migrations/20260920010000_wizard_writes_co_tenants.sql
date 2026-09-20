-- The wizard writes co-tenants onto the TENANT record.
--
-- The one-record rule mirrors properties.tenant_2..5 FROM tenants.co_tenants.
-- The wizard wrote tenant_2..5 straight onto the property and nothing onto
-- the tenant row, so under the mirror every save would have blanked them.
-- Now the wizard's tenant_2..5 form fields become co_tenants on the one
-- record, and the property gets them from there like everything else does.
--
-- Patched from pg_get_functiondef, as before: no migration in this repo holds
-- the current body of commit_property_wizard.
DO $mig$
DECLARE v_def text; v_a text; v_b text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname='commit_property_wizard';
  IF v_def IS NULL THEN RAISE EXCEPTION 'commit_property_wizard not found'; END IF;

  -- UPDATE branch: add co_tenants after tenant_portion
  v_a := $a$        tenant_portion = NULLIF(v_tenant->>'tenant_portion','')::numeric
      WHERE id = v_existing_tenant_id AND company_id = v_company_id;$a$;
  v_b := $b$        tenant_portion = NULLIF(v_tenant->>'tenant_portion','')::numeric,
        co_tenants = ARRAY(SELECT x FROM unnest(ARRAY[
          NULLIF(btrim(v_tenant->>'tenant_2'),''), NULLIF(btrim(v_tenant->>'tenant_3'),''),
          NULLIF(btrim(v_tenant->>'tenant_4'),''), NULLIF(btrim(v_tenant->>'tenant_5'),'')
        ]) AS x WHERE x IS NOT NULL)
      WHERE id = v_existing_tenant_id AND company_id = v_company_id;$b$;
  IF position(v_a IN v_def) = 0 THEN RAISE EXCEPTION 'UPDATE anchor not found'; END IF;
  v_def := replace(v_def, v_a, v_b);

  -- INSERT branch: column list and values
  v_a := $a$        voucher_portion, tenant_portion
      ) VALUES ($a$;
  v_b := $b$        voucher_portion, tenant_portion, co_tenants
      ) VALUES ($b$;
  IF position(v_a IN v_def) = 0 THEN RAISE EXCEPTION 'INSERT column anchor not found'; END IF;
  v_def := replace(v_def, v_a, v_b);

  v_a := $a$        NULLIF(v_tenant->>'voucher_portion','')::numeric,
        NULLIF(v_tenant->>'tenant_portion','')::numeric
      ) RETURNING id INTO v_tenant_id;$a$;
  v_b := $b$        NULLIF(v_tenant->>'voucher_portion','')::numeric,
        NULLIF(v_tenant->>'tenant_portion','')::numeric,
        ARRAY(SELECT x FROM unnest(ARRAY[
          NULLIF(btrim(v_tenant->>'tenant_2'),''), NULLIF(btrim(v_tenant->>'tenant_3'),''),
          NULLIF(btrim(v_tenant->>'tenant_4'),''), NULLIF(btrim(v_tenant->>'tenant_5'),'')
        ]) AS x WHERE x IS NOT NULL)
      ) RETURNING id INTO v_tenant_id;$b$;
  IF position(v_a IN v_def) = 0 THEN RAISE EXCEPTION 'INSERT values anchor not found'; END IF;
  v_def := replace(v_def, v_a, v_b);

  EXECUTE v_def;
END $mig$;

DO $verify$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname='commit_property_wizard';
  IF (length(v_def) - length(replace(v_def, 'co_tenants', ''))) / length('co_tenants') < 2 THEN
    RAISE EXCEPTION 'co_tenants did not land in both branches';
  END IF;
END $verify$;
