-- service_role needs DELETE for admin cleanup and for the test suite, which
-- could not remove its own fixtures and therefore left claimable rows behind
-- that the LIVE worker then picked up and ran through the model.
--
-- 'authenticated' is deliberately NOT granted DELETE. Housy keeps both what
-- the model proposed (output) and what a human actually applied (applied),
-- because that difference is the only record of where the model is
-- unreliable. A user deleting jobs would erase exactly that evidence.
GRANT DELETE ON public.ai_jobs TO service_role;
