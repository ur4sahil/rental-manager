-- Suggestions that are simply THERE when the page loads.
--
-- The per-transaction lookup needs one round trip each, which is fine for
-- a deliberate "code these 20" action and useless for pre-filling a list:
-- fifty rows would be fifty calls before anything rendered. This answers
-- the whole page in one query, so nobody has to select rows and press a
-- button to get something that costs nothing.
--
-- No model in this path at all. It is a join against what this company has
-- already coded -- 93.4% accurate on the 83% of lines with a precedent,
-- measured leave-one-out, and explainable by the count it returns.
--
-- memo_key ALSO gains whitespace collapsing here, and that is not cosmetic.
-- Bank feeds pad descriptions to fixed columns:
--
--   "WASHINGTON GAS   DES:PAYMENT    ID:XXXXX#   INDN:SIGMA HOUSING LLC"
--
-- Collapsing digits but not spaces meant the same payee with different
-- padding produced different keys and matched nothing. A seeded Washington
-- Gas transaction found NO suggestion while 28 identical payments sat in
-- its history, and Highland Condominium matched 16 precedents instead of
-- 105. Nothing errored -- the lookup just quietly found less than it
-- should, which reads as weak coverage rather than a bug.
--
-- The indexes are expression indexes over memo_key, so they hold values
-- computed by the old definition and must be rebuilt, not left in place.

DROP INDEX IF EXISTS idx_acct_journal_lines_memo_trgm;
DROP INDEX IF EXISTS idx_acct_journal_lines_company_memo_key;

CREATE OR REPLACE FUNCTION public.memo_key(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT btrim(regexp_replace(
           regexp_replace(lower(coalesce(p_text, '')), '[0-9]+', '#', 'g'),
           '\s+', ' ', 'g'));
$$;

CREATE INDEX IF NOT EXISTS idx_acct_journal_lines_memo_trgm
  ON public.acct_journal_lines USING gin (public.memo_key(memo) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_acct_journal_lines_company_memo_key
  ON public.acct_journal_lines (company_id, public.memo_key(memo));

COMMENT ON FUNCTION public.memo_key IS
  'Normalises a bank description for matching: lowercased, digit runs collapsed to #, whitespace runs collapsed to one space. The whitespace step matters because bank feeds pad descriptions to fixed columns.';

CREATE OR REPLACE FUNCTION public.suggest_accounts_for_pending(
  p_company_id  text,
  p_txn_ids     uuid[] DEFAULT NULL,
  p_min_support int DEFAULT 3,
  p_min_agree   numeric DEFAULT 0.7
)
RETURNS TABLE (
  transaction_id uuid,
  account_id     uuid,
  account_name   text,
  support        bigint,
  agreement      numeric,
  class_id       text,
  class_name     text,
  class_method   text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  WITH pending AS (
    SELECT t.id,
           public.memo_key(coalesce(t.bank_description_clean, t.bank_description_raw, '')) AS k,
           lower(btrim(coalesce(t.payee_normalized, t.payee_raw, ''))) AS ent,
           lower(btrim(coalesce(t.bank_description_clean, t.bank_description_raw, ''))) AS full_memo,
           round(abs(coalesce(t.amount, 0)), 2) AS amt
    FROM public.bank_feed_transaction t
    WHERE t.company_id = p_company_id
      AND t.status = 'for_review'
      -- "none" is a STRING here, not NULL; it is the column default. A
      -- plain NULL check would skip every untouched transaction.
      AND (t.suggestion_status IS NULL OR t.suggestion_status IN ('none', 'suggested_ai'))
      AND (p_txn_ids IS NULL OR t.id = ANY(p_txn_ids))
  ),
  -- Only the category side: every entry has two, and counting the asset
  -- side makes one memo look like it maps to several accounts.
  hist AS (
    SELECT public.memo_key(l.memo) AS k,
           lower(btrim(coalesce(l.entity_name, ''))) AS ent,
           l.entity_type,
           lower(btrim(coalesce(l.memo, ''))) AS full_memo,
           round(coalesce(l.debit, 0) + coalesce(l.credit, 0), 2) AS amt,
           l.account_id, a.name AS account_name, l.class_id
    FROM public.acct_journal_lines l
    JOIN public.acct_accounts a ON a.id = l.account_id
    WHERE l.company_id = p_company_id
      AND coalesce(l.memo, '') <> ''
      AND a.type IN ('Revenue', 'Expense', 'Other Income')
  ),
  acct AS (
    SELECT p.id, h.account_id, h.account_name, count(*) AS n
    FROM pending p JOIN hist h ON h.k = p.k AND p.k <> ''
    GROUP BY p.id, h.account_id, h.account_name
  ),
  acct_ranked AS (
    SELECT id, account_id, account_name, n,
           round(n::numeric / NULLIF(sum(n) OVER (PARTITION BY id), 0), 3) AS agreement,
           row_number() OVER (PARTITION BY id ORDER BY n DESC) AS rk
    FROM acct
  ),
  -- The property ladder, by measured reliability: tenant 99%, then vendor
  -- pinned by description AND amount at 85%. Nothing looser -- vendor alone
  -- is 53%, and a wrong property that looks like an answer is worse than
  -- an empty field.
  cls AS (
    SELECT p.id, h.class_id, count(*) AS n, 'tenant'::text AS method, 1 AS tier
    FROM pending p JOIN hist h ON h.ent = p.ent AND p.ent <> '' AND h.entity_type = 'customer'
    GROUP BY p.id, h.class_id
    UNION ALL
    SELECT p.id, h.class_id, count(*) AS n, 'vendor+memo+amount'::text, 2
    FROM pending p JOIN hist h
      ON h.ent = p.ent AND h.full_memo = p.full_memo AND h.amt = p.amt
    WHERE p.ent <> '' AND p.full_memo <> ''
    GROUP BY p.id, h.class_id
  ),
  cls_ranked AS (
    SELECT id, class_id, method, n,
           row_number() OVER (PARTITION BY id ORDER BY tier, n DESC) AS rk
    FROM cls WHERE class_id IS NOT NULL
  )
  SELECT ar.id, ar.account_id, ar.account_name, ar.n, ar.agreement,
         cr.class_id::text, c.name, cr.method
  FROM acct_ranked ar
  LEFT JOIN cls_ranked cr ON cr.id = ar.id AND cr.rk = 1
  LEFT JOIN public.acct_classes c ON c.id::text = cr.class_id::text
  WHERE ar.rk = 1
    AND ar.n >= greatest(coalesce(p_min_support, 3), 1)
    AND ar.agreement >= coalesce(p_min_agree, 0.7);
$$;

REVOKE ALL ON FUNCTION public.suggest_accounts_for_pending(text, uuid[], int, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.suggest_accounts_for_pending(text, uuid[], int, numeric)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.suggest_accounts_for_pending IS
  'One query returning account and property suggestions for every pending transaction, from this company''s own coding history. No model involved. Used to pre-fill the Bank Transactions list on load rather than requiring a click.';
