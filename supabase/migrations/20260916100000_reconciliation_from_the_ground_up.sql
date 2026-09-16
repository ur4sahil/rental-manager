-- Bank reconciliation, rebuilt to the model QuickBooks and Xero both use.
--
-- What was here could not reconcile anything, for a reason that is obvious
-- once stated: `bank_reconciliations` had no account_id. Every reconciliation
-- for every bank account landed in one undifferentiated pile, so "the prior
-- period's ending balance" -- the number the whole exercise hangs from -- was
-- unanswerable. Sigma Housing has three bank feeds and zero rows in this
-- table, and that is not a coincidence.
--
-- The model, from QuickBooks:
--
--     beginning balance = the PRIOR completed reconciliation's ending balance
--     cleared balance   = beginning + cleared debits - cleared credits
--     difference        = statement ending balance - cleared balance
--                         and a reconciliation is finished when it is 0.00
--
-- The important part is that beginning_balance is STORED, not recomputed.
-- Recomputing it from the ledger each time means an edit to a transaction
-- someone reconciled in March silently changes March's starting point in
-- April. Storing it is what makes a "beginning balance discrepancy" a thing
-- you can be told about instead of a drift nobody sees.

-- ---- one reconciliation belongs to one bank account -----------------------
alter table public.bank_reconciliations
  add column if not exists account_id uuid references public.acct_accounts(id),
  add column if not exists beginning_balance numeric(14,2) not null default 0,
  add column if not exists cleared_balance numeric(14,2),
  add column if not exists statement_date date,
  add column if not exists cleared_count integer not null default 0;

comment on column public.bank_reconciliations.account_id is
  'The bank GL account reconciled. Was missing entirely, which made a per-account beginning balance impossible.';
comment on column public.bank_reconciliations.beginning_balance is
  'Carried from the prior completed reconciliation for this account. Stored, never recomputed: recomputing lets an edit to an already-reconciled transaction move a closed period''s starting point without telling anyone.';
comment on column public.bank_reconciliations.cleared_balance is
  'beginning_balance + cleared debits - cleared credits. The figure the statement ending balance is compared against.';
comment on column public.bank_reconciliations.statement_date is
  'Last day of the statement period. The books are measured AS AT this date, not as at today.';

-- An account can be reconciled once per period. Without this, re-running a
-- month silently stacks rows and the "prior ending balance" lookup picks an
-- arbitrary one.
create unique index if not exists bank_reconciliations_account_period_uniq
  on public.bank_reconciliations (company_id, account_id, period)
  where account_id is not null;

-- The lookups this model actually performs: "the most recent completed
-- reconciliation for this account before this period".
create index if not exists bank_reconciliations_account_period_idx
  on public.bank_reconciliations (company_id, account_id, period desc);

-- ---- the cleared flag has to be findable ---------------------------------
-- Marking lines reconciled is useless if reading them back costs a table
-- scan of 16,747 rows. Partial, because the answer is always "the reconciled
-- ones" and they are the minority.
create index if not exists acct_journal_lines_reconciled_idx
  on public.acct_journal_lines (account_id, reconciled)
  where reconciled = true;

-- Outstanding items -- the Xero half -- are book lines on a bank account with
-- no feed line behind them. That question is asked on every Banking page load.
create index if not exists acct_journal_lines_unmatched_bank_idx
  on public.acct_journal_lines (account_id)
  where bank_feed_transaction_id is null;

-- ---- a statement balance is a fact about a MOMENT ------------------------
-- bank_account_feed.bank_balance_current is overwritten on every sync, so the
-- balance that was true when a period closed is destroyed by the next poll.
-- Reconciling a past month then means deriving the balance backwards from
-- today, which only works while every intervening transaction is present --
-- and on the 6027 feed they demonstrably are not.
--
-- One row per sync. Small, append-only, and it turns "what did the bank say
-- on 31 January" from an inference into a lookup.
create table if not exists public.bank_balance_snapshot (
  id uuid primary key default gen_random_uuid(),
  company_id text not null,
  bank_account_feed_id uuid not null references public.bank_account_feed(id) on delete cascade,
  captured_at timestamptz not null default now(),
  balance_current numeric(14,2),
  balance_available numeric(14,2),
  source text not null default 'plaid',
  created_at timestamptz not null default now()
);

create index if not exists bank_balance_snapshot_feed_time_idx
  on public.bank_balance_snapshot (bank_account_feed_id, captured_at desc);

comment on table public.bank_balance_snapshot is
  'What the bank said its balance was, and when. Append-only. bank_account_feed.bank_balance_current holds only the latest and is overwritten every sync, which loses the figure a closed period must be reconciled against.';

alter table public.bank_balance_snapshot enable row level security;

-- Same shape as every other company-scoped table here: members read, and
-- only the service role writes, because the only writer is the sync worker.
drop policy if exists bank_balance_snapshot_select on public.bank_balance_snapshot;
create policy bank_balance_snapshot_select on public.bank_balance_snapshot
  for select to authenticated
  using (company_id = any (select public.get_user_company_ids()));

drop policy if exists bank_balance_snapshot_service on public.bank_balance_snapshot;
create policy bank_balance_snapshot_service on public.bank_balance_snapshot
  for all to service_role using (true) with check (true);

grant select on public.bank_balance_snapshot to authenticated;
grant all on public.bank_balance_snapshot to service_role;

-- ---- seed today's balance so there is at least one point of reference -----
-- Not backfilled history, which we do not have and will not invent. Just the
-- current figure recorded as a fact with a timestamp, so tomorrow's sync is
-- the second point and not the first.
insert into public.bank_balance_snapshot (company_id, bank_account_feed_id, captured_at, balance_current, source)
select f.company_id, f.id, coalesce(f.last_synced_at, now()), f.bank_balance_current, 'seed-from-feed'
from public.bank_account_feed f
where f.bank_balance_current is not null
  and not exists (
    select 1 from public.bank_balance_snapshot s where s.bank_account_feed_id = f.id
  );
