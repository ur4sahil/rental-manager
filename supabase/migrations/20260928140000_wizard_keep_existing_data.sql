-- Property setup wizard: saving must never lose or change what the user did
-- not touch. Edit mode is now a true MERGE.
--
-- Audit theme J (owner-approved). What commit_property_wizard did on an EDIT
-- save before this migration, even when nothing was changed:
--
--   * Utilities and HOA dues were archived wholesale and re-inserted from the
--     form. The re-inserted rows got new ids, status 'pending' (a PAID HOA bill
--     became unpaid again), utility amount 0, and a due date rebuilt from a
--     "day" the client could not even read -- the form held a full date string,
--     Number("2026-09-15") is NaN, so every due date went to the 1st.
--   * Insurance and property tax: when the step was not enabled in the payload
--     (step skipped, list failed to load, stale draft) EVERY policy / tax
--     record on the property was archived. Loans the same when the property had
--     one loan.
--   * Websites: written as COALESCE(payload, '') so a website the form never
--     loaded (the loan and insurance loaders on one path skipped it) was wiped.
--   * Lease payment_due_day was forced to 1; tenant late fee was set to NULL /
--     'flat' (the wizard has no late-fee field at all), move_in was overwritten
--     with lease_start, and a tenant on 'notice' was flipped back to 'active'.
--   * Recurring rent next_post_date was recomputed from the lease start on
--     every save, moving an existing schedule's next posting.
--   * year_built was sent by the client and never written.
--
-- The rules now, in edit mode:
--   * Utilities / HOA rows are matched by id (sent by the client) or, failing
--     that, by provider / HOA name, and UPDATEd in place. Only the fields the
--     wizard shows are written; status, paid_date, amount (utilities), bill
--     readings etc. are left alone. A blank text field keeps the stored value.
--   * A row is archived only if the client says it SAW it when the form opened
--     (utilities_seen_ids / hoas_seen_ids, falling back to the older name lists)
--     and it is not in the payload -- i.e. the user removed it. A row with an id
--     that is no longer live is skipped, never resurrected.
--   * Loan / insurance / tax: archived only when the payload names the specific
--     record ({enabled:false, id}) -- the user switched that one off. A missing
--     or null payload section leaves the tables alone.
--   * Due days: an unchanged day keeps the stored date; a changed day moves it
--     within the same month; a blank day keeps it.
--   * credential_key_fp is persisted wherever the RPC writes credential columns
--     (utilities, hoa_payments, property_loans, property_insurance).
--   * A NULL stored by another page is not turned into '' / 0 / false just
--     because the form shows it that way (_wizard_txt / _num / _bool).
--
-- Also for the property import's create path (fresh mode): utility amount,
-- a full due date, and 'owner'/'tenant' responsibility tokens are accepted;
-- a blank responsibility or due date is left NULL rather than guessed
-- ('tenant' / the 1st); tax county/jurisdiction are stored.
--
-- Owner decision (audit theme K): the wizard no longer creates or updates a
-- Mortgage/Loan recurring journal schedule (the setup_recurring branch is
-- gone). Switching off a property's LAST loan still deactivates an existing
-- mortgage schedule, as before, so it cannot keep posting for a loan that no
-- longer exists.
--
-- Signature, SECURITY DEFINER, (absent) search_path and grants of
-- commit_property_wizard are unchanged; CREATE OR REPLACE keeps the ACL. The
-- helpers are plain SECURITY INVOKER functions with no table access,
-- executable by authenticated / service_role only.

CREATE OR REPLACE FUNCTION public._wizard_safe_date(p text)
 RETURNS date
 LANGUAGE plpgsql
 IMMUTABLE
AS $f$
BEGIN
  IF p IS NULL OR p !~ '^\d{4}-\d{2}-\d{2}' THEN RETURN NULL; END IF;
  RETURN left(p, 10)::date;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$f$;

-- A day-of-month from a payload value: '15' / 15 -> 15, a full date -> its day,
-- blank or junk -> NULL (meaning "not given").
CREATE OR REPLACE FUNCTION public._wizard_day(p text)
 RETURNS int
 LANGUAGE plpgsql
 IMMUTABLE
AS $f$
BEGIN
  IF p IS NULL OR btrim(p) = '' THEN RETURN NULL; END IF;
  IF btrim(p) ~ '^\d{1,2}$' THEN
    RETURN CASE WHEN btrim(p)::int BETWEEN 1 AND 31 THEN btrim(p)::int END;
  END IF;
  RETURN extract(day from public._wizard_safe_date(p))::int;
END;
$f$;

-- The due date to store. A full date wins; no day keeps what is stored; the
-- stored day unchanged keeps the stored date; a different day moves it within
-- the stored (or, for a new row, the current) month.
CREATE OR REPLACE FUNCTION public._wizard_merge_due(p_existing date, p_full date, p_day int)
 RETURNS date
 LANGUAGE plpgsql
 STABLE
AS $f$
DECLARE
  v_base date;
  v_last int;
BEGIN
  IF p_full IS NOT NULL THEN RETURN p_full; END IF;
  IF p_day IS NULL THEN RETURN p_existing; END IF;
  IF p_existing IS NOT NULL AND extract(day from p_existing)::int = p_day THEN
    RETURN p_existing;
  END IF;
  v_base := date_trunc('month', COALESCE(p_existing, current_date))::date;
  v_last := extract(day from (v_base + interval '1 month - 1 day'))::int;
  RETURN v_base + (LEAST(GREATEST(p_day, 1), v_last) - 1);
END;
$f$;

-- Rows written by OTHER pages often hold NULL where the wizard's form holds
-- '' / 0 / false. Re-saving must not turn one into the other: these return the
-- stored value when both sides are "empty", else the new value (so a real
-- change, including a deliberate clear of a non-empty value, still lands).
CREATE OR REPLACE FUNCTION public._wizard_txt(p_new text, p_old text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $f$
  SELECT CASE WHEN NULLIF(p_new, '') IS NULL AND NULLIF(p_old, '') IS NULL THEN p_old ELSE p_new END;
$f$;

-- p_blank is what an empty payload value meant before (0 for a deposit, NULL
-- for a loan amount), kept so this changes nothing but the NULL-vs-0 case.
CREATE OR REPLACE FUNCTION public._wizard_num(p_new text, p_old numeric, p_blank numeric DEFAULT NULL)
 RETURNS numeric
 LANGUAGE plpgsql
 IMMUTABLE
AS $f$
DECLARE
  v numeric := COALESCE(NULLIF(p_new, '')::numeric, p_blank);
BEGIN
  IF p_old IS NULL AND COALESCE(v, 0) = 0 THEN RETURN NULL; END IF;
  RETURN v;
END;
$f$;

CREATE OR REPLACE FUNCTION public._wizard_bool(p_new text, p_old boolean)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $f$
  SELECT CASE WHEN p_old IS NULL AND COALESCE(NULLIF(p_new, '')::boolean, false) = false
              THEN NULL ELSE COALESCE(NULLIF(p_new, '')::boolean, false) END;
$f$;

REVOKE ALL ON FUNCTION public._wizard_safe_date(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._wizard_day(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._wizard_merge_due(date, date, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._wizard_safe_date(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._wizard_day(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._wizard_merge_due(date, date, int) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public._wizard_txt(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._wizard_num(text, numeric, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._wizard_bool(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._wizard_txt(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._wizard_num(text, numeric, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._wizard_bool(text, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commit_property_wizard(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $fn$
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
  v_old_address text;
  v_class_id text;
  v_tenant_id bigint;
  v_tenant_name text;
  v_all_tenants text;
  v_lease_id uuid;
  v_existing_tenant_id bigint;
  v_existing_lease_id uuid;
  v_existing_loan_id uuid;
  v_loan_id text;
  v_loan_count int;
  v_existing_ins_id uuid;
  v_existing_tax_id uuid;
  v_existing_recur_id uuid;
  v_u jsonb;
  v_h jsonb;
  v_tenant_ar_id uuid;
  v_revenue_id uuid;
  v_next_post_date date;
  v_day int;
  v_is_occupied boolean;
  v_loan_has_creds boolean := false;
  v_ins_has_creds  boolean := false;
  -- Edit-mode merge bookkeeping.
  v_row_id bigint;
  v_row_gone boolean;
  v_matched_util bigint[] := '{}';
  v_matched_hoa  bigint[] := '{}';
  v_resp text;
  v_ins_id text;
  v_tax_id text;
  v_skip boolean;
  v_old_day int;
  v_old_next date;
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
  IF jsonb_typeof(v_loan) = 'null' THEN v_loan := NULL; END IF;
  IF jsonb_typeof(v_insurance) = 'null' THEN v_insurance := NULL; END IF;
  IF jsonb_typeof(v_taxes) = 'null' THEN v_taxes := NULL; END IF;
  IF jsonb_typeof(v_recurring) = 'null' THEN v_recurring := NULL; END IF;
  IF jsonb_typeof(v_utilities) <> 'array' THEN v_utilities := '[]'::jsonb; END IF;
  IF jsonb_typeof(v_hoas) <> 'array' THEN v_hoas := '[]'::jsonb; END IF;

  v_is_occupied := (v_prop->>'status') = 'occupied';

  -- compute_property_address is what the sync_addr triggers call, and
  -- those triggers own properties.address. Composing it a second way here
  -- is how the wizard came to file a property's utilities and documents
  -- under an address the Properties page never queries.
  v_address := compute_property_address(
    v_prop->>'address_line_1', v_prop->>'address_line_2',
    v_prop->>'city', v_prop->>'state', v_prop->>'zip');

  IF v_mode = 'edit' AND v_property_id_in IS NOT NULL THEN
    -- Capture the address as it stands BEFORE the components change, so a
    -- rename can be cascaded from it. FOR UPDATE: no concurrent rename can
    -- slip in between this read and the UPDATE.
    SELECT address INTO v_old_address FROM properties
    WHERE id = v_property_id_in AND company_id = v_company_id
    FOR UPDATE;
    UPDATE properties SET
      address_line_1 = v_prop->>'address_line_1',
      address_line_2 = public._wizard_txt(v_prop->>'address_line_2', address_line_2),
      city = v_prop->>'city',
      state = v_prop->>'state',
      zip = v_prop->>'zip',
      -- blank = not given: keep what is stored
      county = COALESCE(NULLIF(v_prop->>'county',''), county),
      type = v_prop->>'type',
      status = v_prop->>'status',
      notes = public._wizard_txt(v_prop->>'notes', notes),
      year_built = CASE WHEN COALESCE(v_prop->>'year_built','') ~ '^\d{4}$'
                        THEN (v_prop->>'year_built')::int ELSE year_built END
    WHERE id = v_property_id_in AND company_id = v_company_id;
    v_property_id := v_property_id_in;
    SELECT address INTO v_address FROM properties
    WHERE id = v_property_id AND company_id = v_company_id;
    -- The address changed: move every row keyed on the old text address
    -- (tenants, leases, recurring, utilities, HOA, loans, insurance, taxes,
    -- acct_classes.name, ...) to the new one NOW, before any lookup below
    -- keys on v_address. Without this, each lookup misses and INSERTs a
    -- duplicate.
    IF v_old_address IS NOT NULL AND v_address IS NOT NULL
       AND v_old_address IS DISTINCT FROM v_address THEN
      PERFORM public._cascade_property_rename(v_company_id, v_old_address, v_address);
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM properties WHERE company_id = v_company_id AND address = v_address AND archived_at IS NULL) THEN
      RAISE EXCEPTION 'A property with this address already exists';
    END IF;
    INSERT INTO properties (
      address, address_line_1, address_line_2, city, state, zip, county,
      type, status, notes, year_built, company_id
    ) VALUES (
      v_address, v_prop->>'address_line_1', v_prop->>'address_line_2',
      v_prop->>'city', v_prop->>'state', v_prop->>'zip', v_prop->>'county',
      v_prop->>'type', v_prop->>'status', v_prop->>'notes',
      CASE WHEN COALESCE(v_prop->>'year_built','') ~ '^\d{4}$' THEN (v_prop->>'year_built')::int END,
      v_company_id
    ) RETURNING id INTO v_property_id;
    SELECT address INTO v_address FROM properties
    WHERE id = v_property_id AND company_id = v_company_id;
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
      AND name = v_tenant_name
      AND property = v_address
      AND archived_at IS NULL
    LIMIT 1;

    IF v_existing_tenant_id IS NULL THEN
    SELECT id INTO v_existing_tenant_id FROM tenants
    WHERE company_id = v_company_id
      AND property = v_address
      AND lower(COALESCE(email,'')) = lower(COALESCE(v_tenant->>'tenant_email',''))
      AND archived_at IS NULL
    LIMIT 1;
    END IF;
    IF v_existing_tenant_id IS NULL THEN
      SELECT id INTO v_existing_tenant_id FROM tenants
      WHERE company_id = v_company_id AND property = v_address
        AND lease_status = 'active' AND archived_at IS NULL
      LIMIT 1;
    END IF;

    IF v_existing_tenant_id IS NOT NULL THEN
      UPDATE tenants SET
        name = v_tenant_name,
        first_name = public._wizard_txt(v_tenant->>'tenant_first', first_name),
        middle_initial = public._wizard_txt(v_tenant->>'tenant_mi', middle_initial),
        last_name = public._wizard_txt(v_tenant->>'tenant_last', last_name),
        email = public._wizard_txt(lower(v_tenant->>'tenant_email'), email),
        phone = public._wizard_txt(v_tenant->>'tenant_phone', phone),
        rent = (v_tenant->>'rent')::numeric,
        -- The wizard has no late-fee field: blank keeps the stored terms.
        late_fee_amount = COALESCE(NULLIF(v_tenant->>'late_fee_amount','')::numeric, late_fee_amount),
        late_fee_type = COALESCE(NULLIF(v_tenant->>'late_fee_type',''), late_fee_type, 'flat'),
        -- A tenant on notice still lives there; saving the wizard is not a
        -- decision to withdraw their notice.
        lease_status = CASE WHEN lease_status = 'notice' THEN lease_status ELSE 'active' END,
        lease_start = NULLIF(v_tenant->>'lease_start','')::date,
        lease_end_date = NULLIF(v_tenant->>'lease_end','')::date,
        -- move_in is not on the wizard form: only fill it when empty.
        move_in = COALESCE(move_in, NULLIF(v_tenant->>'lease_start','')::date),
        is_voucher = public._wizard_bool(v_tenant->>'is_voucher', is_voucher),
        voucher_number = NULLIF(v_tenant->>'voucher_number',''),
        reexam_date = NULLIF(v_tenant->>'reexam_date','')::date,
        case_manager_name = NULLIF(v_tenant->>'case_manager_name',''),
        case_manager_email = NULLIF(v_tenant->>'case_manager_email',''),
        case_manager_phone = NULLIF(v_tenant->>'case_manager_phone',''),
        voucher_portion = NULLIF(v_tenant->>'voucher_portion','')::numeric,
        tenant_portion = NULLIF(v_tenant->>'tenant_portion','')::numeric,
        co_tenants = ARRAY(SELECT x FROM unnest(ARRAY[
          NULLIF(btrim(v_tenant->>'tenant_2'),''), NULLIF(btrim(v_tenant->>'tenant_3'),''),
          NULLIF(btrim(v_tenant->>'tenant_4'),''), NULLIF(btrim(v_tenant->>'tenant_5'),'')
        ]) AS x WHERE x IS NOT NULL)
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
        voucher_portion, tenant_portion, co_tenants
      ) VALUES (
        v_company_id, v_tenant_name,
        v_tenant->>'tenant_first', v_tenant->>'tenant_mi', v_tenant->>'tenant_last',
        lower(v_tenant->>'tenant_email'), v_tenant->>'tenant_phone', v_address,
        (v_tenant->>'rent')::numeric,
        NULLIF(v_tenant->>'late_fee_amount','')::numeric,
        COALESCE(NULLIF(v_tenant->>'late_fee_type',''),'flat'),
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
        NULLIF(v_tenant->>'tenant_portion','')::numeric,
        ARRAY(SELECT x FROM unnest(ARRAY[
          NULLIF(btrim(v_tenant->>'tenant_2'),''), NULLIF(btrim(v_tenant->>'tenant_3'),''),
          NULLIF(btrim(v_tenant->>'tenant_4'),''), NULLIF(btrim(v_tenant->>'tenant_5'),'')
        ]) AS x WHERE x IS NOT NULL)
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
      security_deposit = public._wizard_num(v_tenant->>'security_deposit', security_deposit, 0),
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
        -- payment_due_day is not on the wizard form: leave it as stored
        -- (it used to be reset to the 1st on every save).
        UPDATE leases SET
          tenant_name = v_all_tenants,
          tenant_id = v_tenant_id,
          start_date = (v_tenant->>'lease_start')::date,
          end_date = (v_tenant->>'lease_end')::date,
          rent_amount = (v_tenant->>'rent')::numeric,
          security_deposit = public._wizard_num(v_tenant->>'security_deposit', security_deposit, 0)
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

  -- ─── UTILITIES — merge in edit mode ──────────────────────────────
  -- Each payload row UPDATEs the live row it came from (id, else same
  -- provider) and writes only what the wizard shows. status, amount, bill
  -- readings and the row id are left alone, so a bill marked paid stays paid
  -- and the utility-account bridge keeps pointing at the same row.
  FOR v_u IN SELECT * FROM jsonb_array_elements(v_utilities) LOOP
    IF COALESCE(trim(v_u->>'provider'),'') = '' THEN CONTINUE; END IF;
    v_resp := CASE lower(COALESCE(v_u->>'responsibility',''))
      WHEN 'owner_pays' THEN 'owner' WHEN 'owner' THEN 'owner'
      WHEN 'tenant_pays' THEN 'tenant' WHEN 'tenant' THEN 'tenant'
      WHEN 'condo_fee' THEN 'condo_fee'
      ELSE NULL END;
    v_row_id := NULL;
    v_row_gone := false;
    IF v_mode = 'edit' THEN
      IF COALESCE(v_u->>'id','') ~ '^\d+$' THEN
        SELECT id INTO v_row_id FROM utilities
         WHERE id = (v_u->>'id')::bigint AND company_id = v_company_id
           AND property = v_address AND archived_at IS NULL
           AND NOT (id = ANY(v_matched_util));
        -- The row the form was showing has since been removed elsewhere:
        -- do not bring it back.
        v_row_gone := v_row_id IS NULL;
      ELSE
        SELECT id INTO v_row_id FROM utilities
         WHERE company_id = v_company_id AND property = v_address
           AND archived_at IS NULL AND is_final_bill IS NOT TRUE
           AND lower(btrim(provider)) = lower(btrim(v_u->>'provider'))
           AND NOT (id = ANY(v_matched_util))
         ORDER BY id LIMIT 1;
      END IF;
    END IF;
    IF v_row_gone THEN CONTINUE; END IF;

    IF v_row_id IS NOT NULL THEN
      UPDATE utilities SET
        provider = v_u->>'provider',
        type = COALESCE(NULLIF(v_u->>'type',''), type),
        account_number = COALESCE(NULLIF(v_u->>'account_number',''), account_number),
        amount = COALESCE(NULLIF(v_u->>'amount','')::numeric, amount),
        due = public._wizard_merge_due(due, public._wizard_safe_date(v_u->>'due_date'),
                                       public._wizard_day(v_u->>'due_day')),
        responsibility = COALESCE(v_resp, responsibility),
        website = COALESCE(NULLIF(v_u->>'website',''), website),
        username_encrypted = CASE WHEN NULLIF(v_u->>'username_encrypted','') IS NOT NULL
          THEN v_u->>'username_encrypted' ELSE username_encrypted END,
        password_encrypted = CASE WHEN NULLIF(v_u->>'username_encrypted','') IS NOT NULL
          THEN v_u->>'password_encrypted' ELSE password_encrypted END,
        encryption_iv = CASE WHEN NULLIF(v_u->>'username_encrypted','') IS NOT NULL
          THEN v_u->>'encryption_iv' ELSE encryption_iv END,
        encryption_iv_username = CASE WHEN NULLIF(v_u->>'username_encrypted','') IS NOT NULL
          THEN v_u->>'encryption_iv_username' ELSE encryption_iv_username END,
        encryption_salt = CASE WHEN NULLIF(v_u->>'username_encrypted','') IS NOT NULL
          THEN v_u->>'encryption_salt' ELSE encryption_salt END,
        credential_key_fp = CASE WHEN NULLIF(v_u->>'username_encrypted','') IS NOT NULL
          THEN COALESCE(NULLIF(v_u->>'credential_key_fp',''), credential_key_fp) ELSE credential_key_fp END
      WHERE id = v_row_id AND company_id = v_company_id;
      v_matched_util := v_matched_util || v_row_id;
    ELSE
      INSERT INTO utilities (
        company_id, property, provider, type, account_number, amount, due,
        responsibility, status, website,
        username_encrypted, password_encrypted,
        encryption_iv, encryption_iv_username, encryption_salt, credential_key_fp
      ) VALUES (
        v_company_id, v_address, v_u->>'provider', COALESCE(NULLIF(v_u->>'type',''),'Electric'), NULLIF(v_u->>'account_number',''),
        COALESCE(NULLIF(v_u->>'amount','')::numeric, 0),
        -- No date and no day given (a blank import cell): leave it blank rather
        -- than invent the 1st. The wizard always sends a day for a new row.
        public._wizard_merge_due(NULL, public._wizard_safe_date(v_u->>'due_date'),
                                 public._wizard_day(v_u->>'due_day')),
        v_resp,
        'pending',
        COALESCE(v_u->>'website',''),
        NULLIF(v_u->>'username_encrypted',''), NULLIF(v_u->>'password_encrypted',''),
        NULLIF(v_u->>'encryption_iv',''), NULLIF(v_u->>'encryption_iv_username',''),
        NULLIF(v_u->>'encryption_salt',''), NULLIF(v_u->>'credential_key_fp','')
      ) RETURNING id INTO v_row_id;
      v_matched_util := v_matched_util || v_row_id;
    END IF;
  END LOOP;
  -- Removal: only rows the form SAW when it opened and that are not in the
  -- payload. A row that appeared meanwhile, or one the form never loaded, is
  -- left alone. Final bills are never archived here.
  IF v_mode = 'edit' THEN
    IF jsonb_typeof(p_payload->'utilities_seen_ids') = 'array' THEN
      UPDATE utilities SET archived_at = now()
       WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL
         AND is_final_bill IS NOT TRUE
         AND id::text IN (SELECT jsonb_array_elements_text(p_payload->'utilities_seen_ids'))
         AND NOT (id = ANY(v_matched_util));
    ELSIF jsonb_typeof(p_payload->'utilities_seen') = 'array' THEN
      UPDATE utilities SET archived_at = now()
       WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL
         AND is_final_bill IS NOT TRUE
         AND provider IN (SELECT jsonb_array_elements_text(p_payload->'utilities_seen'))
         AND NOT (id = ANY(v_matched_util));
    END IF;
  END IF;

  -- ─── HOAs — merge in edit mode ───────────────────────────────────
  -- status and paid_date are never written on an existing row: a paid bill
  -- stays paid.
  FOR v_h IN SELECT * FROM jsonb_array_elements(v_hoas) LOOP
    IF COALESCE(trim(v_h->>'hoa_name'),'') = '' THEN CONTINUE; END IF;
    v_row_id := NULL;
    v_row_gone := false;
    IF v_mode = 'edit' THEN
      IF COALESCE(v_h->>'id','') ~ '^\d+$' THEN
        SELECT id INTO v_row_id FROM hoa_payments
         WHERE id = (v_h->>'id')::bigint AND company_id = v_company_id
           AND property = v_address AND archived_at IS NULL
           AND NOT (id = ANY(v_matched_hoa));
        v_row_gone := v_row_id IS NULL;
      ELSE
        SELECT id INTO v_row_id FROM hoa_payments
         WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL
           AND lower(btrim(hoa_name)) = lower(btrim(v_h->>'hoa_name'))
           AND NOT (id = ANY(v_matched_hoa))
         ORDER BY id LIMIT 1;
      END IF;
    END IF;
    IF v_row_gone THEN CONTINUE; END IF;

    IF v_row_id IS NOT NULL THEN
      UPDATE hoa_payments SET
        hoa_name = v_h->>'hoa_name',
        amount = COALESCE(NULLIF(v_h->>'amount','')::numeric, amount),
        due_date = CASE
          WHEN public._wizard_merge_due(public._wizard_safe_date(due_date),
                 public._wizard_safe_date(v_h->>'due_date'), public._wizard_day(v_h->>'due_day'))
               IS NOT DISTINCT FROM public._wizard_safe_date(due_date)
            THEN due_date
          ELSE COALESCE(public._wizard_merge_due(public._wizard_safe_date(due_date),
                 public._wizard_safe_date(v_h->>'due_date'), public._wizard_day(v_h->>'due_day'))::text, due_date)
        END,
        frequency = COALESCE(NULLIF(v_h->>'frequency',''), frequency),
        notes = COALESCE(NULLIF(v_h->>'notes',''), notes),
        website = COALESCE(NULLIF(v_h->>'website',''), website),
        username_encrypted = CASE WHEN NULLIF(v_h->>'username_encrypted','') IS NOT NULL
          THEN v_h->>'username_encrypted' ELSE username_encrypted END,
        password_encrypted = CASE WHEN NULLIF(v_h->>'username_encrypted','') IS NOT NULL
          THEN v_h->>'password_encrypted' ELSE password_encrypted END,
        encryption_iv = CASE WHEN NULLIF(v_h->>'username_encrypted','') IS NOT NULL
          THEN v_h->>'encryption_iv' ELSE encryption_iv END,
        encryption_iv_username = CASE WHEN NULLIF(v_h->>'username_encrypted','') IS NOT NULL
          THEN v_h->>'encryption_iv_username' ELSE encryption_iv_username END,
        encryption_salt = CASE WHEN NULLIF(v_h->>'username_encrypted','') IS NOT NULL
          THEN v_h->>'encryption_salt' ELSE encryption_salt END,
        credential_key_fp = COALESCE(NULLIF(v_h->>'credential_key_fp',''), credential_key_fp),
        management_company = COALESCE(NULLIF(v_h->>'management_company',''), management_company),
        mgmt_website = COALESCE(NULLIF(v_h->>'mgmt_website',''), mgmt_website),
        mgmt_username_encrypted = CASE WHEN NULLIF(v_h->>'mgmt_username_encrypted','') IS NOT NULL
          THEN v_h->>'mgmt_username_encrypted' ELSE mgmt_username_encrypted END,
        mgmt_password_encrypted = CASE WHEN NULLIF(v_h->>'mgmt_username_encrypted','') IS NOT NULL
          THEN v_h->>'mgmt_password_encrypted' ELSE mgmt_password_encrypted END,
        mgmt_encryption_iv = CASE WHEN NULLIF(v_h->>'mgmt_username_encrypted','') IS NOT NULL
          THEN v_h->>'mgmt_encryption_iv' ELSE mgmt_encryption_iv END,
        mgmt_encryption_iv_username = CASE WHEN NULLIF(v_h->>'mgmt_username_encrypted','') IS NOT NULL
          THEN v_h->>'mgmt_encryption_iv_username' ELSE mgmt_encryption_iv_username END,
        pay_portal_website = COALESCE(NULLIF(v_h->>'pay_portal_website',''), pay_portal_website),
        pay_username_encrypted = CASE WHEN NULLIF(v_h->>'pay_username_encrypted','') IS NOT NULL
          THEN v_h->>'pay_username_encrypted' ELSE pay_username_encrypted END,
        pay_password_encrypted = CASE WHEN NULLIF(v_h->>'pay_username_encrypted','') IS NOT NULL
          THEN v_h->>'pay_password_encrypted' ELSE pay_password_encrypted END,
        pay_encryption_iv = CASE WHEN NULLIF(v_h->>'pay_username_encrypted','') IS NOT NULL
          THEN v_h->>'pay_encryption_iv' ELSE pay_encryption_iv END,
        pay_encryption_iv_username = CASE WHEN NULLIF(v_h->>'pay_username_encrypted','') IS NOT NULL
          THEN v_h->>'pay_encryption_iv_username' ELSE pay_encryption_iv_username END,
        contact_name = COALESCE(NULLIF(v_h->>'contact_name',''), contact_name),
        contact_email = COALESCE(NULLIF(v_h->>'contact_email',''), contact_email),
        contact_phone = COALESCE(NULLIF(v_h->>'contact_phone',''), contact_phone)
      WHERE id = v_row_id AND company_id = v_company_id;
      v_matched_hoa := v_matched_hoa || v_row_id;
    ELSE
      INSERT INTO hoa_payments (
        company_id, property, hoa_name, amount, due_date,
        frequency, status, notes, website,
        username_encrypted, password_encrypted,
        encryption_iv, encryption_iv_username, encryption_salt, credential_key_fp,
        management_company, mgmt_website,
        mgmt_username_encrypted, mgmt_password_encrypted,
        mgmt_encryption_iv, mgmt_encryption_iv_username,
        pay_portal_website,
        pay_username_encrypted, pay_password_encrypted,
        pay_encryption_iv, pay_encryption_iv_username,
        contact_name, contact_email, contact_phone
      ) VALUES (
        v_company_id, v_address, v_h->>'hoa_name',
        (v_h->>'amount')::numeric,
        COALESCE(public._wizard_merge_due(NULL, public._wizard_safe_date(v_h->>'due_date'),
          public._wizard_day(v_h->>'due_day'))::text, ''),
        COALESCE(v_h->>'frequency','Monthly'),
        'pending',
        COALESCE(v_h->>'notes',''),
        COALESCE(v_h->>'website',''),
        NULLIF(v_h->>'username_encrypted',''), NULLIF(v_h->>'password_encrypted',''),
        NULLIF(v_h->>'encryption_iv',''), NULLIF(v_h->>'encryption_iv_username',''),
        NULLIF(v_h->>'encryption_salt',''), NULLIF(v_h->>'credential_key_fp',''),
        NULLIF(v_h->>'management_company',''), COALESCE(v_h->>'mgmt_website',''),
        NULLIF(v_h->>'mgmt_username_encrypted',''), NULLIF(v_h->>'mgmt_password_encrypted',''),
        NULLIF(v_h->>'mgmt_encryption_iv',''), NULLIF(v_h->>'mgmt_encryption_iv_username',''),
        COALESCE(v_h->>'pay_portal_website',''),
        NULLIF(v_h->>'pay_username_encrypted',''), NULLIF(v_h->>'pay_password_encrypted',''),
        NULLIF(v_h->>'pay_encryption_iv',''), NULLIF(v_h->>'pay_encryption_iv_username',''),
        NULLIF(v_h->>'contact_name',''), NULLIF(v_h->>'contact_email',''), NULLIF(v_h->>'contact_phone','')
      ) RETURNING id INTO v_row_id;
      v_matched_hoa := v_matched_hoa || v_row_id;
    END IF;
  END LOOP;
  IF v_mode = 'edit' THEN
    IF jsonb_typeof(p_payload->'hoas_seen_ids') = 'array' THEN
      UPDATE hoa_payments SET archived_at = now(), archived_by = v_caller_email
       WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL
         AND id::text IN (SELECT jsonb_array_elements_text(p_payload->'hoas_seen_ids'))
         AND NOT (id = ANY(v_matched_hoa));
    ELSIF jsonb_typeof(p_payload->'hoas_seen') = 'array' THEN
      UPDATE hoa_payments SET archived_at = now(), archived_by = v_caller_email
       WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL
         AND hoa_name IN (SELECT jsonb_array_elements_text(p_payload->'hoas_seen'))
         AND NOT (id = ANY(v_matched_hoa));
    END IF;
  END IF;

  IF v_loan IS NOT NULL AND COALESCE((v_loan->>'enabled')::boolean, false) THEN
    v_loan_has_creds := NULLIF(v_loan->>'username_encrypted','') IS NOT NULL
                    AND NULLIF(v_loan->>'password_encrypted','') IS NOT NULL;
    v_loan_id := NULLIF(v_loan->>'id','');
    v_skip := false;
    IF v_loan_id IS NOT NULL THEN
      SELECT id INTO v_existing_loan_id FROM property_loans
       WHERE id::text = v_loan_id AND company_id = v_company_id AND archived_at IS NULL
       LIMIT 1;
      -- The loan the form was showing has been archived since: never
      -- resurrect it as a new row.
      v_skip := v_existing_loan_id IS NULL;
    ELSE
      SELECT count(*) INTO v_loan_count FROM property_loans
       WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL;
      IF v_loan_count = 1 THEN
        SELECT id INTO v_existing_loan_id FROM property_loans
         WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL
         LIMIT 1;
      ELSE
        v_existing_loan_id := NULL;
      END IF;
    END IF;
    IF v_skip THEN
      NULL;
    ELSIF v_existing_loan_id IS NOT NULL THEN
      UPDATE property_loans SET
        lender_name = v_loan->>'lender_name',
        loan_type = COALESCE(v_loan->>'loan_type','Conventional'),
        original_amount = public._wizard_num(v_loan->>'original_amount', original_amount),
        current_balance = public._wizard_num(v_loan->>'current_balance', current_balance),
        interest_rate = public._wizard_num(v_loan->>'interest_rate', interest_rate),
        monthly_payment = public._wizard_num(v_loan->>'monthly_payment', monthly_payment),
        escrow_included = public._wizard_bool(v_loan->>'escrow_included', escrow_included),
        escrow_amount = public._wizard_num(v_loan->>'escrow_amount', escrow_amount),
        loan_start_date = NULLIF(v_loan->>'loan_start_date','')::date,
        maturity_date = NULLIF(v_loan->>'maturity_date','')::date,
        account_number = public._wizard_txt(v_loan->>'account_number', account_number),
        username_encrypted = CASE WHEN v_loan_has_creds THEN v_loan->>'username_encrypted' ELSE username_encrypted END,
        password_encrypted = CASE WHEN v_loan_has_creds THEN v_loan->>'password_encrypted' ELSE password_encrypted END,
        encryption_iv_username = CASE WHEN v_loan_has_creds THEN v_loan->>'encryption_iv_username' ELSE encryption_iv_username END,
        encryption_iv = CASE WHEN v_loan_has_creds THEN v_loan->>'encryption_iv' ELSE encryption_iv END,
        encryption_salt = CASE WHEN v_loan_has_creds THEN v_loan->>'encryption_salt' ELSE encryption_salt END,
        credential_key_fp = CASE WHEN v_loan_has_creds
          THEN COALESCE(NULLIF(v_loan->>'credential_key_fp',''), credential_key_fp) ELSE credential_key_fp END,
        website = COALESCE(NULLIF(v_loan->>'website',''), website),
        notes = public._wizard_txt(COALESCE(v_loan->>'notes',''), notes)
      WHERE id = v_existing_loan_id AND company_id = v_company_id;
    ELSE
      INSERT INTO property_loans (
        company_id, property, property_id, lender_name, loan_type,
        original_amount, current_balance, interest_rate, monthly_payment,
        escrow_included, escrow_amount, loan_start_date, maturity_date,
        account_number,
        username_encrypted, password_encrypted,
        encryption_iv_username, encryption_iv, encryption_salt, credential_key_fp,
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
        v_loan->>'account_number',
        v_loan->>'username_encrypted', v_loan->>'password_encrypted',
        v_loan->>'encryption_iv_username', v_loan->>'encryption_iv',
        v_loan->>'encryption_salt', NULLIF(v_loan->>'credential_key_fp',''),
        COALESCE(v_loan->>'website',''),
        COALESCE(v_loan->>'notes','')
      );
    END IF;

    -- Owner decision (audit theme K, double expenses): the wizard no longer
    -- creates or updates a Mortgage/Loan recurring journal schedule. The
    -- setup_recurring / payment_day payload keys are ignored.
  ELSIF v_mode = 'edit' AND v_loan IS NOT NULL AND NULLIF(v_loan->>'id','') IS NOT NULL THEN
    -- The user switched off THIS loan (or moved the property to a portfolio
    -- loan). Only that loan is archived -- never every loan on the property,
    -- and never because the loan section was simply absent.
    UPDATE property_loans SET archived_at = now()
     WHERE id::text = v_loan->>'id' AND company_id = v_company_id
       AND property = v_address AND archived_at IS NULL;
    IF NOT EXISTS (SELECT 1 FROM property_loans
                    WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL) THEN
      UPDATE recurring_journal_entries SET status = 'inactive', archived_at = now()
       WHERE company_id = v_company_id AND property = v_address AND status = 'active'
         AND archived_at IS NULL AND description LIKE 'Mortgage/Loan%';
    END IF;
  END IF;

  IF v_insurance IS NOT NULL AND COALESCE((v_insurance->>'enabled')::boolean, false) THEN
    v_ins_has_creds := NULLIF(v_insurance->>'username_encrypted','') IS NOT NULL
                   AND NULLIF(v_insurance->>'password_encrypted','') IS NOT NULL;
    v_ins_id := NULLIF(v_insurance->>'id','');
    v_skip := false;
    IF v_ins_id IS NOT NULL THEN
      SELECT id INTO v_existing_ins_id FROM property_insurance
      WHERE id::text = v_ins_id AND company_id = v_company_id AND archived_at IS NULL;
      v_skip := v_existing_ins_id IS NULL;   -- archived meanwhile: do not resurrect
    ELSE
      SELECT id INTO v_existing_ins_id FROM property_insurance
      WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL
      ORDER BY created_at, id
      LIMIT 1;
    END IF;
    IF v_skip THEN
      NULL;
    ELSIF v_existing_ins_id IS NOT NULL THEN
      UPDATE property_insurance SET
        provider = v_insurance->>'provider',
        policy_number = public._wizard_txt(v_insurance->>'policy_number', policy_number),
        premium_amount = public._wizard_num(v_insurance->>'premium_amount', premium_amount),
        premium_frequency = COALESCE(v_insurance->>'premium_frequency','annual'),
        coverage_amount = public._wizard_num(v_insurance->>'coverage_amount', coverage_amount),
        expiration_date = NULLIF(v_insurance->>'expiration_date','')::date,
        notes = public._wizard_txt(COALESCE(v_insurance->>'notes',''), notes),
        website = COALESCE(NULLIF(v_insurance->>'website',''), website),
        username_encrypted = CASE WHEN v_ins_has_creds THEN v_insurance->>'username_encrypted' ELSE username_encrypted END,
        password_encrypted = CASE WHEN v_ins_has_creds THEN v_insurance->>'password_encrypted' ELSE password_encrypted END,
        encryption_iv_username = CASE WHEN v_ins_has_creds THEN v_insurance->>'encryption_iv_username' ELSE encryption_iv_username END,
        encryption_iv = CASE WHEN v_ins_has_creds THEN v_insurance->>'encryption_iv' ELSE encryption_iv END,
        encryption_salt = CASE WHEN v_ins_has_creds THEN v_insurance->>'encryption_salt' ELSE encryption_salt END,
        credential_key_fp = CASE WHEN v_ins_has_creds
          THEN COALESCE(NULLIF(v_insurance->>'credential_key_fp',''), credential_key_fp) ELSE credential_key_fp END
      WHERE id = v_existing_ins_id AND company_id = v_company_id;
    ELSE
      INSERT INTO property_insurance (
        company_id, property, property_id,
        provider, policy_number, premium_amount, premium_frequency,
        coverage_amount, expiration_date, notes, website,
        username_encrypted, password_encrypted,
        encryption_iv_username, encryption_iv, encryption_salt, credential_key_fp
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
        v_insurance->>'encryption_salt', NULLIF(v_insurance->>'credential_key_fp','')
      );
    END IF;
  ELSIF v_mode = 'edit' AND v_insurance IS NOT NULL AND NULLIF(v_insurance->>'id','') IS NOT NULL THEN
    -- The user switched off THIS policy. Only it is archived; a skipped or
    -- unloaded insurance step (no id) leaves every policy alone.
    UPDATE property_insurance SET archived_at = now()
     WHERE id::text = v_insurance->>'id' AND company_id = v_company_id
       AND property = v_address AND archived_at IS NULL;
  END IF;

  IF v_taxes IS NOT NULL AND COALESCE((v_taxes->>'enabled')::boolean, false) THEN
    v_tax_id := NULLIF(v_taxes->>'id','');
    v_skip := false;
    IF v_tax_id IS NOT NULL THEN
      SELECT id INTO v_existing_tax_id FROM property_taxes
      WHERE id::text = v_tax_id AND company_id = v_company_id AND archived_at IS NULL;
      v_skip := v_existing_tax_id IS NULL;
    ELSE
      SELECT id INTO v_existing_tax_id FROM property_taxes
      WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL
      ORDER BY created_at, id
      LIMIT 1;
    END IF;
    IF v_skip THEN
      NULL;
    ELSIF v_existing_tax_id IS NOT NULL THEN
      UPDATE property_taxes SET
        county = COALESCE(NULLIF(v_taxes->>'county',''), county),
        jurisdiction = COALESCE(NULLIF(v_taxes->>'jurisdiction',''), jurisdiction),
        parcel_id = NULLIF(v_taxes->>'parcel_id',''),
        assessed_value = NULLIF(v_taxes->>'assessed_value','')::numeric,
        tax_year = NULLIF(v_taxes->>'tax_year','')::int,
        annual_tax_amount = COALESCE(NULLIF(v_taxes->>'annual_tax_amount','')::numeric, annual_tax_amount),
        billing_frequency = COALESCE(v_taxes->>'billing_frequency','semi_annual'),
        next_due_date = NULLIF(v_taxes->>'next_due_date','')::date,
        exemptions = NULLIF(v_taxes->>'exemptions',''),
        escrow_paid_by_lender = COALESCE((v_taxes->>'escrow_paid_by_lender')::boolean, false),
        records_url = NULLIF(v_taxes->>'records_url',''),
        notes = NULLIF(v_taxes->>'notes','')
      WHERE id = v_existing_tax_id AND company_id = v_company_id;
    ELSE
      INSERT INTO property_taxes (
        company_id, property, property_id, county, jurisdiction,
        parcel_id, assessed_value, tax_year, annual_tax_amount,
        billing_frequency, next_due_date, exemptions,
        escrow_paid_by_lender, records_url, notes
      ) VALUES (
        v_company_id, v_address, v_property_id,
        NULLIF(v_taxes->>'county',''), NULLIF(v_taxes->>'jurisdiction',''),
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
  ELSIF v_mode = 'edit' AND v_taxes IS NOT NULL AND NULLIF(v_taxes->>'id','') IS NOT NULL THEN
    -- The user switched off THIS tax record; nothing else is archived.
    UPDATE property_taxes SET archived_at = now()
     WHERE id::text = v_taxes->>'id' AND company_id = v_company_id
       AND property = v_address AND archived_at IS NULL;
  END IF;

  IF v_is_occupied AND v_tenant_id IS NOT NULL
     AND v_recurring IS NOT NULL AND NULLIF(v_recurring->>'amount','')::numeric IS NOT NULL THEN
    v_tenant_ar_id := _wizard_get_tenant_ar(v_company_id, v_tenant_name, v_tenant_id);
    v_revenue_id := _wizard_resolve_account(v_company_id, '4000');
    v_day := GREATEST(1, LEAST(31, COALESCE(NULLIF(v_recurring->>'day_of_month','')::int, 1)));
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

      -- Match the guard's uniqueness key (company_id + tenant_id), NOT tenant_name +
      -- description. The old name-based lookup missed an existing schedule whose
      -- stored tenant_name differed from the recomputed v_all_tenants, so the RPC
      -- INSERTed a second active schedule and guard_one_active_recurring_per_tenant
      -- rejected the whole atomic commit (4620 Deepwood / tenant 1346).
      SELECT id, day_of_month, next_post_date INTO v_existing_recur_id, v_old_day, v_old_next
        FROM recurring_journal_entries
      WHERE company_id = v_company_id
        AND tenant_id = v_tenant_id
        AND status = 'active' AND archived_at IS NULL
      LIMIT 1;
      -- An existing schedule keeps its next posting when the day is unchanged
      -- and no LATER start was asked for. Recomputing it from the lease start
      -- on every save moved it (usually backwards) without anyone asking.
      IF v_existing_recur_id IS NOT NULL AND v_old_next IS NOT NULL
         AND v_old_day IS NOT DISTINCT FROM v_day
         AND (v_user_next IS NULL OR v_user_next <= v_old_next) THEN
        v_next_post_date := v_old_next;
      END IF;
    END;
    IF v_existing_recur_id IS NOT NULL THEN
      UPDATE recurring_journal_entries SET
        description = 'Monthly rent — ' || v_all_tenants || ' — ' || split_part(v_address, ',', 1),
        frequency = COALESCE(v_recurring->>'frequency','monthly'),
        day_of_month = v_day,
        amount = (v_recurring->>'amount')::numeric,
        tenant_name = v_all_tenants,
        tenant_id = v_tenant_id,
        property = v_address,
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
  ELSIF v_mode = 'edit' AND v_tenant_id IS NOT NULL
        AND COALESCE((p_payload->>'recurring_cleared')::boolean, false) THEN
    -- The user cleared recurring rent on an occupied property: stop future
    -- posts. A payload that merely omits recurring changes nothing.
    UPDATE recurring_journal_entries SET status = 'inactive', archived_at = now()
     WHERE company_id = v_company_id AND status = 'active' AND archived_at IS NULL
       AND tenant_id = v_tenant_id AND description LIKE 'Monthly rent%';
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
$fn$;
