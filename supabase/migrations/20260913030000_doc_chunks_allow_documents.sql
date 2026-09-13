-- Widen doc_chunks' source whitelist.
--
-- The store was built for generated documents and templates. Extraction
-- works on UPLOADED files -- a rental licence PDF, a signed lease -- which
-- live in `documents`, and the check constraint rejected them outright,
-- so the actual extraction target could not be stored at all.
--
-- Still a whitelist rather than free text: source_table routes a chunk
-- back to the thing it came from, and a typo'd table name produces chunks
-- that can never be traced or cleaned up.
ALTER TABLE public.doc_chunks DROP CONSTRAINT IF EXISTS doc_chunks_source_table_check;
ALTER TABLE public.doc_chunks ADD CONSTRAINT doc_chunks_source_table_check
  CHECK (source_table IN ('doc_generated','doc_templates','lease_templates','documents','property_licenses','leases'));
