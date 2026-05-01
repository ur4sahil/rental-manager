-- Replace the bank_feed_transaction unique constraint so it uses
-- provider_transaction_id when present (Teller rows) and falls back to
-- fingerprint_hash only when ptid is null (CSV imports).
--
-- The original constraint was UNIQUE(company_id, bank_account_feed_id,
-- fingerprint_hash). That's correct for the CSV side (no provider id
-- exists, so fingerprint is the only stable key). But for Teller rows
-- it's wrong: legitimate banking events can share an identical
-- date/amount/direction/description and Teller assigns each its own
-- distinct provider_transaction_id. The old constraint silently
-- dropped the 2nd and 3rd same-fingerprint rows at the DB layer, even
-- when the application-level dedup correctly let them through.
--
-- Sigma 0822 lost 2 of 3 $398.17 RETURN OF POSTED CHECK / ITEM
-- deposits on 2026-01-15 this way (provider ids …c001/c002/c003,
-- identical fingerprint). The app-layer fix (commit e824434) was
-- necessary but not sufficient — Postgres still rejected the inserts.
-- This migration mirrors that fix at the schema layer.
--
-- New rule (expression unique index):
--   UNIQUE(company_id, bank_account_feed_id,
--          COALESCE(provider_transaction_id, fingerprint_hash))
-- Teller rows uniquify by their provider_transaction_id (the truth);
-- CSV rows still uniquify by fingerprint_hash (no other key exists).
DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'public.bank_feed_transaction'::regclass
    AND contype = 'u'
    AND array_length(conkey, 1) = 3
    AND conkey @> ARRAY[
      (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.bank_feed_transaction'::regclass AND attname = 'company_id'),
      (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.bank_feed_transaction'::regclass AND attname = 'bank_account_feed_id'),
      (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.bank_feed_transaction'::regclass AND attname = 'fingerprint_hash')
    ]
  LIMIT 1;

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.bank_feed_transaction DROP CONSTRAINT %I', cname);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS bank_feed_transaction_dedup_key
  ON public.bank_feed_transaction (
    company_id,
    bank_account_feed_id,
    COALESCE(provider_transaction_id, fingerprint_hash)
  );
