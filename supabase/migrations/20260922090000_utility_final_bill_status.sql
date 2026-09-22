-- final_bill_status tracks a utility that has been flipped owner->tenant but
-- whose CLOSEOUT bill/credit is still the owner's (usage up to the meter
-- transfer). 'none' = normal; 'pending' = final bill still owed by owner (stays
-- on the owner's to-pay list, auto-fetched, payable in-app); 'settled' = that
-- final bill/credit was recorded, so the utility is fully the tenant's now.
ALTER TABLE public.utility_accounts
  ADD COLUMN IF NOT EXISTS final_bill_status text NOT NULL DEFAULT 'none';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_utility_final_bill_status') THEN
    ALTER TABLE public.utility_accounts
      ADD CONSTRAINT chk_utility_final_bill_status CHECK (final_bill_status IN ('none','pending','settled'));
  END IF;
END $$;
