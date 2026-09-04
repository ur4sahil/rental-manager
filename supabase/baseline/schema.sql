-- ============================================================
-- BASELINE SCHEMA
--
-- Generated from production (hoymytpyaudjvsgiiibn) with pg_dump.
--
-- WHY THIS EXISTS. The 158 migrations that follow cannot build this
-- database. Not one of the core tables -- properties, tenants, payments,
-- companies, app_users, the acct_* tables -- is created by any of them.
-- They were made by hand in the Supabase dashboard before migrations were
-- kept, so the very first migration already assumes `payments` exists and
-- only adds columns to it. `supabase db push` against an empty project
-- therefore failed on the first ALTER TABLE, and the repo could not
-- reproduce its own schema.
--
-- This file closes that gap: it is the complete schema as it actually
-- stands, so an empty project can be brought to the current state from
-- the repository alone.
--
-- It runs FIRST (timestamp precedes every existing migration) and
-- supersedes them -- they are historical record, and replaying them over
-- this baseline is neither needed nor safe. Use
-- scripts/rebuild-from-baseline.sh, which applies this file and then
-- stamps the migration history so later migrations behave normally.
--
-- To regenerate after schema changes reach production:
--   ./scripts/generate-baseline.sh
-- ============================================================

--
-- PostgreSQL database dump
--

\restrict fSXlDjwwEPRba8CzwZYJ4qyg88CyFInEDGiCfCOa7eSATpr1Ei4IymnMxYonXNz

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- (skipped) CREATE SCHEMA "public" — Supabase provisions it


--
-- Name: SCHEMA "public"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA "public" IS 'standard public schema';


--
-- Name: _doc_signatures_audit_trg(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."_doc_signatures_audit_trg"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_actor text;
  v_role text;
  v_deltas jsonb := '{}'::jsonb;
  -- Field set we care about — everything else (UI-only metadata)
  -- is excluded from the delta to keep the log compact.
  v_tracked text[] := ARRAY[
    'status','signer_name','signer_email','signature_data','signing_method',
    'consent_text','signer_ip','user_agent','integrity_hash',
    'signed_at','viewed_at','sent_at','declined_at','declined_reason',
    'access_token','token_expires_at',
    'e_records_consented','e_records_consent_at','e_records_consent_version',
    'hardware_software_acknowledged','paper_copy_requested_at',
    'consent_withdrawn_at','consent_withdrawn_reason'
  ];
  k text;
  v_old_val text;
  v_new_val text;
BEGIN
  -- Best-effort actor identity. JWT email is set when the call
  -- comes through PostgREST as a logged-in staff user; for
  -- public-RPC paths (sign_document, request_paper_copy) the JWT
  -- is the anon role with no email, so we tag those as 'public'.
  BEGIN v_actor := COALESCE(NULLIF(auth.jwt() ->> 'email',''), 'public'); EXCEPTION WHEN others THEN v_actor := 'system'; END;
  BEGIN v_role  := NULLIF(auth.jwt() ->> 'role','');                        EXCEPTION WHEN others THEN v_role := NULL; END;

  IF (TG_OP = 'INSERT') THEN
    INSERT INTO doc_signature_audit_log (
      signature_id, doc_id, company_id, op,
      old_status, new_status, field_deltas, actor_email, actor_role
    ) VALUES (
      NEW.id, NEW.doc_id, NEW.company_id, 'insert',
      NULL, NEW.status,
      to_jsonb(NEW) - 'access_token' - 'signature_data',  -- redact secrets at rest in the log
      v_actor, v_role
    );
    RETURN NEW;
  ELSIF (TG_OP = 'UPDATE') THEN
    -- Build a column-by-column delta of tracked fields.
    FOREACH k IN ARRAY v_tracked LOOP
      v_old_val := (to_jsonb(OLD) ->> k);
      v_new_val := (to_jsonb(NEW) ->> k);
      IF v_old_val IS DISTINCT FROM v_new_val THEN
        -- Redact long/secret fields in the delta — keep just the
        -- hash prefix so the auditor knows it changed without
        -- copying the full signature image / token into the log.
        IF k IN ('signature_data','access_token') THEN
          v_deltas := v_deltas || jsonb_build_object(k, jsonb_build_object(
            'old_prefix', LEFT(COALESCE(v_old_val,''), 16),
            'new_prefix', LEFT(COALESCE(v_new_val,''), 16),
            'len_changed', length(COALESCE(v_old_val,'')) <> length(COALESCE(v_new_val,''))
          ));
        ELSE
          v_deltas := v_deltas || jsonb_build_object(k, jsonb_build_object('old', v_old_val, 'new', v_new_val));
        END IF;
      END IF;
    END LOOP;
    -- Skip entirely if nothing tracked changed (e.g. a transient
    -- viewed_at-only update fired by a re-fetch race).
    IF v_deltas <> '{}'::jsonb THEN
      INSERT INTO doc_signature_audit_log (
        signature_id, doc_id, company_id, op,
        old_status, new_status, field_deltas, actor_email, actor_role
      ) VALUES (
        NEW.id, NEW.doc_id, NEW.company_id, 'update',
        OLD.status, NEW.status, v_deltas, v_actor, v_role
      );
    END IF;
    RETURN NEW;
  ELSIF (TG_OP = 'DELETE') THEN
    INSERT INTO doc_signature_audit_log (
      signature_id, doc_id, company_id, op,
      old_status, new_status, field_deltas, actor_email, actor_role
    ) VALUES (
      OLD.id, OLD.doc_id, OLD.company_id, 'delete',
      OLD.status, NULL,
      to_jsonb(OLD) - 'access_token' - 'signature_data',
      v_actor, v_role
    );
    RETURN OLD;
  END IF;
  RETURN NULL;
END $$;


--
-- Name: _gen_signing_token(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."_gen_signing_token"() RETURNS "text"
    LANGUAGE "sql"
    AS $$
  SELECT translate(replace(encode(gen_random_bytes(32), 'base64'), '=', ''), '+/', '-_');
$$;


--
-- Name: _wizard_get_tenant_ar("text", "text", bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."_wizard_get_tenant_ar"("p_company_id" "text", "p_tenant_name" "text", "p_tenant_id" bigint) RETURNS "uuid"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_id uuid;
  v_parent uuid;
  v_next_seq int;
  v_code text;
BEGIN
  IF p_tenant_name IS NULL OR p_tenant_name = '' THEN
    RETURN _wizard_resolve_account(p_company_id, '1100');
  END IF;
  SELECT id INTO v_id FROM acct_accounts
  WHERE company_id = p_company_id AND type = 'Asset' AND name = 'AR - ' || p_tenant_name
  LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  v_parent := _wizard_resolve_account(p_company_id, '1100');
  SELECT COALESCE(MAX(CAST(split_part(code, '-', 2) AS int)), 0) + 1 INTO v_next_seq
  FROM acct_accounts
  WHERE company_id = p_company_id AND code LIKE '1100-%';
  v_code := '1100-' || lpad(v_next_seq::text, 3, '0');
  -- acct_accounts.tenant_id is uuid; tenants.id is bigint. Don't write
  -- it — the AR account is identified by name "AR - <tenant_name>"
  -- everywhere else, and the column is NULL across every live row.
  INSERT INTO acct_accounts (company_id, code, name, type, is_active, old_text_id, parent_id)
  VALUES (p_company_id, v_code, 'AR - ' || p_tenant_name, 'Asset', true,
          p_company_id || '-' || v_code, v_parent)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;


--
-- Name: _wizard_resolve_account("text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."_wizard_resolve_account"("p_company_id" "text", "p_code" "text") RETURNS "uuid"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_id uuid;
  v_name text;
  v_type text;
BEGIN
  SELECT id INTO v_id FROM acct_accounts WHERE company_id = p_company_id AND code = p_code LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  v_name := CASE p_code
    WHEN '1000' THEN 'Checking Account'
    WHEN '1100' THEN 'Accounts Receivable'
    WHEN '2100' THEN 'Security Deposits Held'
    WHEN '4000' THEN 'Rental Income'
    WHEN '5600' THEN 'Mortgage/Loan Payment'
    ELSE 'Account ' || p_code
  END;
  v_type := CASE substring(p_code, 1, 1)
    WHEN '1' THEN 'Asset'
    WHEN '2' THEN 'Liability'
    WHEN '3' THEN 'Equity'
    WHEN '4' THEN 'Revenue'
    ELSE 'Expense'
  END;
  INSERT INTO acct_accounts (company_id, code, name, type, is_active, old_text_id)
  VALUES (p_company_id, p_code, v_name, v_type, true, p_company_id || '-' || p_code)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;


--
-- Name: accept_pm_assignment("uuid", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."accept_pm_assignment"("p_request_id" "uuid", "p_pm_company_id" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


--
-- Name: accept_pm_assignment("text", "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."accept_pm_assignment"("p_request_id" "text", "p_pm_company_id" "text", "p_reviewer_email" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_req RECORD;
BEGIN
  -- Fetch and validate request
  SELECT * INTO v_req FROM pm_assignment_requests
    WHERE id = p_request_id AND pm_company_id = p_pm_company_id AND status = 'pending';
  
  IF v_req IS NULL THEN
    RAISE EXCEPTION 'Request not found or already processed';
  END IF;

  -- Mark request as accepted
  UPDATE pm_assignment_requests SET
    status = 'accepted',
    reviewed_by = p_reviewer_email,
    reviewed_at = NOW()
  WHERE id = p_request_id;

  -- Assign PM to the property
  UPDATE properties SET
    pm_company_id = p_pm_company_id,
    pm_company_name = v_req.pm_company_name
  WHERE id = v_req.property_id AND company_id = v_req.owner_company_id;

  RETURN jsonb_build_object(
    'success', true,
    'property_address', v_req.property_address,
    'pm_company_name', v_req.pm_company_name
  );
END;
$$;


--
-- Name: apply_late_fee_atomic("text", "uuid", "text", "text", numeric, "text", "text", "text", "text", "uuid", "uuid", "uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."apply_late_fee_atomic"("p_company_id" "text", "p_tenant_id" "uuid", "p_tenant_name" "text", "p_property" "text", "p_fee_amount" numeric, "p_je_number" "text", "p_je_date" "text", "p_description" "text", "p_reference" "text", "p_late_fee_account_id" "uuid", "p_ar_account_id" "uuid", "p_class_id" "uuid" DEFAULT NULL::"uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_je_id UUID;
  v_result JSON;
BEGIN
  -- 1. Create journal entry header
  INSERT INTO acct_journal_entries (company_id, number, date, description, reference, property, status)
  VALUES (p_company_id, p_je_number, p_je_date, p_description, p_reference, p_property, 'posted')
  RETURNING id INTO v_je_id;

  -- 2. Create journal lines (DR: AR, CR: Late Fee Income)
  INSERT INTO acct_journal_lines (journal_entry_id, company_id, account_id, debit, credit, class_id, memo)
  VALUES
    (v_je_id, p_company_id, p_ar_account_id, p_fee_amount, 0, p_class_id, p_description),
    (v_je_id, p_company_id, p_late_fee_account_id, 0, p_fee_amount, p_class_id, p_description);

  -- 3. Create ledger entry
  INSERT INTO ledger_entries (company_id, tenant, tenant_id, property, date, description, amount, type, balance)
  VALUES (p_company_id, p_tenant_name, p_tenant_id, p_property, p_je_date, p_description, p_fee_amount, 'charge', 0);

  -- 4. Update tenant balance
  PERFORM update_tenant_balance(p_tenant_id, p_fee_amount);

  v_result := json_build_object('jeId', v_je_id, 'success', true);
  RETURN v_result;

EXCEPTION WHEN OTHERS THEN
  RAISE;
END;
$$;


--
-- Name: approve_member_request(bigint, "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."approve_member_request"("p_member_id" bigint, "p_role" "text" DEFAULT 'tenant'::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


--
-- Name: archive_property(bigint, "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."archive_property"("p_property_id" bigint, "p_company_id" "text", "p_archived_by" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


--
-- Name: archive_property("text", "text", "text", boolean, "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."archive_property"("p_company_id" "text", "p_property_id" "text", "p_address" "text", "p_archive_tenant" boolean DEFAULT false, "p_user_email" "text" DEFAULT 'system'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_prop_id INT;
  v_tenant_count INT;
BEGIN
  v_prop_id := p_property_id::INT;

  -- Archive the property
  UPDATE properties SET archived_at = NOW(), archived_by = p_user_email
    WHERE company_id = p_company_id AND id = v_prop_id AND archived_at IS NULL;

  -- Archive related work orders
  UPDATE work_orders SET archived_at = NOW()
    WHERE company_id = p_company_id AND (property = p_address OR property_id = v_prop_id) AND archived_at IS NULL;

  -- Archive related utilities
  UPDATE utilities SET archived_at = NOW()
    WHERE company_id = p_company_id AND property = p_address AND archived_at IS NULL;

  -- Archive related HOA payments
  UPDATE hoa_payments SET archived_at = NOW()
    WHERE company_id = p_company_id AND property = p_address AND archived_at IS NULL;

  -- Archive related autopay schedules
  UPDATE autopay_schedules SET archived_at = NOW()
    WHERE company_id = p_company_id AND property = p_address AND archived_at IS NULL;

  -- Optionally archive the tenant
  IF p_archive_tenant THEN
    UPDATE tenants SET archived_at = NOW(), archived_by = p_user_email
      WHERE company_id = p_company_id AND property = p_address AND archived_at IS NULL;
    UPDATE leases SET archived_at = NOW()
      WHERE company_id = p_company_id AND property = p_address AND archived_at IS NULL;
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;


--
-- Name: audit_trigger_func(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."audit_trigger_func"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_company_id TEXT := 'unknown';
  v_record_id TEXT := '';
BEGIN
  -- Safely extract company_id (may not exist on all tables)
  BEGIN
    IF TG_OP = 'DELETE' THEN
      v_company_id := OLD.company_id;
      v_record_id := OLD.id::TEXT;
    ELSE
      v_company_id := NEW.company_id;
      v_record_id := NEW.id::TEXT;
    END IF;
  EXCEPTION WHEN undefined_column THEN
    v_company_id := 'unknown';
    v_record_id := '';
  END;

  INSERT INTO audit_trail (
    company_id, action, module, details, record_id,
    user_email, user_role
  ) VALUES (
    COALESCE(v_company_id, 'unknown'),
    TG_OP,
    TG_TABLE_NAME,
    TG_OP || ' on ' || TG_TABLE_NAME,
    COALESCE(v_record_id, ''),
    COALESCE(current_setting('request.jwt.claims', true)::json->>'email', 'system'),
    'auto'
  );
  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  -- Don't let audit failures block the actual operation
  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: auto_fill_property_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."auto_fill_property_id"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW.property_id IS NULL AND NEW.property IS NOT NULL AND NEW.company_id IS NOT NULL THEN
    SELECT id INTO NEW.property_id FROM properties
    WHERE address = NEW.property AND company_id = NEW.company_id LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: batch_post_rent_charges("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."batch_post_rent_charges"("p_company_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_lease RECORD;
  v_today DATE := CURRENT_DATE;
  v_month TEXT := to_char(v_today, 'YYYY-MM');
  v_charge_date TEXT;
  v_je_id TEXT;
  v_je_number TEXT;
  v_count INTEGER := 0;
  v_due_day INTEGER;
  v_class_id TEXT;
  v_attempt INTEGER;
  v_ar_id TEXT;
  v_revenue_id TEXT;
BEGIN
  -- Verify caller is admin/staff of this company
  IF NOT EXISTS (
    SELECT 1 FROM company_members
    WHERE company_id = p_company_id
    AND LOWER(user_email) = LOWER(auth.jwt()->>'email')
    AND status = 'active'
    AND role IN ('admin', 'office_assistant', 'accountant')
  ) THEN
    RAISE EXCEPTION 'Access denied: insufficient role for this operation';
  END IF;
  
  -- Find the company-specific account IDs for AR and Revenue
  SELECT id INTO v_ar_id FROM acct_accounts WHERE company_id = p_company_id AND name = 'Accounts Receivable' LIMIT 1;
  SELECT id INTO v_revenue_id FROM acct_accounts WHERE company_id = p_company_id AND name = 'Rental Income' LIMIT 1;
  IF v_ar_id IS NULL OR v_revenue_id IS NULL THEN
    RAISE EXCEPTION 'Missing required accounts (Accounts Receivable or Rental Income) for company %', p_company_id;
  END IF;

  FOR v_lease IN 
    SELECT l.*, t.balance as tenant_balance
    FROM leases l
    LEFT JOIN tenants t ON t.id = l.tenant_id
    WHERE l.company_id = p_company_id 
    AND l.status = 'active'
    AND l.start_date <= v_today::TEXT
  LOOP
    -- Check if already posted this month
    IF EXISTS (
      SELECT 1 FROM acct_journal_entries 
      WHERE company_id = p_company_id 
      AND reference LIKE 'RENT-AUTO-%' || v_month || '%'
      AND status != 'voided'
      AND position(v_lease.tenant_name IN description) > 0
    ) THEN
      CONTINUE;
    END IF;

    -- Clamp due day
    v_due_day := LEAST(COALESCE(v_lease.payment_due_day, 1), 
                       EXTRACT(DAY FROM (date_trunc('month', v_today) + interval '1 month - 1 day'))::INTEGER);
    v_charge_date := v_month || '-' || LPAD(v_due_day::TEXT, 2, '0');

    -- Get class ID for property
    SELECT id INTO v_class_id FROM acct_classes 
    WHERE company_id = p_company_id AND name = v_lease.property LIMIT 1;

    -- Retry loop for JE number conflicts
    v_attempt := 0;
    LOOP
      v_attempt := v_attempt + 1;
      IF v_attempt > 5 THEN
        -- Skip this lease entirely if we can't get a unique number
        v_je_id := NULL;
        EXIT;
      END IF;
      
      BEGIN
        v_je_number := next_journal_number(p_company_id);
        v_je_id := 'je-' || EXTRACT(EPOCH FROM NOW())::BIGINT || '-' || substr(md5(random()::text), 1, 8) || v_count || v_attempt;

        INSERT INTO acct_journal_entries (id, number, date, description, reference, property, status, company_id)
        VALUES (v_je_id, v_je_number, v_charge_date, 
                'Rent charge — ' || v_lease.tenant_name || ' — ' || v_lease.property,
                'RENT-AUTO-' || v_lease.id::text || '-' || v_month,
                v_lease.property, 'posted', p_company_id);
        EXIT; -- success
      EXCEPTION WHEN unique_violation THEN
        CONTINUE; -- retry
      END;
    END LOOP;

    -- Only insert lines and update balance if header succeeded
    IF v_je_id IS NOT NULL THEN
      -- DR Accounts Receivable, CR Rental Income
      INSERT INTO acct_journal_lines (journal_entry_id, account_id, account_name, debit, credit, class_id, memo)
      VALUES 
        (v_je_id, COALESCE(v_ar_id, '1100'), 'Accounts Receivable', v_lease.rent_amount, 0, v_class_id, 'Rent — ' || v_lease.tenant_name),
        (v_je_id, COALESCE(v_revenue_id, '4000'), 'Rental Income', 0, v_lease.rent_amount, v_class_id, v_lease.property || ' — ' || v_month);

      -- Update tenant balance atomically
      IF v_lease.tenant_id IS NOT NULL THEN
        UPDATE tenants SET balance = COALESCE(balance, 0) + v_lease.rent_amount 
        WHERE id = v_lease.tenant_id;
        
        -- Create ledger entry for this rent charge
        INSERT INTO ledger_entries (company_id, tenant, property, date, description, amount, type, balance)
        VALUES (p_company_id, v_lease.tenant_name, v_lease.property, v_charge_date,
                'Rent charge — ' || v_month, v_lease.rent_amount, 'charge', 0);
      END IF;

      v_count := v_count + 1;
    END IF; -- v_je_id IS NOT NULL

  END LOOP;

  RETURN jsonb_build_object('success', true, 'charges_posted', v_count, 'month', v_month);
END;
$$;


--
-- Name: change_user_email("text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."change_user_email"("p_old_email" "text", "p_new_email" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


--
-- Name: change_user_email("text", "text", "text", "text", "text", "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."change_user_email"("p_company_id" "text", "p_user_id" "text", "p_old_email" "text", "p_new_email" "text", "p_name" "text", "p_role" "text", "p_custom_pages" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_caller_email TEXT;
BEGIN
  -- Verify caller is authenticated and is admin of this company
  v_caller_email := LOWER(auth.jwt()->>'email');
  IF NOT EXISTS (
    SELECT 1 FROM company_members
    WHERE company_id = p_company_id
    AND LOWER(user_email) = v_caller_email
    AND status = 'active'
    AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only admins can change user emails';
  END IF;

  -- 1. Delete old membership row (if email actually changed)
  IF LOWER(p_old_email) != LOWER(p_new_email) THEN
    DELETE FROM company_members
    WHERE company_id = p_company_id
    AND LOWER(user_email) = LOWER(p_old_email);
  END IF;

  -- 2. Update app_users
  UPDATE app_users SET
    email = LOWER(p_new_email),
    name = p_name,
    role = p_role,
    custom_pages = p_custom_pages
  WHERE company_id = p_company_id AND id = p_user_id::int;

  -- 3. Upsert new membership
  INSERT INTO company_members (company_id, user_email, user_name, role, status, custom_pages)
  VALUES (p_company_id, LOWER(p_new_email), p_name, p_role, 'active', p_custom_pages)
  ON CONFLICT (company_id, user_email) DO UPDATE SET
    user_name = EXCLUDED.user_name,
    role = EXCLUDED.role,
    custom_pages = EXCLUDED.custom_pages;

  RETURN jsonb_build_object('success', true);
END;
$$;


--
-- Name: commit_property_wizard("jsonb"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."commit_property_wizard"("p_payload" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $_$
DECLARE
  v_company_id text;
  v_wizard_id uuid;
  v_mode text;
  v_caller_email text;
  v_caller_role text;

  v_prop jsonb;
  v_tenant jsonb;
  v_utilities jsonb;
  v_hoas jsonb;
  v_loan jsonb;
  v_insurance jsonb;
  v_taxes jsonb;
  v_recurring jsonb;

  v_property_id bigint;
  v_property_id_in bigint;
  v_property_id_raw text;
  v_address text;
  v_class_id text;
  v_tenant_id bigint;
  v_tenant_name text;
  v_all_tenants text;
  v_lease_id uuid;
  v_existing_tenant_id bigint;
  v_existing_lease_id uuid;
  v_existing_loan_id uuid;
  v_existing_ins_id uuid;
  v_existing_tax_id uuid;
  v_existing_recur_id uuid;
  v_existing_mort_id uuid;
  v_u jsonb;
  v_h jsonb;
  v_tenant_ar_id uuid;
  v_revenue_id uuid;
  v_mortgage_id uuid;
  v_checking_id uuid;
  v_next_post_date date;
  v_day int;
  v_is_occupied boolean;
BEGIN
  v_company_id := p_payload->>'company_id';
  v_wizard_id  := NULLIF(p_payload->>'wizard_id','')::uuid;
  v_mode       := COALESCE(p_payload->>'mode', 'fresh');

  v_property_id_raw := p_payload->>'property_id_for_edit';
  IF v_mode = 'edit' AND v_property_id_raw IS NOT NULL AND v_property_id_raw ~ '^\d+$' THEN
    v_property_id_in := v_property_id_raw::bigint;
  ELSE
    v_property_id_in := NULL;
    v_mode := 'fresh';
  END IF;

  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
  WHERE company_id = v_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';
  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: not a member of this company';
  END IF;
  IF v_caller_role NOT IN ('admin','owner','pm','manager','office_assistant') THEN
    RAISE EXCEPTION 'Role % cannot commit a property wizard', v_caller_role;
  END IF;

  v_prop := p_payload->'property';
  v_tenant := p_payload->'tenant';
  v_utilities := COALESCE(p_payload->'utilities', '[]'::jsonb);
  v_hoas := COALESCE(p_payload->'hoas', '[]'::jsonb);
  v_loan := p_payload->'loan';
  v_insurance := p_payload->'insurance';
  v_taxes := p_payload->'taxes';
  v_recurring := p_payload->'recurring';

  v_is_occupied := (v_prop->>'status') = 'occupied';

  v_address := TRIM(BOTH ', ' FROM COALESCE(v_prop->>'address_line_1','') ||
    CASE WHEN COALESCE(v_prop->>'address_line_2','') <> '' THEN ', ' || (v_prop->>'address_line_2') ELSE '' END ||
    ', ' || COALESCE(v_prop->>'city','') ||
    ', ' || COALESCE(v_prop->>'state','') ||
    ' ' || COALESCE(v_prop->>'zip',''));

  IF v_mode = 'edit' AND v_property_id_in IS NOT NULL THEN
    UPDATE properties SET
      address = v_address,
      address_line_1 = v_prop->>'address_line_1',
      address_line_2 = v_prop->>'address_line_2',
      city = v_prop->>'city',
      state = v_prop->>'state',
      zip = v_prop->>'zip',
      county = v_prop->>'county',
      type = v_prop->>'type',
      status = v_prop->>'status',
      notes = v_prop->>'notes'
    WHERE id = v_property_id_in AND company_id = v_company_id;
    v_property_id := v_property_id_in;
  ELSE
    IF EXISTS (SELECT 1 FROM properties WHERE company_id = v_company_id AND address = v_address AND archived_at IS NULL) THEN
      RAISE EXCEPTION 'A property with this address already exists';
    END IF;
    INSERT INTO properties (
      address, address_line_1, address_line_2, city, state, zip, county,
      type, status, notes, company_id
    ) VALUES (
      v_address, v_prop->>'address_line_1', v_prop->>'address_line_2',
      v_prop->>'city', v_prop->>'state', v_prop->>'zip', v_prop->>'county',
      v_prop->>'type', v_prop->>'status', v_prop->>'notes', v_company_id
    ) RETURNING id INTO v_property_id;
  END IF;

  INSERT INTO acct_classes (id, name, description, color, is_active, company_id)
  VALUES (
    gen_random_uuid()::text, v_address,
    (v_prop->>'type') || ' · $' || COALESCE(v_tenant->>'rent','0') || '/mo',
    '#6366f1', true, v_company_id
  )
  ON CONFLICT (company_id, name) DO UPDATE SET
    description = EXCLUDED.description,
    is_active = true
  RETURNING id INTO v_class_id;
  UPDATE properties SET class_id = v_class_id WHERE id = v_property_id AND company_id = v_company_id;

  IF v_is_occupied AND v_tenant IS NOT NULL AND (v_tenant->>'tenant') IS NOT NULL AND (v_tenant->>'tenant') <> '' THEN
    v_tenant_name := v_tenant->>'tenant';

    SELECT id INTO v_existing_tenant_id FROM tenants
    WHERE company_id = v_company_id
      AND property = v_address
      AND lower(COALESCE(email,'')) = lower(COALESCE(v_tenant->>'tenant_email',''))
      AND archived_at IS NULL
    LIMIT 1;
    IF v_existing_tenant_id IS NULL THEN
      SELECT id INTO v_existing_tenant_id FROM tenants
      WHERE company_id = v_company_id AND property = v_address
        AND lease_status = 'active' AND archived_at IS NULL
      LIMIT 1;
    END IF;

    IF v_existing_tenant_id IS NOT NULL THEN
      UPDATE tenants SET
        name = v_tenant_name,
        first_name = v_tenant->>'tenant_first',
        middle_initial = v_tenant->>'tenant_mi',
        last_name = v_tenant->>'tenant_last',
        email = lower(v_tenant->>'tenant_email'),
        phone = v_tenant->>'tenant_phone',
        rent = (v_tenant->>'rent')::numeric,
        late_fee_amount = NULLIF(v_tenant->>'late_fee_amount','')::numeric,
        late_fee_type = COALESCE(v_tenant->>'late_fee_type','flat'),
        lease_status = 'active',
        lease_start = NULLIF(v_tenant->>'lease_start','')::date,
        lease_end_date = NULLIF(v_tenant->>'lease_end','')::date,
        move_in = NULLIF(v_tenant->>'lease_start','')::date,
        is_voucher = COALESCE((v_tenant->>'is_voucher')::boolean, false),
        voucher_number = NULLIF(v_tenant->>'voucher_number',''),
        reexam_date = NULLIF(v_tenant->>'reexam_date','')::date,
        case_manager_name = NULLIF(v_tenant->>'case_manager_name',''),
        case_manager_email = NULLIF(v_tenant->>'case_manager_email',''),
        case_manager_phone = NULLIF(v_tenant->>'case_manager_phone',''),
        voucher_portion = NULLIF(v_tenant->>'voucher_portion','')::numeric,
        tenant_portion = NULLIF(v_tenant->>'tenant_portion','')::numeric
      WHERE id = v_existing_tenant_id AND company_id = v_company_id;
      v_tenant_id := v_existing_tenant_id;
    ELSE
      INSERT INTO tenants (
        company_id, name, first_name, middle_initial, last_name,
        email, phone, property, rent,
        late_fee_amount, late_fee_type, lease_status,
        lease_start, lease_end_date, move_in, balance,
        is_voucher, voucher_number, reexam_date,
        case_manager_name, case_manager_email, case_manager_phone,
        voucher_portion, tenant_portion
      ) VALUES (
        v_company_id, v_tenant_name,
        v_tenant->>'tenant_first', v_tenant->>'tenant_mi', v_tenant->>'tenant_last',
        lower(v_tenant->>'tenant_email'), v_tenant->>'tenant_phone', v_address,
        (v_tenant->>'rent')::numeric,
        NULLIF(v_tenant->>'late_fee_amount','')::numeric,
        COALESCE(v_tenant->>'late_fee_type','flat'),
        'active',
        NULLIF(v_tenant->>'lease_start','')::date,
        NULLIF(v_tenant->>'lease_end','')::date,
        NULLIF(v_tenant->>'lease_start','')::date,
        0,
        COALESCE((v_tenant->>'is_voucher')::boolean, false),
        NULLIF(v_tenant->>'voucher_number',''),
        NULLIF(v_tenant->>'reexam_date','')::date,
        NULLIF(v_tenant->>'case_manager_name',''),
        NULLIF(v_tenant->>'case_manager_email',''),
        NULLIF(v_tenant->>'case_manager_phone',''),
        NULLIF(v_tenant->>'voucher_portion','')::numeric,
        NULLIF(v_tenant->>'tenant_portion','')::numeric
      ) RETURNING id INTO v_tenant_id;
    END IF;

    UPDATE properties SET
      status = 'occupied',
      tenant = v_tenant_name,
      tenant_2 = COALESCE(v_tenant->>'tenant_2',''),
      tenant_2_email = COALESCE(v_tenant->>'tenant_2_email',''),
      tenant_2_phone = COALESCE(v_tenant->>'tenant_2_phone',''),
      tenant_3 = COALESCE(v_tenant->>'tenant_3',''),
      tenant_3_email = COALESCE(v_tenant->>'tenant_3_email',''),
      tenant_3_phone = COALESCE(v_tenant->>'tenant_3_phone',''),
      tenant_4 = COALESCE(v_tenant->>'tenant_4',''),
      tenant_4_email = COALESCE(v_tenant->>'tenant_4_email',''),
      tenant_4_phone = COALESCE(v_tenant->>'tenant_4_phone',''),
      tenant_5 = COALESCE(v_tenant->>'tenant_5',''),
      tenant_5_email = COALESCE(v_tenant->>'tenant_5_email',''),
      tenant_5_phone = COALESCE(v_tenant->>'tenant_5_phone',''),
      rent = (v_tenant->>'rent')::numeric,
      security_deposit = COALESCE(NULLIF(v_tenant->>'security_deposit','')::numeric, 0),
      lease_start = NULLIF(v_tenant->>'lease_start','')::date,
      lease_end = NULLIF(v_tenant->>'lease_end','')::date
    WHERE id = v_property_id AND company_id = v_company_id;

    IF (v_tenant->>'lease_start') IS NOT NULL AND (v_tenant->>'lease_start') <> ''
       AND (v_tenant->>'lease_end') IS NOT NULL AND (v_tenant->>'lease_end') <> '' THEN
      v_all_tenants := concat_ws(' / ',
        NULLIF(v_tenant->>'tenant',''),
        NULLIF(v_tenant->>'tenant_2',''),
        NULLIF(v_tenant->>'tenant_3',''),
        NULLIF(v_tenant->>'tenant_4','')
      );
      SELECT id INTO v_existing_lease_id FROM leases
      WHERE company_id = v_company_id AND property = v_address AND status = 'active'
      LIMIT 1;
      IF v_existing_lease_id IS NOT NULL THEN
        UPDATE leases SET
          tenant_name = v_all_tenants,
          tenant_id = v_tenant_id,
          start_date = (v_tenant->>'lease_start')::date,
          end_date = (v_tenant->>'lease_end')::date,
          rent_amount = (v_tenant->>'rent')::numeric,
          security_deposit = COALESCE(NULLIF(v_tenant->>'security_deposit','')::numeric, 0),
          payment_due_day = 1
        WHERE id = v_existing_lease_id AND company_id = v_company_id;
        v_lease_id := v_existing_lease_id;
      ELSE
        INSERT INTO leases (
          company_id, tenant_name, tenant_id, property,
          start_date, end_date, rent_amount, security_deposit,
          status, payment_due_day
        ) VALUES (
          v_company_id, v_all_tenants, v_tenant_id, v_address,
          (v_tenant->>'lease_start')::date,
          (v_tenant->>'lease_end')::date,
          (v_tenant->>'rent')::numeric,
          COALESCE(NULLIF(v_tenant->>'security_deposit','')::numeric, 0),
          'active', 1
        ) RETURNING id INTO v_lease_id;
      END IF;
    END IF;
  END IF;

  -- ─── 4. UTILITIES — replace-all ──────────────────────────────────
  -- utilities has archived_at but not archived_by (unlike its siblings).
  IF v_mode = 'edit' THEN
    UPDATE utilities SET archived_at = now()
    WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL;
  END IF;
  FOR v_u IN SELECT * FROM jsonb_array_elements(v_utilities) LOOP
    IF COALESCE(trim(v_u->>'provider'),'') = '' THEN CONTINUE; END IF;
    v_day := LEAST(28, GREATEST(1, COALESCE(NULLIF(v_u->>'due_day','')::int, 1)));
    INSERT INTO utilities (
      company_id, property, provider, amount, due,
      responsibility, status, website,
      username_encrypted, password_encrypted,
      encryption_iv, encryption_iv_username, encryption_salt
    ) VALUES (
      v_company_id, v_address, v_u->>'provider', 0,
      make_date(
        extract(year from current_date)::int,
        extract(month from current_date)::int,
        v_day
      ),
      CASE WHEN v_u->>'responsibility' = 'owner_pays' THEN 'owner' ELSE 'tenant' END,
      'pending',
      COALESCE(v_u->>'website',''),
      v_u->>'username_encrypted', v_u->>'password_encrypted',
      v_u->>'encryption_iv', v_u->>'encryption_iv_username', v_u->>'encryption_salt'
    );
  END LOOP;

  IF v_mode = 'edit' THEN
    UPDATE hoa_payments SET archived_at = now(), archived_by = v_caller_email
    WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL;
  END IF;
  FOR v_h IN SELECT * FROM jsonb_array_elements(v_hoas) LOOP
    IF COALESCE(trim(v_h->>'hoa_name'),'') = '' THEN CONTINUE; END IF;
    v_day := LEAST(28, GREATEST(1, COALESCE(NULLIF(v_h->>'due_day','')::int, 1)));
    INSERT INTO hoa_payments (
      company_id, property, hoa_name, amount, due_date,
      frequency, status, notes, website,
      username_encrypted, password_encrypted,
      encryption_iv, encryption_iv_username, encryption_salt
    ) VALUES (
      v_company_id, v_address, v_h->>'hoa_name',
      (v_h->>'amount')::numeric,
      make_date(
        extract(year from current_date)::int,
        extract(month from current_date)::int,
        v_day
      ),
      COALESCE(v_h->>'frequency','Monthly'),
      'pending',
      COALESCE(v_h->>'notes',''),
      COALESCE(v_h->>'website',''),
      v_h->>'username_encrypted', v_h->>'password_encrypted',
      v_h->>'encryption_iv', v_h->>'encryption_iv_username', v_h->>'encryption_salt'
    );
  END LOOP;

  IF v_loan IS NOT NULL AND COALESCE((v_loan->>'enabled')::boolean, false) THEN
    SELECT id INTO v_existing_loan_id FROM property_loans
    WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL
    LIMIT 1;
    IF v_existing_loan_id IS NOT NULL THEN
      UPDATE property_loans SET
        lender_name = v_loan->>'lender_name',
        loan_type = COALESCE(v_loan->>'loan_type','Conventional'),
        original_amount = NULLIF(v_loan->>'original_amount','')::numeric,
        current_balance = NULLIF(v_loan->>'current_balance','')::numeric,
        interest_rate = NULLIF(v_loan->>'interest_rate','')::numeric,
        monthly_payment = NULLIF(v_loan->>'monthly_payment','')::numeric,
        escrow_included = COALESCE((v_loan->>'escrow_included')::boolean, false),
        escrow_amount = NULLIF(v_loan->>'escrow_amount','')::numeric,
        loan_start_date = NULLIF(v_loan->>'loan_start_date','')::date,
        maturity_date = NULLIF(v_loan->>'maturity_date','')::date,
        account_number_encrypted = v_loan->>'account_number_encrypted',
        account_number_iv = v_loan->>'account_number_iv',
        account_number_salt = v_loan->>'account_number_salt',
        username_encrypted = v_loan->>'username_encrypted',
        password_encrypted = v_loan->>'password_encrypted',
        encryption_iv_username = v_loan->>'encryption_iv_username',
        encryption_iv = v_loan->>'encryption_iv',
        encryption_salt = v_loan->>'encryption_salt',
        website = COALESCE(v_loan->>'website',''),
        notes = COALESCE(v_loan->>'notes','')
      WHERE id = v_existing_loan_id AND company_id = v_company_id;
    ELSE
      INSERT INTO property_loans (
        company_id, property, property_id, lender_name, loan_type,
        original_amount, current_balance, interest_rate, monthly_payment,
        escrow_included, escrow_amount, loan_start_date, maturity_date,
        account_number_encrypted, account_number_iv, account_number_salt,
        username_encrypted, password_encrypted,
        encryption_iv_username, encryption_iv, encryption_salt,
        website, notes
      ) VALUES (
        v_company_id, v_address, v_property_id::text,
        v_loan->>'lender_name',
        COALESCE(v_loan->>'loan_type','Conventional'),
        NULLIF(v_loan->>'original_amount','')::numeric,
        NULLIF(v_loan->>'current_balance','')::numeric,
        NULLIF(v_loan->>'interest_rate','')::numeric,
        NULLIF(v_loan->>'monthly_payment','')::numeric,
        COALESCE((v_loan->>'escrow_included')::boolean, false),
        NULLIF(v_loan->>'escrow_amount','')::numeric,
        NULLIF(v_loan->>'loan_start_date','')::date,
        NULLIF(v_loan->>'maturity_date','')::date,
        v_loan->>'account_number_encrypted',
        v_loan->>'account_number_iv',
        v_loan->>'account_number_salt',
        v_loan->>'username_encrypted', v_loan->>'password_encrypted',
        v_loan->>'encryption_iv_username', v_loan->>'encryption_iv',
        v_loan->>'encryption_salt',
        COALESCE(v_loan->>'website',''),
        COALESCE(v_loan->>'notes','')
      );
    END IF;

    IF NULLIF(v_loan->>'monthly_payment','')::numeric IS NOT NULL
       AND COALESCE((v_loan->>'setup_recurring')::boolean, false) THEN
      v_mortgage_id := _wizard_resolve_account(v_company_id, '5600');
      v_checking_id := _wizard_resolve_account(v_company_id, '1000');
      v_day := LEAST(28, GREATEST(1, COALESCE(NULLIF(v_loan->>'payment_day','')::int, 1)));
      v_next_post_date := make_date(
        extract(year from current_date)::int,
        extract(month from current_date)::int + 1,
        v_day
      );
      SELECT id INTO v_existing_mort_id FROM recurring_journal_entries
      WHERE company_id = v_company_id AND property = v_address
        AND status = 'active' AND archived_at IS NULL
        AND description LIKE 'Mortgage/Loan%'
      LIMIT 1;
      IF v_existing_mort_id IS NOT NULL THEN
        UPDATE recurring_journal_entries SET
          amount = (v_loan->>'monthly_payment')::numeric,
          day_of_month = v_day,
          debit_account_id = v_mortgage_id,
          credit_account_id = v_checking_id,
          next_post_date = v_next_post_date
        WHERE id = v_existing_mort_id AND company_id = v_company_id;
      ELSE
        INSERT INTO recurring_journal_entries (
          company_id, description, frequency, day_of_month, amount,
          property,
          debit_account_id, debit_account_name,
          credit_account_id, credit_account_name,
          status, next_post_date, created_by
        ) VALUES (
          v_company_id,
          'Mortgage/Loan Payment — ' || split_part(v_address, ',', 1),
          'monthly', v_day, (v_loan->>'monthly_payment')::numeric,
          v_address,
          v_mortgage_id, 'Mortgage/Loan Payment', v_checking_id, 'Checking Account',
          'active', v_next_post_date, v_caller_email
        );
      END IF;
    END IF;
  END IF;

  IF v_insurance IS NOT NULL AND COALESCE((v_insurance->>'enabled')::boolean, false) THEN
    SELECT id INTO v_existing_ins_id FROM property_insurance
    WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL
    LIMIT 1;
    IF v_existing_ins_id IS NOT NULL THEN
      UPDATE property_insurance SET
        provider = v_insurance->>'provider',
        policy_number = v_insurance->>'policy_number',
        premium_amount = NULLIF(v_insurance->>'premium_amount','')::numeric,
        premium_frequency = COALESCE(v_insurance->>'premium_frequency','annual'),
        coverage_amount = NULLIF(v_insurance->>'coverage_amount','')::numeric,
        expiration_date = NULLIF(v_insurance->>'expiration_date','')::date,
        notes = COALESCE(v_insurance->>'notes',''),
        website = COALESCE(v_insurance->>'website',''),
        username_encrypted = v_insurance->>'username_encrypted',
        password_encrypted = v_insurance->>'password_encrypted',
        encryption_iv_username = v_insurance->>'encryption_iv_username',
        encryption_iv = v_insurance->>'encryption_iv',
        encryption_salt = v_insurance->>'encryption_salt'
      WHERE id = v_existing_ins_id AND company_id = v_company_id;
    ELSE
      INSERT INTO property_insurance (
        company_id, property, property_id,
        provider, policy_number, premium_amount, premium_frequency,
        coverage_amount, expiration_date, notes, website,
        username_encrypted, password_encrypted,
        encryption_iv_username, encryption_iv, encryption_salt
      ) VALUES (
        v_company_id, v_address, v_property_id::text,
        v_insurance->>'provider', v_insurance->>'policy_number',
        NULLIF(v_insurance->>'premium_amount','')::numeric,
        COALESCE(v_insurance->>'premium_frequency','annual'),
        NULLIF(v_insurance->>'coverage_amount','')::numeric,
        NULLIF(v_insurance->>'expiration_date','')::date,
        COALESCE(v_insurance->>'notes',''),
        COALESCE(v_insurance->>'website',''),
        v_insurance->>'username_encrypted', v_insurance->>'password_encrypted',
        v_insurance->>'encryption_iv_username', v_insurance->>'encryption_iv',
        v_insurance->>'encryption_salt'
      );
    END IF;
  END IF;

  IF v_taxes IS NOT NULL AND COALESCE((v_taxes->>'enabled')::boolean, false) THEN
    SELECT id INTO v_existing_tax_id FROM property_taxes
    WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL
    LIMIT 1;
    IF v_existing_tax_id IS NOT NULL THEN
      UPDATE property_taxes SET
        parcel_id = NULLIF(v_taxes->>'parcel_id',''),
        assessed_value = NULLIF(v_taxes->>'assessed_value','')::numeric,
        tax_year = NULLIF(v_taxes->>'tax_year','')::int,
        annual_tax_amount = NULLIF(v_taxes->>'annual_tax_amount','')::numeric,
        billing_frequency = COALESCE(v_taxes->>'billing_frequency','semi_annual'),
        next_due_date = NULLIF(v_taxes->>'next_due_date','')::date,
        exemptions = NULLIF(v_taxes->>'exemptions',''),
        escrow_paid_by_lender = COALESCE((v_taxes->>'escrow_paid_by_lender')::boolean, false),
        records_url = NULLIF(v_taxes->>'records_url',''),
        notes = NULLIF(v_taxes->>'notes','')
      WHERE id = v_existing_tax_id AND company_id = v_company_id;
    ELSE
      INSERT INTO property_taxes (
        company_id, property, property_id,
        parcel_id, assessed_value, tax_year, annual_tax_amount,
        billing_frequency, next_due_date, exemptions,
        escrow_paid_by_lender, records_url, notes
      ) VALUES (
        v_company_id, v_address, v_property_id,
        NULLIF(v_taxes->>'parcel_id',''),
        NULLIF(v_taxes->>'assessed_value','')::numeric,
        NULLIF(v_taxes->>'tax_year','')::int,
        NULLIF(v_taxes->>'annual_tax_amount','')::numeric,
        COALESCE(v_taxes->>'billing_frequency','semi_annual'),
        NULLIF(v_taxes->>'next_due_date','')::date,
        NULLIF(v_taxes->>'exemptions',''),
        COALESCE((v_taxes->>'escrow_paid_by_lender')::boolean, false),
        NULLIF(v_taxes->>'records_url',''),
        NULLIF(v_taxes->>'notes','')
      );
    END IF;
  END IF;

  IF v_is_occupied AND v_tenant_id IS NOT NULL
     AND v_recurring IS NOT NULL AND NULLIF(v_recurring->>'amount','')::numeric IS NOT NULL THEN
    v_tenant_ar_id := _wizard_get_tenant_ar(v_company_id, v_tenant_name, v_tenant_id);
    v_revenue_id := _wizard_resolve_account(v_company_id, '4000');
    v_day := GREATEST(1, LEAST(31, COALESCE(NULLIF(v_recurring->>'day_of_month','')::int, 1)));
    -- Compute the default anchor: day_of_month of the month
    -- immediately after lease_start's calendar month.
    DECLARE
      v_default_next date := NULL;
      v_user_next    date := NULLIF(v_recurring->>'start_date','')::date;
    BEGIN
      IF NULLIF(v_tenant->>'lease_start','') IS NOT NULL THEN
        v_default_next :=
          (date_trunc('month', (v_tenant->>'lease_start')::date) +
           (CASE COALESCE(v_recurring->>'frequency','monthly')
             WHEN 'quarterly'   THEN '3 months'::interval
             WHEN 'semi-annual' THEN '6 months'::interval
             WHEN 'annual'      THEN '12 months'::interval
             ELSE '1 month'::interval
            END) +
           make_interval(days => v_day - 1)
          )::date;
      END IF;

      -- User's explicit start_date is respected only when it's AT OR
      -- AFTER the default — earlier would collide with the wizard's
      -- manual first-month post. Otherwise fall through to default,
      -- and finally to today+1m if lease_start was also missing.
      v_next_post_date := COALESCE(
        CASE
          WHEN v_user_next IS NOT NULL AND v_default_next IS NOT NULL
            THEN GREATEST(v_user_next, v_default_next)
          ELSE COALESCE(v_user_next, v_default_next)
        END,
        make_date(
          extract(year from current_date)::int,
          extract(month from current_date)::int + 1,
          v_day
        )
      );
    END;
    SELECT id INTO v_existing_recur_id FROM recurring_journal_entries
    WHERE company_id = v_company_id AND property = v_address
      AND status = 'active' AND archived_at IS NULL
      AND description LIKE 'Monthly rent%'
      AND COALESCE(tenant_name,'') = COALESCE(v_all_tenants,'')
    LIMIT 1;
    IF v_existing_recur_id IS NOT NULL THEN
      UPDATE recurring_journal_entries SET
        description = 'Monthly rent — ' || v_all_tenants || ' — ' || split_part(v_address, ',', 1),
        frequency = COALESCE(v_recurring->>'frequency','monthly'),
        day_of_month = v_day,
        amount = (v_recurring->>'amount')::numeric,
        tenant_name = v_all_tenants,
        tenant_id = v_tenant_id,
        debit_account_id = v_tenant_ar_id,
        debit_account_name = 'AR - ' || v_all_tenants,
        credit_account_id = v_revenue_id,
        credit_account_name = 'Rental Income',
        next_post_date = v_next_post_date
      WHERE id = v_existing_recur_id AND company_id = v_company_id;
    ELSE
      INSERT INTO recurring_journal_entries (
        company_id, description, frequency, day_of_month, amount,
        tenant_name, tenant_id, property,
        debit_account_id, debit_account_name,
        credit_account_id, credit_account_name,
        status, next_post_date, created_by
      ) VALUES (
        v_company_id,
        'Monthly rent — ' || v_all_tenants || ' — ' || split_part(v_address, ',', 1),
        COALESCE(v_recurring->>'frequency','monthly'),
        v_day,
        (v_recurring->>'amount')::numeric,
        v_all_tenants, v_tenant_id, v_address,
        v_tenant_ar_id, 'AR - ' || v_all_tenants,
        v_revenue_id, 'Rental Income',
        'active', v_next_post_date, v_caller_email
      );
    END IF;
  END IF;

  IF v_wizard_id IS NOT NULL THEN
    UPDATE property_setup_wizard SET
      property_address = v_address,
      property_id = v_property_id::text,
      status = 'completed',
      updated_at = now()
    WHERE id = v_wizard_id AND company_id = v_company_id;
  END IF;

  RETURN jsonb_build_object(
    'property_id', v_property_id,
    'tenant_id', v_tenant_id,
    'lease_id', v_lease_id,
    'class_id', v_class_id,
    'address', v_address
  );
END;
$_$;


--
-- Name: compute_property_address("text", "text", "text", "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."compute_property_address"("p_line1" "text", "p_line2" "text", "p_city" "text", "p_state" "text", "p_zip" "text") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
BEGIN
  RETURN TRIM(CONCAT_WS(', ',
    NULLIF(TRIM(COALESCE(p_line1, '')), ''),
    NULLIF(TRIM(COALESCE(p_line2, '')), ''),
    NULLIF(TRIM(COALESCE(p_city, '')), ''),
    NULLIF(TRIM(CONCAT_WS(' ', NULLIF(TRIM(COALESCE(p_state, '')), ''), NULLIF(TRIM(COALESCE(p_zip, '')), ''))), '')
  ));
END;
$$;


--
-- Name: create_company_atomic("text", "text", "text", "text", "text", "text", "text", "text", "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."create_company_atomic"("p_company_id" "text", "p_name" "text", "p_type" "text", "p_company_code" "text", "p_company_role" "text", "p_address" "text", "p_phone" "text", "p_email" "text", "p_creator_email" "text", "p_creator_name" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  INSERT INTO companies (id, name, type, company_code, company_role, address, phone, email)
  VALUES (p_company_id, p_name, p_type, p_company_code, p_company_role, p_address, p_phone, p_email);
  INSERT INTO company_members (company_id, user_email, role, status)
  VALUES (p_company_id, p_creator_email, 'admin', 'active');
END;
$$;


--
-- Name: create_doc_envelope("uuid", "jsonb"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."create_doc_envelope"("p_doc_id" "uuid", "p_signers" "jsonb") RETURNS TABLE("signer_id" "uuid", "signer_email" "text", "access_token" "text", "sign_order" integer, "status" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
DECLARE
  v_company_id text;
  v_template_id uuid;
  v_signing_mode text;
  v_user_email text;
  v_now timestamptz := now();
  v_expiry timestamptz := v_now + interval '30 days';
  v_doc_hash text;
  s jsonb;
  v_min_order int;
BEGIN
  v_user_email := auth.jwt() ->> 'email';
  IF v_user_email IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT d.company_id, d.template_id INTO v_company_id, v_template_id
  FROM doc_generated d WHERE d.id = p_doc_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'doc not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM company_members cm
    WHERE cm.company_id = v_company_id
      AND cm.user_email ILIKE v_user_email
      AND cm.status = 'active'
      AND cm.role IN ('admin','owner','pm','office_assistant')
  ) THEN
    RAISE EXCEPTION 'not authorized for this company';
  END IF;

  -- Snapshot the rendered body's hash NOW. This is what the signer
  -- will see displayed and what their signature commits to. Any
  -- later mutation of rendered_body will not change this hash, so
  -- a forensic reviewer can detect tampering by re-hashing the
  -- post-mutation body and comparing to doc_hash_at_send.
  SELECT encode(digest(COALESCE(d.rendered_body,''), 'sha256'), 'hex')
    INTO v_doc_hash
    FROM doc_generated d WHERE d.id = p_doc_id;

  SELECT COALESCE(t.signing_mode, 'parallel') INTO v_signing_mode
  FROM doc_templates t WHERE t.id = v_template_id;
  v_signing_mode := COALESCE(v_signing_mode, 'parallel');
  IF v_signing_mode = 'none' THEN v_signing_mode := 'parallel'; END IF;

  DELETE FROM doc_signatures
  WHERE doc_id = p_doc_id AND status IN ('pending','sent','viewed');

  FOR s IN SELECT * FROM jsonb_array_elements(p_signers) LOOP
    INSERT INTO doc_signatures (
      company_id, doc_id, signer_role, signer_name, signer_email,
      sign_order, status, access_token, token_expires_at, sent_at
    ) VALUES (
      v_company_id, p_doc_id,
      COALESCE(s->>'role', 'signer'),
      s->>'name',
      lower(s->>'email'),
      COALESCE((s->>'order')::int, 1),
      'pending',
      _gen_signing_token(),
      v_expiry,
      v_now
    );
  END LOOP;

  IF v_signing_mode = 'sequential' THEN
    SELECT MIN(ds.sign_order) INTO v_min_order
      FROM doc_signatures ds
      WHERE ds.doc_id = p_doc_id AND ds.status = 'pending';
    UPDATE doc_signatures
      SET status = 'sent'
      WHERE doc_id = p_doc_id AND status = 'pending' AND sign_order = v_min_order;
  ELSE
    UPDATE doc_signatures
      SET status = 'sent'
      WHERE doc_id = p_doc_id AND status = 'pending';
  END IF;

  UPDATE doc_generated
    SET envelope_status = 'out_for_signature',
        envelope_sent_at = v_now,
        doc_hash_at_send = v_doc_hash
  WHERE id = p_doc_id;

  RETURN QUERY
    SELECT ds.id, ds.signer_email, ds.access_token, ds.sign_order, ds.status
    FROM doc_signatures ds
    WHERE ds.doc_id = p_doc_id
    ORDER BY ds.sign_order, ds.created_at;
END; $$;


--
-- Name: delete_property_cascade("text", "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."delete_property_cascade"("p_company_id" "text", "p_property_id" "text", "p_address" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_prop_id INT;
BEGIN
  v_prop_id := p_property_id::INT;

  -- Cascade delete all related records (atomic)
  -- Delete work_orders by BOTH address and property_id FK
  DELETE FROM work_orders WHERE company_id = p_company_id AND (property = p_address OR property_id = v_prop_id);
  DELETE FROM autopay_schedules WHERE company_id = p_company_id AND property = p_address;
  DELETE FROM utilities WHERE company_id = p_company_id AND property = p_address;
  DELETE FROM hoa_payments WHERE company_id = p_company_id AND property = p_address;
  DELETE FROM ledger_entries WHERE company_id = p_company_id AND property = p_address;
  DELETE FROM documents WHERE company_id = p_company_id AND property = p_address;
  
  -- Also clear any other FK references to this property
  UPDATE tenants SET property = '' WHERE company_id = p_company_id AND property = p_address;
  DELETE FROM leases WHERE company_id = p_company_id AND property = p_address;
  
  -- Now safe to delete the property itself
  DELETE FROM properties WHERE company_id = p_company_id AND id = v_prop_id;

  RETURN jsonb_build_object('success', true);
END;
$$;


--
-- Name: delete_tenant_cascade("text", integer, "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."delete_tenant_cascade"("p_company_id" "text", "p_tenant_id" integer, "p_tenant_name" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  IF NOT has_write_access(p_company_id) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  DELETE FROM ledger_entries WHERE company_id = p_company_id AND tenant = p_tenant_name;
  DELETE FROM messages WHERE company_id = p_company_id AND tenant = p_tenant_name;
  DELETE FROM payments WHERE company_id = p_company_id AND tenant = p_tenant_name;
  DELETE FROM work_orders WHERE company_id = p_company_id AND tenant = p_tenant_name;
  DELETE FROM autopay_schedules WHERE company_id = p_company_id AND tenant = p_tenant_name;
  DELETE FROM tenants WHERE company_id = p_company_id AND id = p_tenant_id;

  RETURN jsonb_build_object('success', true);
END;
$$;


--
-- Name: find_unbalanced_jes("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."find_unbalanced_jes"("p_company_id" "text") RETURNS TABLE("id" "text", "number" "text", "difference" numeric, "date" "date")
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    je.id,
    je.number,
    ABS(COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0))::numeric AS difference,
    MAX(je.date) AS date
  FROM acct_journal_entries je
  LEFT JOIN acct_journal_lines jl ON jl.journal_entry_id = je.id
  WHERE je.company_id = p_company_id
    AND je.status = 'posted'
  GROUP BY je.id, je.number
  HAVING ABS(COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)) > 0.01
  ORDER BY MAX(je.date) DESC
  LIMIT 50;
END;
$$;


--
-- Name: get_owner_id("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."get_owner_id"("p_company_id" "text") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  SELECT o.id FROM owners o
  JOIN company_members cm ON cm.company_id = o.company_id AND lower(cm.user_email) = lower(o.email)
  WHERE cm.company_id = p_company_id
  AND (cm.auth_user_id = auth.uid() OR lower(cm.user_email) = lower(auth.email()))
  AND cm.status = 'active' AND cm.role = 'owner'
  LIMIT 1;
$$;


--
-- Name: get_signature_by_token("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."get_signature_by_token"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_sig doc_signatures%ROWTYPE;
  v_doc doc_generated%ROWTYPE;
  v_company_name text;
  v_company_email text;
BEGIN
  IF p_token IS NULL OR length(p_token) < 20 THEN
    RETURN jsonb_build_object('error','invalid token');
  END IF;

  SELECT * INTO v_sig FROM doc_signatures WHERE access_token = p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','token not found'); END IF;
  IF v_sig.token_expires_at < now() THEN RETURN jsonb_build_object('error','token expired'); END IF;
  IF v_sig.status NOT IN ('sent','viewed') THEN
    RETURN jsonb_build_object('error','not available','status', v_sig.status,'signed_at', v_sig.signed_at);
  END IF;

  SELECT * INTO v_doc FROM doc_generated WHERE id = v_sig.doc_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','doc not found'); END IF;

  SELECT name, email INTO v_company_name, v_company_email
    FROM companies WHERE id = v_doc.company_id;

  IF v_sig.status = 'sent' THEN
    UPDATE doc_signatures SET status = 'viewed', viewed_at = now()
      WHERE id = v_sig.id;
    v_sig.status := 'viewed';
    v_sig.viewed_at := now();
  END IF;

  RETURN jsonb_build_object(
    'signer_id', v_sig.id,
    'signer_role', v_sig.signer_role,
    'signer_name', v_sig.signer_name,
    'signer_email', v_sig.signer_email,
    'status', v_sig.status,
    'sign_order', v_sig.sign_order,
    'doc_id', v_doc.id,
    'doc_name', v_doc.name,
    'doc_body', v_doc.rendered_body,
    'doc_hash_at_send', v_doc.doc_hash_at_send,
    'doc_property_address', v_doc.property_address,
    'doc_tenant_name', v_doc.tenant_name,
    'company_name', v_company_name,
    'company_contact_email', v_company_email,
    'expires_at', v_sig.token_expires_at
  );
END; $$;


--
-- Name: is_company_staff("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."is_company_staff"("p_company_id" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM company_members
    WHERE company_id = p_company_id
    AND (auth_user_id = auth.uid() OR lower(user_email) = lower(auth.email()))
    AND status = 'active'
    AND role NOT IN ('tenant', 'owner')
  );
$$;


SET default_tablespace = '';

SET default_table_access_method = "heap";

--
-- Name: acct_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."acct_accounts" (
    "old_text_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "type" "text" NOT NULL,
    "subtype" "text",
    "description" "text" DEFAULT ''::"text",
    "balance" numeric DEFAULT 0,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "code" "text",
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "parent_id" "uuid",
    "tenant_id" bigint
);


--
-- Name: acct_journal_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."acct_journal_entries" (
    "id" "text" DEFAULT "gen_random_uuid"() NOT NULL,
    "number" "text" NOT NULL,
    "date" "date" NOT NULL,
    "description" "text" NOT NULL,
    "reference" "text" DEFAULT ''::"text",
    "status" "text" DEFAULT 'draft'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "property" "text" DEFAULT ''::"text",
    "stripe_payment_intent_id" "text",
    "transaction_type" "text"
);


--
-- Name: acct_journal_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."acct_journal_lines" (
    "id" integer NOT NULL,
    "journal_entry_id" "text" NOT NULL,
    "old_account_id" "text",
    "account_name" "text" NOT NULL,
    "debit" numeric DEFAULT 0,
    "credit" numeric DEFAULT 0,
    "class_id" "text",
    "memo" "text" DEFAULT ''::"text",
    "reconciled" boolean DEFAULT false,
    "reconciled_date" "date",
    "account_id" "uuid",
    "company_id" "text",
    "bank_feed_transaction_id" "uuid",
    "entity_type" "text",
    "entity_id" "uuid",
    "entity_name" "text",
    CONSTRAINT "chk_entity_type" CHECK ((("entity_type" IS NULL) OR ("entity_type" = ANY (ARRAY['customer'::"text", 'vendor'::"text"]))))
);


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."tenants" (
    "id" integer NOT NULL,
    "name" "text" NOT NULL,
    "email" "text",
    "phone" "text",
    "property" "text",
    "balance" numeric DEFAULT 0,
    "lease_status" "text" DEFAULT 'active'::"text",
    "move_in" "date",
    "move_out" "date",
    "rent" numeric(10,2) DEFAULT 0,
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "property_id" integer,
    "lease_start" "date",
    "lease_end_date" "date",
    "archived_at" timestamp with time zone,
    "archived_by" "text",
    "doc_status" "text" DEFAULT 'pending_docs'::"text",
    "first_name" "text" DEFAULT ''::"text",
    "middle_initial" "text" DEFAULT ''::"text",
    "last_name" "text" DEFAULT ''::"text",
    "late_fee_amount" numeric DEFAULT 0,
    "late_fee_type" "text" DEFAULT 'flat'::"text",
    "is_voucher" boolean DEFAULT false,
    "voucher_number" "text",
    "reexam_date" "date",
    "case_manager_name" "text",
    "case_manager_email" "text",
    "case_manager_phone" "text",
    "voucher_portion" numeric DEFAULT 0,
    "tenant_portion" numeric DEFAULT 0,
    "approved_doc_exceptions" "jsonb" DEFAULT '[]'::"jsonb",
    "stripe_customer_id" "text",
    CONSTRAINT "chk_tenant_late_fee_type" CHECK ((("late_fee_type" IS NULL) OR ("late_fee_type" = ANY (ARRAY['flat'::"text", 'percent'::"text"]))))
);


--
-- Name: ledger_entries; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW "public"."ledger_entries" AS
 SELECT "jl"."id",
    "jl"."company_id",
    "t"."name" AS "tenant",
    "a"."tenant_id",
    COALESCE("je"."property", ''::"text") AS "property",
    NULL::bigint AS "property_id",
    (("je"."date")::"text")::"date" AS "date",
    COALESCE("je"."description", ''::"text") AS "description",
    (COALESCE("jl"."debit", (0)::numeric) + COALESCE("jl"."credit", (0)::numeric)) AS "amount",
    COALESCE("je"."transaction_type",
        CASE
            WHEN (COALESCE("jl"."debit", (0)::numeric) > (0)::numeric) THEN 'charge'::"text"
            ELSE 'payment'::"text"
        END) AS "type",
    "sum"(
        CASE
            WHEN (COALESCE("je"."transaction_type",
            CASE
                WHEN (COALESCE("jl"."debit", (0)::numeric) > (0)::numeric) THEN 'charge'::"text"
                ELSE 'payment'::"text"
            END) = ANY (ARRAY['charge'::"text", 'late_fee'::"text", 'expense'::"text", 'deposit_deduction'::"text", 'deposit'::"text"])) THEN (COALESCE("jl"."debit", (0)::numeric) + COALESCE("jl"."credit", (0)::numeric))
            WHEN (COALESCE("je"."transaction_type",
            CASE
                WHEN (COALESCE("jl"."debit", (0)::numeric) > (0)::numeric) THEN 'charge'::"text"
                ELSE 'payment'::"text"
            END) = ANY (ARRAY['payment'::"text", 'credit'::"text", 'deposit_return'::"text", 'void'::"text"])) THEN (- (COALESCE("jl"."debit", (0)::numeric) + COALESCE("jl"."credit", (0)::numeric)))
            ELSE (COALESCE("jl"."debit", (0)::numeric) + COALESCE("jl"."credit", (0)::numeric))
        END) OVER (PARTITION BY "a"."tenant_id" ORDER BY (("je"."date")::"text")::"date", "je"."created_at", "jl"."id" ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "balance",
    "je"."id" AS "journal_entry_id",
    "je"."created_at"
   FROM ((("public"."acct_journal_lines" "jl"
     JOIN "public"."acct_journal_entries" "je" ON (("je"."id" = "jl"."journal_entry_id")))
     JOIN "public"."acct_accounts" "a" ON (("a"."id" = "jl"."account_id")))
     JOIN "public"."tenants" "t" ON (("t"."id" = "a"."tenant_id")))
  WHERE (("a"."tenant_id" IS NOT NULL) AND ("je"."status" = 'posted'::"text") AND ("public"."is_company_staff"("jl"."company_id") OR ("lower"("t"."email") = "lower"("auth"."email"())) OR (COALESCE(("auth"."jwt"() ->> 'role'::"text"), ''::"text") = 'service_role'::"text")));


--
-- Name: get_tenant_ledger("text", bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."get_tenant_ledger"("p_company_id" "text", "p_tenant_id" bigint) RETURNS SETOF "public"."ledger_entries"
    LANGUAGE "sql" STABLE
    AS $$
  SELECT * FROM ledger_entries
  WHERE company_id = p_company_id AND tenant_id = p_tenant_id
  ORDER BY date DESC, created_at DESC;
$$;


--
-- Name: get_tenant_name("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."get_tenant_name"("p_company_id" "text") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  SELECT t.name FROM tenants t
  JOIN company_members cm ON cm.company_id = t.company_id AND lower(cm.user_email) = lower(t.email)
  WHERE cm.company_id = p_company_id
  AND (cm.auth_user_id = auth.uid() OR lower(cm.user_email) = lower(auth.email()))
  AND cm.status = 'active' AND cm.role = 'tenant' AND t.archived_at IS NULL
  LIMIT 1;
$$;


--
-- Name: get_user_company_ids(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."get_user_company_ids"() RETURNS SETOF "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  RETURN QUERY
  SELECT company_id FROM company_members
  WHERE LOWER(user_email) = LOWER(auth.jwt()->>'email')
    AND status = 'active'
    AND role NOT IN ('tenant', 'owner');
END;
$$;


--
-- Name: handle_membership_request(bigint, "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."handle_membership_request"("p_member_id" bigint, "p_action" "text", "p_role" "text" DEFAULT 'tenant'::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


--
-- Name: handle_membership_request("text", "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."handle_membership_request"("p_company_id" "text", "p_member_id" "text", "p_action" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_caller_email TEXT;
  v_member RECORD;
  v_new_status TEXT;
BEGIN
  -- Verify caller is authenticated admin of this company
  v_caller_email := LOWER(auth.jwt()->>'email');
  IF NOT EXISTS (
    SELECT 1 FROM company_members
    WHERE company_id = p_company_id
    AND LOWER(user_email) = v_caller_email
    AND status = 'active'
    AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only admins can approve or reject membership requests';
  END IF;
  
  -- Validate the action
  IF p_action NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'Invalid action: must be approve or reject';
  END IF;
  
  v_new_status := CASE WHEN p_action = 'approve' THEN 'active' ELSE 'rejected' END;
  
  -- Fetch the member to verify it exists and is pending
  SELECT * INTO v_member FROM company_members
    WHERE company_id = p_company_id AND id = p_member_id::int;
  
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'Member not found';
  END IF;
  
  IF v_member.status != 'pending' THEN
    RAISE EXCEPTION 'Request is not pending (current status: %)', v_member.status;
  END IF;
  
  -- Update status
  UPDATE company_members SET status = v_new_status
    WHERE company_id = p_company_id AND id = p_member_id::int;
  
  RETURN jsonb_build_object(
    'success', true,
    'action', p_action,
    'user_email', v_member.user_email,
    'user_name', v_member.user_name
  );
END;
$$;


--
-- Name: hard_delete_company("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."hard_delete_company"("p_company_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $_$
DECLARE
  v_caller_email text;
  v_caller_role text;
  v_table record;
  v_deleted bigint;
  v_total bigint := 0;
  v_per_table jsonb := '{}'::jsonb;
BEGIN
  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';

  SELECT role INTO v_caller_role
  FROM company_members
  WHERE company_id = p_company_id
    AND lower(user_email) = lower(v_caller_email)
    AND status = 'active';

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Unauthorized: only admins/owners can hard-delete a company';
  END IF;

  -- Pass 1: every table with a company_id column, except companies itself
  -- (handled at the end) and company_members (needs to stay until we've
  -- finished the caller's authorization check above — but we can delete
  -- it in this loop since we already captured the caller's role).
  FOR v_table IN
    SELECT c.table_schema, c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'company_id'
      AND c.table_name NOT IN ('companies')
    ORDER BY c.table_name
  LOOP
    EXECUTE format(
      'DELETE FROM %I.%I WHERE company_id = $1',
      v_table.table_schema, v_table.table_name
    ) USING p_company_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted > 0 THEN
      v_per_table := v_per_table || jsonb_build_object(v_table.table_name, v_deleted);
      v_total := v_total + v_deleted;
    END IF;
  END LOOP;

  -- Finally, the company row itself.
  DELETE FROM companies WHERE id = p_company_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted = 0 THEN
    RAISE EXCEPTION 'Company % not found or already deleted', p_company_id;
  END IF;
  v_per_table := v_per_table || jsonb_build_object('companies', v_deleted);
  v_total := v_total + v_deleted;

  RETURN jsonb_build_object(
    'company_id', p_company_id,
    'total_rows_deleted', v_total,
    'per_table', v_per_table
  );
END;
$_$;


--
-- Name: has_write_access("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."has_write_access"("p_company_id" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  RETURN EXISTS(
    SELECT 1 FROM company_members
    WHERE company_id = p_company_id
    AND LOWER(user_email) = LOWER(auth.jwt()->>'email')
    AND status = 'active'
    AND role IN ('admin', 'office_assistant', 'accountant', 'maintenance')
  );
END;
$$;


--
-- Name: increment_rule_stats("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."increment_rule_stats"("rule_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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
$$;


--
-- Name: increment_vendor_totals(bigint, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."increment_vendor_totals"("p_vendor_id" bigint, "p_amount" numeric) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


--
-- Name: increment_vendor_totals("text", "text", numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."increment_vendor_totals"("p_company_id" "text", "p_vendor_id" "text", "p_amount" numeric) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  UPDATE vendors SET 
    total_paid = COALESCE(total_paid, 0) + p_amount,
    total_jobs = COALESCE(total_jobs, 0) + 1
  WHERE company_id = p_company_id AND id = p_vendor_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor not found';
  END IF;
  
  RETURN jsonb_build_object('success', true);
END;
$$;


--
-- Name: insert_ledger_entry_with_balance("text", "text", bigint, "text", "text", "text", numeric, "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."insert_ledger_entry_with_balance"("p_company_id" "text", "p_tenant" "text" DEFAULT NULL::"text", "p_tenant_id" bigint DEFAULT NULL::bigint, "p_property" "text" DEFAULT NULL::"text", "p_date" "text" DEFAULT NULL::"text", "p_description" "text" DEFAULT NULL::"text", "p_amount" numeric DEFAULT 0, "p_type" "text" DEFAULT NULL::"text") RETURNS bigint
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- ledger_entries is now a view — there's nothing to insert into.
  -- The legacy callers haven't been removed from the JS yet but
  -- their writes are redundant (the JE on the AR account that
  -- preceded this call already determines the row in the view).
  RETURN NULL;
END;
$$;


--
-- Name: is_company_admin("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."is_company_admin"("p_company_id" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  RETURN EXISTS(
    SELECT 1 FROM company_members
    WHERE company_id = p_company_id
    AND LOWER(user_email) = LOWER(auth.jwt()->>'email')
    AND status = 'active'
    AND role = 'admin'
  );
END;
$$;


--
-- Name: is_company_member("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."is_company_member"("p_company_id" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM company_members
    WHERE company_id = p_company_id
    AND (auth_user_id = auth.uid() OR lower(user_email) = lower(auth.email()))
    AND status = 'active'
  );
$$;


--
-- Name: is_member_of_company("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."is_member_of_company"("p_company_id" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM company_members
    WHERE company_id = p_company_id
    AND lower(user_email) = lower(current_setting('request.jwt.claims', true)::json->>'email')
    AND status = 'active'
  )
$$;


--
-- Name: move_out_commit_state("text", "uuid", bigint, "text", "text", "date", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."move_out_commit_state"("p_company_id" "text", "p_lease_id" "uuid", "p_tenant_id" bigint, "p_tenant_name" "text", "p_property" "text", "p_move_out_date" "date", "p_archived_by" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_lease_rows    integer := 0;
  v_tenant_rows   integer := 0;
  v_property_rows integer := 0;
  v_autopay_rows  integer := 0;
  v_recur_rows    integer := 0;
BEGIN
  IF p_company_id IS NULL OR p_company_id = '' THEN
    RAISE EXCEPTION 'company_id required';
  END IF;
  IF p_lease_id IS NULL THEN
    RAISE EXCEPTION 'lease_id required';
  END IF;
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id required';
  END IF;
  IF p_property IS NULL OR p_property = '' THEN
    RAISE EXCEPTION 'property required';
  END IF;
  IF p_move_out_date IS NULL THEN
    RAISE EXCEPTION 'move_out_date required';
  END IF;

  -- 1. Terminate lease
  UPDATE leases
     SET status = 'terminated',
         end_date = p_move_out_date
   WHERE id = p_lease_id
     AND company_id = p_company_id;
  GET DIAGNOSTICS v_lease_rows = ROW_COUNT;
  IF v_lease_rows = 0 THEN
    RAISE EXCEPTION 'lease not found or not owned by company';
  END IF;

  -- 2. Archive tenant
  UPDATE tenants
     SET lease_status = 'inactive',
         move_out = p_move_out_date,
         archived_at = now(),
         archived_by = COALESCE(p_archived_by, 'system')
   WHERE id = p_tenant_id
     AND company_id = p_company_id;
  GET DIAGNOSTICS v_tenant_rows = ROW_COUNT;
  IF v_tenant_rows = 0 THEN
    RAISE EXCEPTION 'tenant not found or not owned by company';
  END IF;

  -- 3. Property → vacant (primary tenant cleared + lease_end nulled)
  UPDATE properties
     SET status = 'vacant',
         tenant = '',
         lease_end = NULL
   WHERE company_id = p_company_id
     AND address = p_property;
  GET DIAGNOSTICS v_property_rows = ROW_COUNT;

  -- 4. Deactivate this tenant's autopay on this property.
  --    Scoped by tenant name to avoid disabling a same-named tenant
  --    at a different property; also scoped by property so a tenant
  --    moving out of Address A doesn't stop their autopay at Address B.
  UPDATE autopay_schedules
     SET active = false
   WHERE company_id = p_company_id
     AND tenant = p_tenant_name
     AND property = p_property;
  GET DIAGNOSTICS v_autopay_rows = ROW_COUNT;

  -- 5. Deactivate rent-style recurring for THIS tenant only.
  --    Mortgage / HOA / other property-level recurrings have a
  --    null/empty tenant_name and stay untouched.
  UPDATE recurring_journal_entries
     SET status = 'inactive',
         archived_at = now()
   WHERE company_id = p_company_id
     AND property = p_property
     AND tenant_name = p_tenant_name
     AND status = 'active';
  GET DIAGNOSTICS v_recur_rows = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok',           true,
    'lease_rows',   v_lease_rows,
    'tenant_rows',  v_tenant_rows,
    'property_rows', v_property_rows,
    'autopay_rows', v_autopay_rows,
    'recur_rows',   v_recur_rows
  );
END;
$$;


--
-- Name: next_je_number("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."next_je_number"("p_company_id" "text") RETURNS "text"
    LANGUAGE "sql" STABLE
    AS $_$
  SELECT 'JE-' || lpad(
    (COALESCE(
      (SELECT MAX(CAST(SUBSTRING(number FROM 'JE-(\d+)$') AS BIGINT))
       FROM acct_journal_entries
       WHERE company_id = p_company_id
         AND number ~ '^JE-\d+$'),
      0
    ) + 1)::text,
    4, '0'
  );
$_$;


--
-- Name: next_journal_number("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."next_journal_number"("p_company_id" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(REPLACE(number, 'JE-', '') AS INTEGER)), 0) + 1
  INTO next_num
  FROM acct_journal_entries
  WHERE company_id = p_company_id;
  RETURN 'JE-' || LPAD(next_num::TEXT, 4, '0');
END;
$$;


--
-- Name: post_je_and_ledger("text", "text", "text", "text", "text", "text", "jsonb", "text", bigint, "text", numeric, "text", "text", numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."post_je_and_ledger"("p_company_id" "text", "p_date" "text", "p_description" "text", "p_reference" "text" DEFAULT ''::"text", "p_property" "text" DEFAULT ''::"text", "p_status" "text" DEFAULT 'posted'::"text", "p_lines" "jsonb" DEFAULT '[]'::"jsonb", "p_ledger_tenant" "text" DEFAULT NULL::"text", "p_ledger_tenant_id" bigint DEFAULT NULL::bigint, "p_ledger_property" "text" DEFAULT NULL::"text", "p_ledger_amount" numeric DEFAULT 0, "p_ledger_type" "text" DEFAULT NULL::"text", "p_ledger_description" "text" DEFAULT NULL::"text", "p_balance_change" numeric DEFAULT 0) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE v_je_id uuid; v_je_number text; v_attempt int := 0; v_line jsonb;
BEGIN
  LOOP
    v_je_number := next_je_number(p_company_id);
    BEGIN
      INSERT INTO acct_journal_entries (company_id, number, date, description, reference, property, status, transaction_type)
      VALUES (p_company_id, v_je_number, p_date::date, p_description, p_reference, p_property, p_status, COALESCE(p_ledger_type, 'charge'))
      RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_attempt := v_attempt + 1;
      IF v_attempt >= 5 THEN RAISE EXCEPTION 'Could not generate unique JE number after 5 attempts'; END IF;
    END;
  END LOOP;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO acct_journal_lines (journal_entry_id, company_id, account_id, account_name, debit, credit, class_id, memo)
    VALUES (v_je_id, p_company_id, (v_line->>'account_id')::uuid, COALESCE(v_line->>'account_name', ''),
      COALESCE((v_line->>'debit')::numeric, 0), COALESCE((v_line->>'credit')::numeric, 0),
      NULLIF(v_line->>'class_id', ''), COALESCE(v_line->>'memo', ''));
  END LOOP;
  RETURN v_je_id;
END;
$$;


--
-- Name: prevent_signature_tampering(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."prevent_signature_tampering"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Allow updates from our RPC (which sets verified_server_side = true)
  IF NEW.verified_server_side = true AND OLD.status = 'pending' THEN
    RETURN NEW;
  END IF;
  
  -- Block any update to an already-signed row
  IF OLD.status = 'signed' THEN
    RAISE EXCEPTION 'Cannot modify a signed signature record';
  END IF;
  
  RETURN NEW;
END;
$$;


--
-- Name: property_licenses_touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."property_licenses_touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


--
-- Name: property_tax_bills_touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."property_tax_bills_touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


--
-- Name: purge_old_archives(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."purge_old_archives"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_cutoff TIMESTAMPTZ := NOW() - INTERVAL '180 days';
  v_total INT := 0;
  v_count INT;
BEGIN
  DELETE FROM work_orders WHERE archived_at IS NOT NULL AND archived_at < v_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_total := v_total + v_count;
  DELETE FROM autopay_schedules WHERE archived_at IS NOT NULL AND archived_at < v_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_total := v_total + v_count;
  DELETE FROM utilities WHERE archived_at IS NOT NULL AND archived_at < v_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_total := v_total + v_count;
  DELETE FROM hoa_payments WHERE archived_at IS NOT NULL AND archived_at < v_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_total := v_total + v_count;
  DELETE FROM documents WHERE archived_at IS NOT NULL AND archived_at < v_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_total := v_total + v_count;
  DELETE FROM payments WHERE archived_at IS NOT NULL AND archived_at < v_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_total := v_total + v_count;
  DELETE FROM leases WHERE archived_at IS NOT NULL AND archived_at < v_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_total := v_total + v_count;
  DELETE FROM tenants WHERE archived_at IS NOT NULL AND archived_at < v_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_total := v_total + v_count;
  -- Properties last (FK dependencies)
  DELETE FROM properties WHERE archived_at IS NOT NULL AND archived_at < v_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_total := v_total + v_count;
  RETURN jsonb_build_object('purged', v_total, 'cutoff', v_cutoff);
END;
$$;


--
-- Name: recompute_tenant_balance(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."recompute_tenant_balance"("p_tenant_id" bigint) RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_balance numeric;
BEGIN
  IF p_tenant_id IS NULL THEN
    RETURN;
  END IF;
  SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)
  INTO v_balance
  FROM acct_journal_lines jl
  JOIN acct_journal_entries je ON je.id = jl.journal_entry_id
  JOIN acct_accounts a ON a.id = jl.account_id
  WHERE a.tenant_id = p_tenant_id
    AND je.status = 'posted';
  UPDATE tenants SET balance = v_balance WHERE id = p_tenant_id;
END;
$$;


--
-- Name: recompute_tenant_balances_bulk("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."recompute_tenant_balances_bulk"("p_company_id" "text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_updated integer := 0;
BEGIN
  IF p_company_id IS NULL OR p_company_id = '' THEN
    RAISE EXCEPTION 'company_id is required';
  END IF;

  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role'
     AND NOT is_company_staff(p_company_id) THEN
    RAISE EXCEPTION 'not authorized for company %', p_company_id;
  END IF;

  -- Body of recompute_tenant_balance(bigint) run once per tenant, so the
  -- result is identical to what the per-row trigger would produce. The
  -- inner sum is deliberately NOT company-scoped, matching the original.
  WITH tenant_ids AS (
    SELECT DISTINCT a.tenant_id
      FROM acct_accounts a
     WHERE a.company_id = p_company_id
       AND a.tenant_id IS NOT NULL
  ), balances AS (
    SELECT ti.tenant_id,
           COALESCE((
             SELECT SUM(jl.debit) - SUM(jl.credit)
               FROM acct_journal_lines jl
               JOIN acct_journal_entries je ON je.id = jl.journal_entry_id
               JOIN acct_accounts a         ON a.id  = jl.account_id
              WHERE a.tenant_id = ti.tenant_id
                AND je.status = 'posted'
           ), 0) AS bal
      FROM tenant_ids ti
  )
  UPDATE tenants t
     SET balance = b.bal
    FROM balances b
   WHERE t.id = b.tenant_id
     AND t.company_id = p_company_id
     AND t.balance IS DISTINCT FROM b.bal;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;


--
-- Name: FUNCTION "recompute_tenant_balances_bulk"("p_company_id" "text"); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION "public"."recompute_tenant_balances_bulk"("p_company_id" "text") IS 'Recompute tenants.balance for every tenant in a company in one pass. Used after a bulk ledger import that ran with sync_tenant_balance_lines disabled.';


--
-- Name: redeem_invite_code("text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."redeem_invite_code"("p_code" "text", "p_user_email" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  UPDATE tenant_invite_codes SET redeemed_at = now(), redeemed_by = p_user_email WHERE code = p_code AND redeemed_at IS NULL;
END;
$$;


--
-- Name: redeem_invite_code("text", "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."redeem_invite_code"("p_code" "text", "p_email" "text", "p_name" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_code_row RECORD;
BEGIN
  -- Lock and fetch the code row atomically
  SELECT * INTO v_code_row
  FROM tenant_invite_codes
  WHERE code = UPPER(p_code) AND used = false
  FOR UPDATE SKIP LOCKED;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid or expired invite code');
  END IF;
  
  -- Mark as used
  UPDATE tenant_invite_codes
  SET used = true, used_by = LOWER(p_email), used_at = NOW()
  WHERE id = v_code_row.id;
  
  -- Create company_members entry
  INSERT INTO company_members (company_id, user_email, user_name, role, status, invited_by)
  VALUES (v_code_row.company_id, LOWER(p_email), p_name, 'tenant', 'active', v_code_row.created_by)
  ON CONFLICT (company_id, user_email) DO UPDATE SET status = 'active', role = 'tenant';
  
  -- Update tenant email if tenant_id exists
  IF v_code_row.tenant_id IS NOT NULL THEN
    UPDATE tenants SET email = LOWER(p_email) WHERE id = v_code_row.tenant_id;
  END IF;
  
  -- Create app_users entry (SECURITY DEFINER bypasses RLS — works even pre-auth)
  INSERT INTO app_users (email, name, role, user_type, company_id)
  VALUES (LOWER(p_email), p_name, 'tenant', 'tenant', v_code_row.company_id)
  ON CONFLICT (email) DO UPDATE SET role = 'tenant', user_type = 'tenant', company_id = v_code_row.company_id;
  
  RETURN jsonb_build_object(
    'success', true,
    'company_id', v_code_row.company_id,
    'property', v_code_row.property,
    'tenant_id', v_code_row.tenant_id
  );
END;
$$;


--
-- Name: rename_property_cascade("text", "text", "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."rename_property_cascade"("p_company_id" "text", "p_property_id" "text", "p_old_address" "text", "p_new_address" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  IF NOT has_write_access(p_company_id) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  UPDATE tenants SET property = p_new_address WHERE company_id = p_company_id AND property = p_old_address;
  UPDATE payments SET property = p_new_address WHERE company_id = p_company_id AND property = p_old_address;
  UPDATE ledger_entries SET property = p_new_address WHERE company_id = p_company_id AND property = p_old_address;
  UPDATE work_orders SET property = p_new_address WHERE company_id = p_company_id AND property = p_old_address;
  UPDATE utilities SET property = p_new_address WHERE company_id = p_company_id AND property = p_old_address;
  UPDATE autopay_schedules SET property = p_new_address WHERE company_id = p_company_id AND property = p_old_address;
  UPDATE documents SET property = p_new_address WHERE company_id = p_company_id AND property = p_old_address;
  UPDATE hoa_payments SET property = p_new_address WHERE company_id = p_company_id AND property = p_old_address;
  UPDATE leases SET property = p_new_address WHERE company_id = p_company_id AND property = p_old_address;
  UPDATE acct_classes SET name = p_new_address WHERE company_id = p_company_id AND name = p_old_address;

  RETURN jsonb_build_object('success', true, 'tables_updated', 10);
END;
$$;


--
-- Name: rename_property_v2("text", bigint, "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."rename_property_v2"("p_company_id" "text", "p_property_id" bigint, "p_new_address" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


--
-- Name: rename_property_v2("text", "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."rename_property_v2"("p_company_id" "text", "p_property_id" "text", "p_new_address" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_prop_id_int INTEGER;
BEGIN
  -- Handle both text and integer property IDs
  BEGIN
    v_prop_id_int := p_property_id::INTEGER;
  EXCEPTION WHEN OTHERS THEN
    v_prop_id_int := NULL;
  END;

  -- Update the property address
  IF v_prop_id_int IS NOT NULL THEN
    UPDATE properties SET address = p_new_address
    WHERE id = v_prop_id_int AND company_id = p_company_id;
  ELSE
    UPDATE properties SET address = p_new_address
    WHERE id::TEXT = p_property_id AND company_id = p_company_id;
  END IF;

  -- Update display text on related tables using property_id FK
  UPDATE payments SET property = p_new_address WHERE property_id = v_prop_id_int AND company_id = p_company_id;
  UPDATE tenants SET property = p_new_address WHERE property_id = v_prop_id_int AND company_id = p_company_id;
  UPDATE work_orders SET property = p_new_address WHERE property_id = v_prop_id_int AND company_id = p_company_id;
  UPDATE utilities SET property = p_new_address WHERE property_id = v_prop_id_int AND company_id = p_company_id;
  UPDATE hoa_payments SET property = p_new_address WHERE property_id = v_prop_id_int AND company_id = p_company_id;
  UPDATE autopay_schedules SET property = p_new_address WHERE property_id = v_prop_id_int AND company_id = p_company_id;
  UPDATE documents SET property = p_new_address WHERE property_id = v_prop_id_int AND company_id = p_company_id;
  UPDATE ledger_entries SET property = p_new_address WHERE property_id = v_prop_id_int AND company_id = p_company_id;
  UPDATE leases SET property = p_new_address WHERE property_id = v_prop_id_int AND company_id = p_company_id;

  RETURN jsonb_build_object('success', true);
END;
$$;


--
-- Name: rename_tenant_cascade("text", "text", "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."rename_tenant_cascade"("p_company_id" "text", "p_old_name" "text", "p_new_name" "text", "p_property" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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

  UPDATE payments          SET tenant = p_new_name      WHERE company_id = p_company_id AND tenant = p_old_name      AND property = p_property;
  UPDATE leases            SET tenant_name = p_new_name WHERE company_id = p_company_id AND tenant_name = p_old_name AND property = p_property;
  UPDATE work_orders       SET tenant = p_new_name      WHERE company_id = p_company_id AND tenant = p_old_name      AND property = p_property;
  UPDATE documents         SET tenant = p_new_name      WHERE company_id = p_company_id AND tenant = p_old_name      AND property = p_property;
  UPDATE ledger_entries    SET tenant = p_new_name      WHERE company_id = p_company_id AND tenant = p_old_name      AND property = p_property;
  UPDATE messages          SET tenant = p_new_name      WHERE company_id = p_company_id AND tenant = p_old_name      AND property = p_property;
  UPDATE autopay_schedules SET tenant = p_new_name      WHERE company_id = p_company_id AND tenant = p_old_name      AND property = p_property;
  UPDATE properties        SET tenant = p_new_name      WHERE company_id = p_company_id AND tenant = p_old_name      AND address  = p_property;
END;
$$;


--
-- Name: request_join_company("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."request_join_company"("p_company_id" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE v_email text;
BEGIN
  v_email := current_setting('request.jwt.claims', true)::json->>'email';
  INSERT INTO company_members (company_id, user_email, role, status)
  VALUES (p_company_id, v_email, 'tenant', 'pending')
  ON CONFLICT DO NOTHING;
END;
$$;


--
-- Name: request_join_company("text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."request_join_company"("p_company_id" "text", "p_role" "text" DEFAULT 'office_assistant'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_user_id UUID;
  v_email TEXT;
  v_existing RECORD;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  v_email := LOWER(auth.jwt()->>'email');
  
  -- Check for existing membership
  SELECT status INTO v_existing FROM company_members
    WHERE company_id = p_company_id AND LOWER(user_email) = v_email;
  
  IF v_existing.status = 'active' THEN
    RAISE EXCEPTION 'Already a member of this company';
  ELSIF v_existing.status = 'pending' THEN
    RAISE EXCEPTION 'Request already pending';
  ELSIF v_existing.status = 'rejected' THEN
    RAISE EXCEPTION 'Previous request was rejected — contact the company admin';
  ELSIF v_existing.status = 'removed' THEN
    RAISE EXCEPTION 'Previously removed — contact the company admin';
  END IF;
  
  INSERT INTO company_members (company_id, user_email, user_name, role, status, invited_by, auth_user_id)
  VALUES (p_company_id, v_email, SPLIT_PART(v_email, '@', 1), p_role, 'pending', 'self-request', v_user_id)
  ON CONFLICT (company_id, user_email) DO UPDATE SET
    status = 'pending', auth_user_id = v_user_id;
  
  RETURN jsonb_build_object('success', true);
END;
$$;


--
-- Name: request_paper_copy("text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."request_paper_copy"("p_token" "text", "p_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_sig doc_signatures%ROWTYPE;
BEGIN
  IF p_token IS NULL OR length(p_token) < 20 THEN
    RETURN jsonb_build_object('error','invalid token');
  END IF;
  SELECT * INTO v_sig FROM doc_signatures WHERE access_token = p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','token not found'); END IF;
  IF v_sig.token_expires_at < now() THEN RETURN jsonb_build_object('error','token expired'); END IF;
  UPDATE doc_signatures
    SET paper_copy_requested_at = now(),
        consent_withdrawn_reason = COALESCE(NULLIF(p_reason, ''), consent_withdrawn_reason)
    WHERE id = v_sig.id;
  RETURN jsonb_build_object('success', true, 'requested_at', now());
END; $$;


--
-- Name: resolve_signed_pdf_path("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."resolve_signed_pdf_path"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
DECLARE
  v_sig doc_signatures%ROWTYPE;
  v_doc doc_generated%ROWTYPE;
BEGIN
  IF p_token IS NULL OR length(p_token) < 20 THEN
    RETURN jsonb_build_object('error','invalid token');
  END IF;
  SELECT * INTO v_sig FROM doc_signatures WHERE access_token = p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','token not found'); END IF;
  IF v_sig.token_expires_at < now() THEN
    RETURN jsonb_build_object('error','token expired');
  END IF;
  SELECT * INTO v_doc FROM doc_generated WHERE id = v_sig.doc_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','doc not found'); END IF;
  IF v_doc.signed_pdf_path IS NULL THEN
    RETURN jsonb_build_object('error','signed pdf not yet stored',
      'envelope_status', v_doc.envelope_status);
  END IF;
  RETURN jsonb_build_object(
    'doc_id', v_doc.id,
    'doc_name', v_doc.name,
    'signed_pdf_path', v_doc.signed_pdf_path,
    'signed_pdf_hash', v_doc.signed_pdf_hash
  );
END $$;


--
-- Name: restore_archived("text", "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."restore_archived"("p_company_id" "text", "p_table_name" "text", "p_item_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  -- Only allow known tables
  IF p_table_name = 'properties' THEN
    UPDATE properties SET archived_at = NULL, archived_by = NULL WHERE company_id = p_company_id AND id = p_item_id::INT;
  ELSIF p_table_name = 'tenants' THEN
    UPDATE tenants SET archived_at = NULL, archived_by = NULL WHERE company_id = p_company_id AND id = p_item_id::INT;
  ELSIF p_table_name = 'work_orders' THEN
    UPDATE work_orders SET archived_at = NULL WHERE company_id = p_company_id AND id = p_item_id::INT;
  ELSIF p_table_name = 'documents' THEN
    UPDATE documents SET archived_at = NULL WHERE company_id = p_company_id AND id = p_item_id::INT;
  ELSIF p_table_name = 'leases' THEN
    UPDATE leases SET archived_at = NULL WHERE company_id = p_company_id AND id = p_item_id::INT;
  ELSIF p_table_name = 'payments' THEN
    UPDATE payments SET archived_at = NULL WHERE company_id = p_company_id AND id = p_item_id::INT;
  ELSIF p_table_name = 'utilities' THEN
    UPDATE utilities SET archived_at = NULL WHERE company_id = p_company_id AND id = p_item_id::INT;
  ELSIF p_table_name = 'hoa_payments' THEN
    UPDATE hoa_payments SET archived_at = NULL WHERE company_id = p_company_id AND id = p_item_id::INT;
  ELSE
    RAISE EXCEPTION 'Unknown table: %', p_table_name;
  END IF;
  RETURN jsonb_build_object('success', true, 'restored', p_table_name);
END;
$$;


--
-- Name: rls_auto_enable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


--
-- Name: set_journal_line_company_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."set_journal_line_company_id"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW.company_id IS NULL THEN
    SELECT company_id INTO NEW.company_id
    FROM acct_journal_entries WHERE id = NEW.journal_entry_id;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: set_signed_pdf("uuid", "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."set_signed_pdf"("p_doc_id" "uuid", "p_pdf_path" "text", "p_pdf_hash" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
DECLARE
  v_doc doc_generated%ROWTYPE;
  v_sig record;
  v_queued int := 0;
BEGIN
  SELECT * INTO v_doc FROM doc_generated WHERE id = p_doc_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','doc not found'); END IF;
  IF v_doc.envelope_status <> 'completed' THEN
    RETURN jsonb_build_object('error','envelope not completed');
  END IF;
  IF v_doc.signed_pdf_path IS NOT NULL THEN
    RETURN jsonb_build_object('already_set', true,
      'signed_pdf_path', v_doc.signed_pdf_path,
      'signed_pdf_hash', v_doc.signed_pdf_hash);
  END IF;

  UPDATE doc_generated
    SET signed_pdf_path = p_pdf_path,
        signed_pdf_hash = p_pdf_hash,
        signed_pdf_uploaded_at = now()
    WHERE id = p_doc_id;

  -- Fan out: one notification_queue row per signer. The delivery
  -- worker picks these up by type='signed_doc_copy' and signs a
  -- short-lived URL against signed_pdf_path at send time, so the
  -- URL never goes stale waiting in the queue.
  FOR v_sig IN
    SELECT id, signer_email, signer_name FROM doc_signatures
    WHERE doc_id = p_doc_id
      AND status IN ('signed','viewed','sent','pending')
      AND signer_email IS NOT NULL
  LOOP
    INSERT INTO notification_queue (company_id, type, recipient_email, data, status)
    VALUES (
      v_doc.company_id, 'signed_doc_copy', lower(v_sig.signer_email),
      jsonb_build_object(
        'doc_id', p_doc_id,
        'doc_name', v_doc.name,
        'signed_pdf_path', p_pdf_path,
        'signed_pdf_hash', p_pdf_hash,
        'signer_name', v_sig.signer_name
      )::text,
      'pending'
    );
    v_queued := v_queued + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'signers_queued', v_queued);
END $$;


--
-- Name: sign_document("text", "text", "text", "text", "text", "text", boolean, boolean, "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."sign_document"("p_token" "text", "p_signer_name" "text", "p_signature_data" "text", "p_signing_method" "text", "p_consent_text" "text", "p_user_agent" "text", "p_e_records_consented" boolean DEFAULT NULL::boolean, "p_hw_sw_acknowledged" boolean DEFAULT NULL::boolean, "p_consent_version" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
DECLARE
  v_sig doc_signatures%ROWTYPE;
  v_doc doc_generated%ROWTYPE;
  v_now timestamptz := now();
  v_hash text;
  v_doc_hash text;
  v_ip inet;
  v_remaining int;
  v_signing_mode text;
  v_next_id uuid;
  v_next_email text;
  v_next_min_order int;
  v_all_signed boolean;
BEGIN
  IF p_token IS NULL OR length(p_token) < 20 THEN
    RETURN jsonb_build_object('error','invalid token');
  END IF;
  IF p_signature_data IS NULL OR length(p_signature_data) < 10 THEN
    RETURN jsonb_build_object('error','signature required');
  END IF;
  IF p_consent_text IS NULL OR length(p_consent_text) < 10 THEN
    RETURN jsonb_build_object('error','consent text required');
  END IF;
  -- ESIGN §101(c)(1)(A): affirmative consent to use electronic records.
  -- Backwards compatibility: if the caller passes NULL (legacy clients
  -- that haven't been updated), accept it but log nothing — the new
  -- frontend always passes true. After all clients update, flip to
  -- requiring true.
  IF p_e_records_consented IS NOT NULL AND p_e_records_consented = false THEN
    RETURN jsonb_build_object('error','electronic records consent required');
  END IF;

  SELECT * INTO v_sig FROM doc_signatures WHERE access_token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','token not found'); END IF;
  IF v_sig.token_expires_at < v_now THEN RETURN jsonb_build_object('error','token expired'); END IF;
  IF v_sig.status NOT IN ('sent','viewed') THEN
    RETURN jsonb_build_object('error','already signed or cancelled','status',v_sig.status);
  END IF;
  IF p_signing_method NOT IN ('draw','type') THEN
    RETURN jsonb_build_object('error','invalid signing method');
  END IF;

  SELECT * INTO v_doc FROM doc_generated WHERE id = v_sig.doc_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','doc not found'); END IF;

  -- Use the SNAPSHOTTED doc_hash_at_send (set when envelope was sent),
  -- not the current rendered_body. If the body is mutated between
  -- send and sign, the hash still binds to what the signer originally
  -- saw — that's the whole point. Fall back to recomputing from the
  -- current body for legacy envelopes that pre-date this column.
  v_doc_hash := COALESCE(
    v_doc.doc_hash_at_send,
    encode(digest(COALESCE(v_doc.rendered_body,''), 'sha256'), 'hex')
  );

  -- Reproducible signature hash: no timestamp included.
  -- Reviewers can recompute by hand from these four values.
  v_hash := encode(
    digest(
      v_doc_hash || '|' ||
      v_sig.signer_email || '|' ||
      p_signature_data || '|' ||
      COALESCE(p_consent_version, ''),
      'sha256'
    ), 'hex'
  );

  BEGIN v_ip := inet_client_addr(); EXCEPTION WHEN others THEN v_ip := NULL; END;

  UPDATE doc_signatures SET
    status = 'signed',
    signer_name = COALESCE(NULLIF(p_signer_name,''), signer_name),
    signature_data = p_signature_data,
    signing_method = p_signing_method,
    consent_text = p_consent_text,
    user_agent = p_user_agent,
    signer_ip = v_ip,
    integrity_hash = v_hash,
    signed_at = v_now,
    e_records_consented = COALESCE(p_e_records_consented, e_records_consented),
    e_records_consent_at = CASE WHEN p_e_records_consented IS TRUE THEN v_now ELSE e_records_consent_at END,
    e_records_consent_version = COALESCE(p_consent_version, e_records_consent_version),
    hardware_software_acknowledged = COALESCE(p_hw_sw_acknowledged, hardware_software_acknowledged)
  WHERE id = v_sig.id;

  SELECT COUNT(*) INTO v_remaining FROM doc_signatures
    WHERE doc_id = v_sig.doc_id AND status IN ('pending','sent','viewed');

  IF v_remaining = 0 THEN
    UPDATE doc_generated SET envelope_status = 'completed', envelope_completed_at = v_now
      WHERE id = v_sig.doc_id;
    v_all_signed := true;
  ELSE
    v_all_signed := false;
    SELECT COALESCE(t.signing_mode, 'parallel') INTO v_signing_mode
      FROM doc_generated d LEFT JOIN doc_templates t ON t.id = d.template_id
      WHERE d.id = v_sig.doc_id;
    IF v_signing_mode = 'sequential' THEN
      SELECT MIN(ds.sign_order) INTO v_next_min_order FROM doc_signatures ds
        WHERE ds.doc_id = v_sig.doc_id AND ds.status = 'pending';
      IF v_next_min_order IS NOT NULL THEN
        UPDATE doc_signatures SET status = 'sent'
          WHERE doc_id = v_sig.doc_id AND status = 'pending' AND sign_order = v_next_min_order
          RETURNING id, signer_email INTO v_next_id, v_next_email;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'signed_at', v_now,
    'integrity_hash', v_hash,
    'doc_hash_at_send', v_doc_hash,
    'all_signed', v_all_signed,
    'doc_id', v_sig.doc_id,
    'next_signer_id', v_next_id,
    'next_signer_email', v_next_email
  );
END; $$;


--
-- Name: sign_lease("uuid", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."sign_lease"("p_signature_id" "uuid", "p_signer_name" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  UPDATE lease_signatures
     SET status = 'signed',
         signed_at = now(),
         signer_name = p_signer_name
   WHERE id = p_signature_id;
END;
$$;


--
-- Name: sign_lease("text", "text", "text", "text", "text", "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."sign_lease"("p_company_id" "text", "p_lease_id" "text", "p_signer_id" "text", "p_signature_data" "text", "p_signing_method" "text" DEFAULT 'typed'::"text", "p_consent_text" "text" DEFAULT 'I agree that my electronic signature is the legal equivalent of my manual/handwritten signature and I consent to be legally bound by this lease agreement.'::"text", "p_user_agent" "text" DEFAULT ''::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_user_email TEXT;
  v_user_id UUID;
  v_signer RECORD;
  v_lease RECORD;
  v_timestamp TIMESTAMPTZ;
  v_ip TEXT;
  v_hash_input TEXT;
  v_integrity_hash TEXT;
  v_all_signed BOOLEAN;
BEGIN
  -- 1. Get the authenticated caller's identity (server-verified, can't be spoofed)
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  v_user_email := LOWER(auth.jwt()->>'email');
  IF v_user_email IS NULL OR v_user_email = '' THEN
    RAISE EXCEPTION 'No email in auth token';
  END IF;

  -- 2. Fetch the signer row and verify it belongs to this company/lease
  SELECT * INTO v_signer FROM lease_signatures
    WHERE id = p_signer_id 
    AND lease_id = p_lease_id 
    AND company_id = p_company_id;
  
  IF v_signer IS NULL THEN
    RAISE EXCEPTION 'Signature request not found';
  END IF;
  
  IF v_signer.status = 'signed' THEN
    RAISE EXCEPTION 'Already signed';
  END IF;

  -- 3. Verify the caller IS the signer (email match)
  -- For landlord role, also allow company admins
  IF v_signer.signer_role = 'tenant' THEN
    IF LOWER(v_signer.signer_email) != v_user_email THEN
      RAISE EXCEPTION 'Email mismatch: you are % but signer is %', v_user_email, v_signer.signer_email;
    END IF;
  ELSE
    -- Landlord/PM: verify they're an active admin/staff member of this company
    IF NOT EXISTS (
      SELECT 1 FROM company_members 
      WHERE company_id = p_company_id 
      AND LOWER(user_email) = v_user_email 
      AND status = 'active'
      AND role IN ('admin', 'office_assistant')
    ) THEN
      RAISE EXCEPTION 'Not authorized to sign as landlord for this company';
    END IF;
  END IF;

  -- 4. Fetch lease details for the hash
  SELECT * INTO v_lease FROM leases
    WHERE id = p_lease_id AND company_id = p_company_id;
  
  IF v_lease IS NULL THEN
    RAISE EXCEPTION 'Lease not found';
  END IF;

  -- 5. Capture server timestamp and IP
  v_timestamp := NOW();
  -- IP from the connection (Supabase passes this through)
  v_ip := COALESCE(
    current_setting('request.headers', true)::json->>'x-real-ip',
    current_setting('request.headers', true)::json->>'x-forwarded-for',
    current_setting('request.headers', true)::json->>'cf-connecting-ip',
    'server-recorded'
  );

  -- 6. Generate integrity hash: SHA-256 of all signing evidence
  -- This creates a tamper-evident record — if any field is changed after signing,
  -- the hash won't match, proving the record was altered.
  v_hash_input := p_lease_id || '|' 
    || p_signer_id || '|' 
    || v_user_email || '|' 
    || v_user_id::TEXT || '|'
    || v_signer.signer_name || '|'
    || v_signer.signer_role || '|'
    || v_timestamp::TEXT || '|' 
    || v_ip || '|'
    || p_signature_data || '|'
    || p_consent_text;
  
  v_integrity_hash := encode(digest(v_hash_input, 'sha256'), 'hex');

  -- 7. Update the signature row atomically
  UPDATE lease_signatures SET
    status = 'signed',
    signed_at = v_timestamp,
    signature_data = p_signature_data,
    ip_address = v_ip,
    user_agent = p_user_agent,
    integrity_hash = v_integrity_hash,
    auth_user_id = v_user_id,
    consent_text = p_consent_text,
    signing_method = p_signing_method,
    verified_server_side = true
  WHERE id = p_signer_id 
    AND lease_id = p_lease_id 
    AND company_id = p_company_id
    AND status = 'pending';  -- Extra guard: only sign if still pending

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Signature update failed — may have been signed already';
  END IF;

  -- 8. Check if all signers have now signed
  SELECT NOT EXISTS (
    SELECT 1 FROM lease_signatures 
    WHERE lease_id = p_lease_id 
    AND company_id = p_company_id 
    AND status != 'signed'
  ) INTO v_all_signed;

  -- 9. Update lease signature status
  UPDATE leases SET 
    signature_status = CASE WHEN v_all_signed THEN 'fully_signed' ELSE 'partially_signed' END
  WHERE id = p_lease_id AND company_id = p_company_id;

  -- 10. Return the evidence record
  RETURN jsonb_build_object(
    'success', true,
    'signer_name', v_signer.signer_name,
    'signer_email', v_user_email,
    'signed_at', v_timestamp,
    'ip_address', v_ip,
    'integrity_hash', v_integrity_hash,
    'all_signed', v_all_signed,
    'verified_server_side', true
  );
END;
$$;


--
-- Name: sync_property_address(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."sync_property_address"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.address := compute_property_address(
    NEW.address_line_1, NEW.address_line_2, NEW.city, NEW.state, NEW.zip
  );
  RETURN NEW;
END;
$$;


--
-- Name: tenant_make_payment("text", integer, numeric, "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."tenant_make_payment"("p_company_id" "text", "p_tenant_id" integer, "p_amount" numeric, "p_method" "text" DEFAULT 'stripe'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_tenant RECORD;
  v_today TEXT;
  v_je_id TEXT;
BEGIN
  -- Verify caller IS this tenant (by email match)
  SELECT * INTO v_tenant FROM tenants
  WHERE id = p_tenant_id AND company_id = p_company_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tenant not found';
  END IF;
  
  IF LOWER(v_tenant.email) != LOWER(auth.jwt()->>'email') THEN
    RAISE EXCEPTION 'Access denied: you can only make payments for your own account';
  END IF;
  
  IF p_amount <= 0 OR p_amount > 100000 THEN
    RAISE EXCEPTION 'Invalid payment amount';
  END IF;
  
  v_today := to_char(CURRENT_DATE, 'YYYY-MM-DD');
  
  -- Record payment
  INSERT INTO payments (company_id, tenant, property, amount, type, method, status, date)
  VALUES (p_company_id, v_tenant.name, v_tenant.property, p_amount, 'rent', p_method, 'paid', v_today);
  
  -- Update tenant balance
  UPDATE tenants SET balance = COALESCE(balance, 0) - p_amount WHERE id = p_tenant_id;
  
  -- Create ledger entry
  INSERT INTO ledger_entries (company_id, tenant, property, date, description, amount, type, balance)
  VALUES (p_company_id, v_tenant.name, v_tenant.property, v_today, 'Rent payment (online)', -p_amount, 'payment', 0);
  
  RETURN jsonb_build_object('success', true, 'amount', p_amount, 'tenant', v_tenant.name);
END;
$$;


--
-- Name: trg_sync_balance_from_je_lines(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."trg_sync_balance_from_je_lines"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_old_tenant_id bigint;
  v_new_tenant_id bigint;
BEGIN
  -- DELETE: recompute the (former) account's tenant
  IF TG_OP = 'DELETE' THEN
    SELECT tenant_id INTO v_old_tenant_id FROM acct_accounts WHERE id = OLD.account_id;
    PERFORM recompute_tenant_balance(v_old_tenant_id);
    RETURN OLD;
  END IF;

  -- INSERT: recompute the new account's tenant
  IF TG_OP = 'INSERT' THEN
    SELECT tenant_id INTO v_new_tenant_id FROM acct_accounts WHERE id = NEW.account_id;
    PERFORM recompute_tenant_balance(v_new_tenant_id);
    RETURN NEW;
  END IF;

  -- UPDATE: recompute both old and new account tenants if the
  -- account_id changed; otherwise just the one.
  IF OLD.account_id IS DISTINCT FROM NEW.account_id THEN
    SELECT tenant_id INTO v_old_tenant_id FROM acct_accounts WHERE id = OLD.account_id;
    SELECT tenant_id INTO v_new_tenant_id FROM acct_accounts WHERE id = NEW.account_id;
    PERFORM recompute_tenant_balance(v_old_tenant_id);
    IF v_new_tenant_id IS DISTINCT FROM v_old_tenant_id THEN
      PERFORM recompute_tenant_balance(v_new_tenant_id);
    END IF;
  ELSE
    SELECT tenant_id INTO v_new_tenant_id FROM acct_accounts WHERE id = NEW.account_id;
    PERFORM recompute_tenant_balance(v_new_tenant_id);
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: trg_sync_balance_from_je_status(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."trg_sync_balance_from_je_status"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_tenant_id bigint;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;
  FOR v_tenant_id IN
    SELECT DISTINCT a.tenant_id
    FROM acct_journal_lines jl
    JOIN acct_accounts a ON a.id = jl.account_id
    WHERE jl.journal_entry_id = NEW.id AND a.tenant_id IS NOT NULL
  LOOP
    PERFORM recompute_tenant_balance(v_tenant_id);
  END LOOP;
  RETURN NEW;
END;
$$;


--
-- Name: update_tenant_balance(bigint, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."update_tenant_balance"("p_tenant_id" bigint, "p_amount_change" numeric) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


--
-- Name: validate_invite_code("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."validate_invite_code"("p_code" "text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE v_result json;
BEGIN
  SELECT json_build_object('valid', true, 'company_id', company_id, 'property', property)
  INTO v_result FROM tenant_invite_codes WHERE code = p_code AND redeemed_at IS NULL;
  IF v_result IS NULL THEN RETURN json_build_object('valid', false); END IF;
  RETURN v_result;
END;
$$;


--
-- Name: verify_signature_integrity("text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."verify_signature_integrity"("p_signature_id" "text", "p_company_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_sig RECORD;
  v_hash_input TEXT;
  v_computed_hash TEXT;
  v_matches BOOLEAN;
BEGIN
  SELECT * INTO v_sig FROM lease_signatures
    WHERE id = p_signature_id AND company_id = p_company_id;
  
  IF v_sig IS NULL THEN
    RETURN jsonb_build_object('verified', false, 'reason', 'Signature not found');
  END IF;
  
  IF v_sig.integrity_hash IS NULL THEN
    RETURN jsonb_build_object('verified', false, 'reason', 'No integrity hash — signed before server-side verification was enabled');
  END IF;

  -- Recompute the hash from stored fields
  v_hash_input := v_sig.lease_id || '|' 
    || v_sig.id || '|' 
    || LOWER(COALESCE(v_sig.signer_email, '')) || '|' 
    || COALESCE(v_sig.auth_user_id::TEXT, '') || '|'
    || v_sig.signer_name || '|'
    || v_sig.signer_role || '|'
    || v_sig.signed_at::TEXT || '|' 
    || COALESCE(v_sig.ip_address, '') || '|'
    || COALESCE(v_sig.signature_data, '') || '|'
    || COALESCE(v_sig.consent_text, '');
  
  v_computed_hash := encode(digest(v_hash_input, 'sha256'), 'hex');
  v_matches := (v_computed_hash = v_sig.integrity_hash);

  RETURN jsonb_build_object(
    'verified', v_matches,
    'signer_name', v_sig.signer_name,
    'signer_email', v_sig.signer_email,
    'signed_at', v_sig.signed_at,
    'ip_address', v_sig.ip_address,
    'signing_method', v_sig.signing_method,
    'server_verified', v_sig.verified_server_side,
    'integrity_hash', v_sig.integrity_hash,
    'reason', CASE WHEN v_matches THEN 'Hash matches — record is authentic' ELSE 'HASH MISMATCH — record may have been tampered with' END
  );
END;
$$;


--
-- Name: withdraw_e_records_consent("text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."withdraw_e_records_consent"("p_token" "text", "p_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_sig doc_signatures%ROWTYPE;
BEGIN
  IF p_token IS NULL OR length(p_token) < 20 THEN
    RETURN jsonb_build_object('error','invalid token');
  END IF;
  SELECT * INTO v_sig FROM doc_signatures WHERE access_token = p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','token not found'); END IF;
  UPDATE doc_signatures
    SET consent_withdrawn_at = now(),
        consent_withdrawn_reason = NULLIF(p_reason, '')
    WHERE id = v_sig.id;
  RETURN jsonb_build_object('success', true, 'withdrawn_at', now());
END; $$;


--
-- Name: accounting_period_lock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."accounting_period_lock" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "lock_date" "date" NOT NULL,
    "locked_by" "text",
    "locked_at" timestamp with time zone DEFAULT "now"(),
    "notes" "text"
);


--
-- Name: acct_classes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."acct_classes" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text",
    "color" "text" DEFAULT '#3B82F6'::"text",
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "company_id" "text" DEFAULT 'sandbox-llc'::"text"
);


--
-- Name: acct_journal_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."acct_journal_lines_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: acct_journal_lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."acct_journal_lines_id_seq" OWNED BY "public"."acct_journal_lines"."id";


--
-- Name: app_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."app_users" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" "text",
    "name" "text",
    "role" "text" DEFAULT 'office_assistant'::"text",
    "created_at" timestamp without time zone DEFAULT "now"(),
    "custom_pages" "text",
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "user_type" "text" DEFAULT 'pm'::"text",
    "archived_at" timestamp with time zone,
    "archived_by" "text",
    "first_name" "text" DEFAULT ''::"text",
    "middle_initial" "text" DEFAULT ''::"text",
    "last_name" "text" DEFAULT ''::"text",
    "preferences" "jsonb" DEFAULT '{}'::"jsonb",
    "password_set_at" timestamp with time zone,
    "manager_email" "text"
);


--
-- Name: audit_trail; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."audit_trail" (
    "id" integer NOT NULL,
    "action" "text" NOT NULL,
    "module" "text" NOT NULL,
    "details" "text" DEFAULT ''::"text",
    "record_id" "text",
    "user_email" "text" NOT NULL,
    "user_role" "text" DEFAULT 'admin'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "company_id" "text" DEFAULT 'sandbox-llc'::"text"
);


--
-- Name: audit_trail_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."audit_trail_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_trail_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."audit_trail_id_seq" OWNED BY "public"."audit_trail"."id";


--
-- Name: automation_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."automation_jobs" (
    "id" integer NOT NULL,
    "company_id" "text" NOT NULL,
    "utility_account_id" integer,
    "job_type" "text" NOT NULL,
    "status" "text" DEFAULT 'queued'::"text",
    "bill_id" integer,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "error_message" "text" DEFAULT ''::"text",
    "screenshots" "jsonb" DEFAULT '[]'::"jsonb",
    "logs" "text" DEFAULT ''::"text",
    "triggered_by" "text" DEFAULT 'schedule'::"text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: automation_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."automation_jobs_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: automation_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."automation_jobs_id_seq" OWNED BY "public"."automation_jobs"."id";


--
-- Name: autopay_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."autopay_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant" "text",
    "property" "text",
    "amount" numeric,
    "frequency" "text",
    "day_of_month" "text",
    "start_date" "text",
    "end_date" "text",
    "method" "text",
    "active" boolean DEFAULT true,
    "created_at" timestamp without time zone DEFAULT "now"(),
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "property_id" integer,
    "archived_at" timestamp with time zone,
    "archived_by" "text",
    "tenant_id" bigint,
    "enabled" boolean DEFAULT true NOT NULL,
    "next_charge_date" "date",
    "provider" "text" DEFAULT 'manual'::"text" NOT NULL,
    "stripe_customer_id" "text",
    "stripe_payment_method_id" "text",
    "card_brand" "text",
    "card_last4" "text",
    "last_error" "text",
    "last_error_at" timestamp with time zone,
    "last_charge_at" timestamp with time zone
);


--
-- Name: bank_account_feed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."bank_account_feed" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "gl_account_id" "uuid",
    "account_name" "text" NOT NULL,
    "masked_number" "text" DEFAULT ''::"text",
    "account_type" "text" DEFAULT 'checking'::"text" NOT NULL,
    "currency_code" "text" DEFAULT 'USD'::"text",
    "bank_balance_current" numeric(18,2),
    "ledger_balance_cached" numeric(18,2),
    "last_synced_at" timestamp with time zone,
    "import_enabled" boolean DEFAULT true,
    "review_count_cached" integer DEFAULT 0,
    "status" "text" DEFAULT 'active'::"text",
    "institution_name" "text" DEFAULT ''::"text",
    "connection_type" "text" DEFAULT 'csv'::"text",
    "plaid_account_id" "text",
    "bank_connection_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "bank_account_feed_account_type_check" CHECK (("account_type" = ANY (ARRAY['checking'::"text", 'savings'::"text", 'credit_card'::"text", 'loan'::"text", 'other'::"text"]))),
    CONSTRAINT "bank_account_feed_connection_type_check" CHECK (("connection_type" = ANY (ARRAY['csv'::"text", 'plaid'::"text", 'teller'::"text", 'manual'::"text"]))),
    CONSTRAINT "bank_account_feed_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'inactive'::"text", 'errored'::"text"])))
);


--
-- Name: bank_connection; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."bank_connection" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "source_type" "text" DEFAULT 'plaid'::"text",
    "institution_name" "text",
    "institution_id" "text",
    "plaid_item_id" "text",
    "access_token_encrypted" "text",
    "encryption_iv" "text",
    "connection_status" "text" DEFAULT 'active'::"text",
    "last_successful_sync_at" timestamp with time zone,
    "last_error_code" "text",
    "last_error_message" "text",
    "plaid_sync_cursor" "text",
    "consent_expiration_time" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "encryption_salt" "text",
    "sync_from_date" "date",
    CONSTRAINT "bank_connection_connection_status_check" CHECK (("connection_status" = ANY (ARRAY['active'::"text", 'needs_reauth'::"text", 'errored'::"text", 'disconnected'::"text"]))),
    CONSTRAINT "bank_connection_source_type_check" CHECK (("source_type" = ANY (ARRAY['plaid'::"text", 'teller'::"text", 'manual'::"text"])))
);


--
-- Name: COLUMN "bank_connection"."sync_from_date"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."bank_connection"."sync_from_date" IS 'Optional date floor for daily Teller sync. Cron skips txns posted before this date. NULL = pull Teller default window.';


--
-- Name: bank_feed_transaction; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."bank_feed_transaction" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "bank_account_feed_id" "uuid",
    "bank_import_batch_id" "uuid",
    "source_type" "text" DEFAULT 'csv'::"text",
    "provider_transaction_id" "text",
    "posted_date" "date" NOT NULL,
    "amount" numeric(18,2) NOT NULL,
    "direction" "text" NOT NULL,
    "bank_description_raw" "text",
    "bank_description_clean" "text",
    "memo" "text",
    "check_number" "text",
    "payee_raw" "text",
    "payee_normalized" "text",
    "reference_number" "text",
    "balance_after" numeric(18,2),
    "fingerprint_hash" "text" NOT NULL,
    "duplicate_group_key" "text",
    "status" "text" DEFAULT 'for_review'::"text",
    "suggestion_status" "text" DEFAULT 'none'::"text",
    "exclusion_reason" "text",
    "excluded_at" timestamp with time zone,
    "excluded_by" "text",
    "accepted_at" timestamp with time zone,
    "accepted_by" "text",
    "matched_target_type" "text",
    "matched_target_id" "uuid",
    "posting_decision_id" "uuid",
    "journal_entry_id" "uuid",
    "raw_payload_json" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "bank_feed_transaction_direction_check" CHECK (("direction" = ANY (ARRAY['inflow'::"text", 'outflow'::"text"]))),
    CONSTRAINT "bank_feed_transaction_status_check" CHECK (("status" = ANY (ARRAY['for_review'::"text", 'categorized'::"text", 'matched'::"text", 'excluded'::"text", 'posted'::"text", 'locked'::"text", 'reversed'::"text"])))
);


--
-- Name: bank_feed_transaction_link; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."bank_feed_transaction_link" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "bank_feed_transaction_id" "uuid",
    "linked_object_type" "text" NOT NULL,
    "linked_object_id" "uuid" NOT NULL,
    "link_role" "text" DEFAULT 'created_from'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "bank_feed_transaction_link_link_role_check" CHECK (("link_role" = ANY (ARRAY['created_from'::"text", 'matched_to'::"text", 'settled_by'::"text", 'reversed_by'::"text"])))
);


--
-- Name: bank_import_batch; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."bank_import_batch" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "bank_account_feed_id" "uuid",
    "source_type" "text" DEFAULT 'csv'::"text",
    "original_filename" "text",
    "file_hash" "text",
    "imported_by" "text",
    "imported_at" timestamp with time zone DEFAULT "now"(),
    "row_count" integer DEFAULT 0,
    "accepted_count" integer DEFAULT 0,
    "skipped_count" integer DEFAULT 0,
    "duplicate_count" integer DEFAULT 0,
    "status" "text" DEFAULT 'imported'::"text",
    "mapping_json" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "bank_import_batch_source_type_check" CHECK (("source_type" = ANY (ARRAY['csv'::"text", 'plaid'::"text", 'manual'::"text"]))),
    CONSTRAINT "bank_import_batch_status_check" CHECK (("status" = ANY (ARRAY['uploaded'::"text", 'mapped'::"text", 'parsed'::"text", 'validated'::"text", 'imported'::"text", 'failed'::"text"])))
);


--
-- Name: bank_import_mapping_profile; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."bank_import_mapping_profile" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "institution_name" "text",
    "bank_account_feed_id" "uuid",
    "delimiter" "text" DEFAULT ','::"text",
    "header_row_index" integer DEFAULT 0,
    "date_column" "text",
    "date_format" "text" DEFAULT 'MM/DD/YYYY'::"text",
    "amount_mode" "text" DEFAULT 'single_signed'::"text",
    "amount_column" "text",
    "debit_column" "text",
    "credit_column" "text",
    "description_columns_json" "jsonb" DEFAULT '[]'::"jsonb",
    "payee_column" "text",
    "memo_column" "text",
    "check_number_column" "text",
    "reference_column" "text",
    "balance_column" "text",
    "invert_sign" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "bank_import_mapping_profile_amount_mode_check" CHECK (("amount_mode" = ANY (ARRAY['single_signed'::"text", 'debit_credit'::"text"])))
);


--
-- Name: bank_posting_decision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."bank_posting_decision" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "bank_feed_transaction_id" "uuid",
    "decision_type" "text" NOT NULL,
    "payee" "text",
    "memo" "text",
    "header_class_id" "uuid",
    "transfer_gl_account_id" "uuid",
    "status" "text" DEFAULT 'draft'::"text",
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "bank_posting_decision_decision_type_check" CHECK (("decision_type" = ANY (ARRAY['add'::"text", 'match'::"text", 'transfer'::"text", 'split'::"text", 'exclude'::"text"]))),
    CONSTRAINT "bank_posting_decision_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'validated'::"text", 'posted'::"text", 'failed'::"text", 'undone'::"text"])))
);


--
-- Name: bank_posting_decision_line; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."bank_posting_decision_line" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "bank_posting_decision_id" "uuid",
    "line_no" integer DEFAULT 1,
    "gl_account_id" "uuid",
    "gl_account_name" "text",
    "amount" numeric(18,2) NOT NULL,
    "entry_side" "text" DEFAULT 'debit'::"text",
    "memo" "text",
    "class_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "bank_posting_decision_line_entry_side_check" CHECK (("entry_side" = ANY (ARRAY['debit'::"text", 'credit'::"text", 'derived'::"text"])))
);


--
-- Name: bank_reconciliations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."bank_reconciliations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "period" "text" NOT NULL,
    "bank_ending_balance" numeric(12,2) NOT NULL,
    "book_balance" numeric(12,2) DEFAULT 0,
    "difference" numeric(12,2) DEFAULT 0,
    "status" "text" DEFAULT 'in_progress'::"text",
    "reconciled_items" "jsonb" DEFAULT '[]'::"jsonb",
    "unreconciled_items" "jsonb" DEFAULT '[]'::"jsonb",
    "notes" "text" DEFAULT ''::"text",
    "reconciled_by" "text" DEFAULT ''::"text",
    "reconciled_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    CONSTRAINT "bank_reconciliations_status_check" CHECK (("status" = ANY (ARRAY['reconciled'::"text", 'in_progress'::"text", 'discrepancy'::"text", 'pending_items'::"text", 'reopened'::"text"])))
);


--
-- Name: bank_transaction_rule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."bank_transaction_rule" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "priority" integer DEFAULT 100,
    "enabled" boolean DEFAULT true,
    "bank_account_feed_id" "uuid",
    "condition_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "action_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "auto_accept" boolean DEFAULT false,
    "stop_processing" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "rule_type" "text" DEFAULT 'assign'::"text",
    "apply_count" integer DEFAULT 0,
    "last_applied_at" timestamp with time zone,
    CONSTRAINT "bank_transaction_rule_rule_type_check" CHECK (("rule_type" = ANY (ARRAY['assign'::"text", 'exclude'::"text"])))
);


--
-- Name: budgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."budgets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "account_id" "uuid",
    "account_name" "text",
    "period" "text" NOT NULL,
    "amount" numeric(18,2) DEFAULT 0 NOT NULL,
    "notes" "text" DEFAULT ''::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."companies" (
    "id" "text" DEFAULT ('co-'::"text" || "substr"("md5"(("random"())::"text"), 1, 12)) NOT NULL,
    "name" "text" NOT NULL,
    "type" "text" DEFAULT 'LLC'::"text",
    "company_code" "text" DEFAULT "upper"("substr"("md5"(("random"())::"text"), 1, 8)),
    "address" "text" DEFAULT ''::"text",
    "phone" "text" DEFAULT ''::"text",
    "email" "text" DEFAULT ''::"text",
    "logo_url" "text" DEFAULT ''::"text",
    "created_by" "text" DEFAULT ''::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "company_role" "text" DEFAULT 'management'::"text",
    "archived_at" timestamp with time zone,
    "archived_by" "text"
);


--
-- Name: company_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."company_members" (
    "id" integer NOT NULL,
    "company_id" "text" NOT NULL,
    "user_email" "text" NOT NULL,
    "user_name" "text" DEFAULT ''::"text",
    "role" "text" DEFAULT 'office_assistant'::"text",
    "status" "text" DEFAULT 'pending'::"text",
    "custom_pages" "text",
    "invited_by" "text" DEFAULT ''::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "auth_user_id" "uuid",
    "manager_email" "text"
);


--
-- Name: company_members_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."company_members_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: company_members_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."company_members_id_seq" OWNED BY "public"."company_members"."id";


--
-- Name: company_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."company_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "late_fee_grace_days" integer DEFAULT 5,
    "late_fee_amount" numeric(10,2) DEFAULT 50,
    "late_fee_type" "text" DEFAULT 'flat'::"text",
    "default_lease_months" integer DEFAULT 12,
    "default_deposit_months" integer DEFAULT 1,
    "rent_escalation_pct" numeric(5,2) DEFAULT 3.0,
    "payment_due_day" integer DEFAULT 1,
    "renewal_notice_days" integer DEFAULT 60,
    "rent_due_reminder_days" integer DEFAULT 3,
    "lease_expiry_warning_days" integer DEFAULT 60,
    "insurance_expiry_warning_days" integer DEFAULT 90,
    "deposit_return_days" integer DEFAULT 30,
    "termination_notice_days" integer DEFAULT 30,
    "archive_retention_days" integer DEFAULT 180,
    "hoa_upcoming_window_days" integer DEFAULT 14,
    "voucher_reexam_window_days" integer DEFAULT 120,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "updated_by" "text",
    CONSTRAINT "company_settings_late_fee_type_check" CHECK (("late_fee_type" = ANY (ARRAY['flat'::"text", 'percent'::"text"]))),
    CONSTRAINT "company_settings_payment_due_day_check" CHECK ((("payment_due_day" >= 1) AND ("payment_due_day" <= 31)))
);


--
-- Name: doc_exception_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."doc_exception_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "tenant_name" "text" NOT NULL,
    "property" "text",
    "requested_by" "text" NOT NULL,
    "reason" "text" DEFAULT ''::"text",
    "status" "text" DEFAULT 'pending'::"text",
    "reviewed_by" "text",
    "reviewed_at" timestamp with time zone,
    "review_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "approver_email" "text",
    "doc_type" "text"
);


--
-- Name: doc_generated; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."doc_generated" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "template_id" "uuid",
    "name" "text" NOT NULL,
    "field_values" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "rendered_body" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text",
    "property_id" "text",
    "property_address" "text",
    "tenant_name" "text",
    "recipients" "jsonb" DEFAULT '[]'::"jsonb",
    "file_path" "text",
    "created_by" "text",
    "sent_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "archived_at" timestamp with time zone,
    "archived_by" "text",
    "output_type" "text" DEFAULT 'html'::"text",
    "pdf_output_path" "text",
    "envelope_status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "envelope_sent_at" timestamp with time zone,
    "envelope_completed_at" timestamp with time zone,
    "signed_pdf_path" "text",
    "certificate_pdf_path" "text",
    "doc_hash_at_send" "text",
    "signed_pdf_hash" "text",
    "signed_pdf_uploaded_at" timestamp with time zone,
    CONSTRAINT "doc_generated_envelope_status_check" CHECK (("envelope_status" = ANY (ARRAY['draft'::"text", 'out_for_signature'::"text", 'completed'::"text", 'declined'::"text", 'voided'::"text"])))
);


--
-- Name: doc_signature_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."doc_signature_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "signature_id" "uuid" NOT NULL,
    "doc_id" "uuid" NOT NULL,
    "company_id" "text" NOT NULL,
    "op" "text" NOT NULL,
    "old_status" "text",
    "new_status" "text",
    "field_deltas" "jsonb",
    "actor_email" "text",
    "actor_role" "text",
    "changed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "doc_signature_audit_log_op_check" CHECK (("op" = ANY (ARRAY['insert'::"text", 'update'::"text", 'delete'::"text"])))
);


--
-- Name: doc_signatures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."doc_signatures" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "doc_id" "uuid" NOT NULL,
    "signer_role" "text" NOT NULL,
    "signer_name" "text",
    "signer_email" "text" NOT NULL,
    "sign_order" integer DEFAULT 1 NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "access_token" "text",
    "token_expires_at" timestamp with time zone,
    "signature_data" "text",
    "signing_method" "text",
    "consent_text" "text",
    "signer_ip" "inet",
    "user_agent" "text",
    "integrity_hash" "text",
    "sent_at" timestamp with time zone,
    "viewed_at" timestamp with time zone,
    "signed_at" timestamp with time zone,
    "declined_at" timestamp with time zone,
    "declined_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "e_records_consented" boolean DEFAULT false NOT NULL,
    "e_records_consent_at" timestamp with time zone,
    "e_records_consent_version" "text",
    "hardware_software_acknowledged" boolean DEFAULT false NOT NULL,
    "paper_copy_requested_at" timestamp with time zone,
    "consent_withdrawn_at" timestamp with time zone,
    "consent_withdrawn_reason" "text",
    CONSTRAINT "doc_signatures_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'viewed'::"text", 'signed'::"text", 'declined'::"text", 'voided'::"text"])))
);


--
-- Name: doc_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."doc_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "category" "text" DEFAULT 'general'::"text" NOT NULL,
    "description" "text" DEFAULT ''::"text",
    "body" "text" DEFAULT ''::"text" NOT NULL,
    "fields" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "is_system" boolean DEFAULT false,
    "is_active" boolean DEFAULT true,
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "field_config" "jsonb" DEFAULT '{}'::"jsonb",
    "template_type" "text" DEFAULT 'html'::"text",
    "pdf_storage_path" "text",
    "pdf_page_count" integer DEFAULT 0,
    "pdf_field_placements" "jsonb" DEFAULT '[]'::"jsonb",
    "signing_mode" "text" DEFAULT 'none'::"text" NOT NULL,
    "signer_roles" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    CONSTRAINT "doc_templates_signing_mode_check" CHECK (("signing_mode" = ANY (ARRAY['none'::"text", 'parallel'::"text", 'sequential'::"text"])))
);


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text",
    "tenant" "text",
    "property" "text",
    "type" "text",
    "url" "text",
    "size" "text",
    "uploaded_at" timestamp without time zone DEFAULT "now"(),
    "file_name" "text",
    "tenant_visible" boolean DEFAULT false,
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "property_id" integer,
    "archived_at" timestamp with time zone,
    "archived_by" "text"
);


--
-- Name: error_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."error_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text",
    "error_code" "text" NOT NULL,
    "message" "text" NOT NULL,
    "raw_message" "text",
    "severity" "text" DEFAULT 'error'::"text",
    "module" "text",
    "context" "text",
    "meta" "jsonb" DEFAULT '{}'::"jsonb",
    "user_email" "text",
    "user_role" "text",
    "url" "text",
    "user_agent" "text",
    "reported_by_user" boolean DEFAULT false,
    "resolved" boolean DEFAULT false,
    "resolution_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "resolved_at" timestamp with time zone
);


--
-- Name: eviction_cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."eviction_cases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "tenant_id" "uuid",
    "tenant_name" "text" NOT NULL,
    "property" "text" NOT NULL,
    "reason" "text" DEFAULT 'non_payment'::"text" NOT NULL,
    "notice_type" "text" DEFAULT 'pay_or_quit'::"text",
    "notice_days" integer DEFAULT 30,
    "notice_date" "date",
    "cure_deadline" "date",
    "filing_date" "date",
    "hearing_date" "date",
    "judgment_date" "date",
    "lockout_date" "date",
    "current_stage" "text" DEFAULT 'notice'::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "outcome" "text",
    "notes" "text",
    "stage_history" "jsonb" DEFAULT '[]'::"jsonb",
    "total_costs" numeric(12,2) DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: hoa_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."hoa_payments" (
    "id" integer NOT NULL,
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "property" "text" DEFAULT ''::"text",
    "hoa_name" "text" DEFAULT ''::"text",
    "amount" numeric DEFAULT 0,
    "due_date" "text" DEFAULT ''::"text",
    "frequency" "text" DEFAULT 'monthly'::"text",
    "status" "text" DEFAULT 'pending'::"text",
    "paid_date" "text",
    "notes" "text" DEFAULT ''::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "property_id" integer,
    "archived_at" timestamp with time zone,
    "archived_by" "text",
    "website" "text" DEFAULT ''::"text",
    "username_encrypted" "text" DEFAULT ''::"text",
    "password_encrypted" "text" DEFAULT ''::"text",
    "encryption_iv" "text" DEFAULT ''::"text",
    "encryption_salt" "text",
    "encryption_iv_username" "text"
);


--
-- Name: hoa_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."hoa_payments_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hoa_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."hoa_payments_id_seq" OWNED BY "public"."hoa_payments"."id";


--
-- Name: inspections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."inspections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "property" "text",
    "date" "text",
    "type" "text",
    "status" "text" DEFAULT 'scheduled'::"text",
    "inspector" "text",
    "notes" "text",
    "checklist" "jsonb",
    "created_at" timestamp without time zone DEFAULT "now"(),
    "company_id" "text" DEFAULT 'sandbox-llc'::"text"
);


--
-- Name: journal_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."journal_entries" (
    "id" integer NOT NULL,
    "date" "date" DEFAULT "now"(),
    "account" "text",
    "description" "text",
    "debit" numeric DEFAULT 0,
    "credit" numeric DEFAULT 0,
    "created_at" timestamp without time zone DEFAULT "now"(),
    "property" "text"
);


--
-- Name: journal_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."journal_entries_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: journal_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."journal_entries_id_seq" OWNED BY "public"."journal_entries"."id";


--
-- Name: journal_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."journal_number_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: late_fee_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."late_fee_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text",
    "grace_days" integer,
    "fee_amount" numeric,
    "fee_type" "text",
    "apply_to" "text",
    "created_at" timestamp without time zone DEFAULT "now"(),
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "archived_at" timestamp with time zone,
    "archived_by" "text"
);


--
-- Name: lease_signatures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."lease_signatures" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid",
    "signer_name" "text" NOT NULL,
    "signer_email" "text" DEFAULT ''::"text",
    "signer_role" "text" DEFAULT 'tenant'::"text",
    "status" "text" DEFAULT 'pending'::"text",
    "signed_at" timestamp with time zone,
    "ip_address" "text" DEFAULT ''::"text",
    "signature_data" "text" DEFAULT ''::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "user_agent" "text" DEFAULT ''::"text",
    "integrity_hash" "text",
    "auth_user_id" "uuid",
    "consent_text" "text",
    "signing_method" "text" DEFAULT 'typed'::"text",
    "verified_server_side" boolean DEFAULT false,
    CONSTRAINT "lease_signatures_signer_role_check" CHECK (("signer_role" = ANY (ARRAY['tenant'::"text", 'landlord'::"text", 'witness'::"text"]))),
    CONSTRAINT "lease_signatures_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'signed'::"text", 'declined'::"text"])))
);


--
-- Name: lease_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."lease_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text",
    "clauses" "text" DEFAULT ''::"text",
    "special_terms" "text" DEFAULT ''::"text",
    "default_deposit_months" numeric(3,1) DEFAULT 1,
    "default_lease_months" integer DEFAULT 12,
    "default_escalation_pct" numeric(5,2) DEFAULT 3,
    "payment_due_day" integer DEFAULT 1,
    "move_in_checklist" "jsonb" DEFAULT '["Keys handed over", "Smoke detectors tested", "Appliances working", "Walls condition documented", "Floors condition documented", "Plumbing checked", "Electrical checked", "Windows & doors checked", "HVAC filter replaced", "Photos taken"]'::"jsonb",
    "move_out_checklist" "jsonb" DEFAULT '["Keys returned", "All personal items removed", "Unit cleaned", "Walls patched/repaired", "Appliances clean", "Carpets cleaned", "Final inspection done", "Forwarding address collected", "Utilities transferred", "Security deposit review"]'::"jsonb",
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "company_id" "text" DEFAULT 'sandbox-llc'::"text"
);


--
-- Name: leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."leases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" integer,
    "tenant_name" "text" NOT NULL,
    "property" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text",
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "rent_amount" numeric(10,2) NOT NULL,
    "rent_escalation_pct" numeric(5,2) DEFAULT 0,
    "escalation_frequency" "text" DEFAULT 'annual'::"text",
    "payment_due_day" integer DEFAULT 1,
    "security_deposit" numeric(10,2) DEFAULT 0,
    "deposit_status" "text" DEFAULT 'held'::"text",
    "deposit_returned" numeric(10,2) DEFAULT 0,
    "deposit_return_date" "date",
    "deposit_deductions" "text" DEFAULT ''::"text",
    "lease_type" "text" DEFAULT 'fixed'::"text",
    "clauses" "text" DEFAULT ''::"text",
    "special_terms" "text" DEFAULT ''::"text",
    "auto_renew" boolean DEFAULT false,
    "renewal_notice_days" integer DEFAULT 60,
    "renewed_from" "uuid",
    "document_url" "text" DEFAULT ''::"text",
    "move_in_checklist" "jsonb" DEFAULT '[]'::"jsonb",
    "move_out_checklist" "jsonb" DEFAULT '[]'::"jsonb",
    "move_in_completed" boolean DEFAULT false,
    "move_out_completed" boolean DEFAULT false,
    "created_by" "text" DEFAULT ''::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "signature_status" "text" DEFAULT 'unsigned'::"text",
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "late_fee_amount" numeric DEFAULT 50,
    "late_fee_type" "text" DEFAULT 'flat'::"text",
    "late_fee_grace_days" integer DEFAULT 5,
    "rent_increase_history" "text" DEFAULT '[]'::"text",
    "property_id" integer,
    "archived_at" timestamp with time zone,
    "archived_by" "text",
    CONSTRAINT "chk_lease_late_fee_type" CHECK ((("late_fee_type" IS NULL) OR ("late_fee_type" = ANY (ARRAY['flat'::"text", 'percent'::"text"])))),
    CONSTRAINT "leases_deposit_status_check" CHECK (("deposit_status" = ANY (ARRAY['held'::"text", 'partial_return'::"text", 'returned'::"text", 'forfeited'::"text"]))),
    CONSTRAINT "leases_lease_type_check" CHECK (("lease_type" = ANY (ARRAY['fixed'::"text", 'month_to_month'::"text", 'renewal'::"text"]))),
    CONSTRAINT "leases_signature_status_check" CHECK (("signature_status" = ANY (ARRAY['unsigned'::"text", 'pending'::"text", 'partially_signed'::"text", 'fully_signed'::"text"]))),
    CONSTRAINT "leases_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'active'::"text", 'expired'::"text", 'renewed'::"text", 'terminated'::"text"])))
);


--
-- Name: ledger_entries_legacy_table; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ledger_entries_legacy_table" (
    "id" integer NOT NULL,
    "tenant" "text",
    "property" "text",
    "date" "date" DEFAULT "now"(),
    "description" "text",
    "amount" numeric,
    "type" "text",
    "balance" numeric DEFAULT 0,
    "created_at" timestamp without time zone DEFAULT "now"(),
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "property_id" integer,
    "tenant_id" bigint,
    "journal_entry_id" "text"
);


--
-- Name: ledger_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."ledger_entries_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ledger_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."ledger_entries_id_seq" OWNED BY "public"."ledger_entries_legacy_table"."id";


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."messages" (
    "id" integer NOT NULL,
    "tenant" "text",
    "property" "text",
    "sender" "text",
    "message" "text",
    "read" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "tenant_id" bigint,
    "sender_email" "text",
    "sender_role" "text",
    "read_at" timestamp with time zone,
    "attachment_url" "text",
    "attachment_name" "text"
);


--
-- Name: messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."messages_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."messages_id_seq" OWNED BY "public"."messages"."id";


--
-- Name: notification_inbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."notification_inbox" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "icon" "text" DEFAULT '📬'::"text",
    "message" "text" NOT NULL,
    "recipient_email" "text" DEFAULT ''::"text",
    "notification_type" "text" DEFAULT 'general'::"text",
    "read" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: notification_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."notification_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_type" "text" NOT NULL,
    "recipient_email" "text" NOT NULL,
    "subject" "text" DEFAULT ''::"text",
    "message" "text" DEFAULT ''::"text",
    "status" "text" DEFAULT 'sent'::"text",
    "related_id" "text" DEFAULT ''::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    CONSTRAINT "notification_log_status_check" CHECK (("status" = ANY (ARRAY['sent'::"text", 'failed'::"text", 'pending'::"text"])))
);


--
-- Name: notification_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."notification_queue" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "type" "text" DEFAULT 'general'::"text" NOT NULL,
    "recipient_email" "text" NOT NULL,
    "data" "jsonb",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "error_message" "text",
    "processed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "cc" "jsonb" DEFAULT '[]'::"jsonb",
    "bcc" "jsonb" DEFAULT '[]'::"jsonb",
    "scheduled_for" timestamp with time zone
);


--
-- Name: notification_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."notification_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_type" "text" NOT NULL,
    "enabled" boolean DEFAULT true,
    "recipients" "text" DEFAULT 'admin'::"text",
    "days_before" integer DEFAULT 0,
    "template" "text" DEFAULT ''::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "channels" "jsonb" DEFAULT '{"push": false, "email": true, "in_app": true}'::"jsonb",
    "subject_template" "text",
    "custom_recipients" "jsonb" DEFAULT '[]'::"jsonb",
    "cc" "jsonb" DEFAULT '[]'::"jsonb",
    "bcc" "jsonb" DEFAULT '[]'::"jsonb",
    "quiet_hours_start" time without time zone,
    "quiet_hours_end" time without time zone,
    "quiet_hours_tz" "text" DEFAULT 'America/New_York'::"text",
    "severity" "text" DEFAULT 'normal'::"text",
    "extra_vars" "jsonb" DEFAULT '[]'::"jsonb",
    CONSTRAINT "notification_settings_severity_check" CHECK (("severity" = ANY (ARRAY['low'::"text", 'normal'::"text", 'high'::"text"])))
);


--
-- Name: notification_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."notification_templates" (
    "id" integer NOT NULL,
    "name" "text" DEFAULT ''::"text",
    "event_type" "text" DEFAULT ''::"text",
    "subject" "text" DEFAULT ''::"text",
    "body" "text" DEFAULT ''::"text",
    "is_active" boolean DEFAULT true,
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: notification_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."notification_templates_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notification_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."notification_templates_id_seq" OWNED BY "public"."notification_templates"."id";


--
-- Name: owner_distributions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."owner_distributions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid",
    "statement_id" "uuid",
    "amount" numeric(12,2) NOT NULL,
    "method" "text" DEFAULT 'check'::"text",
    "reference" "text" DEFAULT ''::"text",
    "date" "date" DEFAULT CURRENT_DATE,
    "notes" "text" DEFAULT ''::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "company_id" "text" DEFAULT 'sandbox-llc'::"text"
);


--
-- Name: owner_statements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."owner_statements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid",
    "owner_name" "text" NOT NULL,
    "period" "text" NOT NULL,
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "total_income" numeric(12,2) DEFAULT 0,
    "total_expenses" numeric(12,2) DEFAULT 0,
    "management_fee" numeric(12,2) DEFAULT 0,
    "net_to_owner" numeric(12,2) DEFAULT 0,
    "line_items" "jsonb" DEFAULT '[]'::"jsonb",
    "status" "text" DEFAULT 'draft'::"text",
    "sent_date" "date",
    "paid_date" "date",
    "notes" "text" DEFAULT ''::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    CONSTRAINT "owner_statements_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'sent'::"text", 'paid'::"text"])))
);


--
-- Name: owners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."owners" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "email" "text",
    "phone" "text" DEFAULT ''::"text",
    "address" "text" DEFAULT ''::"text",
    "company" "text" DEFAULT ''::"text",
    "tax_id" "text" DEFAULT ''::"text",
    "payment_method" "text" DEFAULT 'check'::"text",
    "bank_name" "text" DEFAULT ''::"text",
    "bank_routing" "text" DEFAULT ''::"text",
    "bank_account" "text" DEFAULT ''::"text",
    "management_fee_pct" numeric(5,2) DEFAULT 10,
    "notes" "text" DEFAULT ''::"text",
    "status" "text" DEFAULT 'active'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "portal_enabled" boolean DEFAULT false,
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "first_name" "text" DEFAULT ''::"text",
    "middle_initial" "text" DEFAULT ''::"text",
    "last_name" "text" DEFAULT ''::"text",
    "archived_at" timestamp with time zone,
    "archived_by" "text",
    CONSTRAINT "owners_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'inactive'::"text"])))
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."payments" (
    "id" integer NOT NULL,
    "tenant" "text",
    "property" "text",
    "amount" numeric,
    "date" "date" DEFAULT "now"(),
    "type" "text" DEFAULT 'rent'::"text",
    "method" "text",
    "status" "text" DEFAULT 'unpaid'::"text",
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "property_id" integer,
    "archived_at" timestamp with time zone,
    "stripe_session_id" "text",
    "paid_at" timestamp with time zone
);


--
-- Name: payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."payments_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."payments_id_seq" OWNED BY "public"."payments"."id";


--
-- Name: plaid_sync_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."plaid_sync_event" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "bank_connection_id" "uuid",
    "started_at" timestamp with time zone DEFAULT "now"(),
    "completed_at" timestamp with time zone,
    "sync_cursor_before" "text",
    "sync_cursor_after" "text",
    "added_count" integer DEFAULT 0,
    "modified_count" integer DEFAULT 0,
    "removed_count" integer DEFAULT 0,
    "status" "text" DEFAULT 'syncing'::"text",
    "error_json" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "plaid_sync_event_status_check" CHECK (("status" = ANY (ARRAY['syncing'::"text", 'success'::"text", 'partial_success'::"text", 'failed'::"text", 'requires_reauth'::"text"])))
);


--
-- Name: pm_assignment_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."pm_assignment_requests" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "owner_company_id" "text" NOT NULL,
    "pm_company_id" "text" NOT NULL,
    "pm_company_name" "text" NOT NULL,
    "property_id" "text" NOT NULL,
    "property_address" "text" NOT NULL,
    "requested_by" "text" NOT NULL,
    "requested_at" timestamp with time zone DEFAULT "now"(),
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reviewed_by" "text",
    "reviewed_at" timestamp with time zone,
    "review_note" "text" DEFAULT ''::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "pm_assignment_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'declined'::"text", 'cancelled'::"text"])))
);


--
-- Name: properties; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."properties" (
    "id" integer NOT NULL,
    "address" "text" NOT NULL,
    "type" "text",
    "status" "text" DEFAULT 'vacant'::"text",
    "rent" numeric,
    "tenant" "text",
    "lease_end" "date",
    "last_inspection" "date",
    "owner_id" "uuid",
    "owner_name" "text" DEFAULT ''::"text",
    "notes" "text" DEFAULT ''::"text",
    "bedrooms" integer,
    "bathrooms" integer,
    "sqft" integer,
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "pm_company_id" "text",
    "pm_company_name" "text",
    "address_line_1" "text" DEFAULT ''::"text",
    "address_line_2" "text" DEFAULT ''::"text",
    "city" "text" DEFAULT ''::"text",
    "state" "text" DEFAULT ''::"text",
    "zip" "text" DEFAULT ''::"text",
    "security_deposit" numeric DEFAULT 0,
    "lease_start" "text" DEFAULT ''::"text",
    "archived_at" timestamp with time zone,
    "archived_by" "text",
    "class_id" "text",
    "tenant_2" "text" DEFAULT ''::"text",
    "tenant_2_email" "text" DEFAULT ''::"text",
    "tenant_2_phone" "text" DEFAULT ''::"text",
    "tenant_3" "text" DEFAULT ''::"text",
    "tenant_3_email" "text" DEFAULT ''::"text",
    "tenant_3_phone" "text" DEFAULT ''::"text",
    "tenant_4" "text" DEFAULT ''::"text",
    "tenant_4_email" "text" DEFAULT ''::"text",
    "tenant_4_phone" "text" DEFAULT ''::"text",
    "tenant_5" "text" DEFAULT ''::"text",
    "tenant_5_email" "text" DEFAULT ''::"text",
    "tenant_5_phone" "text" DEFAULT ''::"text",
    "county" "text"
);


--
-- Name: properties_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."properties_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: properties_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."properties_id_seq" OWNED BY "public"."properties"."id";


--
-- Name: property_change_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."property_change_requests" (
    "id" integer NOT NULL,
    "request_type" "text" DEFAULT 'add'::"text" NOT NULL,
    "property_id" integer,
    "requested_by" "text" NOT NULL,
    "requested_at" timestamp with time zone DEFAULT "now"(),
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reviewed_by" "text",
    "reviewed_at" timestamp with time zone,
    "review_note" "text" DEFAULT ''::"text",
    "address" "text" NOT NULL,
    "type" "text" DEFAULT 'Single Family'::"text",
    "property_status" "text" DEFAULT 'vacant'::"text",
    "rent" "text" DEFAULT '0'::"text",
    "tenant" "text" DEFAULT ''::"text",
    "lease_end" "text" DEFAULT ''::"text",
    "notes" "text" DEFAULT ''::"text",
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "approver_email" "text"
);


--
-- Name: property_change_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."property_change_requests_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: property_change_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."property_change_requests_id_seq" OWNED BY "public"."property_change_requests"."id";


--
-- Name: property_insurance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."property_insurance" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "property" "text" NOT NULL,
    "property_id" "text",
    "provider" "text",
    "policy_number" "text",
    "premium_amount" numeric DEFAULT 0,
    "premium_frequency" "text" DEFAULT 'annual'::"text",
    "coverage_amount" numeric DEFAULT 0,
    "expiration_date" "date",
    "notes" "text",
    "archived_at" timestamp with time zone,
    "archived_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "website" "text" DEFAULT ''::"text",
    "username_encrypted" "text" DEFAULT ''::"text",
    "password_encrypted" "text" DEFAULT ''::"text",
    "encryption_iv" "text" DEFAULT ''::"text",
    "encryption_salt" "text",
    "encryption_iv_username" "text"
);


--
-- Name: property_licenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."property_licenses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "property_id" integer NOT NULL,
    "license_type" "text" NOT NULL,
    "license_type_custom" "text",
    "license_number" "text",
    "jurisdiction" "text",
    "issue_date" "date",
    "expiry_date" "date" NOT NULL,
    "fee_amount" numeric(10,2),
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "document_id" "uuid",
    "notes" "text",
    "last_reminder_sent_at" timestamp with time zone,
    "last_reminder_day_bucket" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "archived_at" timestamp with time zone,
    "archived_by" "text"
);


--
-- Name: property_loans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."property_loans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "property" "text" NOT NULL,
    "property_id" "text",
    "lender_name" "text" NOT NULL,
    "loan_type" "text" DEFAULT 'conventional'::"text",
    "original_amount" numeric DEFAULT 0,
    "current_balance" numeric DEFAULT 0,
    "interest_rate" numeric DEFAULT 0,
    "monthly_payment" numeric DEFAULT 0,
    "escrow_included" boolean DEFAULT false,
    "escrow_amount" numeric DEFAULT 0,
    "escrow_covers" "jsonb" DEFAULT '[]'::"jsonb",
    "loan_start_date" "date",
    "maturity_date" "date",
    "account_number" "text",
    "status" "text" DEFAULT 'active'::"text",
    "notes" "text",
    "archived_at" timestamp with time zone,
    "archived_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "website" "text" DEFAULT ''::"text",
    "username_encrypted" "text" DEFAULT ''::"text",
    "password_encrypted" "text" DEFAULT ''::"text",
    "encryption_iv" "text" DEFAULT ''::"text",
    "encryption_salt" "text",
    "encryption_iv_username" "text"
);


--
-- Name: property_setup_wizard; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."property_setup_wizard" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "property_id" "text",
    "property_address" "text",
    "current_step" integer DEFAULT 1,
    "completed_steps" "jsonb" DEFAULT '[]'::"jsonb",
    "wizard_data" "jsonb" DEFAULT '{}'::"jsonb",
    "status" "text" DEFAULT 'in_progress'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "completed_at" timestamp with time zone,
    "skipped_approved_steps" "jsonb" DEFAULT '[]'::"jsonb"
);


--
-- Name: property_tax_bills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."property_tax_bills" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "property" "text" NOT NULL,
    "property_id" integer,
    "tax_year" integer NOT NULL,
    "installment_label" "text" NOT NULL,
    "due_date" "date" NOT NULL,
    "expected_amount" numeric,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "paid_date" "date",
    "paid_amount" numeric,
    "paid_notes" "text",
    "auto_generated" boolean DEFAULT true NOT NULL,
    "last_reminder_sent_at" timestamp with time zone,
    "last_reminder_day_bucket" integer,
    "archived_at" timestamp with time zone,
    "archived_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "property_tax_bills_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'paid'::"text", 'skipped'::"text", 'voided'::"text"])))
);


--
-- Name: property_taxes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."property_taxes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "property" "text" NOT NULL,
    "property_id" integer,
    "county" "text",
    "jurisdiction" "text",
    "parcel_id" "text",
    "assessed_value" numeric DEFAULT 0,
    "tax_year" integer,
    "annual_tax_amount" numeric DEFAULT 0 NOT NULL,
    "billing_frequency" "text" DEFAULT 'semi_annual'::"text",
    "next_due_date" "date",
    "exemptions" "text",
    "escrow_paid_by_lender" boolean DEFAULT false,
    "records_url" "text",
    "notes" "text",
    "archived_at" timestamp with time zone,
    "archived_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "property_taxes_billing_frequency_check" CHECK (("billing_frequency" = ANY (ARRAY['annual'::"text", 'semi_annual'::"text", 'quarterly'::"text", 'monthly'::"text"])))
);


--
-- Name: push_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."push_attempts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "caller_email" "text",
    "recipient_email" "text" NOT NULL,
    "title" "text",
    "body" "text",
    "status" "text" NOT NULL,
    "delivered_count" integer DEFAULT 0,
    "pruned_count" integer DEFAULT 0,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "payload_tag" "text"
);


--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."push_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "user_email" "text" NOT NULL,
    "subscription" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "last_sw_received_at" timestamp with time zone,
    "last_dispatch_at" timestamp with time zone,
    "dead_marked_at" timestamp with time zone
);


--
-- Name: recurring_journal_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."recurring_journal_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "description" "text" NOT NULL,
    "frequency" "text" DEFAULT 'monthly'::"text" NOT NULL,
    "day_of_month" integer DEFAULT 1 NOT NULL,
    "amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "tenant_name" "text",
    "tenant_id" bigint,
    "property" "text",
    "debit_account_id" "text" DEFAULT '1200'::"text",
    "debit_account_name" "text" DEFAULT 'Accounts Receivable'::"text",
    "credit_account_id" "text" DEFAULT '4000'::"text",
    "credit_account_name" "text" DEFAULT 'Rental Income'::"text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "next_post_date" "date",
    "last_posted_at" timestamp with time zone,
    "late_fee_enabled" boolean DEFAULT true,
    "grace_period_days" integer DEFAULT 5,
    "late_fee_amount" numeric(12,2) DEFAULT 50,
    "late_fee_pct" numeric(5,2),
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "last_posted_date" "date",
    "archived_at" timestamp with time zone,
    "archived_by" "text",
    CONSTRAINT "recurring_je_tenant_pair_check" CHECK (((("tenant_name" IS NULL) OR ("tenant_name" = ''::"text")) = ("tenant_id" IS NULL)))
);


--
-- Name: tenant_invite_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."tenant_invite_codes" (
    "id" integer NOT NULL,
    "code" "text" NOT NULL,
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "property" "text" DEFAULT ''::"text",
    "tenant_id" integer,
    "tenant_name" "text" DEFAULT ''::"text",
    "tenant_email" "text" DEFAULT ''::"text",
    "created_by" "text" DEFAULT ''::"text",
    "used" boolean DEFAULT false,
    "used_by" "text",
    "used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: tenant_invite_codes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."tenant_invite_codes_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tenant_invite_codes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."tenant_invite_codes_id_seq" OWNED BY "public"."tenant_invite_codes"."id";


--
-- Name: tenants_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."tenants_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tenants_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."tenants_id_seq" OWNED BY "public"."tenants"."id";


--
-- Name: utilities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."utilities" (
    "id" integer NOT NULL,
    "property" "text",
    "provider" "text",
    "amount" numeric,
    "due" "date",
    "responsibility" "text" DEFAULT 'owner'::"text",
    "status" "text" DEFAULT 'pending'::"text",
    "due_date" "date",
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "property_id" integer,
    "archived_at" timestamp with time zone,
    "website" "text" DEFAULT ''::"text",
    "username_encrypted" "text" DEFAULT ''::"text",
    "password_encrypted" "text" DEFAULT ''::"text",
    "encryption_iv" "text" DEFAULT ''::"text",
    "encryption_salt" "text",
    "encryption_iv_username" "text"
);


--
-- Name: utilities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."utilities_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: utilities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."utilities_id_seq" OWNED BY "public"."utilities"."id";


--
-- Name: utility_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."utility_accounts" (
    "id" integer NOT NULL,
    "company_id" "text" NOT NULL,
    "property" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "provider_display" "text" NOT NULL,
    "account_number" "text" DEFAULT ''::"text",
    "username_encrypted" "text" NOT NULL,
    "password_encrypted" "text" NOT NULL,
    "encryption_iv" "text" NOT NULL,
    "login_url" "text" DEFAULT ''::"text",
    "account_type" "text" DEFAULT 'electric'::"text",
    "check_frequency" "text" DEFAULT 'weekly'::"text",
    "last_checked_at" timestamp with time zone,
    "last_check_status" "text" DEFAULT 'never'::"text",
    "last_check_error" "text" DEFAULT ''::"text",
    "two_factor_method" "text" DEFAULT 'none'::"text",
    "is_active" boolean DEFAULT true,
    "notes" "text" DEFAULT ''::"text",
    "archived_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "encryption_salt" "text",
    "encryption_iv_username" "text"
);


--
-- Name: utility_accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."utility_accounts_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: utility_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."utility_accounts_id_seq" OWNED BY "public"."utility_accounts"."id";


--
-- Name: utility_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."utility_audit" (
    "id" bigint NOT NULL,
    "utility_id" bigint,
    "property" "text",
    "provider" "text",
    "amount" numeric,
    "action" "text",
    "paid_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "company_id" "text" DEFAULT 'sandbox-llc'::"text"
);


--
-- Name: utility_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE "public"."utility_audit" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."utility_audit_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: utility_bills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."utility_bills" (
    "id" integer NOT NULL,
    "company_id" "text" NOT NULL,
    "utility_account_id" integer,
    "property" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "provider_display" "text" DEFAULT ''::"text",
    "bill_date" "text",
    "due_date" "text",
    "amount" numeric DEFAULT 0 NOT NULL,
    "pdf_storage_path" "text" DEFAULT ''::"text",
    "status" "text" DEFAULT 'pending_review'::"text",
    "payment_methods_available" "jsonb" DEFAULT '[]'::"jsonb",
    "payment_method_selected" "text" DEFAULT ''::"text",
    "payment_confirmation" "text" DEFAULT ''::"text",
    "payment_screenshot_path" "text" DEFAULT ''::"text",
    "paid_at" timestamp with time zone,
    "authorized_by" "text" DEFAULT ''::"text",
    "authorized_at" timestamp with time zone,
    "je_id" "text" DEFAULT ''::"text",
    "error_message" "text" DEFAULT ''::"text",
    "archived_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: utility_bills_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."utility_bills_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: utility_bills_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."utility_bills_id_seq" OWNED BY "public"."utility_bills"."id";


--
-- Name: utility_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."utility_providers" (
    "id" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "login_url" "text" NOT NULL,
    "region" "text" DEFAULT ''::"text",
    "account_type" "text" DEFAULT 'electric'::"text",
    "supports_2fa" boolean DEFAULT false,
    "two_factor_methods" "text"[] DEFAULT '{}'::"text"[],
    "is_active" boolean DEFAULT true,
    "notes" "text" DEFAULT ''::"text"
);


--
-- Name: vendor_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."vendor_invoices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "vendor_id" "uuid",
    "vendor_name" "text" NOT NULL,
    "work_order_id" "uuid",
    "property" "text" DEFAULT ''::"text",
    "description" "text" DEFAULT ''::"text",
    "amount" numeric(10,2) NOT NULL,
    "invoice_number" "text" DEFAULT ''::"text",
    "invoice_date" "date" DEFAULT CURRENT_DATE,
    "due_date" "date",
    "status" "text" DEFAULT 'pending'::"text",
    "paid_date" "date",
    "payment_method" "text" DEFAULT ''::"text",
    "notes" "text" DEFAULT ''::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    CONSTRAINT "vendor_invoices_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'paid'::"text", 'disputed'::"text"])))
);


--
-- Name: vendors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."vendors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "company" "text" DEFAULT ''::"text",
    "email" "text" DEFAULT ''::"text",
    "phone" "text" DEFAULT ''::"text",
    "address" "text" DEFAULT ''::"text",
    "specialty" "text" DEFAULT 'General'::"text",
    "license_number" "text" DEFAULT ''::"text",
    "insurance_expiry" "date",
    "hourly_rate" numeric(10,2) DEFAULT 0,
    "flat_rate" numeric(10,2) DEFAULT 0,
    "rating" integer DEFAULT 0,
    "notes" "text" DEFAULT ''::"text",
    "status" "text" DEFAULT 'active'::"text",
    "total_jobs" integer DEFAULT 0,
    "total_paid" numeric(12,2) DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "archived_at" timestamp with time zone,
    "archived_by" "text",
    "first_name" "text" DEFAULT ''::"text",
    "middle_initial" "text" DEFAULT ''::"text",
    "last_name" "text" DEFAULT ''::"text",
    CONSTRAINT "vendors_rating_check" CHECK ((("rating" >= 0) AND ("rating" <= 5))),
    CONSTRAINT "vendors_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'inactive'::"text", 'preferred'::"text", 'blocked'::"text"])))
);


--
-- Name: work_order_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."work_order_photos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "work_order_id" "uuid",
    "property" "text",
    "url" "text",
    "caption" "text",
    "created_at" timestamp without time zone DEFAULT "now"(),
    "company_id" "text" DEFAULT 'sandbox-llc'::"text"
);


--
-- Name: work_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."work_orders" (
    "id" integer NOT NULL,
    "property" "text",
    "tenant" "text",
    "issue" "text",
    "priority" "text" DEFAULT 'normal'::"text",
    "status" "text" DEFAULT 'open'::"text",
    "created" "date" DEFAULT "now"(),
    "assigned" "text",
    "cost" numeric DEFAULT 0,
    "vendor_id" "uuid",
    "vendor_name" "text" DEFAULT ''::"text",
    "notes" "text" DEFAULT ''::"text",
    "company_id" "text" DEFAULT 'sandbox-llc'::"text",
    "property_id" integer,
    "archived_at" timestamp with time zone,
    "archived_by" "text"
);


--
-- Name: work_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."work_orders_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: work_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."work_orders_id_seq" OWNED BY "public"."work_orders"."id";


--
-- Name: acct_journal_lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."acct_journal_lines" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."acct_journal_lines_id_seq"'::"regclass");


--
-- Name: audit_trail id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."audit_trail" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."audit_trail_id_seq"'::"regclass");


--
-- Name: automation_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."automation_jobs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."automation_jobs_id_seq"'::"regclass");


--
-- Name: company_members id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."company_members" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."company_members_id_seq"'::"regclass");


--
-- Name: hoa_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hoa_payments" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."hoa_payments_id_seq"'::"regclass");


--
-- Name: journal_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."journal_entries" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."journal_entries_id_seq"'::"regclass");


--
-- Name: ledger_entries_legacy_table id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ledger_entries_legacy_table" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."ledger_entries_id_seq"'::"regclass");


--
-- Name: messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."messages" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."messages_id_seq"'::"regclass");


--
-- Name: notification_templates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."notification_templates" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."notification_templates_id_seq"'::"regclass");


--
-- Name: payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payments" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."payments_id_seq"'::"regclass");


--
-- Name: properties id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."properties" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."properties_id_seq"'::"regclass");


--
-- Name: property_change_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."property_change_requests" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."property_change_requests_id_seq"'::"regclass");


--
-- Name: tenant_invite_codes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tenant_invite_codes" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."tenant_invite_codes_id_seq"'::"regclass");


--
-- Name: tenants id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tenants" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."tenants_id_seq"'::"regclass");


--
-- Name: utilities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."utilities" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."utilities_id_seq"'::"regclass");


--
-- Name: utility_accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."utility_accounts" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."utility_accounts_id_seq"'::"regclass");


--
-- Name: utility_bills id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."utility_bills" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."utility_bills_id_seq"'::"regclass");


--
-- Name: work_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_orders" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."work_orders_id_seq"'::"regclass");


--
-- Name: accounting_period_lock accounting_period_lock_company_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."accounting_period_lock"
    ADD CONSTRAINT "accounting_period_lock_company_id_key" UNIQUE ("company_id");


--
-- Name: accounting_period_lock accounting_period_lock_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."accounting_period_lock"
    ADD CONSTRAINT "accounting_period_lock_pkey" PRIMARY KEY ("id");


--
-- Name: acct_accounts acct_accounts_company_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."acct_accounts"
    ADD CONSTRAINT "acct_accounts_company_code_unique" UNIQUE ("company_id", "code");


--
-- Name: acct_accounts acct_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."acct_accounts"
    ADD CONSTRAINT "acct_accounts_pkey" PRIMARY KEY ("id");


--
-- Name: acct_classes acct_classes_company_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."acct_classes"
    ADD CONSTRAINT "acct_classes_company_name_unique" UNIQUE ("company_id", "name");


--
-- Name: acct_classes acct_classes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."acct_classes"
    ADD CONSTRAINT "acct_classes_pkey" PRIMARY KEY ("id");


--
-- Name: acct_journal_entries acct_journal_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."acct_journal_entries"
    ADD CONSTRAINT "acct_journal_entries_pkey" PRIMARY KEY ("id");


--
-- Name: acct_journal_lines acct_journal_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."acct_journal_lines"
    ADD CONSTRAINT "acct_journal_lines_pkey" PRIMARY KEY ("id");


--
-- Name: app_users app_users_email_company_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."app_users"
    ADD CONSTRAINT "app_users_email_company_unique" UNIQUE ("email", "company_id");


--
-- Name: app_users app_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."app_users"
    ADD CONSTRAINT "app_users_pkey" PRIMARY KEY ("id");


--
-- Name: audit_trail audit_trail_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."audit_trail"
    ADD CONSTRAINT "audit_trail_pkey" PRIMARY KEY ("id");


--
-- Name: automation_jobs automation_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."automation_jobs"
    ADD CONSTRAINT "automation_jobs_pkey" PRIMARY KEY ("id");


--
-- Name: autopay_schedules autopay_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."autopay_schedules"
    ADD CONSTRAINT "autopay_schedules_pkey" PRIMARY KEY ("id");


--
-- Name: bank_account_feed bank_account_feed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_account_feed"
    ADD CONSTRAINT "bank_account_feed_pkey" PRIMARY KEY ("id");


--
-- Name: bank_connection bank_connection_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_connection"
    ADD CONSTRAINT "bank_connection_pkey" PRIMARY KEY ("id");


--
-- Name: bank_feed_transaction_link bank_feed_transaction_link_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_feed_transaction_link"
    ADD CONSTRAINT "bank_feed_transaction_link_pkey" PRIMARY KEY ("id");


--
-- Name: bank_feed_transaction bank_feed_transaction_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_feed_transaction"
    ADD CONSTRAINT "bank_feed_transaction_pkey" PRIMARY KEY ("id");


--
-- Name: bank_import_batch bank_import_batch_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_import_batch"
    ADD CONSTRAINT "bank_import_batch_pkey" PRIMARY KEY ("id");


--
-- Name: bank_import_mapping_profile bank_import_mapping_profile_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_import_mapping_profile"
    ADD CONSTRAINT "bank_import_mapping_profile_pkey" PRIMARY KEY ("id");


--
-- Name: bank_posting_decision_line bank_posting_decision_line_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_posting_decision_line"
    ADD CONSTRAINT "bank_posting_decision_line_pkey" PRIMARY KEY ("id");


--
-- Name: bank_posting_decision bank_posting_decision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_posting_decision"
    ADD CONSTRAINT "bank_posting_decision_pkey" PRIMARY KEY ("id");


--
-- Name: bank_reconciliations bank_reconciliations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_reconciliations"
    ADD CONSTRAINT "bank_reconciliations_pkey" PRIMARY KEY ("id");


--
-- Name: bank_transaction_rule bank_transaction_rule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_transaction_rule"
    ADD CONSTRAINT "bank_transaction_rule_pkey" PRIMARY KEY ("id");


--
-- Name: budgets budgets_company_id_account_id_period_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_company_id_account_id_period_key" UNIQUE ("company_id", "account_id", "period");


--
-- Name: budgets budgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_pkey" PRIMARY KEY ("id");


--
-- Name: companies companies_company_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."companies"
    ADD CONSTRAINT "companies_company_code_key" UNIQUE ("company_code");


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."companies"
    ADD CONSTRAINT "companies_pkey" PRIMARY KEY ("id");


--
-- Name: company_members company_members_company_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."company_members"
    ADD CONSTRAINT "company_members_company_email_unique" UNIQUE ("company_id", "user_email");


--
-- Name: company_members company_members_company_id_user_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."company_members"
    ADD CONSTRAINT "company_members_company_id_user_email_key" UNIQUE ("company_id", "user_email");


--
-- Name: company_members company_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."company_members"
    ADD CONSTRAINT "company_members_pkey" PRIMARY KEY ("id");


--
-- Name: company_settings company_settings_company_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."company_settings"
    ADD CONSTRAINT "company_settings_company_id_key" UNIQUE ("company_id");


--
-- Name: company_settings company_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."company_settings"
    ADD CONSTRAINT "company_settings_pkey" PRIMARY KEY ("id");


--
-- Name: doc_exception_requests doc_exception_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."doc_exception_requests"
    ADD CONSTRAINT "doc_exception_requests_pkey" PRIMARY KEY ("id");


--
-- Name: doc_generated doc_generated_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."doc_generated"
    ADD CONSTRAINT "doc_generated_pkey" PRIMARY KEY ("id");


--
-- Name: doc_signature_audit_log doc_signature_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."doc_signature_audit_log"
    ADD CONSTRAINT "doc_signature_audit_log_pkey" PRIMARY KEY ("id");


--
-- Name: doc_signatures doc_signatures_access_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."doc_signatures"
    ADD CONSTRAINT "doc_signatures_access_token_key" UNIQUE ("access_token");


--
-- Name: doc_signatures doc_signatures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."doc_signatures"
    ADD CONSTRAINT "doc_signatures_pkey" PRIMARY KEY ("id");


--
-- Name: doc_templates doc_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."doc_templates"
    ADD CONSTRAINT "doc_templates_pkey" PRIMARY KEY ("id");


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_pkey" PRIMARY KEY ("id");


--
-- Name: error_log error_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."error_log"
    ADD CONSTRAINT "error_log_pkey" PRIMARY KEY ("id");


--
-- Name: eviction_cases eviction_cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."eviction_cases"
    ADD CONSTRAINT "eviction_cases_pkey" PRIMARY KEY ("id");


--
-- Name: hoa_payments hoa_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hoa_payments"
    ADD CONSTRAINT "hoa_payments_pkey" PRIMARY KEY ("id");


--
-- Name: inspections inspections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."inspections"
    ADD CONSTRAINT "inspections_pkey" PRIMARY KEY ("id");


--
-- Name: journal_entries journal_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."journal_entries"
    ADD CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id");


--
-- Name: late_fee_rules late_fee_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."late_fee_rules"
    ADD CONSTRAINT "late_fee_rules_pkey" PRIMARY KEY ("id");


--
-- Name: lease_signatures lease_signatures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."lease_signatures"
    ADD CONSTRAINT "lease_signatures_pkey" PRIMARY KEY ("id");


--
-- Name: lease_templates lease_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."lease_templates"
    ADD CONSTRAINT "lease_templates_pkey" PRIMARY KEY ("id");


--
-- Name: leases leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."leases"
    ADD CONSTRAINT "leases_pkey" PRIMARY KEY ("id");


--
-- Name: ledger_entries_legacy_table ledger_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ledger_entries_legacy_table"
    ADD CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id");


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");


--
-- Name: notification_inbox notification_inbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."notification_inbox"
    ADD CONSTRAINT "notification_inbox_pkey" PRIMARY KEY ("id");


--
-- Name: notification_log notification_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."notification_log"
    ADD CONSTRAINT "notification_log_pkey" PRIMARY KEY ("id");


--
-- Name: notification_queue notification_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."notification_queue"
    ADD CONSTRAINT "notification_queue_pkey" PRIMARY KEY ("id");


--
-- Name: notification_settings notification_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."notification_settings"
    ADD CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("id");


--
-- Name: notification_templates notification_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."notification_templates"
    ADD CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id");


--
-- Name: owner_distributions owner_distributions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."owner_distributions"
    ADD CONSTRAINT "owner_distributions_pkey" PRIMARY KEY ("id");


--
-- Name: owner_statements owner_statements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."owner_statements"
    ADD CONSTRAINT "owner_statements_pkey" PRIMARY KEY ("id");


--
-- Name: owners owners_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."owners"
    ADD CONSTRAINT "owners_email_key" UNIQUE ("email");


--
-- Name: owners owners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."owners"
    ADD CONSTRAINT "owners_pkey" PRIMARY KEY ("id");


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");


--
-- Name: plaid_sync_event plaid_sync_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."plaid_sync_event"
    ADD CONSTRAINT "plaid_sync_event_pkey" PRIMARY KEY ("id");


--
-- Name: pm_assignment_requests pm_assignment_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pm_assignment_requests"
    ADD CONSTRAINT "pm_assignment_requests_pkey" PRIMARY KEY ("id");


--
-- Name: properties properties_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."properties"
    ADD CONSTRAINT "properties_pkey" PRIMARY KEY ("id");


--
-- Name: property_change_requests property_change_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."property_change_requests"
    ADD CONSTRAINT "property_change_requests_pkey" PRIMARY KEY ("id");


--
-- Name: property_insurance property_insurance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."property_insurance"
    ADD CONSTRAINT "property_insurance_pkey" PRIMARY KEY ("id");


--
-- Name: property_licenses property_licenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."property_licenses"
    ADD CONSTRAINT "property_licenses_pkey" PRIMARY KEY ("id");


--
-- Name: property_loans property_loans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."property_loans"
    ADD CONSTRAINT "property_loans_pkey" PRIMARY KEY ("id");


--
-- Name: property_setup_wizard property_setup_wizard_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."property_setup_wizard"
    ADD CONSTRAINT "property_setup_wizard_pkey" PRIMARY KEY ("id");


--
-- Name: property_tax_bills property_tax_bills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."property_tax_bills"
    ADD CONSTRAINT "property_tax_bills_pkey" PRIMARY KEY ("id");


--
-- Name: property_taxes property_taxes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."property_taxes"
    ADD CONSTRAINT "property_taxes_pkey" PRIMARY KEY ("id");


--
-- Name: push_attempts push_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."push_attempts"
    ADD CONSTRAINT "push_attempts_pkey" PRIMARY KEY ("id");


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id");


--
-- Name: recurring_journal_entries recurring_journal_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."recurring_journal_entries"
    ADD CONSTRAINT "recurring_journal_entries_pkey" PRIMARY KEY ("id");


--
-- Name: tenant_invite_codes tenant_invite_codes_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tenant_invite_codes"
    ADD CONSTRAINT "tenant_invite_codes_code_key" UNIQUE ("code");


--
-- Name: tenant_invite_codes tenant_invite_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tenant_invite_codes"
    ADD CONSTRAINT "tenant_invite_codes_pkey" PRIMARY KEY ("id");


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tenants"
    ADD CONSTRAINT "tenants_pkey" PRIMARY KEY ("id");


--
-- Name: acct_journal_entries unique_je_number_per_company; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."acct_journal_entries"
    ADD CONSTRAINT "unique_je_number_per_company" UNIQUE ("company_id", "number");


--
-- Name: utilities utilities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."utilities"
    ADD CONSTRAINT "utilities_pkey" PRIMARY KEY ("id");


--
-- Name: utility_accounts utility_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."utility_accounts"
    ADD CONSTRAINT "utility_accounts_pkey" PRIMARY KEY ("id");


--
-- Name: utility_audit utility_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."utility_audit"
    ADD CONSTRAINT "utility_audit_pkey" PRIMARY KEY ("id");


--
-- Name: utility_bills utility_bills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."utility_bills"
    ADD CONSTRAINT "utility_bills_pkey" PRIMARY KEY ("id");


--
-- Name: utility_providers utility_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."utility_providers"
    ADD CONSTRAINT "utility_providers_pkey" PRIMARY KEY ("id");


--
-- Name: vendor_invoices vendor_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."vendor_invoices"
    ADD CONSTRAINT "vendor_invoices_pkey" PRIMARY KEY ("id");


--
-- Name: vendors vendors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."vendors"
    ADD CONSTRAINT "vendors_pkey" PRIMARY KEY ("id");


--
-- Name: work_order_photos work_order_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_order_photos"
    ADD CONSTRAINT "work_order_photos_pkey" PRIMARY KEY ("id");


--
-- Name: work_orders work_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id");


--
-- Name: bank_feed_transaction_dedup_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "bank_feed_transaction_dedup_key" ON "public"."bank_feed_transaction" USING "btree" ("company_id", "bank_account_feed_id", COALESCE("provider_transaction_id", "fingerprint_hash"));


--
-- Name: idx_acct_accounts_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_acct_accounts_company" ON "public"."acct_accounts" USING "btree" ("company_id");


--
-- Name: idx_acct_accounts_company_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_acct_accounts_company_code" ON "public"."acct_accounts" USING "btree" ("company_id", "code");


--
-- Name: idx_acct_accounts_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_acct_accounts_parent" ON "public"."acct_accounts" USING "btree" ("parent_id") WHERE ("parent_id" IS NOT NULL);


--
-- Name: idx_acct_accounts_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_acct_accounts_tenant" ON "public"."acct_accounts" USING "btree" ("tenant_id") WHERE ("tenant_id" IS NOT NULL);


--
-- Name: idx_acct_classes_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_acct_classes_company" ON "public"."acct_classes" USING "btree" ("company_id");


--
-- Name: idx_acct_je_company_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_acct_je_company_date" ON "public"."acct_journal_entries" USING "btree" ("company_id", "date");


--
-- Name: idx_acct_je_stripe_pi; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_acct_je_stripe_pi" ON "public"."acct_journal_entries" USING "btree" ("stripe_payment_intent_id") WHERE ("stripe_payment_intent_id" IS NOT NULL);


--
-- Name: idx_acct_jl_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_acct_jl_account" ON "public"."acct_journal_lines" USING "btree" ("account_id");


--
-- Name: idx_acct_jl_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_acct_jl_company" ON "public"."acct_journal_lines" USING "btree" ("company_id");


--
-- Name: idx_acct_jl_entry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_acct_jl_entry" ON "public"."acct_journal_lines" USING "btree" ("journal_entry_id");


--
-- Name: idx_app_users_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_app_users_company" ON "public"."app_users" USING "btree" ("company_id");


--
-- Name: idx_app_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_app_users_email" ON "public"."app_users" USING "btree" ("email");


--
-- Name: idx_app_users_manager; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_app_users_manager" ON "public"."app_users" USING "btree" ("company_id", "lower"("manager_email"));


--
-- Name: idx_audit_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_audit_company" ON "public"."audit_trail" USING "btree" ("company_id");


--
-- Name: idx_audit_trail_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_audit_trail_company" ON "public"."audit_trail" USING "btree" ("company_id");


--
-- Name: idx_audit_trail_company_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_audit_trail_company_created" ON "public"."audit_trail" USING "btree" ("company_id", "created_at" DESC);


--
-- Name: idx_audit_trail_company_module; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_audit_trail_company_module" ON "public"."audit_trail" USING "btree" ("company_id", "module");


--
-- Name: idx_audit_trail_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_audit_trail_created" ON "public"."audit_trail" USING "btree" ("created_at" DESC);


--
-- Name: idx_audit_trail_module; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_audit_trail_module" ON "public"."audit_trail" USING "btree" ("module");


--
-- Name: idx_autopay_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_autopay_company" ON "public"."autopay_schedules" USING "btree" ("company_id");


--
-- Name: idx_autopay_due_stripe; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_autopay_due_stripe" ON "public"."autopay_schedules" USING "btree" ("next_charge_date") WHERE (("enabled" = true) AND ("provider" = 'stripe'::"text") AND ("archived_at" IS NULL));


--
-- Name: idx_autopay_one_stripe_per_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_autopay_one_stripe_per_tenant" ON "public"."autopay_schedules" USING "btree" ("company_id", "tenant_id") WHERE (("provider" = 'stripe'::"text") AND ("archived_at" IS NULL));


--
-- Name: idx_autopay_property_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_autopay_property_id" ON "public"."autopay_schedules" USING "btree" ("property_id");


--
-- Name: idx_baf_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_baf_company" ON "public"."bank_account_feed" USING "btree" ("company_id");


--
-- Name: idx_bank_recon_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bank_recon_period" ON "public"."bank_reconciliations" USING "btree" ("period");


--
-- Name: idx_bank_reconciliations_company_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bank_reconciliations_company_created" ON "public"."bank_reconciliations" USING "btree" ("company_id", "created_at" DESC);


--
-- Name: idx_bank_reconciliations_company_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bank_reconciliations_company_period" ON "public"."bank_reconciliations" USING "btree" ("company_id", "period");


--
-- Name: idx_bc_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bc_company" ON "public"."bank_connection" USING "btree" ("company_id");


--
-- Name: idx_bft_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bft_batch" ON "public"."bank_feed_transaction" USING "btree" ("bank_import_batch_id");


--
-- Name: idx_bft_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bft_company" ON "public"."bank_feed_transaction" USING "btree" ("company_id");


--
-- Name: idx_bft_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bft_date" ON "public"."bank_feed_transaction" USING "btree" ("company_id", "posted_date");


--
-- Name: idx_bft_feed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bft_feed" ON "public"."bank_feed_transaction" USING "btree" ("bank_account_feed_id");


--
-- Name: idx_bft_fingerprint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bft_fingerprint" ON "public"."bank_feed_transaction" USING "btree" ("fingerprint_hash");


--
-- Name: idx_bft_provider_txn; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bft_provider_txn" ON "public"."bank_feed_transaction" USING "btree" ("provider_transaction_id");


--
-- Name: idx_bft_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bft_status" ON "public"."bank_feed_transaction" USING "btree" ("company_id", "status");


--
-- Name: idx_bftl_txn; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bftl_txn" ON "public"."bank_feed_transaction_link" USING "btree" ("bank_feed_transaction_id");


--
-- Name: idx_bib_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bib_company" ON "public"."bank_import_batch" USING "btree" ("company_id");


--
-- Name: idx_bimp_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bimp_company" ON "public"."bank_import_mapping_profile" USING "btree" ("company_id");


--
-- Name: idx_bpd_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_bpd_company" ON "public"."bank_posting_decision" USING "btree" ("company_id");


--
-- Name: idx_btr_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_btr_company" ON "public"."bank_transaction_rule" USING "btree" ("company_id");


--
-- Name: idx_budgets_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_budgets_company" ON "public"."budgets" USING "btree" ("company_id");


--
-- Name: idx_cm_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_cm_company_status" ON "public"."company_members" USING "btree" ("company_id", "status");


--
-- Name: idx_cm_email_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_cm_email_status" ON "public"."company_members" USING "btree" ("lower"("user_email"), "status");


--
-- Name: idx_company_members_auth_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_company_members_auth_uid" ON "public"."company_members" USING "btree" ("auth_user_id");


--
-- Name: idx_company_members_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_company_members_company" ON "public"."company_members" USING "btree" ("company_id");


--
-- Name: idx_company_members_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_company_members_email" ON "public"."company_members" USING "btree" ("user_email");


--
-- Name: idx_company_members_manager; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_company_members_manager" ON "public"."company_members" USING "btree" ("company_id", "lower"("manager_email"));


--
-- Name: idx_company_members_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_company_members_user" ON "public"."company_members" USING "btree" ("auth_user_id", "status");


--
-- Name: idx_company_settings_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_company_settings_company" ON "public"."company_settings" USING "btree" ("company_id");


--
-- Name: idx_der_approver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_der_approver" ON "public"."doc_exception_requests" USING "btree" ("company_id", "lower"("approver_email"), "status");


--
-- Name: idx_der_tenant_doctype; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_der_tenant_doctype" ON "public"."doc_exception_requests" USING "btree" ("company_id", "tenant_name", "doc_type", "status");


--
-- Name: idx_doc_exc_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_doc_exc_company" ON "public"."doc_exception_requests" USING "btree" ("company_id", "status");


--
-- Name: idx_doc_generated_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_doc_generated_company" ON "public"."doc_generated" USING "btree" ("company_id");


--
-- Name: idx_doc_generated_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_doc_generated_status" ON "public"."doc_generated" USING "btree" ("status");


--
-- Name: idx_doc_generated_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_doc_generated_template" ON "public"."doc_generated" USING "btree" ("template_id");


--
-- Name: idx_doc_sig_audit_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_doc_sig_audit_company" ON "public"."doc_signature_audit_log" USING "btree" ("company_id", "changed_at" DESC);


--
-- Name: idx_doc_sig_audit_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_doc_sig_audit_doc" ON "public"."doc_signature_audit_log" USING "btree" ("doc_id", "changed_at" DESC);


--
-- Name: idx_doc_sig_audit_signature; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_doc_sig_audit_signature" ON "public"."doc_signature_audit_log" USING "btree" ("signature_id", "changed_at" DESC);


--
-- Name: idx_doc_signatures_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_doc_signatures_company" ON "public"."doc_signatures" USING "btree" ("company_id");


--
-- Name: idx_doc_signatures_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_doc_signatures_doc" ON "public"."doc_signatures" USING "btree" ("doc_id");


--
-- Name: idx_doc_signatures_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_doc_signatures_email" ON "public"."doc_signatures" USING "btree" ("signer_email");


--
-- Name: idx_doc_signatures_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_doc_signatures_token" ON "public"."doc_signatures" USING "btree" ("access_token") WHERE ("access_token" IS NOT NULL);


--
-- Name: idx_doc_templates_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_doc_templates_company" ON "public"."doc_templates" USING "btree" ("company_id");


--
-- Name: idx_documents_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_documents_company" ON "public"."documents" USING "btree" ("company_id");


--
-- Name: idx_documents_property_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_documents_property_id" ON "public"."documents" USING "btree" ("property_id");


--
-- Name: idx_documents_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_documents_tenant" ON "public"."documents" USING "btree" ("tenant");


--
-- Name: idx_error_log_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_error_log_code" ON "public"."error_log" USING "btree" ("error_code", "created_at" DESC);


--
-- Name: idx_error_log_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_error_log_company" ON "public"."error_log" USING "btree" ("company_id", "created_at" DESC);


--
-- Name: idx_error_log_reported; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_error_log_reported" ON "public"."error_log" USING "btree" ("reported_by_user", "created_at" DESC) WHERE ("reported_by_user" = true);


--
-- Name: idx_error_log_unresolved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_error_log_unresolved" ON "public"."error_log" USING "btree" ("resolved", "created_at" DESC) WHERE ("resolved" = false);


--
-- Name: idx_eviction_cases_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_eviction_cases_company" ON "public"."eviction_cases" USING "btree" ("company_id");


--
-- Name: idx_eviction_cases_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_eviction_cases_status" ON "public"."eviction_cases" USING "btree" ("company_id", "status");


--
-- Name: idx_hoa_payments_property_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_hoa_payments_property_id" ON "public"."hoa_payments" USING "btree" ("property_id");


--
-- Name: idx_inbox_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_inbox_company" ON "public"."notification_inbox" USING "btree" ("company_id", "created_at" DESC);


--
-- Name: idx_inbox_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_inbox_unread" ON "public"."notification_inbox" USING "btree" ("company_id", "recipient_email", "read") WHERE ("read" = false);


--
-- Name: idx_je_company_reference_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_je_company_reference_unique" ON "public"."acct_journal_entries" USING "btree" ("company_id", "reference") WHERE (("status" <> 'voided'::"text") AND ("reference" <> ''::"text"));


--
-- Name: idx_jl_bank_feed_txn; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_jl_bank_feed_txn" ON "public"."acct_journal_lines" USING "btree" ("bank_feed_transaction_id") WHERE ("bank_feed_transaction_id" IS NOT NULL);


--
-- Name: idx_late_fee_rules_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_late_fee_rules_company" ON "public"."late_fee_rules" USING "btree" ("company_id");


--
-- Name: idx_lease_sigs_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_lease_sigs_email" ON "public"."lease_signatures" USING "btree" ("signer_email");


--
-- Name: idx_lease_sigs_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_lease_sigs_lease" ON "public"."lease_signatures" USING "btree" ("lease_id");


--
-- Name: idx_leases_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_leases_company" ON "public"."leases" USING "btree" ("company_id");


--
-- Name: idx_leases_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_leases_company_status" ON "public"."leases" USING "btree" ("company_id", "status");


--
-- Name: idx_leases_end_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_leases_end_date" ON "public"."leases" USING "btree" ("end_date");


--
-- Name: idx_leases_property; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_leases_property" ON "public"."leases" USING "btree" ("property");


--
-- Name: idx_leases_property_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_leases_property_id" ON "public"."leases" USING "btree" ("property_id");


--
-- Name: idx_leases_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_leases_status" ON "public"."leases" USING "btree" ("status");


--
-- Name: idx_leases_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_leases_tenant" ON "public"."leases" USING "btree" ("tenant_name");


--
-- Name: idx_ledger_entries_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ledger_entries_company" ON "public"."ledger_entries_legacy_table" USING "btree" ("company_id");


--
-- Name: idx_ledger_entries_company_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ledger_entries_company_tenant" ON "public"."ledger_entries_legacy_table" USING "btree" ("company_id", "tenant");


--
-- Name: idx_ledger_entries_je_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ledger_entries_je_id" ON "public"."ledger_entries_legacy_table" USING "btree" ("journal_entry_id") WHERE ("journal_entry_id" IS NOT NULL);


--
-- Name: idx_ledger_property_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ledger_property_id" ON "public"."ledger_entries_legacy_table" USING "btree" ("property_id");


--
-- Name: idx_messages_company_tenant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_messages_company_tenant_created" ON "public"."messages" USING "btree" ("company_id", "tenant_id", "created_at" DESC);


--
-- Name: idx_messages_company_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_messages_company_tenant_id" ON "public"."messages" USING "btree" ("company_id", "tenant_id") WHERE ("tenant_id" IS NOT NULL);


--
-- Name: idx_messages_company_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_messages_company_unread" ON "public"."messages" USING "btree" ("company_id", "tenant_id") WHERE ("read_at" IS NULL);


--
-- Name: idx_notif_log_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_notif_log_date" ON "public"."notification_log" USING "btree" ("created_at");


--
-- Name: idx_notif_log_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_notif_log_type" ON "public"."notification_log" USING "btree" ("event_type");


--
-- Name: idx_notif_queue_scheduled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_notif_queue_scheduled" ON "public"."notification_queue" USING "btree" ("status", "scheduled_for") WHERE ("status" = 'pending'::"text");


--
-- Name: idx_notif_queue_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_notif_queue_status" ON "public"."notification_queue" USING "btree" ("status", "created_at");


--
-- Name: idx_notif_settings_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_notif_settings_unique" ON "public"."notification_settings" USING "btree" ("company_id", "event_type");


--
-- Name: idx_nq_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_nq_pending" ON "public"."notification_queue" USING "btree" ("status", "created_at") WHERE ("status" = 'pending'::"text");


--
-- Name: idx_owner_statements_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_owner_statements_owner" ON "public"."owner_statements" USING "btree" ("owner_id");


--
-- Name: idx_owner_statements_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_owner_statements_period" ON "public"."owner_statements" USING "btree" ("period");


--
-- Name: idx_owners_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_owners_company" ON "public"."owners" USING "btree" ("company_id");


--
-- Name: idx_owners_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_owners_status" ON "public"."owners" USING "btree" ("status");


--
-- Name: idx_payments_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_payments_company" ON "public"."payments" USING "btree" ("company_id");


--
-- Name: idx_payments_company_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_payments_company_date" ON "public"."payments" USING "btree" ("company_id", "date");


--
-- Name: idx_payments_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_payments_company_status" ON "public"."payments" USING "btree" ("company_id", "status");


--
-- Name: idx_payments_property_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_payments_property_id" ON "public"."payments" USING "btree" ("property_id");


--
-- Name: idx_pcr_approver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_pcr_approver" ON "public"."property_change_requests" USING "btree" ("company_id", "lower"("approver_email"), "status");


--
-- Name: idx_pm_requests_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_pm_requests_owner" ON "public"."pm_assignment_requests" USING "btree" ("owner_company_id", "status");


--
-- Name: idx_pm_requests_pm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_pm_requests_pm" ON "public"."pm_assignment_requests" USING "btree" ("pm_company_id", "status");


--
-- Name: idx_prop_licenses_company_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_prop_licenses_company_expiry" ON "public"."property_licenses" USING "btree" ("company_id", "expiry_date") WHERE ("archived_at" IS NULL);


--
-- Name: idx_prop_licenses_property; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_prop_licenses_property" ON "public"."property_licenses" USING "btree" ("property_id") WHERE ("archived_at" IS NULL);


--
-- Name: idx_prop_licenses_reminder_scan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_prop_licenses_reminder_scan" ON "public"."property_licenses" USING "btree" ("expiry_date") WHERE (("archived_at" IS NULL) AND ("status" = ANY (ARRAY['active'::"text", 'pending_renewal'::"text"])));


--
-- Name: idx_properties_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_properties_active" ON "public"."properties" USING "btree" ("company_id") WHERE ("archived_at" IS NULL);


--
-- Name: idx_properties_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_properties_company" ON "public"."properties" USING "btree" ("company_id");


--
-- Name: idx_properties_company_archived; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_properties_company_archived" ON "public"."properties" USING "btree" ("company_id", "archived_at");


--
-- Name: idx_properties_county; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_properties_county" ON "public"."properties" USING "btree" ("company_id", "county") WHERE ("county" IS NOT NULL);


--
-- Name: idx_properties_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_properties_owner" ON "public"."properties" USING "btree" ("owner_id");


--
-- Name: idx_properties_unique_address; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_properties_unique_address" ON "public"."properties" USING "btree" ("company_id", "address") WHERE ("archived_at" IS NULL);


--
-- Name: idx_property_insurance_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_property_insurance_company" ON "public"."property_insurance" USING "btree" ("company_id");


--
-- Name: idx_property_loans_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_property_loans_company" ON "public"."property_loans" USING "btree" ("company_id");


--
-- Name: idx_property_loans_property; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_property_loans_property" ON "public"."property_loans" USING "btree" ("company_id", "property");


--
-- Name: idx_property_setup_wizard_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_property_setup_wizard_company" ON "public"."property_setup_wizard" USING "btree" ("company_id", "status");


--
-- Name: idx_property_tax_bills_company_status_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_property_tax_bills_company_status_due" ON "public"."property_tax_bills" USING "btree" ("company_id", "status", "due_date") WHERE ("archived_at" IS NULL);


--
-- Name: idx_property_tax_bills_property; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_property_tax_bills_property" ON "public"."property_tax_bills" USING "btree" ("company_id", "property") WHERE ("archived_at" IS NULL);


--
-- Name: idx_property_taxes_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_property_taxes_company" ON "public"."property_taxes" USING "btree" ("company_id");


--
-- Name: idx_property_taxes_next_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_property_taxes_next_due" ON "public"."property_taxes" USING "btree" ("company_id", "next_due_date") WHERE ("archived_at" IS NULL);


--
-- Name: idx_property_taxes_property; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_property_taxes_property" ON "public"."property_taxes" USING "btree" ("company_id", "property");


--
-- Name: idx_pse_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_pse_company" ON "public"."plaid_sync_event" USING "btree" ("company_id");


--
-- Name: idx_push_attempts_company_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_push_attempts_company_recent" ON "public"."push_attempts" USING "btree" ("company_id", "created_at" DESC);


--
-- Name: idx_push_attempts_payload_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_push_attempts_payload_tag" ON "public"."push_attempts" USING "btree" ("payload_tag", "created_at" DESC) WHERE ("payload_tag" IS NOT NULL);


--
-- Name: idx_push_attempts_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_push_attempts_recipient" ON "public"."push_attempts" USING "btree" ("recipient_email", "created_at" DESC);


--
-- Name: idx_push_sub_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_push_sub_unique" ON "public"."push_subscriptions" USING "btree" ("company_id", "user_email", (("subscription" ->> 'endpoint'::"text")));


--
-- Name: idx_push_subs_health; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_push_subs_health" ON "public"."push_subscriptions" USING "btree" ("company_id", "user_email", "last_sw_received_at");


--
-- Name: idx_recur_je_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_recur_je_tenant_id" ON "public"."recurring_journal_entries" USING "btree" ("tenant_id") WHERE ("tenant_id" IS NOT NULL);


--
-- Name: idx_rje_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_rje_company" ON "public"."recurring_journal_entries" USING "btree" ("company_id");


--
-- Name: idx_rje_next_post; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_rje_next_post" ON "public"."recurring_journal_entries" USING "btree" ("next_post_date") WHERE ("status" = 'active'::"text");


--
-- Name: idx_rje_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_rje_status" ON "public"."recurring_journal_entries" USING "btree" ("company_id", "status");


--
-- Name: idx_tenant_invite_codes_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_tenant_invite_codes_code" ON "public"."tenant_invite_codes" USING "btree" ("code");


--
-- Name: idx_tenant_invite_codes_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_tenant_invite_codes_company" ON "public"."tenant_invite_codes" USING "btree" ("company_id");


--
-- Name: idx_tenants_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_tenants_active" ON "public"."tenants" USING "btree" ("company_id") WHERE ("archived_at" IS NULL);


--
-- Name: idx_tenants_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_tenants_company" ON "public"."tenants" USING "btree" ("company_id");


--
-- Name: idx_tenants_company_archived; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_tenants_company_archived" ON "public"."tenants" USING "btree" ("company_id", "archived_at");


--
-- Name: idx_tenants_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_tenants_email" ON "public"."tenants" USING "btree" ("email");


--
-- Name: idx_tenants_property_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_tenants_property_id" ON "public"."tenants" USING "btree" ("property_id");


--
-- Name: idx_tenants_unique_name_property; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_tenants_unique_name_property" ON "public"."tenants" USING "btree" ("company_id", "name", "property") WHERE ("archived_at" IS NULL);


--
-- Name: idx_utilities_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_utilities_company" ON "public"."utilities" USING "btree" ("company_id");


--
-- Name: idx_utilities_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_utilities_company_status" ON "public"."utilities" USING "btree" ("company_id", "status");


--
-- Name: idx_utilities_property_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_utilities_property_id" ON "public"."utilities" USING "btree" ("property_id");


--
-- Name: idx_utility_accounts_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_utility_accounts_company" ON "public"."utility_accounts" USING "btree" ("company_id") WHERE ("archived_at" IS NULL);


--
-- Name: idx_utility_bills_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_utility_bills_company" ON "public"."utility_bills" USING "btree" ("company_id") WHERE ("archived_at" IS NULL);


--
-- Name: idx_utility_bills_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_utility_bills_status" ON "public"."utility_bills" USING "btree" ("company_id", "status") WHERE ("archived_at" IS NULL);


--
-- Name: idx_vendor_invoices_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_vendor_invoices_status" ON "public"."vendor_invoices" USING "btree" ("status");


--
-- Name: idx_vendor_invoices_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_vendor_invoices_vendor" ON "public"."vendor_invoices" USING "btree" ("vendor_id");


--
-- Name: idx_vendors_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_vendors_company" ON "public"."vendors" USING "btree" ("company_id");


--
-- Name: idx_vendors_specialty; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_vendors_specialty" ON "public"."vendors" USING "btree" ("specialty");


--
-- Name: idx_vendors_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_vendors_status" ON "public"."vendors" USING "btree" ("status");


--
-- Name: idx_work_orders_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_work_orders_active" ON "public"."work_orders" USING "btree" ("company_id") WHERE ("archived_at" IS NULL);


--
-- Name: idx_work_orders_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_work_orders_company" ON "public"."work_orders" USING "btree" ("company_id");


--
-- Name: idx_work_orders_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_work_orders_company_status" ON "public"."work_orders" USING "btree" ("company_id", "status");


--
-- Name: idx_work_orders_property_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_work_orders_property_id" ON "public"."work_orders" USING "btree" ("property_id");


--
-- Name: push_subscriptions_company_email_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "push_subscriptions_company_email_key" ON "public"."push_subscriptions" USING "btree" ("company_id", "lower"("user_email"));


--
-- Name: push_subscriptions_company_email_raw_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "push_subscriptions_company_email_raw_key" ON "public"."push_subscriptions" USING "btree" ("company_id", "user_email");


--
-- Name: uq_property_tax_bills_autogen; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "uq_property_tax_bills_autogen" ON "public"."property_tax_bills" USING "btree" ("company_id", "property", "tax_year", "installment_label") WHERE (("auto_generated" = true) AND ("archived_at" IS NULL));


--
-- Name: ux_ledger_je_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ux_ledger_je_tenant" ON "public"."ledger_entries_legacy_table" USING "btree" ("journal_entry_id", "tenant_id") WHERE ("journal_entry_id" IS NOT NULL);


--
-- Name: hoa_payments audit_hoa_payments; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "audit_hoa_payments" AFTER INSERT OR DELETE OR UPDATE ON "public"."hoa_payments" FOR EACH ROW EXECUTE FUNCTION "public"."audit_trigger_func"();


--
-- Name: leases audit_leases; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "audit_leases" AFTER INSERT OR DELETE OR UPDATE ON "public"."leases" FOR EACH ROW EXECUTE FUNCTION "public"."audit_trigger_func"();


--
-- Name: owners audit_owners; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "audit_owners" AFTER INSERT OR DELETE OR UPDATE ON "public"."owners" FOR EACH ROW EXECUTE FUNCTION "public"."audit_trigger_func"();


--
-- Name: payments audit_payments; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "audit_payments" AFTER INSERT OR DELETE OR UPDATE ON "public"."payments" FOR EACH ROW EXECUTE FUNCTION "public"."audit_trigger_func"();


--
-- Name: properties audit_properties; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "audit_properties" AFTER INSERT OR DELETE OR UPDATE ON "public"."properties" FOR EACH ROW EXECUTE FUNCTION "public"."audit_trigger_func"();


--
-- Name: tenants audit_tenants; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "audit_tenants" AFTER INSERT OR DELETE OR UPDATE ON "public"."tenants" FOR EACH ROW EXECUTE FUNCTION "public"."audit_trigger_func"();


--
-- Name: utilities audit_utilities; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "audit_utilities" AFTER INSERT OR DELETE OR UPDATE ON "public"."utilities" FOR EACH ROW EXECUTE FUNCTION "public"."audit_trigger_func"();


--
-- Name: vendors audit_vendors; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "audit_vendors" AFTER INSERT OR DELETE OR UPDATE ON "public"."vendors" FOR EACH ROW EXECUTE FUNCTION "public"."audit_trigger_func"();


--
-- Name: work_orders audit_work_orders; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "audit_work_orders" AFTER INSERT OR DELETE OR UPDATE ON "public"."work_orders" FOR EACH ROW EXECUTE FUNCTION "public"."audit_trigger_func"();


--
-- Name: autopay_schedules auto_property_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "auto_property_id" BEFORE INSERT OR UPDATE ON "public"."autopay_schedules" FOR EACH ROW EXECUTE FUNCTION "public"."auto_fill_property_id"();


--
-- Name: documents auto_property_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "auto_property_id" BEFORE INSERT OR UPDATE ON "public"."documents" FOR EACH ROW EXECUTE FUNCTION "public"."auto_fill_property_id"();


--
-- Name: hoa_payments auto_property_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "auto_property_id" BEFORE INSERT OR UPDATE ON "public"."hoa_payments" FOR EACH ROW EXECUTE FUNCTION "public"."auto_fill_property_id"();


--
-- Name: leases auto_property_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "auto_property_id" BEFORE INSERT OR UPDATE ON "public"."leases" FOR EACH ROW EXECUTE FUNCTION "public"."auto_fill_property_id"();


--
-- Name: ledger_entries_legacy_table auto_property_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "auto_property_id" BEFORE INSERT OR UPDATE ON "public"."ledger_entries_legacy_table" FOR EACH ROW EXECUTE FUNCTION "public"."auto_fill_property_id"();


--
-- Name: payments auto_property_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "auto_property_id" BEFORE INSERT OR UPDATE ON "public"."payments" FOR EACH ROW EXECUTE FUNCTION "public"."auto_fill_property_id"();


--
-- Name: tenants auto_property_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "auto_property_id" BEFORE INSERT OR UPDATE ON "public"."tenants" FOR EACH ROW EXECUTE FUNCTION "public"."auto_fill_property_id"();


--
-- Name: utilities auto_property_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "auto_property_id" BEFORE INSERT OR UPDATE ON "public"."utilities" FOR EACH ROW EXECUTE FUNCTION "public"."auto_fill_property_id"();


--
-- Name: work_orders auto_property_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "auto_property_id" BEFORE INSERT OR UPDATE ON "public"."work_orders" FOR EACH ROW EXECUTE FUNCTION "public"."auto_fill_property_id"();


--
-- Name: doc_signatures doc_signatures_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "doc_signatures_audit" AFTER INSERT OR DELETE OR UPDATE ON "public"."doc_signatures" FOR EACH ROW EXECUTE FUNCTION "public"."_doc_signatures_audit_trg"();


--
-- Name: lease_signatures protect_signed_signatures; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "protect_signed_signatures" BEFORE UPDATE ON "public"."lease_signatures" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_signature_tampering"();


--
-- Name: properties sync_addr; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "sync_addr" BEFORE INSERT OR UPDATE ON "public"."properties" FOR EACH ROW WHEN (("new"."address_line_1" IS NOT NULL)) EXECUTE FUNCTION "public"."sync_property_address"();


--
-- Name: acct_journal_lines sync_tenant_balance_lines; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "sync_tenant_balance_lines" AFTER INSERT OR DELETE OR UPDATE ON "public"."acct_journal_lines" FOR EACH ROW EXECUTE FUNCTION "public"."trg_sync_balance_from_je_lines"();


--
-- Name: acct_journal_entries sync_tenant_balance_status; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "sync_tenant_balance_status" AFTER UPDATE ON "public"."acct_journal_entries" FOR EACH ROW EXECUTE FUNCTION "public"."trg_sync_balance_from_je_status"();


--
-- Name: acct_journal_lines trg_jl_company_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_jl_company_id" BEFORE INSERT ON "public"."acct_journal_lines" FOR EACH ROW EXECUTE FUNCTION "public"."set_journal_line_company_id"();


--
-- Name: property_licenses trg_property_licenses_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_property_licenses_updated_at" BEFORE UPDATE ON "public"."property_licenses" FOR EACH ROW EXECUTE FUNCTION "public"."property_licenses_touch_updated_at"();


--
-- Name: property_tax_bills trg_property_tax_bills_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_property_tax_bills_updated_at" BEFORE UPDATE ON "public"."property_tax_bills" FOR EACH ROW EXECUTE FUNCTION "public"."property_tax_bills_touch_updated_at"();


--
-- Name: acct_accounts acct_accounts_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."acct_accounts"
    ADD CONSTRAINT "acct_accounts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."acct_accounts"("id") ON DELETE SET NULL;


--
-- Name: acct_journal_lines acct_journal_lines_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."acct_journal_lines"
    ADD CONSTRAINT "acct_journal_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."acct_accounts"("id") ON DELETE SET NULL;


--
-- Name: acct_journal_lines acct_journal_lines_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."acct_journal_lines"
    ADD CONSTRAINT "acct_journal_lines_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."acct_classes"("id") ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: acct_journal_lines acct_journal_lines_journal_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."acct_journal_lines"
    ADD CONSTRAINT "acct_journal_lines_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."acct_journal_entries"("id") ON DELETE CASCADE;


--
-- Name: automation_jobs automation_jobs_bill_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."automation_jobs"
    ADD CONSTRAINT "automation_jobs_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "public"."utility_bills"("id");


--
-- Name: automation_jobs automation_jobs_utility_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."automation_jobs"
    ADD CONSTRAINT "automation_jobs_utility_account_id_fkey" FOREIGN KEY ("utility_account_id") REFERENCES "public"."utility_accounts"("id");


--
-- Name: autopay_schedules autopay_schedules_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."autopay_schedules"
    ADD CONSTRAINT "autopay_schedules_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id");


--
-- Name: autopay_schedules autopay_schedules_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."autopay_schedules"
    ADD CONSTRAINT "autopay_schedules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;


--
-- Name: bank_account_feed bank_account_feed_gl_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_account_feed"
    ADD CONSTRAINT "bank_account_feed_gl_account_id_fkey" FOREIGN KEY ("gl_account_id") REFERENCES "public"."acct_accounts"("id");


--
-- Name: bank_feed_transaction bank_feed_transaction_bank_account_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_feed_transaction"
    ADD CONSTRAINT "bank_feed_transaction_bank_account_feed_id_fkey" FOREIGN KEY ("bank_account_feed_id") REFERENCES "public"."bank_account_feed"("id");


--
-- Name: bank_feed_transaction bank_feed_transaction_bank_import_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_feed_transaction"
    ADD CONSTRAINT "bank_feed_transaction_bank_import_batch_id_fkey" FOREIGN KEY ("bank_import_batch_id") REFERENCES "public"."bank_import_batch"("id");


--
-- Name: bank_feed_transaction_link bank_feed_transaction_link_bank_feed_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_feed_transaction_link"
    ADD CONSTRAINT "bank_feed_transaction_link_bank_feed_transaction_id_fkey" FOREIGN KEY ("bank_feed_transaction_id") REFERENCES "public"."bank_feed_transaction"("id");


--
-- Name: bank_import_batch bank_import_batch_bank_account_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_import_batch"
    ADD CONSTRAINT "bank_import_batch_bank_account_feed_id_fkey" FOREIGN KEY ("bank_account_feed_id") REFERENCES "public"."bank_account_feed"("id");


--
-- Name: bank_posting_decision bank_posting_decision_bank_feed_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_posting_decision"
    ADD CONSTRAINT "bank_posting_decision_bank_feed_transaction_id_fkey" FOREIGN KEY ("bank_feed_transaction_id") REFERENCES "public"."bank_feed_transaction"("id");


--
-- Name: bank_posting_decision_line bank_posting_decision_line_bank_posting_decision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."bank_posting_decision_line"
    ADD CONSTRAINT "bank_posting_decision_line_bank_posting_decision_id_fkey" FOREIGN KEY ("bank_posting_decision_id") REFERENCES "public"."bank_posting_decision"("id") ON DELETE CASCADE;


--
-- Name: budgets budgets_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."acct_accounts"("id");


--
-- Name: company_members company_members_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."company_members"
    ADD CONSTRAINT "company_members_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;


--
-- Name: company_settings company_settings_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."company_settings"
    ADD CONSTRAINT "company_settings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;


--
-- Name: doc_generated doc_generated_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."doc_generated"
    ADD CONSTRAINT "doc_generated_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."doc_templates"("id") ON DELETE SET NULL;


--
-- Name: doc_signature_audit_log doc_signature_audit_log_signature_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."doc_signature_audit_log"
    ADD CONSTRAINT "doc_signature_audit_log_signature_id_fkey" FOREIGN KEY ("signature_id") REFERENCES "public"."doc_signatures"("id");


--
-- Name: doc_signatures doc_signatures_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."doc_signatures"
    ADD CONSTRAINT "doc_signatures_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "public"."doc_generated"("id") ON DELETE CASCADE;


--
-- Name: documents documents_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id");


--
-- Name: error_log error_log_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."error_log"
    ADD CONSTRAINT "error_log_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");


--
-- Name: hoa_payments hoa_payments_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hoa_payments"
    ADD CONSTRAINT "hoa_payments_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id");


--
-- Name: lease_signatures lease_signatures_lease_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."lease_signatures"
    ADD CONSTRAINT "lease_signatures_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;


--
-- Name: leases leases_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."leases"
    ADD CONSTRAINT "leases_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id");


--
-- Name: leases leases_renewed_from_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."leases"
    ADD CONSTRAINT "leases_renewed_from_fkey" FOREIGN KEY ("renewed_from") REFERENCES "public"."leases"("id") ON DELETE SET NULL;


--
-- Name: leases leases_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."leases"
    ADD CONSTRAINT "leases_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE SET NULL;


--
-- Name: ledger_entries_legacy_table ledger_entries_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ledger_entries_legacy_table"
    ADD CONSTRAINT "ledger_entries_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id");


--
-- Name: owner_distributions owner_distributions_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."owner_distributions"
    ADD CONSTRAINT "owner_distributions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE CASCADE;


--
-- Name: owner_distributions owner_distributions_statement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."owner_distributions"
    ADD CONSTRAINT "owner_distributions_statement_id_fkey" FOREIGN KEY ("statement_id") REFERENCES "public"."owner_statements"("id") ON DELETE SET NULL;


--
-- Name: owner_statements owner_statements_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."owner_statements"
    ADD CONSTRAINT "owner_statements_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE CASCADE;


--
-- Name: payments payments_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id");


--
-- Name: plaid_sync_event plaid_sync_event_bank_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."plaid_sync_event"
    ADD CONSTRAINT "plaid_sync_event_bank_connection_id_fkey" FOREIGN KEY ("bank_connection_id") REFERENCES "public"."bank_connection"("id");


--
-- Name: properties properties_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."properties"
    ADD CONSTRAINT "properties_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."acct_classes"("id") ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: properties properties_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."properties"
    ADD CONSTRAINT "properties_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE SET NULL;


--
-- Name: property_licenses property_licenses_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."property_licenses"
    ADD CONSTRAINT "property_licenses_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE SET NULL;


--
-- Name: property_licenses property_licenses_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."property_licenses"
    ADD CONSTRAINT "property_licenses_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE CASCADE;


--
-- Name: tenants tenants_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tenants"
    ADD CONSTRAINT "tenants_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id");


--
-- Name: utilities utilities_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."utilities"
    ADD CONSTRAINT "utilities_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id");


--
-- Name: utility_audit utility_audit_utility_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."utility_audit"
    ADD CONSTRAINT "utility_audit_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "public"."utilities"("id") ON DELETE CASCADE;


--
-- Name: utility_bills utility_bills_utility_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."utility_bills"
    ADD CONSTRAINT "utility_bills_utility_account_id_fkey" FOREIGN KEY ("utility_account_id") REFERENCES "public"."utility_accounts"("id");


--
-- Name: vendor_invoices vendor_invoices_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."vendor_invoices"
    ADD CONSTRAINT "vendor_invoices_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE CASCADE;


--
-- Name: work_orders work_orders_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id");


--
-- Name: work_orders work_orders_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE SET NULL;


--
-- Name: error_log Admins can update errors; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update errors" ON "public"."error_log" FOR UPDATE USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"((("current_setting"('request.jwt.claims'::"text", true))::json ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text") AND ("cm"."role" = ANY (ARRAY['admin'::"text", 'owner'::"text"]))))));


--
-- Name: utility_audit Allow all for service_role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all for service_role" ON "public"."utility_audit" TO "service_role" USING (true) WITH CHECK (true);


--
-- Name: error_log Anyone can insert errors; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can insert errors" ON "public"."error_log" FOR INSERT WITH CHECK (true);


--
-- Name: error_log Company members can read own errors; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company members can read own errors" ON "public"."error_log" FOR SELECT USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"((("current_setting"('request.jwt.claims'::"text", true))::json ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: recurring_journal_entries Users can manage recurring entries for their company; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can manage recurring entries for their company" ON "public"."recurring_journal_entries" USING (("company_id" IN ( SELECT "company_members"."company_id"
   FROM "public"."company_members"
  WHERE (("company_members"."user_email" = ("auth"."jwt"() ->> 'email'::"text")) AND ("company_members"."status" = 'active'::"text")))));


--
-- Name: notification_queue Users manage notification queue; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage notification queue" ON "public"."notification_queue" USING (("company_id" IN ( SELECT "company_members"."company_id"
   FROM "public"."company_members"
  WHERE (("company_members"."user_email" = ("auth"."jwt"() ->> 'email'::"text")) AND ("company_members"."status" = 'active'::"text")))));


--
-- Name: push_subscriptions Users manage own push subscriptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own push subscriptions" ON "public"."push_subscriptions" USING (("user_email" = ("auth"."jwt"() ->> 'email'::"text")));


--
-- Name: notification_inbox Users see their company notifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users see their company notifications" ON "public"."notification_inbox" USING (("company_id" IN ( SELECT "company_members"."company_id"
   FROM "public"."company_members"
  WHERE (("company_members"."user_email" = ("auth"."jwt"() ->> 'email'::"text")) AND ("company_members"."status" = 'active'::"text")))));


--
-- Name: accounting_period_lock; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."accounting_period_lock" ENABLE ROW LEVEL SECURITY;

--
-- Name: acct_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."acct_accounts" ENABLE ROW LEVEL SECURITY;

--
-- Name: acct_accounts acct_accounts_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "acct_accounts_read" ON "public"."acct_accounts" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: acct_accounts acct_accounts_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "acct_accounts_staff" ON "public"."acct_accounts" USING ("public"."is_company_staff"("company_id"));


--
-- Name: acct_accounts acct_accounts_staff_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "acct_accounts_staff_all" ON "public"."acct_accounts" USING ("public"."is_company_staff"("company_id")) WITH CHECK ("public"."is_company_staff"("company_id"));


--
-- Name: acct_accounts acct_accounts_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "acct_accounts_write" ON "public"."acct_accounts" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: acct_classes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."acct_classes" ENABLE ROW LEVEL SECURITY;

--
-- Name: acct_classes acct_classes_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "acct_classes_read" ON "public"."acct_classes" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: acct_classes acct_classes_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "acct_classes_staff" ON "public"."acct_classes" USING ("public"."is_company_staff"("company_id"));


--
-- Name: acct_classes acct_classes_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "acct_classes_write" ON "public"."acct_classes" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: acct_journal_entries acct_je_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "acct_je_staff" ON "public"."acct_journal_entries" USING ("public"."is_company_staff"("company_id"));


--
-- Name: acct_journal_entries acct_je_staff_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "acct_je_staff_all" ON "public"."acct_journal_entries" USING ("public"."is_company_staff"("company_id")) WITH CHECK ("public"."is_company_staff"("company_id"));


--
-- Name: acct_journal_lines acct_jl_staff_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "acct_jl_staff_all" ON "public"."acct_journal_lines" USING ("public"."is_company_staff"("company_id")) WITH CHECK ("public"."is_company_staff"("company_id"));


--
-- Name: acct_journal_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."acct_journal_entries" ENABLE ROW LEVEL SECURITY;

--
-- Name: acct_journal_entries acct_journal_entries_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "acct_journal_entries_read" ON "public"."acct_journal_entries" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: acct_journal_entries acct_journal_entries_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "acct_journal_entries_write" ON "public"."acct_journal_entries" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: acct_journal_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."acct_journal_lines" ENABLE ROW LEVEL SECURITY;

--
-- Name: accounting_period_lock apl_company_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "apl_company_access" ON "public"."accounting_period_lock" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: app_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."app_users" ENABLE ROW LEVEL SECURITY;

--
-- Name: app_users app_users_company; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "app_users_company" ON "public"."app_users" USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: app_users app_users_safe_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "app_users_safe_insert" ON "public"."app_users" FOR INSERT WITH CHECK (((("lower"("email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("role" = ANY (ARRAY['tenant'::"text", 'owner'::"text", 'pm'::"text", 'office_assistant'::"text", 'accountant'::"text", 'maintenance'::"text"]))) OR ("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids"))));


--
-- Name: app_users app_users_self_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "app_users_self_read" ON "public"."app_users" FOR SELECT USING (("lower"("email") = "lower"("auth"."email"())));


--
-- Name: app_users app_users_self_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "app_users_self_update" ON "public"."app_users" FOR UPDATE USING (("lower"("email") = "lower"("auth"."email"()))) WITH CHECK (("lower"("email") = "lower"("auth"."email"())));


--
-- Name: app_users app_users_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "app_users_staff" ON "public"."app_users" USING ("public"."is_company_staff"("company_id"));


--
-- Name: audit_trail audit_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "audit_staff" ON "public"."audit_trail" USING ("public"."is_company_staff"("company_id"));


--
-- Name: audit_trail; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."audit_trail" ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_trail audit_trail_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "audit_trail_insert" ON "public"."audit_trail" FOR INSERT WITH CHECK (true);


--
-- Name: audit_trail audit_trail_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "audit_trail_read" ON "public"."audit_trail" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: audit_trail audit_trail_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "audit_trail_write" ON "public"."audit_trail" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: automation_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."automation_jobs" ENABLE ROW LEVEL SECURITY;

--
-- Name: automation_jobs automation_jobs_company; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "automation_jobs_company" ON "public"."automation_jobs" USING (("company_id" IN ( SELECT "company_members"."company_id"
   FROM "public"."company_members"
  WHERE ("company_members"."auth_user_id" = "auth"."uid"()))));


--
-- Name: autopay_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."autopay_schedules" ENABLE ROW LEVEL SECURITY;

--
-- Name: autopay_schedules autopay_schedules_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "autopay_schedules_read" ON "public"."autopay_schedules" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: autopay_schedules autopay_schedules_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "autopay_schedules_write" ON "public"."autopay_schedules" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: autopay_schedules autopay_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "autopay_staff" ON "public"."autopay_schedules" USING ("public"."is_company_staff"("company_id"));


--
-- Name: autopay_schedules autopay_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "autopay_tenant" ON "public"."autopay_schedules" FOR SELECT USING (("tenant" = "public"."get_tenant_name"("company_id")));


--
-- Name: autopay_schedules autopay_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "autopay_tenant_update" ON "public"."autopay_schedules" FOR UPDATE USING (("tenant" = "public"."get_tenant_name"("company_id")));


--
-- Name: autopay_schedules autopay_tenant_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "autopay_tenant_write" ON "public"."autopay_schedules" FOR INSERT WITH CHECK (("tenant" = "public"."get_tenant_name"("company_id")));


--
-- Name: bank_account_feed baf_company_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "baf_company_access" ON "public"."bank_account_feed" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: bank_account_feed; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."bank_account_feed" ENABLE ROW LEVEL SECURITY;

--
-- Name: bank_connection; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."bank_connection" ENABLE ROW LEVEL SECURITY;

--
-- Name: bank_feed_transaction; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."bank_feed_transaction" ENABLE ROW LEVEL SECURITY;

--
-- Name: bank_feed_transaction_link; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."bank_feed_transaction_link" ENABLE ROW LEVEL SECURITY;

--
-- Name: bank_import_batch; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."bank_import_batch" ENABLE ROW LEVEL SECURITY;

--
-- Name: bank_import_mapping_profile; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."bank_import_mapping_profile" ENABLE ROW LEVEL SECURITY;

--
-- Name: bank_posting_decision; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."bank_posting_decision" ENABLE ROW LEVEL SECURITY;

--
-- Name: bank_posting_decision_line; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."bank_posting_decision_line" ENABLE ROW LEVEL SECURITY;

--
-- Name: bank_reconciliations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."bank_reconciliations" ENABLE ROW LEVEL SECURITY;

--
-- Name: bank_reconciliations bank_reconciliations_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "bank_reconciliations_read" ON "public"."bank_reconciliations" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: bank_reconciliations bank_reconciliations_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "bank_reconciliations_write" ON "public"."bank_reconciliations" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: bank_transaction_rule; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."bank_transaction_rule" ENABLE ROW LEVEL SECURITY;

--
-- Name: bank_connection bc_company_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "bc_company_access" ON "public"."bank_connection" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: bank_feed_transaction bft_company_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "bft_company_access" ON "public"."bank_feed_transaction" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: bank_feed_transaction_link bftl_company_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "bftl_company_access" ON "public"."bank_feed_transaction_link" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: bank_import_batch bib_company_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "bib_company_access" ON "public"."bank_import_batch" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: bank_import_mapping_profile bimp_company_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "bimp_company_access" ON "public"."bank_import_mapping_profile" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: bank_posting_decision bpd_company_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "bpd_company_access" ON "public"."bank_posting_decision" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: bank_posting_decision_line bpdl_company_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "bpdl_company_access" ON "public"."bank_posting_decision_line" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: bank_transaction_rule btr_company_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "btr_company_access" ON "public"."bank_transaction_rule" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: budgets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."budgets" ENABLE ROW LEVEL SECURITY;

--
-- Name: budgets budgets_company_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "budgets_company_access" ON "public"."budgets" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: company_members cm_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cm_delete" ON "public"."company_members" FOR DELETE USING ("public"."is_member_of_company"("company_id"));


--
-- Name: company_members cm_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cm_insert" ON "public"."company_members" FOR INSERT WITH CHECK (("lower"("user_email") = "lower"((("current_setting"('request.jwt.claims'::"text", true))::json ->> 'email'::"text"))));


--
-- Name: company_members cm_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cm_read" ON "public"."company_members" FOR SELECT USING ((("lower"("user_email") = "lower"((("current_setting"('request.jwt.claims'::"text", true))::json ->> 'email'::"text"))) OR "public"."is_member_of_company"("company_id")));


--
-- Name: company_members cm_self_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cm_self_select" ON "public"."company_members" FOR SELECT USING ((("auth_user_id" = "auth"."uid"()) OR ("lower"("user_email") = "lower"("auth"."email"()))));


--
-- Name: company_members cm_staff_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cm_staff_all" ON "public"."company_members" USING ("public"."is_company_staff"("company_id"));


--
-- Name: company_members cm_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cm_update" ON "public"."company_members" FOR UPDATE USING ((("lower"("user_email") = "lower"((("current_setting"('request.jwt.claims'::"text", true))::json ->> 'email'::"text"))) OR "public"."is_member_of_company"("company_id")));


--
-- Name: companies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."companies" ENABLE ROW LEVEL SECURITY;

--
-- Name: companies companies_create; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "companies_create" ON "public"."companies" FOR INSERT WITH CHECK (("auth"."role"() = 'authenticated'::"text"));


--
-- Name: companies companies_member_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "companies_member_access" ON "public"."companies" USING (("id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: companies companies_search; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "companies_search" ON "public"."companies" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));


--
-- Name: company_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."company_members" ENABLE ROW LEVEL SECURITY;

--
-- Name: company_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."company_settings" ENABLE ROW LEVEL SECURITY;

--
-- Name: company_settings company_settings_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_settings_read" ON "public"."company_settings" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: company_settings company_settings_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "company_settings_write" ON "public"."company_settings" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: doc_exception_requests doc_exc_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "doc_exc_staff" ON "public"."doc_exception_requests" USING ("public"."is_company_staff"("company_id"));


--
-- Name: doc_exception_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."doc_exception_requests" ENABLE ROW LEVEL SECURITY;

--
-- Name: doc_generated; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."doc_generated" ENABLE ROW LEVEL SECURITY;

--
-- Name: doc_generated doc_generated_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "doc_generated_staff" ON "public"."doc_generated" USING ("public"."is_company_staff"("company_id"));


--
-- Name: doc_generated doc_generated_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "doc_generated_tenant" ON "public"."doc_generated" FOR SELECT USING (("tenant_name" = "public"."get_tenant_name"("company_id")));


--
-- Name: doc_signature_audit_log doc_sig_audit_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "doc_sig_audit_select" ON "public"."doc_signature_audit_log" FOR SELECT TO "authenticated" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("cm"."user_email" ~~* ("auth"."jwt"() ->> 'email'::"text")) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: doc_signature_audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."doc_signature_audit_log" ENABLE ROW LEVEL SECURITY;

--
-- Name: doc_signatures; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."doc_signatures" ENABLE ROW LEVEL SECURITY;

--
-- Name: doc_signatures doc_signatures_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "doc_signatures_insert" ON "public"."doc_signatures" FOR INSERT TO "authenticated" WITH CHECK (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("cm"."user_email" ~~* ("auth"."jwt"() ->> 'email'::"text")) AND ("cm"."status" = 'active'::"text") AND ("cm"."role" = ANY (ARRAY['admin'::"text", 'owner'::"text", 'pm'::"text", 'office_assistant'::"text"]))))));


--
-- Name: doc_signatures doc_signatures_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "doc_signatures_select" ON "public"."doc_signatures" FOR SELECT TO "authenticated" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("cm"."user_email" ~~* ("auth"."jwt"() ->> 'email'::"text")) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: doc_signatures doc_signatures_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "doc_signatures_update" ON "public"."doc_signatures" FOR UPDATE TO "authenticated" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("cm"."user_email" ~~* ("auth"."jwt"() ->> 'email'::"text")) AND ("cm"."status" = 'active'::"text") AND ("cm"."role" = ANY (ARRAY['admin'::"text", 'owner'::"text", 'pm'::"text", 'office_assistant'::"text"]))))));


--
-- Name: doc_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."doc_templates" ENABLE ROW LEVEL SECURITY;

--
-- Name: doc_templates doc_templates_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "doc_templates_staff" ON "public"."doc_templates" USING ("public"."is_company_staff"("company_id"));


--
-- Name: doc_templates doc_templates_system_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "doc_templates_system_read" ON "public"."doc_templates" FOR SELECT USING ((("company_id" = '00000000-0000-0000-0000-000000000000'::"text") OR ("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"((("current_setting"('request.jwt.claims'::"text", true))::json ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text"))))));


--
-- Name: documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."documents" ENABLE ROW LEVEL SECURITY;

--
-- Name: documents documents_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "documents_read" ON "public"."documents" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: documents documents_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "documents_staff" ON "public"."documents" USING ("public"."is_company_staff"("company_id"));


--
-- Name: documents documents_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "documents_tenant" ON "public"."documents" FOR SELECT USING ((("tenant" IS NOT NULL) AND ("btrim"("tenant") <> ''::"text") AND ("lower"("tenant") = "lower"("public"."get_tenant_name"("company_id")))));


--
-- Name: documents documents_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "documents_tenant_insert" ON "public"."documents" FOR INSERT WITH CHECK (("tenant" = "public"."get_tenant_name"("company_id")));


--
-- Name: documents documents_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "documents_write" ON "public"."documents" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: error_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."error_log" ENABLE ROW LEVEL SECURITY;

--
-- Name: eviction_cases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."eviction_cases" ENABLE ROW LEVEL SECURITY;

--
-- Name: eviction_cases eviction_cases_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "eviction_cases_staff" ON "public"."eviction_cases" USING ("public"."is_company_staff"("company_id")) WITH CHECK ("public"."is_company_staff"("company_id"));


--
-- Name: hoa_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."hoa_payments" ENABLE ROW LEVEL SECURITY;

--
-- Name: hoa_payments hoa_payments_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "hoa_payments_read" ON "public"."hoa_payments" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: hoa_payments hoa_payments_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "hoa_payments_write" ON "public"."hoa_payments" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: hoa_payments hoa_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "hoa_staff" ON "public"."hoa_payments" USING ("public"."is_company_staff"("company_id"));


--
-- Name: inspections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."inspections" ENABLE ROW LEVEL SECURITY;

--
-- Name: inspections inspections_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "inspections_read" ON "public"."inspections" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: inspections inspections_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "inspections_staff" ON "public"."inspections" USING ("public"."is_company_staff"("company_id"));


--
-- Name: inspections inspections_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "inspections_write" ON "public"."inspections" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: tenant_invite_codes invite_codes_create; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "invite_codes_create" ON "public"."tenant_invite_codes" FOR INSERT WITH CHECK (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: tenant_invite_codes invite_codes_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "invite_codes_read" ON "public"."tenant_invite_codes" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: tenant_invite_codes invite_codes_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "invite_codes_update" ON "public"."tenant_invite_codes" FOR UPDATE USING ((("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")) OR ("lower"("used_by") = "lower"(("auth"."jwt"() ->> 'email'::"text")))));


--
-- Name: acct_journal_lines je_lines_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "je_lines_access" ON "public"."acct_journal_lines" USING (("journal_entry_id" IN ( SELECT "acct_journal_entries"."id"
   FROM "public"."acct_journal_entries"
  WHERE ("acct_journal_entries"."company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")))));


--
-- Name: journal_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."journal_entries" ENABLE ROW LEVEL SECURITY;

--
-- Name: late_fee_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."late_fee_rules" ENABLE ROW LEVEL SECURITY;

--
-- Name: late_fee_rules late_fee_rules_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "late_fee_rules_read" ON "public"."late_fee_rules" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: late_fee_rules late_fee_rules_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "late_fee_rules_write" ON "public"."late_fee_rules" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: late_fee_rules late_fees_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "late_fees_staff" ON "public"."late_fee_rules" USING ("public"."is_company_staff"("company_id"));


--
-- Name: lease_signatures; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."lease_signatures" ENABLE ROW LEVEL SECURITY;

--
-- Name: lease_signatures lease_signatures_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "lease_signatures_read" ON "public"."lease_signatures" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: lease_signatures lease_signatures_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "lease_signatures_write" ON "public"."lease_signatures" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: lease_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."lease_templates" ENABLE ROW LEVEL SECURITY;

--
-- Name: lease_templates lease_templates_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "lease_templates_read" ON "public"."lease_templates" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: lease_templates lease_templates_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "lease_templates_write" ON "public"."lease_templates" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: lease_templates lease_tmpl_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "lease_tmpl_staff" ON "public"."lease_templates" USING ("public"."is_company_staff"("company_id"));


--
-- Name: leases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."leases" ENABLE ROW LEVEL SECURITY;

--
-- Name: leases leases_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "leases_read" ON "public"."leases" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: leases leases_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "leases_staff" ON "public"."leases" USING ("public"."is_company_staff"("company_id"));


--
-- Name: leases leases_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "leases_tenant" ON "public"."leases" FOR SELECT USING (("tenant_name" = "public"."get_tenant_name"("company_id")));


--
-- Name: leases leases_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "leases_write" ON "public"."leases" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: ledger_entries_legacy_table; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ledger_entries_legacy_table" ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_entries_legacy_table ledger_entries_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "ledger_entries_read" ON "public"."ledger_entries_legacy_table" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: ledger_entries_legacy_table ledger_entries_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "ledger_entries_write" ON "public"."ledger_entries_legacy_table" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: ledger_entries_legacy_table ledger_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "ledger_staff" ON "public"."ledger_entries_legacy_table" USING ("public"."is_company_staff"("company_id"));


--
-- Name: company_members members_company_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members_company_access" ON "public"."company_members" FOR SELECT USING ((("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")) OR ("lower"("user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text")))));


--
-- Name: company_members members_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members_manage" ON "public"."company_members" FOR INSERT WITH CHECK (((("lower"("user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("status" = 'pending'::"text")) OR (("lower"("user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("role" = 'admin'::"text") AND ("invited_by" = 'self'::"text") AND ("company_id" IN ( SELECT "companies"."id"
   FROM "public"."companies"
  WHERE ("lower"("companies"."created_by") = "lower"(("auth"."jwt"() ->> 'email'::"text")))))) OR "public"."is_company_admin"("company_id")));


--
-- Name: company_members members_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members_update" ON "public"."company_members" FOR UPDATE USING ("public"."is_company_admin"("company_id"));


--
-- Name: messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;

--
-- Name: messages messages_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "messages_read" ON "public"."messages" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: messages messages_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "messages_staff" ON "public"."messages" USING ("public"."is_company_staff"("company_id"));


--
-- Name: messages messages_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "messages_tenant_read" ON "public"."messages" FOR SELECT USING (("tenant" = "public"."get_tenant_name"("company_id")));


--
-- Name: messages messages_tenant_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "messages_tenant_write" ON "public"."messages" FOR INSERT WITH CHECK (("tenant" = "public"."get_tenant_name"("company_id")));


--
-- Name: messages messages_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "messages_write" ON "public"."messages" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: notification_log notif_log_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "notif_log_staff" ON "public"."notification_log" USING ("public"."is_company_staff"("company_id"));


--
-- Name: notification_settings notif_settings_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "notif_settings_staff" ON "public"."notification_settings" USING ("public"."is_company_staff"("company_id"));


--
-- Name: notification_inbox; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."notification_inbox" ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."notification_log" ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_log notification_log_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "notification_log_read" ON "public"."notification_log" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: notification_log notification_log_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "notification_log_write" ON "public"."notification_log" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: notification_queue; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."notification_queue" ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."notification_settings" ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_settings notification_settings_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "notification_settings_read" ON "public"."notification_settings" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: notification_settings notification_settings_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "notification_settings_write" ON "public"."notification_settings" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: notification_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."notification_templates" ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_queue nq_company_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "nq_company_isolation_delete" ON "public"."notification_queue" FOR DELETE USING ((("auth"."role"() = 'service_role'::"text") OR ("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text"))))));


--
-- Name: notification_queue nq_company_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "nq_company_isolation_insert" ON "public"."notification_queue" FOR INSERT WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("cm"."status" = ANY (ARRAY['active'::"text", 'pending'::"text", 'invited'::"text"])))))));


--
-- Name: notification_queue nq_company_isolation_modify; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "nq_company_isolation_modify" ON "public"."notification_queue" FOR UPDATE USING ((("auth"."role"() = 'service_role'::"text") OR ("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text"))))));


--
-- Name: notification_queue nq_company_isolation_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "nq_company_isolation_read" ON "public"."notification_queue" FOR SELECT USING ((("auth"."role"() = 'service_role'::"text") OR ("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text"))))));


--
-- Name: owner_distributions owner_dist_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner_dist_self" ON "public"."owner_distributions" FOR SELECT USING (("owner_id" = "public"."get_owner_id"("company_id")));


--
-- Name: owner_distributions owner_dist_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner_dist_staff" ON "public"."owner_distributions" USING ("public"."is_company_staff"("company_id"));


--
-- Name: owner_distributions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."owner_distributions" ENABLE ROW LEVEL SECURITY;

--
-- Name: owner_distributions owner_distributions_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner_distributions_read" ON "public"."owner_distributions" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: owner_distributions owner_distributions_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner_distributions_write" ON "public"."owner_distributions" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: owner_statements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."owner_statements" ENABLE ROW LEVEL SECURITY;

--
-- Name: owner_statements owner_statements_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner_statements_read" ON "public"."owner_statements" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: owner_statements owner_statements_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner_statements_write" ON "public"."owner_statements" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: owner_statements owner_stmts_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner_stmts_self" ON "public"."owner_statements" FOR SELECT USING (("owner_id" = "public"."get_owner_id"("company_id")));


--
-- Name: owner_statements owner_stmts_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner_stmts_staff" ON "public"."owner_statements" USING ("public"."is_company_staff"("company_id"));


--
-- Name: owners; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."owners" ENABLE ROW LEVEL SECURITY;

--
-- Name: owners owners_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owners_read" ON "public"."owners" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: owners owners_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owners_self" ON "public"."owners" FOR SELECT USING ((("lower"("email") = "lower"("auth"."email"())) AND "public"."is_company_member"("company_id")));


--
-- Name: owners owners_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owners_staff" ON "public"."owners" USING ("public"."is_company_staff"("company_id"));


--
-- Name: owners owners_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owners_write" ON "public"."owners" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;

--
-- Name: payments payments_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "payments_read" ON "public"."payments" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: payments payments_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "payments_staff" ON "public"."payments" USING ("public"."is_company_staff"("company_id"));


--
-- Name: payments payments_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "payments_tenant_insert" ON "public"."payments" FOR INSERT WITH CHECK (("tenant" = "public"."get_tenant_name"("company_id")));


--
-- Name: payments payments_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "payments_tenant_read" ON "public"."payments" FOR SELECT USING (("tenant" = "public"."get_tenant_name"("company_id")));


--
-- Name: payments payments_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "payments_write" ON "public"."payments" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: plaid_sync_event; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."plaid_sync_event" ENABLE ROW LEVEL SECURITY;

--
-- Name: pm_assignment_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."pm_assignment_requests" ENABLE ROW LEVEL SECURITY;

--
-- Name: pm_assignment_requests pm_req_pm_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "pm_req_pm_read" ON "public"."pm_assignment_requests" FOR SELECT USING (("pm_company_id" IN ( SELECT "company_members"."company_id"
   FROM "public"."company_members"
  WHERE (("lower"("company_members"."user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("company_members"."status" = 'active'::"text")))));


--
-- Name: pm_assignment_requests pm_req_pm_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "pm_req_pm_update" ON "public"."pm_assignment_requests" FOR UPDATE USING (("pm_company_id" IN ( SELECT "company_members"."company_id"
   FROM "public"."company_members"
  WHERE (("lower"("company_members"."user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("company_members"."status" = 'active'::"text") AND ("company_members"."role" = 'admin'::"text")))));


--
-- Name: properties; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."properties" ENABLE ROW LEVEL SECURITY;

--
-- Name: properties properties_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "properties_owner" ON "public"."properties" FOR SELECT USING (("owner_id" = "public"."get_owner_id"("company_id")));


--
-- Name: properties properties_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "properties_select" ON "public"."properties" FOR SELECT USING ((("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")) OR ("pm_company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids"))));


--
-- Name: properties properties_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "properties_staff" ON "public"."properties" USING ("public"."is_company_staff"("company_id"));


--
-- Name: properties properties_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "properties_tenant" ON "public"."properties" FOR SELECT USING (("address" IN ( SELECT "tenants"."property"
   FROM "public"."tenants"
  WHERE (("tenants"."name" = "public"."get_tenant_name"("properties"."company_id")) AND ("tenants"."company_id" = "properties"."company_id") AND ("tenants"."archived_at" IS NULL)))));


--
-- Name: property_change_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."property_change_requests" ENABLE ROW LEVEL SECURITY;

--
-- Name: property_change_requests property_change_requests_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "property_change_requests_read" ON "public"."property_change_requests" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: property_change_requests property_change_requests_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "property_change_requests_write" ON "public"."property_change_requests" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: property_insurance; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."property_insurance" ENABLE ROW LEVEL SECURITY;

--
-- Name: property_insurance property_insurance_company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "property_insurance_company_isolation" ON "public"."property_insurance" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"((("current_setting"('request.jwt.claims'::"text", true))::json ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text"))))) WITH CHECK (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"((("current_setting"('request.jwt.claims'::"text", true))::json ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: property_licenses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."property_licenses" ENABLE ROW LEVEL SECURITY;

--
-- Name: property_licenses property_licenses_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "property_licenses_insert" ON "public"."property_licenses" FOR INSERT TO "authenticated" WITH CHECK (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("cm"."user_email" ~~* ("auth"."jwt"() ->> 'email'::"text")) AND ("cm"."status" = 'active'::"text") AND ("cm"."role" = ANY (ARRAY['admin'::"text", 'owner'::"text", 'pm'::"text", 'office_assistant'::"text"]))))));


--
-- Name: property_licenses property_licenses_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "property_licenses_select" ON "public"."property_licenses" FOR SELECT TO "authenticated" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("cm"."user_email" ~~* ("auth"."jwt"() ->> 'email'::"text")) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: property_licenses property_licenses_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "property_licenses_update" ON "public"."property_licenses" FOR UPDATE TO "authenticated" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("cm"."user_email" ~~* ("auth"."jwt"() ->> 'email'::"text")) AND ("cm"."status" = 'active'::"text") AND ("cm"."role" = ANY (ARRAY['admin'::"text", 'owner'::"text", 'pm'::"text", 'office_assistant'::"text"]))))));


--
-- Name: property_loans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."property_loans" ENABLE ROW LEVEL SECURITY;

--
-- Name: property_loans property_loans_company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "property_loans_company_isolation" ON "public"."property_loans" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"((("current_setting"('request.jwt.claims'::"text", true))::json ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text"))))) WITH CHECK (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"((("current_setting"('request.jwt.claims'::"text", true))::json ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: property_setup_wizard; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."property_setup_wizard" ENABLE ROW LEVEL SECURITY;

--
-- Name: property_setup_wizard property_setup_wizard_company_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "property_setup_wizard_company_isolation" ON "public"."property_setup_wizard" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"((("current_setting"('request.jwt.claims'::"text", true))::json ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text"))))) WITH CHECK (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"((("current_setting"('request.jwt.claims'::"text", true))::json ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: property_tax_bills; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."property_tax_bills" ENABLE ROW LEVEL SECURITY;

--
-- Name: property_tax_bills property_tax_bills_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "property_tax_bills_insert" ON "public"."property_tax_bills" FOR INSERT TO "authenticated" WITH CHECK (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("cm"."user_email" ~~* ("auth"."jwt"() ->> 'email'::"text")) AND ("cm"."status" = 'active'::"text") AND ("cm"."role" = ANY (ARRAY['admin'::"text", 'owner'::"text", 'pm'::"text", 'office_assistant'::"text"]))))));


--
-- Name: property_tax_bills property_tax_bills_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "property_tax_bills_select" ON "public"."property_tax_bills" FOR SELECT TO "authenticated" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("cm"."user_email" ~~* ("auth"."jwt"() ->> 'email'::"text")) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: property_tax_bills property_tax_bills_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "property_tax_bills_update" ON "public"."property_tax_bills" FOR UPDATE TO "authenticated" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("cm"."user_email" ~~* ("auth"."jwt"() ->> 'email'::"text")) AND ("cm"."status" = 'active'::"text") AND ("cm"."role" = ANY (ARRAY['admin'::"text", 'owner'::"text", 'pm'::"text", 'office_assistant'::"text"]))))));


--
-- Name: property_taxes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."property_taxes" ENABLE ROW LEVEL SECURITY;

--
-- Name: property_taxes property_taxes_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "property_taxes_insert" ON "public"."property_taxes" FOR INSERT TO "authenticated" WITH CHECK (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("cm"."user_email" ~~* ("auth"."jwt"() ->> 'email'::"text")) AND ("cm"."status" = 'active'::"text") AND ("cm"."role" = ANY (ARRAY['admin'::"text", 'owner'::"text", 'pm'::"text", 'office_assistant'::"text"]))))));


--
-- Name: property_taxes property_taxes_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "property_taxes_select" ON "public"."property_taxes" FOR SELECT TO "authenticated" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("cm"."user_email" ~~* ("auth"."jwt"() ->> 'email'::"text")) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: property_taxes property_taxes_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "property_taxes_update" ON "public"."property_taxes" FOR UPDATE TO "authenticated" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("cm"."user_email" ~~* ("auth"."jwt"() ->> 'email'::"text")) AND ("cm"."status" = 'active'::"text") AND ("cm"."role" = ANY (ARRAY['admin'::"text", 'owner'::"text", 'pm'::"text", 'office_assistant'::"text"]))))));


--
-- Name: utility_providers providers_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "providers_read" ON "public"."utility_providers" FOR SELECT USING (true);


--
-- Name: push_subscriptions ps_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "ps_user_isolation" ON "public"."push_subscriptions" USING ((("auth"."role"() = 'service_role'::"text") OR ("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("cm"."status" = ANY (ARRAY['active'::"text", 'pending'::"text", 'invited'::"text"]))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("cm"."status" = ANY (ARRAY['active'::"text", 'pending'::"text", 'invited'::"text"])))))));


--
-- Name: plaid_sync_event pse_company_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "pse_company_access" ON "public"."plaid_sync_event" USING (("company_id" IN ( SELECT "cm"."company_id"
   FROM "public"."company_members" "cm"
  WHERE (("lower"("cm"."user_email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))) AND ("cm"."status" = 'active'::"text")))));


--
-- Name: push_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."push_attempts" ENABLE ROW LEVEL SECURITY;

--
-- Name: push_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."push_subscriptions" ENABLE ROW LEVEL SECURITY;

--
-- Name: recurring_journal_entries recurring_je_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "recurring_je_staff" ON "public"."recurring_journal_entries" USING ("public"."is_company_staff"("company_id"));


--
-- Name: recurring_journal_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."recurring_journal_entries" ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_invite_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."tenant_invite_codes" ENABLE ROW LEVEL SECURITY;

--
-- Name: tenants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."tenants" ENABLE ROW LEVEL SECURITY;

--
-- Name: tenants tenants_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "tenants_read" ON "public"."tenants" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: tenants tenants_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "tenants_self" ON "public"."tenants" FOR SELECT USING ((("lower"("email") = "lower"("auth"."email"())) AND "public"."is_company_member"("company_id")));


--
-- Name: tenants tenants_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "tenants_staff" ON "public"."tenants" USING ("public"."is_company_staff"("company_id"));


--
-- Name: tenants tenants_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "tenants_write" ON "public"."tenants" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: utility_accounts util_accts_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "util_accts_staff" ON "public"."utility_accounts" USING ("public"."is_company_staff"("company_id"));


--
-- Name: utilities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."utilities" ENABLE ROW LEVEL SECURITY;

--
-- Name: utilities utilities_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "utilities_read" ON "public"."utilities" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: utilities utilities_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "utilities_staff" ON "public"."utilities" USING ("public"."is_company_staff"("company_id"));


--
-- Name: utilities utilities_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "utilities_write" ON "public"."utilities" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: utility_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."utility_accounts" ENABLE ROW LEVEL SECURITY;

--
-- Name: utility_accounts utility_accounts_company; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "utility_accounts_company" ON "public"."utility_accounts" USING (("company_id" IN ( SELECT "company_members"."company_id"
   FROM "public"."company_members"
  WHERE ("company_members"."auth_user_id" = "auth"."uid"()))));


--
-- Name: utility_audit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."utility_audit" ENABLE ROW LEVEL SECURITY;

--
-- Name: utility_audit utility_audit_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "utility_audit_read" ON "public"."utility_audit" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: utility_audit utility_audit_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "utility_audit_write" ON "public"."utility_audit" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: utility_bills; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."utility_bills" ENABLE ROW LEVEL SECURITY;

--
-- Name: utility_bills utility_bills_company; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "utility_bills_company" ON "public"."utility_bills" USING (("company_id" IN ( SELECT "company_members"."company_id"
   FROM "public"."company_members"
  WHERE ("company_members"."auth_user_id" = "auth"."uid"()))));


--
-- Name: utility_providers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."utility_providers" ENABLE ROW LEVEL SECURITY;

--
-- Name: vendor_invoices vendor_inv_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "vendor_inv_staff" ON "public"."vendor_invoices" USING ("public"."is_company_staff"("company_id"));


--
-- Name: vendor_invoices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."vendor_invoices" ENABLE ROW LEVEL SECURITY;

--
-- Name: vendor_invoices vendor_invoices_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "vendor_invoices_read" ON "public"."vendor_invoices" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: vendor_invoices vendor_invoices_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "vendor_invoices_write" ON "public"."vendor_invoices" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: vendors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."vendors" ENABLE ROW LEVEL SECURITY;

--
-- Name: vendors vendors_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "vendors_read" ON "public"."vendors" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: vendors vendors_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "vendors_staff" ON "public"."vendors" USING ("public"."is_company_staff"("company_id"));


--
-- Name: vendors vendors_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "vendors_write" ON "public"."vendors" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: work_order_photos wo_photos_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "wo_photos_access" ON "public"."work_order_photos" USING ((("work_order_id")::"text" IN ( SELECT ("work_orders"."id")::"text" AS "id"
   FROM "public"."work_orders"
  WHERE ("work_orders"."company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")))));


--
-- Name: work_order_photos wo_photos_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "wo_photos_staff" ON "public"."work_order_photos" USING ("public"."is_company_staff"("company_id"));


--
-- Name: work_order_photos wo_photos_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "wo_photos_tenant" ON "public"."work_order_photos" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."work_orders" "wo"
  WHERE ((("wo"."id")::"text" = ("work_order_photos"."work_order_id")::"text") AND ("wo"."tenant" = "public"."get_tenant_name"("wo"."company_id"))))));


--
-- Name: work_order_photos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."work_order_photos" ENABLE ROW LEVEL SECURITY;

--
-- Name: work_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."work_orders" ENABLE ROW LEVEL SECURITY;

--
-- Name: work_orders work_orders_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "work_orders_read" ON "public"."work_orders" FOR SELECT USING (("company_id" IN ( SELECT "public"."get_user_company_ids"() AS "get_user_company_ids")));


--
-- Name: work_orders work_orders_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "work_orders_staff" ON "public"."work_orders" USING ("public"."is_company_staff"("company_id"));


--
-- Name: work_orders work_orders_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "work_orders_tenant_insert" ON "public"."work_orders" FOR INSERT WITH CHECK (("tenant" = "public"."get_tenant_name"("company_id")));


--
-- Name: work_orders work_orders_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "work_orders_tenant_read" ON "public"."work_orders" FOR SELECT USING (("tenant" = "public"."get_tenant_name"("company_id")));


--
-- Name: work_orders work_orders_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "work_orders_write" ON "public"."work_orders" USING ("public"."has_write_access"("company_id")) WITH CHECK ("public"."has_write_access"("company_id"));


--
-- Name: SCHEMA "public"; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";


--
-- Name: FUNCTION "_doc_signatures_audit_trg"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."_doc_signatures_audit_trg"() TO "anon";
GRANT ALL ON FUNCTION "public"."_doc_signatures_audit_trg"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."_doc_signatures_audit_trg"() TO "service_role";


--
-- Name: FUNCTION "_gen_signing_token"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."_gen_signing_token"() TO "anon";
GRANT ALL ON FUNCTION "public"."_gen_signing_token"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."_gen_signing_token"() TO "service_role";


--
-- Name: FUNCTION "_wizard_get_tenant_ar"("p_company_id" "text", "p_tenant_name" "text", "p_tenant_id" bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."_wizard_get_tenant_ar"("p_company_id" "text", "p_tenant_name" "text", "p_tenant_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."_wizard_get_tenant_ar"("p_company_id" "text", "p_tenant_name" "text", "p_tenant_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."_wizard_get_tenant_ar"("p_company_id" "text", "p_tenant_name" "text", "p_tenant_id" bigint) TO "service_role";


--
-- Name: FUNCTION "_wizard_resolve_account"("p_company_id" "text", "p_code" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."_wizard_resolve_account"("p_company_id" "text", "p_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."_wizard_resolve_account"("p_company_id" "text", "p_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."_wizard_resolve_account"("p_company_id" "text", "p_code" "text") TO "service_role";


--
-- Name: FUNCTION "accept_pm_assignment"("p_request_id" "uuid", "p_pm_company_id" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."accept_pm_assignment"("p_request_id" "uuid", "p_pm_company_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."accept_pm_assignment"("p_request_id" "uuid", "p_pm_company_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."accept_pm_assignment"("p_request_id" "uuid", "p_pm_company_id" "text") TO "service_role";


--
-- Name: FUNCTION "accept_pm_assignment"("p_request_id" "text", "p_pm_company_id" "text", "p_reviewer_email" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."accept_pm_assignment"("p_request_id" "text", "p_pm_company_id" "text", "p_reviewer_email" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."accept_pm_assignment"("p_request_id" "text", "p_pm_company_id" "text", "p_reviewer_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."accept_pm_assignment"("p_request_id" "text", "p_pm_company_id" "text", "p_reviewer_email" "text") TO "service_role";


--
-- Name: FUNCTION "apply_late_fee_atomic"("p_company_id" "text", "p_tenant_id" "uuid", "p_tenant_name" "text", "p_property" "text", "p_fee_amount" numeric, "p_je_number" "text", "p_je_date" "text", "p_description" "text", "p_reference" "text", "p_late_fee_account_id" "uuid", "p_ar_account_id" "uuid", "p_class_id" "uuid"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."apply_late_fee_atomic"("p_company_id" "text", "p_tenant_id" "uuid", "p_tenant_name" "text", "p_property" "text", "p_fee_amount" numeric, "p_je_number" "text", "p_je_date" "text", "p_description" "text", "p_reference" "text", "p_late_fee_account_id" "uuid", "p_ar_account_id" "uuid", "p_class_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."apply_late_fee_atomic"("p_company_id" "text", "p_tenant_id" "uuid", "p_tenant_name" "text", "p_property" "text", "p_fee_amount" numeric, "p_je_number" "text", "p_je_date" "text", "p_description" "text", "p_reference" "text", "p_late_fee_account_id" "uuid", "p_ar_account_id" "uuid", "p_class_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_late_fee_atomic"("p_company_id" "text", "p_tenant_id" "uuid", "p_tenant_name" "text", "p_property" "text", "p_fee_amount" numeric, "p_je_number" "text", "p_je_date" "text", "p_description" "text", "p_reference" "text", "p_late_fee_account_id" "uuid", "p_ar_account_id" "uuid", "p_class_id" "uuid") TO "service_role";


--
-- Name: FUNCTION "approve_member_request"("p_member_id" bigint, "p_role" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."approve_member_request"("p_member_id" bigint, "p_role" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."approve_member_request"("p_member_id" bigint, "p_role" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."approve_member_request"("p_member_id" bigint, "p_role" "text") TO "service_role";


--
-- Name: FUNCTION "archive_property"("p_property_id" bigint, "p_company_id" "text", "p_archived_by" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."archive_property"("p_property_id" bigint, "p_company_id" "text", "p_archived_by" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."archive_property"("p_property_id" bigint, "p_company_id" "text", "p_archived_by" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."archive_property"("p_property_id" bigint, "p_company_id" "text", "p_archived_by" "text") TO "service_role";


--
-- Name: FUNCTION "archive_property"("p_company_id" "text", "p_property_id" "text", "p_address" "text", "p_archive_tenant" boolean, "p_user_email" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."archive_property"("p_company_id" "text", "p_property_id" "text", "p_address" "text", "p_archive_tenant" boolean, "p_user_email" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."archive_property"("p_company_id" "text", "p_property_id" "text", "p_address" "text", "p_archive_tenant" boolean, "p_user_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."archive_property"("p_company_id" "text", "p_property_id" "text", "p_address" "text", "p_archive_tenant" boolean, "p_user_email" "text") TO "service_role";


--
-- Name: FUNCTION "audit_trigger_func"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."audit_trigger_func"() TO "anon";
GRANT ALL ON FUNCTION "public"."audit_trigger_func"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."audit_trigger_func"() TO "service_role";


--
-- Name: FUNCTION "auto_fill_property_id"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."auto_fill_property_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."auto_fill_property_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auto_fill_property_id"() TO "service_role";


--
-- Name: FUNCTION "batch_post_rent_charges"("p_company_id" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."batch_post_rent_charges"("p_company_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."batch_post_rent_charges"("p_company_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."batch_post_rent_charges"("p_company_id" "text") TO "service_role";


--
-- Name: FUNCTION "change_user_email"("p_old_email" "text", "p_new_email" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."change_user_email"("p_old_email" "text", "p_new_email" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."change_user_email"("p_old_email" "text", "p_new_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."change_user_email"("p_old_email" "text", "p_new_email" "text") TO "service_role";


--
-- Name: FUNCTION "change_user_email"("p_company_id" "text", "p_user_id" "text", "p_old_email" "text", "p_new_email" "text", "p_name" "text", "p_role" "text", "p_custom_pages" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."change_user_email"("p_company_id" "text", "p_user_id" "text", "p_old_email" "text", "p_new_email" "text", "p_name" "text", "p_role" "text", "p_custom_pages" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."change_user_email"("p_company_id" "text", "p_user_id" "text", "p_old_email" "text", "p_new_email" "text", "p_name" "text", "p_role" "text", "p_custom_pages" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."change_user_email"("p_company_id" "text", "p_user_id" "text", "p_old_email" "text", "p_new_email" "text", "p_name" "text", "p_role" "text", "p_custom_pages" "text") TO "service_role";


--
-- Name: FUNCTION "commit_property_wizard"("p_payload" "jsonb"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."commit_property_wizard"("p_payload" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."commit_property_wizard"("p_payload" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."commit_property_wizard"("p_payload" "jsonb") TO "service_role";


--
-- Name: FUNCTION "compute_property_address"("p_line1" "text", "p_line2" "text", "p_city" "text", "p_state" "text", "p_zip" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."compute_property_address"("p_line1" "text", "p_line2" "text", "p_city" "text", "p_state" "text", "p_zip" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."compute_property_address"("p_line1" "text", "p_line2" "text", "p_city" "text", "p_state" "text", "p_zip" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."compute_property_address"("p_line1" "text", "p_line2" "text", "p_city" "text", "p_state" "text", "p_zip" "text") TO "service_role";


--
-- Name: FUNCTION "create_company_atomic"("p_company_id" "text", "p_name" "text", "p_type" "text", "p_company_code" "text", "p_company_role" "text", "p_address" "text", "p_phone" "text", "p_email" "text", "p_creator_email" "text", "p_creator_name" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."create_company_atomic"("p_company_id" "text", "p_name" "text", "p_type" "text", "p_company_code" "text", "p_company_role" "text", "p_address" "text", "p_phone" "text", "p_email" "text", "p_creator_email" "text", "p_creator_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."create_company_atomic"("p_company_id" "text", "p_name" "text", "p_type" "text", "p_company_code" "text", "p_company_role" "text", "p_address" "text", "p_phone" "text", "p_email" "text", "p_creator_email" "text", "p_creator_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_company_atomic"("p_company_id" "text", "p_name" "text", "p_type" "text", "p_company_code" "text", "p_company_role" "text", "p_address" "text", "p_phone" "text", "p_email" "text", "p_creator_email" "text", "p_creator_name" "text") TO "service_role";


--
-- Name: FUNCTION "create_doc_envelope"("p_doc_id" "uuid", "p_signers" "jsonb"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."create_doc_envelope"("p_doc_id" "uuid", "p_signers" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_doc_envelope"("p_doc_id" "uuid", "p_signers" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."create_doc_envelope"("p_doc_id" "uuid", "p_signers" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_doc_envelope"("p_doc_id" "uuid", "p_signers" "jsonb") TO "service_role";


--
-- Name: FUNCTION "delete_property_cascade"("p_company_id" "text", "p_property_id" "text", "p_address" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."delete_property_cascade"("p_company_id" "text", "p_property_id" "text", "p_address" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."delete_property_cascade"("p_company_id" "text", "p_property_id" "text", "p_address" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_property_cascade"("p_company_id" "text", "p_property_id" "text", "p_address" "text") TO "service_role";


--
-- Name: FUNCTION "delete_tenant_cascade"("p_company_id" "text", "p_tenant_id" integer, "p_tenant_name" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."delete_tenant_cascade"("p_company_id" "text", "p_tenant_id" integer, "p_tenant_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."delete_tenant_cascade"("p_company_id" "text", "p_tenant_id" integer, "p_tenant_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_tenant_cascade"("p_company_id" "text", "p_tenant_id" integer, "p_tenant_name" "text") TO "service_role";


--
-- Name: FUNCTION "find_unbalanced_jes"("p_company_id" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."find_unbalanced_jes"("p_company_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."find_unbalanced_jes"("p_company_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."find_unbalanced_jes"("p_company_id" "text") TO "service_role";


--
-- Name: FUNCTION "get_owner_id"("p_company_id" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."get_owner_id"("p_company_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_owner_id"("p_company_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_owner_id"("p_company_id" "text") TO "service_role";


--
-- Name: FUNCTION "get_signature_by_token"("p_token" "text"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."get_signature_by_token"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_signature_by_token"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_signature_by_token"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_signature_by_token"("p_token" "text") TO "service_role";


--
-- Name: FUNCTION "is_company_staff"("p_company_id" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."is_company_staff"("p_company_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."is_company_staff"("p_company_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_company_staff"("p_company_id" "text") TO "service_role";


--
-- Name: TABLE "acct_accounts"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."acct_accounts" TO "anon";
GRANT ALL ON TABLE "public"."acct_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."acct_accounts" TO "service_role";


--
-- Name: TABLE "acct_journal_entries"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."acct_journal_entries" TO "anon";
GRANT ALL ON TABLE "public"."acct_journal_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."acct_journal_entries" TO "service_role";


--
-- Name: TABLE "acct_journal_lines"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."acct_journal_lines" TO "anon";
GRANT ALL ON TABLE "public"."acct_journal_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."acct_journal_lines" TO "service_role";


--
-- Name: TABLE "tenants"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."tenants" TO "anon";
GRANT ALL ON TABLE "public"."tenants" TO "authenticated";
GRANT ALL ON TABLE "public"."tenants" TO "service_role";


--
-- Name: TABLE "ledger_entries"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."ledger_entries" TO "anon";
GRANT ALL ON TABLE "public"."ledger_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."ledger_entries" TO "service_role";


--
-- Name: FUNCTION "get_tenant_ledger"("p_company_id" "text", "p_tenant_id" bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."get_tenant_ledger"("p_company_id" "text", "p_tenant_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."get_tenant_ledger"("p_company_id" "text", "p_tenant_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_tenant_ledger"("p_company_id" "text", "p_tenant_id" bigint) TO "service_role";


--
-- Name: FUNCTION "get_tenant_name"("p_company_id" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."get_tenant_name"("p_company_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_tenant_name"("p_company_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_tenant_name"("p_company_id" "text") TO "service_role";


--
-- Name: FUNCTION "get_user_company_ids"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."get_user_company_ids"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_user_company_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_company_ids"() TO "service_role";


--
-- Name: FUNCTION "handle_membership_request"("p_member_id" bigint, "p_action" "text", "p_role" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."handle_membership_request"("p_member_id" bigint, "p_action" "text", "p_role" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."handle_membership_request"("p_member_id" bigint, "p_action" "text", "p_role" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_membership_request"("p_member_id" bigint, "p_action" "text", "p_role" "text") TO "service_role";


--
-- Name: FUNCTION "handle_membership_request"("p_company_id" "text", "p_member_id" "text", "p_action" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."handle_membership_request"("p_company_id" "text", "p_member_id" "text", "p_action" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."handle_membership_request"("p_company_id" "text", "p_member_id" "text", "p_action" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_membership_request"("p_company_id" "text", "p_member_id" "text", "p_action" "text") TO "service_role";


--
-- Name: FUNCTION "hard_delete_company"("p_company_id" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."hard_delete_company"("p_company_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."hard_delete_company"("p_company_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."hard_delete_company"("p_company_id" "text") TO "service_role";


--
-- Name: FUNCTION "has_write_access"("p_company_id" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."has_write_access"("p_company_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."has_write_access"("p_company_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_write_access"("p_company_id" "text") TO "service_role";


--
-- Name: FUNCTION "increment_rule_stats"("rule_id" "uuid"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."increment_rule_stats"("rule_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."increment_rule_stats"("rule_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_rule_stats"("rule_id" "uuid") TO "service_role";


--
-- Name: FUNCTION "increment_vendor_totals"("p_vendor_id" bigint, "p_amount" numeric); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."increment_vendor_totals"("p_vendor_id" bigint, "p_amount" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."increment_vendor_totals"("p_vendor_id" bigint, "p_amount" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_vendor_totals"("p_vendor_id" bigint, "p_amount" numeric) TO "service_role";


--
-- Name: FUNCTION "increment_vendor_totals"("p_company_id" "text", "p_vendor_id" "text", "p_amount" numeric); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."increment_vendor_totals"("p_company_id" "text", "p_vendor_id" "text", "p_amount" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."increment_vendor_totals"("p_company_id" "text", "p_vendor_id" "text", "p_amount" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_vendor_totals"("p_company_id" "text", "p_vendor_id" "text", "p_amount" numeric) TO "service_role";


--
-- Name: FUNCTION "insert_ledger_entry_with_balance"("p_company_id" "text", "p_tenant" "text", "p_tenant_id" bigint, "p_property" "text", "p_date" "text", "p_description" "text", "p_amount" numeric, "p_type" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."insert_ledger_entry_with_balance"("p_company_id" "text", "p_tenant" "text", "p_tenant_id" bigint, "p_property" "text", "p_date" "text", "p_description" "text", "p_amount" numeric, "p_type" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."insert_ledger_entry_with_balance"("p_company_id" "text", "p_tenant" "text", "p_tenant_id" bigint, "p_property" "text", "p_date" "text", "p_description" "text", "p_amount" numeric, "p_type" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."insert_ledger_entry_with_balance"("p_company_id" "text", "p_tenant" "text", "p_tenant_id" bigint, "p_property" "text", "p_date" "text", "p_description" "text", "p_amount" numeric, "p_type" "text") TO "service_role";


--
-- Name: FUNCTION "is_company_admin"("p_company_id" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."is_company_admin"("p_company_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."is_company_admin"("p_company_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_company_admin"("p_company_id" "text") TO "service_role";


--
-- Name: FUNCTION "is_company_member"("p_company_id" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."is_company_member"("p_company_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."is_company_member"("p_company_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_company_member"("p_company_id" "text") TO "service_role";


--
-- Name: FUNCTION "is_member_of_company"("p_company_id" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."is_member_of_company"("p_company_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."is_member_of_company"("p_company_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_member_of_company"("p_company_id" "text") TO "service_role";


--
-- Name: FUNCTION "move_out_commit_state"("p_company_id" "text", "p_lease_id" "uuid", "p_tenant_id" bigint, "p_tenant_name" "text", "p_property" "text", "p_move_out_date" "date", "p_archived_by" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."move_out_commit_state"("p_company_id" "text", "p_lease_id" "uuid", "p_tenant_id" bigint, "p_tenant_name" "text", "p_property" "text", "p_move_out_date" "date", "p_archived_by" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."move_out_commit_state"("p_company_id" "text", "p_lease_id" "uuid", "p_tenant_id" bigint, "p_tenant_name" "text", "p_property" "text", "p_move_out_date" "date", "p_archived_by" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."move_out_commit_state"("p_company_id" "text", "p_lease_id" "uuid", "p_tenant_id" bigint, "p_tenant_name" "text", "p_property" "text", "p_move_out_date" "date", "p_archived_by" "text") TO "service_role";


--
-- Name: FUNCTION "next_je_number"("p_company_id" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."next_je_number"("p_company_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."next_je_number"("p_company_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."next_je_number"("p_company_id" "text") TO "service_role";


--
-- Name: FUNCTION "next_journal_number"("p_company_id" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."next_journal_number"("p_company_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."next_journal_number"("p_company_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."next_journal_number"("p_company_id" "text") TO "service_role";


--
-- Name: FUNCTION "post_je_and_ledger"("p_company_id" "text", "p_date" "text", "p_description" "text", "p_reference" "text", "p_property" "text", "p_status" "text", "p_lines" "jsonb", "p_ledger_tenant" "text", "p_ledger_tenant_id" bigint, "p_ledger_property" "text", "p_ledger_amount" numeric, "p_ledger_type" "text", "p_ledger_description" "text", "p_balance_change" numeric); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."post_je_and_ledger"("p_company_id" "text", "p_date" "text", "p_description" "text", "p_reference" "text", "p_property" "text", "p_status" "text", "p_lines" "jsonb", "p_ledger_tenant" "text", "p_ledger_tenant_id" bigint, "p_ledger_property" "text", "p_ledger_amount" numeric, "p_ledger_type" "text", "p_ledger_description" "text", "p_balance_change" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."post_je_and_ledger"("p_company_id" "text", "p_date" "text", "p_description" "text", "p_reference" "text", "p_property" "text", "p_status" "text", "p_lines" "jsonb", "p_ledger_tenant" "text", "p_ledger_tenant_id" bigint, "p_ledger_property" "text", "p_ledger_amount" numeric, "p_ledger_type" "text", "p_ledger_description" "text", "p_balance_change" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."post_je_and_ledger"("p_company_id" "text", "p_date" "text", "p_description" "text", "p_reference" "text", "p_property" "text", "p_status" "text", "p_lines" "jsonb", "p_ledger_tenant" "text", "p_ledger_tenant_id" bigint, "p_ledger_property" "text", "p_ledger_amount" numeric, "p_ledger_type" "text", "p_ledger_description" "text", "p_balance_change" numeric) TO "service_role";


--
-- Name: FUNCTION "prevent_signature_tampering"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."prevent_signature_tampering"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_signature_tampering"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_signature_tampering"() TO "service_role";


--
-- Name: FUNCTION "property_licenses_touch_updated_at"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."property_licenses_touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."property_licenses_touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."property_licenses_touch_updated_at"() TO "service_role";


--
-- Name: FUNCTION "property_tax_bills_touch_updated_at"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."property_tax_bills_touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."property_tax_bills_touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."property_tax_bills_touch_updated_at"() TO "service_role";


--
-- Name: FUNCTION "purge_old_archives"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."purge_old_archives"() TO "anon";
GRANT ALL ON FUNCTION "public"."purge_old_archives"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."purge_old_archives"() TO "service_role";


--
-- Name: FUNCTION "recompute_tenant_balance"("p_tenant_id" bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."recompute_tenant_balance"("p_tenant_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."recompute_tenant_balance"("p_tenant_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."recompute_tenant_balance"("p_tenant_id" bigint) TO "service_role";


--
-- Name: FUNCTION "recompute_tenant_balances_bulk"("p_company_id" "text"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."recompute_tenant_balances_bulk"("p_company_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."recompute_tenant_balances_bulk"("p_company_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."recompute_tenant_balances_bulk"("p_company_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."recompute_tenant_balances_bulk"("p_company_id" "text") TO "service_role";


--
-- Name: FUNCTION "redeem_invite_code"("p_code" "text", "p_user_email" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."redeem_invite_code"("p_code" "text", "p_user_email" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."redeem_invite_code"("p_code" "text", "p_user_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."redeem_invite_code"("p_code" "text", "p_user_email" "text") TO "service_role";


--
-- Name: FUNCTION "redeem_invite_code"("p_code" "text", "p_email" "text", "p_name" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."redeem_invite_code"("p_code" "text", "p_email" "text", "p_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."redeem_invite_code"("p_code" "text", "p_email" "text", "p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."redeem_invite_code"("p_code" "text", "p_email" "text", "p_name" "text") TO "service_role";


--
-- Name: FUNCTION "rename_property_cascade"("p_company_id" "text", "p_property_id" "text", "p_old_address" "text", "p_new_address" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."rename_property_cascade"("p_company_id" "text", "p_property_id" "text", "p_old_address" "text", "p_new_address" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."rename_property_cascade"("p_company_id" "text", "p_property_id" "text", "p_old_address" "text", "p_new_address" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."rename_property_cascade"("p_company_id" "text", "p_property_id" "text", "p_old_address" "text", "p_new_address" "text") TO "service_role";


--
-- Name: FUNCTION "rename_property_v2"("p_company_id" "text", "p_property_id" bigint, "p_new_address" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."rename_property_v2"("p_company_id" "text", "p_property_id" bigint, "p_new_address" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."rename_property_v2"("p_company_id" "text", "p_property_id" bigint, "p_new_address" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."rename_property_v2"("p_company_id" "text", "p_property_id" bigint, "p_new_address" "text") TO "service_role";


--
-- Name: FUNCTION "rename_property_v2"("p_company_id" "text", "p_property_id" "text", "p_new_address" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."rename_property_v2"("p_company_id" "text", "p_property_id" "text", "p_new_address" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."rename_property_v2"("p_company_id" "text", "p_property_id" "text", "p_new_address" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."rename_property_v2"("p_company_id" "text", "p_property_id" "text", "p_new_address" "text") TO "service_role";


--
-- Name: FUNCTION "rename_tenant_cascade"("p_company_id" "text", "p_old_name" "text", "p_new_name" "text", "p_property" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."rename_tenant_cascade"("p_company_id" "text", "p_old_name" "text", "p_new_name" "text", "p_property" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."rename_tenant_cascade"("p_company_id" "text", "p_old_name" "text", "p_new_name" "text", "p_property" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."rename_tenant_cascade"("p_company_id" "text", "p_old_name" "text", "p_new_name" "text", "p_property" "text") TO "service_role";


--
-- Name: FUNCTION "request_join_company"("p_company_id" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."request_join_company"("p_company_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."request_join_company"("p_company_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."request_join_company"("p_company_id" "text") TO "service_role";


--
-- Name: FUNCTION "request_join_company"("p_company_id" "text", "p_role" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."request_join_company"("p_company_id" "text", "p_role" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."request_join_company"("p_company_id" "text", "p_role" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."request_join_company"("p_company_id" "text", "p_role" "text") TO "service_role";


--
-- Name: FUNCTION "request_paper_copy"("p_token" "text", "p_reason" "text"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."request_paper_copy"("p_token" "text", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."request_paper_copy"("p_token" "text", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."request_paper_copy"("p_token" "text", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."request_paper_copy"("p_token" "text", "p_reason" "text") TO "service_role";


--
-- Name: FUNCTION "resolve_signed_pdf_path"("p_token" "text"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."resolve_signed_pdf_path"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resolve_signed_pdf_path"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_signed_pdf_path"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_signed_pdf_path"("p_token" "text") TO "service_role";


--
-- Name: FUNCTION "restore_archived"("p_company_id" "text", "p_table_name" "text", "p_item_id" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."restore_archived"("p_company_id" "text", "p_table_name" "text", "p_item_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."restore_archived"("p_company_id" "text", "p_table_name" "text", "p_item_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."restore_archived"("p_company_id" "text", "p_table_name" "text", "p_item_id" "text") TO "service_role";


--
-- Name: FUNCTION "rls_auto_enable"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";


--
-- Name: FUNCTION "set_journal_line_company_id"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."set_journal_line_company_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_journal_line_company_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_journal_line_company_id"() TO "service_role";


--
-- Name: FUNCTION "set_signed_pdf"("p_doc_id" "uuid", "p_pdf_path" "text", "p_pdf_hash" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."set_signed_pdf"("p_doc_id" "uuid", "p_pdf_path" "text", "p_pdf_hash" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."set_signed_pdf"("p_doc_id" "uuid", "p_pdf_path" "text", "p_pdf_hash" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_signed_pdf"("p_doc_id" "uuid", "p_pdf_path" "text", "p_pdf_hash" "text") TO "service_role";


--
-- Name: FUNCTION "sign_document"("p_token" "text", "p_signer_name" "text", "p_signature_data" "text", "p_signing_method" "text", "p_consent_text" "text", "p_user_agent" "text", "p_e_records_consented" boolean, "p_hw_sw_acknowledged" boolean, "p_consent_version" "text"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."sign_document"("p_token" "text", "p_signer_name" "text", "p_signature_data" "text", "p_signing_method" "text", "p_consent_text" "text", "p_user_agent" "text", "p_e_records_consented" boolean, "p_hw_sw_acknowledged" boolean, "p_consent_version" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sign_document"("p_token" "text", "p_signer_name" "text", "p_signature_data" "text", "p_signing_method" "text", "p_consent_text" "text", "p_user_agent" "text", "p_e_records_consented" boolean, "p_hw_sw_acknowledged" boolean, "p_consent_version" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."sign_document"("p_token" "text", "p_signer_name" "text", "p_signature_data" "text", "p_signing_method" "text", "p_consent_text" "text", "p_user_agent" "text", "p_e_records_consented" boolean, "p_hw_sw_acknowledged" boolean, "p_consent_version" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sign_document"("p_token" "text", "p_signer_name" "text", "p_signature_data" "text", "p_signing_method" "text", "p_consent_text" "text", "p_user_agent" "text", "p_e_records_consented" boolean, "p_hw_sw_acknowledged" boolean, "p_consent_version" "text") TO "service_role";


--
-- Name: FUNCTION "sign_lease"("p_signature_id" "uuid", "p_signer_name" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."sign_lease"("p_signature_id" "uuid", "p_signer_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."sign_lease"("p_signature_id" "uuid", "p_signer_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sign_lease"("p_signature_id" "uuid", "p_signer_name" "text") TO "service_role";


--
-- Name: FUNCTION "sign_lease"("p_company_id" "text", "p_lease_id" "text", "p_signer_id" "text", "p_signature_data" "text", "p_signing_method" "text", "p_consent_text" "text", "p_user_agent" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."sign_lease"("p_company_id" "text", "p_lease_id" "text", "p_signer_id" "text", "p_signature_data" "text", "p_signing_method" "text", "p_consent_text" "text", "p_user_agent" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."sign_lease"("p_company_id" "text", "p_lease_id" "text", "p_signer_id" "text", "p_signature_data" "text", "p_signing_method" "text", "p_consent_text" "text", "p_user_agent" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sign_lease"("p_company_id" "text", "p_lease_id" "text", "p_signer_id" "text", "p_signature_data" "text", "p_signing_method" "text", "p_consent_text" "text", "p_user_agent" "text") TO "service_role";


--
-- Name: FUNCTION "sync_property_address"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."sync_property_address"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_property_address"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_property_address"() TO "service_role";


--
-- Name: FUNCTION "tenant_make_payment"("p_company_id" "text", "p_tenant_id" integer, "p_amount" numeric, "p_method" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."tenant_make_payment"("p_company_id" "text", "p_tenant_id" integer, "p_amount" numeric, "p_method" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."tenant_make_payment"("p_company_id" "text", "p_tenant_id" integer, "p_amount" numeric, "p_method" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."tenant_make_payment"("p_company_id" "text", "p_tenant_id" integer, "p_amount" numeric, "p_method" "text") TO "service_role";


--
-- Name: FUNCTION "trg_sync_balance_from_je_lines"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."trg_sync_balance_from_je_lines"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_sync_balance_from_je_lines"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_sync_balance_from_je_lines"() TO "service_role";


--
-- Name: FUNCTION "trg_sync_balance_from_je_status"(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."trg_sync_balance_from_je_status"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_sync_balance_from_je_status"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_sync_balance_from_je_status"() TO "service_role";


--
-- Name: FUNCTION "update_tenant_balance"("p_tenant_id" bigint, "p_amount_change" numeric); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."update_tenant_balance"("p_tenant_id" bigint, "p_amount_change" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."update_tenant_balance"("p_tenant_id" bigint, "p_amount_change" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_tenant_balance"("p_tenant_id" bigint, "p_amount_change" numeric) TO "service_role";


--
-- Name: FUNCTION "validate_invite_code"("p_code" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."validate_invite_code"("p_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."validate_invite_code"("p_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_invite_code"("p_code" "text") TO "service_role";


--
-- Name: FUNCTION "verify_signature_integrity"("p_signature_id" "text", "p_company_id" "text"); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION "public"."verify_signature_integrity"("p_signature_id" "text", "p_company_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."verify_signature_integrity"("p_signature_id" "text", "p_company_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."verify_signature_integrity"("p_signature_id" "text", "p_company_id" "text") TO "service_role";


--
-- Name: FUNCTION "withdraw_e_records_consent"("p_token" "text", "p_reason" "text"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."withdraw_e_records_consent"("p_token" "text", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."withdraw_e_records_consent"("p_token" "text", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."withdraw_e_records_consent"("p_token" "text", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."withdraw_e_records_consent"("p_token" "text", "p_reason" "text") TO "service_role";


--
-- Name: TABLE "accounting_period_lock"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."accounting_period_lock" TO "anon";
GRANT ALL ON TABLE "public"."accounting_period_lock" TO "authenticated";
GRANT ALL ON TABLE "public"."accounting_period_lock" TO "service_role";


--
-- Name: TABLE "acct_classes"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."acct_classes" TO "anon";
GRANT ALL ON TABLE "public"."acct_classes" TO "authenticated";
GRANT ALL ON TABLE "public"."acct_classes" TO "service_role";


--
-- Name: SEQUENCE "acct_journal_lines_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."acct_journal_lines_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."acct_journal_lines_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."acct_journal_lines_id_seq" TO "service_role";


--
-- Name: TABLE "app_users"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."app_users" TO "anon";
GRANT ALL ON TABLE "public"."app_users" TO "authenticated";
GRANT ALL ON TABLE "public"."app_users" TO "service_role";


--
-- Name: TABLE "audit_trail"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."audit_trail" TO "anon";
GRANT ALL ON TABLE "public"."audit_trail" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_trail" TO "service_role";


--
-- Name: SEQUENCE "audit_trail_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."audit_trail_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."audit_trail_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."audit_trail_id_seq" TO "service_role";


--
-- Name: TABLE "automation_jobs"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."automation_jobs" TO "anon";
GRANT ALL ON TABLE "public"."automation_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."automation_jobs" TO "service_role";


--
-- Name: SEQUENCE "automation_jobs_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."automation_jobs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."automation_jobs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."automation_jobs_id_seq" TO "service_role";


--
-- Name: TABLE "autopay_schedules"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."autopay_schedules" TO "anon";
GRANT ALL ON TABLE "public"."autopay_schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."autopay_schedules" TO "service_role";


--
-- Name: TABLE "bank_account_feed"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."bank_account_feed" TO "anon";
GRANT ALL ON TABLE "public"."bank_account_feed" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_account_feed" TO "service_role";


--
-- Name: TABLE "bank_connection"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."bank_connection" TO "anon";
GRANT ALL ON TABLE "public"."bank_connection" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_connection" TO "service_role";


--
-- Name: TABLE "bank_feed_transaction"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."bank_feed_transaction" TO "anon";
GRANT ALL ON TABLE "public"."bank_feed_transaction" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_feed_transaction" TO "service_role";


--
-- Name: TABLE "bank_feed_transaction_link"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."bank_feed_transaction_link" TO "anon";
GRANT ALL ON TABLE "public"."bank_feed_transaction_link" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_feed_transaction_link" TO "service_role";


--
-- Name: TABLE "bank_import_batch"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."bank_import_batch" TO "anon";
GRANT ALL ON TABLE "public"."bank_import_batch" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_import_batch" TO "service_role";


--
-- Name: TABLE "bank_import_mapping_profile"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."bank_import_mapping_profile" TO "anon";
GRANT ALL ON TABLE "public"."bank_import_mapping_profile" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_import_mapping_profile" TO "service_role";


--
-- Name: TABLE "bank_posting_decision"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."bank_posting_decision" TO "anon";
GRANT ALL ON TABLE "public"."bank_posting_decision" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_posting_decision" TO "service_role";


--
-- Name: TABLE "bank_posting_decision_line"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."bank_posting_decision_line" TO "anon";
GRANT ALL ON TABLE "public"."bank_posting_decision_line" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_posting_decision_line" TO "service_role";


--
-- Name: TABLE "bank_reconciliations"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."bank_reconciliations" TO "anon";
GRANT ALL ON TABLE "public"."bank_reconciliations" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_reconciliations" TO "service_role";


--
-- Name: TABLE "bank_transaction_rule"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."bank_transaction_rule" TO "anon";
GRANT ALL ON TABLE "public"."bank_transaction_rule" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_transaction_rule" TO "service_role";


--
-- Name: TABLE "budgets"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."budgets" TO "anon";
GRANT ALL ON TABLE "public"."budgets" TO "authenticated";
GRANT ALL ON TABLE "public"."budgets" TO "service_role";


--
-- Name: TABLE "companies"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."companies" TO "anon";
GRANT ALL ON TABLE "public"."companies" TO "authenticated";
GRANT ALL ON TABLE "public"."companies" TO "service_role";


--
-- Name: TABLE "company_members"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."company_members" TO "anon";
GRANT ALL ON TABLE "public"."company_members" TO "authenticated";
GRANT ALL ON TABLE "public"."company_members" TO "service_role";


--
-- Name: SEQUENCE "company_members_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."company_members_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."company_members_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."company_members_id_seq" TO "service_role";


--
-- Name: TABLE "company_settings"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."company_settings" TO "anon";
GRANT ALL ON TABLE "public"."company_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."company_settings" TO "service_role";


--
-- Name: TABLE "doc_exception_requests"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."doc_exception_requests" TO "anon";
GRANT ALL ON TABLE "public"."doc_exception_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."doc_exception_requests" TO "service_role";


--
-- Name: TABLE "doc_generated"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."doc_generated" TO "anon";
GRANT ALL ON TABLE "public"."doc_generated" TO "authenticated";
GRANT ALL ON TABLE "public"."doc_generated" TO "service_role";


--
-- Name: TABLE "doc_signature_audit_log"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."doc_signature_audit_log" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."doc_signature_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."doc_signature_audit_log" TO "service_role";


--
-- Name: TABLE "doc_signatures"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."doc_signatures" TO "anon";
GRANT ALL ON TABLE "public"."doc_signatures" TO "authenticated";
GRANT ALL ON TABLE "public"."doc_signatures" TO "service_role";


--
-- Name: TABLE "doc_templates"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."doc_templates" TO "anon";
GRANT ALL ON TABLE "public"."doc_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."doc_templates" TO "service_role";


--
-- Name: TABLE "documents"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."documents" TO "anon";
GRANT ALL ON TABLE "public"."documents" TO "authenticated";
GRANT ALL ON TABLE "public"."documents" TO "service_role";


--
-- Name: TABLE "error_log"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."error_log" TO "anon";
GRANT ALL ON TABLE "public"."error_log" TO "authenticated";
GRANT ALL ON TABLE "public"."error_log" TO "service_role";


--
-- Name: TABLE "eviction_cases"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."eviction_cases" TO "anon";
GRANT ALL ON TABLE "public"."eviction_cases" TO "authenticated";
GRANT ALL ON TABLE "public"."eviction_cases" TO "service_role";


--
-- Name: TABLE "hoa_payments"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."hoa_payments" TO "anon";
GRANT ALL ON TABLE "public"."hoa_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."hoa_payments" TO "service_role";


--
-- Name: SEQUENCE "hoa_payments_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."hoa_payments_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."hoa_payments_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."hoa_payments_id_seq" TO "service_role";


--
-- Name: TABLE "inspections"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."inspections" TO "anon";
GRANT ALL ON TABLE "public"."inspections" TO "authenticated";
GRANT ALL ON TABLE "public"."inspections" TO "service_role";


--
-- Name: TABLE "journal_entries"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."journal_entries" TO "anon";
GRANT ALL ON TABLE "public"."journal_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."journal_entries" TO "service_role";


--
-- Name: SEQUENCE "journal_entries_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."journal_entries_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."journal_entries_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."journal_entries_id_seq" TO "service_role";


--
-- Name: SEQUENCE "journal_number_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."journal_number_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."journal_number_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."journal_number_seq" TO "service_role";


--
-- Name: TABLE "late_fee_rules"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."late_fee_rules" TO "anon";
GRANT ALL ON TABLE "public"."late_fee_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."late_fee_rules" TO "service_role";


--
-- Name: TABLE "lease_signatures"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."lease_signatures" TO "anon";
GRANT ALL ON TABLE "public"."lease_signatures" TO "authenticated";
GRANT ALL ON TABLE "public"."lease_signatures" TO "service_role";


--
-- Name: TABLE "lease_templates"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."lease_templates" TO "anon";
GRANT ALL ON TABLE "public"."lease_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."lease_templates" TO "service_role";


--
-- Name: TABLE "leases"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."leases" TO "anon";
GRANT ALL ON TABLE "public"."leases" TO "authenticated";
GRANT ALL ON TABLE "public"."leases" TO "service_role";


--
-- Name: TABLE "ledger_entries_legacy_table"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."ledger_entries_legacy_table" TO "anon";
GRANT ALL ON TABLE "public"."ledger_entries_legacy_table" TO "authenticated";
GRANT ALL ON TABLE "public"."ledger_entries_legacy_table" TO "service_role";


--
-- Name: SEQUENCE "ledger_entries_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."ledger_entries_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."ledger_entries_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."ledger_entries_id_seq" TO "service_role";


--
-- Name: TABLE "messages"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."messages" TO "anon";
GRANT ALL ON TABLE "public"."messages" TO "authenticated";
GRANT ALL ON TABLE "public"."messages" TO "service_role";


--
-- Name: SEQUENCE "messages_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."messages_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."messages_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."messages_id_seq" TO "service_role";


--
-- Name: TABLE "notification_inbox"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."notification_inbox" TO "anon";
GRANT ALL ON TABLE "public"."notification_inbox" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_inbox" TO "service_role";


--
-- Name: TABLE "notification_log"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."notification_log" TO "anon";
GRANT ALL ON TABLE "public"."notification_log" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_log" TO "service_role";


--
-- Name: TABLE "notification_queue"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."notification_queue" TO "anon";
GRANT ALL ON TABLE "public"."notification_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_queue" TO "service_role";


--
-- Name: TABLE "notification_settings"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."notification_settings" TO "anon";
GRANT ALL ON TABLE "public"."notification_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_settings" TO "service_role";


--
-- Name: TABLE "notification_templates"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."notification_templates" TO "anon";
GRANT ALL ON TABLE "public"."notification_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_templates" TO "service_role";


--
-- Name: SEQUENCE "notification_templates_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."notification_templates_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."notification_templates_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."notification_templates_id_seq" TO "service_role";


--
-- Name: TABLE "owner_distributions"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."owner_distributions" TO "anon";
GRANT ALL ON TABLE "public"."owner_distributions" TO "authenticated";
GRANT ALL ON TABLE "public"."owner_distributions" TO "service_role";


--
-- Name: TABLE "owner_statements"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."owner_statements" TO "anon";
GRANT ALL ON TABLE "public"."owner_statements" TO "authenticated";
GRANT ALL ON TABLE "public"."owner_statements" TO "service_role";


--
-- Name: TABLE "owners"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."owners" TO "anon";
GRANT ALL ON TABLE "public"."owners" TO "authenticated";
GRANT ALL ON TABLE "public"."owners" TO "service_role";


--
-- Name: TABLE "payments"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";


--
-- Name: SEQUENCE "payments_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."payments_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."payments_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."payments_id_seq" TO "service_role";


--
-- Name: TABLE "plaid_sync_event"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."plaid_sync_event" TO "anon";
GRANT ALL ON TABLE "public"."plaid_sync_event" TO "authenticated";
GRANT ALL ON TABLE "public"."plaid_sync_event" TO "service_role";


--
-- Name: TABLE "pm_assignment_requests"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."pm_assignment_requests" TO "anon";
GRANT ALL ON TABLE "public"."pm_assignment_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."pm_assignment_requests" TO "service_role";


--
-- Name: TABLE "properties"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."properties" TO "anon";
GRANT ALL ON TABLE "public"."properties" TO "authenticated";
GRANT ALL ON TABLE "public"."properties" TO "service_role";


--
-- Name: SEQUENCE "properties_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."properties_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."properties_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."properties_id_seq" TO "service_role";


--
-- Name: TABLE "property_change_requests"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."property_change_requests" TO "anon";
GRANT ALL ON TABLE "public"."property_change_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."property_change_requests" TO "service_role";


--
-- Name: SEQUENCE "property_change_requests_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."property_change_requests_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."property_change_requests_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."property_change_requests_id_seq" TO "service_role";


--
-- Name: TABLE "property_insurance"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."property_insurance" TO "anon";
GRANT ALL ON TABLE "public"."property_insurance" TO "authenticated";
GRANT ALL ON TABLE "public"."property_insurance" TO "service_role";


--
-- Name: TABLE "property_licenses"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."property_licenses" TO "anon";
GRANT ALL ON TABLE "public"."property_licenses" TO "authenticated";
GRANT ALL ON TABLE "public"."property_licenses" TO "service_role";


--
-- Name: TABLE "property_loans"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."property_loans" TO "anon";
GRANT ALL ON TABLE "public"."property_loans" TO "authenticated";
GRANT ALL ON TABLE "public"."property_loans" TO "service_role";


--
-- Name: TABLE "property_setup_wizard"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."property_setup_wizard" TO "anon";
GRANT ALL ON TABLE "public"."property_setup_wizard" TO "authenticated";
GRANT ALL ON TABLE "public"."property_setup_wizard" TO "service_role";


--
-- Name: TABLE "property_tax_bills"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."property_tax_bills" TO "anon";
GRANT ALL ON TABLE "public"."property_tax_bills" TO "authenticated";
GRANT ALL ON TABLE "public"."property_tax_bills" TO "service_role";


--
-- Name: TABLE "property_taxes"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."property_taxes" TO "anon";
GRANT ALL ON TABLE "public"."property_taxes" TO "authenticated";
GRANT ALL ON TABLE "public"."property_taxes" TO "service_role";


--
-- Name: TABLE "push_attempts"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."push_attempts" TO "anon";
GRANT ALL ON TABLE "public"."push_attempts" TO "authenticated";
GRANT ALL ON TABLE "public"."push_attempts" TO "service_role";


--
-- Name: TABLE "push_subscriptions"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."push_subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."push_subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."push_subscriptions" TO "service_role";


--
-- Name: TABLE "recurring_journal_entries"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."recurring_journal_entries" TO "anon";
GRANT ALL ON TABLE "public"."recurring_journal_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."recurring_journal_entries" TO "service_role";


--
-- Name: TABLE "tenant_invite_codes"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."tenant_invite_codes" TO "anon";
GRANT ALL ON TABLE "public"."tenant_invite_codes" TO "authenticated";
GRANT ALL ON TABLE "public"."tenant_invite_codes" TO "service_role";


--
-- Name: SEQUENCE "tenant_invite_codes_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."tenant_invite_codes_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."tenant_invite_codes_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."tenant_invite_codes_id_seq" TO "service_role";


--
-- Name: SEQUENCE "tenants_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."tenants_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."tenants_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."tenants_id_seq" TO "service_role";


--
-- Name: TABLE "utilities"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."utilities" TO "anon";
GRANT ALL ON TABLE "public"."utilities" TO "authenticated";
GRANT ALL ON TABLE "public"."utilities" TO "service_role";


--
-- Name: SEQUENCE "utilities_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."utilities_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."utilities_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."utilities_id_seq" TO "service_role";


--
-- Name: TABLE "utility_accounts"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."utility_accounts" TO "anon";
GRANT ALL ON TABLE "public"."utility_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."utility_accounts" TO "service_role";


--
-- Name: SEQUENCE "utility_accounts_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."utility_accounts_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."utility_accounts_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."utility_accounts_id_seq" TO "service_role";


--
-- Name: TABLE "utility_audit"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."utility_audit" TO "anon";
GRANT ALL ON TABLE "public"."utility_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."utility_audit" TO "service_role";


--
-- Name: SEQUENCE "utility_audit_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."utility_audit_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."utility_audit_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."utility_audit_id_seq" TO "service_role";


--
-- Name: TABLE "utility_bills"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."utility_bills" TO "anon";
GRANT ALL ON TABLE "public"."utility_bills" TO "authenticated";
GRANT ALL ON TABLE "public"."utility_bills" TO "service_role";


--
-- Name: SEQUENCE "utility_bills_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."utility_bills_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."utility_bills_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."utility_bills_id_seq" TO "service_role";


--
-- Name: TABLE "utility_providers"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."utility_providers" TO "anon";
GRANT ALL ON TABLE "public"."utility_providers" TO "authenticated";
GRANT ALL ON TABLE "public"."utility_providers" TO "service_role";


--
-- Name: TABLE "vendor_invoices"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."vendor_invoices" TO "anon";
GRANT ALL ON TABLE "public"."vendor_invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."vendor_invoices" TO "service_role";


--
-- Name: TABLE "vendors"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."vendors" TO "anon";
GRANT ALL ON TABLE "public"."vendors" TO "authenticated";
GRANT ALL ON TABLE "public"."vendors" TO "service_role";


--
-- Name: TABLE "work_order_photos"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."work_order_photos" TO "anon";
GRANT ALL ON TABLE "public"."work_order_photos" TO "authenticated";
GRANT ALL ON TABLE "public"."work_order_photos" TO "service_role";


--
-- Name: TABLE "work_orders"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE "public"."work_orders" TO "anon";
GRANT ALL ON TABLE "public"."work_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."work_orders" TO "service_role";


--
-- Name: SEQUENCE "work_orders_id_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE "public"."work_orders_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."work_orders_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."work_orders_id_seq" TO "service_role";


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- PostgreSQL database dump complete
--

\unrestrict fSXlDjwwEPRba8CzwZYJ4qyg88CyFInEDGiCfCOa7eSATpr1Ei4IymnMxYonXNz

