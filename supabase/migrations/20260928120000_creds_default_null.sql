-- Saving a utility / insurance policy / loan / HOA WITHOUT a login must work.
--
-- 20260914210000 + 20260915020000 added chk_<table>_creds_not_blank, which
-- forbids '' in username_encrypted / password_encrypted / encryption_iv
-- (NULL is the one honest "no credential"). But those three columns kept
-- DEFAULT '' from the original schema, so any INSERT that simply omits the
-- login gets '' from the default and the CHECK rejects the whole row.
--
-- Fix: the default becomes NULL. Existing rows and the CHECK constraints are
-- deliberately untouched. Other credential columns (encryption_iv_username,
-- encryption_salt, hoa mgmt_* / pay_*) already default to NULL.
ALTER TABLE public.utilities
  ALTER COLUMN username_encrypted SET DEFAULT NULL,
  ALTER COLUMN password_encrypted SET DEFAULT NULL,
  ALTER COLUMN encryption_iv      SET DEFAULT NULL;

ALTER TABLE public.property_insurance
  ALTER COLUMN username_encrypted SET DEFAULT NULL,
  ALTER COLUMN password_encrypted SET DEFAULT NULL,
  ALTER COLUMN encryption_iv      SET DEFAULT NULL;

ALTER TABLE public.property_loans
  ALTER COLUMN username_encrypted SET DEFAULT NULL,
  ALTER COLUMN password_encrypted SET DEFAULT NULL,
  ALTER COLUMN encryption_iv      SET DEFAULT NULL;

ALTER TABLE public.hoa_payments
  ALTER COLUMN username_encrypted SET DEFAULT NULL,
  ALTER COLUMN password_encrypted SET DEFAULT NULL,
  ALTER COLUMN encryption_iv      SET DEFAULT NULL;
