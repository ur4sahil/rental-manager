-- Repair orphaned class pointers, then make the orphaning impossible.
--
-- CAUSE. Three call sites upserted acct_classes with a freshly minted
-- `id` in the payload and `onConflict: (company_id, name)`. PostgREST
-- compiles that to
--     INSERT ... ON CONFLICT (company_id, name) DO UPDATE SET id = EXCLUDED.id, ...
-- so hitting an existing class REWROTE its primary key. acct_classes.id
-- is plain TEXT and, unlike account_id and journal_entry_id, class_id
-- carried no foreign key -- so every acct_journal_lines.class_id and
-- properties.class_id referencing that class was silently orphaned.
-- created_at is untouched by an UPDATE, which is why the damage leaves
-- no trace in the timestamps.
--
-- The worst offender was Accounting.js's property/class sync: bulk, and
-- automatic on page load. One company lost attribution on 13,881 lines.
--
-- REPAIR. Class names are property addresses and are unique per company
-- (acct_classes_company_name_unique), so a dead id resolves without
-- ambiguity by name, via either of two paths. Nothing is deleted.

-- 1. Journal lines. Resolve each distinct dead (company, class_id) pair
--    once -- there are ~47 of them behind ~14k rows -- then repoint in
--    bulk. Path A: the property that still carries the dead id gives the
--    address. Path B: the journal entry's own property name.
WITH dead AS (
  SELECT DISTINCT l.company_id, l.class_id
    FROM acct_journal_lines l
    LEFT JOIN acct_classes c ON c.id = l.class_id
   WHERE l.class_id IS NOT NULL AND c.id IS NULL
),
map AS (
  SELECT d.company_id, d.class_id,
         COALESCE(
           (SELECT c.id FROM properties p
              JOIN acct_classes c ON c.name = p.address AND c.company_id = d.company_id
             WHERE p.class_id = d.class_id AND p.company_id = d.company_id
             LIMIT 1),
           (SELECT c.id FROM acct_journal_lines l2
              JOIN acct_journal_entries je ON je.id = l2.journal_entry_id
              JOIN acct_classes c ON c.name = je.property AND c.company_id = d.company_id
             WHERE l2.class_id = d.class_id AND l2.company_id = d.company_id
             LIMIT 1)
         ) AS live_id
    FROM dead d
)
UPDATE acct_journal_lines l
   SET class_id = m.live_id
  FROM map m
 WHERE l.company_id = m.company_id
   AND l.class_id  = m.class_id
   AND m.live_id IS NOT NULL;

-- 2. Properties, by their own address.
UPDATE properties p
   SET class_id = c.id
  FROM acct_classes c
 WHERE c.company_id = p.company_id
   AND c.name = p.address
   AND p.class_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM acct_classes c2 WHERE c2.id = p.class_id);

-- 3. Anything still pointing at nothing becomes NULL. A dangling id is
--    strictly worse than an honest NULL: it reads as "attributed" while
--    resolving to nothing, and it would block the foreign keys below.
UPDATE acct_journal_lines l SET class_id = NULL
 WHERE l.class_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM acct_classes c WHERE c.id = l.class_id);

UPDATE properties p SET class_id = NULL
 WHERE p.class_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM acct_classes c WHERE c.id = p.class_id);

-- 4. Let the database mint class ids, so an insert no longer has to send
--    one -- which is what let a conflicting upsert overwrite the key.
ALTER TABLE acct_classes ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;

-- 5. The guardrail this table always should have had. ON UPDATE CASCADE
--    makes a rewritten class id harmless: references follow it instead
--    of being orphaned. ON DELETE SET NULL preserves today's behaviour
--    (a deleted class means no attribution) without leaving dead ids.
ALTER TABLE acct_journal_lines
  ADD CONSTRAINT acct_journal_lines_class_id_fkey
  FOREIGN KEY (class_id) REFERENCES acct_classes(id)
  ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE properties
  ADD CONSTRAINT properties_class_id_fkey
  FOREIGN KEY (class_id) REFERENCES acct_classes(id)
  ON UPDATE CASCADE ON DELETE SET NULL;
