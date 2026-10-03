// The lease on the tenant's page, in the Leases tab and in the tenant portal
// (Phase 1 of docs/PLAN-tenant-documents.md).
//
// There used to be three leases: the Document Builder's, a fixed six-clause
// text in a pop-up on the Tenants page (nothing saved, nothing sent), and a
// five-row table composed by the Leases page. Only the Builder's is left.
import fs from "fs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (detail ? "\n      " + detail : "")); } };
const read = (f) => fs.readFileSync(new URL("../src/" + f, import.meta.url), "utf8");
const svc = read("utils/docService.js"), docs = read("components/Documents.js"), tenants = read("components/Tenants.js"),
  leases = read("components/Leases.js"), page = read("components/TenantPage.js"), card = read("components/TenancyDocuments.js"),
  portal = read("components/TenantPortal.js");

const lift = (src, start, end) => src.slice(src.indexOf(start), end ? src.indexOf(end, src.indexOf(start)) : undefined);
// The signer-role rules live in their own pure module now (signerRoles.js,
// re-exported by docService), so they are imported, not lifted from text.
const { effectiveSignerRoles, signerDefaultFor } = await import("../src/utils/signerRoles.js");

// ── signature slots follow the adults on the tenancy
const LEASE_ROLES = [
  { role: "tenant", label: "Tenant", order: 1, required: true },
  { role: "tenant_2", label: "Co-tenant 2", order: 1, required: false },
  { role: "tenant_3", label: "Co-tenant 3", order: 1, required: false },
  { role: "landlord", label: "Landlord", order: 2, required: true },
];
let r = effectiveSignerRoles(LEASE_ROLES, 5);
ok("five adults on a three-slot lease: two slots are added", r.length === 6 && r.some(x => x.role === "tenant_4") && r.some(x => x.role === "tenant_5"));
ok("the added slots sign at the tenants' step, not after the landlord", r.filter(x => /^tenant_[45]$/.test(x.role)).every(x => x.order === 1 && x.required === false));
ok("the added slots are labelled for a person to read", r.find(x => x.role === "tenant_4").label === "Co-tenant 4");
ok("three or fewer adults: the template's slots are left alone", effectiveSignerRoles(LEASE_ROLES, 3).length === 4 && effectiveSignerRoles(LEASE_ROLES, 1).length === 4 && effectiveSignerRoles(LEASE_ROLES, 0).length === 4);
ok("the template's own roles are never changed", JSON.stringify(effectiveSignerRoles(LEASE_ROLES, 5).slice(0, 4)) === JSON.stringify(LEASE_ROLES) && LEASE_ROLES.length === 4);
ok("a template with no tenant signer (a letter the landlord signs) gets no tenant slots", effectiveSignerRoles([{ role: "landlord", order: 1 }], 4).length === 1);
ok("no roles, no slots", effectiveSignerRoles(null, 3).length === 0 && effectiveSignerRoles([], 3).length === 0);
ok("an added slot never collides with a role the template already uses", (() => { const x = effectiveSignerRoles([{ role: "tenant", order: 1 }, { role: "tenant_3", order: 1 }], 3); return new Set(x.map(y => y.role)).size === x.length && x.length === 3; })());
const ctx = { signers: { tenants: ["A", "B", "C", "D", "E"].map(n => ({ name: n, email: n.toLowerCase() + "@x.test" })), landlord: { name: "L", email: "l@x.test" } } };
ok("each slot is prefilled with its own person, in order", effectiveSignerRoles(LEASE_ROLES, 5).map(x => signerDefaultFor(x.role, ctx).name).join("") === "ABCLDE");
ok("a slot beyond the people on the tenancy is left blank", signerDefaultFor("tenant_3", { signers: { tenants: [{ name: "A", email: "a@x" }], landlord: {} } }).name === "");
ok("the builder uses the widened slots to prefill, to list and to send",
  /for \(const r of effectiveSignerRoles\(template\.signer_roles, source\.signers\?\.tenants\?\.length \|\| 0, \{ witnesses: !!template\.field_config\?\.witnesses \}\)\)/.test(docs)
  && /const roles = signerRoles;/.test(docs) && /\{\[\.\.\.signerRoles\]\.sort\(/.test(docs));
ok("a named signer with no email stops the send instead of being silently left off", /if \(!email && name\) \{ showToast\(name \+ " has no email address\./.test(docs));

// ── one lease, not three
ok("the Tenants page's throwaway lease (six fixed clauses in a pop-up) is gone", !/openLeaseForSigning/.test(tenants) && !/RESIDENTIAL LEASE AGREEMENT/.test(tenants) && !/Generate & E-Sign Lease/.test(tenants));
ok("the Leases page no longer composes its own lease text", !/buildLeaseHtml/.test(leases) && !/Residential Lease Agreement/.test(leases) && !/output_type: "lease"/.test(leases));
ok("the Leases page no longer creates an envelope itself", !/create_doc_envelope/.test(leases) && !/sendSignatureRequests/.test(leases));
ok("'Create lease' on the tenant page opens the Builder with the lease template and this tenant, and comes back",
  /setPage\("doc_builder", \{ templateKey: "md_residential_lease", tenantId: Number\(tenant\.id\), returnTo: \{ page: "tenants", action: \{ openTenantId: tenant\.id/.test(tenants));
ok("the Leases tab opens the same template for the lease's tenant and lease", /<TenancyDocuments companyId=\{companyId\} leaseId=\{lease\.id\} tenantId=\{lease\.tenant_id\}/.test(leases) && /templateKey: "md_residential_lease"/.test(leases));
ok("a lease not linked to a tenant record says so instead of offering a blank lease", /lease\.tenant_id == null &&/.test(leases) && /actions=\{lease\.tenant_id != null \?/.test(leases));
ok("the lease button reports signed / out for signature truthfully", /l\.signature_status === "fully_signed" \? "✓ Signed" : \["pending", "partially_signed"\]\.includes\(l\.signature_status\) \? "Out for signature" : "Lease document"/.test(leases));

// ── the tenant's page shows what was made and who has signed
ok("the tenant page has a slot for the lease card, above the uploaded documents", /leaseCard,/.test(page) && page.indexOf("{leaseCard}") < page.indexOf('<DetailCard title="Documents"') && page.indexOf("{leaseCard}") > 0);
ok("Tenants.js fills that slot for the tenant by id", /leaseCard=\{selectedTenant\?\.id \? \(<>/.test(tenants) && /<TenancyDocuments key=\{selectedTenant\.id \+ "-" \+ leaseChangesKey\} companyId=\{companyId\} tenantId=\{selectedTenant\.id\}/.test(tenants));
ok("an archived tenant's documents are shown but nothing new can be started", /actions=\{selectedTenant\.archived_at \? \[\] : leaseActionsFor\(selectedTenant\)\}/.test(tenants) && /canAct=\{!selectedTenant\.archived_at\}/.test(tenants));
ok("documents are found by tenant or lease RECORD, never by name", /q = leaseId \? q\.eq\("lease_id", leaseId\) : q\.eq\("tenant_id", Number\(tenantId\)\)/.test(card) && !/\.eq\("tenant_name"/.test(card) && !/ilike\("name"/.test(card));
ok("the card is scoped to the company", /\.eq\("company_id", companyId\)\.is\("archived_at", null\)/.test(card));
ok("a signer whose turn it is can be reminded or given the link; cancel voids the envelope", /resendSignatureRequest\(companyId, sig\.id\)/.test(card) && /voidEnvelope\(companyId, doc\.id/.test(card) && /\["sent", "viewed"\]\.includes\(s\.status\)/.test(card));
ok("the signed copy is opened through a signed URL", /getSignedUrl\("documents", path\)/.test(card));
// docStanding, lifted the same way
const standing = new Function("fmtDate", lift(card, "export function docStanding", "\nconst TONE").replace("export ", "") + "\nreturn docStanding;")((d) => String(d).slice(0, 10));
ok("standing: out for signature counts who has signed, ignoring cancelled requests", standing({ envelope_status: "out_for_signature" }, [{ status: "signed" }, { status: "sent" }, { status: "voided" }]).label === "Out for signature · 1 of 2 signed");
ok("standing: completed reads as signed by everyone", standing({ envelope_status: "completed" }, []).key === "signed");
ok("standing: cancelled and declined are told apart", standing({ envelope_status: "voided" }).key === "cancelled" && standing({ envelope_status: "declined" }).key === "declined");
ok("standing: a document never sent says so", standing({ envelope_status: "draft" }).label === "Not sent" && standing({}).key === "draft");
ok("standing: a served notice says when", standing({ envelope_status: "draft", served_at: "2026-10-05T12:00:00Z" }).label === "Served 2026-10-05");

// ── tenant portal: to sign, and my documents
ok("the portal asks the database what is waiting for THIS login, not the signatures table", /supabase\.rpc\("my_pending_signatures", \{ p_company_id: companyId \}\)/.test(portal) && !/from\("doc_signatures"\)/.test(portal));
ok("a failed lookup shows nothing rather than breaking the portal", /setToSign\(error \? \[\] : \(data \|\| \[\]\)\)/.test(portal));
ok("the card is on the overview and on the documents tab, and opens the signing page", (portal.match(/toSign\.length > 0 &&/g) || []).length === 2 && /window\.open\("\/sign\/" \+ encodeURIComponent\(t\.access_token\)/.test(portal));
const mig = fs.readFileSync(new URL("../supabase/migrations/20261003020000_my_pending_signatures.sql", import.meta.url), "utf8");
ok("the function matches the caller's own login email, case-insensitively", /lower\(s\.signer_email\) = lower\(auth\.email\(\)\)/.test(mig) && /NULLIF\(auth\.email\(\), ''\) IS NOT NULL/.test(mig));
ok("the caller must be an active member of that company", /cm\.company_id = p_company_id AND cm\.status = 'active'\s+AND lower\(cm\.user_email\) = lower\(auth\.email\(\)\)/.test(mig));
ok("only requests whose turn it is, on a document still out, with a live link", /s\.status IN \('sent', 'viewed'\)/.test(mig) && /d\.envelope_status = 'out_for_signature'/.test(mig) && /s\.token_expires_at > now\(\)/.test(mig));
ok("not callable without a login", /REVOKE ALL ON FUNCTION public\.my_pending_signatures\(text\) FROM PUBLIC, anon;/.test(mig));
const impl = fs.readFileSync(new URL("../api/_doc-email-impl.js", import.meta.url), "utf8");
ok("a signed copy is filed where the tenant's portal lists it", /tenant_id: doc\.tenant_id \|\| null, property_id: doc\.property_id \|\| null, tenant_visible: true/.test(impl));

// ── the device's own mail app (asked for by Sahil, 2026-10-02)
const mail = new Function(lift(svc, "export function mailtoUrl").replace(/export /g, "") + "\nreturn { mailtoUrl, signingMailto, canShareFile };")();
ok("a draft carries the recipient, subject and message, safely encoded", mail.mailtoUrl({ to: ["a@x.com"], subject: "Lease & notice", body: "Line 1\nLine 2?" }) === "mailto:a%40x.com?subject=Lease%20%26%20notice&body=Line%201%0ALine%202%3F");
ok("several recipients are comma-separated; junk and header-injection attempts are dropped", mail.mailtoUrl({ to: ["a@x.com", "", "not an email", "b@y.org", "c@z.com?bcc=evil@x.com,d@q.com"] }) === "mailto:a%40x.com,b%40y.org");
ok("no recipient still makes a usable draft", mail.mailtoUrl({ subject: "Hi" }) === "mailto:?subject=Hi");
const sm = decodeURIComponent(mail.signingMailto({ signer: { signer_email: "t@x.com", signer_name: "Pat Tenant", access_token: "tok123" }, docName: "Lease", origin: "https://housify365.com/" }));
ok("a signing draft goes to that signer with their own link", sm.startsWith("mailto:t@x.com?subject=Please sign: Lease") && sm.includes("https://housify365.com/sign/tok123") && sm.includes("Hi Pat,"));
ok("a device with no share sheet is reported as such, not as an error", mail.canShareFile({}) === false);
ok("the builder prepares first and opens the share sheet or draft from a second click", /async function prepareMailDraft\(doc\)/.test(docs) && /onClick=\{shareMailDraft\}/.test(docs) && /href=\{mailtoUrl\(\{ to: mailDraft\.recipients, subject: mailDraft\.subject, body: mailDraft\.body \}\)\}/.test(docs));
ok("the app's own Send stays, and stays the first button", docs.indexOf('{sending ? "Sending..." : "Send Email"}') > 0 && docs.indexOf('{sending ? "Sending..." : "Send Email"}') < docs.indexOf("Open in my mail app"));
ok("the screen says the app cannot see whether it was sent", /The app cannot see whether you did, so it is not in the email log/.test(docs));
ok("a signer can be emailed from the device's own mail app, with their link", /href=\{signingMailto\(\{ signer: s, docName: d\.name, origin: window\.location\.origin \}\)\}/.test(card));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
