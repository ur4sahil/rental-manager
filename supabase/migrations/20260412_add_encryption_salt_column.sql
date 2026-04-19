-- Per-credential salt column. Until now every credential in a company shared
-- the same derived key (PBKDF2 salt = "propmanager_<companyId>_v2"), so
-- compromise of one plaintext effectively exposed all. The new API generates
-- a unique 16-byte salt per row; rows without a salt still decrypt via the
-- legacy scheme (backward compat).
ALTER TABLE bank_connection     ADD COLUMN IF NOT EXISTS encryption_salt text;
ALTER TABLE hoa_payments        ADD COLUMN IF NOT EXISTS encryption_salt text;
ALTER TABLE property_insurance  ADD COLUMN IF NOT EXISTS encryption_salt text;
ALTER TABLE property_loans      ADD COLUMN IF NOT EXISTS encryption_salt text;
ALTER TABLE utilities           ADD COLUMN IF NOT EXISTS encryption_salt text;
ALTER TABLE utility_accounts    ADD COLUMN IF NOT EXISTS encryption_salt text;
