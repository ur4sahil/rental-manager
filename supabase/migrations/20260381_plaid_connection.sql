-- Bank Connection (Plaid items)
CREATE TABLE IF NOT EXISTS bank_connection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  source_type text DEFAULT 'plaid' CHECK (source_type IN ('plaid', 'manual')),
  institution_name text,
  institution_id text,
  plaid_item_id text,
  access_token_encrypted text,
  encryption_iv text,
  connection_status text DEFAULT 'active' CHECK (connection_status IN ('active', 'needs_reauth', 'errored', 'disconnected')),
  last_successful_sync_at timestamptz,
  last_error_code text,
  last_error_message text,
  plaid_sync_cursor text,
  consent_expiration_time timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bc_company ON bank_connection(company_id);
ALTER TABLE bank_connection ENABLE ROW LEVEL SECURITY;

-- Plaid Sync Event log
CREATE TABLE IF NOT EXISTS plaid_sync_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  bank_connection_id uuid REFERENCES bank_connection(id),
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  sync_cursor_before text,
  sync_cursor_after text,
  added_count integer DEFAULT 0,
  modified_count integer DEFAULT 0,
  removed_count integer DEFAULT 0,
  status text DEFAULT 'syncing' CHECK (status IN ('syncing', 'success', 'partial_success', 'failed', 'requires_reauth')),
  error_json jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pse_company ON plaid_sync_event(company_id);
ALTER TABLE plaid_sync_event ENABLE ROW LEVEL SECURITY;

-- Link bank_account_feed to bank_connection
ALTER TABLE bank_account_feed ADD COLUMN IF NOT EXISTS bank_connection_id uuid REFERENCES bank_connection(id);
