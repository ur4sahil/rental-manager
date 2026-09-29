-- next_je_number: numbers past 9999.
--
-- lpad(s, 4, '0') pads to 4 characters AND TRUNCATES longer input, so the
-- 10,000th entry came out as 'JE-1000' -- an existing number. Every later
-- call returned the same number and every posting through it failed (the
-- callers retry a number collision only a few times). Sigma Housing LLC was
-- at JE-9539 when this was found (2026-09-29).
--
-- Same function, pad only when shorter than 4: JE-0042, JE-9999, JE-10000.
-- MAX(...) already reads the digits as a BIGINT, so JE-10000 sorts above
-- JE-9999 and the sequence continues.
CREATE OR REPLACE FUNCTION public.next_je_number(p_company_id text)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT 'JE-' || lpad(n::text, greatest(4, length(n::text)), '0')
    FROM (SELECT COALESCE(
            (SELECT MAX(CAST(SUBSTRING(number FROM 'JE-(\d+)$') AS BIGINT))
               FROM acct_journal_entries
              WHERE company_id = p_company_id
                AND number ~ '^JE-\d+$'),
            0) + 1 AS n) s;
$function$;
