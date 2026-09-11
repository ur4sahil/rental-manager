-- acct_journal_lines.entity_id must hold the primary key of whichever
-- entity a line references, and those keys are not all the same type:
--
--   tenants.id  integer      (entity_type 'customer')
--   vendors.id  uuid         (entity_type 'vendor')
--   owners.id   uuid
--
-- The column was uuid, so a tenant could never be written to it. The
-- symptom split two ways depending on the code path: addJournalEntry
-- passed the value through unguarded and the insert failed outright with
-- 22P02 "invalid input syntax for type uuid: 312", while paths using the
-- safeUUID() helper silently replaced the tenant id with NULL. Hence not
-- one of the 9,468 rows carrying an entity_id is a tenant -- every one is
-- a vendor, because vendor ids happen to be uuids.
--
-- text is what the column should always have been, and is what class_id
-- and old_account_id already are for exactly this reason. uuid -> text is
-- a lossless widening: every existing value keeps its canonical
-- hyphenated form and no row can fail to convert.
--
-- DATABASE-WIDE: alters a shared accounting table for every company.
ALTER TABLE public.acct_journal_lines
  ALTER COLUMN entity_id TYPE text USING entity_id::text;

COMMENT ON COLUMN public.acct_journal_lines.entity_id IS
  'Primary key of the referenced entity, as text. Deliberately NOT uuid: tenants.id is integer while vendors.id and owners.id are uuid, so no single key type fits. Pair it with entity_type to know which table to look in.';
