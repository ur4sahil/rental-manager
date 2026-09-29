-- JE numbers: every server-side poster claims its number with
-- _je_number_claim (20260929040000) instead of next_je_number.
--
-- next_je_number reads MAX(number)+1 without holding anything, so two
-- postings in parallel get the SAME number; the loser hits
-- unique_je_number_per_company and retries up to 5 times, and under enough
-- concurrency it gives up ("could not allocate a JE number"). _je_number_claim
-- takes a transaction-level advisory lock on the number it returns, so a
-- parallel caller skips to the next free one and never collides. A rolled-back
-- transaction releases its lock and the number is simply reused -- no gap.
--
-- Callers that still used next_je_number (checked on production 2026-09-29):
--   batch_post_late_fees, _stripe_post_reversal_core  -- SECURITY DEFINER
--   post_bank_transaction, _repair_post               -- SECURITY INVOKER,
--       executed by authenticated users. _je_number_claim is deliberately
--       not granted to authenticated, so these go through
--       _je_number_claim_staff, which checks the caller is staff of that
--       company first.
--
-- Each body is patched IN PLACE from its live definition: exactly one
-- `next_je_number(p_company_id)` is replaced, and the migration aborts if
-- that call is not found exactly once. Nothing else in the functions changes,
-- so this is safe on any environment whatever comments/whitespace it carries.
-- The retry loops stay: a client-side insert (the browser still numbers via
-- next_je_number + retry) can still take a number between claim and insert.

CREATE OR REPLACE FUNCTION public._je_number_claim_staff(p_company_id text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
BEGIN
  -- auth.role() is the caller's JWT role even inside SECURITY DEFINER.
  -- service_role and direct/admin sessions (no JWT) are trusted, as in
  -- _bank_require_staff.
  IF coalesce(auth.role(), '') NOT IN ('service_role', '')
     AND NOT EXISTS (SELECT 1 FROM public.get_staff_company_ids() s WHERE s = p_company_id) THEN
    RAISE EXCEPTION 'Only staff of this company can number its journal entries.'
      USING ERRCODE = '42501';
  END IF;
  RETURN public._je_number_claim(p_company_id);
END $$;
REVOKE ALL ON FUNCTION public._je_number_claim_staff(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._je_number_claim_staff(text) TO authenticated, service_role;

DO $patch$
DECLARE
  r record; v_def text; v_new text; v_n int;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.batch_post_late_fees(text)'::regprocedure,           'public._je_number_claim(p_company_id)'),
      ('public._stripe_post_reversal_core(text,text,text,text,text,bigint,text,text,text,text,date)'::regprocedure,
                                                                    'public._je_number_claim(p_company_id)'),
      ('public.post_bank_transaction(text,uuid,text,text,text,jsonb,jsonb,jsonb)'::regprocedure,
                                                                    'public._je_number_claim_staff(p_company_id)'),
      ('public._repair_post(text,date,text,text,text,jsonb)'::regprocedure,
                                                                    'public._je_number_claim_staff(p_company_id)')
    ) s(fn, repl)
  LOOP
    v_def := pg_get_functiondef(r.fn);
    v_n := (length(v_def) - length(replace(v_def, 'next_je_number(p_company_id)', ''))) / length('next_je_number(p_company_id)');
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: expected exactly one next_je_number(p_company_id), found %', r.fn, v_n;
    END IF;
    v_new := replace(v_def, 'next_je_number(p_company_id)', r.repl);
    EXECUTE v_new;
  END LOOP;
END $patch$;

-- No server-side poster may use next_je_number any more.
DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
               AND proname IN ('batch_post_late_fees','_stripe_post_reversal_core','post_bank_transaction','_repair_post')
               AND prosrc LIKE '%next_je_number(%') THEN
    RAISE EXCEPTION 'a poster still calls next_je_number';
  END IF;
END $check$;
