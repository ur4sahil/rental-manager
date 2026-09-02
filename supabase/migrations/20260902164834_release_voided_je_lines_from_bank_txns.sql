-- Release journal lines belonging to VOIDED entries from the bank
-- transactions they were stamped against.
--
-- Background: undoTransaction voided the journal entry it had created but
-- never cleared bank_feed_transaction_id on that entry's lines. Each
-- categorize -> undo -> re-categorize cycle therefore left another pair of
-- lines claiming the same bank transaction, so a single transaction could
-- accumulate lines from half a dozen dead entries. The write paths in
-- Banking.js (undo) and Accounting.js (void from the Journal Entries page)
-- now clear the stamp; this cleans up what the old code already left.
--
-- Scope: UPDATE only, and only on lines whose journal entry is voided.
-- No rows are deleted. The voided entries and their lines remain intact
-- as an audit record — they simply stop claiming to belong to a bank
-- transaction. Posted entries are never touched, so no balance, report,
-- or reconciliation result changes.


UPDATE acct_journal_lines l
   SET bank_feed_transaction_id = NULL
  FROM acct_journal_entries je
 WHERE je.id = l.journal_entry_id
   AND l.bank_feed_transaction_id IS NOT NULL
   AND je.status = 'voided';

-- A transaction can be left marked categorized/matched/posted while every
-- entry behind it is voided, which makes the Bank Transactions tab claim a
-- posting that is not on the books. Return those to For Review so they can
-- be categorized again.
UPDATE bank_feed_transaction t
   SET status               = 'for_review',
       accepted_at          = NULL,
       accepted_by          = NULL,
       journal_entry_id     = NULL,
       posting_decision_id  = NULL,
       matched_target_type  = NULL,
       matched_target_id    = NULL
 WHERE t.status IN ('categorized', 'matched', 'posted')
   -- nothing live is stamped against it any more...
   AND NOT EXISTS (
     SELECT 1 FROM acct_journal_lines l
      WHERE l.bank_feed_transaction_id = t.id
   )
   -- ...and the entry it points at, if any, is voided
   AND t.journal_entry_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM acct_journal_entries je
      WHERE je.id = t.journal_entry_id::text
        AND je.status = 'voided'
   );

