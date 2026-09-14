-- Housy's suggestions were silently dead on production, for every company.
--
-- The deployed client calls suggest_accounts_for_pending with
-- p_allow_siblings -- a FIFTH parameter that production's four-parameter
-- version did not have. PostgREST could not resolve the call, returned an
-- error, and Banking.js swallows it:
--
--     if (error || !data?.length) return rows;
--
-- so the screen showed no badge and no suggestion, and nothing anywhere
-- said why. The code and the database disagreed about the contract and the
-- disagreement was invisible from both sides.
--
-- IT DRIFTED BECAUSE THIS FILE DID NOT EXIST. The sibling version was
-- applied to the test project directly and never written down as a
-- migration, so "works on test" and "shipped" quietly came apart. That is
-- the actual lesson here, not the SQL below.
--
-- Measured on production for Sigma Housing before writing this:
--     1,501 pending transactions, all carrying a memo
--         0 match that company's OWN coded history (154 lines)
--       260 match the vocabulary present across all books
-- so the zero was never a cold start to wait out: restricted to its own
-- books the function has almost nothing to learn from and cannot suggest
-- anything however long it runs.
--
-- WHAT CROSSES BETWEEN COMPANIES, AND WHAT DOES NOT
--
-- Only the account NAME mapping -- "this memo means Repairs" -- and only
-- from books the CALLER can already see: the sib CTE is bounded by
-- get_user_company_ids(), so it can never read a company the user has no
-- access to. The suggested account is then resolved back to an account
-- belonging to the TARGET company by name, so a suggestion never points at
-- another company's ledger. No amount, property, tenant or volume crosses.
--
-- Own precedent always wins: ranked orders (scope='company') first, and
-- sib_acct only contributes for transactions with no own-company match.
--
-- The four-argument version is DROPPED rather than left beside this one --
-- both would match a four-argument call and PostgREST would have two
-- candidates.
CREATE OR REPLACE FUNCTION public.suggest_accounts_for_pending(
  p_company_id text,
  p_txn_ids uuid[] DEFAULT NULL::uuid[],
  p_min_support integer DEFAULT 3,
  p_min_agree numeric DEFAULT 0.7,
  p_allow_siblings boolean DEFAULT true
)
RETURNS TABLE(transaction_id uuid, account_id uuid, account_name text,
              support bigint, agreement numeric, class_id text,
              class_name text, class_method text, scope text)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $function$
  WITH pending AS (
    SELECT t.id,
           public.memo_key(coalesce(t.bank_description_clean, t.bank_description_raw, '')) AS k,
           lower(btrim(coalesce(t.payee_normalized, t.payee_raw, ''))) AS ent,
           lower(btrim(coalesce(t.bank_description_clean, t.bank_description_raw, ''))) AS full_memo,
           round(abs(coalesce(t.amount, 0)), 2) AS amt
    FROM public.bank_feed_transaction t
    WHERE t.company_id = p_company_id
      AND t.status = 'for_review'
      -- "none" is a STRING here, not NULL; it is the column default.
      AND (t.suggestion_status IS NULL OR t.suggestion_status IN ('none', 'suggested_ai'))
      AND (p_txn_ids IS NULL OR t.id = ANY(p_txn_ids))
  ),
  own AS (
    SELECT public.memo_key(l.memo) AS k,
           lower(btrim(coalesce(l.entity_name, ''))) AS ent, l.entity_type,
           lower(btrim(coalesce(l.memo, ''))) AS full_memo,
           round(coalesce(l.debit, 0) + coalesce(l.credit, 0), 2) AS amt,
           l.account_id, a.name AS account_name, l.class_id
    FROM public.acct_journal_lines l
    JOIN public.acct_accounts a ON a.id = l.account_id
    WHERE l.company_id = p_company_id AND coalesce(l.memo, '') <> ''
      AND a.type IN ('Revenue', 'Expense', 'Other Income')
  ),
  sib AS (
    SELECT public.memo_key(l.memo) AS k, a.name AS account_name
    FROM public.acct_journal_lines l
    JOIN public.acct_accounts a ON a.id = l.account_id
    WHERE p_allow_siblings
      AND l.company_id IN (SELECT get_user_company_ids())
      AND l.company_id <> p_company_id
      AND coalesce(l.memo, '') <> ''
      AND a.type IN ('Revenue', 'Expense', 'Other Income')
  ),
  own_acct AS (
    SELECT p.id, o.account_id, o.account_name, count(*) AS n, 'company'::text AS scope
    FROM pending p JOIN own o ON o.k = p.k AND p.k <> ''
    GROUP BY p.id, o.account_id, o.account_name
  ),
  sib_acct AS (
    SELECT p.id, mine.id AS account_id, s.account_name, count(*) AS n, 'siblings'::text AS scope
    FROM pending p
    JOIN sib s ON s.k = p.k AND p.k <> ''
    JOIN public.acct_accounts mine
      ON mine.company_id = p_company_id AND lower(mine.name) = lower(s.account_name)
    WHERE NOT EXISTS (SELECT 1 FROM own_acct oa WHERE oa.id = p.id)
    GROUP BY p.id, mine.id, s.account_name
  ),
  merged AS (SELECT * FROM own_acct UNION ALL SELECT * FROM sib_acct),
  ranked AS (
    SELECT id, account_id, account_name, n, scope,
           round(n::numeric / NULLIF(sum(n) OVER (PARTITION BY id), 0), 3) AS agreement,
           row_number() OVER (PARTITION BY id ORDER BY (scope = 'company') DESC, n DESC) AS rk
    FROM merged
  ),
  cls AS (
    SELECT p.id, o.class_id, count(*) AS n, 'tenant'::text AS method, 1 AS tier
    FROM pending p JOIN own o ON o.ent = p.ent AND p.ent <> '' AND o.entity_type = 'customer'
    GROUP BY p.id, o.class_id
    UNION ALL
    SELECT p.id, o.class_id, count(*), 'vendor+memo+amount'::text, 2
    FROM pending p JOIN own o
      ON o.ent = p.ent AND o.full_memo = p.full_memo AND o.amt = p.amt
    WHERE p.ent <> '' AND p.full_memo <> ''
    GROUP BY p.id, o.class_id
  ),
  cls_ranked AS (
    SELECT id, class_id, method,
           row_number() OVER (PARTITION BY id ORDER BY tier, n DESC) AS rk
    FROM cls WHERE class_id IS NOT NULL
  )
  SELECT r.id, r.account_id, r.account_name, r.n, r.agreement,
         cr.class_id::text, c.name, cr.method, r.scope
  FROM ranked r
  LEFT JOIN cls_ranked cr ON cr.id = r.id AND cr.rk = 1
  LEFT JOIN public.acct_classes c ON c.id::text = cr.class_id::text
  WHERE r.rk = 1
    AND r.n >= greatest(coalesce(p_min_support, 3), 1)
    AND r.agreement >= coalesce(p_min_agree, 0.7);
$function$;

DROP FUNCTION IF EXISTS public.suggest_accounts_for_pending(text, uuid[], integer, numeric);
