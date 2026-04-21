-- Managerial layer: admin can designate specific Managers and assign
-- staff users under them. Requests that staff submits (property
-- change requests, document exceptions) snapshot the assigned
-- manager's email at creation — that's the "approver_email" column,
-- used by the approval queue to route requests to the right person
-- without re-resolving the manager on every read.
--
-- Scope decision: per-user only. No unassigned fallback; staff with
-- no manager_email route to admin. Team join requests stay admin-only
-- and don't get a manager route.

ALTER TABLE app_users       ADD COLUMN IF NOT EXISTS manager_email TEXT;
ALTER TABLE company_members ADD COLUMN IF NOT EXISTS manager_email TEXT;
ALTER TABLE property_change_requests ADD COLUMN IF NOT EXISTS approver_email TEXT;
ALTER TABLE doc_exception_requests   ADD COLUMN IF NOT EXISTS approver_email TEXT;

-- Case-insensitive email indexes mirror the pattern already used
-- elsewhere (emails are stored lowercased but some legacy rows may
-- have mixed-case values; lower() keeps the index honest).
CREATE INDEX IF NOT EXISTS idx_app_users_manager
  ON app_users(company_id, lower(manager_email));
CREATE INDEX IF NOT EXISTS idx_company_members_manager
  ON company_members(company_id, lower(manager_email));
CREATE INDEX IF NOT EXISTS idx_pcr_approver
  ON property_change_requests(company_id, lower(approver_email), status);
CREATE INDEX IF NOT EXISTS idx_der_approver
  ON doc_exception_requests(company_id, lower(approver_email), status);
