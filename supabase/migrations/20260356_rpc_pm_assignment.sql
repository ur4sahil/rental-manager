CREATE OR REPLACE FUNCTION accept_pm_assignment(p_request_id uuid, p_pm_company_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE pm_assignment_requests SET status = 'accepted', accepted_at = now() WHERE id = p_request_id;
END;
$$
