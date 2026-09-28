-- A tenant on notice still lives there.
--
-- THE PROBLEM
--
-- The occupancy mirror (20260920000000_one_tenant_record) only counted a
-- tenant whose lease_status = 'active'. Giving notice (Tenants page "Send
-- Notice", Lifecycle notice-to-quit) sets lease_status = 'notice', so the
-- moment a tenant gave notice the property flipped to VACANT and lost its
-- tenant name -- while the tenant was still living there and paying rent.
--
-- And although that migration settled on 'active' as the one word for a live
-- tenancy, eight client code paths kept writing 'current'. The client is
-- fixed in the same change; the trigger below is the safety net for any
-- path (or older cached bundle) that still sends 'current'.
--
-- THE RULE
--
--   * The live tenant at an address is the non-archived tenant whose
--     lease_status is 'active' or 'notice' -- 'active' preferred, then the
--     lowest id.
--   * Property status is 'notice given' when that tenant is on notice,
--     'occupied' when active, and vacant when there is none. 'maintenance',
--     'archived' and other states a person chose are still left alone.
--   * trg_properties_rederive (the "cannot be written around" twin) uses the
--     same rule, or a direct write to the property would undo it.
--
-- idx_tenants_one_active_per_property is deliberately NOT changed: an
-- incoming 'active' tenant may overlap an outgoing 'notice' tenant.

-- ---------------------------------------------------------------------------
-- 1. the mirror: tenants -> properties
CREATE OR REPLACE FUNCTION public.derive_property_occupancy(p_company_id text, p_address text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_t      public.tenants%ROWTYPE;
  v_has    boolean;
  v_notice boolean;
BEGIN
  IF p_company_id IS NULL OR p_address IS NULL OR p_address = '' THEN RETURN; END IF;

  SELECT * INTO v_t FROM public.tenants
   WHERE company_id = p_company_id AND property = p_address
     AND archived_at IS NULL AND lease_status IN ('active','notice')
   ORDER BY (lease_status = 'active') DESC, id LIMIT 1;
  v_has := FOUND;
  v_notice := v_has AND v_t.lease_status = 'notice';

  UPDATE public.properties SET
    -- Only vacant / occupied / notice given are decided here. Other states
    -- were chosen by a person and stay.
    status = CASE
      WHEN v_notice AND status IN ('vacant','occupied','in_setup','notice given') THEN 'notice given'
      WHEN v_has    AND status IN ('vacant','occupied','in_setup','notice given') THEN 'occupied'
      WHEN NOT v_has AND status IN ('occupied','notice given')                   THEN 'vacant'
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

-- ---------------------------------------------------------------------------
-- 2. the direct-write twin uses the same rule
CREATE OR REPLACE FUNCTION public.trg_properties_rederive()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_t      public.tenants%ROWTYPE;
  v_has    boolean;
  v_notice boolean;
BEGIN
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
     AND archived_at IS NULL AND lease_status IN ('active','notice')
   ORDER BY (lease_status = 'active') DESC, id LIMIT 1;
  v_has := FOUND;
  v_notice := v_has AND v_t.lease_status = 'notice';

  NEW.status := CASE
    WHEN v_notice AND NEW.status IN ('vacant','occupied','in_setup','notice given') THEN 'notice given'
    WHEN v_has    AND NEW.status IN ('vacant','occupied','in_setup','notice given') THEN 'occupied'
    WHEN NOT v_has AND NEW.status IN ('occupied','notice given')                   THEN 'vacant'
    ELSE NEW.status END;
  NEW.tenant   := CASE WHEN v_has THEN COALESCE(v_t.name,'') ELSE '' END;
  NEW.tenant_2 := CASE WHEN v_has THEN COALESCE(v_t.co_tenants[1],'') ELSE '' END;
  NEW.tenant_3 := CASE WHEN v_has THEN COALESCE(v_t.co_tenants[2],'') ELSE '' END;
  NEW.tenant_4 := CASE WHEN v_has THEN COALESCE(v_t.co_tenants[3],'') ELSE '' END;
  NEW.tenant_5 := CASE WHEN v_has THEN COALESCE(v_t.co_tenants[4],'') ELSE '' END;
  RETURN NEW;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. safety net: 'current' is stored as 'active'
CREATE OR REPLACE FUNCTION public.trg_tenants_normalize_lease_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NEW.lease_status IS NOT NULL AND lower(btrim(NEW.lease_status)) = 'current' THEN
    NEW.lease_status := 'active';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS tenants_normalize_lease_status ON public.tenants;
CREATE TRIGGER tenants_normalize_lease_status
  BEFORE INSERT OR UPDATE OF lease_status ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.trg_tenants_normalize_lease_status();
