// Document email + envelope actions. Reached as /api/notifications?action=doc
// (a new route file would be the 13th function on a plan that allows 12).
//
// Why this exists. Every "please sign" email and every "Send via Email" in
// the Document Builder called supabase.functions.invoke("send-email") -- an
// edge function that is in no repo and deployed to no project. Each call
// failed, the failure was logged "silent", and nobody was ever emailed. The
// signed-copy email went a second way (notification_queue) to a worker that
// is paused and unscheduled, with a template that carried no link.
//
// One path now, and it leaves a record: every attempt writes a doc_email_log
// row saying where the mail was meant to go, where it went, and whether it
// left.
//
// Body: { op, ... }
//   send-requests  { company_id, doc_id }                 staff  email every signer whose turn it is
//   resend         { company_id, signature_id }           staff  remind one signer, extend their link
//   void           { company_id, doc_id, reason }         staff  cancel an envelope
//   next-signers   { token }                              signer after signing: ask whoever is next
//   send-document  { company_id, doc_id, to[], message, pdf_base64, filename }   staff
//   application-request { company_id, application_id }    staff  email an applicant their application link
//
// SAFETY: outside production nothing is sent unless DOC_EMAIL_ALLOWLIST is
// set, and then only to addresses on it -- mail for anyone else is redirected
// to the first address on the list with the intended recipient in the
// subject. The test database holds real tenants' email addresses.
const { Resend } = require("resend");
const { requireMember, serviceClient } = require("./_member");

const SEND_ROLES = new Set(["admin", "pm", "manager", "office_assistant"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LINK_DAYS = 30;

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const appUrl = (req) => {
  const env = (process.env.APP_URL || "").replace(/\/$/, "");
  if (env) return env;
  const origin = req && req.headers && (req.headers.origin || (req.headers.host ? "https://" + req.headers.host : ""));
  return String(origin || "").replace(/\/$/, "");
};
const allowlist = () => (process.env.DOC_EMAIL_ALLOWLIST || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const isProduction = () => (process.env.VERCEL_ENV || "") === "production";

function shell(title, bodyHtml, companyName) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1f2937;font-size:15px;line-height:1.5">`
    + `<h2 style="font-size:18px;margin:0 0 12px">${esc(title)}</h2>${bodyHtml}`
    + `<p style="color:#6b7280;font-size:12px;margin-top:28px;border-top:1px solid #e5e7eb;padding-top:12px">Sent by ${esc(companyName || "Housify")} through Housify.</p></div>`;
}
const button = (href, label) => `<p style="margin:20px 0"><a href="${esc(href)}" style="background:#4f46e5;color:#ffffff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${esc(label)}</a></p>`
  + `<p style="color:#6b7280;font-size:12px">If the button does not work, copy this link into your browser:<br>${esc(href)}</p>`;

/**
 * Send one email and log it. Never throws: returns { ok, status, to, error }.
 * status: sent | failed | suppressed
 */
async function deliver(sb, { companyId, docId = null, signatureId = null, kind, to, subject, html, text, attachments = null, replyTo = null, createdBy = null }) {
  const intended = String(to || "").trim().toLowerCase();
  let actual = intended, subj = subject, status = "sent", error = null, providerId = null;
  const list = allowlist();
  try {
    if (!EMAIL_RE.test(intended)) throw new Error("not a valid email address");
    if (!isProduction()) {
      if (!list.length) { status = "suppressed"; error = "not production and no DOC_EMAIL_ALLOWLIST: nothing is sent"; }
      else if (!list.includes(intended)) { actual = list[0]; subj = `[TEST, meant for ${intended}] ${subject}`; }
    }
    if (status === "sent" && (process.env.DOC_EMAIL_TRANSPORT || "") === "log") { status = "suppressed"; error = "DOC_EMAIL_TRANSPORT=log"; }
    if (status === "sent") {
      // DOC_RESEND_API_KEY lets a test site send THESE emails (allowlisted
      // above) while its general RESEND_API_KEY stays a dead value, so the
      // reminder and invite routes there still cannot email real people.
      const key = process.env.DOC_RESEND_API_KEY || process.env.RESEND_API_KEY || "";
      if (!key) throw new Error("no email key is configured");
      const resend = new Resend(key);
      const msg = { from: process.env.EMAIL_FROM || "Housify <notifications@housify365.com>", to: actual, subject: subj, html, text: text || undefined };
      if (replyTo && EMAIL_RE.test(replyTo)) msg.replyTo = replyTo;
      if (attachments && attachments.length) msg.attachments = attachments;
      const out = await resend.emails.send(msg);
      if (out && out.error) throw new Error(out.error.message || String(out.error.name || "send failed"));
      providerId = (out && out.data && out.data.id) || null;
    }
  } catch (e) {
    status = "failed"; error = String((e && e.message) || e).slice(0, 500);
  }
  try {
    await sb.from("doc_email_log").insert({
      company_id: companyId, doc_id: docId, signature_id: signatureId, kind,
      to_email: actual || intended || "?", intended_email: intended || null, subject: String(subj || "").slice(0, 300),
      status, error, provider_id: providerId, created_by: createdBy,
    });
  } catch (_e) { /* the log must never be the reason a send is reported as failed */ }
  return { ok: status === "sent", status, to: actual, intended, error };
}

async function companyOf(sb, companyId) {
  const { data } = await sb.from("companies").select("name, email").eq("id", companyId).maybeSingle();
  return data || { name: "", email: "" };
}

function signRequestEmail({ sig, doc, company, base, reminder }) {
  const link = `${base}/sign/${sig.access_token}`;
  const who = sig.signer_name ? `Hello ${esc(sig.signer_name)},` : "Hello,";
  const html = shell(reminder ? "Reminder: your signature is needed" : "Your signature is requested",
    `<p>${who}</p><p><strong>${esc(company.name || "Your property manager")}</strong> has sent you <strong>${esc(doc.name)}</strong> to review and sign electronically.</p>`
    + (doc.property_address ? `<p style="color:#4b5563">Property: ${esc(doc.property_address)}</p>` : "")
    + button(link, "Review and sign")
    + `<p style="color:#6b7280;font-size:13px">This link is personal to you and expires in ${LINK_DAYS} days. Please do not forward it.</p>`,
    company.name);
  const text = `${company.name || "Your property manager"} has sent you "${doc.name}" to review and sign.\n\nOpen this link to sign: ${link}\n\nThe link is personal to you and expires in ${LINK_DAYS} days.`;
  return { subject: (reminder ? "Reminder: please sign " : "Signature requested: ") + doc.name, html, text };
}

// Email everyone whose turn it is and who has not been emailed yet.
async function emailPendingSigners(sb, req, doc, { createdBy = null } = {}) {
  const { data: sigs } = await sb.from("doc_signatures")
    .select("id, signer_name, signer_email, signer_role, access_token, status, request_emailed_at")
    .eq("doc_id", doc.id).eq("status", "sent").is("request_emailed_at", null);
  const company = await companyOf(sb, doc.company_id);
  const base = appUrl(req);
  const results = [];
  for (const sig of sigs || []) {
    const mail = signRequestEmail({ sig, doc, company, base, reminder: false });
    const r = await deliver(sb, { companyId: doc.company_id, docId: doc.id, signatureId: sig.id, kind: "sign_request", to: sig.signer_email, replyTo: company.email, createdBy, ...mail });
    // Stamped unless the send FAILED: a failed request stays eligible, so
    // "Send" can simply be pressed again. A suppressed one (a test site
    // with sending off) counts as asked -- otherwise every later signer
    // would re-ask the same people each time they finished.
    if (r.status !== "failed") await sb.from("doc_signatures").update({ request_emailed_at: new Date().toISOString() }).eq("id", sig.id);
    results.push({ signature_id: sig.id, role: sig.signer_role, email: sig.signer_email, status: r.status, delivered_to: r.to, error: r.error });
  }
  return results;
}

// Remind one signer whose turn it is, and give their link a full term: a
// reminder is useless if the link died yesterday. Used by the "Remind"
// button and by the daily clock (api/_lease-clock-impl.js).
async function remindSigner(sb, req, { sig, doc, company, createdBy = null }) {
  const expires = new Date(Date.now() + LINK_DAYS * 86400000).toISOString();
  await sb.from("doc_signatures").update({ token_expires_at: expires }).eq("id", sig.id);
  const mail = signRequestEmail({ sig, doc, company, base: appUrl(req), reminder: !!sig.request_emailed_at });
  const r = await deliver(sb, { companyId: doc.company_id, docId: doc.id, signatureId: sig.id, kind: sig.request_emailed_at ? "sign_reminder" : "sign_request", to: sig.signer_email, replyTo: company.email, createdBy, ...mail });
  if (r.status !== "failed") {
    await sb.from("doc_signatures").update({
      request_emailed_at: sig.request_emailed_at || new Date().toISOString(),
      reminder_count: (sig.reminder_count || 0) + (sig.request_emailed_at ? 1 : 0),
      last_reminded_at: new Date().toISOString(),
    }).eq("id", sig.id);
  }
  return { r, expires };
}

// After the signed PDF is stored: file it where people look, send every
// signer their copy, tell the person who sent it.
async function afterSignedPdfStored(sb, req, doc, pdfBytes, certBytes = null) {
  const out = { filed_document_id: null, copies: [] };
  const company = await companyOf(sb, doc.company_id);

  // 1. File a copy under Documents so the tenant page, the property page and
  //    the tenant portal -- which all read the `documents` table and the
  //    `documents` bucket -- show it without knowing about envelopes.
  try {
    if (!doc.filed_document_id) {
      const path = `${doc.company_id}/signed/${doc.id}.pdf`;
      const up = await sb.storage.from("documents").upload(path, pdfBytes, { contentType: "application/pdf", upsert: true });
      if (up.error) throw new Error(up.error.message);
      const KIND_TYPE = { lease: "Lease", renewal: "Lease", addendum: "Lease", rent_increase_notice: "Notice", notice_to_vacate: "Notice", move_out_acknowledgment: "Notice", late_notice: "Notice", notice_of_intent: "Notice", deposit_disposition: "Financial", move_out_statement: "Financial" };
      const { data: row, error } = await sb.from("documents").insert({
        company_id: doc.company_id, name: `${doc.name} (signed).pdf`, type: KIND_TYPE[doc.doc_kind] || "Other",
        url: path, file_name: path, tenant: doc.tenant_name || "", property: doc.property_address || "",
        tenant_id: doc.tenant_id || null, property_id: doc.property_id || null, tenant_visible: true,
        // A prospect's lease: there is no tenant yet. The file is kept with
        // the prospect and follows them when they are converted. (Sent only
        // when set, so a database that predates prospects is unaffected.)
        ...(doc.prospect_id ? { prospect_id: doc.prospect_id } : {}),
      }).select("id").maybeSingle();
      if (error) throw new Error(error.message);
      if (row) { await sb.from("doc_generated").update({ filed_document_id: row.id }).eq("id", doc.id); out.filed_document_id = row.id; }
      // The lease record itself points at its signed copy (its
      // signature_status is kept by _sync_lease_signature_status).
      if (doc.lease_id) {
        const { error: lErr } = await sb.from("leases").update({ document_url: path }).eq("id", doc.lease_id).eq("company_id", doc.company_id);
        if (lErr) console.error("[doc] lease document_url not set:", lErr.message);
      }
    }
  } catch (e) {
    console.error("[doc] filing the signed copy failed:", e.message);
    out.filing_error = e.message;
  }

  // 2. A copy to each person who signed.
  const { data: sigs } = await sb.from("doc_signatures").select("id, signer_name, signer_email").eq("doc_id", doc.id).eq("status", "signed");
  const seen = new Set();
  // The signed lease and, as a second file, its certificate of completion.
  const safeName = (doc.name || "document").replace(/[^a-zA-Z0-9 _.-]+/g, "_").slice(0, 80);
  const attach = pdfBytes.length <= 8 * 1024 * 1024 ? [
    { filename: safeName + " (signed).pdf", content: pdfBytes },
    ...(certBytes && certBytes.length <= 4 * 1024 * 1024 ? [{ filename: safeName + " (certificate of completion).pdf", content: certBytes }] : []),
  ] : null;
  for (const sig of sigs || []) {
    const email = String(sig.signer_email || "").toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const html = shell("Your signed copy",
      `<p>${sig.signer_name ? "Hello " + esc(sig.signer_name) + "," : "Hello,"}</p><p>Everyone has signed <strong>${esc(doc.name)}</strong>. ${attach ? "Your signed copy is attached" + (attach.length > 1 ? ", with its certificate of completion as a second file" : "") + "." : "Reply to this email to request your copy."}</p><p>Please keep ${attach && attach.length > 1 ? "them" : "it"} for your records.</p>`,
      company.name);
    const r = await deliver(sb, { companyId: doc.company_id, docId: doc.id, signatureId: sig.id, kind: "signed_copy", to: email, subject: "Signed copy: " + doc.name,
      html, text: `Everyone has signed "${doc.name}". Your copy is attached.`, attachments: attach, replyTo: company.email });
    out.copies.push({ email, status: r.status, delivered_to: r.to });
  }

  // No email to the person who sent the envelope (Sahil, 2026-10-03): the
  // signed copy is filed under the tenant, prospect or lease, and History
  // shows the envelope as completed.
  return out;
}

async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_e) { body = {}; } }
  body = body || {};
  const op = String(body.op || "");
  const sb = serviceClient();
  if (!sb) { res.status(500).json({ error: "server is not configured for database access" }); return; }

  // ── signer-authenticated ────────────────────────────────────────────
  if (op === "next-signers") {
    const token = String(body.token || "");
    if (token.length < 20) { res.status(400).json({ error: "token required" }); return; }
    const { data: sig } = await sb.from("doc_signatures").select("id, doc_id, status").eq("access_token", token).maybeSingle();
    if (!sig || sig.status !== "signed") { res.status(403).json({ error: "this link has not signed" }); return; }
    const { data: doc } = await sb.from("doc_generated").select("id, company_id, name, property_address, envelope_status").eq("id", sig.doc_id).maybeSingle();
    if (!doc || doc.envelope_status !== "out_for_signature") { res.status(200).json({ results: [] }); return; }
    const results = await emailPendingSigners(sb, req, doc, { createdBy: "signer" });
    // The signer learns only how many were notified, never who.
    res.status(200).json({ notified: results.filter(r => r.status === "sent").length, asked: results.length });
    return;
  }

  // ── staff-authenticated ─────────────────────────────────────────────
  const auth = await requireMember(req, { companyId: body.company_id, roles: SEND_ROLES, sb });
  if (auth.error) { res.status(auth.status).json({ error: auth.error }); return; }
  const companyId = String(body.company_id);
  const actor = auth.user.email;
  const loadDoc = async (id) => {
    if (!id || typeof id !== "string") return null;
    const { data } = await sb.from("doc_generated").select("*").eq("id", id).eq("company_id", companyId).maybeSingle();
    return data || null;
  };

  if (op === "send-requests") {
    const doc = await loadDoc(body.doc_id);
    if (!doc) { res.status(404).json({ error: "document not found" }); return; }
    if (doc.envelope_status !== "out_for_signature") { res.status(409).json({ error: "this document is not out for signature" }); return; }
    const results = await emailPendingSigners(sb, req, doc, { createdBy: actor });
    res.status(200).json({ results });
    return;
  }

  if (op === "resend") {
    const { data: sig } = await sb.from("doc_signatures").select("*").eq("id", String(body.signature_id || "")).eq("company_id", companyId).maybeSingle();
    if (!sig) { res.status(404).json({ error: "signer not found" }); return; }
    if (!["sent", "viewed"].includes(sig.status)) { res.status(409).json({ error: sig.status === "pending" ? "it is not this signer's turn yet" : "this signer is " + sig.status }); return; }
    const doc = await loadDoc(sig.doc_id);
    if (!doc || doc.envelope_status !== "out_for_signature") { res.status(409).json({ error: "this document is not out for signature" }); return; }
    const company = await companyOf(sb, companyId);
    const { r, expires } = await remindSigner(sb, req, { sig, doc, company, createdBy: actor });
    res.status(200).json({ status: r.status, delivered_to: r.to, error: r.error, expires_at: expires });
    return;
  }

  if (op === "void") {
    const doc = await loadDoc(body.doc_id);
    if (!doc) { res.status(404).json({ error: "document not found" }); return; }
    if (doc.envelope_status === "completed") { res.status(409).json({ error: "a fully signed document cannot be cancelled" }); return; }
    if (doc.envelope_status !== "out_for_signature") { res.status(409).json({ error: "this document is not out for signature" }); return; }
    const { error: sErr } = await sb.from("doc_signatures").update({ status: "voided" }).eq("doc_id", doc.id).in("status", ["pending", "sent", "viewed"]);
    if (sErr) { res.status(500).json({ error: "could not cancel the signature requests" }); return; }
    const { error: dErr } = await sb.from("doc_generated").update({
      envelope_status: "voided", voided_at: new Date().toISOString(), voided_by: actor, void_reason: String(body.reason || "").slice(0, 500) || null,
    }).eq("id", doc.id);
    if (dErr) { res.status(500).json({ error: "could not cancel the document" }); return; }
    await sb.rpc("_sync_lease_signature_status", { p_doc_id: doc.id });
    res.status(200).json({ voided: true });
    return;
  }

  if (op === "send-document") {
    const doc = await loadDoc(body.doc_id);
    if (!doc) { res.status(404).json({ error: "document not found" }); return; }
    const to = Array.from(new Set((Array.isArray(body.to) ? body.to : []).map(s => String(s || "").trim().toLowerCase()).filter(Boolean)));
    if (!to.length) { res.status(400).json({ error: "at least one recipient is required" }); return; }
    if (to.length > 10) { res.status(400).json({ error: "at most 10 recipients" }); return; }
    const bad = to.filter(e => !EMAIL_RE.test(e));
    if (bad.length) { res.status(400).json({ error: "not a valid email address: " + bad[0] }); return; }
    let attachments = null;
    if (body.pdf_base64) {
      const bytes = Buffer.from(String(body.pdf_base64), "base64");
      if (bytes.length < 200 || bytes.slice(0, 4).toString() !== "%PDF") { res.status(400).json({ error: "attachment is not a PDF" }); return; }
      if (bytes.length > 8 * 1024 * 1024) { res.status(413).json({ error: "PDF too large to email" }); return; }
      attachments = [{ filename: String(body.filename || "document.pdf").replace(/[^a-zA-Z0-9 _.-]+/g, "_").slice(0, 100), content: bytes }];
    }
    const company = await companyOf(sb, companyId);
    const note = String(body.message || "").trim().slice(0, 4000);
    const html = shell(doc.name,
      (note ? `<p style="white-space:pre-line">${esc(note)}</p>` : `<p>Please find <strong>${esc(doc.name)}</strong> ${attachments ? "attached" : "below"}.</p>`)
      + (doc.property_address ? `<p style="color:#4b5563">Property: ${esc(doc.property_address)}</p>` : ""), company.name);
    const results = [];
    for (const email of to) {
      const r = await deliver(sb, { companyId, docId: doc.id, kind: "document", to: email, subject: doc.name, html, text: note || `Please find "${doc.name}" attached.`, attachments, replyTo: company.email, createdBy: actor });
      results.push({ email, status: r.status, delivered_to: r.to, error: r.error });
    }
    if (results.some(r => r.status === "sent")) {
      await sb.from("doc_generated").update({ status: "sent", sent_at: new Date().toISOString(), recipients: to }).eq("id", doc.id);
    }
    res.status(200).json({ results });
    return;
  }

  // Email an applicant the private link to their rental application.
  if (op === "application-request") {
    const { data: app } = await sb.from("prospect_applications").select("*").eq("id", String(body.application_id || "")).eq("company_id", companyId).maybeSingle();
    if (!app) { res.status(404).json({ error: "application not found" }); return; }
    if (!["sent", "opened"].includes(app.status)) { res.status(409).json({ error: app.status === "submitted" ? "this application has already been submitted" : "this application link has been withdrawn" }); return; }
    if (!EMAIL_RE.test(String(app.applicant_email || ""))) { res.status(400).json({ error: "there is no email address for this applicant" }); return; }
    const { data: prospect } = await sb.from("prospects").select("property").eq("id", app.prospect_id).maybeSingle();
    const company = await companyOf(sb, companyId);
    // A reminder is useless if the link died yesterday: give it a full term.
    const expires = new Date(Date.now() + LINK_DAYS * 86400000).toISOString();
    await sb.from("prospect_applications").update({ token_expires_at: expires }).eq("id", app.id);
    const link = `${appUrl(req)}/apply/${app.access_token}`;
    const who = app.applicant_name ? `Hello ${esc(String(app.applicant_name).split(/\s+/)[0])},` : "Hello,";
    const html = shell("Your rental application",
      `<p>${who}</p><p><strong>${esc(company.name || "Your property manager")}</strong> has asked you to fill in a rental application`
      + (prospect && prospect.property ? ` for <strong>${esc(prospect.property)}</strong>` : "") + `.</p>`
      + `<p>It takes about ten minutes and is signed online. It does not ask for your Social Security number or bank details.</p>`
      + button(link, "Fill in the application")
      + `<p style="color:#6b7280;font-size:13px">This link is personal to you and expires in ${LINK_DAYS} days. Please do not forward it.</p>`,
      company.name);
    const text = `${company.name || "Your property manager"} has asked you to fill in a rental application.\n\nOpen this link: ${link}\n\nThe link is personal to you and expires in ${LINK_DAYS} days.`;
    const r = await deliver(sb, { companyId, kind: "application_request", to: app.applicant_email, subject: "Your rental application" + (prospect && prospect.property ? ": " + prospect.property : ""), html, text, replyTo: company.email, createdBy: actor });
    if (r.status === "sent") await sb.from("prospect_applications").update({ request_emailed_at: new Date().toISOString() }).eq("id", app.id);
    res.status(200).json({ status: r.status, delivered_to: r.to, error: r.error });
    return;
  }

  res.status(400).json({ error: "unknown op" });
}

module.exports = handler;
module.exports.deliver = deliver;
module.exports.afterSignedPdfStored = afterSignedPdfStored;
module.exports.SEND_ROLES = SEND_ROLES;
module.exports.remindSigner = remindSigner;
module.exports.companyOf = companyOf;
module.exports.mail = { shell, button, esc, appUrl };
