-- Migration: Accounting integration hardening
-- Adds tenant_id to ledger_entries, class_id to properties, unique constraint on acct_classes

-- 1. Add tenant_id column to ledger_entries for reliable lookups (vs name-based)
-- Fix: drop UUID column if it was incorrectly created, re-add as BIGINT to match tenants.id
ALTER TABLE ledger_entries DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS tenant_id BIGINT;

-- Backfill tenant_id from tenant name where possible
UPDATE ledger_entries le
SET tenant_id = t.id
FROM tenants t
WHERE le.tenant_id IS NULL
  AND le.tenant = t.name
  AND le.company_id = t.company_id;

-- 2. Add class_id column to properties for reliable accounting class linkage
ALTER TABLE properties ADD COLUMN IF NOT EXISTS class_id TEXT;

-- Backfill class_id from acct_classes where property address matches class name
UPDATE properties p
SET class_id = ac.id
FROM acct_classes ac
WHERE p.class_id IS NULL
  AND ac.name = p.address
  AND ac.company_id = p.company_id;

-- 3. Add unique constraint on acct_classes (company_id, name) to prevent duplicates
-- First, remove duplicates keeping the newest one
DELETE FROM acct_classes a
USING acct_classes b
WHERE a.company_id = b.company_id
  AND a.name = b.name
  AND a.created_at < b.created_at;

-- Now add the constraint
ALTER TABLE acct_classes DROP CONSTRAINT IF EXISTS acct_classes_company_name_unique;
ALTER TABLE acct_classes ADD CONSTRAINT acct_classes_company_name_unique UNIQUE (company_id, name);
