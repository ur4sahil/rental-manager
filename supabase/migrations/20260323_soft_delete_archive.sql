-- Add archived_at / archived_by columns to tables that still use hard delete
-- This enables soft-delete (archive) across all modules

ALTER TABLE vendors          ADD COLUMN IF NOT EXISTS archived_at timestamptz, ADD COLUMN IF NOT EXISTS archived_by text;
ALTER TABLE hoa_payments     ADD COLUMN IF NOT EXISTS archived_at timestamptz, ADD COLUMN IF NOT EXISTS archived_by text;
ALTER TABLE autopay_schedules ADD COLUMN IF NOT EXISTS archived_at timestamptz, ADD COLUMN IF NOT EXISTS archived_by text;
ALTER TABLE recurring_journal_entries ADD COLUMN IF NOT EXISTS archived_at timestamptz, ADD COLUMN IF NOT EXISTS archived_by text;
ALTER TABLE doc_generated    ADD COLUMN IF NOT EXISTS archived_at timestamptz, ADD COLUMN IF NOT EXISTS archived_by text;
ALTER TABLE app_users        ADD COLUMN IF NOT EXISTS archived_at timestamptz, ADD COLUMN IF NOT EXISTS archived_by text;
ALTER TABLE late_fee_rules   ADD COLUMN IF NOT EXISTS archived_at timestamptz, ADD COLUMN IF NOT EXISTS archived_by text;
