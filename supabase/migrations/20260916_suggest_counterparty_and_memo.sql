-- Bank-transaction suggestions: learn from the counterparty, and read what
-- the memo already says.
--
-- WHY. suggest_accounts_for_pending grouped history by memo_key(), which
-- lowercases and replaces digits with '#' but leaves alphabetic tokens
-- alone. Every Zelle memo carries a unique alphabetic confirmation code:
--
--   bank:    zelle payment to betty de jesus morillo for "#"; conf# ejlspiqh#
--   journal: zelle payment to betty de jesus morillo for "# cross meadow"; conf# conay#pnb
--
-- so no two memos ever share a key and nothing groups. Betty De Jesus
-- Morillo has been coded 53 times -- 35 to Construction Expenses, 13 to
-- Repairs & Maintenance -- and the engine offered nothing for any of her 16
-- pending transactions. Measured on Sigma Housing LLC: 427 of 956 pending
-- transactions had a suggestion, and all 427 were three recurring vendor
-- charges whose memos happen to be identical every month.
--
-- WHAT CHANGES. Two additions, both cheap and both explainable:
--
--   counterparty_key()  extracts the person or business a transfer names,
--                       so 16 Morillo payments group as one precedent.
--
--   memo_property()     pulls a property reference out of the memo. Plaid's
--                       text routinely states it -- 'Zelle payment to David
--                       Ortiz for "10407 beacon ridge"' -- and that is a
--                       fact about the transaction, not a guess from it.
--
-- Precedence is deliberate: an exact whole-memo match still wins, because it
-- is the most specific evidence. Counterparty is the fallback.

-- ── the counterparty a transfer names ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.counterparty_key(p_text text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT nullif(btrim(lower((regexp_match(
    coalesce(p_text, ''),
    -- "Zelle payment to NAME for", "Zelle payment from NAME Conf#",
    -- "SOMETHING DES:NAME ID:", "CHECK PAID TO NAME"
    -- Postgres regex is POSIX, which prefers the longest OVERALL match --
    -- so adding alternatives changes which one wins and where the capture
    -- lands. Adding 'payment to' and 'check paid to' to this pattern took it
    -- from 108 matches to 3. Measured, not assumed; extend it only against
    -- real data.
    '(?i)(?:zelle payment (?:to|from)|des:)\s+([A-Za-z .''&-]{4,44}?)\s*(?:for|conf#|id:|ind[nc]:|$)'
  ))[1])), '');
$$;

COMMENT ON FUNCTION public.counterparty_key(text) IS
  'The person or business a bank memo names. Stable across transactions where memo_key is not, because it excludes the per-payment confirmation code.';

-- ── a property reference stated in the memo ──────────────────────────────
-- Returns the house number plus the first distinctive street word, e.g.
-- '10407 beacon'. Matching happens against properties in the caller.
CREATE OR REPLACE FUNCTION public.memo_property_hint(p_text text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT nullif(btrim(lower((regexp_match(
    coalesce(p_text, ''),
    -- a house number followed by a word: '10407 beacon ridge', '6978 hawthorne'
    '(\d{2,6})\s+([A-Za-z]{4,})'
  ))[1] || ' ' || (regexp_match(
    coalesce(p_text, ''), '(\d{2,6})\s+([A-Za-z]{4,})'
  ))[2])), '');
$$;

COMMENT ON FUNCTION public.memo_property_hint(text) IS
  'House number + first street word stated in a bank memo. A fact the memo asserts, not an inference.';

-- ── the suggestion engine, with both tiers added ─────────────────────────
CREATE OR REPLACE FUNCTION public.suggest_accounts_for_pending(
  p_company_id text,
  p_txn_ids uuid[] DEFAULT NULL::uuid[],
  p_min_support integer DEFAULT 3,
  -- 0.6, lowered from 0.7 on Sahil's instruction 2026-09-16. Betty De Jesus
  -- Morillo's history splits 35 Construction Expenses / 13 Repairs / 3
  -- Labour = 69% agreement, so at 0.7 all 16 of her pending transactions got
  -- nothing at all. The choice is between suggesting only when history is
  -- near-unanimous and suggesting the most common coding for a person to
  -- correct; he chose the latter. Nothing here posts -- every result is a
  -- suggestion that pre-fills a form.
  p_min_agree numeric DEFAULT 0.6,
  p_allow_siblings boolean DEFAULT true)
RETURNS TABLE(transaction_id uuid, account_id uuid, account_name text,
              support bigint, agreement numeric, class_id text, class_name text,
              class_method text, scope text)
LANGUAGE sql STABLE
SET search_path TO 'public', 'pg_catalog'
AS $function$
  WITH pending AS (
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
    SELECT public.memo_key(l.memo) AS k, a.name AS account_name
    FROM public.acct_journal_lines l
    JOIN public.acct_accounts a ON a.id = l.account_id
    WHERE p_allow_siblings
      AND l.company_id IN (SELECT get_user_company_ids())
      AND l.company_id <> p_company_id
      AND coalesce(l.memo, '') <> ''
      AND a.type IN ('Revenue', 'Expense', 'Other Income')
  ),
  -- TIER 1: the whole memo matched. Most specific, so it wins.
  own_acct AS (
    SELECT p.id, o.account_id, o.account_name, count(*) AS n,
           'company'::text AS scope, 1 AS tier
    FROM pending p JOIN own o ON o.k = p.k AND p.k <> ''
    GROUP BY p.id, o.account_id, o.account_name
  ),
  -- TIER 2: the same counterparty, however the rest of the memo read.
  -- This is what recovers Morillo's 16 payments from her 53 codings.
  cp_acct AS (
    SELECT p.id, o.account_id, o.account_name, count(*) AS n,
           'counterparty'::text AS scope, 2 AS tier
    FROM pending p JOIN own o ON o.cp = p.cp AND p.cp IS NOT NULL AND o.cp IS NOT NULL
    WHERE NOT EXISTS (SELECT 1 FROM own_acct oa WHERE oa.id = p.id)
    GROUP BY p.id, o.account_id, o.account_name
  ),
  sib_acct AS (
    SELECT p.id, mine.id AS account_id, s.account_name, count(*) AS n,
           'siblings'::text AS scope, 3 AS tier
    FROM pending p
    JOIN sib s ON s.k = p.k AND p.k <> ''
    JOIN public.acct_accounts mine
      ON mine.company_id = p_company_id AND lower(mine.name) = lower(s.account_name)
    WHERE NOT EXISTS (SELECT 1 FROM own_acct oa WHERE oa.id = p.id)
      AND NOT EXISTS (SELECT 1 FROM cp_acct ca WHERE ca.id = p.id)
    GROUP BY p.id, mine.id, s.account_name
  ),
  merged AS (
    SELECT * FROM own_acct UNION ALL SELECT * FROM cp_acct UNION ALL SELECT * FROM sib_acct
  ),
  ranked AS (
    SELECT id, account_id, account_name, n, scope, tier,
           round(n::numeric / NULLIF(sum(n) OVER (PARTITION BY id, tier), 0), 3) AS agreement,
           row_number() OVER (PARTITION BY id ORDER BY tier, n DESC) AS rk
    FROM merged
  ),
  -- CLASS. Tier 3 is new: a property the memo names outright.
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
    UNION ALL
    -- the memo states the property: 'Zelle payment to David Ortiz for "10407 beacon ridge"'
    SELECT p.id, pr.class_id::text, 1::bigint, 'memo names the property'::text, 3
    FROM pending p
    JOIN public.properties pr
      ON pr.company_id = p_company_id AND pr.archived_at IS NULL
     AND pr.class_id IS NOT NULL
     AND p.phint IS NOT NULL
     AND lower(pr.address) LIKE split_part(p.phint, ' ', 1) || '%'
     AND lower(pr.address) LIKE '%' || split_part(p.phint, ' ', 2) || '%'
    UNION ALL
    -- same counterparty, and it was classed somewhere before
    SELECT p.id, o.class_id, count(*), 'counterparty'::text, 4
    FROM pending p JOIN own o ON o.cp = p.cp AND p.cp IS NOT NULL AND o.cp IS NOT NULL
    WHERE o.class_id IS NOT NULL
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
