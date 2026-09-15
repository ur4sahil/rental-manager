-- The tenant ledger's running balance must come from debit/credit, not from
-- a guess about what a transaction_type string means.
--
-- THE BUG
--
-- The view signed each row by je.transaction_type: one list of types added,
-- another subtracted, and an ELSE that ADDED anything it did not recognise.
-- Production has 9 rows typed 'bank' -- Cash App and Square receipts -- and
-- 'bank' is in neither list. So a $2,000 payment was added as a charge,
-- overstating that tenant by $4,000, and the tenant ledger disagreed with
-- the general ledger while both looked authoritative.
--
-- Measured on production before the change: 6 of 177 tenants wrong,
-- $852,000 overstated in total. Five are junk rows ("A", "B B") whose true
-- balances are credits; the sixth is a real tenant overstated by $4,000 --
-- the view said $14,243 where the general ledger and tenants.balance both
-- said $10,243.
--
-- The ELSE is the part that matters. An unrecognised type silently INFLATED
-- what a tenant owed -- the most dangerous direction to be wrong in, on the
-- screen used to chase people for money. It was found only because a
-- separate fix left one tenant disagreeing and that disagreement was
-- chased rather than waved through.
--
-- THE FIX
--
-- Double-entry already carries the sign. On a receivable, debit increases
-- what is owed and credit reduces it, so the balance IS sum(debit - credit)
-- and no type mapping is needed. That is exactly what tenants.balance and
-- the general ledger compute, which is why those two agreed while the view
-- did not. Three sources of truth become one.
--
-- `type` is still returned, because the UI labels rows with it -- but it no
-- longer decides arithmetic. A new transaction_type can now be introduced
-- without silently corrupting every balance beneath it.
--
-- Verified: test 143/143 matched the general ledger before AND after (the
-- change disturbs nothing ordinary); production went from 6 wrong to 0.
CREATE OR REPLACE VIEW public.ledger_entries AS
 SELECT jl.id,
    jl.company_id,
    t.name AS tenant,
    a.tenant_id,
    COALESCE(je.property, ''::text) AS property,
    NULL::bigint AS property_id,
    je.date::text::date AS date,
    COALESCE(je.description, ''::text) AS description,
    COALESCE(jl.debit, 0::numeric) + COALESCE(jl.credit, 0::numeric) AS amount,
    COALESCE(je.transaction_type,
        CASE
            WHEN COALESCE(jl.debit, 0::numeric) > 0::numeric THEN 'charge'::text
            ELSE 'payment'::text
        END) AS type,
    -- Signed by the entry itself, not by a label attached to it.
    sum(COALESCE(jl.debit, 0::numeric) - COALESCE(jl.credit, 0::numeric))
      OVER (PARTITION BY a.tenant_id
            ORDER BY (je.date::text::date), je.created_at, jl.id
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance,
    je.id AS journal_entry_id,
    je.created_at
   FROM acct_journal_lines jl
     JOIN acct_journal_entries je ON je.id = jl.journal_entry_id
     JOIN acct_accounts a ON a.id = jl.account_id
     JOIN tenants t ON t.id = a.tenant_id
  WHERE a.tenant_id IS NOT NULL
    AND je.status = 'posted'::text
    AND (is_company_staff(jl.company_id)
         OR lower(t.email) = lower(auth.email())
         OR COALESCE(auth.jwt() ->> 'role'::text, ''::text) = 'service_role'::text);
