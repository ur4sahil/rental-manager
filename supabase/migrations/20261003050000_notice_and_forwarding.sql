-- Notices and move-out (Phase 3 of docs/PLAN-tenant-documents.md).
--
-- "Generate Move-Out Notice" set a tenant to "notice" and a move-out date,
-- and that was all: nothing recorded WHEN notice was given or WHO gave it
-- (the tenant, or the landlord), and no notice existed. A forwarding address
-- was a tick-box on the move-out checklist with nowhere to write the address
-- the deposit letter has to be sent to.
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS notice_given_on date,
  ADD COLUMN IF NOT EXISTS notice_given_by text,
  ADD COLUMN IF NOT EXISTS forwarding_address text,
  ADD COLUMN IF NOT EXISTS forwarding_email text;

DO $chk$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_notice_given_by_check') THEN
    ALTER TABLE public.tenants ADD CONSTRAINT tenants_notice_given_by_check
      CHECK (notice_given_by IS NULL OR notice_given_by IN ('tenant', 'landlord'));
  END IF;
END $chk$;

NOTIFY pgrst, 'reload schema';
