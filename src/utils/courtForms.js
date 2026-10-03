// Maryland failure-to-pay-rent paperwork. Pure: no database, no React; the
// PDF library is handed in, so the same code fills the form in a browser
// and in a test.
//
// DC-CV-115, Notice of Intent to File a Complaint for Summary Ejectment
// (Failure to Pay Rent), Real Property 8-401(c). The court publishes it as
// a fillable PDF; public/dccv115.pdf is that file, unchanged, and
// this fills in its own fields. If the court revises the form the field
// names below stop matching and filling REFUSES rather than guesses.
//
// DC-CV-082, the complaint itself, cannot be filled in here at all: the
// court's own copy says "This form is not printable, and cannot be
// completed online... The Court requires the carbonless multi-part form".
// So the app makes a WORKSHEET: every answer the form asks for, numbered
// as on the form, to copy onto the court's paper (or key into e-filing).
import { money } from "./arrears.js";

export const NOTICE_DAYS = 10;                      // RP 8-401(c) [LAW]
export const DCCV115 = {
  // At the site root on purpose: the single-page-app rewrite in vercel.json
  // leaves root files with an extension alone.
  file: "/dccv115.pdf",
  revision: "DC-CV-115 (Rev. 10/2024)",
  sha256: "f99ff6d21fe93c77f640e03f247dc8b9954e965eec6852e29fd75c3ed8085fbd",
  text: {
    landlordName: "Landlord/Agent Name", landlordAddress: "Landlord/Agent Address", landlordCityStateZip: "City, State, Zip",
    landlordPhone: "Landlord/Agent Telephone Number", landlordEmail: "E-mail Address",
    tenant1: "Tenant #1", tenant2: "Tenant #2", tenant3: "Tenant #3", tenant4: "Tenant #4",
    tenantAddress: "Tenant Address", tenantCityStateZip: "City, State, Zip_1", tenantPhone: "Tenant Telephone Number",
    tenantEmail1: "Tenant Email Address #1", tenantEmail2: "Tenant Email Address #2", tenantEmail3: "Tenant Email Address #3", tenantEmail4: "Tenant Email Address #4",
    rent: "Past-due rent", rentFrom: "From (Day)", rentTo: "To (Day)",
    lateFees: "Late Fees", feesFrom: "From (day)_1", feesTo: "to (day)_1",
    total: "Total Due",
    contactPhone: "Phone Number", contactEmail: "E-mail", contactAddress: "Address",
    noticeDate: "Date of Notice Provided", signedDate: "Date_2", signature: "Signature of Landlord/Attorney/Agent", attorneyNumber: "Attorney Number",
  },
  checks: {
    rentMonths: "checkbox31", rentWeeks: "Check Box32", feesMonths: "Check Box33", feesWeeks: "Check Box34",
    mail: "Check Box35", posted: "Check Box36", electronic: "Check Box37", email: "Check Box38", text: "Check Box39", portal: "Check Box40",
  },
  remove: ["Reset"],
};

// DC-CV-082, the complaint, in the version the court publishes for MDEC
// e-filing ("bulk filing"): a fillable PDF, three copies of the complaint
// (one set of fields fills all three), a return-of-service page for the
// process server and the notice to the tenant. public/dccv082.pdf is the
// court's file, unchanged. The counter still wants its carbonless paper
// form; this one is for e-filing (or to copy from).
export const DCCV082 = {
  file: "/dccv082.pdf",
  revision: "DC-CV-082 (Rev. 10/01/2024), MDEC bulk-filing version",
  sha256: "9f6b81d883666fbaaf304e2e9026f272f8d7bb227083f89c55aaff4f5ba9abfa",
  text: {
    courtAddress: "Court Address",
    landlordName: "Text2", landlordAddress: "Text3", landlordCity: "Text4", landlordState: "Text5", landlordZip: "Text6",
    tenant1: "Text7", tenant2: "Text8", tenant3: "Text9", tenant4: "Text10",
    tenantAddress: "Text11", tenantCity: "Text12", tenantState: "Text13", tenantZip: "Text14",
    propertyName: "Text24", propertyAddress: "Text25",
    licenseNumber: "Text30", licenseOther: "T 100", mdeCertificate: "Text36",
    rent: "Text45", dueDay: "Text46", rentMonths: "Text47", rentTotal: "Text48", utilityCredits: "Text49", netRent: "Text50",
    lateMonths: "Text54", lateAmount: "Text51", subtotal: "Text52", futureRent: "Text53", total: "Text58",
    priorJudgments: "Text59", militaryFacts: "Text65", noticeDate: "Text70",
    signerName: "Text71", signature: "Text72", attorneyNumber: "Text73", signedDate: "Text74", signerAddress: "Text75", signerPhone: "Text76",
  },
  checks: {
    licenseNo: "Check Box28", licenseYes: "Check Box29", unlicensed: "Check Box26", unlicensedExempt: "Check 27", unlicensedReasons: "Check 28", unlicensedOther: "Check 29",
    leadNotAffected: "Check Box31", leadAffected: "Check Box32", leadRegistrationCurrent: "Check Box33", leadOwnerUnable: "Check Box37", leadExempt: "Check 34", leadNonCooperation: "Check 35",
    moneyJudgment: "Check Box38",
    notSubsidized: "Check Box39", subsidized: "Check Box40", section8: "Check Box34", subsidyOther: "Check Box35",
    perWeek: "Check Box41", perMonth: "Check Box42", rentWeeks: "Check Box43", rentMonths: "Check Box44", lateWeeks: "Check Box55", lateMonths: "Check Box56",
    futureRent: "Check Box57", deceased: "Check Box60", dodVerified: "Check Box61",
    allTenantsListed: "Check Box6", someMilitary: "Check Box9", noMilitary: "Check Box5", unknownMilitary: "Check Box7",
    noticeMail: "Check Box8", noticePosted: "Check Box10", noticeElectronic: "Check Box11",
  },
  dropdowns: { district: "District" },
  remove: ["Reset"],
  // The court locations the form itself offers.
  districts: ["Allegany County", "Anne Arundel County - Annapolis", "Anne Arundel County - Glen Burnie", "Baltimore City - Eastside", "Baltimore City - Hubbard", "Baltimore City - Hargrove", "Baltimore City - Wabash", "Baltimore County - Catonsville", "Baltimore County - Essex", "Baltimore County - Towson", "Calvert County", "Caroline County", "Carroll County", "Cecil County", "Charles County", "Dorchester County", "Frederick County", "Garrett County", "Harford County", "Howard County", "Kent County", "Montgomery County - Rockville", "Montgomery County - Silver Spring", "Prince George's County - Hyattsville", "Prince George's County - Upper Marlboro", "Queen Anne's County", "Somerset County", "St. Mary's County", "Talbot County", "Washington County", "Wicomico County", "Worcester County - Ocean City", "Worcester County - Snow Hill"],
};
/** The court locations that serve a county (the form's own names). */
export function districtsFor(county, city = "") {
  const c = String(county || "").replace(/\s+county$/i, "").trim().toLowerCase();
  const key = /^baltimore city$/.test(c) || (!c && /^baltimore$/i.test(String(city).trim())) ? "baltimore city" : c;
  if (!key) return [];
  return DCCV082.districts.filter(d => d.toLowerCase().startsWith(key));
}

/**
 * What goes in each field of the DC-CV-082 (e-filing version).
 * Inputs are what the dialog collects; see FtprFiling.js.
 * @returns {{ ok, problems: string[], text, checks: string[], dropdowns, total, subtotal }}
 */
export function dccv082Values({
  district = "", courtAddress = "", landlord = {}, tenants = [], premises = {}, propertyName = "",
  license = { status: "yes", number: "", expires: "", reason: "" },      // status: yes | no | unlicensed (reason: exempt | reasons | other + text)
  lead = { status: "not_affected", certificate: "", reason: "" },        // status: not_affected | affected | owner_unable (reason: exempt | non_cooperation)
  moneyJudgment = false, subsidized = false, subsidyKind = "s8",
  monthlyRent = 0, dueDay = 1, perWeek = false, claim, utilityCredits = 0, futureRent = 0,
  priorJudgments = "", deceased = false, military = "", militaryFacts = "", dodVerified = false, allTenantsListed = true,
  notice = {}, signer = {}, signature = "", signedDate = "",
} = {}) {
  const T = DCCV082.text, C = DCCV082.checks, problems = [], text = {}, checks = [], dropdowns = {};
  const put = (key, v) => { const s = String(v ?? "").trim(); if (s) text[T[key]] = s; };
  const tick = (key) => checks.push(C[key]);
  const names = (tenants || []).map(t => String(t?.name || "").trim()).filter(Boolean);
  const rent = money(claim?.rent?.amount), fees = money(claim?.lateFees?.amount), credits = money(utilityCredits);
  const net = money(rent - credits), subtotal = money(net + fees), future = money(futureRent), total = money(subtotal + future);
  const period = (c) => (c && isIso(c.from) && isIso(c.to) ? usDate(c.from) + " to " + usDate(c.to) : "");

  if (!DCCV082.districts.includes(district)) problems.push("Choose the court (the District Court location for the property's county).");
  if (!String(landlord.name || "").trim() || !String(landlord.address || "").trim()) problems.push("The landlord's name and address are missing (Settings › Company Details).");
  if (!names.length) problems.push("There is no tenant to name.");
  if (names.length > 4) problems.push("The form has room for four tenants; this tenancy has " + names.length + ".");
  if (!String(premises.address || "").trim()) problems.push("The address of the rented home is missing.");
  if (!(rent > 0)) problems.push("No rent is past due. A failure-to-pay-rent complaint needs unpaid rent.");
  if (rent > 0 && !period(claim?.rent)) problems.push("The period the unpaid rent covers is missing.");
  if (license.status === "yes" && !String(license.number || "").trim()) problems.push("The rental licence number is missing. Enter it, or say the property is not required to be licensed.");
  if (license.status === "unlicensed" && license.reason === "other" && !String(license.text || "").trim()) problems.push("Say why the property is unlicensed.");
  if (lead.status === "affected" && !String(lead.certificate || "").trim()) problems.push("The MDE lead inspection certificate number is missing.");
  if (!["none", "some", "unknown"].includes(military)) problems.push("Say what is known about military service.");
  if (military === "none" && !String(militaryFacts || "").trim()) problems.push("The form requires the facts supporting 'no tenant is in the military service' (e.g. 'DOD SCRA search on <date>, no active duty found').");
  if (!isIso(notice.providedOn) || !noticeMethod(notice.method)) problems.push("The date and method of the Notice of Intent are not recorded.");
  if (!String(signer.name || "").trim()) problems.push("The signer's name is missing.");
  if (!(Number(monthlyRent) > 0)) problems.push("The monthly rent is missing.");

  dropdowns[DCCV082.dropdowns.district] = DCCV082.districts.includes(district) ? district : " ";
  put("courtAddress", courtAddress);
  put("landlordName", landlord.name); put("landlordAddress", landlord.address);
  put("landlordCity", landlord.city); put("landlordState", landlord.state); put("landlordZip", landlord.zip);
  names.slice(0, 4).forEach((n, i) => put("tenant" + (i + 1), n));
  put("tenantAddress", premises.address); put("tenantCity", premises.city); put("tenantState", premises.state); put("tenantZip", premises.zip);
  put("propertyName", propertyName); put("propertyAddress", [premises.address, premises.city].filter(Boolean).join(", "));
  if (license.status === "no") tick("licenseNo");
  else if (license.status === "unlicensed") { tick("unlicensed"); tick(license.reason === "exempt" ? "unlicensedExempt" : license.reason === "reasons" ? "unlicensedReasons" : "unlicensedOther"); if (license.reason === "other") put("licenseOther", license.text); }
  else { tick("licenseYes"); put("licenseNumber", [license.number, license.expires && isIso(license.expires) ? "expires " + usDate(license.expires) : license.expires].filter(Boolean).join(", ")); }
  if (lead.status === "affected") { tick("leadAffected"); tick("leadRegistrationCurrent"); put("mdeCertificate", lead.certificate); }
  else if (lead.status === "owner_unable") { tick("leadAffected"); tick("leadOwnerUnable"); tick(lead.reason === "non_cooperation" ? "leadNonCooperation" : "leadExempt"); }
  else tick("leadNotAffected");
  if (moneyJudgment) tick("moneyJudgment");
  if (subsidized) { tick("subsidized"); tick(subsidyKind === "other" ? "subsidyOther" : "section8"); } else tick("notSubsidized");
  put("rent", usMoney(monthlyRent)); put("dueDay", ordinal(dueDay)); tick(perWeek ? "perWeek" : "perMonth");
  tick(perWeek ? "rentWeeks" : "rentMonths"); put("rentMonths", period(claim?.rent)); put("rentTotal", usMoney(rent));
  put("utilityCredits", credits > 0 ? usMoney(credits) : ""); put("netRent", usMoney(net));
  if (fees > 0) { tick(perWeek ? "lateWeeks" : "lateMonths"); put("lateMonths", period(claim?.lateFees)); put("lateAmount", usMoney(fees)); }
  put("subtotal", usMoney(subtotal));
  if (future > 0) { tick("futureRent"); put("futureRent", usMoney(future)); }
  put("total", usMoney(total));
  put("priorJudgments", priorJudgments);
  if (deceased) tick("deceased");
  if (dodVerified) tick("dodVerified");
  if (allTenantsListed && names.length <= 4) tick("allTenantsListed");
  if (military === "some") tick("someMilitary"); else if (military === "none") { tick("noMilitary"); put("militaryFacts", militaryFacts); } else if (military === "unknown") tick("unknownMilitary");
  put("noticeDate", usDate(notice.providedOn));
  const m = noticeMethod(notice.method);
  if (m) tick(m.key === "mail" ? "noticeMail" : m.key === "posted" ? "noticePosted" : "noticeElectronic");
  put("signerName", signer.name); put("signature", signature); put("attorneyNumber", signer.attorneyNumber);
  put("signedDate", usDate(signedDate)); put("signerAddress", signer.address); put("signerPhone", signer.phone);
  return { ok: problems.length === 0, problems, text, checks, dropdowns, subtotal, total, net };
}

/**
 * Fill the court's e-filing PDF. Left fillable (not flattened): the clerk's
 * and the process server's parts are still to be written on it.
 */
export async function fillDccv082(PDFLib, bytes, values) {
  const pdf = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = pdf.getForm();
  const have = new Set(form.getFields().map(f => f.getName()));
  const need = [...Object.values(DCCV082.text), ...Object.values(DCCV082.checks), ...Object.values(DCCV082.dropdowns)];
  const missing = need.filter(n => !have.has(n));
  if (missing.length) throw new Error("The court's complaint form has changed and can no longer be filled in automatically (missing: " + missing.slice(0, 3).join(", ") + "). Download the current DC-CV-082 from mdcourts.gov and fill it in by hand.");
  for (const [name, value] of Object.entries(values.text || {})) form.getTextField(name).setText(pdfSafe(value));
  for (const name of values.checks || []) form.getCheckBox(name).check();
  for (const [name, value] of Object.entries(values.dropdowns || {})) { try { form.getDropdown(name).select(value); } catch (_e) { /* a location the form does not list */ } }
  for (const name of DCCV082.remove) { if (have.has(name)) { try { form.removeField(form.getField(name)); } catch (_e) { /* harmless */ } } }
  pdf.setTitle("Failure to Pay Rent - Landlord's Complaint for Repossession of Rented Property (DC-CV-082)");
  return pdf.save({ updateFieldAppearances: true });
}

// DC-CV-081, Petition for Warrant of Restitution: after judgment for
// possession, the ask for the warrant the sheriff acts on. Fillable;
// public/dccv081.pdf is the court's file, unchanged.
export const DCCV081 = {
  file: "/dccv081.pdf",
  revision: "DC-CV-081, Petition for Warrant of Restitution (court form, 2 pages)",
  sha256: "ff25db87f65dc16a05a1a006dba734029c320a8ef1e9e26fd8670d022b01685d",
  text: {
    courtAddress: "Court Address", courtPhone: "Court Telephone Number", caseNumber: "Case Number",
    landlordName: "Plaintiff/Landlord/Agent Name", landlordAddress: "Plaintiff/Landlord/Agent Street Address", landlordCity: "Plaintiff/Landlord/Agent City", landlordState: "Plaintiff/Landlord/Agent State", landlordZip: "Plaintiff/Landlord/Agent Zip",
    tenant1: "Defendant/Tenant 1 Name", tenant2: "Defendant/Tenant 2 Name", tenant3: "Defendant/Tenant 3 Name", tenant4: "Defendant/Tenant 4 Name",
    tenantAddress: "Defendant(s)/Tenant(s) Street Address", tenantCity: "Defendant(s)/Tenant(s) City", tenantState: "Defendant(s)/Tenant(s) State", tenantZip: "Defendant(s)/Tenant(s) Zip",
    judgmentDate: "Date", amountDue: "Amount Due", costs: "Amount of Costs", premises: "Description of premises", amountPaid: "Amount Paid", balance: "Amount of Balance",
    signedDate: "Date of Signature", signature: "Signature of Plaintiff/ Landlord/Agent/Attorney", attorneyNumber: "Attorney Number",
    phone: "Telephone Number", signerName: "Printed Name", fax: "Fax", signerAddress: "Street Address", email: "E-mail", signerCityStateZip: "City, State, Zip",
  },
  checks: { failureToPayRent: "Failure to Pay Rent", otherCase: "Other Case Types", determinedAmount: "Determined the amount due to be", orderedPossession: "Ordered that possession of the premises described as", noRightToRedeem: "Found the defendant/tenant does not have the right to redeem", hasPaid: "Has paid (if any)" },
  dropdowns: { district: "City/County" },
  remove: ["Reset Form"],
};
/**
 * What goes in each field of the DC-CV-081.
 * @returns {{ ok, problems, text, checks, dropdowns }}
 */
export function dccv081Values({ district = "", courtAddress = "", courtPhone = "", caseNumber = "", landlord = {}, tenants = [], premises = {}, judgmentDate = "", amountDue = 0, costs = 0, premisesDescription = "", noRightToRedeem = false, amountPaid = 0, signer = {}, signedDate = "", signature = "" } = {}) {
  const T = DCCV081.text, C = DCCV081.checks, problems = [], text = {}, checks = [], dropdowns = {};
  const put = (key, v) => { const s = String(v ?? "").trim(); if (s) text[T[key]] = s; };
  const names = (tenants || []).map(t => String(t?.name || "").trim()).filter(Boolean);
  const due = money(amountDue), paid = money(amountPaid), balance = money(Math.max(0, due - paid));
  if (!DCCV082.districts.includes(district)) problems.push("Choose the court.");
  if (!String(caseNumber || "").trim()) problems.push("The case number is missing (the court gave it when the complaint was filed).");
  if (!isIso(judgmentDate)) problems.push("The date of the judgment is missing.");
  if (!(due > 0)) problems.push("The amount the court determined to be due is missing.");
  if (!String(premisesDescription || premises.address || "").trim()) problems.push("The address of the rented home is missing.");
  if (!names.length) problems.push("There is no tenant to name.");
  if (names.length > 4) problems.push("The form has room for four tenants; this tenancy has " + names.length + ".");
  if (!String(landlord.name || "").trim()) problems.push("The landlord's name is missing (Settings › Company Details).");
  if (!String(signer.name || "").trim()) problems.push("The signer's name is missing.");
  dropdowns[DCCV081.dropdowns.district] = DCCV082.districts.includes(district) ? district : " ";
  put("courtAddress", courtAddress); put("courtPhone", courtPhone); put("caseNumber", caseNumber);
  put("landlordName", landlord.name); put("landlordAddress", landlord.address); put("landlordCity", landlord.city); put("landlordState", landlord.state); put("landlordZip", landlord.zip);
  names.slice(0, 4).forEach((n, i) => put("tenant" + (i + 1), n));
  put("tenantAddress", premises.address); put("tenantCity", premises.city); put("tenantState", premises.state); put("tenantZip", premises.zip);
  checks.push(C.failureToPayRent);
  put("judgmentDate", usDate(judgmentDate));
  checks.push(C.determinedAmount); put("amountDue", usMoney(due)); put("costs", usMoney(costs));
  checks.push(C.orderedPossession); put("premises", premisesDescription || [premises.address, premises.city, premises.state, premises.zip].filter(Boolean).join(", "));
  if (noRightToRedeem) checks.push(C.noRightToRedeem);
  if (paid > 0) { checks.push(C.hasPaid); put("amountPaid", usMoney(paid)); }
  put("balance", usMoney(balance));
  put("signedDate", usDate(signedDate)); put("signature", signature); put("attorneyNumber", signer.attorneyNumber);
  put("phone", signer.phone); put("signerName", signer.name); put("fax", signer.fax); put("signerAddress", signer.address); put("email", signer.email); put("signerCityStateZip", signer.cityStateZip);
  return { ok: problems.length === 0, problems, text, checks, dropdowns, balance };
}
export async function fillDccv081(PDFLib, bytes, values) {
  const pdf = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = pdf.getForm();
  const have = new Set(form.getFields().map(f => f.getName()));
  const need = [...Object.values(DCCV081.text), ...Object.values(DCCV081.checks), ...Object.values(DCCV081.dropdowns)];
  const missing = need.filter(n => !have.has(n));
  if (missing.length) throw new Error("The court's petition form has changed and can no longer be filled in automatically (missing: " + missing.slice(0, 3).join(", ") + "). Download the current DC-CV-081 from mdcourts.gov and fill it in by hand.");
  for (const [name, value] of Object.entries(values.text || {})) form.getTextField(name).setText(pdfSafe(value));
  for (const name of values.checks || []) form.getCheckBox(name).check();
  for (const [name, value] of Object.entries(values.dropdowns || {})) { try { form.getDropdown(name).select(value); } catch (_e) { /* not listed */ } }
  for (const name of DCCV081.remove) { if (have.has(name)) { try { form.removeField(form.getField(name)); } catch (_e) { /* harmless */ } } }
  pdf.setTitle("Petition for Warrant of Restitution (DC-CV-081)");
  return pdf.save({ updateFieldAppearances: true });
}

// How the notice may be provided, in the form's own words.
export const NOTICE_METHODS = [
  { key: "mail", label: "First-class mail, with a certificate of mailing", electronic: false },
  { key: "posted", label: "Affixed to the door of the leased property", electronic: false },
  { key: "email", label: "E-mail message", electronic: true },
  { key: "text", label: "Text message", electronic: true },
  { key: "portal", label: "Electronic tenant portal", electronic: true },
];
export const noticeMethod = (key) => NOTICE_METHODS.find(m => m.key === key) || null;

const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
/** 2026-10-02 -> 10/02/2026, the way a court form is written. */
export const usDate = (iso) => (isIso(iso) ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}` : "");
export const usMoney = (n) => money(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (n) => String(n).padStart(2, "0");
export function addDaysIso(iso, n) {
  if (!isIso(iso)) return "";
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + Math.floor(Number(n) || 0)));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
/** The last day the tenant may pay before a complaint can be filed. */
export const cureDeadline = (providedOn, days = NOTICE_DAYS) => addDaysIso(providedOn, days);
/** A complaint may be prepared only once the ten days have fully passed. */
export function complaintReadiness({ providedOn, today, days = NOTICE_DAYS }) {
  if (!isIso(providedOn)) return { ready: false, reason: "The Notice of Intent has not been provided to the tenant yet." };
  const deadline = cureDeadline(providedOn, days);
  if (!isIso(today) || today <= deadline) return { ready: false, deadline, reason: "The tenant has until the end of " + usDate(deadline) + " to pay. The complaint can be prepared from " + usDate(addDaysIso(deadline, 1)) + "." };
  return { ready: true, deadline };
}

/** "123 Main St, Bowie, MD 20715" -> { street, cityStateZip }. */
export function splitAddress(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  const m = s.match(/^(.*?),\s*([^,]+,\s*[A-Za-z]{2}\.?\s+\d{5}(?:-\d{4})?)$/);
  return m ? { street: m[1].trim(), cityStateZip: m[2].trim() } : { street: s, cityStateZip: "" };
}

/** The District Court that hears a failure-to-pay case: the county the property is in. */
export function courtFor(county, city = "") {
  const c = String(county || "").replace(/\s+county$/i, "").trim();
  if (/^baltimore city$/i.test(c) || (!c && /^baltimore$/i.test(String(city).trim()))) return "District Court of Maryland for Baltimore City";
  return c ? "District Court of Maryland for " + c + " County" : "";
}

/**
 * What goes in each field of the DC-CV-115.
 * @returns {{ ok, problems: string[], text: Object<fieldName,string>, checks: string[] }}
 */
export function dccv115Values({ landlord = {}, tenants = [], premises = {}, tenantPhone = "", claim, noticeDate, method, tenantAskedForElectronic = false, signature = "", signedDate = "", attorneyNumber = "" } = {}) {
  const T = DCCV115.text, C = DCCV115.checks, problems = [], text = {}, checks = [];
  const put = (key, v) => { const s = String(v ?? "").trim(); if (s) text[T[key]] = s; };
  const names = (tenants || []).map(t => ({ name: String(t?.name || "").trim(), email: String(t?.email || "").trim() })).filter(t => t.name);

  if (!String(landlord.name || "").trim()) problems.push("The landlord's name is missing (the company's name in Settings).");
  if (!String(landlord.address || "").trim()) problems.push("The landlord's address is missing (the company's address in Settings).");
  if (!names.length) problems.push("There is no tenant to give the notice to.");
  if (names.length > 4) problems.push("The form has room for four tenants; this tenancy has " + names.length + ". Add the others by hand.");
  if (!String(premises.address || "").trim()) problems.push("The address of the rented home is missing.");
  const rent = money(claim?.rent?.amount), fees = money(claim?.lateFees?.amount), total = money(rent + fees);
  if (!(total > 0)) problems.push("Nothing is past due, so there is nothing to give notice of.");
  if (rent > 0 && (!isIso(claim?.rent?.from) || !isIso(claim?.rent?.to))) problems.push("The period the unpaid rent covers is missing.");
  if (fees > 0 && (!isIso(claim?.lateFees?.from) || !isIso(claim?.lateFees?.to))) problems.push("The period the late fees cover is missing.");
  if (!isIso(noticeDate)) problems.push("Choose the date the notice is provided.");
  const m = noticeMethod(method);
  if (!m) problems.push("Choose how the notice is provided.");
  if (m && m.electronic && !tenantAskedForElectronic) problems.push("A notice may be sent electronically only at the tenant's request. Confirm the tenant asked for it, or choose mail or the door.");

  put("landlordName", landlord.name);
  put("landlordAddress", landlord.address); put("landlordCityStateZip", landlord.cityStateZip);
  put("landlordPhone", landlord.phone); put("landlordEmail", landlord.email);
  names.slice(0, 4).forEach((t, i) => { put("tenant" + (i + 1), t.name); put("tenantEmail" + (i + 1), t.email); });
  put("tenantAddress", premises.address); put("tenantCityStateZip", premises.cityStateZip); put("tenantPhone", tenantPhone);
  if (rent > 0) { put("rent", usMoney(rent)); put("rentFrom", usDate(claim.rent.from)); put("rentTo", usDate(claim.rent.to)); checks.push(C.rentMonths); }
  if (fees > 0) { put("lateFees", usMoney(fees)); put("feesFrom", usDate(claim.lateFees.from)); put("feesTo", usDate(claim.lateFees.to)); checks.push(C.feesMonths); }
  if (total > 0) put("total", usMoney(total));
  put("noticeDate", usDate(noticeDate));
  if (m) { if (m.electronic) checks.push(C.electronic, C[m.key]); else checks.push(C[m.key]); }
  put("signedDate", usDate(signedDate || noticeDate)); put("signature", signature); put("attorneyNumber", attorneyNumber);
  return { ok: problems.length === 0, problems, text, checks, total };
}

// The standard fonts in a PDF cover Latin-1 only. Anything else (a curly
// quote pasted into a name, an emoji) would make the library throw.
export const pdfSafe = (s) => String(s ?? "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/[^\x20-\x7E\xA0-\xFF]/gu, "?");

/**
 * Fill the court's own PDF. `PDFLib` is the pdf-lib module; `bytes` the
 * untouched form. Returns the filled, flattened PDF as bytes.
 */
export async function fillDccv115(PDFLib, bytes, values, { flatten = true } = {}) {
  const pdf = await PDFLib.PDFDocument.load(bytes);
  const form = pdf.getForm();
  const have = new Set(form.getFields().map(f => f.getName()));
  const need = [...Object.values(DCCV115.text), ...Object.values(DCCV115.checks)];
  const missing = need.filter(n => !have.has(n));
  if (missing.length) throw new Error("The court's form has changed and can no longer be filled in automatically (missing: " + missing.slice(0, 3).join(", ") + "). Download the current DC-CV-115 from mdcourts.gov and fill it in by hand.");
  for (const [name, value] of Object.entries(values.text || {})) form.getTextField(name).setText(pdfSafe(value));
  for (const name of values.checks || []) form.getCheckBox(name).check();
  for (const name of DCCV115.remove) { if (have.has(name)) { try { form.removeField(form.getField(name)); } catch (_e) { /* a button that will not go is harmless */ } } }
  // Flattened: what was served cannot be edited afterwards, and it prints
  // the same everywhere.
  if (flatten) form.flatten();
  pdf.setTitle("Notice of Intent to File a Complaint for Summary Ejectment (Failure to Pay Rent)");
  return pdf.save();
}

/**
 * Every answer the DC-CV-082 asks for, in the form's order.
 * @returns {{ lines: Array<{ no, label, value, note? }>, problems: string[], subtotal, total }}
 */
export function dccv082Lines({ landlord = {}, tenants = [], premises = {}, court = "", license = {}, lead = {}, subsidized = false, subsidyKind = "", monthlyRent = 0, dueDay = 1, claim, futureRent = 0, notice = {}, military = "", priorJudgments = "", signer = {} } = {}) {
  const problems = [];
  const rent = money(claim?.rent?.amount), fees = money(claim?.lateFees?.amount);
  const subtotal = money(rent + fees), future = money(futureRent), total = money(subtotal + future);
  const names = (tenants || []).map(t => String(t?.name || "").trim()).filter(Boolean);
  if (!court) problems.push("The county is missing on the property, so the court cannot be named.");
  if (!(rent > 0)) problems.push("No rent is past due. A failure-to-pay-rent complaint needs unpaid rent.");
  if (!String(license.number || "").trim() && !license.exemptReason) problems.push("No rental licence number is on file for this property. The form asks for the number and its expiration date, or why none is needed.");
  if (license.expires && isIso(license.expires) && isIso(notice.today) && license.expires < notice.today) problems.push("The rental licence on file expired " + usDate(license.expires) + ".");
  if (!String(lead.number || "").trim() && !lead.notAffected) problems.push("No lead (MDE) inspection certificate number is on file. The form asks for it unless the property is not affected (built 1978 or later) or exempt.");
  if (!isIso(notice.providedOn) || !noticeMethod(notice.method)) problems.push("The date and method of the Notice of Intent are not recorded.");
  if (!military) problems.push("Say what is known about military service; the form requires it for each tenant.");
  if (names.length > 4) problems.push("The form has room for four tenants; this tenancy has " + names.length + ".");

  const m = noticeMethod(notice.method);
  const period = (c) => (c && isIso(c.from) && isIso(c.to) ? usDate(c.from) + " to " + usDate(c.to) : "");
  const lines = [
    { no: "", label: "Court", value: court },
    { no: "", label: "Landlord", value: [landlord.name, landlord.address, landlord.cityStateZip].filter(Boolean).join(", ") },
    { no: "", label: "Tenant(s)", value: names.map((n, i) => `(${i + 1}) ${n}`).join("   "), note: "Number of tenants: " + names.length },
    { no: "", label: "Tenant address", value: [premises.address, premises.cityStateZip].filter(Boolean).join(", ") },
    { no: "1", label: "The property is described as", value: [premises.address, premises.cityStateZip].filter(Boolean).join(", ") },
    { no: "2", label: "Required to be licensed as a rental property?", value: license.number ? "Yes. Licence number " + license.number + (license.expires ? ", expires " + usDate(license.expires) : ", expiration date not on file") : (license.exemptReason ? "Not licensed because: " + license.exemptReason : "NOT ON FILE: enter the licence number and expiration date") },
    { no: "3", label: "Lead paint (affected property under Environment Article 6-801)", value: lead.number ? "Affected property; registration current. MDE inspection certificate number " + lead.number : (lead.notAffected ? "The property is not affected." : "NOT ON FILE: enter the MDE inspection certificate number, or tick 'not affected'") },
    { no: "4", label: "The tenant rents from the landlord, who asks for possession and a judgment", value: "(printed on the form)" },
    { no: "5", label: "Government subsidized tenancy?", value: subsidized ? "IS a government subsidized tenancy" + (subsidyKind ? " (" + subsidyKind + ")" : "") + ". Enter only the TENANT's portion of the rent." : "Is NOT a government subsidized tenancy" },
    { no: "5", label: "Rent the tenant is responsible to pay", value: "$" + usMoney(monthlyRent) + ", due on the " + ordinal(dueDay) + " of the month" },
    { no: "5", label: "Rent is due for the months of", value: period(claim?.rent), note: "in the total amount of $" + usMoney(rent) },
    { no: "5", label: "Less tenant payments for utility bills, fees and security deposits (PU 7-309 / RP 8-212.3)", value: "$0.00", note: "Net rent: $" + usMoney(rent) + ". Applies only where utilities are billed by ratio; confirm with your attorney." },
    { no: "5", label: "Late charges for the months of", value: fees > 0 ? period(claim?.lateFees) : "None", note: fees > 0 ? "in the amount of $" + usMoney(fees) : "" },
    { no: "6", label: "SUBTOTAL", value: "$" + usMoney(subtotal) },
    { no: "7", label: "Rent becoming due after filing but by the trial date", value: future > 0 ? "Requested: $" + usMoney(future) : "Not requested" },
    { no: "8", label: "TOTAL", value: "$" + usMoney(total) },
    { no: "9", label: "Prior judgments in the past 12 months (case numbers and dates)", value: String(priorJudgments || "").trim() || "None" },
    { no: "", label: "All the tenants on the lease are listed above", value: names.length <= 4 ? "Yes" : "No: more than four" },
    { no: "", label: "Military service", value: MILITARY_LABEL[military] || "NOT ANSWERED", note: military === "none" ? "The form requires the specific facts supporting this; verify each tenant at scra.dmdc.osd.mil and keep the certificate." : "" },
    { no: "11", label: "Notice of Intent (DC-CV-115) provided to the tenant on", value: isIso(notice.providedOn) ? usDate(notice.providedOn) + ", by " + (m ? (m.electronic ? "electronic delivery (" + m.label.toLowerCase() + "), proof of transmission kept" : m.label.toLowerCase()) : "?") : "NOT RECORDED" },
    { no: "", label: "Signer (print name)", value: [signer.name, signer.address, signer.phone, signer.email].filter(Boolean).join(" | ") },
  ];
  return { lines, problems, subtotal, total };
}
export const MILITARY_LABEL = {
  none: "No tenant is in the military service",
  some: "At least one tenant is in the military service",
  unknown: "Unable to determine whether any tenant is in the military service",
};
function ordinal(n) {
  const d = Math.floor(Number(n)) || 1, s = ["th", "st", "nd", "rd"], v = d % 100;
  return d + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Wrap text to a width, by the font's own measure. */
function wrap(font, text, size, maxWidth) {
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? line + " " + word : word;
      if (font.widthOfTextAtSize(next, size) <= maxWidth || !line) line = next;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

/** The worksheet as a PDF: letter size, as many pages as it needs. */
export async function worksheetPdf(PDFLib, { title, subtitle = "", lines = [], warnings = [], footer = "" }) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 54, width = W - M * 2;
  let page = pdf.addPage([W, H]), y = H - M;
  const need = (h) => { if (y - h < M + 24) { page = pdf.addPage([W, H]); y = H - M; } };
  const draw = (text, { font = regular, size = 10, color = rgb(0.1, 0.1, 0.1), indent = 0, gap = 3 } = {}) => {
    for (const ln of wrap(font, pdfSafe(text), size, width - indent)) { need(size + gap); page.drawText(ln, { x: M + indent, y: y - size, size, font, color }); y -= size + gap; }
  };
  draw(title, { font: bold, size: 14, gap: 5 });
  if (subtitle) draw(subtitle, { size: 9.5, color: rgb(0.35, 0.35, 0.35), gap: 4 });
  y -= 6;
  if (warnings.length) {
    draw("Check before filing", { font: bold, size: 10.5, color: rgb(0.7, 0.1, 0.1) });
    for (const w of warnings) draw("- " + w, { size: 9.5, color: rgb(0.7, 0.1, 0.1), indent: 8 });
    y -= 8;
  }
  for (const l of lines) {
    need(34);
    draw((l.no ? l.no + ". " : "") + l.label, { font: bold, size: 9.5, color: rgb(0.3, 0.3, 0.3) });
    draw(l.value || "-", { size: 11, indent: 12 });
    if (l.note) draw(l.note, { size: 9, color: rgb(0.4, 0.4, 0.4), indent: 12 });
    y -= 5;
  }
  if (footer) { y -= 6; draw(footer, { size: 8.5, color: rgb(0.4, 0.4, 0.4) }); }
  pdf.setTitle(pdfSafe(title));
  return pdf.save();
}
