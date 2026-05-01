-- Persist the user's preferred from_date on bank_connection so the
-- daily Teller sync cron respects it. Without this, the cron POSTs
-- with no body.from_date and Teller returns its full window (18+
-- months for BofA), bypassing whatever date floor the user set on
-- the initial pull.
--
-- Sahil hit this on Sigma 6027: enrolled with from_date=2026-01-01,
-- expected ~336 transactions; cron pulled 1,356 covering Oct 2024
-- onward.
--
-- Cron logic (teller-sync-transactions.js): if body.from_date is
-- absent, fall back to bank_connection.sync_from_date. NULL = no
-- floor (current behavior preserved for legacy connections).
ALTER TABLE bank_connection
  ADD COLUMN IF NOT EXISTS sync_from_date date;

COMMENT ON COLUMN bank_connection.sync_from_date IS
  'Optional date floor for daily Teller sync. Cron skips txns posted before this date. NULL = pull Teller default window.';
