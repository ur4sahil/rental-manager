-- The Bank Transactions page timed out on every fresh load.
--
-- PM-8004 "canceling statement due to statement timeout", eight times in
-- thirteen minutes on 2026-09-16, every one from
-- suggest_accounts_for_pending. The role ceiling is 8s for `authenticated`.
--
-- TWO CAUSES, AND I FOUND THE SECOND ONLY BY MEASURING PROPERLY.
--
-- The first was an unindexable operator in the sibling tier:
--
--     WHERE l.company_id IN (SELECT get_user_company_ids())
--       AND l.company_id <> p_company_id     -- `<>` cannot use a btree
--
-- so despite idx_acct_journal_lines_company_memo_key existing, the planner
-- chose Seq Scan on acct_journal_lines (37,931 rows) and computed memo_key()
-- on every one. Fixed by resolving the sibling ids into an array and using
-- `= ANY(...)`, and by driving the lookup from the pending memo keys so only
-- keys something is actually asking about are read.
--
-- That took it from 1502ms to 417ms AS `postgres` -- and I nearly stopped
-- there. But `postgres` bypasses RLS. Called the way the app actually calls
-- it, as `authenticated` through PostgREST, it was still 8.5s cold and 7.3s
-- warm. The index work was real and insufficient; measuring as a superuser
-- and declaring victory would have shipped a page that still timed out.
--
-- The dominant cost is acct_journal_lines' tenant policy:
--
--     acct_jl_tenant: EXISTS (SELECT 1 FROM acct_accounts a WHERE ...)
--                     AND EXISTS (...)
--
-- Permissive policies are OR'd, so Postgres evaluates the tenant branch for
-- every candidate row even when the staff branch would already admit it --
-- two correlated subqueries across 17,447 lines, on every call.
--
-- SECURITY DEFINER is the established answer in this schema:
-- get_staff_company_ids() and get_user_company_ids() are both defined that
-- way for the same reason, and CLAUDE.md records the rule -- "route
-- cross-table checks through a SECURITY DEFINER helper, which bypasses RLS
-- and breaks the cycle".
--
-- It is only safe because the access check moves INSIDE, before any data is
-- read: the caller must be active non-tenant staff of the company being
-- asked about. get_staff_company_ids() is itself SECURITY DEFINER, so that
-- costs one index lookup rather than a per-row policy evaluation.
--
-- #variable_conflict use_column is required, not cosmetic. In PL/pgSQL every
-- RETURNS TABLE output name (account_id, class_id, scope...) shadows the
-- same-named column, and without the pragma the function fails 42702 on
-- every call. Found by running it, not by reading it.
--
-- VERIFIED ON PRODUCTION as `authenticated`, before and after promotion:
--
--     before : 7975ms cold (or timeout), 7663ms warm, 468 rows
--     after  :  584ms cold,  417ms warm, 468 rows      (13x)
--     live   :  961 / 855 / 400ms, HTTP 200, 468 rows
--
--     identical output: only-in-old 0, only-in-new 0
--     security: a company with no membership returns 0 rows, not an error
--               and not data

CREATE OR REPLACE FUNCTION public.suggest_accounts_for_pending(p_company_id text, p_txn_ids uuid[] DEFAULT NULL::uuid[], p_min_support integer DEFAULT 3, p_min_agree numeric DEFAULT 0.6, p_allow_siblings boolean DEFAULT true)
 RETURNS TABLE(transaction_id uuid, account_id uuid, account_name text, support bigint, agreement numeric, class_id text, class_name text, class_method text, scope text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  IF p_company_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM (SELECT get_staff_company_ids() AS c) s
                    WHERE s.c = p_company_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH sibling_companies AS (
    SELECT array_agg(c) AS ids
    FROM (SELECT get_user_company_ids() AS c) s
    WHERE p_allow_siblings AND c <> p_company_id
  ),
  pending AS (
    SELECT t.id,
           public.memo_key(coalesce(t.bank_description_clean, t.bank_description_raw, '')) AS k,
           public.counterparty_key(coalesce(t.bank_description_clean, t.bank_description_raw, '')) AS cp,
           public.memo_property_hint(coalesce(t.bank_description_clean, t.bank_description_raw, '')) AS phint,
           lower(btrim(coalesce(t.payee_normalized, t.payee_raw, ''))) AS ent,
           lower(btrim(coalesce(t.bank_description_clean, t.bank_description_raw, ''))) AS full_memo,
           round(abs(coalesce(t.amount, 0)), 2) AS amt
    FROM public.bank_feed_transaction t
    WHERE t.company_id = p_company_id
      AND t.status = 'for_review'
      AND (t.suggestion_status IS NULL OR t.suggestion_status IN ('none', 'suggested_ai'))
      AND (p_txn_ids IS NULL OR t.id = ANY(p_txn_ids))
  ),
  pending_keys AS (SELECT DISTINCT k FROM pending WHERE k <> ''),
  own AS (
    SELECT public.memo_key(l.memo) AS k,
           public.counterparty_key(l.memo) AS cp,
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
    SELECT pk.k, a.name AS account_name
    FROM pending_keys pk
    CROSS JOIN sibling_companies sc
    JOIN public.acct_journal_lines l
      ON l.company_id = ANY(sc.ids)
     AND public.memo_key(l.memo) = pk.k
    JOIN public.acct_accounts a ON a.id = l.account_id
    WHERE sc.ids IS NOT NULL
      AND coalesce(l.memo, '') <> ''
      AND a.type IN ('Revenue', 'Expense', 'Other Income')
  ),
  own_acct AS (
    SELECT p.id, o.account_id, o.account_name, count(*) AS n, 'company'::text AS scope, 1 AS tier
    FROM pending p JOIN own o ON o.k = p.k AND p.k <> ''
    GROUP BY p.id, o.account_id, o.account_name
  ),
  cp_acct AS (
    SELECT p.id, o.account_id, o.account_name, count(*) AS n, 'counterparty'::text AS scope, 2 AS tier
    FROM pending p JOIN own o ON o.cp = p.cp AND p.cp IS NOT NULL AND o.cp IS NOT NULL
    WHERE NOT EXISTS (SELECT 1 FROM own_acct oa WHERE oa.id = p.id)
    GROUP BY p.id, o.account_id, o.account_name
  ),
  sib_acct AS (
    SELECT p.id, mine.id AS account_id, s.account_name, count(*) AS n, 'siblings'::text AS scope, 3 AS tier
    FROM pending p
    JOIN sib s ON s.k = p.k AND p.k <> ''
    JOIN public.acct_accounts mine
      ON mine.company_id = p_company_id AND lower(mine.name) = lower(s.account_name)
    WHERE NOT EXISTS (SELECT 1 FROM own_acct oa WHERE oa.id = p.id)
      AND NOT EXISTS (SELECT 1 FROM cp_acct ca WHERE ca.id = p.id)
    GROUP BY p.id, mine.id, s.account_name
  ),
  merged AS (SELECT * FROM own_acct UNION ALL SELECT * FROM cp_acct UNION ALL SELECT * FROM sib_acct),
  ranked AS (
    SELECT id, account_id, account_name, n, scope, tier,
           round(n::numeric / NULLIF(sum(n) OVER (PARTITION BY id, tier), 0), 3) AS agreement,
           row_number() OVER (PARTITION BY id ORDER BY tier, n DESC) AS rk
    FROM merged
  ),
  cls AS (
    SELECT p.id, o.class_id, count(*) AS n, 'tenant'::text AS method, 1 AS tier
    FROM pending p JOIN own o ON o.ent = p.ent AND p.ent <> '' AND o.entity_type = 'customer'
    GROUP BY p.id, o.class_id
    UNION ALL
    SELECT p.id, o.class_id, count(*), 'vendor+memo+amount'::text, 2
    FROM pending p JOIN own o ON o.ent = p.ent AND o.full_memo = p.full_memo AND o.amt = p.amt
    WHERE p.ent <> '' AND p.full_memo <> ''
    GROUP BY p.id, o.class_id
    UNION ALL
    SELECT p.id, pr.class_id::text, 1::bigint, 'memo names the property'::text, 3
    FROM pending p
    JOIN public.properties pr
      ON pr.company_id = p_company_id AND pr.archived_at IS NULL
     AND pr.class_id IS NOT NULL AND p.phint IS NOT NULL
     AND lower(pr.address) LIKE split_part(p.phint, ' ', 1) || '%'
     AND lower(pr.address) LIKE '%' || split_part(p.phint, ' ', 2) || '%'
    UNION ALL
    SELECT p.id, o.class_id, count(*), 'counterparty'::text, 4
    FROM pending p JOIN own o ON o.cp = p.cp AND p.cp IS NOT NULL AND o.cp IS NOT NULL
    WHERE o.class_id IS NOT NULL
    GROUP BY p.id, o.class_id
  ),
  cls_ranked AS (
    SELECT id, class_id, method, row_number() OVER (PARTITION BY id ORDER BY tier, n DESC) AS rk
    FROM cls WHERE class_id IS NOT NULL
  )
  SELECT r.id, r.account_id, r.account_name, r.n, r.agreement,
         cr.class_id::text, c.name, cr.method, r.scope
  FROM ranked r
  LEFT JOIN cls_ranked cr ON cr.id = r.id AND cr.rk = 1
  LEFT JOIN public.acct_classes c ON c.id::text = cr.class_id::text
  WHERE r.rk = 1
    AND r.n >= greatest(coalesce(p_min_support, 3), 1)
    AND r.agreement >= coalesce(p_min_agree, 0.6);
END;
$function$;

grant execute on function public.suggest_accounts_for_pending(text, uuid[], integer, numeric, boolean) to authenticated;
