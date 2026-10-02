// The daily clock. Reached as /api/daily-reminders?task=lease-clock.
//
// Dates used to be stored and never acted on. Once a day, for each company:
//   1. lease changes whose day has come take effect (a renewal's new term, a
//      rent increase) -- the app also does this when someone opens it, this
//      makes it true on a day nobody does;
//   2. signers who have sat on a request are reminded, if the company turned
//      that on (company_settings.auto_remind_signers_days, 0 = off);
//   3. staff are emailed what newly needs attention: a lease ending, a
//      document nobody has signed, a signing link about to die, a signed
//      applicant whose start date has arrived, a deposit statement coming
//      due. Each thing is said once (lease_clock_notified); the full,
//      current list is the "Needs attention" card on the dashboard.
//
// What needs attention is decided by ONE place, the database function
// lease_clock_items, which the dashboard card reads too.
//
// Every email goes through deliver() in _doc-email-impl.js, so the test
// site's safety applies here unchanged: outside production nothing is sent
// except to the allowlist.
const { isCronSecretBearer, cronSecretMatches } = require("./_auth");
const { serviceClient } = require("./_member");
const docEmail = require("./_doc-email-impl");

const MAX_AUTO_REMINDERS = 3;
const DIGEST_LINES = 20;
const TIME_BUDGET_MS = 50000;
const SEVERITY_LABEL = { overdue: "Overdue", high: "Soon", normal: "Coming up" };

// ── pure ───────────────────────────────────────────────────────────────
function pickNew(items, notifiedKeys) {
  const seen = new Set(notifiedKeys || []);
  return (items || []).filter(i => i && i.item_key && !seen.has(i.item_key));
}

// Signers due an automatic reminder: asked at least once, `days` since the
// last time they heard from us, and not yet reminded MAX_AUTO_REMINDERS
// times. days <= 0 means the company has it switched off.
function signersDue(sigs, days, nowMs = Date.now(), max = MAX_AUTO_REMINDERS) {
  const n = Math.floor(Number(days));
  if (!(n > 0)) return [];
  return (sigs || []).filter(s => {
    if (!s || !["sent", "viewed"].includes(s.status)) return false;
    if (!s.request_emailed_at) return false;
    if ((Number(s.reminder_count) || 0) >= max) return false;
    const last = Date.parse(s.last_reminded_at || s.request_emailed_at);
    return Number.isFinite(last) && nowMs - last >= n * 86400000;
  });
}

function digest({ newItems, total, company, base }) {
  const { shell, button, esc } = docEmail.mail;
  const shown = newItems.slice(0, DIGEST_LINES);
  const more = newItems.length - shown.length;
  const n = newItems.length;
  const subject = `${n} thing${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} attention` + (company.name ? ` — ${company.name}` : "");
  const rows = shown.map(i =>
    `<tr><td style="padding:8px 10px 8px 0;vertical-align:top;white-space:nowrap;color:${i.severity === "overdue" ? "#b91c1c" : i.severity === "high" ? "#b45309" : "#6b7280"};font-size:12px;font-weight:600">${esc(SEVERITY_LABEL[i.severity] || "")}</td>`
    + `<td style="padding:8px 0;border-bottom:1px solid #f3f4f6"><strong>${esc(i.title)}</strong><br><span style="color:#4b5563;font-size:13px">${esc(i.detail)}</span></td></tr>`).join("");
  const html = shell("New today",
    `<table style="width:100%;border-collapse:collapse">${rows}</table>`
    + (more > 0 ? `<p style="color:#6b7280;font-size:13px">And ${more} more.</p>` : "")
    + (total > n ? `<p style="color:#6b7280;font-size:13px">${total} things are waiting in all. The rest were in an earlier email.</p>` : "")
    + button(`${base}/dashboard`, "Open the dashboard")
    + `<p style="color:#6b7280;font-size:12px">Each item is emailed once. The dashboard always shows the full, current list, and anything can be dismissed there. Turn this email off in Settings.</p>`,
    company.name);
  const text = shown.map(i => `- ${i.title}: ${i.detail}`).join("\n") + (more > 0 ? `\nAnd ${more} more.` : "") + `\n\nOpen the dashboard: ${base}/dashboard`;
  return { subject, html, text };
}

// ── handler ────────────────────────────────────────────────────────────
async function runCompany(sb, req, company, { dryRun = false } = {}) {
  const out = { companyId: company.id };
  const base = docEmail.mail.appUrl(req);

  // 1. Changes whose day has come.
  if (!dryRun) {
    const applied = await sb.rpc("apply_due_lease_changes", { p_company_id: company.id });
    if (applied.error) out.apply_error = applied.error.message;
    else if (applied.data && (applied.data.applied || applied.data.failed)) out.lease_changes = applied.data;
  }

  const { data: settings } = await sb.from("company_settings").select("lease_clock_digest, auto_remind_signers_days").eq("company_id", company.id).maybeSingle();
  const remindDays = settings ? Number(settings.auto_remind_signers_days) || 0 : 0;
  const digestOn = settings ? settings.lease_clock_digest !== false : true;

  // 2. Signers who have not signed.
  if (remindDays > 0) {
    const { data: sigs } = await sb.from("doc_signatures").select("*").eq("company_id", company.id).in("status", ["sent", "viewed"])
      .not("request_emailed_at", "is", null).lt("reminder_count", MAX_AUTO_REMINDERS).limit(200);
    const due = signersDue(sigs, remindDays);
    out.reminders = { due: due.length, sent: 0, failed: 0 };
    const docs = new Map();
    for (const sig of due) {
      if (!docs.has(sig.doc_id)) {
        const { data: doc } = await sb.from("doc_generated").select("*").eq("id", sig.doc_id).eq("company_id", company.id).maybeSingle();
        docs.set(sig.doc_id, doc || null);
      }
      const doc = docs.get(sig.doc_id);
      if (!doc || doc.envelope_status !== "out_for_signature" || doc.archived_at) continue;
      if (dryRun) continue;
      const { r } = await docEmail.remindSigner(sb, req, { sig, doc, company, createdBy: "daily clock" });
      if (r.status === "failed") out.reminders.failed++; else out.reminders.sent++;
    }
  }

  // 3. What is newly waiting.
  const { data: items, error: iErr } = await sb.rpc("lease_clock_items", { p_company_id: company.id });
  if (iErr) { out.error = iErr.message; return out; }
  out.items = (items || []).length;
  if (!out.items) return out;

  const keys = items.map(i => i.item_key);
  const notified = [];
  for (let i = 0; i < keys.length; i += 100) {
    const { data, error } = await sb.from("lease_clock_notified").select("item_key").eq("company_id", company.id).in("item_key", keys.slice(i, i + 100));
    if (error) { out.error = error.message; return out; }
    for (const r of data || []) notified.push(r.item_key);
  }
  const fresh = pickNew(items, notified);
  out.new_items = fresh.length;
  if (!fresh.length || !digestOn || dryRun) { if (!digestOn) out.digest = "off"; return out; }

  const { data: admins } = await sb.from("company_members").select("user_email").eq("company_id", company.id).eq("role", "admin").eq("status", "active");
  const to = [...new Set((admins || []).map(a => String(a.user_email || "").trim().toLowerCase()).filter(Boolean))];
  if (!to.length) { out.digest = "nobody to tell"; return out; }
  const mail = digest({ newItems: fresh, total: items.length, company, base });
  let told = 0;
  for (const email of to) {
    const r = await docEmail.deliver(sb, { companyId: company.id, kind: "clock_digest", to: email, createdBy: "daily clock", ...mail });
    if (r.status !== "failed") told++;
  }
  out.digest = { to: to.length, told };
  // Said once -- unless every send failed, in which case tomorrow tries again.
  if (told > 0) {
    const rows = fresh.map(i => ({ company_id: company.id, item_key: i.item_key }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await sb.from("lease_clock_notified").upsert(rows.slice(i, i + 200), { onConflict: "company_id,item_key", ignoreDuplicates: true });
      if (error) { out.notified_error = error.message; break; }
    }
  }
  return out;
}

async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET || "";
  const authHeader = req.headers.authorization || "";
  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const isCronAuth = CRON_SECRET.length >= 8 && (
    isCronSecretBearer(authHeader, CRON_SECRET) || cronSecretMatches(body.cron_secret || "", CRON_SECRET)
  );
  if (!isCronAuth) { res.status(401).json({ error: "Unauthorized" }); return; }

  const sb = serviceClient();
  if (!sb) { res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY or URL not configured" }); return; }

  // One company (a manual run, a test) or all of them.
  const only = String(body.company_id || (req.query && req.query.company_id) || "");
  const dryRun = body.dry_run === true || (req.query && req.query.dry_run === "1");
  let q = sb.from("companies").select("id, name, email").is("archived_at", null);
  if (only) q = q.eq("id", only);
  const { data: companies, error } = await q;
  if (error) { res.status(500).json({ error: error.message }); return; }

  const started = Date.now();
  const results = [];
  let skipped = 0;
  for (const company of companies || []) {
    // One at a time: each run posts and emails, and a failure has to be
    // attributable. Stop before the platform stops us; tomorrow resumes.
    if (Date.now() - started > TIME_BUDGET_MS) { skipped++; continue; }
    try { results.push(await runCompany(sb, req, { ...company, id: String(company.id) }, { dryRun })); }
    catch (e) { results.push({ companyId: String(company.id), error: String((e && e.message) || e) }); }
  }
  const failed = results.filter(r => r.error);
  res.status(failed.length || skipped ? 207 : 200).json({
    ok: failed.length === 0 && skipped === 0,
    companies: (companies || []).length,
    not_reached: skipped,
    results: results.filter(r => r.items || r.error || r.lease_changes || r.reminders || r.apply_error),
  });
}

module.exports = handler;
module.exports.pickNew = pickNew;
module.exports.signersDue = signersDue;
module.exports.digest = digest;
module.exports.MAX_AUTO_REMINDERS = MAX_AUTO_REMINDERS;
