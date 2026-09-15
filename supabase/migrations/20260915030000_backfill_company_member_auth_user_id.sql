-- Link existing memberships to their auth user.
--
-- /api/invite-user creates the auth account with inviteUserByEmail, which
-- returns the new user's id -- and nothing stored it. Every invited member
-- therefore sat with auth_user_id NULL.
--
-- It worked, which is why nobody noticed: get_staff_company_ids() and
-- is_company_staff() both match on auth_user_id OR email, so the email
-- branch carried it. The failure is latent -- the moment someone changes
-- their email address, a membership keyed only on the old one stops
-- matching them and they silently lose access to the company.
--
-- Dry run on production before writing: 7 rows unlinked, 5 with exactly one
-- matching auth user, 2 with none (invited but never signed up), 0
-- ambiguous. Only the unambiguous 5 were touched; the other 2 are active
-- members with no auth account at all and have nothing to link to.
--
-- The ambiguity check matters and is not theoretical here: this codebase
-- has already been bitten by same-name and same-email collisions, and
-- guessing which of two auth users a membership belongs to would hand
-- someone another person's company.
UPDATE public.company_members cm
   SET auth_user_id = u.id
  FROM auth.users u
 WHERE cm.auth_user_id IS NULL
   AND cm.status IN ('invited', 'active')
   AND lower(u.email) = lower(cm.user_email)
   AND (SELECT count(*) FROM auth.users u2
         WHERE lower(u2.email) = lower(cm.user_email)) = 1;
