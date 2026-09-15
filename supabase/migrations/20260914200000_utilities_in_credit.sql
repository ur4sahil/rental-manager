-- Which utility accounts are in CREDIT -- the utility owes money back, and a
-- refund cheque can be requested.
--
-- WHY A REPORT AND NOT A FLAG
--
-- utilities.amount is signed: a bill is positive, a credit is negative. That
-- one convention does the safety work. pay-runner already refuses any amount
-- <= 0, so a credit is structurally unpayable rather than relying on a
-- boolean somebody has to remember to check -- and "in credit" is simply
-- amount < 0, with no second field that could disagree with the number
-- beside it.
--
-- THE CASE THIS EXISTS FOR
--
-- SMECO's overview reads "No payment due  -$4.15": the utility owes money.
-- A reader that takes the first dollar figure on the page records a $4.15
-- BILL -- a credit inverted into a debt, on a screen nobody would think to
-- doubt, and one that would then be paid. worker/portals/fetch-bill.js now
-- checks "nothing due" FIRST and stores the credit as a negative amount.
-- This surfaces those rows so they can be acted on rather than sitting
-- unnoticed on one account among forty.
CREATE OR REPLACE FUNCTION public.utilities_in_credit(p_company_id text)
RETURNS TABLE(
  utility_id integer,
  provider text,
  property text,
  account_number text,
  credit_amount numeric,
  last_read_at timestamptz,
  last_read_outcome text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT u.id,
         u.provider,
         u.property,
         u.account_number,
         -- Returned POSITIVE: "this utility owes you $4.15" is what a person
         -- reads when deciding whether to chase a refund; "-4.15" is not.
         (-u.amount) AS credit_amount,
         u.last_read_at,
         u.last_read_outcome
  FROM public.utilities u
  WHERE u.company_id = p_company_id
    AND u.archived_at IS NULL
    AND u.amount IS NOT NULL
    AND u.amount < 0
    AND (current_user IN ('service_role','postgres','supabase_admin')
         OR p_company_id IN (SELECT get_staff_company_ids()))
  ORDER BY (-u.amount) DESC;
$function$;

REVOKE ALL ON FUNCTION public.utilities_in_credit(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.utilities_in_credit(text) TO authenticated, service_role;

COMMENT ON FUNCTION public.utilities_in_credit(text) IS
  'Utility accounts whose balance is a credit (utilities.amount < 0), i.e. the '
  'utility owes money back and a refund cheque can be requested. Amount is '
  'returned positive for reading.';
