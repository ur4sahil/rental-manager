-- Which property does this transaction belong to?
--
-- Harder than which account, for a structural reason: the description says
-- WHAT (rent, HOA, a repair) but not WHICH HOUSE. Measured on 4,410 real
-- category lines, leave-one-out:
--
--   memo alone ......................... 32%   useless
--   it is a TENANT -> their property ... 99.2% effectively solved
--   vendor + description + amount ...... 85.4%
--   vendor + description ............... 80.8%
--   vendor + amount .................... 71.5%
--   vendor alone ....................... 53%   MUST NOT SUGGEST
--
-- That last line is the important one. 53% means half of what it proposes
-- is wrong, and a wrong property that LOOKS like an answer is worse than a
-- blank: a reviewer accepts it, every charge after inherits the mistake,
-- and it surfaces at year end. The floor is 80%.
--
-- A tenant lives at one address; a plumber works everywhere. That single
-- fact is why the ladder has this shape.
--
-- Validated on 60 random real lines after building: tenants offered 33/33
-- at 97%, vendors offered only 7/27 at 86%. Declining three vendors in
-- four is the design working, not failing.

CREATE OR REPLACE FUNCTION public.suggest_class_from_history(
  p_company_id  text,
  p_text        text,
  p_entity_name text DEFAULT NULL,
  p_amount      numeric DEFAULT NULL,
  p_min_support int DEFAULT 2
)
RETURNS TABLE (
  class_id    text,
  class_name  text,
  support     bigint,
  agreement   numeric,
  method      text,
  reliability numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  WITH hist AS (
    SELECT l.class_id,
           lower(btrim(coalesce(l.entity_name, ''))) AS ent,
           l.entity_type,
           lower(btrim(coalesce(l.memo, ''))) AS full_memo,
           round(coalesce(l.debit, 0) + coalesce(l.credit, 0), 2) AS amt
    FROM public.acct_journal_lines l
    JOIN public.acct_accounts a ON a.id = l.account_id
    WHERE l.company_id = p_company_id
      AND l.class_id IS NOT NULL
      AND a.type IN ('Revenue', 'Expense', 'Other Income')
  ),
  target AS (
    SELECT lower(btrim(coalesce(p_entity_name, ''))) AS ent,
           lower(btrim(coalesce(p_text, ''))) AS full_memo,
           round(coalesce(p_amount, -1), 2) AS amt
  ),
  by_tenant AS (
    SELECT h.class_id, count(*) AS support, 'tenant'::text AS method, 0.99::numeric AS reliability
    FROM hist h, target t
    WHERE t.ent <> '' AND h.ent = t.ent AND h.entity_type = 'customer'
    GROUP BY h.class_id
  ),
  by_vendor_memo_amt AS (
    SELECT h.class_id, count(*) AS support, 'vendor+memo+amount'::text AS method, 0.85::numeric AS reliability
    FROM hist h, target t
    WHERE NOT EXISTS (SELECT 1 FROM by_tenant)
      AND t.ent <> '' AND t.full_memo <> '' AND t.amt >= 0
      AND h.ent = t.ent AND h.full_memo = t.full_memo AND h.amt = t.amt
    GROUP BY h.class_id
  ),
  by_vendor_memo AS (
    SELECT h.class_id, count(*) AS support, 'vendor+memo'::text AS method, 0.81::numeric AS reliability
    FROM hist h, target t
    WHERE NOT EXISTS (SELECT 1 FROM by_tenant)
      AND NOT EXISTS (SELECT 1 FROM by_vendor_memo_amt)
      AND t.ent <> '' AND t.full_memo <> ''
      AND h.ent = t.ent AND h.full_memo = t.full_memo
    GROUP BY h.class_id
  ),
  merged AS (
    SELECT * FROM by_tenant
    UNION ALL SELECT * FROM by_vendor_memo_amt
    UNION ALL SELECT * FROM by_vendor_memo
  ),
  named AS (
    SELECT m.class_id, c.name AS class_name, m.support, m.method, m.reliability
    FROM merged m
    LEFT JOIN public.acct_classes c ON c.id::text = m.class_id::text
  )
  SELECT n.class_id::text, n.class_name, n.support,
         round(n.support::numeric / NULLIF(sum(n.support) OVER (), 0), 3) AS agreement,
         n.method, n.reliability
  FROM named n
  WHERE n.support >= greatest(coalesce(p_min_support, 2), 1)
  ORDER BY n.reliability DESC, n.support DESC
  LIMIT 5;
$$;

REVOKE ALL ON FUNCTION public.suggest_class_from_history(text, text, text, numeric, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.suggest_class_from_history(text, text, text, numeric, int)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.suggest_class_from_history IS
  'Ranked properties for a transaction by measured reliability: tenant 99%, vendor+memo+amount 85%, vendor+memo 81%. Tiers below 80% are deliberately omitted.';
