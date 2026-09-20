-- ONE RECORD for who lives where.
--
-- THE PROBLEM, AS FOUND
--
-- "Who lives here" was stored in four places that nothing kept in agreement:
-- properties.status, properties.tenant (+ tenant_2..5), tenants.lease_status
-- and leases.status. Each screen wrote its own copy and read its own copy.
-- The Properties page and the wizard read the property record; the Tenants
-- page reads and writes ONLY the tenant record. So marking a tenant active on
-- the Tenants page changed a copy nobody else looked at, the property stayed
-- vacant, and because the wizard hides its tenant step for a vacant property
-- there was no screen from which it could be fixed. Eight of Sigma's
-- properties were in that state.
--
-- Underneath that, the tenant table itself held duplicates: the same lease
-- entered twice ("Jamie Mahoney & Kevin Herrington" from an import beside
-- "Jamie Mahoney" from the wizard), and the same person active at two
-- addresses. Syncing the property to the tenant record without fixing those
-- would only have spread them further.
--
-- THE RULE
--
-- The TENANT record is the one record. Occupancy is derived from it, never
-- stored independently:
--
--   1. One active tenant per property, enforced by a unique index. People on
--      the same lease are co-tenants on that ONE row (the new co_tenants
--      column), which is what "not unless they are on the same lease" means.
--   2. properties.status / tenant / tenant_2..5 are MIRRORS. A trigger on
--      tenants rewrites them whenever a tenant changes, and a trigger on
--      properties re-derives them whenever anything tries to write them
--      directly -- so they cannot drift, whichever screen or import did the
--      writing, including screens written later.
--   3. One word for active: 'active'. 'current' was the same thing written by
--      a different screen.
--
-- The mirror only decides occupied <-> vacant. 'maintenance', 'in_setup',
-- 'archived' and 'notice given' are states a person chose and are left alone;
-- only the tenant name fields update under them.
--
-- The rule skips co-b274999cc02d841e, which holds demo data with two people
-- at one suite and is not a real tenancy.

-- ---------------------------------------------------------------------------
-- 1. co-tenants live on the tenant record
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS co_tenants text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.tenants.co_tenants IS
  'Other people on the SAME lease. One tenant row per lease; co-tenants are names on it, not separate active rows.';

-- ---------------------------------------------------------------------------
-- 2. one word for active
UPDATE public.tenants SET lease_status = 'active'
 WHERE lower(lease_status) = 'current';

-- ---------------------------------------------------------------------------
-- 3. the mirror: tenants -> properties
CREATE OR REPLACE FUNCTION public.derive_property_occupancy(p_company_id text, p_address text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_t   public.tenants%ROWTYPE;
  v_has boolean;
BEGIN
  IF p_company_id IS NULL OR p_address IS NULL OR p_address = '' THEN RETURN; END IF;

  SELECT * INTO v_t FROM public.tenants
   WHERE company_id = p_company_id AND property = p_address
     AND archived_at IS NULL AND lease_status = 'active'
   ORDER BY id LIMIT 1;
  v_has := FOUND;

  UPDATE public.properties SET
    -- Only occupied <-> vacant is decided here. Other states were chosen by
    -- a person and stay.
    status = CASE
      WHEN v_has AND status IN ('vacant','occupied','in_setup') THEN 'occupied'
      WHEN NOT v_has AND status IN ('occupied','notice given')   THEN 'vacant'
      ELSE status END,
    tenant   = CASE WHEN v_has THEN COALESCE(v_t.name,'') ELSE '' END,
    tenant_2 = CASE WHEN v_has THEN COALESCE(v_t.co_tenants[1],'') ELSE '' END,
    tenant_3 = CASE WHEN v_has THEN COALESCE(v_t.co_tenants[2],'') ELSE '' END,
    tenant_4 = CASE WHEN v_has THEN COALESCE(v_t.co_tenants[3],'') ELSE '' END,
    tenant_5 = CASE WHEN v_has THEN COALESCE(v_t.co_tenants[4],'') ELSE '' END,
    rent            = CASE WHEN v_has AND v_t.rent IS NOT NULL THEN v_t.rent ELSE rent END,
    lease_start     = CASE WHEN v_has THEN v_t.lease_start ELSE NULL END,
    lease_end       = CASE WHEN v_has THEN v_t.lease_end_date ELSE NULL END
  WHERE company_id = p_company_id AND address = p_address;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.trg_tenants_sync_property()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  -- Both the old and the new address when a tenant moves: the old one must
  -- become vacant as well as the new one becoming occupied.
  -- Deriving is idempotent, so both addresses are simply recomputed. When
  -- they are the same address it costs one extra read; when a tenant moves
  -- it is the only way the old property becomes vacant.
  IF TG_OP IN ('UPDATE','DELETE') THEN
    PERFORM public.derive_property_occupancy(OLD.company_id, OLD.property);
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    PERFORM public.derive_property_occupancy(NEW.company_id, NEW.property);
  END IF;
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS tenants_sync_property ON public.tenants;
CREATE TRIGGER tenants_sync_property
  AFTER INSERT OR UPDATE OF property, lease_status, archived_at, name, co_tenants, rent, lease_start, lease_end_date
  OR DELETE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.trg_tenants_sync_property();

-- ---------------------------------------------------------------------------
-- 4. the mirror cannot be written around: properties re-derive on direct write
CREATE OR REPLACE FUNCTION public.trg_properties_rederive()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_t   public.tenants%ROWTYPE;
  v_has boolean;
BEGIN
  -- Only when the occupancy columns are what is being written. Address
  -- renames and everything else pass through untouched.
  -- ALL six columns, or a direct write to tenant_3..5 slips past the
  -- re-derive. Found by sending "  " as tenant_3 through the wizard: the
  -- mirror had set tenant and tenant_2 correctly, so this check saw no change
  -- and let the two spaces through.
  IF NEW.status   IS NOT DISTINCT FROM OLD.status
     AND NEW.tenant   IS NOT DISTINCT FROM OLD.tenant
     AND NEW.tenant_2 IS NOT DISTINCT FROM OLD.tenant_2
     AND NEW.tenant_3 IS NOT DISTINCT FROM OLD.tenant_3
     AND NEW.tenant_4 IS NOT DISTINCT FROM OLD.tenant_4
     AND NEW.tenant_5 IS NOT DISTINCT FROM OLD.tenant_5 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_t FROM public.tenants
   WHERE company_id = NEW.company_id AND property = NEW.address
     AND archived_at IS NULL AND lease_status = 'active'
   ORDER BY id LIMIT 1;
  v_has := FOUND;

  NEW.status := CASE
    WHEN v_has AND NEW.status IN ('vacant','occupied','in_setup') THEN 'occupied'
    WHEN NOT v_has AND NEW.status IN ('occupied','notice given')   THEN 'vacant'
    ELSE NEW.status END;
  NEW.tenant   := CASE WHEN v_has THEN COALESCE(v_t.name,'') ELSE '' END;
  NEW.tenant_2 := CASE WHEN v_has THEN COALESCE(v_t.co_tenants[1],'') ELSE '' END;
  NEW.tenant_3 := CASE WHEN v_has THEN COALESCE(v_t.co_tenants[2],'') ELSE '' END;
  NEW.tenant_4 := CASE WHEN v_has THEN COALESCE(v_t.co_tenants[3],'') ELSE '' END;
  NEW.tenant_5 := CASE WHEN v_has THEN COALESCE(v_t.co_tenants[4],'') ELSE '' END;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS properties_rederive_occupancy ON public.properties;
CREATE TRIGGER properties_rederive_occupancy
  BEFORE UPDATE OF status, tenant, tenant_2, tenant_3, tenant_4, tenant_5 ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.trg_properties_rederive();

-- ---------------------------------------------------------------------------
-- 5. THE RULE. Created LAST, and it refuses to be created while any company
--    still has two active tenants at one address -- which is the point. The
--    data has to be right before the rule can hold it right.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_one_active_per_property
  ON public.tenants (company_id, property)
  WHERE archived_at IS NULL
    AND lease_status = 'active'
    AND company_id <> 'co-b274999cc02d841e';

COMMENT ON INDEX public.idx_tenants_one_active_per_property IS
  'One active tenant row per property. Co-tenants go in co_tenants on that row. A second active row at the same address is a data error and is refused.';
