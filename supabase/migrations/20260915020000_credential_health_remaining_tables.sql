-- The same two silent credential failures, on the three tables that were
-- left when utilities was fixed. See
-- supabase/migrations/20260914210000_credential_health_key_fingerprint.sql
-- for the diagnosis; this applies it to the rest.
--
-- FAULT 1: '' IS NOT "NO CREDENTIAL"
--
-- The save paths persist `payload.x || existing || ""`, so a record saved
-- without a login stores an empty string. Every IS NOT NULL and COUNT()
-- check then reports a credential that is not there:
--
--   hoa_payments        19 rows claimed a login,  1 had one
--   property_insurance  14 rows claimed a login,  1 had one
--   property_loans      16 rows claimed a login,  1 had one
--
-- 49 claimed, 3 real. That inflated signal is what made a survey of
-- utilities report stored logins for Pepco, Dominion and Fairfax Water when
-- all three held empty strings -- and sent someone trying to decrypt
-- nothing.
--
-- FAULT 2: A ROTATED KEY BROKE ALL OF THEM, SILENTLY
--
-- Commit 7f5bccb (18 April) moved encryption from a browser-shipped key to
-- a server-only one, and left a note: rows already encrypted decrypt
-- correctly "as long as ENCRYPTION_KEY is set to the same value
-- REACT_APP_ENCRYPTION_KEY held. Once rotated, a one-time re-encrypt
-- migration is required (future task)."
--
-- Both keys are currently identical, so the handover was done correctly --
-- which means the value was rotated AFTERWARDS and that future task was
-- never written. Every one of the 3 remaining credentials fails under both
-- keys and under every legacy scheme api/encrypt.js implements: v3 per-row
-- salt, v2 company salt, the keyless v2 fallback and the legacy Teller
-- derivation. AES-GCM failing across all of them is a wrong master key, not
-- corruption.
--
-- Nothing reported it. The decrypt endpoint derives one key and throws, so
-- the app shows a credential that simply never opens.
--
-- credential_key_fp records WHICH key encrypted a row -- a 12-character
-- fingerprint, never the key -- so the next rotation is a diagnosis
-- ("re-enter this") rather than silence.

ALTER TABLE public.hoa_payments ADD COLUMN IF NOT EXISTS credential_key_fp text;
COMMENT ON COLUMN public.hoa_payments.credential_key_fp IS
  'Fingerprint (not the key) of the ENCRYPTION_KEY that encrypted this row''s credentials. '
  'A row whose fingerprint differs from the current key cannot be decrypted and needs re-entering.';

UPDATE public.hoa_payments
   SET username_encrypted     = NULLIF(username_encrypted, ''),
       password_encrypted     = NULLIF(password_encrypted, ''),
       encryption_iv          = NULLIF(encryption_iv, ''),
       encryption_iv_username = NULLIF(encryption_iv_username, ''),
       encryption_salt        = NULLIF(encryption_salt, '')
 WHERE username_encrypted = '' OR password_encrypted = '' OR encryption_iv = ''
    OR encryption_iv_username = '' OR encryption_salt = '';

ALTER TABLE public.hoa_payments DROP CONSTRAINT IF EXISTS chk_hoa_payments_creds_not_blank;
ALTER TABLE public.hoa_payments ADD CONSTRAINT chk_hoa_payments_creds_not_blank CHECK (
  coalesce(username_encrypted, 'x') <> ''
  AND coalesce(password_encrypted, 'x') <> ''
  AND coalesce(encryption_iv, 'x') <> ''
);

ALTER TABLE public.property_insurance ADD COLUMN IF NOT EXISTS credential_key_fp text;
COMMENT ON COLUMN public.property_insurance.credential_key_fp IS
  'Fingerprint (not the key) of the ENCRYPTION_KEY that encrypted this row''s credentials. '
  'A row whose fingerprint differs from the current key cannot be decrypted and needs re-entering.';

UPDATE public.property_insurance
   SET username_encrypted     = NULLIF(username_encrypted, ''),
       password_encrypted     = NULLIF(password_encrypted, ''),
       encryption_iv          = NULLIF(encryption_iv, ''),
       encryption_iv_username = NULLIF(encryption_iv_username, ''),
       encryption_salt        = NULLIF(encryption_salt, '')
 WHERE username_encrypted = '' OR password_encrypted = '' OR encryption_iv = ''
    OR encryption_iv_username = '' OR encryption_salt = '';

ALTER TABLE public.property_insurance DROP CONSTRAINT IF EXISTS chk_property_insurance_creds_not_blank;
ALTER TABLE public.property_insurance ADD CONSTRAINT chk_property_insurance_creds_not_blank CHECK (
  coalesce(username_encrypted, 'x') <> ''
  AND coalesce(password_encrypted, 'x') <> ''
  AND coalesce(encryption_iv, 'x') <> ''
);

ALTER TABLE public.property_loans ADD COLUMN IF NOT EXISTS credential_key_fp text;
COMMENT ON COLUMN public.property_loans.credential_key_fp IS
  'Fingerprint (not the key) of the ENCRYPTION_KEY that encrypted this row''s credentials. '
  'A row whose fingerprint differs from the current key cannot be decrypted and needs re-entering.';

UPDATE public.property_loans
   SET username_encrypted     = NULLIF(username_encrypted, ''),
       password_encrypted     = NULLIF(password_encrypted, ''),
       encryption_iv          = NULLIF(encryption_iv, ''),
       encryption_iv_username = NULLIF(encryption_iv_username, ''),
       encryption_salt        = NULLIF(encryption_salt, '')
 WHERE username_encrypted = '' OR password_encrypted = '' OR encryption_iv = ''
    OR encryption_iv_username = '' OR encryption_salt = '';

ALTER TABLE public.property_loans DROP CONSTRAINT IF EXISTS chk_property_loans_creds_not_blank;
ALTER TABLE public.property_loans ADD CONSTRAINT chk_property_loans_creds_not_blank CHECK (
  coalesce(username_encrypted, 'x') <> ''
  AND coalesce(password_encrypted, 'x') <> ''
  AND coalesce(encryption_iv, 'x') <> ''
);
