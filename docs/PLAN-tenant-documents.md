# Plan: wire the Document Builder into the Tenant module

Status: PLAN ONLY. Nothing here is built. Written 2026-10-02 from a read of the
code on `staging` and the TEST database. Production was not queried.

Marks used below: **[V]** = I verified it myself in the code or the test
database. **[R]** = reported by the code research and not re-checked line by
line. Anything legal is marked **[LAW]** and needs your attorney's sign-off
before it goes live.

---

## 1. Bottom line

The Tenant module and the Document Builder are two separate systems that
share almost nothing. Wiring buttons to templates is the smaller half of the
job. The larger half is that the pieces a tenant document depends on are
missing or broken underneath:

1. **Nothing can open the Document Builder for a specific tenant.** It takes
   no tenant, lease or template from outside. **[V]**
2. **Documents are tied to people by name and address text**, not by record.
   On Sigma's data 25 properties have more than one tenant row, and for those
   the builder's auto-fill silently returns blank tenant fields. **[V]**
3. **E-signing is half built.** Signing emails call a function that is not
   in the code base and is not deployed on the test project; the second
   signer in a sequence is never emailed; a request cannot be re-sent
   (the database rejects it); a signed PDF is never filed where staff or
   tenants look. **[V]**
4. **Email in general is switched off and broken.** The notification sender
   is paused by default, is not on any schedule, and crashes on its normal
   path. **[V]**
5. **Most "document" buttons in the Tenant module produce no document.**
   They change a status, or open a browser tab that stays empty. **[V]**

So the plan has a foundation phase before any button is rewired. Skipping it
would give you buttons that look connected and still send nothing.

---

## 2. What exists today

### 2.1 Tenant-side actions

| Action (where) | What it actually does today | Document? | E-sign? | Email? |
|---|---|---|---|---|
| Create Lease (Leases tab) | Creates the lease as active at once, posts the deposit charge, starts the rent schedule | No | No | Sends "your lease is ready, a signing link will follow". No link ever follows **[V]** |
| New tenant / property setup wizard | Creates a minimal active lease | No | No | "move in" email only **[R]** |
| Renew (Leases tab) | Old lease marked renewed, new lease row, rent changes immediately | No | No | No **[V]** |
| Renew lease (tenant page) | A different renewal: just moves the end date on the same lease. No rent change, no history | No | No | No **[V]** |
| Rent Increase (Leases tab) | Changes rent now. The "effective date" is stored and ignored. No notice period | No | No | No **[R]** |
| E-Sign (Leases tab) | Builds its own lease text (not your lease template), sends for signature | Own HTML | Yes | Via the missing function. Lease never shows "Signed" afterwards **[V]** |
| Generate & E-Sign Lease (tenant page) | A third lease: fixed six-clause text in a pop-up with a drawing box. Nothing saved. Prints raw code text in one clause | Throwaway | Fake | No **[R]** |
| Generate Move-Out Notice (tenant page) | Sets the tenant to "notice" and a move-out date. That is all | No | No | No **[V]** |
| Send Notice (bulk) | Same, for many tenants | No | No | No **[R]** |
| Prepare filing (tenant page, when rent is owed) | Jumps to the Evictions tab without carrying the tenant | No | No | No **[R]** |
| Start Case (Evictions) | Creates a case row, sets tenant to "notice" | No | No | No **[R]** |
| Generate Legal Notice (Evictions) | Builds a notice, then opens an empty browser tab. Never saved | No | No | No **[V]** |
| Court forms | Not in the app at all. Only a calculator script for the amounts, never called | No | No | No **[V]** |
| Move-out wizard | Ends the lease, archives the tenant, posts deposit entries | No | No | Email promises "a deposit notice will follow". None does **[V]** |
| Return Deposit (Leases tab) | Posts the entries | No | No | Plain two-line email, no itemised letter **[R]** |
| Terminate lease | Ends lease, tenant to "past" | No | No | No **[R]** |

### 2.2 Document Builder

Works on its own: templates, fill-in, preview, PDF, send for signature,
history. As of this week it also has real pages, a real PDF and the
auto-filling MD Residential Lease (test site only).

What it cannot do today: **[V]** unless marked
- be opened from another screen with a tenant or template chosen;
- find a tenant by record (it looks up "the tenant at this address");
- link a document to a lease, a property record or a court case;
- re-send, remind, cancel or void a signature request;
- email the next signer in a sequence;
- store the PDF of a document that was not e-signed;
- show a signed document on the tenant page, the property page or the
  tenant portal;
- e-sign or email a court-form (PDF overlay) template: those paths use the
  template's text body, not the PDF **[R]**.

### 2.3 Two security problems found on the way

- **Any logged-in tenant can read every signing link in the company.** The
  database rule on signature rows allows all active members, tenants
  included, and the row contains the secret link. **[V]**
- **Template text is readable by tenant accounts** for the same reason. **[R]**

These are in the foundation phase regardless of anything else.

---

## 3. Why the links are broken (root causes)

| # | Cause | Effect |
|---|---|---|
| A | The builder's logic lives inside one screen's memory. No other screen can call it | Every tenant action re-invents its own document, or produces none |
| B | Records are matched by name/address text | Blank auto-fill for 25 Sigma properties; co-tenants ("A / B / C" lease names) match nothing; a rename can detach or mis-attach documents |
| C | A generated document has no link to its lease, property record or case | "Is this lease signed?" cannot be answered; the Leases tab never turns green |
| D | Status changes are not tied to documents | Tenant is put on "notice" with no notice; lease is "active" with no signed lease |
| E | Delivery is not owned by anything | Three different email paths, none reliably working; promises made in emails that nothing fulfils |
| F | Nothing is filed | A document exists only in Builder > History; staff and tenants look elsewhere |
| G | Nothing runs on a clock | Effective dates, notice periods and deadlines are stored and never acted on |

---

## 4. Target design

Seven rules. Every action in section 5 must satisfy all seven, and the
five-year walk-through in section 6 checks each step against them.

1. **One document service.** A single shared module creates, sends and files
   documents. The Document Builder screen and the Tenant module both call
   it. No screen builds its own lease text again.
2. **Links by record.** Every generated document carries the tenant record,
   the lease record, the property record and (where relevant) the court
   case record, with database-enforced links. Names and addresses are
   printed from those records, never used to find them.
3. **One template per document kind,** chosen by a stable key (not by its
   display name), so "Create lease" always opens your MD Residential Lease
   and a renamed template does not break the button.
4. **The document drives the status.** A status changes because a document
   reached a stage (issued, served, signed), and the change is recorded
   against that document.
5. **One delivery path that is observable.** Every send is logged with
   who, when and whether it went out; failures show on screen, not in a
   silent log.
6. **Everything is filed where people look:** tenant page, property page,
   tenant portal, with a stored PDF that cannot change afterwards.
7. **Dates act.** Effective dates, notice periods and deadlines are carried
   out by a daily job, not by someone remembering.

### 4.1 Data changes (all additive)

On the generated-document table:
- link to lease, to property record, to court case (real links);
- `doc_kind`: lease, renewal, addendum, rent_increase_notice,
  notice_to_vacate, move_out_acknowledgment, late_notice, notice_of_intent
  (DC-CV-115), ftpr_complaint (DC-CV-082), deposit_disposition, other;
- issue/serve facts: served date, served method (email, hand, mail, posted),
  effective date;
- stored PDF path and fingerprint for every final document, signed or not.

On the template table: a stable `template_key`. Fix the first-use copy of
built-in templates, which currently drops signing settings and field rules
**[V]**.

On leases: nothing new. `renewed_from`, `signature_status` and `draft`
already exist and are simply unused.

On court cases: case number, court, amount claimed, link to lease and
property record, writ date.

New small table: **scheduled changes** (what, for which lease, effective
when, created by which document, applied when). This is what makes a rent
increase take effect on its date instead of today.

Sigma has 0 generated documents and 0 court cases in the copy I checked
**[V]**, so there is no old data to convert.

### 4.2 Co-tenants

Today co-tenants are names in a list on the tenant record, with their
emails stored on the property. They have no record of their own. **[V]**
Minimum needed for leases: every adult named on the lease is a signer, with
a name and email collected at send time and saved back to the tenant
record. Full co-tenant records are a separate project and are not required
by this plan.

---

## 5. Wiring, action by action

Columns: what starts it, which template, where the facts come from, what
changes and when, who is emailed, where it is filed.

| Action | Starts from | Template (key) | Status change, and when | Signers / recipients | Filed |
|---|---|---|---|---|---|
| **New lease** | Tenant page, Leases tab, setup wizard: all open the same flow with the tenant preselected | `md_residential_lease` | See Decision 1 | Tenant(s), then landlord | Lease record, tenant page, property page, portal |
| **Renewal** | One "Renew" button (the two current ones merge) | `lease_renewal` (new lease or renewal addendum) | On full signature: old lease "renewed", new lease linked to it, effective on its start date | Tenant(s), then landlord | Same |
| **Rent increase** | Leases tab, or inside Renew | `rent_increase_notice` | Notice issued now; rent changes on the effective date via a scheduled change. Blocked if the date is inside the notice period **[LAW]** | Tenant(s), copy to staff | Same |
| **Addendum** (pet, roommate in/out, other) | Tenant page | `lease_addendum` | On signature: the named change is applied (co-tenant list, extra monthly charge) | All tenants, landlord | Attached to the lease |
| **Tenant gives notice** | Tenant page "Record notice" | `move_out_acknowledgment` | Tenant to "notice" when recorded; notice date, who gave it and move-out date stored on the document | Tenant | Same |
| **Landlord non-renewal / notice to vacate** | Tenant page | `notice_to_vacate` | Tenant to "notice" when served; serve method recorded | Tenant | Same |
| **Late rent notice** | Automatic after the late fee posts, or manual | `late_fee_notice` | None | Tenant | Same |
| **Failure to pay rent, step 1** | Tenant page "Prepare filing" (tenant carried through) | `md_dccv115` Notice of Intent, official form **[LAW]** | Court case opened at "notice"; cure deadline = served date + 10 days | Served on tenant; method recorded | Case, tenant page |
| **Failure to pay rent, step 2** | Case screen, only after the deadline with rent still owed | `md_dccv082` complaint, official form **[LAW]** | Case to "filed"; filing date and case number recorded | None (the court serves) | Case, tenant page |
| **Later court steps** | Case screen | Warrant of restitution and others, added one by one | Stage and dates | None | Case |
| **Move-out** | Tenant page, tenant carried into the wizard | `move_out_statement` | As today, plus forwarding address captured | Tenant | Tenant page (still visible after archive) |
| **Deposit disposition** | End of move-out, or Leases "Return Deposit" (the two merge) | `deposit_disposition` itemised letter | Deposit marked returned/withheld; deadline tracked **[LAW]** | Tenant, at the forwarding address | Same |

Court forms are filled onto the official PDF and printed or e-filed. They
are not e-signed and not emailed to the tenant.

The amounts on the two court forms come from the oldest-first arrears
calculator that already exists as a script (rent and late fees by period,
voucher split). It gets moved into the app. Rental licence and lead
certificate numbers come from the property's licence records (Sigma has 38
on file **[V]**), which the builder cannot reach today **[R]**.

---

## 6. Five-year walk-through

One tenant, 2026 to 2031. For each event: does it work today, and what the
plan needs for it to work. "Works" means all seven rules in section 4 hold.

| # | When | Event | Today | Needs |
|---|---|---|---|---|
| 1 | Month 0 | Tenant and co-tenant added; lease created | Lease active instantly; email promises a link that never comes | Phase 0 + 1 |
| 2 | Month 0 | Lease sent to tenant, co-tenant, then you | Only if the missing email function exists in production; co-tenant has no email; second signer never emailed | Phase 0 + 1 |
| 3 | Month 0 | Co-tenant loses the email | Cannot re-send: database rejects it **[V]** | Phase 0 |
| 4 | Month 0 | All sign | PDF uploaded only if the last signer's browser stays open; lease never shows signed; nothing on tenant page or portal | Phase 0 + 1 |
| 5 | Month 9 | Renewal reminder, 90 days out | Only fires if staff happen to open the dashboard **[R]** | Phase 5 |
| 6 | Month 9 | Renewal offered with a rent increase | Two renew buttons that disagree; rent changes today, not at renewal | Phase 2 |
| 7 | Month 12 | Renewal lease signed; new rent starts | No document, no signature, no effective date | Phase 2 |
| 8 | Month 15 | Roommate added | No addendum; co-tenant list only editable in the setup wizard | Phase 2 |
| 9 | Month 20 | Rent late; late fee; notice | Scheduled late fee does not post with a 5-day grace (it runs on the 5th, still inside grace) **[V]**; no notice | Phase 3 + 5 |
| 10 | Month 21 | Still unpaid: 10-day Notice of Intent | Empty browser tab | Phase 4 |
| 11 | Month 21 | Tenant pays on day 6 | Case can be closed as cured. Works, but there is no notice on file to show what was cured | Phase 4 |
| 12 | Month 24 | No renewal signed; tenancy continues | Lease stays "active" past its end date forever; no month-to-month state | Phase 2 |
| 13 | Month 30 | Rent increase on a month-to-month | As 6 | Phase 2 |
| 14 | Month 40 | Unpaid again: notice, then complaint filed | No form, no case number field, amounts not broken out | Phase 4 |
| 15 | Month 41 | Hearing, judgment, tenant pays before eviction | Stages track; no documents | Phase 4 |
| 16 | Month 50 | Tenant marries, name changes | Rename rewrites documents by name with no property check; could touch a same-name tenant elsewhere **[R]** | Phase 0 |
| 17 | Month 58 | Tenant gives 60 days' notice | Status only. No record of the date or who gave it | Phase 3 |
| 18 | Month 60 | Move-out, inspection | Works for the books. Tenant not carried into the wizard | Phase 3 |
| 19 | Month 60 + 45 days | Itemised deposit letter | Does not exist. A document filed after archive cannot attach to the tenant **[R]** | Phase 0 + 3 |
| 20 | Year 6 | Former tenant asks for their lease | Only in Builder > History, if it was ever made there | Phase 1 |

Today **none of the 20 steps** meets all seven rules. Three work for the
books only (11, 15, 18). Nothing from step 1 onward leaves a document you
could hand to a judge.

### Things that must not break (checked in testing for every phase)

Signed on paper instead of online. Signer declines. Link expires after 30
days. Email bounces. Staff cancels after sending. Template edited after a
document was sent (the sent copy must not change). Two tenants with the
same name. A property renamed. A co-tenant leaves mid-lease. Voucher
tenants (tenant and agency portions). A tenant who moves to another of
your units. Signing on a phone. The test site must never email a real
tenant.

---

## 7. Phases

Each phase ends on the test site for you to check before the next starts.
Estimates are working days.

**Phase 0. Foundations (7 to 9 days).** No visible new buttons.
- One working email path with a log; test site locked to approved addresses.
- E-sign repairs: re-send, remind, cancel; next signer emailed; signed PDF
  stored even if the signer closes the browser; signers get a link to
  their copy; staff told when signing completes.
- Close the two security holes in 2.3.
- Document links by record; shared document service; auto-fill by record
  (fixes the 25 blank properties).
- Signed and final documents filed onto the tenant and property pages.
- Done when: a lease made in the Builder for a two-tenant property fills
  in fully, both sign in order, either can be re-sent, and the signed PDF
  appears on the tenant page.

**Phase 1. Lease from the tenant page (4 to 5 days).**
- "Create lease" everywhere opens the MD Residential Lease for that tenant.
- Remove the two throwaway lease generators.
- Lease shows Unsigned / Out for signature / Signed, truthfully.
- Tenant portal: "to sign" and "my documents".
- Done when: steps 1 to 4 and 20 pass.

**Phase 2. Renewal, rent increase, addenda (6 to 8 days).**
- One Renew flow; scheduled changes take effect on their date.
- Month-to-month after an unsigned expiry.
- Done when: steps 6 to 8, 12, 13 pass.

**Phase 3. Notices and move-out (6 to 7 days).**
- Notice to vacate, tenant-notice acknowledgment, late notice.
- Move-out carries the tenant; forwarding address; itemised deposit letter.
- Done when: steps 9, 17 to 19 pass.

**Phase 4. Failure to pay rent (8 to 10 days).**
- DC-CV-115 and DC-CV-082 on the official forms, amounts from the arrears
  calculator, licence numbers from the property.
- Case screen: case number, court, amounts, documents per stage.
- Done when: steps 10, 11, 14, 15 pass.

**Phase 5. The clock (4 to 5 days).**
- Daily job: renewal reminders at 90/60/30 days, unsigned-document nudges,
  10-day and 45-day deadlines, late fee timing.
- Done when: step 5 passes and a full five-year run passes end to end.

Total: roughly 7 to 9 weeks. Phases 0 and 1 give you a real lease flow in
about 2.5 weeks.

One automated test plays the whole 20-step story on the test database and
is re-run after every phase.

---

## 8. Decisions needed from you

1. **When does a new lease take effect?**
   a. When everyone has signed (recommended), with a "signed on paper,
      activate now" option. Rent schedule and deposit charge start then.
   b. Immediately, as today; signing tracked beside it.
2. **Production email check.** May I read (not change) the production
   project's function list to see whether the signing-email function exists
   there? Without it, signing emails have never been sent in production.
3. **Who signs for the landlord?**
   a. You sign each lease after the tenants (recommended).
   b. Your saved signature is applied automatically once tenants sign.
4. **Court forms scope for the first version.**
   a. Failure to pay rent only: DC-CV-115 and DC-CV-082 (recommended).
   b. Also tenant holding over and breach of lease.
5. **Attorney review.** The notice periods, caps and deadlines below are
   from public sources. I would not ship them as rules without your
   attorney confirming them.

## 9. Maryland rules the plan assumes [LAW]

Found in public sources on 2026-10-02; not legal advice.
- 10-day written Notice of Intent (DC-CV-115) before a failure-to-pay
  complaint (DC-CV-082).
- Late fee capped at 5% of the unpaid rent.
- Rent increase: 90 days' written notice for terms longer than a month.
- Security deposit: returned with an itemised list within 45 days; interest
  owed; maximum one month's rent for leases signed from 2024-10-01.

Sources: Maryland Courts "Rent Court for Landlords, Part 1"
(courts.state.md.us/video/courthelp/start-your-case-rent-court), the
DC-CV-082 form notice (mdcourts.gov/district/forms/civil/dccv082notice072014),
Real Property 8-203 (codes.findlaw.com/md/real-property/md-code-real-prop-sect-8-203),
and secondary summaries of 8-208 and 8-209.

The app today has none of these as rules: no late-fee cap, a 30-day deposit
default, no rent-increase notice check. **[R]** The code's own script calls
DC-CV-115 the "Failure to Pay Rent" form; it is the notice that comes
before it. **[V]**

## 10. Risks

- **Changing when a lease becomes active** (Decision 1a) touches when rent
  and deposit charges post. Sigma's books are tallied; this must apply to
  new leases only and be tested against a copy first.
- **Official court forms change.** The blank forms must be taken from the
  Maryland courts' site and re-checked on a schedule.
- **Email reputation.** Turning sending on means real tenants get real
  email. It should start with signing requests only.
- **Co-tenant data is thin.** Leases that need three signatures need three
  email addresses that are not on file today.

---

## Phase 1 as built (2026-10-02): Prospects

Phase 1 changed shape after discussion with Sahil. Instead of sending a
lease from a tenant record that already bills, a **prospect** is a person
the books know nothing about.

Decisions:

- Prospects have their own sidebar page. Adding a tenant directly (Tenants
  page, property wizard) is unchanged: it is still how someone onboarded
  outside the app gets in.
- A prospect holds contact details, co-applicants, the property, the lease
  terms, files and notes. Nothing is posted for them.
- Several prospects may be sent a lease for the same property. The first
  lease to be fully signed wins; the others are cancelled by the database in
  the same transaction, the applicants are not emailed, and staff are told
  (a note on each losing prospect and a line in the "fully signed" email).
- A lease may be signed at any time. Conversion is one click and is refused
  while the property still has a live tenant or an active lease.
- Rent starts on the lease start date. Conversion posts the deposit and the
  first (possibly part) month dated the lease start, creates the monthly
  schedule from the 1st of the following month, and charges any whole
  months that had already passed.
- A lease signed on paper can be converted by ticking a box; any e-sign
  request still out is withdrawn.

Where it lives:

- `supabase/migrations/20261003010000_prospects.sql` — table, RLS,
  `doc_generated.prospect_id`, `documents.prospect_id`, the envelope trigger.
- `supabase/migrations/20261003011000_prospect_convert.sql` —
  `convert_prospect_to_tenant()` (tenant, lease, occupied property, documents
  relinked, one transaction) and the shared "cancel competing leases" helper.
- `src/utils/onboardingRules.js` — what gets charged, as a pure plan.
- `src/utils/tenantOnboarding.js` — posts that plan; every step re-runnable.
- `src/components/Prospects.js` — the page.
- `src/utils/docService.js` `loadDocContext({ prospectId })` — fills the
  lease from the prospect and never from the current occupant.

All four migrations (20261002010000, 20261002011000, 20261003010000,
20261003011000) were applied to PRODUCTION on 2026-10-02 after a rolled-back
rehearsal there, the MD Residential Lease template was installed for Sigma
Housing LLC (checksum-identical to the tested copy), and `main` was
fast-forwarded to 912dcd0 the same day. Document emails are real on
production from that point (no allowlist there).

Still to do in Phase 1: retire the two throwaway lease generators (Tenants
`openLeaseForSigning`, the Leases page's own HTML), a lease/sign entry on the
tenant page for existing tenants, and "to sign" / "my documents" in the
tenant portal.

---

## Revision after Prospects (2026-10-02)

Nothing in this section is built. Items marked **[V]** were checked in the
code on `staging` at 912dcd0. The phases below carry Sahil's decisions of
2026-10-02.

### What Prospects settled

- Decision 1 (when a lease takes effect): nothing reaches the books until a
  prospect is converted; rent starts on the lease start date.
- Decision 2 (production email): answered by shipping. Signing emails are
  live on production.
- Decision 3 (who signs for the landlord): tenants first, then the landlord
  signs each lease (the template is sequential).
- Risk "co-tenant data is thin": for new leases, a prospect now carries each
  co-applicant's name and email, and conversion copies them to the tenant.

Phase 0 is done and live. Phase 1 is live except the three items listed
under "Still to do in Phase 1" above.

### What Prospects exposed

| # | Gap | Evidence |
|---|---|---|
| G1 | **Five screens start a tenancy's books, each with its own code.** Only the Prospects one charges the months already passed, and only it is covered by the onboarding tests | Prospects (shared engine), Tenants add (`Tenants.js` ~488), property wizard (`Properties.js` ~1634), property quick-add (`Properties.js` ~3559), Leases "Create Lease" (`Leases.js` ~149) **[V]**. Stanley Ibe's missing schedule and Toni Tillman's wrong first charge both came from the wizard path |
| G2 | **Converting before the lease start date posts charges dated in the future** (deposit and first month are dated the lease start, whatever today is) | `planTenancyCharges` **[V]**. Toni's entries dated 2026-11-03 were this, from the wizard |
| G3 | **Money paid before move-in has nowhere to go.** Applicants often pay the deposit at signing; the books know nothing until conversion, and conversion is refused while the old tenant is still there | By design of Phase 1 |
| G4 | **Nothing happens after conversion.** No welcome email, no portal invite, no move-in inspection, no check for the renter's insurance the lease requires before occupancy (Section VI) | `Prospects.js` has no such step **[V]** |
| G5 | **No application step.** The lease (Section XXII) refers to "the application"; a prospect has file uploads and notes but no application form and no checklist of what was received | **[V]** |
| G6 | **Losing applicants are never told** their lease was cancelled (deliberate), and there is no letter to send if you want to | By design |
| G7 | **Signature slots.** The lease has three tenant signature slots; a prospect can carry four co-applicants | Template `signer_roles` **[V]**; behaviour with a fifth adult not yet tested |
| G8 | **Nothing chases a prospect.** Unsigned lease, signing link expiring at 30 days, lease start date arriving with nobody converted | No clock yet (Phase 5) |
| G9 | **Move-out does not know someone is waiting.** A signed prospect for the same property is not mentioned when the old tenant is moved out | **[V]** |
| G10 | **Renewals and rent increases are the same shape as a prospect** (offer, sign, takes effect on a date) and should reuse it instead of a third design | Design note for Phase 2 |

### Revised phases (as decided by Sahil, 2026-10-02)

Working days. "Was" is the original estimate for what is left.

**Phase 1, finish (was ~3 days, now 7 to 8).**
- As planned: retire the two old lease generators; a lease/sign entry on the
  tenant page for existing tenants; tenant portal "to sign" and "my
  documents".
- NEW (G1): one way to start a tenancy. The Tenants page, both property
  paths and Leases "Create Lease" call the same engine as Prospects, so all
  five produce identical ledger entries and a rent schedule every time.
  Existing tenants and posted entries are not touched.
- NEW (G3, Decision B): money received before move-in is recorded against
  the prospect as held and moves to the tenant's ledger on conversion.
  Which account holds it, and how a refund to a prospect who never moves in
  is recorded, are to be agreed with Sahil before this is built. **[LAW]**
- NEW (G7): signature slots follow the number of adults on the lease.

**Phase 2, renewal, rent increase, addenda (7 to 9 days, +1).**
- Unchanged in scope. Built on the prospect pattern (G10): an offer is a
  document; nothing changes until it is signed and its date arrives.
- NEW: a non-renewal or a tenant's notice gives the property an "available
  from" date, shown when choosing a property for a prospect.

**Phase 3, notices and move-out (6.5 to 7.5 days, +0.5).**
- Unchanged, plus (G9): finishing a move-out says "X has a signed lease for
  this home" and offers the conversion.

**Phase 1B, application (NEW, 3 to 4 days, after Phase 3: Decision C).**
- Application form sent to the prospect by link, filled in and signed, filed
  on the prospect (G5), plus a short checklist: ID, income proof, renter's
  insurance, application received.
- A "this home has been leased" email for a losing applicant, sent only when
  staff press the button (G6).
- Application fees have Maryland rules **[LAW]**; attorney list.

**Phase 5, the clock (5 to 6 days, +1).**
- Unchanged, plus (G8): reminder for an unsigned lease, warning before a
  signing link expires, and "lease starts today, not converted yet".

**Phase 4, failure to pay rent (8 to 10 days).** Unchanged. Last, because it
waits on the attorney check.

**Totals.** Left before this revision: about 27 to 33 days. Now: about 37
to 45 days. Order: 1, 2, 3, 1B, 5, 4.

### Decisions (Sahil, 2026-10-02)

- **A. Converting before the lease start date: keep as today.** Deposit and
  first rent are both dated the lease start date, even when that is in the
  future. G2 is accepted, not fixed. When Phase 1 routes the other four
  screens through the shared engine they keep this same dating.
- **B. Money received before move-in: hold it on the prospect**; it moves to
  the tenant's ledger on conversion. Built in Phase 1.
- **C. Application step: build it later**, after Phase 3.
- **D. After conversion: nothing automatic.** No welcome email, no portal
  invite, no inspection. G4 is accepted, not fixed.

### For the attorney list (added)

- The lease text now installed says the security deposit "shall not exceed
  the equivalent of two (2) months' Rent". Section 9 of this plan notes a
  one-month maximum for leases signed from 2024-10-01. The wording is
  Sigma's own and was not changed. **[LAW]**
- Money held for a prospect before move-in (Phase 1) and application fees (Phase 1B). **[LAW]**

---

## Phase 1 finished (2026-10-02, on `staging`; database changes on TEST only)

Built without stopping, at Sahil's instruction. Choices I made on his behalf
are marked **[CHOSEN]**: they are on the test site to look at, and each is
small to change before it goes to production.

**One way to start a tenancy (G1).** `startTenancyBooks`
(`src/utils/tenantOnboarding.js`) is now the only code that posts a deposit,
a first month or a rent schedule. Callers: Prospects (convert), the property
wizard, the property form, Leases "Create lease", and the Tenants page's
add path (which turned out to be unreachable from the screen today).
- Two modes: `new` (a move-in) and `running` (already lives there: the
  schedule only). The shared "Start billing" dialog
  (`StartTenancyModal.js`) and the wizard's Recurring Rent step ask which
  and show what will be posted. **[CHOSEN]** default: a lease that started
  before last month is offered as "already lives there".
- A tenant whose ledger has charges from before the lease start is a
  renewal and is never charged a deposit or a part first month (Toni).
- A month that already carries a rent charge is never charged again,
  however that charge got there (Stanley's hand-posted months).
- The wizard charges the months already passed only in the run that posts
  the first month, so a re-save years later cannot go back and bill.
- Decision A is unchanged: deposit and first rent are dated the lease
  start, future or not.
- The old closable "Set Up Recurring Rent" pop-up and a dead second one
  (which wrote bare account codes) are deleted.

**One lease.** The Tenants page's six-clause pop-up and the Leases page's
own lease text are deleted. "Create lease" on the tenant page and in the
Leases tab opens `md_residential_lease` in the Document Builder for that
tenant. `TenancyDocuments.js` lists what was made for a tenant or a lease,
where it stands and who has signed, with remind / copy link / cancel; it is
on the tenant page and in the Leases tab, and is the place later phases add
renewals and notices.

**Signature slots (G7).** `effectiveSignerRoles` adds a tenant slot for each
adult beyond the template's own. A named signer with no email now stops the
send instead of being left off the envelope.

**Tenant portal.** "Waiting for your signature" on the overview and the
documents tab, from `my_pending_signatures()` (migration 20261003020000):
only requests addressed to the caller's own login email, in a company they
are an active member of. Signed copies were already filed tenant-visible.

**Money before move-in (G3, Decision B).** Migration 20261003030000 and
`src/utils/prospectMoney.js`. **[CHOSEN]**, to confirm with Sahil:
- held as a liability in an account of the prospect's own ("Held - name",
  2150-001 ...) under a parent "Prospect Money Held" (2150, or the next
  free number up to 2199);
- received: DR Checking 1000 / CR the prospect's account. A bank deposit can
  instead be categorised to that account on the Banking page;
- refund: DR the prospect's account / CR Checking, never more than is held;
- on conversion: DR the prospect's account / CR the tenant's own ledger for
  exactly what is held (reference `HELD-T<tenant id>`), dated the day of
  conversion, and the account is closed;
- money kept from an applicant who does not move in is NOT built: that is a
  manual journal entry until the attorney has confirmed what may be kept.
- A prospect with money held cannot be removed until it is refunded.

Tests: `tests/onboarding-rules.test.mjs` (71), `tenancy-docs.test.mjs` (39),
`prospect-money.test.mjs` (29); browser runs against the TEST database for
the wizard (move-in, late entry both ways), Leases "Create lease", the
tenant page card, and money held through to conversion.

Not on production: the code (staging 34fdae1 and later) and migrations
20261003020000, 20261003030000.

---

## Phase 2 as built (2026-10-02, on `staging`; database changes on TEST only)

**A lease change is a row that waits for its date** (`lease_changes`,
migration 20261003040000): `awaiting_signature` → `scheduled` → `applied`,
or `cancelled`. The document drives it: a trigger moves the change when its
envelope is completed or cancelled. `_apply_lease_change` changes the lease,
the tenant (whose trigger carries rent, names and dates onto the property),
the rent schedule and autopay together. `apply_due_lease_changes` runs when
staff open a company, before the month's rent is posted, and is what the
Phase 5 daily job will call.

- **Renew** (tenant page and Leases tab, one dialog): new term and rent,
  then either the Lease Renewal Agreement for signature or "already signed on
  paper". On its day the old lease becomes `renewed` and a new lease row runs
  the new term, carrying the deposit. The two old renewals (one moved the end
  date; one raised the rent on the spot) are deleted.
- **Change the rent**: an increase is refused inside the notice period
  (company setting `rent_increase_notice_days`, default 90 **[LAW]**); a
  decrease needs none. Creates the Rent Increase Notice, or records that
  notice was already given. The old modal that ignored its effective date is
  deleted.
- **Addendum**: a person joins, a person leaves, the rent changes, or
  wording only. Signed, or already signed on paper. Co-tenant names and
  their emails are rebuilt together, so a removal cannot leave one person's
  email against another's name.
- One renewal and one rent change in flight per lease (a unique index).
- What is scheduled is read back from the finished document, so an amount
  edited in the builder is the amount that takes effect.
- **Month-to-month**: a passed end date reads "Month-to-month since ..." in
  the Leases tab and on the tenant page. Nothing ends a tenancy by itself.
- **Available from**: on Prospects, a home whose tenant is on notice shows
  the date it becomes free.
- Standard templates now live in code (`src/utils/standardTemplates.js`:
  `lease_renewal`, `lease_change_addendum`, `rent_increase_notice`) and are
  installed into a company the first time they are missing; an existing
  template is never overwritten. The wording is plain and needs the
  attorney's read **[LAW]**.

Tests: `tests/lease-changes.test.mjs` (84); a rolled-back database run of ten
cases; a browser run of renewal → sign → takes effect, a refused and then a
valid rent change, cancel, and an addendum on paper.

Known gap: when a change takes effect on opening the app, a page already on
screen shows the old figures until it is reloaded.

---

## Phase 3 as built (2026-10-02, on `staging`; database change on TEST only)

- **Notice to vacate** (tenant page, "New…" and the lease drawer):
  `NoticeDialog` records WHO gave notice, WHEN, and the move-out date on the
  tenant (`notice_given_on`, `notice_given_by`; migration 20261003050000),
  then writes it up: an Acknowledgment of Notice to Vacate when the tenant
  gave it, a Notice to Vacate when the landlord did. A notice shorter than
  the company's `termination_notice_days` is recorded and flagged, never
  refused. The lease stays active; only the move-out ends it. The old
  30/60-day buttons that set a status and produced nothing are deleted.
- **Late rent notice**: offered on the tenant page when something is owed,
  filled in with the amount. Sending one automatically after a late fee posts
  is Phase 5.
- **Served**: a notice can be marked served, with the date and how (email,
  by hand, first-class or certified mail, posted). Shown on the document.
- **Move-out**: opened from a tenant's page the wizard starts on that tenant
  and on the move-out date from their notice. It asks for the forwarding
  address (saved on the tenant before they are archived).
- **Security Deposit Statement**: the finished screen shows the accounting
  (released, withheld for damage, applied to unpaid rent, returned or still
  owed) and the date the statement is due, and opens the statement filled in
  for the former tenant. The figures are the ledger's own arithmetic
  (`depositStatement`): the browser test checks the ledger ends at exactly
  what the statement says is returned.
- **Waiting prospect (G9)**: the finished screen names a prospect with a
  lease for the vacated home and links to them.
- New standard templates: `move_out_acknowledgment`, `notice_to_vacate`,
  `late_fee_notice`, `deposit_disposition` (installed only when a company has
  no template under that key).

For the attorney **[LAW]**: the statement's deadline uses the company's
`deposit_return_days`, whose default is 30; Maryland's figure is 45. Interest
on the deposit is a field on the statement but is not calculated.

Tests: `tests/notices.test.mjs` (56) and a browser run of notice →
acknowledgment → served → move-out → statement.

---

## Phase 1B as built (2026-10-02, on `staging`; database change on TEST only)

- **Rental application** (migration 20261003060000, `PublicApplyPage.js`,
  `applicationForm.js`). From a prospect's page staff send each adult a
  private link (`/apply/<token>`). The applicant fills it in with no
  account, on a phone or a computer, and signs by typing their name. It can
  be submitted once; the link stops working after 30 days or when a newer
  one is made. Staff read it on the prospect, and can print it or save it
  as a PDF.
- **[CHOSEN]** what it asks: contact details, current address and landlord,
  work and income, who will live there, pets, vehicles, whether they have
  been evicted, an emergency contact. It does NOT ask for a Social Security
  number, a date of birth, bank details or criminal history. The questions
  and any application fee need the attorney's read **[LAW]**; no fee is
  collected.
- **Checklist** on the prospect: application received (ticks itself), photo
  ID, proof of income, renter's insurance. Each tick records who and when.
- **Sending**: through the app's logged sender, or "Copy link", or a draft
  in the device's own mail app.
- **"Home no longer available" letter (G6)**: a button on a prospect whose
  home went to someone else. Never sent automatically.

Tests: `tests/application.test.mjs` (35) and a browser run with a second,
logged-out browser as the applicant.

---

## Phase 5 as built (2026-10-02, on `staging`; database change on TEST only)

- **One list of what needs attention today** (migration 20261003070000,
  database function `lease_clock_items`). It stores nothing: it reads the
  records each time, so a line goes away by itself once the thing is done.
  - a lease ending within 90 days with no renewal offered (said again at 60
    and at 30 days)
  - a document still unsigned after three days, and when a signing link has
    stopped working or is about to
  - a prospect whose lease start date has arrived and who is not a tenant
    yet (signed or not)
  - a tenancy that ended with a deposit and no deposit statement written,
    with the date it is due
  - a tenant on notice whose move-out is within a week, or past and not run
  - a renewal or rent change that could not take effect on its day
  - a late fee charged this month with no late notice written
- **Dashboard card "Needs attention"** (`LeaseClock.js`). Each line has a
  button that opens the right screen (the tenant, the prospect, the
  move-out, the deposit statement, the late notice), "Send a reminder" for
  unsigned documents, and "Dismiss".
- **Daily job** (`api/_lease-clock-impl.js`, 7am Eastern, runs on
  production only). For every company: lease changes whose day has come
  take effect; admins get ONE morning email listing what is newly waiting
  (each thing is emailed once); signers are reminded automatically if the
  company turned that on.
- **[CHOSEN]** the morning email is ON by default and goes to admins only
  (Settings has a switch). Automatic reminders to people who have not
  signed are OFF by default (Settings: every N days, at most three times,
  each one renews their link).
- **[CHOSEN] late fees now run every day** instead of on the 5th. The 5th
  is inside a five-day grace period, so the scheduled job could never
  charge anyone; daily, the fee posts the first morning after grace ends.
  The amount, the grace period and the once-a-month rule are unchanged.
  **This starts charging late fees automatically once it is on
  production** for any company with a late-fee rule. It needs a yes.
- **Not automatic, on purpose**: the late notice itself. A late fee makes a
  line on the list with a "Write the notice" button; nothing is sent to a
  tenant without a person pressing Send.
- **Gap**: the deposit statement started from the dashboard is not
  pre-filled with the deductions (those are only known on the move-out's
  last screen). Staff fill them in.
- **Release order**: the migration must reach a database before this code
  does, or saving Settings fails there (two new settings columns).

Tests: `tests/lease-clock.test.mjs` (67), a seeded check of every kind of
line on TEST (rolled back), the daily job run twice locally (second run
emails nothing), and a browser run of the dashboard card.

---

## Phase 4 as built (2026-10-02, on `staging`; database change on TEST only)

**Changed from the plan, and why.** The plan said both court forms would be
filled on the official PDFs. Only one can be:
- **DC-CV-115, Notice of Intent** is published by the court as a fillable
  PDF (Rev. 10/2024). The app fills in the court's own fields and stores
  the result. `public/dccv115.pdf` is the court's file, unchanged; if the
  court revises it, filling refuses rather than guesses.
- **DC-CV-082, the complaint** cannot be done that way. The court's own
  copy says: "This form is not printable, and cannot be completed online...
  The Court requires the carbonless multi-part form." So the app makes a
  **worksheet**: every answer the form asks for, numbered as on the form,
  to copy onto the court's paper.

**What it does.**
- **Arrears, worked out in the app** (`src/utils/arrears.js`). Payments are
  applied to the oldest charge first. What reaches the form is unpaid RENT
  and LATE FEES, each with its period. Utilities, deposits, repairs and
  court costs are never claimed (the form says so); they are shown as "left
  off". Staff can correct what a charge counts as, or enter the amounts
  themselves.
- **Voucher tenancies**: only the tenant's own share is claimed. If the
  split between tenant and housing authority does not add up, no number is
  offered and staff must enter the tenant's share.
- **Step 1, the notice** (tenant page "Prepare filing", or "Failure to pay
  rent" on the case screen). Date and method as on the form: first-class
  mail, on the door, or electronic (only if the tenant asked for it). A
  case opens at the notice stage with the amounts, the deadline (10 days),
  the court for the property's county, and the notice on file as served.
  The tenant's status does NOT change: it is not a notice to vacate.
- **Step 2, the complaint worksheet**, only from the 11th day and only with
  rent still owed. Carries the notice's date and method, the rental licence
  number and expiry, the lead certificate number, whether the tenancy is
  subsidised, and asks for military service and prior judgments. Missing
  licence or lead numbers are printed on it as things to check.
- **Case screen**: claimed amounts, notice date and method, deadline with
  days left, court, case number, hearing, judgment and warrant dates, the
  documents, "Record the filing", and "The tenant paid — close the case".
- **Dashboard**: "the 10 days are up" appears in Needs attention.
- **Settings → Company Details**: the landlord's address, phone and email
  (printed on the notice) could not be edited anywhere before.

**[CHOSEN]**
- Money paid on the same day as rent and another charge goes to rent
  first, so the claim errs low, never high.
- The notice is left unsigned, to be signed by hand.
- The old generic "Pay or Quit" printout is hidden for Maryland
  failure-to-pay cases (it is not the form the court requires). It remains
  for other case types and for Virginia and DC.
- Maryland only. A home in VA or DC is refused with a message.

**[LAW] for the attorney before this is used for a real filing**
- That payments may be applied oldest-charge-first across all charges, and
  the "less tenant payments for utility bills, fees and security deposits"
  line (PU 7-309 / RP 8-212.3), which the worksheet shows as $0.
- Whether mailing adds days to the 10.
- The 5% late-fee cap (the app only warns).
- Voucher cases: what may be claimed from the tenant.
- The military-service affidavit wording.

Migration: `20261003080000_ftpr_cases.sql` (new columns on
`eviction_cases`; additive). Tests: `tests/ftpr.test.mjs` (102, including
filling the court's real PDF) and a browser run of notice → worksheet →
filing → paid.

## Editor and court forms (2026-10-03, on `staging`; one database change on TEST only)

Everything above is on production (main 912dcd0 and after). This section is
on `staging` only: commits 07bc8b3, 68fab68, 301aa7f, 5afb41b.

### The Word editor, brought up to Word

Sahil's report: "no tab works on the word editor", then "the signing page is
completely different from what I uploaded". Root cause of the second: the
editor collapsed runs of spaces and tabs when it loaded a body
(`preserveWhitespace` was off), so a lease laid out with spaces and tabs lost
its shape between the upload and the signing page. Fixed at the root
(`PARSE_OPTIONS` everywhere a body is loaded: editor, preview, signing page,
PDF).

Built (src/utils/docRules.js holds the rules, pure; docKit.js the editor
extensions; RichTextEditor.js the screen; docxImport.js the Word import;
pagedPdf.js the PDF):

1. Tab key as Word: nests a list item / un-nests on Shift+Tab; at the start
   of a paragraph sets a first-line indent (half-inch steps); elsewhere a
   real tab character (stops every half inch); inside a table, next cell.
2. Indent / Outdent buttons and a Paragraph popover (alignment, left/right
   /first-line/hanging indent, spacing before/after, line height,
   keep-with-next).
3. A Word-style ruler above the page: margins, first-line and hanging indent
   markers that drag.
4. Numbering styles: 1. / a. / A. / i. / I. / (1) / (a) / (i) / 1.1, bullets
   round/hollow/dash/square; restart at 1; continue previous list. Tab
   inside a list steps 1. -> (a) -> (i). The Word import keeps the file's
   own numbering.
5. Text colour, highlight, superscript/subscript, strikethrough.
6. Tables: insert, rows/columns, merge/split, borders all/outer/none, header
   row; resizable.
7. Forced page break (Ctrl/Cmd+Enter) and keep-with-next (a heading never
   sits alone at the foot of a page). Both done by measuring the real page
   gaps (LayoutFixups).
8. Checkboxes as characters (survive every sanitizer; a checkbox FIELD
   fills in as one).
9. Find & replace.
10a. Different first page (its own header and footer, Page tab).
10b. Export to Word: a real .docx (src/utils/docxExport.js), see commit
   301aa7f for what it keeps.

Plus: initials on every page (Signers tab option; typed on the pad; stamped
on every body page by the finalize API before hashing; migration
20261003090000 on TEST only). The template editor is one side panel with
tabs (Fields / Signers / Page / Rules / Details) and `{{` in the page offers
the fields.

A renderer bug found by the first-page work: the PDF's sheet pitch was
measured between the tops of the first two page gaps, which move with the
first page's footer height; the text drifted a line per page. Now measured
between the gaps' bottoms.

### Court forms (Maryland failure to pay rent)

- DC-CV-115 (Notice of Intent to File): filled from the ledger, flattened.
- DC-CV-082 (Complaint): the court's e-filing version
  (dccv082bulkfiling.pdf) filled and left fillable; a worksheet for the
  paper form.
- DC-CV-081 (Petition for Warrant of Restitution): filled from the case.
All three on the tenant page's menu and under "Court forms (Maryland)" in
the Document Builder. `src/utils/courtForms.js` holds the field maps; the
bundled PDFs in `public/` are sha256-pinned.

### Test state (2026-10-03)

`cd tests && npm run test:unit` runs clean except two items that predate
this work: `payments-autopay-stripe` (3 handler checks, since 0ec422a on
09-29) and `recurring-balance-sync`'s live check (5 recurring rows whose
tenant_name differs from the tenant record — data, in the database
tests/.env points at). Browser checks in the session scratchpad:
editor-e2e, tpl-ui-e2e, initials-e2e, export-e2e, sign-e2e, all passing.
