-- hard_delete_company: server-side atomic company teardown.
--
-- Replaces the client's Promise.allSettled across five hand-listed
-- tables, which left ~15 other tables (acct_journal_entries, ledger,
-- bank_connection + encrypted Teller token, audit_trail, documents,
-- work_orders, leases, etc.) pointing at a deleted company.
--
-- Walks every table in the public schema that has a company_id column
-- and deletes the caller's company rows, then deletes the company row
-- itself. Everything runs inside one txn — if any step fails the whole
-- delete rolls back.
--
-- Authorization: caller must be an active admin or owner member of
-- the target company. Anyone else gets a hard error.

CREATE OR REPLACE FUNCTION hard_delete_company(p_company_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
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
$$;
