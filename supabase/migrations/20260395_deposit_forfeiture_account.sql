-- Add Deposit Forfeiture Income account (4150)
-- Separates deposit forfeitures from regular Other Income for cleaner reporting

-- Insert for all companies that have the standard chart of accounts
INSERT INTO acct_accounts (company_id, code, name, type, subtype, is_active, old_text_id)
SELECT c.id, '4150', 'Deposit Forfeiture Income', 'Revenue', 'Other Income', true, c.id || '-4150'
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM acct_accounts a WHERE a.company_id = c.id AND a.code = '4150'
)
ON CONFLICT DO NOTHING;
