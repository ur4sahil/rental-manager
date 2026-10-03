// Build the MD Residential Lease template from the filled Zoho export:
// swap each filled-in value for its field. Run once; the JSON it writes is
// the artefact.
import { JSDOM } from "/Users/aggar/rental-manager/node_modules/jsdom/lib/api.js";
import fs from "fs";
import { createRequire } from "module";
const require = createRequire("/Users/aggar/rental-manager/");
const w = new JSDOM("<!doctype html><html><body></body></html>").window;
globalThis.DOMParser = w.DOMParser; globalThis.NodeFilter = w.NodeFilter;
const unzip = require("mammoth/lib/unzip"); const orig = unzip.openZip; unzip.openZip = (o) => orig(o.arrayBuffer ? { buffer: Buffer.from(o.arrayBuffer) } : o);
const { convertDocxToHtml } = await import("/Users/aggar/rental-manager/src/utils/docxImport.js");
const buf = fs.readFileSync(process.argv[2]);
const r = await convertDocxToHtml(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

const dom = new JSDOM(`<div id="root">${r.html}</div>`);
const doc = dom.window.document;
const ps = [...doc.querySelectorAll("#root p")];
const find = (startsWith) => { const p = ps.find(p => p.textContent.trim().startsWith(startsWith)); if (!p) throw new Error("paragraph not found: " + startsWith); return p; };
// Replace span texts in order; every expected value must be found or the build fails.
function swap(p, pairs) {
  const spans = [...p.querySelectorAll("span")]; let i = 0;
  for (const [was, now] of pairs) {
    while (i < spans.length && spans[i].textContent !== was) i++;
    if (i >= spans.length) throw new Error(`value not found in "${p.textContent.slice(0, 40)}…": ${JSON.stringify(was)}`);
    spans[i].textContent = now; i++;
  }
}
swap(find("THIS LEASE is made this"), [["1st", "{{lease_day}}"], ["October", "{{lease_month}}"], [",", ", "], ["2026", "{{lease_year}}"], ["Sigma housing llc ", "{{landlord_name}} "], ["Sahil Agarwal", "{{tenant_name}}"]]);
swap(find("Landlord does hereby rent to Tenant"), [
  ["13431 Marble Rock Drive", "{{premises_address}}"], ["13431 Marble Rock Drive", "{{term_words}}"], ["(", "({{term_number}})"], ["casahilagarwal267@gmail.com", ""], [")", ""],
  ["15th", "{{start_day}}"], ["October", "{{start_month}}"], ["2026", "{{start_year}}"],
  ["31st", "{{end_day}}"], ["October", "{{end_month}}"], ["2026", "{{end_year}}"],
  ["Nineteen thousand four hundred forty seven", "{{total_rent_words}}"], ["19447", "{{total_rent_amount}}"],
  ["Fifteen hundred", "{{rent_words}}"], [" and 00/100 Dollars ($", " and {{rent_cents}}/100 Dollars ($"], ["1500", "{{rent_amount}}"]]);
swap(find("Prorated Amount"), [["Prorated Amount – 15-Oct-2026–", "{{proration_line}}"], ["31-Oct-2027", ""], [" = $1447", ""]]);
swap(find("The Tenant, upon execution of this Lease"), [["fifteen hundred", "{{deposit_words}}"], ["and 00/100 Dollars ($", "and {{deposit_cents}}/100 Dollars ($"], ["1500", "{{deposit_amount}}"]]);
swap(find("Tenant covenants to pay promptly the Rent"), [["Seventy Five ", "{{late_words}} "], ["75", "{{late_amount}}"]]);
swap(find("Landlord will pay when due all charges for"), [["Electric ", "{{landlord_utilities}} "], ["Gas, Water,", "{{tenant_utilities}},"]]);
// The signature section. The export lays it out with runs of spaces and
// underscores (WITNESS / LANDLORD, then WITNESS / TENANT), one tenant
// line, which neither lines up nor grows with the tenants on the lease.
// Everything from the "WITNESS: ... LANDLORD:" line to the tenant's
// "Print Name" line becomes the signature block: one signature line per
// signer (every tenant, then the landlord), with the real signature and
// date placed on each line of the signed copy (signatureBlock.js).
{
  const first = ps.findIndex(p => /^WITNESS:\s+LANDLORD:/.test(p.textContent.trim()));
  const last = ps.findIndex(p => p.textContent.includes("Print Name: Sahil Agarwal"));
  if (first < 0 || last < first) throw new Error("signature section not found");
  const block = doc.createElement("p");
  block.textContent = "{{signature_block}}";
  ps[first].before(block);
  for (let i = first; i <= last; i++) ps[i].remove();
}
doc.querySelectorAll("#root span").forEach(s => { if (!s.textContent) s.remove(); });
doc.querySelectorAll("#root u").forEach(u => { if (!u.textContent && !u.children.length) u.remove(); });
const body = doc.getElementById("root").innerHTML;
// Nothing of the sample tenant may survive in the template.
for (const leak of ["Sahil", "Marble Rock", "casahilagarwal", "19447", "Sigma housing"]) if (body.includes(leak)) throw new Error("sample value left in template: " + leak);

const F = (name, label, type, section, prefill_from = "", required = true) => ({ name, label, type, section, required, options: [], default_value: "", prefill_from });
const template = {
  name: "MD Residential Lease",
  category: "leases",
  description: "Single family residential lease (Maryland). Dates, amounts in words, term, prorated rent, total rent and late charge fill themselves in.",
  template_type: "html",
  template_key: "md_residential_lease",
  // Every tenant on the lease signs first (together), then the landlord.
  // Co-tenant slots are optional: a lease with one tenant leaves them empty.
  signing_mode: "sequential",
  signer_roles: [
    { role: "tenant", label: "Tenant", order: 1, required: true },
    { role: "tenant_2", label: "Co-tenant 2", order: 1, required: false },
    { role: "tenant_3", label: "Co-tenant 3", order: 1, required: false },
    { role: "landlord", label: "Landlord", order: 2, required: true },
  ],
  body,
  fields: [
    F("lease_date", "Lease date (date this lease is made)", "date", "Parties", "today"),
    F("landlord_name", "Landlord (leasing LLC) name", "text", "Parties", "company.name"),
    // Every adult on the lease, not just the first: "A, B and C". For a
    // tenant with no co-tenants this is simply their name.
    F("tenant_name", "Tenant name", "text", "Parties", "tenant.all_names"),
    F("premises_address", "Leased premises: full address with city, state and ZIP", "text", "Premises and term", "property.address"),
    F("lease_start_date", "Lease start date", "date", "Premises and term", "lease.start_date"),
    F("lease_end_date", "Lease end date", "date", "Premises and term", "lease.end_date"),
    F("lease_term_months", "Lease term in months", "number", "Premises and term", "", false),
    F("rent_per_month", "Rent per month", "currency", "Rent and deposit", "lease.rent_amount"),
    F("prorated_rent", "Prorated rent for a partial first month", "currency", "Rent and deposit", "", false),
    F("total_lease_rent", "Total lease rent", "currency", "Rent and deposit", "", false),
    F("security_deposit", "Security deposit", "currency", "Rent and deposit", "lease.security_deposit"),
    F("late_charge", "Late charge (5% of monthly rent)", "currency", "Rent and deposit", "", false),
    F("landlord_utilities", "Utilities the landlord pays (comma separated)", "text", "Utilities", "lease.landlord_utilities", false),
    F("tenant_utilities", "Utilities the tenant pays (comma separated)", "text", "Utilities", "lease.tenant_utilities", false),
  ],
  field_config: {
    // The export's footer carried "_______ Landlord / _______ Tenant"
    // initials lines: one tenant line, printed text. The signed copy
    // carries every signer's own initials at the foot of each page instead
    // (initials_each_page), so the printed lines go.
    page_setup: { ...(r.page || {}), headerLeft: "", headerRight: "", footerLeft: "", footerRight: "" },
    initials_each_page: true,
    witnesses: true,
    calculated: {
      lease_term_months: { formula: "months_between(lease_start_date, lease_end_date)" },
      prorated_rent: { formula: "prorate(rent_per_month, lease_start_date)" },
      total_lease_rent: { formula: "rent_per_month * lease_term_months + prorated_rent" },
      late_charge: { formula: "rent_per_month * 0.05" },
    },
    derived: {
      lease_day: { from: "lease_date", format: "day_ordinal" },
      lease_month: { from: "lease_date", format: "month_name" },
      lease_year: { from: "lease_date", format: "year" },
      term_words: { from: "lease_term_months", format: "words_whole" },
      term_number: { from: "lease_term_months", format: "number" },
      start_day: { from: "lease_start_date", format: "day_ordinal" },
      start_month: { from: "lease_start_date", format: "month_name" },
      start_year: { from: "lease_start_date", format: "year" },
      end_day: { from: "lease_end_date", format: "day_ordinal" },
      end_month: { from: "lease_end_date", format: "month_name" },
      end_year: { from: "lease_end_date", format: "year" },
      total_rent_words: { from: "total_lease_rent", format: "words" },
      total_rent_amount: { from: "total_lease_rent", format: "amount" },
      rent_words: { from: "rent_per_month", format: "words_whole" },
      rent_cents: { from: "rent_per_month", format: "cents" },
      rent_amount: { from: "rent_per_month", format: "amount" },
      proration_from: { from: "lease_start_date", format: "date_dd_mmm_yyyy" },
      proration_to: { from: "lease_start_date", format: "month_end" },
      prorated_amount: { from: "prorated_rent", format: "amount" },
      proration_line: { text: "Prorated Amount – {proration_from}–{proration_to} = ${prorated_amount}", blank_when_zero: "prorated_rent" },
      deposit_words: { from: "security_deposit", format: "words_whole" },
      deposit_cents: { from: "security_deposit", format: "cents" },
      deposit_amount: { from: "security_deposit", format: "amount" },
      late_words: { from: "late_charge", format: "words" },
      late_amount: { from: "late_charge", format: "amount" },
    },
  },
};
// Every {{tag}} in the body must be an input or a derived field, and vice versa for derived.
const tags = new Set([...body.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]));
const known = new Set([...template.fields.map(f => f.name), ...Object.keys(template.field_config.derived)]);
// (signature_block is not a field: it expands to the signers' lines.)
const unknown = [...tags].filter(t => !known.has(t) && t !== "signature_block");
if (unknown.length) throw new Error("tags with no field: " + unknown.join(", "));
fs.writeFileSync(process.argv[3], JSON.stringify(template, null, 2) + "\n");
console.log("template written:", process.argv[3], "| body", body.length, "chars | tags used:", tags.size, "| inputs:", template.fields.length, "| derived:", Object.keys(template.field_config.derived).length);
console.log("page setup:", JSON.stringify(template.field_config.page_setup));
