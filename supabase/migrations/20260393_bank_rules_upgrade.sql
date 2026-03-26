-- Bank Rules Upgrade: multi-condition engine support
-- Adds tracking columns and atomic increment RPC

ALTER TABLE bank_transaction_rule
  ADD COLUMN IF NOT EXISTS rule_type TEXT DEFAULT 'assign'
    CHECK (rule_type IN ('assign', 'exclude')),
  ADD COLUMN IF NOT EXISTS apply_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_applied_at TIMESTAMPTZ;

-- Atomic increment for rule match stats
CREATE OR REPLACE FUNCTION increment_rule_stats(rule_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE bank_transaction_rule
  SET apply_count = COALESCE(apply_count, 0) + 1,
      last_applied_at = NOW()
  WHERE id = rule_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
