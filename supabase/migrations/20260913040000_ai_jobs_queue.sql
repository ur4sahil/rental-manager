-- Turn ai_jobs into a real work queue.
--
-- WHY: a 12-page lease takes Gemma 121 seconds to read on the Oracle box
-- (measured 2026-09-13: 7,146 prompt tokens at ~67 tok/s). Cloudflare cuts
-- an origin request off at ~100s, so a lease can never be a single HTTP
-- request no matter which model we use -- prefill happens before the first
-- token, so streaming does not help either. The industry answer to this is
-- submit-and-poll (OpenAI Batch, Anthropic Batches, Vertex LRO), so the job
-- becomes a row that a worker picks up rather than a request someone waits on.
--
-- The status chain gains two states in FRONT of the existing ones:
--
--   queued -> running -> proposed -> approved|rejected -> executing -> done|failed
--   \______________/    \_________________________________________________/
--     new: the model         unchanged: the human review gate that was
--     has not run yet        already here
--
-- 'proposed' keeps its exact meaning -- the model has answered and a human
-- must now look at it. Nothing downstream of review changes.

-- Claiming fields. A worker must be able to take a job without a second
-- worker taking the same one, and a job whose worker died must become
-- claimable again rather than sticking in 'running' forever.
ALTER TABLE public.ai_jobs
  ADD COLUMN IF NOT EXISTS claimed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_by   text,
  ADD COLUMN IF NOT EXISTS attempts     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS started_at   timestamptz,
  ADD COLUMN IF NOT EXISTS priority     integer NOT NULL DEFAULT 0;

-- Widen the status check to admit the two new states.
ALTER TABLE public.ai_jobs DROP CONSTRAINT IF EXISTS ai_jobs_status_known;
ALTER TABLE public.ai_jobs ADD CONSTRAINT ai_jobs_status_known CHECK (
  status IN ('queued','running','proposed','approved','rejected','executing','done','failed'));

-- The queue index: what a worker asks for, every few seconds. Partial, so it
-- stays small however many finished jobs pile up behind it.
CREATE INDEX IF NOT EXISTS idx_ai_jobs_queued
  ON public.ai_jobs (priority DESC, created_at)
  WHERE status = 'queued';

-- Claim exactly one job, atomically.
--
-- FOR UPDATE SKIP LOCKED is the whole point: two workers running this
-- concurrently take two DIFFERENT rows instead of blocking on each other or
-- both taking the same one. Without SKIP LOCKED the second worker waits for
-- the first transaction and then re-reads a row that is no longer queued.
--
-- stale_after reclaims jobs whose worker died mid-run. A worker that is
-- merely slow will find its row already re-claimed and must discard its
-- result; complete_ai_job() enforces that by matching on claimed_by.
CREATE OR REPLACE FUNCTION public.claim_ai_job(
  p_worker      text,
  p_kinds       text[] DEFAULT NULL,
  p_stale_after interval DEFAULT '30 minutes'
)
RETURNS SETOF public.ai_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.ai_jobs j
     SET status     = 'running',
         claimed_at = now(),
         claimed_by = p_worker,
         started_at = COALESCE(j.started_at, now()),
         attempts   = j.attempts + 1
   WHERE j.id = (
     SELECT c.id
       FROM public.ai_jobs c
      WHERE (
              c.status = 'queued'
              OR (c.status = 'running' AND c.claimed_at < now() - p_stale_after)
            )
        AND (p_kinds IS NULL OR c.kind = ANY(p_kinds))
      ORDER BY c.priority DESC, c.created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
  RETURNING j.*;
END;
$$;

-- Record a finished run. Matching on claimed_by is what stops a zombie
-- worker -- one whose job was reclaimed after it stalled -- from overwriting
-- the newer worker's answer with its own stale one.
CREATE OR REPLACE FUNCTION public.complete_ai_job(
  p_id         uuid,
  p_worker     text,
  p_output     jsonb,
  p_model      text,
  p_duration   integer,
  p_confidence numeric DEFAULT NULL,
  p_error      text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE public.ai_jobs
     SET status      = CASE WHEN p_error IS NOT NULL THEN 'failed' ELSE 'proposed' END,
         output      = COALESCE(p_output, output),
         model       = COALESCE(p_model, model),
         duration_ms = COALESCE(p_duration, duration_ms),
         confidence  = COALESCE(p_confidence, confidence),
         error       = p_error,
         claimed_at  = NULL,
         claimed_by  = NULL
   WHERE id = p_id
     AND status = 'running'
     AND claimed_by = p_worker;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- Both functions are called ONLY by the server-side worker route using the
-- service key, never by a browser. No grant to anon or authenticated.
REVOKE ALL ON FUNCTION public.claim_ai_job(text, text[], interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_ai_job(uuid, text, jsonb, text, integer, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_ai_job(text, text[], interval) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_ai_job(uuid, text, jsonb, text, integer, numeric, text) TO service_role;

COMMENT ON FUNCTION public.claim_ai_job IS
  'Atomically claim one queued ai_job (FOR UPDATE SKIP LOCKED). Reclaims jobs stalled beyond p_stale_after.';
COMMENT ON FUNCTION public.complete_ai_job IS
  'Record a worker result. Returns false if the job was reclaimed by another worker, in which case the result must be discarded.';
