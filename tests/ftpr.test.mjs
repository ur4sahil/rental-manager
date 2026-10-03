// Failure to pay rent (Phase 4): the arrears calculation, the court's
// Notice of Intent filled on its own PDF, and the complaint worksheet.
import fs from "fs";
import crypto from "crypto";
import * as PDFLib from "pdf-lib";
import { money, classifyCharge, entriesFromLines, fifoArrears, lateFeesOverCap, manualClaim, monthStart, monthEnd, isVoucherPayment } from "../src/utils/arrears.js";
import { DCCV115, NOTICE_METHODS, usDate, usMoney, addDaysIso, cureDeadline, complaintReadiness, splitAddress, courtFor, dccv115Values, fillDccv115, dccv082Lines, worksheetPdf, pdfSafe } from "../src/utils/courtForms.js";
import { clockAction, CLOCK_KINDS } from "../src/utils/leaseClockRules.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (detail ? "\n      " + detail : "")); } };
const read = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");
let n = 0;
const D = (date, debit, description, extra = {}) => ({ id: "l" + (++n), date, debit, credit: 0, description, memo: "", reference: "", transactionType: "", ...extra });
const C = (date, credit, description = "Payment", extra = {}) => ({ id: "l" + (++n), date, debit: 0, credit, description, memo: "", reference: "", transactionType: "", ...extra });
const run = (lines, opts, overrides) => fifoArrears(entriesFromLines(lines, overrides), opts);

// ── what a charge is
ok("a scheduled rent posting is rent", classifyCharge({ reference: "RECUR-ab12cd34-2026-09", description: "Monthly rent — Pat" }) === "rent");
ok("an imported invoice that says rent is rent", classifyCharge({ reference: "QB-991", description: "Invoice 1422 Rent September" }) === "rent");
ok("a late fee is a late fee, by reference, type or wording", classifyCharge({ reference: "LATEFEE-12-202609" }) === "late_fee" && classifyCharge({ transactionType: "late_fee" }) === "late_fee" && classifyCharge({ description: "Late Fee - Sept" }) === "late_fee" && classifyCharge({ memo: "late charge" }) === "late_fee");
ok("'late rent' is rent, not a late fee", classifyCharge({ description: "Late rent for August" }) === "rent");
ok("a security deposit is never rent", classifyCharge({ reference: "DEP-T12", description: "Security deposit" }) === "other" && classifyCharge({ description: "Rental deposit" }) === "other");
ok("utilities, repairs, court fees and unlabelled entries are not claimable", ["Water bill WSSC", "Journal Entry 44 Repairs", "Court Fee", "Journal Entry 12", ""].every(d => classifyCharge({ description: d }) === "other"));
ok("a housing-authority payment is recognised", isVoucherPayment("HAPGC payment") && isVoucherPayment("Housing Authority of PG") && isVoucherPayment("Section 8") && !isVoucherPayment("Zelle from Pat") && !isVoucherPayment("perhaps cash"));

// ── reading the ledger
let e = entriesFromLines([D("2026-09-01", 1000, "Rent"), C("2026-09-03", 400), { id: "x", date: "", debit: 5, credit: 0 }, { id: "y", date: "2026-09-09", debit: 0, credit: 0 }, null]);
ok("a line becomes a charge or a payment; undated and empty lines are skipped", e.length === 2 && e[0].kind === "charge" && e[1].kind === "payment");
ok("a person's correction wins over the automatic reading, and both are kept", (() => { const l = D("2026-09-01", 300, "Journal Entry 7"); const x = entriesFromLines([l], { [l.id]: "rent" })[0]; return x.category === "rent" && x.autoCategory === "other"; })());
ok("a nonsense correction is ignored", (() => { const l = D("2026-09-01", 300, "Rent"); return entriesFromLines([l], { [l.id]: "banana" })[0].category === "rent"; })());

// ── oldest first
const base = [D("2026-08-01", 1000, "Rent Aug"), D("2026-09-01", 1000, "Rent Sep"), D("2026-09-06", 50, "Late fee Sep"), D("2026-10-01", 1000, "Rent Oct"), C("2026-08-03", 1000), C("2026-09-10", 300)];
let r = run(base);
ok("payments settle the oldest charge first; what is left is the claim", r.rent.amount === 1700 && r.lateFees.amount === 50 && r.total === 1750 && r.balance === 1750, JSON.stringify([r.rent, r.lateFees, r.total, r.balance]));
ok("the rent period runs from the first unpaid month to the end of the last", r.rent.from === "2026-09-01" && r.rent.to === "2026-10-31" && r.rent.months === 2);
ok("the late-fee period is its own", r.lateFees.from === "2026-09-01" && r.lateFees.to === "2026-09-30" && r.lateFees.months === 1);
ok("each open charge says how much of it is still open", r.open.length === 3 && r.open[0].stillOpen === 700 && r.open[0].charged === 1000);
ok("order of the input does not matter", JSON.stringify(run([...base].reverse()).rent) === JSON.stringify(r.rent));
r = run([D("2026-09-01", 50, "Late fee"), D("2026-09-01", 1000, "Rent"), C("2026-09-02", 1000)]);
ok("on the same day rent is paid before the fee", r.rent.amount === 0 && r.lateFees.amount === 50);

// ── what is never claimed
r = run([D("2026-08-01", 1000, "Rent Aug"), D("2026-08-15", 120, "Water bill"), D("2026-09-01", 1000, "Rent Sep"), C("2026-08-03", 1000)]);
ok("an unpaid utility charge is left off the form and said so", r.notClaimed.amount === 120 && r.notClaimed.count === 1 && r.total === 1000 && r.balance === 1120);
ok("the claim is never more than the balance", r.total <= r.balance);
r = run([D("2026-08-01", 1000, "Rent Aug"), D("2026-08-15", 120, "Water bill"), D("2026-09-01", 1000, "Rent Sep"), C("2026-08-20", 1120)]);
ok("a utility charge still takes its turn: money that paid it did not pay rent", r.rent.amount === 1000 && r.notClaimed.amount === 0);
const dep = [D("2026-08-01", 1500, "Security deposit", { reference: "DEP-T9" }), D("2026-08-01", 1000, "Rent Aug"), C("2026-08-01", 1500, "Deposit received"), D("2026-09-01", 1000, "Rent Sep")];
r = run(dep);
ok("money paid the same day as rent and a deposit were charged goes to rent first, so the claim errs low; an open deposit is never claimed", r.rent.amount === 1000 && r.notClaimed.amount === 1000 && r.total === 1000 && r.balance === 2000, JSON.stringify([r.rent.amount, r.notClaimed.amount, r.balance]));
const je = D("2026-09-01", 900, "Journal Entry 31");
ok("an unlabelled charge is not claimed until a person says it is rent", run([je]).total === 0 && run([je]).notClaimed.amount === 900 && run([je], {}, { [je.id]: "rent" }).rent.amount === 900);

// ── nothing owed
r = run([D("2026-09-01", 1000, "Rent"), C("2026-09-02", 1200)]);
ok("an overpaid tenant owes nothing and the credit is shown", r.total === 0 && r.creditLeft === 200 && r.balance === -200 && r.open.length === 0 && r.rent.from === "");
ok("an empty ledger owes nothing", run([]).total === 0 && run(null).balance === 0);
ok("cents do not drift", run([D("2026-09-01", 0.1, "Rent"), D("2026-10-01", 0.2, "Rent"), C("2026-10-02", 0.3)]).total === 0 && money(0.1 + 0.2) === 0.3);

// ── voucher tenancies
const v = [D("2026-08-01", 2000, "Rent Aug"), D("2026-09-01", 2000, "Rent Sep"), D("2026-10-01", 2000, "Rent Oct"),
  C("2026-08-05", 1500, "HAPGC"), C("2026-09-05", 1500, "HAPGC"), C("2026-08-06", 500, "Zelle")];
r = run(v, { voucher: true });
ok("only the tenant's own share is claimed", r.voucherTenancy && r.rent.amount === 1000 && r.total === 1000, JSON.stringify([r.rent, r.voucherSide]));
ok("a month the authority has not paid yet stays the authority's, not the tenant's", r.voucherSide.owedByAuthority === 1500 && r.voucherSide.from === "2026-10-01");
ok("the two shares add back to the ledger", r.reconciles && !r.unreliable && r.balance === 2500);
ok("the same ledger without the voucher split would claim the authority's money too", run(v).total === 2500);
r = run([...v.slice(0, 3), C("2026-08-05", 1500, "HAPGC"), C("2026-08-06", 2000, "Zelle")], { voucher: true });
ok("a split that does not add up is refused, with the reason and what is needed", r.unreliable === true && !r.reconciles && /does not add up/.test(r.blockedReason) && r.needed.length === 2, JSON.stringify([r.total, r.voucherSide, r.balance, r.drift]));
r = run([D("2026-09-01", 2000, "Rent"), D("2026-09-06", 60, "Late fee"), C("2026-09-05", 1500, "HAP")], { voucher: true });
ok("late fees on a voucher tenancy are the tenant's in full", r.lateFees.amount === 60 && r.rent.amount === 500);
r = run([D("2026-09-01", 2000, "Rent"), C("2026-09-05", 1500, "HAP"), C("2026-09-06", 800, "Cash")], { voucher: true });
ok("a voucher tenant in credit is simply owed nothing", r.total === 0 && !r.unreliable);

// ── late-fee cap, own figures, dates
ok("a late fee over 5% of the rent is flagged; one at the cap is not", lateFeesOverCap([{ category: "late_fee", charged: 100 }, { category: "late_fee", charged: 90 }, { category: "rent", charged: 1800 }], 1800).length === 1 && lateFeesOverCap([{ category: "late_fee", charged: 90 }], 1800).length === 0);
ok("with no rent on file nothing is flagged", lateFeesOverCap([{ category: "late_fee", charged: 500 }], 0).length === 0);
let mc = manualClaim({ rent: "1200", rentFrom: "2026-09-01", rentTo: "2026-09-30", lateFees: "" });
ok("a person's own figures make a claim", mc.ok && mc.claim.total === 1200 && mc.claim.manual && mc.claim.lateFees.from === "");
ok("own figures need a period, in order, and something claimed", !manualClaim({ rent: 100 }).ok && !manualClaim({ rent: 100, rentFrom: "2026-09-30", rentTo: "2026-09-01" }).ok && !manualClaim({}).ok && !manualClaim({ rent: -5, rentFrom: "2026-09-01", rentTo: "2026-09-30" }).ok && !manualClaim({ lateFees: 50 }).ok);
ok("month bounds, including a leap February", monthStart("2028-02-17") === "2028-02-01" && monthEnd("2028-02-17") === "2028-02-29" && monthEnd("2027-02-01") === "2027-02-28" && monthEnd("2026-12-05") === "2026-12-31" && monthEnd("bad") === "");

// ── dates and the ten days
ok("court dates are written month/day/year", usDate("2026-10-02") === "10/02/2026" && usDate("") === "" && usDate("10/02/2026") === "");
ok("money is written with cents and commas", usMoney(3600) === "3,600.00" && usMoney("90.5") === "90.50" && usMoney(null) === "0.00");
ok("ten days carry across a month and a year", addDaysIso("2026-10-25", 10) === "2026-11-04" && addDaysIso("2026-12-28", 10) === "2027-01-07" && cureDeadline("2026-10-02") === "2026-10-12");
ok("on the tenth day the tenant may still pay", complaintReadiness({ providedOn: "2026-10-02", today: "2026-10-12" }).ready === false);
ok("the complaint can be prepared from the eleventh day", complaintReadiness({ providedOn: "2026-10-02", today: "2026-10-13" }).ready === true);
ok("no notice on file: not ready, and it says why", !complaintReadiness({ providedOn: "", today: "2026-10-13" }).ready && /has not been provided/.test(complaintReadiness({ providedOn: null, today: "2026-10-13" }).reason));
ok("a missing 'today' is never read as ready", !complaintReadiness({ providedOn: "2026-10-02", today: "" }).ready);

// ── addresses and courts
ok("a one-line address splits into street and city/state/zip", JSON.stringify(splitAddress("100 Main St, Suite 4, Bowie, MD 20715")) === JSON.stringify({ street: "100 Main St, Suite 4", cityStateZip: "Bowie, MD 20715" }) && splitAddress("PO Box 9, Lanham, MD 20706-1234").cityStateZip === "Lanham, MD 20706-1234");
ok("an address it cannot split is kept whole rather than mangled", splitAddress("100 Main St").street === "100 Main St" && splitAddress("100 Main St").cityStateZip === "" && splitAddress(null).street === "");
ok("the court is the District Court for the property's county", courtFor("Prince George's") === "District Court of Maryland for Prince George's County" && courtFor("Montgomery County") === "District Court of Maryland for Montgomery County" && courtFor("Baltimore City") === "District Court of Maryland for Baltimore City" && courtFor("", "Baltimore") === "District Court of Maryland for Baltimore City" && courtFor("") === "");

// ── the Notice of Intent
const claim = { rent: { amount: 3600, from: "2026-09-01", to: "2026-10-31" }, lateFees: { amount: 90, from: "2026-09-01", to: "2026-09-30" } };
const good = { landlord: { name: "Acme Homes LLC", address: "100 Main St", cityStateZip: "Bowie, MD 20715", phone: "301-555-0100", email: "office@example.com" }, tenants: [{ name: "Pat Tenant", email: "pat@example.com" }, { name: "Sam Tenant" }], premises: { address: "22 Oak Ct", cityStateZip: "Bowie, MD 20715" }, tenantPhone: "240-555-0111", claim, noticeDate: "2026-10-02", method: "mail" };
let val = dccv115Values(good);
const T = DCCV115.text, K = DCCV115.checks;
ok("a complete notice has no problems", val.ok && val.problems.length === 0, val.problems.join(" | "));
ok("amounts, periods and total go in the form's own fields", val.text[T.rent] === "3,600.00" && val.text[T.rentFrom] === "09/01/2026" && val.text[T.rentTo] === "10/31/2026" && val.text[T.lateFees] === "90.00" && val.text[T.feesTo] === "09/30/2026" && val.text[T.total] === "3,690.00");
ok("landlord, tenants and the home go where the form puts them", val.text[T.landlordName] === "Acme Homes LLC" && val.text[T.landlordCityStateZip] === "Bowie, MD 20715" && val.text[T.tenant1] === "Pat Tenant" && val.text[T.tenant2] === "Sam Tenant" && !(T.tenant3 in val.text) && val.text[T.tenantAddress] === "22 Oak Ct" && val.text[T.tenantEmail1] === "pat@example.com");
ok("rent and fees are ticked as 'months'; mail is ticked; nothing electronic", val.checks.includes(K.rentMonths) && val.checks.includes(K.feesMonths) && val.checks.includes(K.mail) && !val.checks.includes(K.electronic) && !val.checks.includes(K.rentWeeks));
ok("the signature is left blank for a hand signature", !(T.signature in val.text) && val.text[T.signedDate] === "10/02/2026");
ok("no late fees: that line is left blank and unticked", (() => { const x = dccv115Values({ ...good, claim: { rent: claim.rent, lateFees: { amount: 0 } } }); return x.ok && !(T.lateFees in x.text) && !x.checks.includes(K.feesMonths) && x.text[T.total] === "3,600.00"; })());
ok("on the door ticks 'affixed'", dccv115Values({ ...good, method: "posted" }).checks.includes(K.posted));
ok("electronic delivery needs the tenant's request", !dccv115Values({ ...good, method: "email" }).ok && /only at the tenant's request/.test(dccv115Values({ ...good, method: "email" }).problems.join(" ")));
val = dccv115Values({ ...good, method: "portal", tenantAskedForElectronic: true });
ok("with the request, the electronic box and its kind are both ticked", val.ok && val.checks.includes(K.electronic) && val.checks.includes(K.portal) && !val.checks.includes(K.email));
ok("nothing past due: no notice", !dccv115Values({ ...good, claim: { rent: { amount: 0 }, lateFees: { amount: 0 } } }).ok);
ok("missing landlord address, tenant, home, date or method each stop it", [{ landlord: { name: "A" } }, { tenants: [] }, { premises: {} }, { noticeDate: "" }, { method: "pigeon" }].every(o => !dccv115Values({ ...good, ...o }).ok));
ok("a fifth tenant is flagged; the first four still go on the form", (() => { const x = dccv115Values({ ...good, tenants: ["A", "B", "C", "D", "E"].map(name => ({ name })) }); return !x.ok && /room for four/.test(x.problems.join(" ")) && x.text[T.tenant4] === "D"; })());
ok("a rent amount without its period is refused", !dccv115Values({ ...good, claim: { rent: { amount: 500 }, lateFees: { amount: 0 } } }).ok);
ok("the three kinds of electronic delivery and two on paper are all offered", NOTICE_METHODS.length === 5 && NOTICE_METHODS.filter(m => m.electronic).length === 3);

// ── the court's own PDF
const formBytes = fs.readFileSync(new URL("../public/dccv115.pdf", import.meta.url));
ok("the bundled form is the court's file, byte for byte", crypto.createHash("sha256").update(formBytes).digest("hex") === DCCV115.sha256);
const blank = await PDFLib.PDFDocument.load(formBytes);
const fieldNames = new Set(blank.getForm().getFields().map(f => f.getName()));
ok("every field the app fills exists on the court's form", [...Object.values(T), ...Object.values(K)].every(nm => fieldNames.has(nm)), [...Object.values(T), ...Object.values(K)].filter(nm => !fieldNames.has(nm)).join(", "));
ok("the form says which revision it is", /Rev\. 10\/2024/.test(DCCV115.revision));
val = dccv115Values({ ...good, tenants: [{ name: "Pat “Lee” Tenant — Jr 🙂" }] });
const editable = await PDFLib.PDFDocument.load(await fillDccv115(PDFLib, formBytes, val, { flatten: false }));
const f = editable.getForm();
ok("the values land in the PDF's fields", f.getTextField(T.rent).getText() === "3,600.00" && f.getTextField(T.total).getText() === "3,690.00" && f.getTextField(T.noticeDate).getText() === "10/02/2026" && f.getCheckBox(K.mail).isChecked() && !f.getCheckBox(K.posted).isChecked() && f.getCheckBox(K.rentMonths).isChecked());
ok("a name with characters the PDF font lacks is written safely, not refused", f.getTextField(T.tenant1).getText() === 'Pat "Lee" Tenant - Jr ?', f.getTextField(T.tenant1).getText());
ok("the court's Reset button is removed", !editable.getForm().getFields().some(x => x.getName() === "Reset"));
const flat = await PDFLib.PDFDocument.load(await fillDccv115(PDFLib, formBytes, val));
ok("what is served is flattened: one page, nothing left to edit", flat.getPageCount() === 1 && flat.getForm().getFields().length === 0);
const other = await PDFLib.PDFDocument.create(); other.addPage();
let threw = "";
try { await fillDccv115(PDFLib, await other.save(), val); } catch (err) { threw = err.message; }
ok("a form the court has changed is refused, never guessed at", /has changed/.test(threw) && /by hand/.test(threw), threw);
ok("text is made safe for the PDF's fonts", pdfSafe("“a” — b… ✓") === '"a" - b... ?' && pdfSafe(null) === "" && pdfSafe("José") === "José");

// ── the complaint worksheet
const w = { landlord: good.landlord, tenants: good.tenants, premises: good.premises, court: courtFor("Prince George's"), license: { number: "RL-2291", expires: "2027-03-31" }, lead: { number: "MDE-5521" }, monthlyRent: 1800, dueDay: 1, claim, notice: { providedOn: "2026-10-02", method: "mail", today: "2026-10-14" }, military: "none", signer: { name: "Staff" } };
let sheet = dccv082Lines(w);
const line = (label) => sheet.lines.find(l => l.label.startsWith(label));
ok("a complete worksheet has nothing to check", sheet.problems.length === 0, sheet.problems.join(" | "));
ok("subtotal is rent plus late fees; total adds nothing when future rent is not asked for", sheet.subtotal === 3690 && sheet.total === 3690 && line("SUBTOTAL").value === "$3,690.00" && line("TOTAL").value === "$3,690.00");
ok("the form's numbered questions are answered in order", sheet.lines.map(l => l.no).filter(Boolean).join(",") === "1,2,3,4,5,5,5,5,5,6,7,8,9,11");
ok("the licence number and its expiration are given", /RL-2291, expires 03\/31\/2027/.test(line("Required to be licensed").value));
ok("the lead certificate number is given", /MDE-5521/.test(line("Lead paint").value));
ok("the rent, its due day and the months unpaid are given", /\$1,800\.00, due on the 1st/.test(line("Rent the tenant").value) && line("Rent is due for").value === "09/01/2026 to 10/31/2026");
ok("the notice's date and method are carried from step one", /10\/02\/2026, by first-class mail/.test(line("Notice of Intent").value));
sheet = dccv082Lines({ ...w, futureRent: 1800 });
ok("rent to the trial date is added to the total, not the subtotal", sheet.subtotal === 3690 && sheet.total === 5490 && /Requested: \$1,800\.00/.test(sheet.lines.find(l => l.no === "7").value));
sheet = dccv082Lines({ ...w, license: {}, lead: {}, military: "", court: "" });
ok("a missing licence, lead certificate, court or military answer is each called out", sheet.problems.length === 4 && /NOT ON FILE/.test(sheet.lines.find(l => l.no === "2").value) && /NOT ON FILE/.test(sheet.lines.find(l => l.no === "3").value), sheet.problems.join(" | "));
ok("'not affected' and an exemption reason answer those questions", dccv082Lines({ ...w, license: { exemptReason: "owner-occupied" }, lead: { notAffected: true } }).problems.length === 0);
ok("an expired licence is called out", /expired 03\/31\/2026/.test(dccv082Lines({ ...w, license: { number: "RL-1", expires: "2026-03-31" } }).problems.join(" ")));
ok("no unpaid rent: no complaint", /needs unpaid rent/.test(dccv082Lines({ ...w, claim: { rent: { amount: 0 }, lateFees: { amount: 90, from: "2026-09-01", to: "2026-09-30" } } }).problems.join(" ")));
ok("a subsidized tenancy is stated and warns to enter only the tenant's portion", /IS a government subsidized tenancy \(housing voucher\)/.test(dccv082Lines({ ...w, subsidized: true, subsidyKind: "housing voucher" }).lines.find(l => l.label.startsWith("Government")).value));
ok("day-of-month wording", /2nd of/.test(dccv082Lines({ ...w, dueDay: 2 }).lines[9].value) && /3rd of/.test(dccv082Lines({ ...w, dueDay: 3 }).lines[9].value) && /11th of/.test(dccv082Lines({ ...w, dueDay: 11 }).lines[9].value) && /21st of/.test(dccv082Lines({ ...w, dueDay: 21 }).lines[9].value));
sheet = dccv082Lines(w);
let pdf = await PDFLib.PDFDocument.load(await worksheetPdf(PDFLib, { title: "Worksheet", subtitle: "x", lines: sheet.lines, warnings: ["check “this”"], footer: "Not the court form." }));
ok("the worksheet is a real PDF", pdf.getPageCount() >= 1 && pdf.getTitle() === "Worksheet");
pdf = await PDFLib.PDFDocument.load(await worksheetPdf(PDFLib, { title: "Long", lines: Array.from({ length: 60 }, (_, i) => ({ no: String(i), label: "Question " + i, value: "Answer ".repeat(30) })) }));
ok("a long worksheet runs onto more pages instead of off the bottom", pdf.getPageCount() > 2);

// ── wiring
const data = read("src/utils/ftprData.js"), ui = read("src/components/FtprFiling.js"), life = read("src/components/Lifecycle.js"), tenants = read("src/components/Tenants.js"),
  mig = read("supabase/migrations/20261003080000_ftpr_cases.sql"), docs = read("src/components/Documents.js"), forms = read("src/utils/courtForms.js");
ok("the amounts come from posted entries on the tenant's own receivable account", /from\("acct_accounts"\)\.select\("id"\)\.eq\("company_id", companyId\)\.eq\("tenant_id", tenantId\)/.test(data) && /\.eq\("acct_journal_entries\.status", "posted"\)/.test(data));
ok("the notice does not change the tenant's status (it is not a notice to vacate)", !/from\("tenants"\)\.update/.test(data) && !/from\("tenants"\)\.update/.test(ui));
ok("the case keeps a snapshot of what was claimed and how the notice was provided", /claim_detail: \{ notice: snapshot\(claim\) \}/.test(data) && /notice_served_on: noticeDate, notice_served_method: method, notice_doc_id: stored\.docId/.test(data));
ok("the document is linked to the tenant, lease, property and case, and recorded as served", /doc_kind: kind/.test(data) && /eviction_case_id: caseId/.test(data) && /served_at: noticeDate \+ "T12:00:00", served_method: method, effective_date: deadline/.test(data));
ok("a document whose PDF could not be stored is taken back", /if \(up\.error\) \{\s+await supabase\.from\("doc_generated"\)\.update\(\{ archived_at:/.test(data));
ok("a second notice on a case still at the notice stage restarts the ten days; one in court is left alone", /const early = \["notice", "cure_period"\]\.includes\(ctx\.openCase\.current_stage\)/.test(data));
ok("the complaint cannot be made before the ten days are up, without rent owed, or without the military answer", /if \(!ready\.ready\) hard\.push\(ready\.reason\)/.test(ui) && /No rent is past due any more/.test(ui) && /Say what is known about military service/.test(forms));
ok("a filing cannot be dated inside the ten days", /evCase\.cure_deadline && filedOn <= evCase\.cure_deadline/.test(ui));
ok("the form is Maryland-only and says so for another state", /state !== "MD"/.test(ui) && /This home is not in Maryland/.test(ui));
ok("the complaint is filled on the court's e-filing form, and the paper worksheet stays for the counter", /fillDccv082\(PDFLib, await res\.arrayBuffer\(\), values\)/.test(ui) && /Worksheet for the paper form/.test(ui) && /carbonless multi-part/.test(forms));

// ── the complaint (DC-CV-082, e-filing version) and the warrant petition (DC-CV-081)
const { DCCV082, DCCV081, dccv082Values, fillDccv082, dccv081Values, fillDccv081, districtsFor } = await import("../src/utils/courtForms.js");
const bytes082 = fs.readFileSync(new URL("../public/dccv082.pdf", import.meta.url)), bytes081 = fs.readFileSync(new URL("../public/dccv081.pdf", import.meta.url));
ok("the bundled complaint and petition are the court's files, byte for byte", crypto.createHash("sha256").update(bytes082).digest("hex") === DCCV082.sha256 && crypto.createHash("sha256").update(bytes081).digest("hex") === DCCV081.sha256);
ok("the court locations come from the form's own list, narrowed to the property's county", districtsFor("Prince George's").length === 2 && districtsFor("Prince George's County")[1] === "Prince George's County - Upper Marlboro" && districtsFor("Montgomery").length === 2 && districtsFor("Baltimore City").length === 4 && districtsFor("", "Baltimore").length === 4 && districtsFor("Howard")[0] === "Howard County" && districtsFor("").length === 0);
const c82 = { district: "Prince George's County - Upper Marlboro", landlord: { name: "Acme Homes LLC", address: "100 Main St", city: "Bowie", state: "MD", zip: "20715" }, tenants: [{ name: "Pat Tenant" }, { name: "Sam Tenant" }], premises: { address: "22 Oak Ct", city: "Bowie", state: "MD", zip: "20715" },
  license: { status: "yes", number: "RL-2291", expires: "2027-03-31" }, lead: { status: "not_affected" }, monthlyRent: 1800, dueDay: 1, claim, utilityCredits: 100, futureRent: 1800, military: "none", militaryFacts: "DOD SCRA search 10/14/2026", notice: { providedOn: "2026-10-02", method: "mail" }, signer: { name: "Staff", address: "100 Main St", phone: "301" }, signedDate: "2026-10-14" };
let v82 = dccv082Values(c82);
ok("a complete complaint has no problems", v82.ok, v82.problems.join(" | "));
ok("net rent takes off utility credits; subtotal adds late fees; total adds rent to the trial date", v82.net === 3500 && v82.subtotal === 3590 && v82.total === 5390 && v82.text[DCCV082.text.netRent] === "3,500.00" && v82.text[DCCV082.text.total] === "5,390.00");
ok("the court goes in the form's dropdown; the licence, the notice date and method, the signer go in their fields", v82.dropdowns.District === "Prince George's County - Upper Marlboro" && /RL-2291, expires 03\/31\/2027/.test(v82.text[DCCV082.text.licenseNumber]) && v82.text[DCCV082.text.noticeDate] === "10/02/2026" && v82.checks.includes(DCCV082.checks.noticeMail) && v82.checks.includes(DCCV082.checks.licenseYes) && v82.checks.includes(DCCV082.checks.leadNotAffected) && v82.checks.includes(DCCV082.checks.noMilitary) && v82.checks.includes(DCCV082.checks.futureRent) && v82.checks.includes(DCCV082.checks.notSubsidized) && v82.checks.includes(DCCV082.checks.perMonth));
ok("'no tenant is in the military' needs the facts; 'unable to determine' does not", !dccv082Values({ ...c82, militaryFacts: "" }).ok && dccv082Values({ ...c82, military: "unknown", militaryFacts: "" }).ok);
ok("a voucher tenancy ticks subsidized and Section 8", (() => { const x = dccv082Values({ ...c82, subsidized: true }); return x.checks.includes(DCCV082.checks.subsidized) && x.checks.includes(DCCV082.checks.section8) && !x.checks.includes(DCCV082.checks.notSubsidized); })());
ok("unlicensed-for-a-reason and lead 'owner unable' tick their boxes", (() => { const x = dccv082Values({ ...c82, license: { status: "unlicensed", reason: "other", text: "owner-occupied" }, lead: { status: "owner_unable", reason: "non_cooperation" } }); return x.ok && x.checks.includes(DCCV082.checks.unlicensed) && x.checks.includes(DCCV082.checks.unlicensedOther) && x.text[DCCV082.text.licenseOther] === "owner-occupied" && x.checks.includes(DCCV082.checks.leadOwnerUnable) && x.checks.includes(DCCV082.checks.leadNonCooperation); })());
ok("a missing court, licence number, rent or notice each stop the complaint", [{ district: "" }, { license: { status: "yes", number: "" } }, { claim: { rent: { amount: 0 }, lateFees: { amount: 0 } } }, { notice: {} }, { monthlyRent: 0 }].every(o => !dccv082Values({ ...c82, ...o }).ok));
const f82 = await PDFLib.PDFDocument.load(await fillDccv082(PDFLib, bytes082, v82), { ignoreEncryption: true });
ok("the values land on the court's e-filing form (all five pages kept, fields left fillable for the clerk)", f82.getPageCount() === 5 && f82.getForm().getTextField("Text58").getText() === "5,390.00" && f82.getForm().getCheckBox("Check Box8").isChecked() && f82.getForm().getDropdown("District").getSelected()[0] === "Prince George's County - Upper Marlboro" && !f82.getForm().getFields().some(x => x.getName() === "Reset"));
let v81 = dccv081Values({ district: "Prince George's County - Upper Marlboro", caseNumber: "D-05-CV-26-001234", landlord: { name: "Acme Homes LLC", address: "100 Main St", city: "Bowie", state: "MD", zip: "20715" }, tenants: [{ name: "Pat Tenant" }], premises: { address: "22 Oak Ct", city: "Bowie", state: "MD", zip: "20715" }, judgmentDate: "2026-11-05", amountDue: 5390, costs: 46, amountPaid: 500, signer: { name: "Staff" }, signedDate: "2026-11-20" });
ok("the petition carries the judgment, the amount, what was paid since and the balance", v81.ok && v81.balance === 4890 && v81.text[DCCV081.text.balance] === "4,890.00" && v81.text[DCCV081.text.judgmentDate] === "11/05/2026" && v81.checks.includes(DCCV081.checks.hasPaid) && v81.checks.includes(DCCV081.checks.failureToPayRent) && v81.checks.includes(DCCV081.checks.orderedPossession), v81.problems.join(" | "));
ok("the petition needs the case number and the judgment date", !dccv081Values({ ...{ district: "Howard County", caseNumber: "", judgmentDate: "2026-11-05", amountDue: 10, tenants: [{ name: "A" }], landlord: { name: "L" }, premises: { address: "x" }, signer: { name: "S" } } }).ok && !dccv081Values({ district: "Howard County", caseNumber: "1", judgmentDate: "", amountDue: 10, tenants: [{ name: "A" }], landlord: { name: "L" }, premises: { address: "x" }, signer: { name: "S" } }).ok);
const f81 = await PDFLib.PDFDocument.load(await fillDccv081(PDFLib, bytes081, v81), { ignoreEncryption: true });
ok("the values land on the court's petition form", f81.getPageCount() === 2 && f81.getForm().getTextField("Amount of Balance").getText() === "4,890.00" && f81.getForm().getTextField("Case Number").getText() === "D-05-CV-26-001234" && !f81.getForm().getFields().some(x => x.getName() === "Reset Form"));
ok("the tenant page and the Document Builder point at the court forms", /Notice of Intent to File \(DC-CV-115\)…/.test(tenants) && /Warrant of Restitution \(DC-CV-082, 081\)…/.test(tenants) && /Court forms \(Maryland\)/.test(docs) && /Petition for Warrant of Restitution \(DC-CV-081\)/.test(ui));
ok("'Prepare filing' on a tenant carries that tenant into the flow", /onPrepareFiling=\{t => setPage\("evictions", \{ tenantId: \(t \|\| selectedTenant\)\.id \}\)\}/.test(tenants) && /setFtprTenantId\(initialAction\.tenantId\)/.test(life));
ok("the case screen shows the failure-to-pay panel and passes 'tenant paid'", /<FtprCasePanel evCase=\{selectedCase\}/.test(life) && /onClosePaid=\{\(c\) => closeCase\(c, "tenant_cured"\)\}/.test(life));
ok("closing as paid records the day and does not touch a status the notice never changed", /cured_on: formatLocalDate\(new Date\(\)\)/.test(life) && /evCase\.tenant_id && evCase\.notice_type !== "notice_of_intent"/.test(life));
ok("the generic 'pay or quit' printout is not offered for a Maryland failure-to-pay case", /selectedCase\.reason === "non_payment" && !\/, \(VA\|DC\)\\b\/\.test\(selectedCase\.property \|\| ""\)/.test(life));
ok("a court form in History opens the stored PDF and is not re-rendered or emailed", /d\.output_type === "court_form" \? \(/.test(docs));
ok("the migration is additive, with real links, and needs no approval prompt (no DROP)", !/\bDROP\b/.test(mig) && /eviction_cases_notice_doc_id_fkey/.test(mig) && /ADD COLUMN IF NOT EXISTS case_number text/.test(mig));
ok("the clock says when the ten days are up, and its button opens that case", /'ftpr_deadline:' \|\| e\.id::text/.test(mig) && /e\.cure_deadline < v_today/.test(mig) && !!CLOCK_KINDS.ftpr_deadline && clockAction({ kind: "ftpr_deadline", item_key: "ftpr_deadline:abc-123" }).action.openCaseId === "abc-123" && clockAction({ kind: "ftpr_deadline", item_key: "" }).page === "evictions");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
