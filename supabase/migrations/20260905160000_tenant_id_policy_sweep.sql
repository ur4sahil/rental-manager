-- Finish converting tenant-facing RLS from name matching to id matching.
--
-- The previous migration did documents and payments. The portals E2E
-- then failed on "a same-name tenant's documents and work orders are
-- readable" with a count of 1 -- documents were fixed, work_orders was
-- not. Grepping pg_policies for get_tenant_name turned up seven more
-- policies with the identical defect, so this does the whole set rather
-- than the one the test happened to catch.
--
-- Why it matters: 5 same-name tenant groups exist in production. Every
-- policy below let one of those tenants read the other's rows.

-- ---------------------------------------------------------------
-- 1. work_orders and doc_generated need the column first
-- ---------------------------------------------------------------
ALTER TABLE public.work_orders  ADD COLUMN IF NOT EXISTS tenant_id bigint;
ALTER TABLE public.doc_generated ADD COLUMN IF NOT EXISTS tenant_id bigint;

UPDATE public.work_orders w
   SET tenant_id = t.id
  FROM tenants t
 WHERE w.tenant_id IS NULL
   AND coalesce(btrim(w.tenant),'') <> ''
   AND t.company_id = w.company_id
   AND lower(t.name) = lower(btrim(w.tenant))
   AND t.archived_at IS NULL
   AND (SELECT count(*) FROM tenants t2
         WHERE t2.company_id = w.company_id
           AND lower(t2.name) = lower(btrim(w.tenant))
           AND t2.archived_at IS NULL) = 1;

UPDATE public.doc_generated d
   SET tenant_id = t.id
  FROM tenants t
 WHERE d.tenant_id IS NULL
   AND coalesce(btrim(d.tenant_name),'') <> ''
   AND t.company_id = d.company_id
   AND lower(t.name) = lower(btrim(d.tenant_name))
   AND t.archived_at IS NULL
   AND (SELECT count(*) FROM tenants t2
         WHERE t2.company_id = d.company_id
           AND lower(t2.name) = lower(btrim(d.tenant_name))
           AND t2.archived_at IS NULL) = 1;

CREATE INDEX IF NOT EXISTS idx_work_orders_tenant_id
  ON public.work_orders (company_id, tenant_id) WHERE tenant_id IS NOT NULL;

-- Keep new rows populated. work_orders carries the name in `tenant`, so
-- it can reuse the shared trigger; doc_generated calls its column
-- tenant_name and needs its own.
DROP TRIGGER IF EXISTS work_orders_derive_tenant_id ON public.work_orders;
CREATE TRIGGER work_orders_derive_tenant_id
  BEFORE INSERT OR UPDATE OF tenant ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.derive_tenant_id_from_name();

CREATE OR REPLACE FUNCTION public.derive_tenant_id_from_tenant_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_count int;
BEGIN
  IF NEW.tenant_id IS NOT NULL OR coalesce(btrim(NEW.tenant_name),'') = '' THEN
    RETURN NEW;
  END IF;
  SELECT count(*), min(t.id) INTO v_count, NEW.tenant_id
    FROM tenants t
   WHERE t.company_id = NEW.company_id
     AND lower(t.name) = lower(btrim(NEW.tenant_name))
     AND t.archived_at IS NULL;
  IF v_count <> 1 THEN NEW.tenant_id := NULL; END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS doc_generated_derive_tenant_id ON public.doc_generated;
CREATE TRIGGER doc_generated_derive_tenant_id
  BEFORE INSERT OR UPDATE OF tenant_name ON public.doc_generated
  FOR EACH ROW EXECUTE FUNCTION public.derive_tenant_id_from_tenant_name();

DROP TRIGGER IF EXISTS leases_derive_tenant_id ON public.leases;
CREATE TRIGGER leases_derive_tenant_id
  BEFORE INSERT OR UPDATE OF tenant_name ON public.leases
  FOR EACH ROW EXECUTE FUNCTION public.derive_tenant_id_from_tenant_name();

UPDATE public.leases l
   SET tenant_id = t.id
  FROM tenants t
 WHERE l.tenant_id IS NULL
   AND coalesce(btrim(l.tenant_name),'') <> ''
   AND t.company_id = l.company_id
   AND lower(t.name) = lower(btrim(l.tenant_name))
   AND t.archived_at IS NULL
   AND (SELECT count(*) FROM tenants t2
         WHERE t2.company_id = l.company_id
           AND lower(t2.name) = lower(btrim(l.tenant_name))
           AND t2.archived_at IS NULL) = 1;

-- ---------------------------------------------------------------
-- 2. Re-key every remaining tenant policy onto the id
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS work_orders_tenant_read ON public.work_orders;
CREATE POLICY work_orders_tenant_read ON public.work_orders
  FOR SELECT USING (tenant_id IS NOT NULL AND tenant_id = public.get_tenant_id(company_id));

DROP POLICY IF EXISTS messages_tenant_read ON public.messages;
CREATE POLICY messages_tenant_read ON public.messages
  FOR SELECT USING (tenant_id IS NOT NULL AND tenant_id = public.get_tenant_id(company_id));

DROP POLICY IF EXISTS autopay_tenant ON public.autopay_schedules;
CREATE POLICY autopay_tenant ON public.autopay_schedules
  FOR SELECT USING (tenant_id IS NOT NULL AND tenant_id = public.get_tenant_id(company_id));

DROP POLICY IF EXISTS autopay_tenant_update ON public.autopay_schedules;
CREATE POLICY autopay_tenant_update ON public.autopay_schedules
  FOR UPDATE
  USING      (tenant_id IS NOT NULL AND tenant_id = public.get_tenant_id(company_id))
  WITH CHECK (tenant_id IS NOT NULL AND tenant_id = public.get_tenant_id(company_id));

DROP POLICY IF EXISTS leases_tenant ON public.leases;
CREATE POLICY leases_tenant ON public.leases
  FOR SELECT USING (tenant_id IS NOT NULL AND tenant_id = public.get_tenant_id(company_id));

DROP POLICY IF EXISTS doc_generated_tenant ON public.doc_generated;
CREATE POLICY doc_generated_tenant ON public.doc_generated
  FOR SELECT USING (tenant_id IS NOT NULL AND tenant_id = public.get_tenant_id(company_id));

-- work_order_photos reaches the tenant through its work order, so it
-- inherits the corrected key rather than matching a name of its own.
DROP POLICY IF EXISTS wo_photos_tenant ON public.work_order_photos;
CREATE POLICY wo_photos_tenant ON public.work_order_photos
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM work_orders wo
       WHERE wo.id::text = work_order_photos.work_order_id::text
         AND wo.tenant_id IS NOT NULL
         AND wo.tenant_id = public.get_tenant_id(wo.company_id)
    )
  );

-- properties: a tenant sees the property they actually live in, matched
-- by their tenant row rather than by a name comparison.
DROP POLICY IF EXISTS properties_tenant ON public.properties;
CREATE POLICY properties_tenant ON public.properties
  FOR SELECT USING (
    address IN (
      SELECT t.property FROM tenants t
       WHERE t.id = public.get_tenant_id(properties.company_id)
         AND t.company_id = properties.company_id
         AND t.archived_at IS NULL
    )
  );

-- ---------------------------------------------------------------
-- 3. A tenant should see only their OWN membership row
-- ---------------------------------------------------------------
-- The earlier fix stopped tenants reading each other but still let them
-- read every STAFF row, because TenantPortal needs somewhere to address
-- an outbound message. As the portal E2E puts it: that is an argument
-- for a staff-only view, not for handing a tenant the whole roster.
--
-- So the fan-out moves server-side and the policy closes completely.
CREATE OR REPLACE FUNCTION public.notify_company_staff(
  p_company_id text, p_type text, p_data jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_rows integer;
BEGIN
  -- Caller must belong to the company they are notifying. Without this
  -- the SECURITY DEFINER context would let anyone queue mail to any
  -- company's staff.
  IF NOT public.is_member_of_company(p_company_id) THEN
    RAISE EXCEPTION 'Not a member of %', p_company_id;
  END IF;

  INSERT INTO notification_queue (company_id, type, recipient_email, data, status, cc, bcc)
  SELECT p_company_id, p_type, lower(cm.user_email), p_data::text, 'pending', '{}', '{}'
    FROM company_members cm
   WHERE cm.company_id = p_company_id
     AND cm.status = 'active'
     AND cm.role NOT IN ('tenant', 'owner')
     AND coalesce(btrim(cm.user_email),'') <> '';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.notify_company_staff(text, text, jsonb) TO authenticated;

DROP POLICY IF EXISTS cm_read ON public.company_members;
CREATE POLICY cm_read ON public.company_members
  FOR SELECT USING (
    lower(user_email) = lower(auth.jwt() ->> 'email')
    OR public.is_company_staff(company_id)
  );

-- ---------------------------------------------------------------
-- 4. The INSERT side was still name-keyed too
-- ---------------------------------------------------------------
-- Four tenant INSERT policies checked get_tenant_name() in WITH CHECK,
-- so a tenant could file a work order, message, payment or autopay row
-- attributed to a namesake tenant. Now keyed on the id, which the
-- derive triggers populate.
DROP POLICY IF EXISTS work_orders_tenant_insert ON public.work_orders;
CREATE POLICY work_orders_tenant_insert ON public.work_orders
  FOR INSERT WITH CHECK (tenant_id = public.get_tenant_id(company_id));

DROP POLICY IF EXISTS messages_tenant_write ON public.messages;
CREATE POLICY messages_tenant_write ON public.messages
  FOR INSERT WITH CHECK (tenant_id = public.get_tenant_id(company_id));

DROP POLICY IF EXISTS payments_tenant_insert ON public.payments;
CREATE POLICY payments_tenant_insert ON public.payments
  FOR INSERT WITH CHECK (tenant_id = public.get_tenant_id(company_id));

DROP POLICY IF EXISTS autopay_tenant_write ON public.autopay_schedules;
CREATE POLICY autopay_tenant_write ON public.autopay_schedules
  FOR INSERT WITH CHECK (tenant_id = public.get_tenant_id(company_id));

-- ---------------------------------------------------------------
-- 5. Disambiguate namesakes by property before giving up
-- ---------------------------------------------------------------
-- Name-only matching resolved to NULL whenever two active tenants share
-- a name -- which is exactly the 5 same-name groups in production, and
-- the portals E2E fixture. Fail-closed is right, but it made those
-- tenants' documents invisible to THEMSELVES, not just to each other.
--
-- Same-name tenants virtually always live at different properties, and
-- documents / payments / work_orders all carry the property. So: try
-- (name, property) first, fall back to name alone, and only then give
-- up. Still fail-closed -- a genuinely ambiguous row resolves to NULL.
CREATE OR REPLACE FUNCTION public.derive_tenant_id_from_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_count int; v_id bigint;
BEGIN
  IF NEW.tenant_id IS NOT NULL OR coalesce(btrim(NEW.tenant),'') = '' THEN
    RETURN NEW;
  END IF;

  -- name + property
  SELECT count(*), min(t.id) INTO v_count, v_id
    FROM tenants t
   WHERE t.company_id = NEW.company_id
     AND lower(t.name) = lower(btrim(NEW.tenant))
     AND t.archived_at IS NULL
     AND coalesce(lower(btrim(t.property)),'') = coalesce(lower(btrim(NEW.property)),'');
  IF v_count = 1 THEN NEW.tenant_id := v_id; RETURN NEW; END IF;

  -- name alone
  SELECT count(*), min(t.id) INTO v_count, v_id
    FROM tenants t
   WHERE t.company_id = NEW.company_id
     AND lower(t.name) = lower(btrim(NEW.tenant))
     AND t.archived_at IS NULL;
  NEW.tenant_id := CASE WHEN v_count = 1 THEN v_id ELSE NULL END;
  RETURN NEW;
END;
$function$;

-- Re-run the backfills now that namesakes can be resolved by property.
UPDATE public.documents d SET tenant_id = t.id
  FROM tenants t
 WHERE d.tenant_id IS NULL AND coalesce(btrim(d.tenant),'') <> ''
   AND t.company_id = d.company_id AND lower(t.name) = lower(btrim(d.tenant))
   AND t.archived_at IS NULL
   AND coalesce(lower(btrim(t.property)),'') = coalesce(lower(btrim(d.property)),'')
   AND (SELECT count(*) FROM tenants t2
         WHERE t2.company_id = d.company_id AND lower(t2.name) = lower(btrim(d.tenant))
           AND t2.archived_at IS NULL
           AND coalesce(lower(btrim(t2.property)),'') = coalesce(lower(btrim(d.property)),'')) = 1;

UPDATE public.payments p SET tenant_id = t.id
  FROM tenants t
 WHERE p.tenant_id IS NULL AND coalesce(btrim(p.tenant),'') <> ''
   AND t.company_id = p.company_id AND lower(t.name) = lower(btrim(p.tenant))
   AND t.archived_at IS NULL
   AND coalesce(lower(btrim(t.property)),'') = coalesce(lower(btrim(p.property)),'')
   AND (SELECT count(*) FROM tenants t2
         WHERE t2.company_id = p.company_id AND lower(t2.name) = lower(btrim(p.tenant))
           AND t2.archived_at IS NULL
           AND coalesce(lower(btrim(t2.property)),'') = coalesce(lower(btrim(p.property)),'')) = 1;

UPDATE public.work_orders w SET tenant_id = t.id
  FROM tenants t
 WHERE w.tenant_id IS NULL AND coalesce(btrim(w.tenant),'') <> ''
   AND t.company_id = w.company_id AND lower(t.name) = lower(btrim(w.tenant))
   AND t.archived_at IS NULL
   AND coalesce(lower(btrim(t.property)),'') = coalesce(lower(btrim(w.property)),'')
   AND (SELECT count(*) FROM tenants t2
         WHERE t2.company_id = w.company_id AND lower(t2.name) = lower(btrim(w.tenant))
           AND t2.archived_at IS NULL
           AND coalesce(lower(btrim(t2.property)),'') = coalesce(lower(btrim(w.property)),'')) = 1;
