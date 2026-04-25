-- Fix: e-sign RPCs reintroduced in 20260424000011 / 20260424000012 dropped
-- the `extensions` schema from search_path, so digest() (pgcrypto, lives in
-- the extensions schema on Supabase) couldn't be resolved. The original fix
-- shipped in 20260407_fix_sign_document_search_path.sql; the new versions
-- need the same widening.
--
-- Repro: signing a document hit "function digest(text, unknown) does not exist"
-- because search_path was just `public`.
--
-- We re-create the affected functions with `SET search_path = public, extensions`
-- so digest() resolves. Bodies are unchanged.

ALTER FUNCTION create_doc_envelope(uuid, jsonb) SET search_path = public, extensions;
ALTER FUNCTION sign_document(text, text, text, text, text, text, boolean, boolean, text) SET search_path = public, extensions;

-- set_signed_pdf and resolve_signed_pdf_path don't use digest(), but tighten
-- their search_path too for consistency with the other e-sign RPCs.
ALTER FUNCTION set_signed_pdf(uuid, text, text) SET search_path = public, extensions;
ALTER FUNCTION resolve_signed_pdf_path(text) SET search_path = public, extensions;
