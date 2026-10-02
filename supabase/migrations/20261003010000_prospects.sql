-- Prospective tenants.
--
-- Adding a tenant makes them active at once: the property turns occupied,
-- the deposit is charged and the rent schedule starts. That is right for a
-- tenant onboarded outside the app, and wrong for someone who has not
-- signed a lease yet. A prospect is a person the books know nothing about:
-- they can be sent a lease, and only become a tenant when staff convert
-- them (src/utils/tenantOnboarding.js), which is the first moment anything
-- is posted.
--
-- Several prospects may be sent a lease for the same property. The first
-- lease to be fully signed wins: the others are cancelled by the database,
-- in the same transaction as the winning signature, so two signed leases
-- for one unit cannot both stand.

CREATE TABLE IF NOT EXISTS public.prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  name text NOT NULL,
  first_name text,
  last_name text,
  email text,
  phone text,
  -- Other adults who will be on the lease: [{ "name", "email", "phone" }]
  co_applicants jsonb NOT NULL DEFAULT '[]'::jsonb,
  property_id integer REFERENCES public.properties(id) ON DELETE SET NULL,
  property text,                       -- the address, for display
  lease_start date,
  lease_end date,
  rent numeric(12,2),
  security_deposit numeric(12,2),
  landlord_utilities text,
  tenant_utilities text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','lease_sent','signed','converted','lost')),
  notes text,
  lost_reason text,
  -- Something staff should know that happened without them: e.g. "lease
  -- cancelled: the property was leased to someone else".
  attention text,
  converted_tenant_id bigint REFERENCES public.tenants(id) ON DELETE SET NULL,
  converted_lease_id uuid REFERENCES public.leases(id) ON DELETE SET NULL,
  converted_at timestamptz,
  converted_by text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  archived_by text
);
CREATE INDEX IF NOT EXISTS idx_prospects_company ON public.prospects (company_id, status) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_prospects_property ON public.prospects (company_id, property_id) WHERE archived_at IS NULL;

ALTER TABLE public.prospects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS prospects_staff ON public.prospects;
CREATE POLICY prospects_staff ON public.prospects
  FOR ALL TO authenticated
  USING (public.is_company_staff(company_id))
  WITH CHECK (public.is_company_staff(company_id));
REVOKE ALL ON public.prospects FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.prospects TO authenticated;
GRANT ALL ON public.prospects TO service_role;

-- A prospect's lease, and the files uploaded for them, before there is a tenant.
ALTER TABLE public.doc_generated
  ADD COLUMN IF NOT EXISTS prospect_id uuid REFERENCES public.prospects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS voided_by_doc_id uuid;
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS prospect_id uuid REFERENCES public.prospects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_doc_generated_prospect ON public.doc_generated (prospect_id) WHERE prospect_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_prospect ON public.documents (prospect_id) WHERE prospect_id IS NOT NULL;

-- A prospect's status follows their lease, and the first fully signed
-- lease for a property cancels the others.
CREATE OR REPLACE FUNCTION public._prospect_follow_envelope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_winner text;
  v_other record;
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
    IF NEW.property_id IS NOT NULL THEN
      FOR v_other IN
        SELECT d.id, d.prospect_id FROM doc_generated d
         WHERE d.company_id = NEW.company_id AND d.property_id = NEW.property_id
           AND d.id <> NEW.id AND d.prospect_id IS NOT NULL AND d.prospect_id <> NEW.prospect_id
           AND d.doc_kind = 'lease' AND d.envelope_status = 'out_for_signature'
         FOR UPDATE
      LOOP
        UPDATE doc_signatures SET status = 'voided'
         WHERE doc_id = v_other.id AND status IN ('pending','sent','viewed');
        -- The prospect is told first: the UPDATE of doc_generated below
        -- re-enters this trigger for the cancelled lease, and that branch
        -- only resets a status that is still 'lease_sent'.
        UPDATE prospects
           SET status = 'new', updated_at = now(),
               attention = 'Lease cancelled on ' || to_char(now() AT TIME ZONE 'America/New_York', 'Mon DD, YYYY')
                           || ': the property was leased to ' || COALESCE(v_winner, 'another applicant') || '. They have not been told.'
         WHERE id = v_other.prospect_id AND status = 'lease_sent';
        UPDATE doc_generated
           SET envelope_status = 'voided', voided_at = now(), voided_by = 'system',
               void_reason = 'Another lease for this property was fully signed first', voided_by_doc_id = NEW.id
         WHERE id = v_other.id;
      END LOOP;
    END IF;

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

DROP TRIGGER IF EXISTS doc_generated_prospect_follow ON public.doc_generated;
CREATE TRIGGER doc_generated_prospect_follow
  AFTER INSERT OR UPDATE OF envelope_status ON public.doc_generated
  FOR EACH ROW EXECUTE FUNCTION public._prospect_follow_envelope();

NOTIFY pgrst, 'reload schema';
