-- Drop the legacy 6-arg sign_document overload. The 9-arg version
-- from 20260424000011_esign_legal_defensibility.sql added three new
-- params (p_e_records_consented, p_hw_sw_acknowledged, p_consent_version)
-- with defaults instead of replacing the old signature. Postgres
-- treats default-arg differences as a different overload, so both
-- versions co-exist — and any 6-arg call fails with "could not choose
-- the best candidate function between..." (PG-42725).
--
-- Found via doc-signatures.test.js failing on 17 assertions on
-- 2026-05-01. The 9-arg version is the canonical one (e-records
-- consent + UETA acknowledgment + version pinning), so drop the old.
DROP FUNCTION IF EXISTS public.sign_document(
  text, text, text, text, text, text
);
