// Failure to pay rent: reading what the forms need and recording what was
// made. The rules live in arrears.js and courtForms.js (pure); this is the
// part that talks to the database.
import { supabase } from "../supabase";
import { fetchAllPaged } from "./accounting";
import { loadDocContext } from "./docService";
import { formatLocalDate } from "./helpers";
import { pmError } from "./errors";
import { entriesFromLines, fifoArrears, money } from "./arrears";
import { splitAddress, courtFor, cureDeadline, usDate, noticeMethod, NOTICE_DAYS } from "./courtForms";

const BUCKET = "documents";

/** Every posted line on the tenant's own receivable account(s). */
export async function loadTenantArLines(companyId, tenantId) {
  const { data: accts, error } = await supabase.from("acct_accounts").select("id").eq("company_id", companyId).eq("tenant_id", tenantId);
  if (error) { pmError("PM-4006", { raw: error, context: "failure to pay: find tenant ledger", silent: true }); return { lines: [], failed: true }; }
  const ids = (accts || []).map(a => a.id);
  if (!ids.length) return { lines: [], failed: false };
  const { rows, failed } = await fetchAllPaged(() => supabase.from("acct_journal_lines")
    .select("id, debit, credit, memo, acct_journal_entries!inner(date, status, description, reference, transaction_type, created_at)")
    .eq("company_id", companyId).in("account_id", ids).eq("acct_journal_entries.status", "posted").order("id"), "tenant receivable lines");
  const lines = (rows || []).map(l => {
    const je = Array.isArray(l.acct_journal_entries) ? l.acct_journal_entries[0] : l.acct_journal_entries;
    return { id: l.id, debit: l.debit, credit: l.credit, memo: l.memo || "", date: String(je?.date || "").slice(0, 10), description: je?.description || "", reference: je?.reference || "", transactionType: je?.transaction_type || "", createdAt: je?.created_at || "" };
  });
  return { lines, failed };
}

/** Everything a notice or a worksheet needs about one tenant. */
export async function loadFtprContext({ companyId, tenantId, userProfile = null, activeCompany = null }) {
  const [ctx, companyRes, ledger, caseRes] = await Promise.all([
    loadDocContext({ companyId, tenantId, userProfile, activeCompany }),
    supabase.from("companies").select("name, address, phone, email").eq("id", companyId).maybeSingle(),
    loadTenantArLines(companyId, tenantId),
    supabase.from("eviction_cases").select("*").eq("company_id", companyId).eq("tenant_id", tenantId).eq("status", "active").eq("reason", "non_payment").order("created_at", { ascending: false }).limit(1),
  ]);
  return { ...ctx, company: companyRes.data || { name: activeCompany?.name || "" }, lines: ledger.lines, ledgerFailed: ledger.failed, openCase: (caseRes.data || [])[0] || null };
}

/** The names, addresses and numbers the forms ask for, from the context. */
export function partiesFrom(ctx) {
  const t = ctx.tenant || {}, p = ctx.property || {}, c = ctx.company || {}, d = ctx.data || {};
  const co = splitAddress(c.address || "");
  const street = [p.address_line_1, p.address_line_2].map(s => String(s || "").trim()).filter(Boolean).join(", ");
  const csz = [p.city, [p.state, p.zip].filter(Boolean).join(" ")].map(s => String(s || "").trim()).filter(Boolean).join(", ");
  const fallback = splitAddress(p.address || t.property || "");
  const voucher = !!t.is_voucher;
  const leaseRent = Number(ctx.lease?.rent_amount) || Number(t.rent) || 0;
  return {
    landlord: { name: c.name || "", address: co.street, cityStateZip: co.cityStateZip, phone: c.phone || "", email: c.email || "" },
    tenants: [{ name: t.name || "", email: t.email || "" }, ...(ctx.coTenants || []).map(x => ({ name: x.name, email: x.email || "" }))],
    premises: { address: street || fallback.street, cityStateZip: csz || fallback.cityStateZip },
    tenantPhone: t.phone || "",
    court: courtFor(p.county, p.city),
    license: { number: d["license.rental_number"] || d["license.registration_number"] || "", expires: d["license.rental_expires"] || "" },
    lead: { number: d["license.lead_number"] || "" },
    voucher,
    monthlyRent: voucher && Number(t.tenant_portion) > 0 ? Number(t.tenant_portion) : leaseRent,
    fullRent: leaseRent,
    dueDay: Number(ctx.lease?.payment_due_day) || 1,
  };
}

/** The claim, from the ledger, with a person's corrections to what counts as rent. */
export function claimFrom(ctx, overrides = {}) {
  const entries = entriesFromLines(ctx.lines || [], overrides);
  return fifoArrears(entries, { voucher: !!ctx.tenant?.is_voucher });
}

async function sha256Hex(bytes) {
  try {
    const buf = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  } catch (_e) { return null; }
}

// One generated-document row with its PDF stored beside it. If the file
// cannot be stored the row is archived again: a "notice" with no file
// behind it would be worse than none.
async function storeCourtDoc({ companyId, ctx, kind, name, summary, fields, pdfBytes, userEmail, extra = {} }) {
  const row = {
    company_id: companyId, template_id: null, name, field_values: fields, rendered_body: summary, status: "final", output_type: "court_form",
    property_address: ctx.property?.address || ctx.tenant?.property || "", tenant_name: ctx.tenant?.name || "",
    tenant_id: ctx.tenant?.id ?? null, lease_id: ctx.lease?.id ?? null, property_id: ctx.property?.id ?? null,
    doc_kind: kind, created_by: userEmail || null, ...extra,
  };
  const { data: doc, error } = await supabase.from("doc_generated").insert([row]).select("id").maybeSingle();
  if (error || !doc) { pmError("PM-7003", { raw: error, context: "save court document" }); return { error: "The document could not be saved." }; }
  const path = `${companyId}/generated/${doc.id}.pdf`;
  const up = await supabase.storage.from(BUCKET).upload(path, new Blob([pdfBytes], { type: "application/pdf" }), { contentType: "application/pdf", upsert: true });
  if (up.error) {
    await supabase.from("doc_generated").update({ archived_at: new Date().toISOString(), archived_by: userEmail || "" }).eq("company_id", companyId).eq("id", doc.id);
    pmError("PM-7003", { raw: up.error, context: "store court document PDF" });
    return { error: "The PDF could not be stored." };
  }
  const hash = await sha256Hex(pdfBytes);
  await supabase.from("doc_generated").update({ pdf_output_path: path, ...(hash ? { pdf_output_hash: hash } : {}) }).eq("company_id", companyId).eq("id", doc.id);
  return { docId: doc.id, path };
}

const snapshot = (claim) => ({
  rent: claim.rent, lateFees: claim.lateFees, total: claim.total, notClaimed: claim.notClaimed, manual: !!claim.manual, voucherTenancy: !!claim.voucherTenancy,
  open: (claim.open || []).slice(0, 200).map(c => ({ date: c.date, label: String(c.label || "").slice(0, 120), category: c.category, charged: c.charged, stillOpen: c.stillOpen })),
});
// The case screen reads stage_history with JSON.parse: it is stored as text.
const historyOf = (evCase) => { try { const h = JSON.parse(evCase?.stage_history || "[]"); return Array.isArray(h) ? h : []; } catch (_e) { return []; } };

/**
 * The Notice of Intent was made: store it, and open (or update) the case.
 * The tenant's status is NOT changed: this is not a notice to vacate, and
 * the tenancy carries on if they pay.
 */
export async function saveNotice({ companyId, ctx, parties, claim, noticeDate, method, pdfBytes, userEmail }) {
  const deadline = cureDeadline(noticeDate);
  const m = noticeMethod(method);
  const stored = await storeCourtDoc({
    companyId, ctx, kind: "notice_of_intent", pdfBytes, userEmail,
    name: "Notice of Intent to File (DC-CV-115) — " + (ctx.tenant?.name || "Tenant") + " " + noticeDate,
    summary: `<p>Notice of Intent to File a Complaint for Summary Ejectment (Failure to Pay Rent), court form DC-CV-115, stored as a PDF.</p><p>Total claimed: $${money(claim.total).toFixed(2)}. Provided ${usDate(noticeDate)} by ${m ? m.label.toLowerCase() : method}. The tenant may pay until the end of ${usDate(deadline)}.</p>`,
    fields: { notice_date: noticeDate, method, cure_deadline: deadline, claim: snapshot(claim) },
    extra: { served_at: noticeDate + "T12:00:00", served_method: method, effective_date: deadline },
  });
  if (stored.error) return stored;

  const entry = { stage: "notice", date: noticeDate, note: `Notice of Intent (DC-CV-115) provided by ${m ? m.label.toLowerCase() : method}: $${money(claim.total).toFixed(2)} claimed. The tenant has until ${usDate(deadline)} to pay.`, cost: 0, by: userEmail || "" };
  const facts = {
    reason: "non_payment", notice_type: "notice_of_intent", notice_days: NOTICE_DAYS, notice_date: noticeDate, cure_deadline: deadline,
    lease_id: ctx.lease?.id ?? null, property_id: ctx.property?.id ?? null, court: parties.court || null,
    claim_rent: money(claim.rent.amount), claim_late_fees: money(claim.lateFees.amount), claim_total: money(claim.total), claim_detail: { notice: snapshot(claim) },
    notice_served_on: noticeDate, notice_served_method: method, notice_doc_id: stored.docId,
  };
  let caseId = ctx.openCase?.id || null;
  if (caseId) {
    // A corrected or re-issued notice on a case that is still at the notice
    // stage restarts the ten days. A case already in court is left alone.
    const early = ["notice", "cure_period"].includes(ctx.openCase.current_stage);
    const upd = early ? { ...facts, current_stage: "notice", stage_history: JSON.stringify([...historyOf(ctx.openCase), entry]) }
      : { stage_history: JSON.stringify([...historyOf(ctx.openCase), { ...entry, note: "A further " + entry.note }]) };
    const { error } = await supabase.from("eviction_cases").update(upd).eq("company_id", companyId).eq("id", caseId);
    if (error) { pmError("PM-8006", { raw: error, context: "update failure-to-pay case" }); return { error: "The notice was saved, but the case could not be updated.", docId: stored.docId, path: stored.path }; }
  } else {
    const { data, error } = await supabase.from("eviction_cases").insert([{
      company_id: companyId, tenant_id: ctx.tenant.id, tenant_name: ctx.tenant.name, property: ctx.property?.address || ctx.tenant.property || "",
      current_stage: "notice", status: "active", total_costs: 0, stage_history: JSON.stringify([entry]), ...facts,
    }]).select("id").maybeSingle();
    if (error || !data) { pmError("PM-8006", { raw: error, context: "open failure-to-pay case" }); return { error: "The notice was saved, but the case could not be opened.", docId: stored.docId, path: stored.path }; }
    caseId = data.id;
  }
  await supabase.from("doc_generated").update({ eviction_case_id: caseId }).eq("company_id", companyId).eq("id", stored.docId);
  return { ok: true, docId: stored.docId, path: stored.path, caseId, deadline };
}

/** The complaint worksheet was made: store it on the case. */
export async function saveWorksheet({ companyId, ctx, evCase, claim, total, answers, pdfBytes, userEmail }) {
  const today = formatLocalDate(new Date());
  const stored = await storeCourtDoc({
    companyId, ctx, kind: "ftpr_complaint", pdfBytes, userEmail,
    name: "Complaint worksheet (DC-CV-082) — " + (ctx.tenant?.name || evCase.tenant_name || "Tenant") + " " + today,
    summary: `<p>Worksheet for the Failure to Pay Rent complaint, court form DC-CV-082, stored as a PDF. The court requires its own paper form; this lists every answer to copy onto it.</p><p>Total: $${money(total).toFixed(2)}.</p>`,
    fields: { prepared_on: today, claim: snapshot(claim), total: money(total), answers },
    extra: { eviction_case_id: evCase.id },
  });
  if (stored.error) return stored;
  const detail = { ...(evCase.claim_detail && typeof evCase.claim_detail === "object" ? evCase.claim_detail : {}), complaint: { ...snapshot(claim), total: money(total), prepared_on: today, answers } };
  const entry = { stage: evCase.current_stage, date: today, note: `Complaint worksheet (DC-CV-082) prepared: $${money(total).toFixed(2)}.`, cost: 0, by: userEmail || "" };
  const { error } = await supabase.from("eviction_cases").update({ complaint_doc_id: stored.docId, claim_detail: detail, stage_history: JSON.stringify([...historyOf(evCase), entry]) }).eq("company_id", companyId).eq("id", evCase.id);
  if (error) { pmError("PM-8006", { raw: error, context: "attach complaint worksheet" }); return { error: "The worksheet was saved, but the case could not be updated.", docId: stored.docId, path: stored.path }; }
  return { ok: true, docId: stored.docId, path: stored.path };
}

/** The complaint was filed with the court. */
export async function recordFiling({ companyId, evCase, filedOn, caseNumber, court, claimTotal = null, userEmail }) {
  const entry = { stage: "filing", date: filedOn, note: "Complaint filed" + (court ? " in the " + court : "") + (caseNumber ? ". Case number " + caseNumber : "") + ".", cost: 0, by: userEmail || "" };
  const upd = { current_stage: "filing", filing_date: filedOn, case_number: caseNumber || null, court: court || null, stage_history: JSON.stringify([...historyOf(evCase), entry]) };
  if (claimTotal !== null) upd.claim_total = money(claimTotal);
  const { error } = await supabase.from("eviction_cases").update(upd).eq("company_id", companyId).eq("id", evCase.id);
  if (error) { pmError("PM-8006", { raw: error, context: "record court filing" }); return { error: "The filing could not be recorded." }; }
  return { ok: true };
}

/** Case number, court and dates can be corrected at any time. */
export async function updateCaseFacts({ companyId, caseId, facts }) {
  const allowed = ["case_number", "court", "hearing_date", "judgment_date", "writ_date", "cured_on"];
  const upd = Object.fromEntries(Object.entries(facts || {}).filter(([k]) => allowed.includes(k)).map(([k, v]) => [k, v === "" ? null : v]));
  if (!Object.keys(upd).length) return { ok: true };
  const { error } = await supabase.from("eviction_cases").update(upd).eq("company_id", companyId).eq("id", caseId);
  if (error) { pmError("PM-8006", { raw: error, context: "update court case facts" }); return { error: "The case could not be updated." }; }
  return { ok: true };
}

/** The documents made for a case, oldest first. */
export async function loadCaseDocs(companyId, caseId) {
  const { data, error } = await supabase.from("doc_generated").select("id, name, doc_kind, created_at, pdf_output_path, served_at, served_method, effective_date")
    .eq("company_id", companyId).eq("eviction_case_id", caseId).is("archived_at", null).order("created_at", { ascending: true });
  if (error) { pmError("PM-7003", { raw: error, context: "load case documents", silent: true }); return []; }
  return data || [];
}
