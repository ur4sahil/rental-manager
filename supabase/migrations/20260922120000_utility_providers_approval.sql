-- Utility provider names were free-text, causing fragmentation. Providers now
-- come from this canonical table via a dropdown. Employees may propose a new
-- one; it lands as approval_status='pending' (scoped to the requesting company,
-- usable immediately) until an admin approves it. Existing rows stay 'approved'.
ALTER TABLE public.utility_providers ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_utility_providers_approval') THEN
    ALTER TABLE public.utility_providers
      ADD CONSTRAINT chk_utility_providers_approval CHECK (approval_status IN ('approved','pending'));
  END IF;
END $$;
ALTER TABLE public.utility_providers ADD COLUMN IF NOT EXISTS requested_by text;
ALTER TABLE public.utility_providers ADD COLUMN IF NOT EXISTS requested_company_id text;

-- The three real providers Sigma uses that were missing from the canonical list.
INSERT INTO public.utility_providers (id, display_name, login_url, region, account_type, is_active, approval_status)
SELECT v.id, v.display_name, v.login_url, v.region, v.account_type, v.is_active, v.approval_status
FROM (VALUES
  ('smeco','SMECO','https://www.smeco.coop/','MD','electric',true,'approved'),
  ('charles_county','Charles County','','MD','water',true,'approved'),
  ('city_of_bowie','City of Bowie','','MD','water',true,'approved')
) AS v(id, display_name, login_url, region, account_type, is_active, approval_status)
WHERE NOT EXISTS (SELECT 1 FROM public.utility_providers p WHERE lower(p.display_name)=lower(v.display_name));

-- RLS: the table had only a read policy, so client inserts/updates were blocked.
-- Allow authenticated users to propose a provider, and to modify only PENDING
-- rows (approve → 'approved', reject → is_active=false). Approved providers are
-- locked. Who may approve is gated in the UI (admins only); the pending-row
-- limit keeps that from letting anyone rewrite an established provider.
DROP POLICY IF EXISTS providers_insert ON public.utility_providers;
CREATE POLICY providers_insert ON public.utility_providers FOR INSERT TO authenticated
  WITH CHECK (approval_status IN ('pending','approved'));
DROP POLICY IF EXISTS providers_update_pending ON public.utility_providers;
CREATE POLICY providers_update_pending ON public.utility_providers FOR UPDATE TO authenticated
  USING (approval_status = 'pending')
  WITH CHECK (approval_status IN ('pending','approved'));

-- Align two canonical display names to the forms the existing data was
-- normalized to (Pepco, WSSC), so the dropdown produces names that MATCH the
-- data instead of re-fragmenting it ("PEPCO"/"WSSC Water" -> "Pepco"/"WSSC").
UPDATE public.utility_providers SET display_name='Pepco' WHERE id='pepco' AND display_name<>'Pepco';
UPDATE public.utility_providers SET display_name='WSSC'  WHERE id='wssc'  AND display_name<>'WSSC';
