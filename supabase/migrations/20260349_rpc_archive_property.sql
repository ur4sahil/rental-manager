CREATE OR REPLACE FUNCTION archive_property(p_property_id bigint, p_company_id text, p_archived_by text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE properties SET archived_at = now(), archived_by = p_archived_by WHERE id = p_property_id AND company_id = p_company_id;
END;
$$
