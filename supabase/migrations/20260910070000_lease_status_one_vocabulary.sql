-- lease_status held two spellings for one concept.
--
-- The tenant form defaulted to 'active'; the Tenants page and the bulk
-- importer wrote 'current'. Live data carried 46 rows of one and 28 of
-- the other, and seven queries filtered on a single literal -- so each
-- silently dropped a third of the tenants. Late fees were never applied
-- to a 'current' tenant, rent posting's active list missed them, an
-- inspection could not find its tenant, and the integrity check skipped
-- them entirely.
--
-- The application side is fixed in two ways: every reader now accepts
-- both via ACTIVE_LEASE, and every writer now writes the 'current' /
-- 'past' pair. This settles the stored data to match, so the two never
-- drift apart again.
--
-- 'current' and 'past' win because they are the words the interface
-- shows ("Status: Past"), the words the importer's Status column uses,
-- and the words the Review tab answers with.
--
-- DATABASE-WIDE: this rewrites tenant rows for every company. Approved
-- by Sahil. Non-destructive in the sense that no row is deleted and no
-- other column is touched -- only the two synonyms are folded together.
-- 'review', 'notice' and 'archived' are deliberately left alone.

UPDATE public.tenants SET lease_status = 'current' WHERE lease_status = 'active';
UPDATE public.tenants SET lease_status = 'past'    WHERE lease_status = 'inactive';

COMMENT ON COLUMN public.tenants.lease_status IS
  'current | past | review | notice | archived. "active"/"inactive" were synonyms for current/past and were folded in on 2026-09-10; do not reintroduce them.';
