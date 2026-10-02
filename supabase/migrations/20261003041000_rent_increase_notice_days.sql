-- How many days of written notice a rent INCREASE needs before it may start.
-- A company setting, not a constant, so it can follow the lease and the law
-- where the company operates. 90 is Maryland's figure for a term longer than
-- a month; see the [LAW] list in docs/PLAN-tenant-documents.md.
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS rent_increase_notice_days integer NOT NULL DEFAULT 90;

NOTIFY pgrst, 'reload schema';
