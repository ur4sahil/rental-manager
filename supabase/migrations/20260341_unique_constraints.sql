-- Clean up existing duplicates before adding constraints
-- For properties: archive older duplicates (keep one per address per company)
WITH ranked AS (
  SELECT id, company_id, address,
    ROW_NUMBER() OVER (PARTITION BY company_id, address ORDER BY id DESC) AS rn
  FROM properties
  WHERE archived_at IS NULL
)
UPDATE properties SET archived_at = NOW(), archived_by = 'system-dedup'
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- For tenants: archive older duplicates (keep one per name+property per company)
WITH ranked AS (
  SELECT id, company_id, name, property,
    ROW_NUMBER() OVER (PARTITION BY company_id, name, property ORDER BY id DESC) AS rn
  FROM tenants
  WHERE archived_at IS NULL
)
UPDATE tenants SET archived_at = NOW(), archived_by = 'system-dedup'
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Now add unique constraints (partial — only non-archived)
CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_unique_address
ON properties (company_id, address)
WHERE archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_unique_name_property
ON tenants (company_id, name, property)
WHERE archived_at IS NULL;
