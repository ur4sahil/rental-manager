ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS archived_at timestamptz DEFAULT NULL;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS archived_by text DEFAULT NULL;
