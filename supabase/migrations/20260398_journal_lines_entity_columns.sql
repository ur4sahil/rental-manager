-- Add Customer/Vendor entity tracking to journal lines
ALTER TABLE acct_journal_lines
  ADD COLUMN IF NOT EXISTS entity_type TEXT,
  ADD COLUMN IF NOT EXISTS entity_id UUID,
  ADD COLUMN IF NOT EXISTS entity_name TEXT;

-- Constraint: entity_type must be customer or vendor (or NULL)
ALTER TABLE acct_journal_lines
  ADD CONSTRAINT chk_entity_type CHECK (entity_type IS NULL OR entity_type IN ('customer', 'vendor'));
