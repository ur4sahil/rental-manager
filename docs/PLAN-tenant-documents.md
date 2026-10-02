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

Both migrations are applied to the TEST database only. Production needs
them (and 20261002010000 / 20261002011000 before them) applied first, and
the lease template installed, before this reaches `main`.

Still to do in Phase 1: retire the two throwaway lease generators (Tenants
`openLeaseForSigning`, the Leases page's own HTML), a lease/sign entry on the
tenant page for existing tenants, and "to sign" / "my documents" in the
tenant portal.
