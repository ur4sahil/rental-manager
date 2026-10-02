// Renewals, rent changes and addenda (Phase 2 of docs/PLAN-tenant-documents.md).
//
// They used to change the lease the moment a button was pressed. Now a
// change is written up, signed where it must be, and takes effect on its
// date. These hold the rules (src/utils/leaseChangeRules.js) and the wiring.
import fs from "fs";
import {
  addDays, addMonths, daysBetween, firstOfMonthOnOrAfter, leaseTermState, renewalDefaults, checkRenewal,
  checkRentChange, earliestRentIncreaseDate, checkAddendum, describeLeaseChange, addendumText, changeFromFields, DEFAULT_RENT_NOTICE_DAYS,
} from "../src/utils/leaseChangeRules.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (detail ? "\n      " + detail : "")); } };
const read = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");
const lease = { id: "L1", status: "active", start_date: "2025-11-01", end_date: "2026-10-31", rent_amount: 2000 };

// ── dates
ok("a day is added across a month end and a year end", addDays("2026-10-31", 1) === "2026-11-01" && addDays("2026-12-31", 1) === "2027-01-01" && addDays("2026-03-01", -1) === "2026-02-28");
ok("a leap day is real in 2028 and not in 2027", addDays("2028-02-28", 1) === "2028-02-29" && addDays("2027-02-28", 1) === "2027-03-01");
ok("a month later is clamped to the month's length", addMonths("2026-01-31", 1) === "2026-02-28" && addMonths("2028-01-31", 1) === "2028-02-29" && addMonths("2026-11-30", 3) === "2027-02-28");
ok("twelve months later is the same day next year", addMonths("2026-11-01", 12) === "2027-11-01" && addMonths("2028-02-29", 12) === "2029-02-28");
ok("days between two dates, either way round", daysBetween("2026-10-02", "2026-12-31") === 90 && daysBetween("2026-12-31", "2026-10-02") === -90 && daysBetween("2026-10-02", "2026-10-02") === 0);
ok("the 1st on or after a date", firstOfMonthOnOrAfter("2026-12-31") === "2027-01-01" && firstOfMonthOnOrAfter("2026-12-01") === "2026-12-01");
ok("a date that is not a date gives nothing, not NaN text", addDays("", 1) === "" && addMonths("soon", 1) === "" && Number.isNaN(daysBetween("", "2026-01-01")));

// ── where a term stands
ok("a term with months to run", leaseTermState(lease, "2026-03-01").key === "fixed");
ok("inside the last 90 days it is 'ending soon', with the days left", leaseTermState(lease, "2026-10-01").key === "ending_soon" && leaseTermState(lease, "2026-10-01").daysLeft === 30);
ok("the last day still counts as the term", leaseTermState(lease, "2026-10-31").key === "ending_soon" && /today/.test(leaseTermState(lease, "2026-10-31").label));
ok("a passed end date is month-to-month, never 'expired'", leaseTermState(lease, "2026-11-01").key === "month_to_month" && leaseTermState(lease, "2028-01-01").since === "2026-10-31");
ok("a renewal waiting for signatures, and one scheduled, say so", leaseTermState(lease, "2026-10-01", { status: "awaiting_signature" }).key === "renewal_out" && leaseTermState(lease, "2026-10-01", { status: "scheduled", effective_date: "2026-11-01" }).key === "renewal_scheduled");
ok("a lease that is not active has no term state", leaseTermState({ ...lease, status: "terminated" }, "2026-10-01").key === "none" && leaseTermState(null, "2026-10-01").key === "none");

// ── renewal
let d = renewalDefaults(lease, "2026-10-02");
ok("a renewal opens the day after the term ends, for a year, at the current rent", d.startDate === "2026-11-01" && d.endDate === "2027-10-31" && d.rent === 2000, JSON.stringify(d));
d = renewalDefaults(lease, "2027-01-15");
ok("a lease already month-to-month renews from the 1st of next month", d.startDate === "2027-02-01" && d.endDate === "2028-01-31", JSON.stringify(d));
ok("a renewal must end after it starts", !checkRenewal({ lease, startDate: "2026-11-01", endDate: "2026-11-01", rent: 2000 }).ok && !checkRenewal({ lease, startDate: "2026-11-01", endDate: "2026-10-01", rent: 2000 }).ok);
ok("a renewal needs rent above zero", !checkRenewal({ lease, startDate: "2026-11-01", endDate: "2027-10-31", rent: 0 }).ok && !checkRenewal({ lease, startDate: "2026-11-01", endDate: "2027-10-31", rent: "abc" }).ok);
ok("a renewal cannot start on or before the current lease began", !checkRenewal({ lease, startDate: "2025-11-01", endDate: "2026-10-31", rent: 2000 }).ok);
ok("only an active lease can be renewed", !checkRenewal({ lease: { ...lease, status: "renewed" }, startDate: "2026-11-01", endDate: "2027-10-31", rent: 2000 }).ok);
ok("a good renewal comes back with rounded rent", checkRenewal({ lease, startDate: "2026-11-01", endDate: "2027-10-31", rent: "2150.456" }).rent === 2150.46);

// ── rent change
ok("the default notice is 90 days", DEFAULT_RENT_NOTICE_DAYS === 90 && earliestRentIncreaseDate({ noticeDate: "2026-10-02" }) === "2026-12-31");
let r = checkRentChange({ currentRent: 2000, newRent: 2100, effectiveDate: "2026-11-01", noticeDate: "2026-10-02" });
ok("an increase 30 days out is refused, and says the earliest date", !r.ok && r.earliest === "2026-12-31" && /90 days/.test(r.error));
ok("an increase exactly on the 90th day is allowed", checkRentChange({ currentRent: 2000, newRent: 2100, effectiveDate: "2026-12-31", noticeDate: "2026-10-02" }).ok);
ok("one day short is refused", !checkRentChange({ currentRent: 2000, newRent: 2100, effectiveDate: "2026-12-30", noticeDate: "2026-10-02" }).ok);
r = checkRentChange({ currentRent: 2000, newRent: 1900, effectiveDate: "2026-10-02", noticeDate: "2026-10-02" });
ok("a decrease needs no notice", r.ok && r.increase === false && r.pct === -5);
ok("the same rent is not a change", !checkRentChange({ currentRent: 2000, newRent: 2000, effectiveDate: "2027-01-01", noticeDate: "2026-10-02" }).ok);
ok("a change cannot start before notice was given", !checkRentChange({ currentRent: 2000, newRent: 1900, effectiveDate: "2026-09-01", noticeDate: "2026-10-02" }).ok);
ok("a company's own notice period is used", checkRentChange({ currentRent: 2000, newRent: 2100, effectiveDate: "2026-12-01", noticeDate: "2026-10-02", noticeDays: 60 }).ok && !checkRentChange({ currentRent: 2000, newRent: 2100, effectiveDate: "2026-11-30", noticeDate: "2026-10-02", noticeDays: 60 }).ok);
r = checkRentChange({ currentRent: 2000, newRent: 2150, effectiveDate: "2027-01-01", noticeDate: "2026-10-02" });
ok("the amount and percent are worked out", r.ok && r.amount === 150 && r.pct === 7.5 && r.from === 2000 && r.to === 2150);
ok("the message can be given the screen's date format", /10\/02\/2026/.test(checkRentChange({ currentRent: 2000, newRent: 2100, effectiveDate: "2026-11-01", noticeDate: "2026-10-02", date: s => s.slice(5, 7) + "/" + s.slice(8) + "/" + s.slice(0, 4) }).error));

// ── addendum
ok("a person joining needs a name", !checkAddendum({ kind: "add_person", person: {}, effectiveDate: "2026-10-02" }).ok);
ok("someone already on the lease cannot be added again (tenant or co-tenant, any case)", !checkAddendum({ kind: "add_person", tenantName: "Ann Lee", person: { name: "ann lee" }, effectiveDate: "2026-10-02" }).ok && !checkAddendum({ kind: "add_person", tenantName: "Ann Lee", coTenants: ["Bo Ray"], person: { name: "BO RAY" }, effectiveDate: "2026-10-02" }).ok);
ok("a sixth adult is refused", !checkAddendum({ kind: "add_person", tenantName: "A", coTenants: ["B", "C", "D", "E"], person: { name: "F" }, effectiveDate: "2026-10-02" }).ok && checkAddendum({ kind: "add_person", tenantName: "A", coTenants: ["B", "C", "D"], person: { name: "F" }, effectiveDate: "2026-10-02" }).ok);
ok("a bad email is refused; a blank one is allowed", !checkAddendum({ kind: "add_person", person: { name: "F", email: "nope" }, effectiveDate: "2026-10-02" }).ok && checkAddendum({ kind: "add_person", person: { name: "F" }, effectiveDate: "2026-10-02" }).ok);
ok("the email is stored lower-case", checkAddendum({ kind: "add_person", person: { name: "F", email: "F@X.Com" }, effectiveDate: "2026-10-02" }).payload.add_people[0].email === "f@x.com");
ok("only someone on the lease can leave it", !checkAddendum({ kind: "remove_person", coTenants: ["Bo Ray"], removeName: "Cy Dee", effectiveDate: "2026-10-02" }).ok && checkAddendum({ kind: "remove_person", coTenants: ["Bo Ray"], removeName: "bo ray", effectiveDate: "2026-10-02" }).ok);
ok("a rent addendum needs a different rent", !checkAddendum({ kind: "rent", newRent: 2000, currentRent: 2000, effectiveDate: "2026-10-02" }).ok && checkAddendum({ kind: "rent", newRent: 2050, currentRent: 2000, effectiveDate: "2026-10-02" }).payload.rent === 2050);
ok("a wording-only addendum needs wording, and changes nothing in the records", !checkAddendum({ kind: "other", text: " ", effectiveDate: "2026-10-02" }).ok && JSON.stringify(checkAddendum({ kind: "other", text: "Parking space 4", effectiveDate: "2026-10-02" }).payload) === "{}");
ok("every addendum needs a date", !checkAddendum({ kind: "other", text: "x" }).ok);

// ── in words
ok("a renewal in words", describeLeaseChange({ kind: "renewal", effective_date: "2026-11-01", payload: { end_date: "2027-10-31", rent: 2150 } }) === "New term 2026-11-01 – 2027-10-31 at $2,150.00 a month");
ok("a rent change in words", describeLeaseChange({ kind: "rent_increase", effective_date: "2027-01-01", payload: { rent: 2300 } }) === "Rent becomes $2,300.00 a month from 2027-01-01");
ok("an addendum in words", describeLeaseChange({ kind: "addendum", effective_date: "2026-10-02", payload: { add_people: [{ name: "Jamie" }], remove_people: ["Bo"] } }) === "Jamie joins the lease; Bo leaves the lease from 2026-10-02");
ok("a wording-only addendum says nothing changes in the records", /nothing changes in the records/.test(describeLeaseChange({ kind: "addendum", effective_date: "2026-10-02", payload: {} })));
const at = addendumText({ add_people: [{ name: "Jamie Roommate" }], rent: 2050 }, { text: "One cat is permitted." });
ok("the addendum document states each change, then the free text", /Jamie Roommate is added to the Lease/.test(at) && /changed to \$2,050\.00/.test(at) && /One cat is permitted\.$/.test(at));
ok("removing someone is stated too", /is removed from the Lease/.test(addendumText({ remove_people: ["Bo Ray"] })));

// ── what is scheduled is what the document says
const carried = { kind: "renewal", effective_date: "2026-11-01", payload: { end_date: "2027-10-31", rent: 2150 }, fieldMap: { effective_date: "renewal_start", end_date: "renewal_end", rent: "new_rent" } };
let c = changeFromFields(carried, { renewal_start: "2026-12-01", renewal_end: "2027-11-30", new_rent: "$2,200.00" });
ok("dates and rent edited in the document win over what the dialog proposed", c.effective_date === "2026-12-01" && c.payload.end_date === "2027-11-30" && c.payload.rent === 2200, JSON.stringify(c));
c = changeFromFields(carried, { renewal_start: "12/01/2026", renewal_end: "", new_rent: "" });
ok("a US-format date is read; a blank field keeps what was proposed", c.effective_date === "2026-12-01" && c.payload.end_date === "2027-10-31" && c.payload.rent === 2150, JSON.stringify(c));
ok("the proposed change itself is not mutated", carried.payload.rent === 2150 && carried.effective_date === "2026-11-01");
ok("an addendum's people survive the round trip", changeFromFields({ kind: "addendum", effective_date: "2026-10-02", payload: { add_people: [{ name: "J" }] }, fieldMap: { effective_date: "effective_date" } }, { effective_date: "2026-10-09" }).payload.add_people[0].name === "J");

// ── wiring
const docs = read("src/components/Documents.js"), tenants = read("src/components/Tenants.js"), leases = read("src/components/Leases.js"),
  app = read("src/App.js"), io = read("src/utils/leaseChanges.js"), dlg = read("src/components/LeaseChanges.js"),
  mig = read("supabase/migrations/20261003040000_lease_changes.sql"), std = read("src/utils/standardTemplates.js"), svc = read("src/utils/docService.js");
ok("the Leases tab no longer renews or raises rent on the spot", !/async function renewLease/.test(leases) && !/Apply Rent Increase/.test(leases) && !/status: "renewed"/.test(leases) && !/rent_increase_history: JSON\.stringify/.test(leases));
ok("the Tenants page's 'move the end date' renewal is gone", !/async function renewLease/.test(tenants) && !/Confirm Renewal/.test(tenants));
ok("both screens open the one dialog", /<LeaseChangeDialog kind=\{leaseChangeFor\.kind\}/.test(tenants) && /<LeaseChangeDialog kind=\{leaseChangeFor\.kind\}/.test(leases));
ok("the dialog is rendered on the tenant PAGE, not only over the list", tenants.indexOf("<LeaseChangeDialog") > tenants.indexOf("function renderLeasePanel()") && tenants.indexOf("<LeaseChangeDialog") < tenants.indexOf("// ---- the detail is a PAGE"));
ok("a second renewal or rent change is refused before anything is written, in the dialog and in the builder", /openChangeOfKind\(companyId, lease\.id, plan\.change\.kind\)/.test(dlg) && /openChangeOfKind\(companyId, pendingChange\.current\.leaseId, carried\.kind\)/.test(docs));
ok("the builder schedules what the DOCUMENT says", /changeRowFromDocument\(pendingChange\.current, fieldValues\)/.test(docs) && /effectiveDate: carried\.effective_date, payload: carried\.payload, docId: data\.id/.test(docs));
ok("sent for signature = waiting; a notice finalised or emailed = scheduled", /status: signing \? "awaiting_signature" : "scheduled"/.test(docs) && /saveDocument\("sent", \{ signing: true \}\)/.test(docs));
ok("a draft schedules nothing, and says so", /const carried = status !== "draft" && pendingChange\.current/.test(docs) && /Nothing is scheduled until the document is sent or finalised/.test(docs));
ok("a document whose change could not be recorded is not left behind", /if \(!made\.ok\) \{[\s\S]{0,400}archived_at: new Date\(\)\.toISOString\(\)[\s\S]{0,200}return null;/.test(docs));
ok("a signature request that could not be created cancels the change it carried", /cancel_reason: "The signature request could not be created"/.test(docs));
ok("changes due are applied when a company opens, BEFORE the month's rent is posted", app.indexOf("applyDueLeaseChanges(company.id)") > 0 && app.indexOf("applyDueLeaseChanges(company.id)") < app.indexOf("autoPostRecurringEntries(company.id)"));
ok("a failure to apply does not stop the rent from posting", /applyDueLeaseChanges\(company\.id\)\.catch\(\(\) => \(\{ ok: false \}\)\)\.then\(\(\) =>/.test(app));
ok("cancelling a change that is out for signature cancels the request first", io.indexOf("voidEnvelope(companyId, change.doc_id, reason)") < io.indexOf('.update({ status: "cancelled"') && io.indexOf("voidEnvelope(") > 0);
ok("only an open change can be cancelled", /\.eq\("id", change\.id\)\.in\("status", OPEN\)/.test(io));
ok("the notice period is a company setting with a default", /rent_increase_notice_days: 90/.test(read("src/config.js")) && /field="rent_increase_notice_days"/.test(read("src/components/Admin.js")));

// ── the database
ok("one renewal and one rent change in flight per lease", /CREATE UNIQUE INDEX IF NOT EXISTS idx_lease_changes_one_open[\s\S]{0,160}kind IN \('renewal', 'rent_increase'\)/.test(mig));
ok("a change is applied only from 'scheduled'", /IF v_c\.status <> 'scheduled' THEN RETURN jsonb_build_object\('skipped', v_c\.status\)/.test(mig));
ok("a change on a lease that has ended is cancelled, not applied", /IF NOT FOUND OR v_l\.status <> 'active' OR v_l\.archived_at IS NOT NULL THEN[\s\S]{0,300}status = 'cancelled'/.test(mig));
ok("the rent schedule and autopay move with the lease", /UPDATE recurring_journal_entries SET amount = v_new_rent/.test(mig) && /UPDATE autopay_schedules SET amount = v_new_rent/.test(mig));
ok("the schedule is matched by tenant id, never by name", /tenant_id = v_l\.tenant_id AND status IN \('active', 'paused'\)/.test(mig) && !/tenant_name =/.test(mig));
ok("a renewal makes a new lease linked to the old one and carries the deposit", /'renewal', v_l\.auto_renew/.test(mig) && /'active', v_l\.id, v_l\.late_fee_amount/.test(mig) && /COALESCE\(v_l\.deposit_status, 'held'\)/.test(mig));
ok("the envelope drives the status: completed -> scheduled, voided/declined -> cancelled", /NEW\.envelope_status = 'completed'[\s\S]{0,200}status = 'scheduled'/.test(mig) && /NEW\.envelope_status IN \('voided', 'declined'\)[\s\S]{0,400}status = 'cancelled'/.test(mig));
ok("one bad row does not hold up the rest", /EXCEPTION WHEN others THEN[\s\S]{0,300}Could not be applied/.test(mig));
ok("staff only; nothing for a caller who is not logged in", /REVOKE ALL ON public\.lease_changes FROM anon;/.test(mig) && /REVOKE ALL ON FUNCTION public\.apply_due_lease_changes\(text\) FROM PUBLIC, anon;/.test(mig) && /REVOKE ALL ON FUNCTION public\._apply_lease_change\(uuid, text\) FROM PUBLIC, anon, authenticated;/.test(mig));
ok("the migration needs no approval prompt to run again (no DROP)", !/\bDROP\b/.test(mig));

// ── the templates the buttons open
for (const key of ["lease_renewal", "lease_change_addendum", "rent_increase_notice"]) ok("standard template '" + key + "' is defined", new RegExp("\\n  " + key + ": \\{").test(std));
ok("the renewal and the addendum are signed by the tenants, then the landlord", (std.match(/signing_mode: "sequential", signer_roles: SIGNERS/g) || []).length === 2 && /\{ role: "landlord", label: "Landlord", order: 2, required: true \}/.test(std));
ok("the rent notice is not signed", /rent_increase_notice: \{\s*name: "Rent Increase Notice", category: "notices", template_type: "html", signing_mode: "none"/.test(std));
ok("an existing template is never overwritten", /if \(existing\.data\) return existing\.data;/.test(std) && !/\.update\(/.test(std));
ok("each kind of document is recorded as its kind", /lease_renewal: "renewal"/.test(svc) && /lease_change_addendum: "addendum"/.test(svc) && /rent_increase_notice: "rent_increase_notice"/.test(svc));
// every field the dialog fills exists in the template it opens
for (const [key, names] of [["lease_renewal", ["renewal_start", "renewal_end", "new_rent"]], ["rent_increase_notice", ["effective_date", "current_rent", "new_rent", "notice_days", "increase_reason"]], ["lease_change_addendum", ["effective_date", "addendum_text"]]]) {
  const block = std.slice(std.indexOf("\n  " + key + ": {"), std.indexOf("\n  },", std.indexOf("\n  " + key + ": {")));
  ok(key + ": has every field the dialog fills, and prints each one", names.every(n => block.includes('field("' + n + '"') && block.includes("{{" + n + "}}")), names.filter(n => !block.includes('field("' + n + '"') || !block.includes("{{" + n + "}}")).join(","));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
