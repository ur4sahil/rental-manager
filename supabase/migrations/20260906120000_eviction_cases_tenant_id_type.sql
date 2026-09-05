-- eviction_cases.tenant_id is uuid; tenants.id is integer. createCase
-- writes the tenant's integer id straight into it, so PostgREST answers
-- `invalid input syntax for type uuid` and the insert is rejected: NO
-- eviction case can be opened from the UI at all, and never could.
--
-- Safe to retype: the table holds 2 rows and neither has a tenant_id
-- (they could not -- nothing has ever succeeded in writing one), so
-- there is no data to convert.
--
-- I flagged this column earlier today when adding foreign keys and
-- deliberately left it alone, on the grounds that retyping a column was
-- separate work and not something to smuggle into a FK migration. It is
-- now its own migration, which is where it belonged.
ALTER TABLE public.eviction_cases
  ALTER COLUMN tenant_id TYPE bigint USING NULL;

ALTER TABLE public.eviction_cases DROP CONSTRAINT IF EXISTS eviction_cases_tenant_id_fkey;
ALTER TABLE public.eviction_cases ADD CONSTRAINT eviction_cases_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON UPDATE CASCADE ON DELETE SET NULL;

-- Keep it populated the same way the other tenant-linked tables are, so
-- a case filed by name still resolves to the right tenant.
DROP TRIGGER IF EXISTS eviction_cases_derive_tenant_id ON public.eviction_cases;
CREATE TRIGGER eviction_cases_derive_tenant_id
  BEFORE INSERT OR UPDATE OF tenant_name ON public.eviction_cases
  FOR EACH ROW EXECUTE FUNCTION public.derive_tenant_id_from_tenant_name();

COMMENT ON COLUMN public.eviction_cases.tenant_id IS
  'bigint FK to tenants(id). Was uuid, which made every insert from the UI fail.';
