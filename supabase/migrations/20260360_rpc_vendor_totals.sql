CREATE OR REPLACE FUNCTION increment_vendor_totals(p_vendor_id bigint, p_amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE vendors SET total_paid = COALESCE(total_paid, 0) + p_amount, jobs_completed = COALESCE(jobs_completed, 0) + 1 WHERE id = p_vendor_id;
END;
$$
