-- Indexes for the server-side aggregates. Additive only -- nothing dropped,
-- no rows touched, no behaviour changed.
--
-- The aggregate's first plan was a nested loop: an index scan of
-- acct_journal_entries walking the PRIMARY KEY (261 ms, 15,760 rows visited
-- to find 7,722 posted ones, because nothing indexed company_id + status)
-- and then one index lookup into acct_journal_lines per entry -- 7,722 of
-- them, 47,970 buffers to return 870 rows. 890 ms -> 87 ms with these.
--
-- (company_id, status, date) is the shape every accounting read wants:
-- always scoped to one company, almost always to posted entries, then
-- bounded or ordered by date (trial balance as-of, P&L between, ledger
-- ordering). date is in the index so the range predicate is answered there
-- rather than by re-checking the heap.
CREATE INDEX IF NOT EXISTS idx_acct_je_company_status_date
  ON public.acct_journal_entries (company_id, status, date);

-- The lines side of the same join, so the aggregate groups without fetching
-- every heap row and a per-account ledger goes straight to its own lines.
CREATE INDEX IF NOT EXISTS idx_acct_jl_company_account
  ON public.acct_journal_lines (company_id, account_id);

-- Row estimates were badly wrong (2,530 estimated against 16,548 actual),
-- which is part of why the planner chose a nested loop over a hash join.
ANALYZE public.acct_journal_entries;
ANALYZE public.acct_journal_lines;
ANALYZE public.acct_accounts;
