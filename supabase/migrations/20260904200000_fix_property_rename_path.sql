-- Repair the property rename path, which is broken in three ways, and add
-- the short name that reports will display.
--
-- This is a prerequisite for bulk property import: filling in city/state/zip
-- on the 41 QuickBooks-imported properties changes their address, and the
-- accounting class is named after the address. Renaming has to work, and
-- carry the class with it, or the ledger detaches -- the same failure mode
-- as the class-orphaning bug fixed earlier today.

-- 1. sync_addr fired on UPDATE as well as INSERT, unconditionally
--    recomputing address from the component columns. Since address_line_1
--    DEFAULTS to '' (never null) the WHEN clause was always true, so any
--    UPDATE that set `address` directly had it silently reverted. Split
--    into two triggers so an UPDATE only recomputes when a component
--    column actually changed. A WHEN clause cannot reference TG_OP, hence
--    two triggers rather than one.
DROP TRIGGER IF EXISTS sync_addr     ON public.properties;
DROP TRIGGER IF EXISTS sync_addr_ins ON public.properties;
DROP TRIGGER IF EXISTS sync_addr_upd ON public.properties;

CREATE TRIGGER sync_addr_ins
  BEFORE INSERT ON public.properties
  FOR EACH ROW
  WHEN (NEW.address_line_1 IS NOT NULL)
  EXECUTE FUNCTION public.sync_property_address();

CREATE TRIGGER sync_addr_upd
  BEFORE UPDATE ON public.properties
  FOR EACH ROW
  WHEN (
    NEW.address_line_1 IS DISTINCT FROM OLD.address_line_1
    OR NEW.address_line_2 IS DISTINCT FROM OLD.address_line_2
    OR NEW.city  IS DISTINCT FROM OLD.city
    OR NEW.state IS DISTINCT FROM OLD.state
    OR NEW.zip   IS DISTINCT FROM OLD.zip
  )
  EXECUTE FUNCTION public.sync_property_address();

-- 2. The cascade itself, taking old and new EXPLICITLY. Both callers below
--    share it. Passing the old address in rather than re-reading it matters:
--    the component-based path has already changed `address` by the time the
--    cascade runs, so a function that looked it up would find old = new and
--    silently do nothing -- which is exactly what the first version of this
--    migration did.
CREATE OR REPLACE FUNCTION public._cascade_property_rename(
  p_company_id text, p_old text, p_new text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $function$
BEGIN
  IF p_old IS NULL OR p_new IS NULL OR p_old = p_new THEN RETURN; END IF;

  UPDATE tenants              SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE payments             SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE leases               SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE work_orders          SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE documents            SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE utilities            SET property = p_new WHERE company_id = p_company_id AND property = p_old;
  UPDATE acct_journal_entries SET property = p_new WHERE company_id = p_company_id AND property = p_old;

  -- ledger_entries is deliberately NOT updated: it is a VIEW over a window
  -- function and is not updatable, so writing to it threw and aborted the
  -- whole rename. It derives `property` from acct_journal_entries.property,
  -- updated above, so it follows automatically.

  -- Renamed BY NAME, so class_id references are untouched and the ledger
  -- stays attached. Guarded against acct_classes_company_name_unique.
  IF NOT EXISTS (SELECT 1 FROM acct_classes
                  WHERE company_id = p_company_id AND name = p_new) THEN
    UPDATE acct_classes SET name = p_new
     WHERE company_id = p_company_id AND name = p_old;
  END IF;

  -- Setup/pendency status is matched on this string; without it a renamed
  -- property silently loses its progress.
  UPDATE property_setup_wizard SET property_address = p_new
   WHERE company_id = p_company_id AND property_address = p_old;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rename_property_v2(
  p_company_id text, p_property_id bigint, p_new_address text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $function$
DECLARE
  v_old text; v_caller_email text; v_caller_role text;
BEGIN
  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
   WHERE company_id = p_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Unauthorized: only admins/owners can rename properties';
  END IF;

  SELECT address INTO v_old FROM properties WHERE id = p_property_id AND company_id = p_company_id;
  IF v_old IS NULL OR v_old = p_new_address THEN RETURN; END IF;

  UPDATE properties SET address = p_new_address
   WHERE id = p_property_id AND company_id = p_company_id;
  PERFORM public._cascade_property_rename(p_company_id, v_old, p_new_address);
END;
$function$;

-- 3. The import changes address COMPONENTS and lets the trigger derive the
--    new address. Capture the old value BEFORE touching anything.
CREATE OR REPLACE FUNCTION public.rename_property_from_components(
  p_company_id text, p_property_id bigint,
  p_line1 text, p_line2 text, p_city text, p_state text, p_zip text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
AS $function$
DECLARE
  v_old text; v_new text; v_caller_email text; v_caller_role text;
BEGIN
  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
   WHERE company_id = p_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Unauthorized: only admins/owners can rename properties';
  END IF;

  SELECT address INTO v_old FROM properties WHERE id = p_property_id AND company_id = p_company_id;
  IF v_old IS NULL THEN RETURN NULL; END IF;

  UPDATE properties
     SET address_line_1 = COALESCE(p_line1, address_line_1),
         address_line_2 = COALESCE(p_line2, address_line_2),
         city           = COALESCE(p_city,  city),
         state          = COALESCE(p_state, state),
         zip            = COALESCE(p_zip,   zip)
   WHERE id = p_property_id AND company_id = p_company_id;

  SELECT address INTO v_new FROM properties WHERE id = p_property_id AND company_id = p_company_id;
  PERFORM public._cascade_property_rename(p_company_id, v_old, v_new);
  RETURN v_new;
END;
$function$;

-- 4. Short name for reports. The full address is correct for leases and
--    mail but unusable as a P&L column header, so reports display this.
--    Seeded from the current address, which for the QuickBooks-imported
--    properties IS the QuickBooks name -- so existing reports keep reading
--    exactly as they do today even after addresses gain city/state/zip.
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS short_name text;

UPDATE public.properties SET short_name = address
 WHERE short_name IS NULL AND coalesce(address,'') <> '';

COMMENT ON COLUMN public.properties.short_name IS
  'Display label for reports and dropdowns. Falls back to address when null.';
