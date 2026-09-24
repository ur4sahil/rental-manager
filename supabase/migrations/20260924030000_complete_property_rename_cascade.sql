-- Complete the property-rename cascade.
--
-- Problem: renaming a property (rename_property_from_components ->
-- _cascade_property_rename) only rewrote the address on 7 tables
-- (tenants, payments, leases, work_orders, documents, utilities,
-- acct_journal_entries) plus acct_classes.name and property_setup_wizard.
-- Every OTHER table that keys on the text address was silently left behind,
-- so after a rename the property "detached" from its loan, portfolio loan,
-- insurance, taxes, recurring mortgage entry, autopay, inspections, HOA,
-- utility-module rows, vendor invoices, etc. -- and the wizard, keying on
-- the new address, would then create DUPLICATES.
--
-- Fix: cascade the rename to EVERY table carrying a text `property` column
-- (all confirmed to have company_id). Legacy/unused tables (journal_entries,
-- ledger_entries_legacy_table) are skipped; the ledger_entries VIEW follows
-- acct_journal_entries automatically. A property rename always moves to a
-- brand-new address string, so no UNIQUE(...property...) can collide.

CREATE OR REPLACE FUNCTION public._cascade_property_rename(
  p_company_id text, p_old text, p_new text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $function$
BEGIN
  IF p_old IS NULL OR p_new IS NULL OR p_old = p_new THEN RETURN; END IF;

  -- Originally cascaded (kept)
  UPDATE tenants               SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE payments              SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE leases                SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE work_orders           SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE documents             SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE utilities             SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE acct_journal_entries  SET property = p_new WHERE company_id = p_company_id AND property = p_old;

  -- NEWLY ADDED: the tables the cascade had been forgetting.
  UPDATE autopay_schedules         SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE doc_exception_requests    SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE eviction_cases            SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE hoa_payments              SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE inspections               SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE property_insurance        SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE property_loans            SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE property_taxes            SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE property_tax_bills        SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE recurring_journal_entries SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE tenant_invite_codes       SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE utility_accounts          SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE utility_audit             SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE utility_bills             SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE vendor_invoices           SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE work_order_photos         SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE portfolio_loan_properties SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE messages                  SET property = p_new WHERE company_id = p_company_id AND property = p_old;

  -- ledger_entries is a VIEW over acct_journal_entries (updated above), so it
  -- follows automatically and must not be written directly.

  -- acct_classes is renamed BY NAME so class_id refs stay attached; guarded
  -- against acct_classes_company_name_unique.
  IF NOT EXISTS (SELECT 1 FROM acct_classes
                  WHERE company_id = p_company_id AND name = p_new) THEN
    UPDATE acct_classes SET name = p_new
     WHERE company_id = p_company_id AND name = p_old;
  END IF;

  UPDATE property_setup_wizard SET property_address = p_new
   WHERE company_id = p_company_id AND property_address = p_old;
END;
$function$;
