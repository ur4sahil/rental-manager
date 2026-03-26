-- Fix RPC Authorization: Add caller verification to SECURITY DEFINER functions
-- All mutating RPCs now verify the caller's JWT email is an active member
-- of the target company with the appropriate role before executing.

-- Helper: extract caller email from JWT
-- (reusable across all functions below)

-- ============================================================
-- 1. approve_member_request: only admins/owners can approve
-- ============================================================
CREATE OR REPLACE FUNCTION approve_member_request(p_member_id bigint, p_role text DEFAULT 'tenant')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_company_id text;
  v_caller_email text;
  v_caller_role text;
BEGIN
  SELECT company_id INTO v_company_id FROM company_members WHERE id = p_member_id;
  IF v_company_id IS NULL THEN RAISE EXCEPTION 'Member request not found'; END IF;

  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
  WHERE company_id = v_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Unauthorized: only admins can approve members';
  END IF;

  IF p_role = 'owner' AND v_caller_role != 'owner' THEN
    RAISE EXCEPTION 'Unauthorized: only owners can assign owner role';
  END IF;

  UPDATE company_members SET status = 'active', role = COALESCE(p_role, 'tenant') WHERE id = p_member_id;
END;
$$;

-- ============================================================
-- 2. handle_membership_request: only admins/owners can approve/reject
-- ============================================================
CREATE OR REPLACE FUNCTION handle_membership_request(p_member_id bigint, p_action text, p_role text DEFAULT 'tenant')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_company_id text;
  v_caller_email text;
  v_caller_role text;
BEGIN
  SELECT company_id INTO v_company_id FROM company_members WHERE id = p_member_id;
  IF v_company_id IS NULL THEN RAISE EXCEPTION 'Member request not found'; END IF;

  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
  WHERE company_id = v_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Unauthorized: only admins can manage membership requests';
  END IF;

  IF p_role = 'owner' AND v_caller_role != 'owner' THEN
    RAISE EXCEPTION 'Unauthorized: only owners can assign owner role';
  END IF;

  IF p_action = 'approve' THEN
    UPDATE company_members SET status = 'active', role = COALESCE(p_role, 'tenant') WHERE id = p_member_id;
  ELSIF p_action = 'reject' THEN
    UPDATE company_members SET status = 'rejected' WHERE id = p_member_id;
  END IF;
END;
$$;

-- ============================================================
-- 3. accept_pm_assignment: only admins/owners of the PM company
-- ============================================================
CREATE OR REPLACE FUNCTION accept_pm_assignment(p_request_id uuid, p_pm_company_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_caller_email text;
  v_caller_role text;
BEGIN
  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
  WHERE company_id = p_pm_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Unauthorized: only admins/owners can accept PM assignments';
  END IF;

  UPDATE pm_assignment_requests SET status = 'accepted', accepted_at = now() WHERE id = p_request_id;
END;
$$;

-- ============================================================
-- 4. update_tenant_balance: caller must be a member of the tenant's company
-- ============================================================
CREATE OR REPLACE FUNCTION update_tenant_balance(p_tenant_id bigint, p_amount_change numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_company_id text;
  v_caller_email text;
  v_caller_role text;
BEGIN
  SELECT company_id INTO v_company_id FROM tenants WHERE id = p_tenant_id;
  IF v_company_id IS NULL THEN RAISE EXCEPTION 'Tenant not found'; END IF;

  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
  WHERE company_id = v_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: caller is not a member of this company';
  END IF;

  UPDATE tenants SET balance = COALESCE(balance, 0) + p_amount_change WHERE id = p_tenant_id;
END;
$$;

-- ============================================================
-- 5. increment_vendor_totals: caller must be a member of the vendor's company
-- ============================================================
CREATE OR REPLACE FUNCTION increment_vendor_totals(p_vendor_id bigint, p_amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_company_id text;
  v_caller_email text;
  v_caller_role text;
BEGIN
  SELECT company_id INTO v_company_id FROM vendors WHERE id = p_vendor_id;
  IF v_company_id IS NULL THEN RAISE EXCEPTION 'Vendor not found'; END IF;

  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
  WHERE company_id = v_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: caller is not a member of this company';
  END IF;

  UPDATE vendors SET total_paid = COALESCE(total_paid, 0) + p_amount, jobs_completed = COALESCE(jobs_completed, 0) + 1 WHERE id = p_vendor_id;
END;
$$;

-- ============================================================
-- 6. rename_property_v2: only admins/owners can rename (cascading update)
-- ============================================================
CREATE OR REPLACE FUNCTION rename_property_v2(p_company_id text, p_property_id bigint, p_new_address text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_old text;
  v_caller_email text;
  v_caller_role text;
BEGIN
  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
  WHERE company_id = p_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Unauthorized: only admins/owners can rename properties';
  END IF;

  SELECT address INTO v_old FROM properties WHERE id = p_property_id AND company_id = p_company_id;
  IF v_old IS NULL THEN RETURN; END IF;
  UPDATE properties SET address = p_new_address WHERE id = p_property_id AND company_id = p_company_id;
  UPDATE tenants SET property = p_new_address WHERE company_id = p_company_id AND property = v_old;
  UPDATE payments SET property = p_new_address WHERE company_id = p_company_id AND property = v_old;
  UPDATE leases SET property = p_new_address WHERE company_id = p_company_id AND property = v_old;
  UPDATE work_orders SET property = p_new_address WHERE company_id = p_company_id AND property = v_old;
  UPDATE documents SET property = p_new_address WHERE company_id = p_company_id AND property = v_old;
  UPDATE utilities SET property = p_new_address WHERE company_id = p_company_id AND property = v_old;
  UPDATE ledger_entries SET property = p_new_address WHERE company_id = p_company_id AND property = v_old;
  UPDATE acct_journal_entries SET property = p_new_address WHERE company_id = p_company_id AND property = v_old;
  UPDATE acct_classes SET name = p_new_address WHERE company_id = p_company_id AND name = v_old;
END;
$$;

-- ============================================================
-- 7. archive_property: only admins/owners can archive
-- ============================================================
CREATE OR REPLACE FUNCTION archive_property(p_property_id bigint, p_company_id text, p_archived_by text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_caller_email text;
  v_caller_role text;
BEGIN
  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
  WHERE company_id = p_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Unauthorized: only admins/owners can archive properties';
  END IF;

  UPDATE properties SET archived_at = now(), archived_by = p_archived_by WHERE id = p_property_id AND company_id = p_company_id;
END;
$$;

-- ============================================================
-- 8. rename_tenant_cascade: only admins/owners can rename (cascading update)
-- ============================================================
CREATE OR REPLACE FUNCTION rename_tenant_cascade(p_company_id text, p_old_name text, p_new_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_caller_email text;
  v_caller_role text;
BEGIN
  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
  WHERE company_id = p_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Unauthorized: only admins/owners can rename tenants';
  END IF;

  UPDATE payments SET tenant = p_new_name WHERE company_id = p_company_id AND tenant = p_old_name;
  UPDATE leases SET tenant_name = p_new_name WHERE company_id = p_company_id AND tenant_name = p_old_name;
  UPDATE work_orders SET tenant = p_new_name WHERE company_id = p_company_id AND tenant = p_old_name;
  UPDATE documents SET tenant = p_new_name WHERE company_id = p_company_id AND tenant = p_old_name;
  UPDATE ledger_entries SET tenant = p_new_name WHERE company_id = p_company_id AND tenant = p_old_name;
  UPDATE messages SET tenant = p_new_name WHERE company_id = p_company_id AND tenant = p_old_name;
  UPDATE autopay_schedules SET tenant = p_new_name WHERE company_id = p_company_id AND tenant = p_old_name;
  UPDATE properties SET tenant = p_new_name WHERE company_id = p_company_id AND tenant = p_old_name;
END;
$$;

-- ============================================================
-- 9. sign_lease: verify the caller's email matches the signature record
-- ============================================================
CREATE OR REPLACE FUNCTION sign_lease(p_signature_id uuid, p_signer_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_signer_email text;
  v_caller_email text;
BEGIN
  SELECT signer_email INTO v_signer_email FROM lease_signatures WHERE id = p_signature_id;
  IF v_signer_email IS NULL THEN RAISE EXCEPTION 'Signature record not found'; END IF;

  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  IF lower(v_caller_email) != lower(v_signer_email) THEN
    RAISE EXCEPTION 'Unauthorized: caller email does not match signer';
  END IF;

  UPDATE lease_signatures SET status = 'signed', signed_at = now(), signer_name = p_signer_name WHERE id = p_signature_id;
END;
$$;

-- ============================================================
-- 10. change_user_email: only admins/owners, or the user changing their own email
-- ============================================================
CREATE OR REPLACE FUNCTION change_user_email(p_old_email text, p_new_email text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_caller_email text;
  v_is_admin boolean := false;
BEGIN
  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';

  -- Allow if the caller is changing their own email
  IF lower(v_caller_email) = lower(p_old_email) THEN
    -- OK, self-service
    NULL;
  ELSE
    -- Check if caller is admin/owner in any shared company with the target user
    SELECT EXISTS (
      SELECT 1 FROM company_members cm1
      JOIN company_members cm2 ON cm1.company_id = cm2.company_id
      WHERE lower(cm1.user_email) = lower(v_caller_email) AND cm1.status = 'active' AND cm1.role IN ('admin', 'owner')
        AND lower(cm2.user_email) = lower(p_old_email) AND cm2.status = 'active'
    ) INTO v_is_admin;

    IF NOT v_is_admin THEN
      RAISE EXCEPTION 'Unauthorized: only admins or the user themselves can change email';
    END IF;
  END IF;

  UPDATE company_members SET user_email = p_new_email WHERE lower(user_email) = lower(p_old_email);
  UPDATE app_users SET email = p_new_email WHERE lower(email) = lower(p_old_email);
END;
$$;

-- ============================================================
-- 11. post_je_and_ledger: caller must be a member of the target company
-- ============================================================
CREATE OR REPLACE FUNCTION post_je_and_ledger(
  p_company_id text,
  p_date text,
  p_description text,
  p_reference text DEFAULT '',
  p_property text DEFAULT '',
  p_status text DEFAULT 'posted',
  p_lines jsonb DEFAULT '[]'::jsonb,
  p_ledger_tenant text DEFAULT NULL,
  p_ledger_tenant_id bigint DEFAULT NULL,
  p_ledger_property text DEFAULT NULL,
  p_ledger_amount numeric DEFAULT 0,
  p_ledger_type text DEFAULT NULL,
  p_ledger_description text DEFAULT NULL,
  p_balance_change numeric DEFAULT 0
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_je_id uuid;
  v_je_number text;
  v_last_num int;
  v_attempt int := 0;
  v_prev_balance numeric := 0;
  v_new_balance numeric := 0;
  v_line jsonb;
  v_caller_email text;
  v_caller_role text;
BEGIN
  -- Authorization: caller must be an active member of this company
  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
  WHERE company_id = p_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: caller is not a member of this company';
  END IF;

  -- Step 1: Generate collision-safe JE number
  LOOP
    SELECT COALESCE(
      (SELECT regexp_replace(number, '\D', '', 'g')::int
       FROM acct_journal_entries
       WHERE company_id = p_company_id
       ORDER BY created_at DESC LIMIT 1), 0
    ) INTO v_last_num;

    v_je_number := 'JE-' || lpad((v_last_num + 1 + v_attempt)::text, 4, '0');

    BEGIN
      INSERT INTO acct_journal_entries (company_id, number, date, description, reference, property, status)
      VALUES (p_company_id, v_je_number, p_date, p_description, p_reference, p_property, p_status)
      RETURNING id INTO v_je_id;
      EXIT; -- success
    EXCEPTION WHEN unique_violation THEN
      v_attempt := v_attempt + 1;
      IF v_attempt >= 5 THEN
        RAISE EXCEPTION 'Could not generate unique JE number after 5 attempts';
      END IF;
    END;
  END LOOP;

  -- Step 2: Insert JE lines
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    INSERT INTO acct_journal_lines (
      journal_entry_id, company_id, account_id, account_name,
      debit, credit, class_id, memo
    ) VALUES (
      v_je_id, p_company_id,
      v_line->>'account_id', COALESCE(v_line->>'account_name', ''),
      COALESCE((v_line->>'debit')::numeric, 0),
      COALESCE((v_line->>'credit')::numeric, 0),
      NULLIF(v_line->>'class_id', ''),
      COALESCE(v_line->>'memo', '')
    );
  END LOOP;

  -- Step 3: Insert ledger entry with running balance (if tenant provided)
  IF p_ledger_type IS NOT NULL AND (p_ledger_tenant_id IS NOT NULL OR p_ledger_tenant IS NOT NULL) THEN
    -- Get previous balance
    IF p_ledger_tenant_id IS NOT NULL THEN
      SELECT COALESCE(balance, 0) INTO v_prev_balance
      FROM ledger_entries
      WHERE company_id = p_company_id AND tenant_id = p_ledger_tenant_id
      ORDER BY date DESC, created_at DESC LIMIT 1;
    ELSE
      SELECT COALESCE(balance, 0) INTO v_prev_balance
      FROM ledger_entries
      WHERE company_id = p_company_id AND lower(tenant) = lower(p_ledger_tenant)
      ORDER BY date DESC, created_at DESC LIMIT 1;
    END IF;

    -- Calculate new balance based on type
    IF p_ledger_type IN ('charge', 'late_fee', 'expense', 'deposit_deduction') THEN
      v_new_balance := COALESCE(v_prev_balance, 0) + p_ledger_amount;
    ELSIF p_ledger_type IN ('payment', 'credit', 'deposit_return', 'void') THEN
      v_new_balance := COALESCE(v_prev_balance, 0) - p_ledger_amount;
    ELSE
      v_new_balance := COALESCE(v_prev_balance, 0) + p_ledger_amount;
    END IF;

    INSERT INTO ledger_entries (
      company_id, tenant, tenant_id, property, date,
      description, amount, type, balance
    ) VALUES (
      p_company_id, p_ledger_tenant, p_ledger_tenant_id, p_ledger_property, p_date,
      COALESCE(p_ledger_description, p_description), p_ledger_amount, p_ledger_type, v_new_balance
    );
  END IF;

  -- Step 4: Update tenant balance (if balance change specified)
  IF p_balance_change != 0 AND p_ledger_tenant_id IS NOT NULL THEN
    UPDATE tenants SET balance = COALESCE(balance, 0) + p_balance_change WHERE id = p_ledger_tenant_id;
  END IF;

  RETURN v_je_id;
END;
$$;

-- ============================================================
-- 12. increment_rule_stats: caller must be a member of the rule's company
-- ============================================================
CREATE OR REPLACE FUNCTION increment_rule_stats(rule_id UUID)
RETURNS void AS $$
DECLARE
  v_company_id text;
  v_caller_email text;
  v_caller_role text;
BEGIN
  SELECT company_id INTO v_company_id FROM bank_transaction_rule WHERE id = rule_id;
  IF v_company_id IS NULL THEN RAISE EXCEPTION 'Rule not found'; END IF;

  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
  WHERE company_id = v_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: caller is not a member of this company';
  END IF;

  UPDATE bank_transaction_rule
  SET apply_count = COALESCE(apply_count, 0) + 1,
      last_applied_at = NOW()
  WHERE id = rule_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
