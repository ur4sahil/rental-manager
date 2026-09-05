-- property_tax_bills had INSERT, SELECT and UPDATE policies but no
-- DELETE policy. Under RLS a DELETE with no matching policy is not an
-- error -- it filters to zero rows and returns success. So the app's
-- delete button has always been a silent no-op: the row stays, the UI
-- reports success, and nothing in the product can ever remove a tax
-- bill. Found by the tax-bill form spec, whose cleanup left 88 rows
-- behind before it noticed.
--
-- Scoped to admin/manager, matching the property delete policy added
-- earlier today: a tax bill is a financial record, so removing one is
-- not an office-assistant action.
CREATE POLICY property_tax_bills_delete ON public.property_tax_bills
  FOR DELETE USING (public.is_company_admin_or_manager(company_id));
