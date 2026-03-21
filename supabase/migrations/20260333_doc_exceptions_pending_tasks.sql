-- Document exception requests (similar pattern to property_change_requests)
CREATE TABLE IF NOT EXISTS doc_exception_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  tenant_name TEXT NOT NULL,
  property TEXT,
  requested_by TEXT NOT NULL,
  reason TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', -- pending | approved | rejected
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_doc_exc_company ON doc_exception_requests(company_id, status);

-- Add doc_status to tenants: 'complete' | 'pending_docs' | 'exception_approved'
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS doc_status TEXT DEFAULT 'pending_docs';

-- Enable RLS
ALTER TABLE doc_exception_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "doc_exc_staff" ON doc_exception_requests FOR ALL USING (is_company_staff(company_id));
