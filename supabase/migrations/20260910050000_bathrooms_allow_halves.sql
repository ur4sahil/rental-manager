-- properties.bathrooms is an integer, so a half-bath cannot be saved.
-- Postgres rejects it outright:
--
--   invalid input syntax for type integer: "1.5"
--
-- A bulk import of 41 real properties lost 10 of them to this, and the
-- property wizard has the same limitation -- 1.5 and 2.5 baths are
-- ordinary in US housing, so this is a defect rather than a policy.
--
-- Widening integer to numeric is non-destructive: every existing whole
-- number stays valid and reads back unchanged. numeric(4,1) allows up
-- to 999.5, which covers anything short of a hotel, and the single
-- decimal place stops 1.4999 being stored.
ALTER TABLE public.properties
  ALTER COLUMN bathrooms TYPE numeric(4,1);

COMMENT ON COLUMN public.properties.bathrooms IS
  'Bathroom count, halves allowed (1.5, 2.5). Was integer until 2026-09-10, which rejected every half-bath.';
