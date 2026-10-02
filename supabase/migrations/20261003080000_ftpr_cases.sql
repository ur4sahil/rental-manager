-- Failure to pay rent (Phase 4 of docs/PLAN-tenant-documents.md).
--
-- A court case used to be a tenant's name, an address and a row of stage
-- buttons: no case number, no court, no amounts, and nothing tying the
-- notice that was served or the complaint that was filed to the case.
--
-- This adds those facts to eviction_cases. Additive only; existing cases
-- are untouched. The amounts are a SNAPSHOT of what was claimed on the day
-- the notice or the worksheet was made (claim_detail keeps the open charges
-- behind them), because that is what was served on the tenant and must not
-- drift when the ledger moves afterwards.

ALTER TABLE public.eviction_cases
  ADD COLUMN IF NOT EXISTS case_number text,
  ADD COLUMN IF NOT EXISTS court text,
  ADD COLUMN IF NOT EXISTS lease_id uuid,
  ADD COLUMN IF NOT EXISTS property_id integer,
  ADD COLUMN IF NOT EXISTS claim_rent numeric(12,2),
  ADD COLUMN IF NOT EXISTS claim_late_fees numeric(12,2),
  ADD COLUMN IF NOT EXISTS claim_total numeric(12,2),
  ADD COLUMN IF NOT EXISTS claim_detail jsonb,
  ADD COLUMN IF NOT EXISTS notice_served_on date,
  ADD COLUMN IF NOT EXISTS notice_served_method text,
  ADD COLUMN IF NOT EXISTS notice_doc_id uuid,
  ADD COLUMN IF NOT EXISTS complaint_doc_id uuid,
  ADD COLUMN IF NOT EXISTS writ_date date,
  ADD COLUMN IF NOT EXISTS cured_on date;

-- Real links, so a case cannot point at a lease, property or document that
-- is not there. A removed target leaves the case standing with the link
-- cleared.
DO $fk$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eviction_cases_lease_id_fkey') THEN
    ALTER TABLE public.eviction_cases ADD CONSTRAINT eviction_cases_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eviction_cases_property_id_fkey') THEN
    ALTER TABLE public.eviction_cases ADD CONSTRAINT eviction_cases_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eviction_cases_notice_doc_id_fkey') THEN
    ALTER TABLE public.eviction_cases ADD CONSTRAINT eviction_cases_notice_doc_id_fkey FOREIGN KEY (notice_doc_id) REFERENCES public.doc_generated(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eviction_cases_complaint_doc_id_fkey') THEN
    ALTER TABLE public.eviction_cases ADD CONSTRAINT eviction_cases_complaint_doc_id_fkey FOREIGN KEY (complaint_doc_id) REFERENCES public.doc_generated(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eviction_cases_notice_method_check') THEN
    ALTER TABLE public.eviction_cases ADD CONSTRAINT eviction_cases_notice_method_check
      CHECK (notice_served_method IS NULL OR notice_served_method IN ('mail', 'posted', 'email', 'text', 'portal'));
  END IF;
END $fk$;

CREATE INDEX IF NOT EXISTS idx_eviction_cases_tenant_active ON public.eviction_cases (company_id, tenant_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_doc_generated_eviction_case ON public.doc_generated (eviction_case_id) WHERE eviction_case_id IS NOT NULL;

-- The clock learns one more thing to say: the ten days are up.
CREATE OR REPLACE FUNCTION public.lease_clock_items(p_company_id text)
RETURNS TABLE(item_key text, kind text, severity text, title text, detail text, due_date date,
              tenant_id bigint, lease_id uuid, prospect_id uuid, doc_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
#variable_conflict use_column
DECLARE
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_dep_days integer;
  v_month text := to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYYMM');
BEGIN
  IF COALESCE(NULLIF(auth.role(), ''), 'postgres') NOT IN ('service_role', 'postgres')
     AND NOT public.is_company_staff(p_company_id) THEN
    RAISE EXCEPTION 'You do not have access to this company.' USING ERRCODE = '42501';
  END IF;
  SELECT cs.deposit_return_days INTO v_dep_days FROM company_settings cs WHERE cs.company_id = p_company_id;
  v_dep_days := COALESCE(v_dep_days, 30);

  RETURN QUERY
  WITH items AS (
    -- A lease reaching its end with no renewal in flight. The key carries the
    -- 90/60/30 band, so one dismissed at 90 days comes back at 60 and at 30.
    SELECT 'renewal:' || l.id::text || ':' || CASE WHEN l.end_date - v_today <= 30 THEN '30' WHEN l.end_date - v_today <= 60 THEN '60' ELSE '90' END AS item_key,
           'renewal_due'::text AS kind,
           CASE WHEN l.end_date - v_today <= 30 THEN 'high' ELSE 'normal' END AS severity,
           l.tenant_name || ': lease ends ' || to_char(l.end_date, 'Mon FMDD, YYYY') AS title,
           'In ' || (l.end_date - v_today) || ' days. Offer a renewal, or it carries on month to month.' AS detail,
           l.end_date AS due_date, l.tenant_id::bigint AS tenant_id, l.id AS lease_id, NULL::uuid AS prospect_id, NULL::uuid AS doc_id
      FROM leases l JOIN tenants t ON t.id = l.tenant_id
     WHERE l.company_id = p_company_id AND l.status = 'active' AND l.archived_at IS NULL
       AND l.end_date BETWEEN v_today AND v_today + 90
       AND t.archived_at IS NULL AND t.lease_status = 'active'
       AND NOT EXISTS (SELECT 1 FROM lease_changes c WHERE c.lease_id = l.id AND c.kind = 'renewal' AND c.status IN ('awaiting_signature', 'scheduled'))

    UNION ALL
    -- A document still out for signature: after three days, or sooner when a
    -- signer's link is about to stop working or already has (nobody can sign
    -- until a reminder renews it). One line per document. The key changes
    -- when a link is about to expire, so the morning email mentions it again.
    SELECT 'unsigned:' || d.id::text || CASE WHEN w.soonest < now() + interval '5 days' THEN ':expiring' ELSE '' END, 'unsigned_doc',
           CASE WHEN d.envelope_sent_at < now() - interval '7 days' OR w.expired > 0 OR w.soonest < now() + interval '5 days' THEN 'high' ELSE 'normal' END,
           d.name,
           'Out for signature for ' || GREATEST(1, (v_today - (d.envelope_sent_at AT TIME ZONE 'America/New_York')::date)) || ' days. Waiting for: '
             || COALESCE(w.names, 'nobody') || '.'
             || CASE WHEN w.expired > 0 THEN ' A signing link has stopped working: send a reminder to renew it.'
                     WHEN w.soonest < now() + interval '5 days' THEN ' A signing link stops working on ' || to_char(w.soonest AT TIME ZONE 'America/New_York', 'Mon FMDD') || ': send a reminder to renew it.'
                     ELSE '' END,
           CASE WHEN w.soonest < now() + interval '5 days' THEN (w.soonest AT TIME ZONE 'America/New_York')::date END,
           d.tenant_id, d.lease_id, d.prospect_id, d.id
      FROM doc_generated d
      LEFT JOIN LATERAL (
        SELECT string_agg(COALESCE(NULLIF(s.signer_name, ''), s.signer_email), ', ' ORDER BY s.sign_order, s.created_at) AS names,
               count(*) FILTER (WHERE s.status IN ('sent', 'viewed') AND s.token_expires_at IS NOT NULL AND s.token_expires_at <= now()) AS expired,
               min(s.token_expires_at) FILTER (WHERE s.status IN ('sent', 'viewed') AND s.token_expires_at > now()) AS soonest
          FROM doc_signatures s WHERE s.doc_id = d.id AND s.status IN ('pending', 'sent', 'viewed')
      ) w ON true
     WHERE d.company_id = p_company_id AND d.archived_at IS NULL AND d.envelope_status = 'out_for_signature'
       AND (d.envelope_sent_at < now() - interval '3 days' OR w.expired > 0 OR w.soonest < now() + interval '5 days')

    UNION ALL
    -- A prospect whose lease start has arrived and who is not a tenant yet.
    SELECT 'prospect_start:' || p.id::text, 'prospect_not_converted', 'high',
           p.name || ': lease start ' || to_char(p.lease_start, 'Mon FMDD, YYYY'),
           CASE WHEN p.status = 'signed' THEN 'The lease is signed and they have not been converted to a tenant.'
                ELSE 'The lease start date has arrived and the lease is not signed.' END,
           p.lease_start, NULL::bigint, NULL::uuid, p.id, NULL::uuid
      FROM prospects p
     WHERE p.company_id = p_company_id AND p.archived_at IS NULL AND p.status IN ('new', 'lease_sent', 'signed')
       AND p.lease_start IS NOT NULL AND p.lease_start <= v_today

    UNION ALL
    -- A tenancy that ended with a deposit and no statement made.
    SELECT 'deposit:' || l.id::text, 'deposit_statement_due',
           CASE WHEN t.move_out + v_dep_days < v_today THEN 'overdue' WHEN t.move_out + v_dep_days <= v_today + 7 THEN 'high' ELSE 'normal' END,
           l.tenant_name || ': security deposit statement',
           'The tenancy ended ' || to_char(t.move_out, 'Mon FMDD, YYYY') || '. The itemised statement is due by ' || to_char(t.move_out + v_dep_days, 'Mon FMDD, YYYY') || '.',
           t.move_out + v_dep_days, t.id::bigint, l.id, NULL::uuid, NULL::uuid
      FROM leases l JOIN tenants t ON t.id = l.tenant_id
     WHERE l.company_id = p_company_id AND l.status = 'terminated' AND COALESCE(l.security_deposit, 0) > 0
       AND t.move_out IS NOT NULL AND t.move_out <= v_today AND t.move_out >= v_today - 120
       AND COALESCE(t.lease_status, '') NOT IN ('active', 'notice')
       AND NOT EXISTS (SELECT 1 FROM doc_generated d WHERE d.company_id = p_company_id AND d.tenant_id = t.id
                         AND d.doc_kind = 'deposit_disposition' AND d.archived_at IS NULL AND COALESCE(d.status, '') <> 'draft')

    UNION ALL
    -- A tenant on notice whose move-out is near, or past and not run.
    SELECT 'moveout:' || t.id::text, 'move_out_due',
           CASE WHEN t.move_out < v_today THEN 'overdue' ELSE 'high' END,
           t.name || ': moving out ' || to_char(t.move_out, 'Mon FMDD, YYYY'),
           CASE WHEN t.move_out < v_today THEN 'The move-out date has passed and the move-out has not been run.'
                WHEN t.move_out = v_today THEN 'Moving out today.'
                ELSE 'In ' || (t.move_out - v_today) || ' days.' END,
           t.move_out, t.id::bigint, NULL::uuid, NULL::uuid, NULL::uuid
      FROM tenants t
     WHERE t.company_id = p_company_id AND t.archived_at IS NULL AND t.lease_status = 'notice'
       AND t.move_out IS NOT NULL AND t.move_out <= v_today + 7

    UNION ALL
    -- A lease change whose day came and which could not be applied.
    SELECT 'change_failed:' || c.id::text, 'lease_change_failed', 'overdue',
           'A lease change could not take effect', COALESCE(c.note, ''),
           c.effective_date, c.tenant_id, c.lease_id, NULL::uuid, c.doc_id
      FROM lease_changes c
     WHERE c.company_id = p_company_id AND c.status = 'scheduled' AND c.effective_date <= v_today AND c.note LIKE 'Could not be applied%'

    UNION ALL
    -- Failure to pay rent: the ten days after the Notice of Intent are up.
    -- Whether rent is still owed is for the person to check on the case.
    SELECT 'ftpr_deadline:' || e.id::text, 'ftpr_deadline', 'high',
           e.tenant_name || ': the 10 days are up',
           'The Notice of Intent was provided ' || to_char(e.notice_served_on, 'Mon FMDD, YYYY') || '. If the rent is still unpaid, the complaint can be prepared; if it was paid, close the case as paid.',
           e.cure_deadline, e.tenant_id, e.lease_id, NULL::uuid, e.notice_doc_id
      FROM eviction_cases e
     WHERE e.company_id = p_company_id AND e.status = 'active' AND e.reason = 'non_payment'
       AND e.current_stage IN ('notice', 'cure_period') AND e.notice_served_on IS NOT NULL
       AND e.cure_deadline IS NOT NULL AND e.cure_deadline < v_today

    UNION ALL
    -- A late fee charged this month with no late notice made.
    SELECT 'late_notice:' || t.id::text || ':' || v_month, 'late_notice_due', 'normal',
           t.name || ': late fee charged, no notice sent',
           'A late fee was posted this month. Send a late rent notice from their page.',
           NULL::date, t.id::bigint, NULL::uuid, NULL::uuid, NULL::uuid
      FROM tenants t
     WHERE t.company_id = p_company_id AND t.archived_at IS NULL
       AND EXISTS (SELECT 1 FROM acct_journal_entries je WHERE je.company_id = p_company_id AND je.reference = 'LATEFEE-' || t.id::text || '-' || v_month AND je.status = 'posted')
       AND NOT EXISTS (SELECT 1 FROM doc_generated d WHERE d.company_id = p_company_id AND d.tenant_id = t.id AND d.doc_kind = 'late_notice' AND d.archived_at IS NULL
                         AND to_char((d.created_at AT TIME ZONE 'America/New_York')::date, 'YYYYMM') = v_month)
  )
  SELECT i.item_key, i.kind, i.severity, i.title, i.detail, i.due_date, i.tenant_id, i.lease_id, i.prospect_id, i.doc_id
    FROM items i
   WHERE NOT EXISTS (SELECT 1 FROM lease_clock_dismissed x WHERE x.company_id = p_company_id AND x.item_key = i.item_key)
   ORDER BY CASE i.severity WHEN 'overdue' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, i.due_date NULLS LAST, i.title;
END $$;
REVOKE ALL ON FUNCTION public.lease_clock_items(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lease_clock_items(text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
