-- Wave 2 #3: late-fee rules gain enable/disable. Existing rules default active.
ALTER TABLE public.late_fee_rules ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
