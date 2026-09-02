-- Repair bank transactions whose journal_entry_id points at a VOIDED entry
-- while their lines carry exactly one live POSTED entry.
--
-- These arise from the same defect as the previous migration: a
-- categorize -> undo -> re-categorize cycle could leave the transaction
-- pointing at a dead entry even though a real posting exists. Left alone,
-- pressing Undo would void the already-voided entry the pointer names and
-- leave the live posting orphaned on the books.
--
-- Only rows with exactly one live entry are repaired, so the correct
-- target is unambiguous. UPDATE only — no journal entry or line is
-- modified, and nothing is deleted.

UPDATE bank_feed_transaction t
   SET journal_entry_id = live.je_id::uuid
  FROM (
    SELECT l.bank_feed_transaction_id AS txn_id,
           min(je.id) AS je_id
      FROM acct_journal_lines l
      JOIN acct_journal_entries je
        ON je.id = l.journal_entry_id AND je.status = 'posted'
     WHERE l.bank_feed_transaction_id IS NOT NULL
     GROUP BY l.bank_feed_transaction_id
    HAVING count(DISTINCT l.journal_entry_id) = 1
  ) live
  JOIN acct_journal_entries ptr ON TRUE
 WHERE t.id = live.txn_id
   AND t.status IN ('categorized', 'matched', 'posted')
   AND t.journal_entry_id IS NOT NULL
   AND ptr.id = t.journal_entry_id::text
   AND ptr.status = 'voided';
