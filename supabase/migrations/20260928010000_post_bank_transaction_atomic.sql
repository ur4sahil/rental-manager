-- post_bank_transaction: one atomic write for the three bank-feed posting
-- flows (single-category "add", "transfer", "split").
--
-- Before this, Banking.js posted each flow as 5-7 separate REST writes:
-- JE header, JE lines, posting decision, decision lines, link, txn status.
-- A connection that dropped between the first two stranded an EMPTY
-- journal entry (prod, 2026-09-28: JE-9492, the July FAY Servicing split).
-- Its deterministic reference (BANK-/XFER-/SPLIT-<txn.id>, unique via
-- idx_je_company_reference_unique) then made every retry fail with a
-- duplicate key, surfaced as PM-9005, and the txn sat in for_review for
-- good. The browser can't clean up after a request it never finished,
-- so the fix has to live server-side: a function body is one transaction,
-- and a dropped connection rolls the whole thing back.
--
-- Idempotent by design, because the other failure is a LOST RESPONSE
-- (everything committed, the reply never arrived). The txn row is locked
-- FOR UPDATE, then:
--   * txn already processed AND linked to this reference's JE
--       -> return outcome 'already_posted' (the retry is a no-op success)
--   * txn already processed otherwise  -> raise 'already processed'
--   * a live JE with this reference exists but has no lines (a strand
--     left by the old client path)     -> delete it, then post fresh
--   * a live JE with this reference exists WITH lines, txn unlinked
--                                       -> link the txn to it, never
--                                          post the amounts twice
--
-- SECURITY INVOKER on purpose: RLS on every table below still applies
-- to the calling user, and the period-lock / management-gate triggers
-- still see current_user = authenticated. DEFINER would run as the owner
-- and quietly bypass all of it.
--
-- Decision rows store class ids in uuid columns, but acct_classes.id is
-- text and some classes are not uuid-shaped (19/126 on test). The old
-- client path posted the JE, then failed on the decision insert and left
-- the txn half-posted. Here that failure would roll back the whole post,
-- so a non-uuid class is recorded as NULL on the DECISION only; the JE
-- lines -- the books -- keep the real class id.
--
-- The client still builds the JE lines exactly as before (same accounts,
-- sides, memos, entity tags). This function changes WHEN they are
-- written -- all together -- not WHAT is written.

CREATE OR REPLACE FUNCTION public.post_bank_transaction(
  p_company_id     text,
  p_txn_id         uuid,
  p_kind           text,             -- 'add' | 'transfer' | 'split'
  p_description    text,
  p_property       text  DEFAULT '',
  p_lines          jsonb DEFAULT '[]'::jsonb,  -- JE lines, bank side included
  p_decision       jsonb DEFAULT '{}'::jsonb,  -- payee, memo, header_class_id, transfer_gl_account_id
  p_decision_lines jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_txn          bank_feed_transaction%ROWTYPE;
  v_ref          text;
  v_prior_id     text;
  v_prior_lines  int;
  v_je_id        text;
  v_je_number    text;
  v_decision_id  uuid;
  v_attempt      int := 0;
  v_line         jsonb;
  v_ord          bigint;
  v_email        text := COALESCE(auth.jwt() ->> 'email', '');
  v_constraint   text;
BEGIN
  IF p_kind NOT IN ('add', 'transfer', 'split') THEN
    RAISE EXCEPTION 'post_bank_transaction: unknown kind %', p_kind;
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'post_bank_transaction: a journal entry needs at least 2 lines';
  END IF;

  -- Serialises concurrent posts of the same txn (two tabs, a double click
  -- that slipped the client guard, an auto-accept rule racing a human).
  SELECT * INTO v_txn FROM bank_feed_transaction
   WHERE id = p_txn_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post_bank_transaction: transaction not found';
  END IF;

  v_ref := CASE p_kind WHEN 'add' THEN 'BANK-' WHEN 'transfer' THEN 'XFER-' ELSE 'SPLIT-' END
           || p_txn_id::text;

  -- The reference index excludes voided entries, so an undone post
  -- (voided JE) does not count as prior.
  SELECT id INTO v_prior_id FROM acct_journal_entries
   WHERE company_id = p_company_id AND reference = v_ref AND status <> 'voided'
   LIMIT 1;

  IF v_txn.status <> 'for_review' THEN
    IF v_prior_id IS NOT NULL AND v_txn.journal_entry_id::text = v_prior_id THEN
      RETURN jsonb_build_object('outcome', 'already_posted', 'je_id', v_prior_id);
    END IF;
    RAISE EXCEPTION 'post_bank_transaction: transaction already processed (status %)', v_txn.status
      USING ERRCODE = 'P0001', HINT = 'already_processed';
  END IF;

  IF v_prior_id IS NOT NULL THEN
    SELECT count(*) INTO v_prior_lines FROM acct_journal_lines
     WHERE journal_entry_id = v_prior_id;
    IF v_prior_lines = 0 THEN
      DELETE FROM acct_journal_entries WHERE id = v_prior_id AND company_id = p_company_id;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM bank_feed_transaction_link
                      WHERE bank_feed_transaction_id = p_txn_id
                        AND linked_object_type = 'journal_entry'
                        AND linked_object_id::text = v_prior_id) THEN
        INSERT INTO bank_feed_transaction_link
          (company_id, bank_feed_transaction_id, linked_object_type, linked_object_id, link_role)
        VALUES (p_company_id, p_txn_id, 'journal_entry', v_prior_id::uuid, 'created_from');
      END IF;
      UPDATE bank_feed_transaction
         SET status = 'categorized', accepted_at = now(), accepted_by = v_email,
             journal_entry_id = v_prior_id::uuid
       WHERE id = p_txn_id AND company_id = p_company_id;
      RETURN jsonb_build_object('outcome', 'relinked', 'je_id', v_prior_id);
    END IF;
  END IF;

  -- Header. Retry only a NUMBER collision (next_je_number is MAX-based and
  -- can race); a reference collision can't happen past the check above
  -- while we hold the txn lock, and if it somehow does, re-rolling the
  -- number would not fix it -- let it raise.
  LOOP
    v_je_number := next_je_number(p_company_id);
    BEGIN
      INSERT INTO acct_journal_entries (company_id, number, date, description, reference, property, status)
      VALUES (p_company_id, v_je_number, v_txn.posted_date, COALESCE(p_description, ''),
              v_ref, COALESCE(p_property, ''), 'posted')
      RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint <> 'unique_je_number_per_company' THEN RAISE; END IF;
      v_attempt := v_attempt + 1;
      IF v_attempt >= 5 THEN
        RAISE EXCEPTION 'post_bank_transaction: could not allocate a JE number after 5 attempts';
      END IF;
    END;
  END LOOP;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO acct_journal_lines
      (journal_entry_id, company_id, account_id, account_name, debit, credit, class_id, memo,
       entity_type, entity_id, entity_name, bank_feed_transaction_id)
    VALUES
      (v_je_id, p_company_id, (v_line ->> 'account_id')::uuid, COALESCE(v_line ->> 'account_name', ''),
       COALESCE((v_line ->> 'debit')::numeric, 0), COALESCE((v_line ->> 'credit')::numeric, 0),
       NULLIF(v_line ->> 'class_id', ''), COALESCE(v_line ->> 'memo', ''),
       NULLIF(v_line ->> 'entity_type', ''), NULLIF(v_line ->> 'entity_id', ''),
       NULLIF(v_line ->> 'entity_name', ''), p_txn_id);
  END LOOP;

  INSERT INTO bank_posting_decision
    (company_id, bank_feed_transaction_id, decision_type, payee, memo,
     header_class_id, transfer_gl_account_id, status, created_by)
  VALUES
    (p_company_id, p_txn_id, p_kind, COALESCE(p_decision ->> 'payee', ''), COALESCE(p_decision ->> 'memo', ''),
     CASE WHEN p_decision ->> 'header_class_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (p_decision ->> 'header_class_id')::uuid END,
     NULLIF(p_decision ->> 'transfer_gl_account_id', '')::uuid,
     'posted', v_email)
  RETURNING id INTO v_decision_id;

  FOR v_line, v_ord IN SELECT value, ordinality FROM jsonb_array_elements(p_decision_lines) WITH ORDINALITY LOOP
    INSERT INTO bank_posting_decision_line
      (company_id, bank_posting_decision_id, line_no, gl_account_id, gl_account_name,
       amount, entry_side, memo, class_id)
    VALUES
      (p_company_id, v_decision_id, COALESCE((v_line ->> 'line_no')::int, v_ord::int),
       NULLIF(v_line ->> 'gl_account_id', '')::uuid, COALESCE(v_line ->> 'gl_account_name', ''),
       COALESCE((v_line ->> 'amount')::numeric, 0), COALESCE(v_line ->> 'entry_side', 'debit'),
       COALESCE(v_line ->> 'memo', ''),
       CASE WHEN v_line ->> 'class_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (v_line ->> 'class_id')::uuid END);
  END LOOP;

  INSERT INTO bank_feed_transaction_link
    (company_id, bank_feed_transaction_id, linked_object_type, linked_object_id, link_role)
  VALUES (p_company_id, p_txn_id, 'journal_entry', v_je_id::uuid, 'created_from');

  UPDATE bank_feed_transaction
     SET status = 'categorized', accepted_at = now(), accepted_by = v_email,
         journal_entry_id = v_je_id::uuid, posting_decision_id = v_decision_id
   WHERE id = p_txn_id AND company_id = p_company_id;

  RETURN jsonb_build_object('outcome', 'posted', 'je_id', v_je_id, 'decision_id', v_decision_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.post_bank_transaction(text, uuid, text, text, text, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_bank_transaction(text, uuid, text, text, text, jsonb, jsonb, jsonb) TO authenticated, service_role;
