// The document service: the part of the Document Builder that other screens
// are allowed to call.
//
// It used to be impossible for the Tenant module to produce a document
// through the builder, because everything it needed lived in one
// component's state, and the facts were looked up as "the tenant at this
// address" -- which returns nothing for a property with two tenant rows
// (25 of them on Sigma's data), nothing for a co-tenant, and the wrong
// person for a same-named tenant somewhere else.
//
// Here the facts are loaded by RECORD (tenant id, lease id), and the
// sending goes through one server path that logs every email.
import { supabase } from "../supabase";
import { formatCurrency, formatLocalDate, buildAddress, LIVE_TENANCY } from "./helpers";

// ── Server calls ──────────────────────────────────────────────────────
async function authHeader() {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token ? { Authorization: "Bearer " + token } : {};
}
async function post(path, body, { auth = true } = {}) {
  const headers = { "content-type": "application/json", ...(auth ? await authHeader() : {}) };
  let res, json = {};
  try {
    res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, error: "Could not reach the server (" + (e?.message || "network error") + ")" };
  }
  return res.ok ? { ok: true, ...json } : { ok: false, status: res.status, error: json.error || "Request failed (" + res.status + ")" };
}
const docApi = (op, body, opts) => post("/api/notifications?action=doc", { op, ...body }, opts);

/** Email every signer whose turn it is. → { ok, results:[{email,status,delivered_to,error}] } */
export const sendSignatureRequests = (companyId, docId) => docApi("send-requests", { company_id: companyId, doc_id: docId });
/** Remind one signer (same link, extended). */
export const resendSignatureRequest = (companyId, signatureId) => docApi("resend", { company_id: companyId, signature_id: signatureId });
/** Cancel an envelope that is out for signature. */
export const voidEnvelope = (companyId, docId, reason) => docApi("void", { company_id: companyId, doc_id: docId, reason });
/** Called by the public signing page after a signature: ask whoever is next. */
export const notifyNextSigners = (token) => docApi("next-signers", { token }, { auth: false });
/** Email an applicant the private link to their rental application. */
export const sendApplicationRequest = (companyId, applicationId) => docApi("application-request", { company_id: companyId, application_id: applicationId });
/** Email a document, with its PDF attached, to a list of addresses. */
export const emailDocument = (companyId, docId, { to, message, pdfBytes, filename }) =>
  docApi("send-document", { company_id: companyId, doc_id: docId, to, message, filename, pdf_base64: pdfBytes ? bytesToBase64(pdfBytes) : undefined });
/** Staff fallback: store the signed PDF when the last signer's browser never uploaded it. */
export const storeSignedPdf = (companyId, docId, { pdfBytes, bodyPages, anchors }) =>
  post("/api/finalize-signed-pdf", { company_id: companyId, doc_id: docId, pdf_base64: bytesToBase64(pdfBytes), body_pages: bodyPages, sig_anchors: anchors });
/** At send: the document's pages (unsigned) and where its signature lines
 *  are, so the server can finish the envelope the moment the last person
 *  signs -- whatever they do with their browser afterwards. */
export const storeEnvelopeBody = (companyId, docId, { pdfBytes, bodyPages, anchors }) =>
  post("/api/finalize-signed-pdf?action=body", { company_id: companyId, doc_id: docId, pdf_base64: bytesToBase64(pdfBytes), body_pages: bodyPages, sig_anchors: anchors });
/** Staff: finish a completed envelope on the server from the pages stored at
 *  send. { ok:false, status:404 } when the envelope predates stored pages. */
export const finalizeOnServer = (companyId, docId) =>
  post("/api/finalize-signed-pdf?action=server", { company_id: companyId, doc_id: docId });

// Chunked: String.fromCharCode(...wholeFile) overflows the call stack.
export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < u8.length; i += 0x8000) binary += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A one-line summary of a send, for a toast. */
export function summarizeSends(results) {
  const list = results || [];
  const sent = list.filter(r => r.status === "sent");
  const redirected = sent.filter(r => r.delivered_to && r.email && r.delivered_to !== r.email);
  const failed = list.filter(r => r.status === "failed");
  const held = list.filter(r => r.status === "suppressed");
  const parts = [];
  if (sent.length) parts.push(sent.length + " emailed" + (redirected.length ? " (" + redirected.length + " redirected to you: test site)" : ""));
  if (held.length) parts.push(held.length + " not sent (email is off on this site)");
  if (failed.length) parts.push(failed.length + " failed: " + (failed[0].error || "unknown error"));
  return { text: parts.join("; ") || "Nobody to email", tone: failed.length ? "error" : held.length ? "warning" : "success" };
}

// ── Which kind of document a template makes ───────────────────────────
// doc_generated.doc_kind, by the template's stable key.
export const DOC_KIND_BY_TEMPLATE_KEY = {
  md_residential_lease: "lease",
  lease_renewal_offer: "renewal",
  lease_renewal: "renewal",
  lease_addendum: "addendum",
  lease_change_addendum: "addendum",
  rent_increase_notice: "rent_increase_notice",
  notice_to_vacate: "notice_to_vacate",
  move_out_acknowledgment: "move_out_acknowledgment",
  late_fee_notice: "late_notice",
  notice_to_pay_or_quit: "late_notice",
  md_dccv115: "notice_of_intent",
  md_dccv082: "ftpr_complaint",
  move_out_statement: "move_out_statement",
  deposit_disposition: "deposit_disposition",
  general_letter: "letter",
  home_leased_notice: "letter",
};

// ── Facts for a document, by record ───────────────────────────────────
const joinNames = (names) => names.length <= 1 ? (names[0] || "") : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];

/**
 * Everything a template can fill itself from, for one tenancy.
 *
 * Give it a tenantId (and optionally a leaseId) whenever there is one. A
 * propertyAddress alone is accepted for the builder's "prefill from
 * property" mode; if several tenants live there the caller gets
 * `tenantChoices` and should ask which one.
 *
 * A prospectId is someone who is not a tenant yet. Their own details and the
 * lease terms agreed with them fill the same fields a tenant's would
 * (tenant.name, lease.rent_amount, ...), so one lease template serves both.
 * The CURRENT occupant of the property is deliberately not looked up: a
 * prospect's lease must never be filled in with someone else's name.
 *
 * @returns {Promise<{ data: object, tenant, lease, property, prospect, coTenants: Array, tenantChoices: Array, signers: object }>}
 */
export async function loadDocContext({ companyId, tenantId = null, leaseId = null, prospectId = null, propertyAddress = null, userProfile = null, activeCompany = null }) {
  const data = {};
  let tenant = null, property = null, lease = null, tenantChoices = [], prospect = null;

  if (prospectId) {
    prospect = (await supabase.from("prospects").select("*").eq("company_id", companyId).eq("id", prospectId).maybeSingle()).data || null;
    if (prospect?.property_id != null) {
      property = (await supabase.from("properties").select("*").eq("company_id", companyId).eq("id", prospect.property_id).maybeSingle()).data || null;
    }
  }

  if (tenantId != null) {
    const r = await supabase.from("tenants").select("*").eq("company_id", companyId).eq("id", tenantId).maybeSingle();
    tenant = r.data || null;
  }
  // Property. The tenant's record link first -- but that link can point at
  // an ARCHIVED copy of the property (re-created properties leave the old
  // rows behind, and tenants keep the old id), so among records with the
  // same address the live one wins.
  const address = propertyAddress || tenant?.property || property?.address || null;
  let sameAddress = [];
  if (address) sameAddress = (await supabase.from("properties").select("*").eq("company_id", companyId).eq("address", address).order("id", { ascending: false })).data || [];
  if (tenant?.property_id) {
    property = sameAddress.find(p => p.id === tenant.property_id)
      || (await supabase.from("properties").select("*").eq("company_id", companyId).eq("id", tenant.property_id).maybeSingle()).data || null;
  }
  const liveSame = sameAddress.filter(p => !p.archived_at);
  if (!property || (property.archived_at && liveSame.length)) property = liveSame[0] || property || sameAddress[0] || null;

  if (!tenant && !prospect && (property || address)) {
    // Everyone not archived at this address: by the property link (to any
    // record with this address) OR by the address text. More than one row
    // is normal (a past tenant not yet archived, a tenant on notice with
    // the next one already entered), so never .maybeSingle() here: with
    // two rows that returns nothing and the whole document came out blank.
    const ids = Array.from(new Set([property?.id, ...sameAddress.map(p => p.id)].filter(v => v != null)));
    const byId = ids.length ? (await supabase.from("tenants").select("*").eq("company_id", companyId).is("archived_at", null).in("property_id", ids)).data || [] : [];
    const byText = address ? (await supabase.from("tenants").select("*").eq("company_id", companyId).is("archived_at", null).eq("property", address)).data || [] : [];
    const rows = Array.from(new Map([...byId, ...byText].map(t => [t.id, t])).values());
    const live = rows.filter(t => LIVE_TENANCY.includes(String(t.lease_status || "").toLowerCase()));
    tenantChoices = live.length ? live : rows;
    tenant = [...tenantChoices].sort((a, b) => String(b.move_in || "").localeCompare(String(a.move_in || "")))[0] || null;
  }

  if (leaseId) {
    lease = (await supabase.from("leases").select("*").eq("company_id", companyId).eq("id", leaseId).maybeSingle()).data || null;
  }
  if (!lease && tenant?.id != null) {
    const rows = (await supabase.from("leases").select("*").eq("company_id", companyId).eq("tenant_id", tenant.id).in("status", ["active", "draft"]).order("start_date", { ascending: false }).limit(5)).data || [];
    lease = rows.find(l => l.status === "active") || rows[0] || null;
  }
  if (!lease && property?.id && !tenant && !prospect) {
    lease = (await supabase.from("leases").select("*").eq("company_id", companyId).eq("property_id", property.id).eq("status", "active").order("start_date", { ascending: false }).limit(1)).data?.[0] || null;
  }

  // ── Property + owner
  if (property) {
    data["property.address"] = buildAddress(property) || property.address;
    data["property.unit"] = property.unit || "";
    data["property.type"] = property.type || "";
    data["property.bedrooms"] = property.bedrooms || "";
    data["property.bathrooms"] = property.bathrooms || "";
    data["property.rent"] = property.rent || "";
    data["property.street"] = property.address_line_1 || "";
    data["property.city"] = property.city || "";
    data["property.state"] = property.state || "";
    data["property.zip"] = property.zip || "";
    data["property.county"] = property.county || "";
    data["property.sqft"] = property.sqft || "";
    if (property.owner_id || property.owner_name) {
      const own = property.owner_id
        ? (await supabase.from("owners").select("*").eq("company_id", companyId).eq("id", property.owner_id).maybeSingle()).data
        : (await supabase.from("owners").select("*").eq("company_id", companyId).eq("name", property.owner_name).is("archived_at", null).limit(1)).data?.[0];
      data["owner.name"] = own?.name || property.owner_name || "";
      data["owner.email"] = own?.email || "";
      data["owner.phone"] = own?.phone || "";
    }
  }

  // ── Tenant, and the other adults on the lease. Co-tenants are names on
  // the tenant record; their emails still live on the property.
  const coTenants = [];
  if (tenant) {
    data["tenant.name"] = tenant.name || "";
    data["tenant.email"] = tenant.email || "";
    data["tenant.phone"] = tenant.phone || "";
    data["tenant.balance"] = formatCurrency(tenant.balance || 0);
    data["tenant.security_deposit"] = formatCurrency(tenant.security_deposit || 0);
    data["tenant.status"] = tenant.lease_status || tenant.status || "";
    data["tenant.first_name"] = tenant.first_name || "";
    data["tenant.last_name"] = tenant.last_name || "";
    data["tenant.move_in"] = tenant.move_in || tenant.lease_start || "";
    data["tenant.move_out"] = tenant.move_out || tenant.lease_end_date || "";
    data["tenant.voucher_number"] = tenant.voucher_number || "";
    data["tenant.tenant_portion"] = tenant.tenant_portion ? formatCurrency(tenant.tenant_portion) : "";
    data["tenant.voucher_portion"] = tenant.voucher_portion ? formatCurrency(tenant.voucher_portion) : "";
    const names = Array.isArray(tenant.co_tenants) ? tenant.co_tenants.map(n => String(n || "").trim()).filter(Boolean) : [];
    const onProperty = property ? [2, 3, 4, 5].map(n => ({ name: String(property["tenant_" + n] || "").trim(), email: String(property["tenant_" + n + "_email"] || "").trim(), phone: String(property["tenant_" + n + "_phone"] || "").trim() })).filter(c => c.name) : [];
    const list = names.length ? names : onProperty.map(c => c.name);
    for (const name of list) {
      if (name.toLowerCase() === String(tenant.name || "").trim().toLowerCase()) continue;
      const match = onProperty.find(c => c.name.toLowerCase() === name.toLowerCase());
      coTenants.push({ name, email: match?.email || "", phone: match?.phone || "" });
    }
    data["tenant.co_tenant_names"] = coTenants.map(c => c.name).join(", ");
    data["tenant.all_names"] = joinNames([tenant.name, ...coTenants.map(c => c.name)].filter(Boolean));
  }

  // ── A prospect: the same fields, from what was agreed with them.
  if (prospect && !tenant) {
    const others = (Array.isArray(prospect.co_applicants) ? prospect.co_applicants : [])
      .map(c => ({ name: String(c?.name || "").trim(), email: String(c?.email || "").trim(), phone: String(c?.phone || "").trim() }))
      .filter(c => c.name && c.name.toLowerCase() !== String(prospect.name || "").trim().toLowerCase());
    coTenants.push(...others);
    data["tenant.name"] = prospect.name || "";
    data["tenant.email"] = prospect.email || "";
    data["tenant.phone"] = prospect.phone || "";
    data["tenant.first_name"] = prospect.first_name || "";
    data["tenant.last_name"] = prospect.last_name || "";
    data["tenant.move_in"] = prospect.lease_start || "";
    data["tenant.security_deposit"] = prospect.security_deposit != null ? formatCurrency(prospect.security_deposit) : "";
    data["tenant.co_tenant_names"] = coTenants.map(c => c.name).join(", ");
    data["tenant.all_names"] = joinNames([prospect.name, ...coTenants.map(c => c.name)].filter(Boolean));
    data["lease.start_date"] = prospect.lease_start || "";
    data["lease.end_date"] = prospect.lease_end || "";
    data["lease.rent_amount"] = prospect.rent != null ? formatCurrency(prospect.rent) : "";
    data["lease.security_deposit"] = prospect.security_deposit != null ? formatCurrency(prospect.security_deposit) : "";
    data["lease.payment_due_day"] = 1;
    data["lease.landlord_utilities"] = prospect.landlord_utilities || "";
    data["lease.tenant_utilities"] = prospect.tenant_utilities || "";
    // What the property record says about the unit is right; what it says
    // about who lives there and what they pay is the CURRENT tenant's.
    if (prospect.rent != null) data["property.rent"] = prospect.rent;
  }

  // ── Lease
  if (lease) {
    data["lease.start_date"] = lease.start_date || "";
    data["lease.end_date"] = lease.end_date || "";
    data["lease.rent_amount"] = formatCurrency(lease.rent_amount || 0);
    data["lease.security_deposit"] = formatCurrency(lease.security_deposit || 0);
    data["lease.payment_due_day"] = lease.payment_due_day || "";
  }

  // ── Loan, insurance, tax, HOA, licences: by property record when there
  // is one, by address text only as a fallback.
  if (property || address) {
    const scope = (table) => {
      const q = supabase.from(table).select("*").eq("company_id", companyId).is("archived_at", null).limit(1);
      return q.eq("property", property?.address || address);
    };
    const [ln, ins, tax, hoa, lic] = await Promise.all([
      scope("property_loans"), scope("property_insurance"), scope("property_taxes"), scope("hoa_payments"),
      property?.id
        ? supabase.from("property_licenses").select("license_type, license_number, expiry_date, status").eq("company_id", companyId).eq("property_id", property.id).order("expiry_date", { ascending: false })
        : Promise.resolve({ data: [] }),
    ]);
    const l0 = (ln.data || [])[0];
    if (l0) {
      data["loan.lender"] = l0.lender_name || "";
      data["loan.account_number"] = l0.account_number || "";
      data["loan.balance"] = l0.current_balance ? formatCurrency(l0.current_balance) : "";
      data["loan.monthly_payment"] = l0.monthly_payment ? formatCurrency(l0.monthly_payment) : "";
    }
    const i0 = (ins.data || [])[0];
    if (i0) {
      data["insurance.provider"] = i0.provider || "";
      data["insurance.policy_number"] = i0.policy_number || "";
      data["insurance.coverage"] = i0.coverage_amount ? formatCurrency(i0.coverage_amount) : "";
      data["insurance.expires"] = i0.expiration_date || "";
    }
    const t0 = (tax.data || [])[0];
    if (t0) {
      data["tax.county"] = t0.county || "";
      data["tax.parcel_id"] = t0.parcel_id || "";
      data["tax.annual_amount"] = t0.annual_tax_amount ? formatCurrency(t0.annual_tax_amount) : "";
    }
    const h0 = (hoa.data || [])[0];
    if (h0) {
      data["hoa.name"] = h0.hoa_name || "";
      data["hoa.amount"] = h0.amount ? formatCurrency(h0.amount) : "";
      data["hoa.frequency"] = h0.frequency || "";
    }
    // The newest licence of each kind. A court filing needs these numbers.
    const newest = (types) => (lic.data || []).find(x => types.includes(String(x.license_type || "").toLowerCase()) && x.license_number);
    const rental = newest(["rental_license"]), reg = newest(["rental_registration"]), lead = newest(["lead_paint", "lead_risk_assessment"]);
    data["license.rental_number"] = rental?.license_number || "";
    data["license.rental_expires"] = rental?.expiry_date || "";
    data["license.registration_number"] = reg?.license_number || "";
    data["license.lead_number"] = lead?.license_number || "";
  }

  // ── Context
  data["today"] = formatLocalDate(new Date());
  data["user.name"] = userProfile?.name || "";
  data["user.email"] = userProfile?.email || "";
  data["company.name"] = activeCompany?.name || "";

  // Who signs, by role. Tenants first, the landlord last.
  const signers = {
    tenants: [
      ...(tenant ? [{ name: tenant.name || "", email: tenant.email || "" }]
        : prospect ? [{ name: prospect.name || "", email: prospect.email || "" }] : []),
      ...coTenants.map(c => ({ name: c.name, email: c.email })),
    ],
    landlord: { name: userProfile?.name || activeCompany?.name || "", email: userProfile?.email || "" },
  };

  return { data, tenant, lease, property, prospect, coTenants, tenantChoices, signers };
}

// ── A prospect's lease terms, read back out of a filled-in document ─────
// Staff adjust the rent or the dates while filling in the lease; the
// prospect record has to agree with the lease that was actually sent,
// because conversion charges what the record says. The template's own
// prefill_from mapping says which field holds which term, so this works
// for any lease template rather than for one field-naming scheme.
const TERM_BY_PREFILL = { "lease.start_date": "lease_start", "lease.end_date": "lease_end", "lease.rent_amount": "rent", "lease.security_deposit": "security_deposit" };
const isoDate = (v) => {
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}` : null;
};
export function prospectTermsFromFields(template, fieldValues) {
  const out = {};
  for (const f of (template?.fields || [])) {
    const term = TERM_BY_PREFILL[f.prefill_from];
    const raw = fieldValues?.[f.name];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    if (term === "lease_start" || term === "lease_end") { const d = isoDate(raw); if (d) out[term] = d; }
    else if (term === "rent" || term === "security_deposit") {
      const n = parseFloat(String(raw).replace(/[^0-9.-]/g, ""));
      if (Number.isFinite(n) && n >= 0) out[term] = Math.round(n * 100) / 100;
    }
    else if (f.name === "landlord_utilities" || f.name === "tenant_utilities") out[f.name] = String(raw).trim();
  }
  return out;
}

/** Default name + email for a template's signer role, from a loaded context. */
export { signerDefaultFor, WITNESS_PREFIX, isWitnessRole, witnessedRole, effectiveSignerRoles } from "./signerRoles";

// ── The device's own mail app ──────────────────────────────────────────
// The app's own sending (Resend, from notifications@...) is what makes
// reminders and "next signer" emails possible, and it logs every send. But
// staff sometimes want a message to come from their own address and sit in
// their own Sent folder. These build a draft for whatever mail program the
// device uses. Two limits, both stated on screen: a web page cannot attach
// a file to a mailto: draft (so a computer gets a link to the PDF, while a
// phone's share sheet can carry the file itself), and the app cannot know
// whether the draft was ever sent.
export function mailtoUrl({ to = [], subject = "", body = "" }) {
  const list = (Array.isArray(to) ? to : [to]).map(e => String(e || "").trim()).filter(e => /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(e));
  const q = [];
  if (subject) q.push("subject=" + encodeURIComponent(subject));
  if (body) q.push("body=" + encodeURIComponent(body));
  return "mailto:" + list.map(encodeURIComponent).join(",") + (q.length ? "?" + q.join("&") : "");
}
/** A draft asking one signer to sign, carrying their own link. */
export function signingMailto({ signer, docName, origin, senderName = "" }) {
  const link = String(origin || "").replace(/\/$/, "") + "/sign/" + signer.access_token;
  const first = String(signer.signer_name || "").trim().split(/\s+/)[0];
  return mailtoUrl({
    to: [signer.signer_email],
    subject: "Please sign: " + docName,
    body: (first ? "Hi " + first + "," : "Hello,") + "\n\n" + docName + " is ready for your signature. Use this link to read and sign it (no account needed):\n\n" + link
      + "\n\nThe link is yours alone; please do not forward it." + (senderName ? "\n\n" + senderName : ""),
  });
}
/** Can this device hand a file to its share sheet (which includes its mail app)? */
export function canShareFile(file) {
  try { return typeof navigator !== "undefined" && typeof navigator.share === "function" && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] }); }
  catch { return false; }
}

/** A draft, in the device's own mail app, carrying an applicant's application link. */
export function applicationMailto({ application, origin, companyName = "" }) {
  const link = String(origin || "").replace(/\/$/, "") + "/apply/" + application.access_token;
  const first = String(application.applicant_name || "").trim().split(/\s+/)[0];
  return mailtoUrl({
    to: [application.applicant_email],
    subject: "Your rental application",
    body: (first ? "Hi " + first + "," : "Hello,") + "\n\nPlease fill in your rental application here (about ten minutes, signed online, no account needed):\n\n" + link
      + "\n\nThe link is yours alone; please do not forward it." + (companyName ? "\n\n" + companyName : ""),
  });
}
