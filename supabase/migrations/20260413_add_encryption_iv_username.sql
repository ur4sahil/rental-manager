-- Dual-IV: each ciphertext field must have its own nonce for AES-GCM to be
-- secure. The original schema held only one encryption_iv — the last-written
-- field won the slot (password, because callers always save it second). That
-- meant the username was effectively unreadable after save: it had been
-- encrypted with a random IV that was then discarded. Add a dedicated column
-- for the username IV so new writes preserve both.
--
-- existing encryption_iv keeps its role as the PASSWORD IV (matches every
-- existing row's actual stored contents). encryption_iv_username is new and
-- nullable, populated from this point forward.
ALTER TABLE hoa_payments        ADD COLUMN IF NOT EXISTS encryption_iv_username text;
ALTER TABLE property_insurance  ADD COLUMN IF NOT EXISTS encryption_iv_username text;
ALTER TABLE property_loans      ADD COLUMN IF NOT EXISTS encryption_iv_username text;
ALTER TABLE utilities           ADD COLUMN IF NOT EXISTS encryption_iv_username text;
ALTER TABLE utility_accounts    ADD COLUMN IF NOT EXISTS encryption_iv_username text;
