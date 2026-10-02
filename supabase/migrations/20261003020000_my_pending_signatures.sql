-- Tenant portal: "waiting for your signature".
--
-- A signer reaches a document through the link in their email. A tenant who
-- is logged in to the portal should not have to dig that email out: the
-- portal lists what is waiting for them, with the same link.
--
-- doc_signatures is readable by staff only (the row holds the signing link),
-- so the portal asks through this function instead. It returns a row only
-- when ALL of these hold:
--   * the caller is an active member of the company (a tenant gets that
--     membership from a staff invitation, never by signing up on their own);
--   * the signature request is addressed to the caller's own login email;
--   * it is their turn (sent or opened), the document is still out for
--     signature, and the link has not expired.
-- So it hands out nothing the caller's own inbox does not already hold.
CREATE OR REPLACE FUNCTION public.my_pending_signatures(p_company_id text)
RETURNS TABLE(signature_id uuid, doc_id uuid, doc_name text, doc_kind text, access_token text, sent_at timestamptz, token_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT s.id, d.id, d.name, d.doc_kind, s.access_token, s.sent_at, s.token_expires_at
    FROM doc_signatures s
    JOIN doc_generated d ON d.id = s.doc_id
   WHERE s.company_id = p_company_id
     AND NULLIF(auth.email(), '') IS NOT NULL
     AND lower(s.signer_email) = lower(auth.email())
     AND EXISTS (SELECT 1 FROM company_members cm
                  WHERE cm.company_id = p_company_id AND cm.status = 'active'
                    AND lower(cm.user_email) = lower(auth.email()))
     AND s.status IN ('sent', 'viewed')
     AND d.envelope_status = 'out_for_signature'
     AND d.archived_at IS NULL
     AND (s.token_expires_at IS NULL OR s.token_expires_at > now())
   ORDER BY s.sent_at DESC NULLS LAST
$$;
REVOKE ALL ON FUNCTION public.my_pending_signatures(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_pending_signatures(text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
