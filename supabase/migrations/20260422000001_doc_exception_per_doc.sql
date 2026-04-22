-- Per-document exceptions. Previously a single doc_exception_requests
-- row waived ALL required-doc checks for the tenant at once (the
-- reviewer could only say "skip everything" or "no"), which is too
-- blunt — a tenant might legitimately need a waiver on Renters
-- Insurance while Lease + ID are still required.
--
-- `doc_type` names the specific REQUIRED_TENANT_DOCS entry this
-- exception covers ("Signed Lease Agreement", "Government-Issued ID",
-- "Renters Insurance", "Proof of Utility Transfer"). NULL remains
-- valid for legacy rows and for the blanket-waiver flow where an
-- admin approves every missing doc in one click.
--
-- `approved_doc_types` on `tenants` tracks which specific docs have
-- been individually waived so the tenant-detail UI can show ✓ next
-- to each waived item instead of lying about the doc being uploaded.
-- jsonb array of strings; empty array means no individual waivers.

ALTER TABLE doc_exception_requests
  ADD COLUMN IF NOT EXISTS doc_type TEXT;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS approved_doc_exceptions JSONB DEFAULT '[]'::jsonb;

-- Routing index: reviewers want "pending requests I own for tenant X".
CREATE INDEX IF NOT EXISTS idx_der_tenant_doctype
  ON doc_exception_requests(company_id, tenant_name, doc_type, status);
