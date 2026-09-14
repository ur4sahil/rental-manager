-- Hybrid retrieval over doc_chunks: keyword AND meaning, near-duplicates
-- collapsed.
--
-- Lexical search alone failed two ways on a real 12-page lease, measured:
--
--  1. VOCABULARY. "When does the lease end?" found nothing useful, because
--     the lease says "shall terminate". to_tsquery cannot know those are
--     the same thing, and a reader asking a question almost never uses the
--     document's own words.
--  2. DUPLICATES. The top four passages were one boilerplate clause from
--     four places in the document, ranked identically, filling the whole
--     budget and pushing the answer out.
--
-- doc_chunks has carried embedding vector(768) since it was created and
-- nothing ever wrote to it. nomic-embed-text produces exactly 768
-- dimensions at ~90ms a passage.

-- HNSW rather than ivfflat: no training pass, so it works on an empty
-- table and stays correct as chunks trickle in. These sets are small, so
-- build cost is irrelevant and recall is better.
CREATE INDEX IF NOT EXISTS idx_doc_chunks_embedding
  ON public.doc_chunks USING hnsw (embedding vector_cosine_ops);

CREATE OR REPLACE FUNCTION public.search_doc_chunks_hybrid(
  p_company_id text,
  p_query      text,
  p_embedding  vector(768) DEFAULT NULL,
  p_limit      int DEFAULT 6,
  p_source_id  text DEFAULT NULL
)
RETURNS TABLE (id uuid, source_table text, source_id text, source_name text,
               chunk_index int, content text, rank real, lexical real, semantic real)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  WITH q AS (
    -- Lexemes OR'd, not AND'd. websearch_to_tsquery ANDs every term, so
    -- "are pets allowed" compiled to 'pet & allow' and matched nothing
    -- while the clause plainly discussed pets.
    SELECT to_tsquery('english',
             array_to_string(
               tsvector_to_array(to_tsvector('english', coalesce(p_query, ''))), ' | ')) AS query
    WHERE nullif(btrim(coalesce(p_query, '')), '') IS NOT NULL
      AND array_length(tsvector_to_array(to_tsvector('english', coalesce(p_query, ''))), 1) > 0
  ),
  scored AS (
    SELECT c.id, c.source_table, c.source_id, c.source_name, c.chunk_index, c.content,
           COALESCE(ts_rank(c.tsv, (SELECT query FROM q)), 0)::real AS lexical,
           CASE
             WHEN p_embedding IS NULL OR c.embedding IS NULL THEN 0
             -- <=> is cosine DISTANCE, so 1 - it is similarity.
             ELSE (1 - (c.embedding <=> p_embedding))::real
           END AS semantic
    FROM public.doc_chunks c
    WHERE c.company_id = p_company_id
      AND (p_source_id IS NULL OR c.source_id = p_source_id)
      AND (
        -- Either signal may admit a passage. Requiring both would
        -- reintroduce exactly the vocabulary failure this fixes.
        (EXISTS (SELECT 1 FROM q) AND c.tsv @@ (SELECT query FROM q))
        OR (p_embedding IS NOT NULL AND c.embedding IS NOT NULL)
      )
  ),
  deduped AS (
    -- Strip a LEADING clause number before hashing. Hashing raw content
    -- counted "27. SURRENDER AND HOLDOVER" and "51. SURRENDER AND
    -- HOLDOVER" as two different passages.
    --
    -- Only a LEADING number. Collapsing every digit would merge clauses
    -- that differ precisely by their numbers, which in a lease is usually
    -- the whole point: $2,450 rent and $3,675 deposit are not one passage.
    SELECT DISTINCT ON (md5(btrim(regexp_replace(content, '^\s*\d{1,3}\.\s*', ''))))
           id, source_table, source_id, source_name, chunk_index, content, lexical, semantic
    FROM scored
    ORDER BY md5(btrim(regexp_replace(content, '^\s*\d{1,3}\.\s*', ''))),
             (lexical * 0.4 + semantic * 0.6) DESC, chunk_index
  )
  SELECT id, source_table, source_id, source_name, chunk_index, content,
         -- Weighted toward meaning, because that is the half keyword
         -- search cannot do at all; keywords still matter for names and
         -- numbers, which embeddings blur.
         (lexical * 0.4 + semantic * 0.6)::real AS rank,
         lexical, semantic
  FROM deduped
  ORDER BY rank DESC, chunk_index
  LIMIT LEAST(GREATEST(coalesce(p_limit, 6), 1), 25);
$$;

REVOKE ALL ON FUNCTION public.search_doc_chunks_hybrid(text, text, vector, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_doc_chunks_hybrid(text, text, vector, int, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.search_doc_chunks_hybrid IS
  'Retrieval over doc_chunks blending full-text rank with cosine similarity (0.4/0.6), near-duplicate passages collapsed past any leading clause number. Falls back to lexical-only when no embedding is supplied.';
