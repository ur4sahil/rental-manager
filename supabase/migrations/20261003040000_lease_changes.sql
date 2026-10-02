-- Lease changes that take effect on a date: renewals, rent increases, addenda.
--
-- Until now a renewal or a rent increase changed the lease THE MOMENT a
-- button was pressed. "Renew" on the Leases page raised the rent today for
-- a term starting months away; the rent increase stored an "effective date"
-- and ignored it; and neither produced a document or waited for anyone to
-- sign. (docs/PLAN-tenant-documents.md, steps 6-8, 12, 13.)
--
-- A change is now a row here:
--   awaiting_signature  a renewal or addendum has been sent and is not yet
--                       signed by everyone. Nothing has changed.
--   scheduled           signed (or, for a rent increase, the notice has been
--                       issued). Nothing has changed YET.
--   applied             its effective date arrived and the lease, the tenant
--                       and the rent schedule were changed together.
--   cancelled           withdrawn, declined, or the lease ended first.
--
-- The document drives the status: a trigger on doc_generated moves the
-- change when its envelope is completed or cancelled. Applying is one
-- function, so the daily job (Phase 5) and the app run the same code.

CREATE TABLE IF NOT EXISTS public.lease_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  lease_id uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  tenant_id bigint REFERENCES public.tenants(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('renewal', 'rent_increase', 'addendum')),
  effective_date date NOT NULL,
  -- renewal:       { "end_date": "YYYY-MM-DD", "rent": 2100 }
  -- rent_increase: { "rent": 2100, "reason": "..." }
  -- addendum:      { "rent": 2150 (optional), "add_people": [{ "name", "email", "phone" }],
  --                  "remove_people": ["name"], "summary": "..." }
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'awaiting_signature' CHECK (status IN ('awaiting_signature', 'scheduled', 'applied', 'cancelled')),
  doc_id uuid REFERENCES public.doc_generated(id) ON DELETE SET NULL,
  notice_date date,                  -- rent increase: the day the tenant was told
  note text,
  result_lease_id uuid REFERENCES public.leases(id) ON DELETE SET NULL,
  applied_at timestamptz, applied_by text,
  cancelled_at timestamptz, cancelled_by text, cancel_reason text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lease_changes_due ON public.lease_changes (company_id, effective_date) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_lease_changes_lease ON public.lease_changes (lease_id);
CREATE INDEX IF NOT EXISTS idx_lease_changes_tenant ON public.lease_changes (company_id, tenant_id) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_lease_changes_doc ON public.lease_changes (doc_id) WHERE doc_id IS NOT NULL;
-- One renewal and one rent increase in flight per lease. Two would each
-- believe it had the last word on the rent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lease_changes_one_open ON public.lease_changes (lease_id, kind)
  WHERE status IN ('awaiting_signature', 'scheduled') AND kind IN ('renewal', 'rent_increase');

ALTER TABLE public.lease_changes ENABLE ROW LEVEL SECURITY;
DO $pol$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lease_changes' AND policyname = 'lease_changes_staff') THEN
    CREATE POLICY lease_changes_staff ON public.lease_changes
      FOR ALL TO authenticated
      USING (public.is_company_staff(company_id))
      WITH CHECK (public.is_company_staff(company_id));
  END IF;
END $pol$;
REVOKE ALL ON public.lease_changes FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.lease_changes TO authenticated;
GRANT ALL ON public.lease_changes TO service_role;

-- ── apply one change (internal) ───────────────────────────────────────
-- Everything a change touches, in one transaction: the lease, the tenant
-- (whose trigger carries rent, names and lease dates onto the property), the
-- rent schedule that actually bills, and autopay.
CREATE OR REPLACE FUNCTION public._apply_lease_change(p_id uuid, p_by text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_c lease_changes%ROWTYPE;
  v_l leases%ROWTYPE;
  v_t tenants%ROWTYPE;
  v_new_rent numeric; v_old_rent numeric; v_end date; v_new_lease uuid;
  v_signed boolean := false;
  v_hist jsonb;
  v_people jsonb := '[]'::jsonb; v_person jsonb; v_names text[]; v_prop record; i int;
  v_remove text[]; v_add jsonb;
BEGIN
  SELECT * INTO v_c FROM lease_changes WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not found'); END IF;
  IF v_c.status <> 'scheduled' THEN RETURN jsonb_build_object('skipped', v_c.status); END IF;

  SELECT * INTO v_l FROM leases WHERE id = v_c.lease_id AND company_id = v_c.company_id FOR UPDATE;
  -- The lease ended (terminated, already renewed, archived) before the
  -- change's day came: there is nothing left to change.
  IF NOT FOUND OR v_l.status <> 'active' OR v_l.archived_at IS NOT NULL THEN
    UPDATE lease_changes SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'system',
           cancel_reason = 'The lease was no longer active when this was due to take effect', updated_at = now()
     WHERE id = p_id;
    RETURN jsonb_build_object('cancelled', true, 'reason', 'lease not active');
  END IF;
  IF v_l.tenant_id IS NOT NULL THEN SELECT * INTO v_t FROM tenants WHERE id = v_l.tenant_id AND company_id = v_c.company_id FOR UPDATE; END IF;

  v_old_rent := v_l.rent_amount;
  v_new_rent := NULLIF(v_c.payload ->> 'rent', '')::numeric;
  IF v_new_rent IS NOT NULL AND v_new_rent <= 0 THEN v_new_rent := NULL; END IF;
  IF v_c.doc_id IS NOT NULL THEN
    v_signed := EXISTS (SELECT 1 FROM doc_generated d WHERE d.id = v_c.doc_id AND d.envelope_status = 'completed');
  END IF;
  -- rent_increase_history is JSON kept as text.
  BEGIN v_hist := COALESCE(NULLIF(v_l.rent_increase_history, '')::jsonb, '[]'::jsonb); EXCEPTION WHEN others THEN v_hist := '[]'::jsonb; END;
  IF jsonb_typeof(v_hist) <> 'array' THEN v_hist := '[]'::jsonb; END IF;
  IF v_new_rent IS NOT NULL AND v_new_rent <> v_old_rent THEN
    v_hist := v_hist || jsonb_build_array(jsonb_build_object('from', v_old_rent, 'to', v_new_rent, 'date', v_c.effective_date,
              'reason', COALESCE(NULLIF(v_c.payload ->> 'reason', ''), initcap(replace(v_c.kind, '_', ' '))), 'change_id', v_c.id));
  END IF;

  IF v_c.kind = 'renewal' THEN
    v_end := NULLIF(v_c.payload ->> 'end_date', '')::date;
    IF v_end IS NULL OR v_end <= v_c.effective_date THEN RAISE EXCEPTION 'A renewal needs an end date after its start date.'; END IF;
    UPDATE leases SET status = 'renewed', updated_at = now() WHERE id = v_l.id;
    INSERT INTO leases (company_id, tenant_id, tenant_name, property, property_id, start_date, end_date, rent_amount,
                        security_deposit, deposit_status, deposit_returned, deposit_return_date, deposit_deductions,
                        rent_escalation_pct, escalation_frequency, payment_due_day, lease_type, auto_renew, renewal_notice_days,
                        clauses, special_terms, status, renewed_from, late_fee_amount, late_fee_type, late_fee_grace_days,
                        rent_increase_history, signature_status, created_by)
    VALUES (v_l.company_id, v_l.tenant_id, v_l.tenant_name, v_l.property, v_l.property_id, v_c.effective_date, v_end,
            COALESCE(v_new_rent, v_old_rent),
            v_l.security_deposit, COALESCE(v_l.deposit_status, 'held'), COALESCE(v_l.deposit_returned, 0), v_l.deposit_return_date, COALESCE(v_l.deposit_deductions, ''),
            v_l.rent_escalation_pct, v_l.escalation_frequency, v_l.payment_due_day, 'renewal', v_l.auto_renew, v_l.renewal_notice_days,
            v_l.clauses, v_l.special_terms, 'active', v_l.id, v_l.late_fee_amount, v_l.late_fee_type, v_l.late_fee_grace_days,
            v_hist::text, CASE WHEN v_signed THEN 'fully_signed' ELSE 'unsigned' END, COALESCE(p_by, ''))
    RETURNING id INTO v_new_lease;
    IF v_t.id IS NOT NULL THEN
      UPDATE tenants SET rent = COALESCE(v_new_rent, rent), lease_end_date = v_end, move_out = v_end WHERE id = v_t.id;
    END IF;

  ELSIF v_c.kind = 'rent_increase' THEN
    IF v_new_rent IS NULL THEN RAISE EXCEPTION 'A rent change needs the new rent.'; END IF;
    UPDATE leases SET rent_amount = v_new_rent, rent_increase_history = v_hist::text, updated_at = now() WHERE id = v_l.id;
    IF v_t.id IS NOT NULL THEN UPDATE tenants SET rent = v_new_rent WHERE id = v_t.id; END IF;

  ELSE -- addendum
    IF v_new_rent IS NOT NULL THEN
      UPDATE leases SET rent_amount = v_new_rent, rent_increase_history = v_hist::text, updated_at = now() WHERE id = v_l.id;
    END IF;
    v_add := CASE WHEN jsonb_typeof(v_c.payload -> 'add_people') = 'array' THEN v_c.payload -> 'add_people' ELSE '[]'::jsonb END;
    SELECT COALESCE(array_agg(lower(btrim(x))), '{}') INTO v_remove
      FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(v_c.payload -> 'remove_people') = 'array' THEN v_c.payload -> 'remove_people' ELSE '[]'::jsonb END) x;
    IF v_t.id IS NOT NULL AND (jsonb_array_length(v_add) > 0 OR COALESCE(array_length(v_remove, 1), 0) > 0) THEN
      -- The other adults are names on the tenant row; their email and phone
      -- sit on the property, by position. Rebuild both lists together so a
      -- removal does not leave someone else's email against the wrong name.
      SELECT * INTO v_prop FROM properties WHERE company_id = v_c.company_id
         AND ((v_t.property_id IS NOT NULL AND id = v_t.property_id) OR address = v_t.property)
       ORDER BY (archived_at IS NULL) DESC, id DESC LIMIT 1;
      v_names := COALESCE(v_t.co_tenants, '{}');
      FOR i IN 1 .. COALESCE(array_length(v_names, 1), 0) LOOP
        IF btrim(COALESCE(v_names[i], '')) = '' OR lower(btrim(v_names[i])) = ANY (v_remove) THEN CONTINUE; END IF;
        v_people := v_people || jsonb_build_array(jsonb_build_object('name', btrim(v_names[i]),
          'email', COALESCE(CASE i WHEN 1 THEN v_prop.tenant_2_email WHEN 2 THEN v_prop.tenant_3_email WHEN 3 THEN v_prop.tenant_4_email WHEN 4 THEN v_prop.tenant_5_email END, ''),
          'phone', COALESCE(CASE i WHEN 1 THEN v_prop.tenant_2_phone WHEN 2 THEN v_prop.tenant_3_phone WHEN 3 THEN v_prop.tenant_4_phone WHEN 4 THEN v_prop.tenant_5_phone END, '')));
      END LOOP;
      FOR v_person IN SELECT * FROM jsonb_array_elements(v_add) LOOP
        IF btrim(COALESCE(v_person ->> 'name', '')) = '' THEN CONTINUE; END IF;
        IF lower(btrim(v_person ->> 'name')) = lower(btrim(COALESCE(v_t.name, ''))) THEN CONTINUE; END IF;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_people) e WHERE lower(e ->> 'name') = lower(btrim(v_person ->> 'name'))) THEN CONTINUE; END IF;
        IF jsonb_array_length(v_people) >= 4 THEN RAISE EXCEPTION 'A tenancy holds at most five adults.'; END IF;
        v_people := v_people || jsonb_build_array(jsonb_build_object('name', btrim(v_person ->> 'name'),
          'email', lower(btrim(COALESCE(v_person ->> 'email', ''))), 'phone', btrim(COALESCE(v_person ->> 'phone', ''))));
      END LOOP;
      UPDATE tenants SET co_tenants = COALESCE((SELECT array_agg(e ->> 'name' ORDER BY ord) FROM jsonb_array_elements(v_people) WITH ORDINALITY x(e, ord)), '{}'),
                         rent = COALESCE(v_new_rent, rent)
       WHERE id = v_t.id;
      IF v_prop.id IS NOT NULL THEN
        UPDATE properties SET
          tenant_2_email = COALESCE(v_people -> 0 ->> 'email', ''), tenant_2_phone = COALESCE(v_people -> 0 ->> 'phone', ''),
          tenant_3_email = COALESCE(v_people -> 1 ->> 'email', ''), tenant_3_phone = COALESCE(v_people -> 1 ->> 'phone', ''),
          tenant_4_email = COALESCE(v_people -> 2 ->> 'email', ''), tenant_4_phone = COALESCE(v_people -> 2 ->> 'phone', ''),
          tenant_5_email = COALESCE(v_people -> 3 ->> 'email', ''), tenant_5_phone = COALESCE(v_people -> 3 ->> 'phone', '')
        WHERE id = v_prop.id;
      END IF;
    ELSIF v_t.id IS NOT NULL AND v_new_rent IS NOT NULL THEN
      UPDATE tenants SET rent = v_new_rent WHERE id = v_t.id;
    END IF;
  END IF;

  -- The schedule is what bills rent; autopay is what collects it. Both must
  -- move with the lease or the old amount keeps posting.
  IF v_new_rent IS NOT NULL AND v_new_rent <> v_old_rent AND v_l.tenant_id IS NOT NULL THEN
    UPDATE recurring_journal_entries SET amount = v_new_rent
     WHERE company_id = v_c.company_id AND tenant_id = v_l.tenant_id AND status IN ('active', 'paused') AND archived_at IS NULL;
    UPDATE autopay_schedules SET amount = v_new_rent
     WHERE company_id = v_c.company_id AND tenant_id = v_l.tenant_id AND enabled IS TRUE AND archived_at IS NULL;
  END IF;

  UPDATE lease_changes SET status = 'applied', applied_at = now(), applied_by = COALESCE(p_by, 'system'),
         result_lease_id = COALESCE(v_new_lease, v_l.id), updated_at = now()
   WHERE id = p_id;
  INSERT INTO audit_trail (action, module, details, record_id, user_email, user_role, company_id)
  VALUES ('update', 'leases',
          CASE v_c.kind WHEN 'renewal' THEN 'Renewal took effect: ' WHEN 'rent_increase' THEN 'Rent change took effect: ' ELSE 'Addendum took effect: ' END
            || v_l.tenant_name || ' — ' || v_l.property
            || CASE WHEN v_new_rent IS NOT NULL AND v_new_rent <> v_old_rent THEN ' (rent ' || v_old_rent || ' → ' || v_new_rent || ')' ELSE '' END,
          v_l.id::text, COALESCE(p_by, 'system'), '', v_c.company_id);
  RETURN jsonb_build_object('applied', true, 'kind', v_c.kind, 'lease_id', COALESCE(v_new_lease, v_l.id), 'rent', COALESCE(v_new_rent, v_old_rent));
END $$;
REVOKE ALL ON FUNCTION public._apply_lease_change(uuid, text) FROM PUBLIC, anon, authenticated;

-- ── apply everything that is due for a company ────────────────────────
-- Called when staff open the app (before the month's rent is posted, so a
-- change dated the 1st bills at the new amount) and by the daily job.
CREATE OR REPLACE FUNCTION public.apply_due_lease_changes(p_company_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_who text := COALESCE(NULLIF(auth.email(), ''), 'system');
  r record; v_res jsonb; v_out jsonb := '[]'::jsonb;
BEGIN
  IF COALESCE(NULLIF(auth.role(), ''), 'postgres') NOT IN ('service_role', 'postgres')
     AND NOT public.is_company_staff(p_company_id) THEN
    RAISE EXCEPTION 'You do not have access to this company.' USING ERRCODE = '42501';
  END IF;
  FOR r IN SELECT id FROM lease_changes
            WHERE company_id = p_company_id AND status = 'scheduled' AND effective_date <= v_today
            ORDER BY effective_date, created_at LOOP
    BEGIN
      v_res := public._apply_lease_change(r.id, v_who);
    EXCEPTION WHEN others THEN
      -- One bad row must not hold up the rest; it stays scheduled and says why.
      v_res := jsonb_build_object('error', SQLERRM);
      UPDATE lease_changes SET note = left('Could not be applied: ' || SQLERRM, 500), updated_at = now() WHERE id = r.id;
    END;
    v_out := v_out || jsonb_build_array(v_res || jsonb_build_object('id', r.id));
  END LOOP;
  RETURN jsonb_build_object('today', v_today, 'results', v_out);
END $$;
REVOKE ALL ON FUNCTION public.apply_due_lease_changes(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_due_lease_changes(text) TO authenticated, service_role;

-- ── the document drives the status ────────────────────────────────────
CREATE OR REPLACE FUNCTION public._lease_change_follow_envelope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id uuid; v_today date := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  IF NEW.envelope_status IS NOT DISTINCT FROM OLD.envelope_status THEN RETURN NEW; END IF;
  IF NEW.envelope_status = 'completed' THEN
    UPDATE lease_changes SET status = 'scheduled', updated_at = now()
     WHERE doc_id = NEW.id AND status = 'awaiting_signature' RETURNING id INTO v_id;
    -- Signed on or after its effective date: it takes effect now.
    IF v_id IS NOT NULL AND (SELECT effective_date FROM lease_changes WHERE id = v_id) <= v_today THEN
      PERFORM public._apply_lease_change(v_id, 'system');
    END IF;
  ELSIF NEW.envelope_status IN ('voided', 'declined') THEN
    UPDATE lease_changes SET status = 'cancelled', cancelled_at = now(), cancelled_by = COALESCE(NEW.voided_by, 'system'),
           cancel_reason = CASE WHEN NEW.envelope_status = 'declined' THEN 'A signer declined' ELSE COALESCE(NULLIF(NEW.void_reason, ''), 'The signature request was cancelled') END,
           updated_at = now()
     WHERE doc_id = NEW.id AND status IN ('awaiting_signature', 'scheduled');
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._lease_change_follow_envelope() FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE TRIGGER doc_generated_lease_change_follow
  AFTER UPDATE OF envelope_status ON public.doc_generated
  FOR EACH ROW EXECUTE FUNCTION public._lease_change_follow_envelope();

NOTIFY pgrst, 'reload schema';
