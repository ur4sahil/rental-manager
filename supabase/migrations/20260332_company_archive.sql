-- Add archive columns to companies table for soft-delete
ALTER TABLE companies ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS archived_by text;
