-- Fix RLS on all bank feed tables — use JWT email via company_members (matching other tables)

-- bank_account_feed
DROP POLICY IF EXISTS baf_company_access ON bank_account_feed;
CREATE POLICY baf_company_access ON bank_account_feed FOR ALL
  USING (company_id IN (
    SELECT cm.company_id FROM company_members cm
    WHERE lower(cm.user_email) = lower(auth.jwt()->>'email')
    AND cm.status = 'active'
  ));

-- bank_feed_transaction
DROP POLICY IF EXISTS bft_company_access ON bank_feed_transaction;
CREATE POLICY bft_company_access ON bank_feed_transaction FOR ALL
  USING (company_id IN (
    SELECT cm.company_id FROM company_members cm
    WHERE lower(cm.user_email) = lower(auth.jwt()->>'email')
    AND cm.status = 'active'
  ));

-- bank_import_batch
DROP POLICY IF EXISTS bib_company_access ON bank_import_batch;
CREATE POLICY bib_company_access ON bank_import_batch FOR ALL
  USING (company_id IN (
    SELECT cm.company_id FROM company_members cm
    WHERE lower(cm.user_email) = lower(auth.jwt()->>'email')
    AND cm.status = 'active'
  ));

-- bank_transaction_rule
DROP POLICY IF EXISTS btr_company_access ON bank_transaction_rule;
CREATE POLICY btr_company_access ON bank_transaction_rule FOR ALL
  USING (company_id IN (
    SELECT cm.company_id FROM company_members cm
    WHERE lower(cm.user_email) = lower(auth.jwt()->>'email')
    AND cm.status = 'active'
  ));

-- bank_posting_decision
DROP POLICY IF EXISTS bpd_company_access ON bank_posting_decision;
CREATE POLICY bpd_company_access ON bank_posting_decision FOR ALL
  USING (company_id IN (
    SELECT cm.company_id FROM company_members cm
    WHERE lower(cm.user_email) = lower(auth.jwt()->>'email')
    AND cm.status = 'active'
  ));

-- bank_posting_decision_line
DROP POLICY IF EXISTS bpdl_company_access ON bank_posting_decision_line;
CREATE POLICY bpdl_company_access ON bank_posting_decision_line FOR ALL
  USING (company_id IN (
    SELECT cm.company_id FROM company_members cm
    WHERE lower(cm.user_email) = lower(auth.jwt()->>'email')
    AND cm.status = 'active'
  ));

-- bank_feed_transaction_link
DROP POLICY IF EXISTS bftl_company_access ON bank_feed_transaction_link;
CREATE POLICY bftl_company_access ON bank_feed_transaction_link FOR ALL
  USING (company_id IN (
    SELECT cm.company_id FROM company_members cm
    WHERE lower(cm.user_email) = lower(auth.jwt()->>'email')
    AND cm.status = 'active'
  ));

-- bank_import_mapping_profile
DROP POLICY IF EXISTS bimp_company_access ON bank_import_mapping_profile;
CREATE POLICY bimp_company_access ON bank_import_mapping_profile FOR ALL
  USING (company_id IN (
    SELECT cm.company_id FROM company_members cm
    WHERE lower(cm.user_email) = lower(auth.jwt()->>'email')
    AND cm.status = 'active'
  ));

-- accounting_period_lock
DROP POLICY IF EXISTS apl_company_access ON accounting_period_lock;
CREATE POLICY apl_company_access ON accounting_period_lock FOR ALL
  USING (company_id IN (
    SELECT cm.company_id FROM company_members cm
    WHERE lower(cm.user_email) = lower(auth.jwt()->>'email')
    AND cm.status = 'active'
  ));

-- bank_connection
DROP POLICY IF EXISTS bc_company_access ON bank_connection;
CREATE POLICY bc_company_access ON bank_connection FOR ALL
  USING (company_id IN (
    SELECT cm.company_id FROM company_members cm
    WHERE lower(cm.user_email) = lower(auth.jwt()->>'email')
    AND cm.status = 'active'
  ));

-- plaid_sync_event
DROP POLICY IF EXISTS pse_company_access ON plaid_sync_event;
CREATE POLICY pse_company_access ON plaid_sync_event FOR ALL
  USING (company_id IN (
    SELECT cm.company_id FROM company_members cm
    WHERE lower(cm.user_email) = lower(auth.jwt()->>'email')
    AND cm.status = 'active'
  ));
