-- The unique index idx_utilities_company_provider_account was partial on
-- "account_number IS NOT NULL" but did NOT exclude archived rows. The property
-- wizard edits by archive-then-reinsert, so a utility carrying a real account
-- number was archived and re-inserted with the same number, colliding with its
-- own just-archived copy -- the whole atomic commit then rolled back with
-- "duplicate key ... idx_utilities_company_provider_account" and nothing saved
-- (11442 Deepwood, 11455 Abbotswood Ct, ...). A unique constraint on a
-- soft-deleted table must exclude the soft-deleted rows. Verified on test:
-- archive+reinsert of the same number is allowed; two ACTIVE rows with the same
-- number still collide. No active duplicates exist, so the rebuild is clean.
DROP INDEX IF EXISTS public.idx_utilities_company_provider_account;
CREATE UNIQUE INDEX idx_utilities_company_provider_account
  ON public.utilities (company_id, provider, account_number)
  WHERE account_number IS NOT NULL AND archived_at IS NULL;
