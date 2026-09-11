-- Retrieval store for document question-answering.
--
-- Why this exists: prompt prefill on the LLM box runs at 20-30 tok/s and
-- degrades with length, so feeding a whole lease costs ~9.5 minutes
-- before a single word is generated. Retrieving the handful of relevant
-- passages instead turns that into seconds. The fix is architectural,
-- not hardware -- no GPU changes the arithmetic of sending 16,000 tokens
-- when 500 would do.
--
-- Full-text search, not embeddings, on purpose: ranking with Postgres
-- needs no model, no network path to Ollama, and no ingest-time
-- inference. The `embedding` column is created nullable so semantic
-- search can be added later without a second migration; nothing reads it
-- yet.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.doc_chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   text NOT NULL,
  -- Which record this passage came from. No FK: the three sources live in
  -- different tables, so this is a soft reference and orphans are pruned
  -- by source_id on re-ingest.
  source_table text NOT NULL CHECK (source_table IN ('doc_generated','doc_templates','lease_templates')),
  source_id    text NOT NULL,
  source_name  text,
  chunk_index  int  NOT NULL,
  content      text NOT NULL,
  -- Generated, so it cannot drift from content the way a trigger-free
  -- denormalised column would.
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  embedding    vector(768),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, source_table, source_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_doc_chunks_tsv     ON public.doc_chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_company ON public.doc_chunks (company_id, source_table, source_id);

ALTER TABLE public.doc_chunks ENABLE ROW LEVEL SECURITY;

-- Staff of the owning company only. Deliberately NOT readable by tenant
-- or owner portal roles: a chunk is a fragment of a lease or notice and
-- carries no per-tenant scoping of its own, so exposing it would leak
-- one tenant's terms to another. get_user_company_ids() is SECURITY
-- DEFINER, which is what keeps this from recursing through companies'
-- own policy.
DROP POLICY IF EXISTS doc_chunks_staff_read ON public.doc_chunks;
CREATE POLICY doc_chunks_staff_read ON public.doc_chunks
  FOR SELECT USING (company_id IN (SELECT get_user_company_ids()));

DROP POLICY IF EXISTS doc_chunks_staff_write ON public.doc_chunks;
CREATE POLICY doc_chunks_staff_write ON public.doc_chunks
  FOR ALL USING (company_id IN (SELECT get_user_company_ids()))
       WITH CHECK (company_id IN (SELECT get_user_company_ids()));

-- Grants, without which this table is unreadable from the app. CREATE
-- TABLE grants nothing to the PostgREST roles, so RLS could allow a read
-- and the API would still return nothing -- the same class of failure as
-- dumping a schema with --no-privileges. RLS narrows what a role may
-- see; the grant is what lets it see anything at all. anon is omitted
-- deliberately: passages are staff-only.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.doc_chunks TO authenticated;
GRANT ALL ON public.doc_chunks TO service_role;

COMMENT ON TABLE public.doc_chunks IS
  'Passages of generated documents and templates, for retrieval-augmented question answering. Ranked with Postgres full-text search; the embedding column is reserved for semantic search and is not yet read.';

-- Ranked passage search.
--
-- SECURITY INVOKER on purpose: it must see the CALLER so doc_chunks' RLS
-- applies and a company can only search its own passages. p_company_id
-- is caller-supplied, so RLS is the only thing preventing a cross-company
-- read -- a SECURITY DEFINER version would bypass it while looking
-- correct.
--
-- Ranks on ANY matching term, not ALL of them. websearch_to_tsquery ANDs
-- every term, so "are pets allowed" compiled to 'pet & allow' and matched
-- nothing while the clause plainly read "Tenant shall not keep pets on
-- the premises". A question almost always contains words the document
-- does not use, so requiring all of them fails closed and silently
-- returns no passage. OR the lexemes and let ts_rank order them: a
-- passage matching more terms still ranks higher, and only the top few
-- are taken, so the limit does the pruning.
CREATE OR REPLACE FUNCTION public.search_doc_chunks(
  p_company_id text,
  p_query      text,
  p_limit      int DEFAULT 6,
  p_source_id  text DEFAULT NULL
)
RETURNS TABLE (id uuid, source_table text, source_id text, source_name text,
               chunk_index int, content text, rank real)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  WITH q AS (
    -- Lexemes of the question, stemmed and stop-worded by the same
    -- dictionary that built tsv, then OR'd. The guards matter: a question
    -- of only stop words ("what is it?") would otherwise build an empty
    -- tsquery and match EVERY row.
    SELECT to_tsquery('english',
             array_to_string(
               tsvector_to_array(to_tsvector('english', coalesce(p_query, ''))), ' | ')
           ) AS query
    WHERE nullif(btrim(coalesce(p_query, '')), '') IS NOT NULL
      AND array_length(tsvector_to_array(to_tsvector('english', coalesce(p_query, ''))), 1) > 0
  )
  SELECT c.id, c.source_table, c.source_id, c.source_name, c.chunk_index, c.content,
         ts_rank(c.tsv, q.query) AS rank
  FROM public.doc_chunks c, q
  WHERE c.company_id = p_company_id
    AND (p_source_id IS NULL OR c.source_id = p_source_id)
    AND c.tsv @@ q.query
  ORDER BY rank DESC, c.chunk_index
  -- Clamped: this feeds a prompt, and the point is to send a few passages
  -- rather than the document.
  LIMIT LEAST(GREATEST(coalesce(p_limit, 6), 1), 25);
$$;

REVOKE ALL ON FUNCTION public.search_doc_chunks(text, text, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_doc_chunks(text, text, int, text) TO authenticated, service_role;
