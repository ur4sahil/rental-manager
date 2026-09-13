-- The spine for every AI action: a proposal that a human reviews.
--
-- Not a chat box. Three reasons this shape, all of them measured rather
-- than assumed:
--
--  1. Local inference is SLOW. Prefill on the Oracle box runs 20-30 tok/s
--     and degrades with length -- a whole lease is ~9.5 minutes before
--     the first token. Anything user-facing has to be asynchronous, so a
--     job is a row, not a request.
--  2. Anything touching money or a government filing needs a gate. The
--     model proposes; a person approves; only then does it execute.
--  3. When it gets something wrong you need to see exactly what it saw.
--     The prompt, the retrieved context, the raw output and the diff are
--     all kept, so a bad extraction is debuggable after the fact.
--
-- `output` is what the model proposed. `applied` is what was actually
-- written, which is NOT the same thing once a human edits a field before
-- approving -- keeping both is how we learn where it is unreliable.
CREATE TABLE IF NOT EXISTS public.ai_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    text NOT NULL,

  -- what kind of work: extract_license, abstract_lease, categorise_txn,
  -- draft_notice, prepare_filing, submit_filing...
  kind          text NOT NULL,

  -- proposed -> approved|rejected -> executing -> done|failed
  status        text NOT NULL DEFAULT 'proposed',

  -- what the job is ABOUT, so it can be shown next to that thing
  subject_table text,
  subject_id    text,

  input         jsonb NOT NULL DEFAULT '{}'::jsonb,
  output        jsonb,
  applied       jsonb,

  model         text,
  duration_ms   integer,
  -- The model's own stated confidence, 0..1. Advisory only: it is not
  -- calibrated and must never gate an action on its own.
  confidence    numeric,
  error         text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text,
  reviewed_at   timestamptz,
  reviewed_by   text,
  executed_at   timestamptz,

  CONSTRAINT ai_jobs_status_known CHECK (
    status IN ('proposed','approved','rejected','executing','done','failed')),
  CONSTRAINT ai_jobs_confidence_range CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

-- The queue view: what is waiting for a human, oldest first.
CREATE INDEX IF NOT EXISTS idx_ai_jobs_company_status
  ON public.ai_jobs (company_id, status, created_at DESC);
-- "What has the AI said about THIS property/document?"
CREATE INDEX IF NOT EXISTS idx_ai_jobs_subject
  ON public.ai_jobs (company_id, subject_table, subject_id);

ALTER TABLE public.ai_jobs ENABLE ROW LEVEL SECURITY;

-- Staff of the company only. get_user_company_ids() is SECURITY DEFINER
-- and exists precisely to avoid the mutual recursion that comes from a
-- policy subquerying another RLS-protected table.
DROP POLICY IF EXISTS ai_jobs_select ON public.ai_jobs;
CREATE POLICY ai_jobs_select ON public.ai_jobs
  FOR SELECT USING (company_id IN (SELECT get_user_company_ids()));

DROP POLICY IF EXISTS ai_jobs_insert ON public.ai_jobs;
CREATE POLICY ai_jobs_insert ON public.ai_jobs
  FOR INSERT WITH CHECK (company_id IN (SELECT get_user_company_ids()));

DROP POLICY IF EXISTS ai_jobs_update ON public.ai_jobs;
CREATE POLICY ai_jobs_update ON public.ai_jobs
  FOR UPDATE USING (company_id IN (SELECT get_user_company_ids()))
  WITH CHECK (company_id IN (SELECT get_user_company_ids()));

-- No DELETE policy on purpose: a rejected proposal is evidence of what
-- the model does, and the audit value is in keeping it.

COMMENT ON TABLE public.ai_jobs IS
  'AI proposals awaiting human review. output = what the model proposed; applied = what was actually written after any human edit.';

-- Grants, without which ai_jobs is invisible to the app.
--
-- RLS decides WHICH rows a role may see; a GRANT decides whether the role
-- may touch the table at all. With policies but no grant, PostgREST
-- returns an empty list rather than an error, and this repo's
-- try/catch + `data || []` idiom turns that into "the queue is empty".
-- That is exactly what happened while building: a seeded proposal sat
-- plainly in the table and rendered as an empty page.
GRANT SELECT, INSERT, UPDATE ON public.ai_jobs TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ai_jobs TO service_role;
