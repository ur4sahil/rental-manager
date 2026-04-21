-- Admin override for wizard-skip tasks. When a user clicks Skip on a
-- Property Setup Wizard section, the section stays pending in Tasks &
-- Approvals until (a) the wizard is completed for that step OR (b) an
-- admin explicitly marks it complete-without-data. This column holds
-- the list of step IDs the admin has approved.
--
-- Defaults to [] so existing wizard rows stay visible as "has skips"
-- in Tasks & Approvals until they're touched.
ALTER TABLE property_setup_wizard
  ADD COLUMN IF NOT EXISTS skipped_approved_steps jsonb DEFAULT '[]'::jsonb;
