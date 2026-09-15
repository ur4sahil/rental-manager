-- Make two silent credential failures visible.
--
-- FAULT 1: EMPTY STRING IS NOT "NO CREDENTIAL"
--
-- The save paths persist `payload.username_encrypted || existing || ""`, so
-- a utility saved without credentials stores '' rather than NULL. Every
-- IS NOT NULL and COUNT() check then reports a credential that is not
-- there -- which is how a survey of this table concluded Pepco, Dominion
-- and Fairfax Water had stored logins when all three held empty strings,
-- and why time was spent trying to decrypt nothing.
--
-- Normalised to NULL, with a CHECK so '' cannot come back. NULL is the only
-- honest representation of "no credential".
--
-- FAULT 2: A ROTATED KEY BREAKS EVERY STORED CREDENTIAL, SILENTLY
--
-- ENCRYPTION_KEY was rotated at some point and nothing migrated the
-- existing ciphertext. Proven, not guessed: encrypt-then-decrypt with the
-- CURRENT key round-trips perfectly, while all 7 rows holding real
-- ciphertext fail authentication under it AND under every legacy scheme
-- api/encrypt.js implements. AES-GCM failing everywhere is what a wrong
-- master key looks like.
--
-- The app could not tell that apart from corruption, because the decrypt
-- endpoint derives one key and throws. credential_key_fp records WHICH key
-- encrypted a row -- a fingerprint, never the key -- so a mismatch is a
-- diagnosis instead of a mystery.
ALTER TABLE public.utilities
  ADD COLUMN IF NOT EXISTS credential_key_fp text;

COMMENT ON COLUMN public.utilities.credential_key_fp IS
  'Fingerprint (not the key) of the ENCRYPTION_KEY that encrypted this row''s '
  'credentials. A row whose fingerprint differs from the current key cannot be '
  'decrypted and needs re-entering. NULL for rows saved before this existed.';

UPDATE public.utilities
   SET username_encrypted     = NULLIF(username_encrypted, ''),
       password_encrypted     = NULLIF(password_encrypted, ''),
       encryption_iv          = NULLIF(encryption_iv, ''),
       encryption_iv_username = NULLIF(encryption_iv_username, ''),
       encryption_salt        = NULLIF(encryption_salt, '')
 WHERE username_encrypted = '' OR password_encrypted = ''
    OR encryption_iv = '' OR encryption_iv_username = '' OR encryption_salt = '';

ALTER TABLE public.utilities
  DROP CONSTRAINT IF EXISTS chk_utilities_creds_not_blank;
ALTER TABLE public.utilities
  ADD CONSTRAINT chk_utilities_creds_not_blank CHECK (
    coalesce(username_encrypted, 'x') <> ''
    AND coalesce(password_encrypted, 'x') <> ''
    AND coalesce(encryption_iv, 'x') <> ''
  );

-- What is stored, and whether it can still be read. Deliberately does NOT
-- decrypt: that needs the master key, which belongs on the server and not
-- in a database function. Comparing fingerprints answers the same question
-- without either.
CREATE OR REPLACE FUNCTION public.utilities_credential_health(
  p_company_id text,
  p_current_key_fp text DEFAULT NULL
)
RETURNS TABLE(
  utility_id integer, provider text, property text,
  has_credentials boolean, key_fingerprint text, status text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT u.id, u.provider, u.property,
         (u.username_encrypted IS NOT NULL AND u.password_encrypted IS NOT NULL),
         u.credential_key_fp,
         CASE
           WHEN u.username_encrypted IS NULL OR u.password_encrypted IS NULL
             THEN 'none stored'
           WHEN u.credential_key_fp IS NULL
             THEN 'unknown key — predates fingerprinting, may not decrypt'
           WHEN p_current_key_fp IS NOT NULL AND u.credential_key_fp <> p_current_key_fp
             THEN 'ENCRYPTED UNDER AN OLD KEY — must be re-entered'
           ELSE 'ok'
         END
  FROM public.utilities u
  WHERE u.company_id = p_company_id
    AND u.archived_at IS NULL
    AND (current_user IN ('service_role','postgres','supabase_admin')
         OR p_company_id IN (SELECT get_staff_company_ids()))
  ORDER BY (u.username_encrypted IS NOT NULL) DESC, u.provider;
$function$;

REVOKE ALL ON FUNCTION public.utilities_credential_health(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.utilities_credential_health(text, text) TO authenticated, service_role;
