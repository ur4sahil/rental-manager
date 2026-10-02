-- Convert a prospect into a tenant: one transaction.
--
-- Everything that makes someone a tenant in the RECORDS happens here or not
-- at all -- the tenant, the lease, the property turning occupied, the
-- prospect's documents following them. (The ledger entries -- deposit,
-- first month's rent, the monthly schedule -- are posted by the client
-- straight afterwards through the same idempotent helpers the property
-- wizard uses; see src/utils/tenantOnboarding.js. That half can be re-run
-- safely, which is why it does not need to be in here.)
--
-- The rules, decided with Sahil:
--   * a lease may be signed at any time, but a prospect can only be
--     converted when the property is VACANT;
--   * nothing reaches the books before conversion;
--   * the first fully signed lease for a property wins -- the others are
--     cancelled quietly and staff are told, the applicants are not.

-- The losing leases for a property, cancelled. Shared by the trigger (a
-- lease has just been fully signed) and by the conversion (a lease signed
-- on paper never fires that trigger).
CREATE OR REPLACE FUNCTION public._cancel_competing_prospect_leases(
  p_company_id text, p_property_id integer, p_winner uuid, p_winner_name text, p_by_doc uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_other record; v_n integer := 0;
BEGIN
  IF p_property_id IS NULL THEN RETURN 0; END IF;
  FOR v_other IN
    SELECT d.id, d.prospect_id FROM doc_generated d
     WHERE d.company_id = p_company_id AND d.property_id = p_property_id
       AND d.prospect_id IS NOT NULL AND d.prospect_id <> p_winner
       AND (p_by_doc IS NULL OR d.id <> p_by_doc)
       AND d.doc_kind = 'lease' AND d.envelope_status = 'out_for_signature'
     FOR UPDATE
  LOOP
    UPDATE doc_signatures SET status = 'voided'
     WHERE doc_id = v_other.id AND status IN ('pending','sent','viewed');
    -- The prospect is told first: the UPDATE of doc_generated below re-enters
    -- the envelope trigger for the cancelled lease, and that branch only
    -- resets a status that is still 'lease_sent'.
    UPDATE prospects
       SET status = 'new', updated_at = now(),
           attention = 'Lease cancelled on ' || to_char(now() AT TIME ZONE 'America/New_York', 'Mon DD, YYYY')
                       || ': the property was leased to ' || COALESCE(NULLIF(p_winner_name, ''), 'another applicant') || '. They have not been told.'
     WHERE id = v_other.prospect_id AND status = 'lease_sent';
    UPDATE doc_generated
       SET envelope_status = 'voided', voided_at = now(), voided_by = 'system',
           void_reason = 'Another lease for this property was fully signed first', voided_by_doc_id = p_by_doc
     WHERE id = v_other.id;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public._cancel_competing_prospect_leases(text, integer, uuid, text, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._prospect_follow_envelope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_winner text;
BEGIN
  IF NEW.prospect_id IS NULL OR NEW.doc_kind <> 'lease' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.envelope_status IS NOT DISTINCT FROM OLD.envelope_status THEN RETURN NEW; END IF;

  IF NEW.envelope_status = 'out_for_signature' THEN
    UPDATE prospects SET status = 'lease_sent', attention = NULL, updated_at = now()
     WHERE id = NEW.prospect_id AND status IN ('new','lease_sent');

  ELSIF NEW.envelope_status = 'completed' THEN
    UPDATE prospects SET status = 'signed', attention = NULL, updated_at = now()
     WHERE id = NEW.prospect_id AND status IN ('new','lease_sent');
    SELECT name INTO v_winner FROM prospects WHERE id = NEW.prospect_id;
    PERFORM public._cancel_competing_prospect_leases(NEW.company_id, NEW.property_id, NEW.prospect_id, v_winner, NEW.id);

  ELSIF NEW.envelope_status IN ('voided','declined') THEN
    -- Back to "new" only when nothing else of theirs is still out.
    UPDATE prospects p SET status = 'new', updated_at = now()
     WHERE p.id = NEW.prospect_id AND p.status = 'lease_sent'
       AND NOT EXISTS (SELECT 1 FROM doc_generated d
                        WHERE d.prospect_id = p.id AND d.id <> NEW.id AND d.doc_kind = 'lease'
                          AND d.envelope_status = 'out_for_signature');
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._prospect_follow_envelope() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.convert_prospect_to_tenant(p_prospect_id uuid, p_signed_outside boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_p prospects%ROWTYPE;
  v_prop properties%ROWTYPE;
  v_who text := COALESCE(NULLIF(auth.email(), ''), 'system');
  v_name text;
  v_tenant_id bigint;
  v_lease_id uuid;
  v_signed boolean;
  v_block text;
  v_c jsonb;
  v_co text[] := '{}';
  v_emails text[] := '{}';
  v_phones text[] := '{}';
BEGIN
  SELECT * INTO v_p FROM prospects WHERE id = p_prospect_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'That prospect no longer exists.' USING ERRCODE = 'P0002', HINT = 'not_found'; END IF;
  -- auth.role() is empty for the database owner and the service key; a
  -- browser request is 'authenticated' and must be staff of this company.
  IF COALESCE(NULLIF(auth.role(), ''), 'postgres') NOT IN ('service_role', 'postgres')
     AND NOT public.is_company_staff(v_p.company_id) THEN
    RAISE EXCEPTION 'You do not have access to this company.' USING ERRCODE = '42501';
  END IF;
  IF v_p.archived_at IS NOT NULL THEN RAISE EXCEPTION 'This prospect has been archived.' USING HINT = 'archived'; END IF;
  -- Pressing the button twice must not make two tenants.
  IF v_p.status = 'converted' THEN
    RETURN jsonb_build_object('already_converted', true, 'tenant_id', v_p.converted_tenant_id, 'lease_id', v_p.converted_lease_id);
  END IF;
  IF v_p.status = 'lost' THEN RAISE EXCEPTION 'This prospect is marked lost. Reopen them first.' USING HINT = 'lost'; END IF;

  v_signed := EXISTS (SELECT 1 FROM doc_generated d
                       WHERE d.prospect_id = v_p.id AND d.doc_kind = 'lease' AND d.envelope_status = 'completed');
  IF NOT v_signed AND NOT COALESCE(p_signed_outside, false) THEN
    RAISE EXCEPTION 'The lease has not been fully signed yet.' USING HINT = 'not_signed';
  END IF;

  v_name := btrim(COALESCE(v_p.name, ''));
  IF v_name = '' THEN RAISE EXCEPTION 'The prospect needs a name.' USING HINT = 'missing_terms'; END IF;
  IF v_p.property_id IS NULL THEN RAISE EXCEPTION 'Choose the property for this prospect first.' USING HINT = 'missing_terms'; END IF;
  SELECT * INTO v_prop FROM properties WHERE id = v_p.property_id AND company_id = v_p.company_id FOR UPDATE;
  IF NOT FOUND OR v_prop.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'The property chosen for this prospect no longer exists.' USING HINT = 'missing_terms';
  END IF;
  IF v_p.lease_start IS NULL OR v_p.lease_end IS NULL OR COALESCE(v_p.rent, 0) <= 0 THEN
    RAISE EXCEPTION 'Lease start, lease end and rent are needed before converting.' USING HINT = 'missing_terms';
  END IF;
  IF v_p.lease_end <= v_p.lease_start THEN
    RAISE EXCEPTION 'The lease end date must be after the start date.' USING HINT = 'missing_terms';
  END IF;

  -- Vacant? Someone still living there (active or on notice), or a lease
  -- still running, means not yet.
  SELECT t.name INTO v_block FROM tenants t
   WHERE t.company_id = v_p.company_id AND t.archived_at IS NULL
     AND lower(COALESCE(t.lease_status, '')) IN ('active', 'current', 'notice')
     AND (t.property_id = v_prop.id OR t.property = v_prop.address)
   LIMIT 1;
  IF v_block IS NOT NULL THEN
    RAISE EXCEPTION '% is still the tenant at this property. Move them out first, then convert.', v_block USING HINT = 'occupied';
  END IF;
  IF EXISTS (SELECT 1 FROM leases l
              WHERE l.company_id = v_p.company_id AND l.archived_at IS NULL AND l.status = 'active'
                AND (l.property_id = v_prop.id OR l.property = v_prop.address)) THEN
    RAISE EXCEPTION 'This property still has an active lease on file. End that lease first, then convert.' USING HINT = 'occupied';
  END IF;

  -- The other adults on the lease (up to four: the property has four slots).
  FOR v_c IN SELECT * FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_p.co_applicants) = 'array' THEN v_p.co_applicants ELSE '[]'::jsonb END) LOOP
    IF btrim(COALESCE(v_c->>'name', '')) <> '' AND lower(btrim(v_c->>'name')) <> lower(v_name)
       AND COALESCE(array_length(v_co, 1), 0) < 4 THEN
      v_co := v_co || btrim(v_c->>'name');
      v_emails := v_emails || lower(btrim(COALESCE(v_c->>'email', '')));
      v_phones := v_phones || btrim(COALESCE(v_c->>'phone', ''));
    END IF;
  END LOOP;

  -- ── the tenant. The tenants trigger turns the property occupied and
  -- copies the names, rent and lease dates onto it.
  BEGIN
    INSERT INTO tenants (company_id, name, first_name, last_name, email, phone, property, property_id, rent,
                         lease_status, lease_start, lease_end_date, move_in, balance, security_deposit, co_tenants, doc_status)
    VALUES (v_p.company_id, v_name, COALESCE(v_p.first_name, ''), COALESCE(v_p.last_name, ''),
            lower(NULLIF(btrim(COALESCE(v_p.email, '')), '')), NULLIF(btrim(COALESCE(v_p.phone, '')), ''),
            v_prop.address, v_prop.id, v_p.rent, 'active', v_p.lease_start, v_p.lease_end, v_p.lease_start, 0,
            v_p.security_deposit, v_co, 'pending_docs')
    RETURNING id INTO v_tenant_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'A tenant named "%" already exists at this property.', v_name USING HINT = 'duplicate';
  END;

  -- Co-tenant contact details live on the property.
  UPDATE properties SET
    tenant_2_email = COALESCE(v_emails[1], ''), tenant_2_phone = COALESCE(v_phones[1], ''),
    tenant_3_email = COALESCE(v_emails[2], ''), tenant_3_phone = COALESCE(v_phones[2], ''),
    tenant_4_email = COALESCE(v_emails[3], ''), tenant_4_phone = COALESCE(v_phones[3], ''),
    tenant_5_email = COALESCE(v_emails[4], ''), tenant_5_phone = COALESCE(v_phones[4], ''),
    security_deposit = COALESCE(v_p.security_deposit, security_deposit)
  WHERE id = v_prop.id AND company_id = v_p.company_id;

  -- ── the lease
  INSERT INTO leases (company_id, tenant_name, tenant_id, property, property_id, start_date, end_date,
                      rent_amount, security_deposit, status, payment_due_day, signature_status, created_by)
  VALUES (v_p.company_id, v_name, v_tenant_id::integer, v_prop.address, v_prop.id, v_p.lease_start, v_p.lease_end,
          v_p.rent, COALESCE(v_p.security_deposit, 0), 'active', 1,
          CASE WHEN v_signed THEN 'fully_signed' ELSE 'unsigned' END, v_who)
  RETURNING id INTO v_lease_id;

  -- A lease signed on paper: whatever was still out for e-signature is
  -- withdrawn, for this prospect and for anyone else sent a lease for the
  -- same property.
  IF NOT v_signed THEN
    UPDATE doc_signatures SET status = 'voided'
     WHERE status IN ('pending','sent','viewed')
       AND doc_id IN (SELECT id FROM doc_generated WHERE prospect_id = v_p.id AND envelope_status = 'out_for_signature');
    UPDATE doc_generated SET envelope_status = 'voided', voided_at = now(), voided_by = v_who,
           void_reason = 'The lease was signed outside the app'
     WHERE prospect_id = v_p.id AND envelope_status = 'out_for_signature';
  END IF;
  PERFORM public._cancel_competing_prospect_leases(v_p.company_id, v_prop.id, v_p.id, v_name, NULL);

  -- ── their documents follow them
  UPDATE doc_generated
     SET tenant_id = v_tenant_id, tenant_name = v_name,
         lease_id = CASE WHEN doc_kind IN ('lease','addendum') AND envelope_status <> 'voided' THEN v_lease_id ELSE lease_id END
   WHERE prospect_id = v_p.id AND company_id = v_p.company_id;
  UPDATE documents
     SET tenant_id = v_tenant_id, tenant = v_name, property = v_prop.address, property_id = v_prop.id
   WHERE company_id = v_p.company_id
     AND (prospect_id = v_p.id
          OR id IN (SELECT filed_document_id FROM doc_generated WHERE prospect_id = v_p.id AND filed_document_id IS NOT NULL));

  UPDATE prospects
     SET status = 'converted', converted_tenant_id = v_tenant_id, converted_lease_id = v_lease_id,
         converted_at = now(), converted_by = v_who, attention = NULL, updated_at = now()
   WHERE id = v_p.id;

  INSERT INTO audit_trail (action, module, details, record_id, user_email, user_role, company_id)
  VALUES ('create', 'tenants', 'Prospect converted to tenant: ' || v_name || ' — ' || v_prop.address
          || CASE WHEN v_signed THEN '' ELSE ' (lease signed outside the app)' END,
          v_tenant_id::text, v_who, '', v_p.company_id);

  RETURN jsonb_build_object(
    'tenant_id', v_tenant_id, 'lease_id', v_lease_id, 'tenant_name', v_name,
    'property', v_prop.address, 'property_id', v_prop.id,
    'lease_start', v_p.lease_start, 'lease_end', v_p.lease_end,
    'rent', v_p.rent, 'security_deposit', COALESCE(v_p.security_deposit, 0),
    'signed_in_app', v_signed);
END $$;
REVOKE ALL ON FUNCTION public.convert_prospect_to_tenant(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_prospect_to_tenant(uuid, boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
