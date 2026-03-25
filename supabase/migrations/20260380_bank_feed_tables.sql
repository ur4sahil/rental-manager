-- ============================================================
-- Phase 1: QuickBooks-style Bank Feed Tables
-- ============================================================

-- 1. Bank Account Feed — one per bank/CC account used for imports
CREATE TABLE IF NOT EXISTS bank_account_feed (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  gl_account_id uuid REFERENCES acct_accounts(id),
  account_name text NOT NULL,
  masked_number text DEFAULT '',
  account_type text NOT NULL DEFAULT 'checking' CHECK (account_type IN ('checking', 'savings', 'credit_card', 'loan', 'other')),
  currency_code text DEFAULT 'USD',
  bank_balance_current numeric(18,2),
  ledger_balance_cached numeric(18,2),
  last_synced_at timestamptz,
  import_enabled boolean DEFAULT true,
  review_count_cached integer DEFAULT 0,
  status text DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'errored')),
  institution_name text DEFAULT '',
  connection_type text DEFAULT 'csv' CHECK (connection_type IN ('csv', 'plaid', 'manual')),
  plaid_account_id text,
  bank_connection_id uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_baf_company ON bank_account_feed(company_id);

-- 2. Bank Import Batch — one per CSV upload
CREATE TABLE IF NOT EXISTS bank_import_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  bank_account_feed_id uuid REFERENCES bank_account_feed(id),
  source_type text DEFAULT 'csv' CHECK (source_type IN ('csv', 'plaid', 'manual')),
  original_filename text,
  file_hash text,
  imported_by text,
  imported_at timestamptz DEFAULT now(),
  row_count integer DEFAULT 0,
  accepted_count integer DEFAULT 0,
  skipped_count integer DEFAULT 0,
  duplicate_count integer DEFAULT 0,
  status text DEFAULT 'imported' CHECK (status IN ('uploaded', 'mapped', 'parsed', 'validated', 'imported', 'failed')),
  mapping_json jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bib_company ON bank_import_batch(company_id);

-- 3. Bank Feed Transaction — canonical imported transaction
CREATE TABLE IF NOT EXISTS bank_feed_transaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  bank_account_feed_id uuid REFERENCES bank_account_feed(id),
  bank_import_batch_id uuid REFERENCES bank_import_batch(id),
  source_type text DEFAULT 'csv',
  provider_transaction_id text,
  posted_date date NOT NULL,
  amount numeric(18,2) NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inflow', 'outflow')),
  bank_description_raw text,
  bank_description_clean text,
  memo text,
  check_number text,
  payee_raw text,
  payee_normalized text,
  reference_number text,
  balance_after numeric(18,2),
  fingerprint_hash text NOT NULL,
  duplicate_group_key text,
  status text DEFAULT 'for_review' CHECK (status IN ('for_review', 'categorized', 'matched', 'excluded', 'posted', 'locked', 'reversed')),
  suggestion_status text DEFAULT 'none',
  exclusion_reason text,
  excluded_at timestamptz,
  excluded_by text,
  accepted_at timestamptz,
  accepted_by text,
  matched_target_type text,
  matched_target_id uuid,
  posting_decision_id uuid,
  journal_entry_id uuid,
  raw_payload_json jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(company_id, bank_account_feed_id, fingerprint_hash)
);
CREATE INDEX IF NOT EXISTS idx_bft_company ON bank_feed_transaction(company_id);
CREATE INDEX IF NOT EXISTS idx_bft_status ON bank_feed_transaction(company_id, status);
CREATE INDEX IF NOT EXISTS idx_bft_feed ON bank_feed_transaction(bank_account_feed_id);
CREATE INDEX IF NOT EXISTS idx_bft_batch ON bank_feed_transaction(bank_import_batch_id);
CREATE INDEX IF NOT EXISTS idx_bft_fingerprint ON bank_feed_transaction(fingerprint_hash);

-- 4. Bank Transaction Rule
CREATE TABLE IF NOT EXISTS bank_transaction_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  name text NOT NULL,
  priority integer DEFAULT 100,
  enabled boolean DEFAULT true,
  bank_account_feed_id uuid,
  condition_json jsonb NOT NULL DEFAULT '{}',
  action_json jsonb NOT NULL DEFAULT '{}',
  auto_accept boolean DEFAULT false,
  stop_processing boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_btr_company ON bank_transaction_rule(company_id);

-- 5. Bank Posting Decision — user's accept/match/exclude decision
CREATE TABLE IF NOT EXISTS bank_posting_decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  bank_feed_transaction_id uuid REFERENCES bank_feed_transaction(id),
  decision_type text NOT NULL CHECK (decision_type IN ('add', 'match', 'transfer', 'split', 'exclude')),
  payee text,
  memo text,
  header_class_id uuid,
  transfer_gl_account_id uuid,
  status text DEFAULT 'draft' CHECK (status IN ('draft', 'validated', 'posted', 'failed', 'undone')),
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bpd_company ON bank_posting_decision(company_id);

-- 6. Bank Posting Decision Line — for split transactions
CREATE TABLE IF NOT EXISTS bank_posting_decision_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  bank_posting_decision_id uuid REFERENCES bank_posting_decision(id) ON DELETE CASCADE,
  line_no integer DEFAULT 1,
  gl_account_id uuid,
  gl_account_name text,
  amount numeric(18,2) NOT NULL,
  entry_side text DEFAULT 'debit' CHECK (entry_side IN ('debit', 'credit', 'derived')),
  memo text,
  class_id uuid,
  created_at timestamptz DEFAULT now()
);

-- 7. Bank Feed Transaction Link — traceability
CREATE TABLE IF NOT EXISTS bank_feed_transaction_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  bank_feed_transaction_id uuid REFERENCES bank_feed_transaction(id),
  linked_object_type text NOT NULL,
  linked_object_id uuid NOT NULL,
  link_role text DEFAULT 'created_from' CHECK (link_role IN ('created_from', 'matched_to', 'settled_by', 'reversed_by')),
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bftl_txn ON bank_feed_transaction_link(bank_feed_transaction_id);

-- 8. Bank Import Mapping Profile — saved column mappings per institution
CREATE TABLE IF NOT EXISTS bank_import_mapping_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  name text NOT NULL,
  institution_name text,
  bank_account_feed_id uuid,
  delimiter text DEFAULT ',',
  header_row_index integer DEFAULT 0,
  date_column text,
  date_format text DEFAULT 'MM/DD/YYYY',
  amount_mode text DEFAULT 'single_signed' CHECK (amount_mode IN ('single_signed', 'debit_credit')),
  amount_column text,
  debit_column text,
  credit_column text,
  description_columns_json jsonb DEFAULT '[]',
  payee_column text,
  memo_column text,
  check_number_column text,
  reference_column text,
  balance_column text,
  invert_sign boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bimp_company ON bank_import_mapping_profile(company_id);

-- 9. Period Lock (for accounting controls)
CREATE TABLE IF NOT EXISTS accounting_period_lock (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  lock_date date NOT NULL,
  locked_by text,
  locked_at timestamptz DEFAULT now(),
  notes text,
  UNIQUE(company_id)
);

-- Enable RLS on all new tables
ALTER TABLE bank_account_feed ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_import_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_feed_transaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transaction_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_posting_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_posting_decision_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_feed_transaction_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_import_mapping_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_period_lock ENABLE ROW LEVEL SECURITY;

-- RLS policies (service key bypasses, but for completeness)
DO $$ BEGIN
  -- bank_account_feed
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'bank_account_feed' AND policyname = 'baf_company_access') THEN
    CREATE POLICY baf_company_access ON bank_account_feed FOR ALL USING (company_id = current_setting('app.company_id', true));
  END IF;
  -- bank_feed_transaction
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'bank_feed_transaction' AND policyname = 'bft_company_access') THEN
    CREATE POLICY bft_company_access ON bank_feed_transaction FOR ALL USING (company_id = current_setting('app.company_id', true));
  END IF;
END $$;
