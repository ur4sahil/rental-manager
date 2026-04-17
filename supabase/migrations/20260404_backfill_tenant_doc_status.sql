-- Backfill tenants.doc_status based on actual documents uploaded.
-- Earlier code flipped doc_status to "complete" after a single upload, and the
-- wizard flow only checked 3 of 4 required docs. Both caused tenants with
-- missing docs to disappear from the Tasks/Pending list. This migration
-- recomputes the correct state using the canonical 4-doc checklist:
--   Lease, Government-Issued ID, Renters Insurance, Proof of Utility Transfer.
-- Tenants with doc_status = 'exception_approved' are preserved (admin override).

WITH tenant_doc_check AS (
  SELECT
    t.id,
    (
      EXISTS (
        SELECT 1 FROM documents d
        WHERE d.company_id = t.company_id
          AND d.tenant ILIKE t.name
          AND d.archived_at IS NULL
          AND (lower(coalesce(d.name, '')) LIKE '%lease%' OR lower(coalesce(d.type, '')) LIKE '%lease%')
      )
      AND EXISTS (
        SELECT 1 FROM documents d
        WHERE d.company_id = t.company_id
          AND d.tenant ILIKE t.name
          AND d.archived_at IS NULL
          AND (
            lower(coalesce(d.name, '')) LIKE '%id%' OR lower(coalesce(d.type, '')) LIKE '%id%'
            OR lower(coalesce(d.name, '')) LIKE '%government%' OR lower(coalesce(d.type, '')) LIKE '%government%'
          )
      )
      AND EXISTS (
        SELECT 1 FROM documents d
        WHERE d.company_id = t.company_id
          AND d.tenant ILIKE t.name
          AND d.archived_at IS NULL
          AND (lower(coalesce(d.name, '')) LIKE '%insurance%' OR lower(coalesce(d.type, '')) LIKE '%insurance%')
      )
      AND EXISTS (
        SELECT 1 FROM documents d
        WHERE d.company_id = t.company_id
          AND d.tenant ILIKE t.name
          AND d.archived_at IS NULL
          AND (lower(coalesce(d.name, '')) LIKE '%utility%' OR lower(coalesce(d.type, '')) LIKE '%utility%')
      )
    ) AS has_all
  FROM tenants t
  WHERE t.archived_at IS NULL
    AND coalesce(t.doc_status, '') <> 'exception_approved'
)
UPDATE tenants t
SET doc_status = CASE WHEN c.has_all THEN 'complete' ELSE 'pending_docs' END
FROM tenant_doc_check c
WHERE c.id = t.id
  AND t.doc_status IS DISTINCT FROM (CASE WHEN c.has_all THEN 'complete' ELSE 'pending_docs' END);
