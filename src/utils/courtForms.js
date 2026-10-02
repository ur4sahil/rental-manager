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
