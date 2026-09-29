import React, { useState, useEffect, useRef } from "react";
import ExcelJS from "exceljs";
import { supabase } from "../supabase";
import { Input, MoneyInput, Textarea, Select, Btn, PageHeader, TabBar, EmptyState} from "../ui";
import { safeNum, formatLocalDate, shortId, formatCurrency, parseLocalDate, normalizeEmail, exportToCSV, escapeHtml, sanitizeForPrint, formatPersonName, parseNameParts, formatPhoneInput, buildNameFields, escapeFilterValue, emailFilterValue, fmtDate, canManage, excelDate, EXCEL_DATE_FMT } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { queueNotification } from "../utils/notifications";
import { getPropertyClassId, atomicPostJEAndLedger, fetchAllPaged } from "../utils/accounting";
import { loadOwnerStatementData, syncPendingOwnerAccruals } from "../utils/owners";
import { resolveMgmtFeePct, feeLabel, parseFeeInput, payoutReference, toCents, distributionKind, isLivePayout, sumPayouts, buildOwnerStatement, statementRentSummary } from "../utils/ownerRules";
import { Spinner, Modal, StatCard, Badge } from "./shared";

// Build a formatted, printable HTML document for an owner statement.
// Replaces the old raw-JSON dump. Shared by the admin print button and
// the owner-portal print button so both render the same layout.
// All dynamic text is escaped via escapeHtml/sanitizeForPrint; currency
// uses formatCurrency. Every field is read defensively (0 or "—" when
// missing) since it does not change how statements are generated.
function buildStatementHtml(statement, companyId) {
  const s = statement || {};
  const cats = statementCategories(s);

  const esc = escapeHtml;
  const company = esc(companyId) || "—";
  const ownerName = esc(s.owner_name) || "—";
  const period = esc(s.period) || "—";
  const range = (s.start_date || s.end_date)
    ? `${esc(fmtDate(s.start_date)) || "—"} – ${esc(fmtDate(s.end_date)) || "—"}`
    : "";

  const sections = cats.map(cat => {
    const rows = (Array.isArray(cat.items) ? cat.items : []).map(it => `
      <tr>
        <td class="dt">${esc(fmtDate(it.date)) || "—"}</td>
        <td>${esc(it.description) || "—"}</td>
        <td class="amt">${formatCurrency(Math.abs(safeNum(it.amount)))}</td>
      </tr>`).join("");
    return `
      <h2>${esc(cat.category) || "—"}</h2>
      <table class="lines">
        <thead><tr><th>Date</th><th>Description</th><th class="amt">Amount</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3" class="empty">No items</td></tr>'}</tbody>
      </table>`;
  }).join("");

  // Billed, but show collected: the fee and the net distribution are on
  // collected rent. Older statements (no rent summary) keep the old rows.
  const rs = statementRentSummary(cats);
  const summary = rs ? `
    <table class="summary"><tbody>
      <tr><td>Rent billed</td><td class="amt">${formatCurrency(rs.billed)}</td></tr>
      <tr><td>Rent collected</td><td class="amt">${formatCurrency(rs.collected)}</td></tr>
      <tr><td>Rent unpaid</td><td class="amt">${formatCurrency(rs.unpaid)}</td></tr>
      <tr><td>Total income billed</td><td class="amt">${formatCurrency(safeNum(s.total_income))}</td></tr>
      <tr><td>Total expenses</td><td class="amt">(${formatCurrency(safeNum(s.total_expenses))})</td></tr>
      <tr><td>Management fee (on collected rent)</td><td class="amt">(${formatCurrency(safeNum(s.management_fee))})</td></tr>
      <tr class="net"><td>Net Distribution to Owner (collected rent less fee)</td><td class="amt">${formatCurrency(safeNum(s.net_to_owner))}</td></tr>
    </tbody></table>` : `
    <table class="summary"><tbody>
      <tr><td>Total Income</td><td class="amt">${formatCurrency(safeNum(s.total_income))}</td></tr>
      <tr><td>Total Expenses</td><td class="amt">(${formatCurrency(safeNum(s.total_expenses))})</td></tr>
      <tr><td>Management Fee</td><td class="amt">(${formatCurrency(safeNum(s.management_fee))})</td></tr>
      <tr class="net"><td>Net Distribution to Owner</td><td class="amt">${formatCurrency(safeNum(s.net_to_owner))}</td></tr>
    </tbody></table>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>Statement ${sanitizeForPrint(s.period)}</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;margin:24px;font-size:13px;line-height:1.4}
    h1{font-size:20px;margin:0 0 2px}
    h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#555;margin:20px 0 6px;border-bottom:1px solid #ccc;padding-bottom:3px}
    .head{border-bottom:2px solid #333;padding-bottom:10px;margin-bottom:12px}
    .muted{color:#666;font-size:12px}
    .meta{margin-bottom:8px}
    table{width:100%;border-collapse:collapse}
    th,td{text-align:left;padding:5px 8px;border:1px solid #ddd}
    th{background:#f4f4f4;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#555}
    .amt{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
    td.dt{white-space:nowrap;width:90px;color:#555}
    .empty{text-align:center;color:#999}
    table.summary{margin-top:22px;width:340px;margin-left:auto}
    table.summary td{border:none;border-top:1px solid #eee;padding:6px 8px}
    table.summary tr.net td{border-top:2px solid #333;font-weight:700;font-size:15px}
    @media print{body{margin:0}}
  </style></head>
  <body>
    <div class="head">
      <h1>Owner Statement</h1>
      <div class="muted">${company}</div>
    </div>
    <div class="meta muted">
      <strong>Owner:</strong> ${ownerName}<br>
      <strong>Period:</strong> ${period}${range ? ` (${range})` : ""}
    </div>
    ${sections || '<p class="muted">No line items recorded for this statement.</p>'}
    ${summary}
  </body></html>`;
}

// Open a new window and print the formatted statement. Mirrors the
// original open/write/print flow (no document.close, 300ms print delay).
function openStatementPrint(statement, companyId) {
  const w = window.open("", "_blank", "noopener,noreferrer");
  if (!w) return;
  w.document.write(buildStatementHtml(statement, companyId));
  w.document.title = "Statement " + sanitizeForPrint((statement && statement.period) || "");
  setTimeout(() => w.print(), 300);
}

// line_items is written as a JSON string (a jsonb string scalar); tolerate an
// already-parsed array too.
function statementCategories(s) {
  const raw = s && s.line_items;
  let cats = [];
  if (Array.isArray(raw)) cats = raw;
  else { try { cats = JSON.parse(raw || "[]"); } catch (_e) { cats = []; } }
  return Array.isArray(cats) ? cats : [];
}

// Excel export of a statement: one section per category with a SUM
// subtotal, then a summary whose totals and net are formulas over those
// subtotals (CLAUDE.md report rules).
async function exportStatementExcel(statement) {
  const s = statement || {};
  const cats = statementCategories(s);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Owner Statement");
  ws.columns = [{ key: "a", width: 14 }, { key: "b", width: 60 }, { key: "c", width: 16 }];
  const money = '"$"#,##0.00;[Red]"-$"#,##0.00';
  ws.addRow(["Owner Statement"]).font = { bold: true, size: 14 };
  ws.addRow(["Owner", s.owner_name || ""]);
  ws.addRow(["Period", (s.period || "") + (s.start_date ? " (" + fmtDate(s.start_date) + " – " + fmtDate(s.end_date) + ")" : "")]);
  ws.addRow([]);
  const subtotal = {};
  const rentRows = {};   // cell of each Rent Summary row, for the summary formulas
  for (const cat of cats) {
    const h = ws.addRow([cat.category || ""]);
    h.font = { bold: true };
    h.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
    ws.addRow(["Date", "Description", "Amount"]).font = { bold: true };
    const first = ws.rowCount + 1;
    for (const it of (Array.isArray(cat.items) ? cat.items : [])) {
      const r = ws.addRow([it.date ? excelDate(it.date) : null, it.description || "", safeNum(it.amount)]);
      r.getCell(1).numFmt = EXCEL_DATE_FMT;
      r.getCell(3).numFmt = money;
      if (cat.category === "Rent Summary" && it.key) rentRows[it.key] = "C" + r.number;
    }
    const last = ws.rowCount;
    // The Rent Summary rows (billed / collected / unpaid) are three views of
    // the same rent, not items to add up: no subtotal.
    if (cat.category === "Rent Summary") { ws.addRow([]); continue; }
    const t = ws.addRow(["", "Total " + (cat.category || ""), last >= first ? { formula: `SUM(C${first}:C${last})` } : 0]);
    t.font = { bold: true }; t.getCell(3).numFmt = money;
    subtotal[cat.category] = "C" + t.number;
    ws.addRow([]);
  }
  const ref = (name) => subtotal[name] ? `ABS(${subtotal[name]})` : "0";
  const sumRow = (label, formula, bold) => { const r = ws.addRow(["", label, { formula }]); r.getCell(3).numFmt = money; if (bold) r.font = { bold: true }; return r.number; };
  ws.addRow(["Summary"]).font = { bold: true };
  const inc = sumRow("Total Income (billed)", ref("Income"));
  const exp = sumRow("Total Expenses", ref("Expenses"));
  const fee = sumRow(rentRows.collected ? "Management Fee (on collected rent)" : "Management Fee", ref("Management Fee"));
  if (rentRows.collected) {
    // Billed, but show collected: the net distribution is collected rent
    // less the fee (what was booked to 2200).
    sumRow("Net Distribution to Owner (collected rent less fee)", `${rentRows.collected}-C${fee}`, true);
    sumRow("Net after expenses (information)", `${rentRows.collected}-C${fee}-C${exp}`);
  } else {
    sumRow("Net to Owner", `C${inc}-C${exp}-C${fee}`, true);
  }
  if (subtotal["Distributions Paid"]) sumRow("Distributions Paid in Period", ref("Distributions Paid"));
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `owner-statement-${String(s.owner_name || "owner").replace(/[^A-Za-z0-9]+/g, "-")}-${s.period || ""}.xlsx`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function OwnerManagement({ addNotification, userProfile, userRole, companyId, showToast, showConfirm }) {
  const [owners, setOwners] = useState([]);
  const [properties, setProperties] = useState([]);
  const [statements, setStatements] = useState([]);
  const [distributions, setDistributions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("owners");
  const [showForm, setShowForm] = useState(false);
  const [editingOwner, setEditingOwner] = useState(null);
  const [showStatementGen, setShowStatementGen] = useState(null);
  const [statementPeriod, setStatementPeriod] = useState(formatLocalDate(new Date()).slice(0, 7));
  const [viewStatement, setViewStatement] = useState(null);
  const [showDistForm, setShowDistForm] = useState(null);
  const [distForm, setDistForm] = useState({ amount: "", method: "check", reference: "", notes: "" });

  // management_fee_pct "" = not set (null). The one fee rule is
  // ownerRules.resolveMgmtFeePct: 0 means 0; unset means 0% and is flagged
  // "Fee not set" so staff notice. There is no company-level default setting.
  const [form, setForm] = useState({
  name: "", first_name: "", mi: "", last_name: "", email: "", phone: "", company: "",
  address: "", management_fee_pct: "", payment_method: "check", notes: "",
  });

  // Accruals that could not be synced at the time (a lock-wait timeout, an
  // error, a bulk write past its commit budget) are NEEDS_SYNC markers. The
  // page renders straight away and drains them in the background (bounded
  // batches, see drainOwnerAccruals); when anything was synced the
  // distributions are re-read so the numbers catch up. The nightly integrity
  // cron drains them too. A company switch / unmount discards a stale result.
  const drainRun = useRef(0);
  useEffect(() => {
    fetchData();
    const run = ++drainRun.current;
    const cid = companyId;
    if (cid) {
      syncPendingOwnerAccruals(cid).then(res => {
        if (run !== drainRun.current || !res || res.error || !(res.synced > 0)) return;
        return fetchAllPaged(() => supabase.from("owner_distributions").select("*").eq("company_id", cid).order("date", { ascending: false }).order("id"), "owner distributions")
          .then(d => { if (run === drainRun.current && d && !d.failed) setDistributions(d.rows || []); });
      }).catch(() => { /* retried on the next visit and nightly */ });
    }
    return () => { drainRun.current++; };
  }, [companyId]);

  async function fetchData() {
  setLoading(true);
  // The income side of a statement comes from the general ledger at
  // generation time (generateStatement), not from a capped payments list.
  const [o, p, s, d] = await Promise.all([
  supabase.from("owners").select("*").eq("company_id", companyId).is("archived_at", null).order("name"),
  supabase.from("properties").select("*").eq("company_id", companyId).is("archived_at", null),
  supabase.from("owner_statements").select("*").eq("company_id", companyId).order("created_at", { ascending: false }),
  fetchAllPaged(() => supabase.from("owner_distributions").select("*").eq("company_id", companyId).order("date", { ascending: false }).order("id"), "owner distributions"),
  ]);
  setOwners(o.data || []);
  setProperties(p.data || []);
  setStatements(s.data || []);
  setDistributions(d.rows || []);
  setLoading(false);
  }

  async function saveOwner() {
  if (!guardSubmit("saveOwner")) return;
  try {
  if (!form.name.trim()) { showToast("Owner name is required.", "error"); return; }
  const fee = parseFeeInput(form.management_fee_pct);
  if (fee.error) { showToast(fee.error, "error"); return; }
  const payload = {
  name: form.name,
  first_name: form.first_name,
  middle_initial: form.mi,
  last_name: form.last_name,
  // owners.email is UNIQUE; an empty string would collide with every other
  // owner saved without an email, so "no email" is stored as null.
  email: normalizeEmail(form.email) || null,
  phone: form.phone,
  company: form.company,
  address: form.address,
  management_fee_pct: fee.value,
  payment_method: form.payment_method,
  notes: form.notes,
  };
  let error;
  if (editingOwner) {
  ({ error } = await supabase.from("owners").update(payload).eq("id", editingOwner.id).eq("company_id", companyId));
  } else {
  ({ error } = await supabase.from("owners").insert([{ ...payload, company_id: companyId }]));
  }
  if (error) { pmError("PM-8006", { raw: error, context: editingOwner ? "update owner" : "create owner" }); return; }
  // properties.owner_name is only a display copy of the linked owner's
  // name; keep it in step when the owner is renamed.
  if (editingOwner && editingOwner.name !== payload.name) {
  await supabase.from("properties").update({ owner_name: payload.name }).eq("company_id", companyId).eq("owner_id", editingOwner.id);
  }
  logAudit(editingOwner ? "update" : "create", "owners", (editingOwner ? "Updated" : "Added") + " owner: " + form.name, editingOwner?.id || "", userProfile?.email, userRole, companyId);
  addNotification("👤", (editingOwner ? "Updated" : "Added") + " owner: " + form.name);
  resetForm();
  fetchData();
  } finally { guardRelease("saveOwner"); }
  }

  function resetForm() {
  setShowForm(false);
  setEditingOwner(null);
  setForm({ name: "", first_name: "", mi: "", last_name: "", email: "", phone: "", company: "", address: "", management_fee_pct: "", payment_method: "check", notes: "" });
  }

  function startEdit(owner) {
  setEditingOwner(owner);
  const parsed = parseNameParts(owner.name);
  setForm({
  name: owner.name,
  first_name: owner.first_name || parsed.first_name,
  mi: owner.middle_initial || parsed.middle_initial,
  last_name: owner.last_name || parsed.last_name,
  email: owner.email || "",
  phone: owner.phone || "",
  company: owner.company || "",
  address: owner.address || "",
  management_fee_pct: owner.management_fee_pct === null || owner.management_fee_pct === undefined ? "" : String(owner.management_fee_pct),
  payment_method: owner.payment_method || "check",
  notes: owner.notes || "",
  });
  setShowForm(true);
  }

  async function archiveOwner(owner) {
  if (!guardSubmit("archiveOwner")) return;
  try {
  if (!await showConfirm({ message: `Archive owner "${owner.name}"? Their properties will remain active.`, variant: "danger", confirmText: "Archive" })) return;
  await supabase.from("owners").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email }).eq("id", owner.id).eq("company_id", companyId);
  logAudit("delete", "owners", "Archived owner: " + owner.name, owner.id, userProfile?.email, userRole, companyId);
  fetchData();
  } finally { guardRelease("archiveOwner"); }
  }

  async function generateStatement(owner) {
  if (!guardSubmit("genStatement")) return;
  try {
  const startDate = statementPeriod + "-01";
  const endObj = parseLocalDate(startDate); endObj.setMonth(endObj.getMonth() + 1); endObj.setDate(0);
  const endDate = formatLocalDate(endObj);

  // The properties this owner owned DURING the period (ownership history,
  // clipped to the owner's dates), the general ledger for them, and the
  // owner's own accruals / payouts (stamped owner_id). Billed rent is shown;
  // the fee and the net distribution are on COLLECTED rent (= 4200 / 2200).
  const gl = await loadOwnerStatementData(companyId, owner.id, startDate, endDate);
  if (gl.failed) { showToast("Could not read the books for this statement. Nothing was generated — please retry.", "error"); return; }
  const ownerProps = gl.props;
  if (ownerProps.length === 0 && gl.accruals.length === 0) { showToast("This owner had no properties in that period.", "error"); return; }
  const st = buildOwnerStatement({
  lines: gl.lines, accounts: gl.accounts,
  feeRule: resolveMgmtFeePct(owner),
  accruals: gl.accruals, payouts: gl.payouts,
  startDate, endDate,
  });

  // NOTE: owner_statements has no `properties` column (verified against
  // the test and production schemas). The covered properties are named in
  // the line items; the period goes in start_date/end_date.
  const { error } = await supabase.from("owner_statements").insert([{
  company_id: companyId,
  owner_id: owner.id,
  owner_name: owner.name,
  period: statementPeriod,
  start_date: startDate,
  end_date: endDate,
  total_income: st.totalIncome,
  total_expenses: st.totalExpenses,
  management_fee: st.managementFee,
  net_to_owner: st.netToOwner,
  line_items: JSON.stringify(st.lineItems),
  notes: "From the general ledger: " + ownerProps.length + " propert" + (ownerProps.length === 1 ? "y" : "ies") + " (" + ownerProps.map(p => p.short_name || p.address).join("; ") + "). Rent billed " + formatCurrency(st.rentBilled) + ", collected " + formatCurrency(st.rentCollected) + ", unpaid " + formatCurrency(st.rentUnpaid) + ". Fee and net distribution are on collected rent. Expenses " + formatCurrency(st.totalExpenses) + " (net after expenses " + formatCurrency(st.netAfterExpenses) + "). Distributions paid in period: " + formatCurrency(st.distributionsPaid) + (st.feeIsSet ? "" : ". Management fee not set on this owner (0%)."),
  status: "draft",
  }]);
  if (error) { pmError("PM-8006", { raw: error, context: "generate owner statement" }); return; }

  addNotification("📊", `Statement generated for ${owner.name} — ${statementPeriod}`);
  logAudit("create", "owner_statements", `Statement: ${statementPeriod} for ${owner.name} — Net: $${st.netToOwner}`, "", userProfile?.email, userRole, companyId);
  setShowStatementGen(null);
  fetchData();
  } finally { guardRelease("genStatement"); }
  }

  async function sendStatement(statement) {
  if (!guardSubmit("sendStatement")) return;
  try {
  // The column is sent_date (a date), not sent_at — writing sent_at made
  // PostgREST reject the update, and because nothing checked `error` the
  // UI still claimed the statement had been sent while it stayed a draft.
  const { error: sendErr } = await supabase.from("owner_statements")
  .update({ status: "sent", sent_date: formatLocalDate(new Date()) })
  .eq("id", statement.id).eq("company_id", companyId);
  if (sendErr) { pmError("PM-8006", { raw: sendErr, context: "send owner statement" }); return; }
  const owner = owners.find(o => String(o.id) === String(statement.owner_id));
  if (owner?.email) {
  queueNotification("owner_statement", owner.email, { owner: statement.owner_name, period: statement.period, net: statement.net_to_owner }, companyId);
  }
  addNotification("📧", `Statement sent to ${statement.owner_name}`);
  fetchData();
  } finally { guardRelease("sendStatement"); }
  }

  // Renders a formatted, printable HTML statement via the shared
  // buildStatementHtml/openStatementPrint helpers (was a raw JSON dump).
  function printStatement(statement) {
  openStatementPrint(statement, companyId);
  }

  async function exportStatement(statement) {
  try { await exportStatementExcel(statement); }
  catch (e) { pmError("PM-8006", { raw: e, context: "owner statement Excel export" }); showToast("Export failed: " + (e?.message || e), "error"); }
  }

  async function payOwner(owner) {
  if (!guardSubmit("payOwner")) return;
  try {
  if (!distForm.amount || isNaN(Number(distForm.amount)) || Number(distForm.amount) <= 0) { showToast("Enter a valid amount.", "error"); return; }
  const amt = Number(distForm.amount);
  const today = formatLocalDate(new Date());
  const classId = await getPropertyClassId(properties.find(p => String(p.owner_id) === String(owner.id))?.address || "", companyId);
  // The journal reference is GENERATED (DIST-<owner>-<date>-<cents>[-<ref slug>]).
  // The user's "Reference #" used to be the journal reference itself, so a
  // check number like "1001" collided with any other entry referenced
  // "1001" (idx_je_company_reference_unique) and the payout was refused.
  // The user's text is kept as the memo and in the distribution's notes.
  const userRef = (distForm.reference || "").trim();
  const distRef = payoutReference({ ownerId: owner.id, date: today, cents: toCents(amt), userRef });
  const { data: dupJe } = await supabase.from("acct_journal_entries").select("id").eq("company_id", companyId).eq("reference", distRef).neq("status", "voided").limit(1);
  if ((dupJe || []).length) { showToast("A payout of this amount to " + owner.name + " is already recorded today" + (userRef ? " with reference " + userRef : "") + ". Enter a different Reference # if this is a second payment.", "error"); return; }
  // Insert owner_distributions FIRST, then post the JE; on JE failure the
  // dist row is deleted (dist-first-then-JE-with-rollback, as the accrual).
  const { data: distRow, error: distErr } = await supabase.from("owner_distributions").insert([{
  company_id: companyId,
  owner_id: owner.id,
  kind: "payout",
  amount: amt,
  method: distForm.method,
  reference: distRef,
  date: today,
  notes: [userRef ? "Ref #" + userRef : "", distForm.notes || ""].filter(Boolean).join(" · "),
  }]).select("id").maybeSingle();
  if (distErr) { pmError("PM-8006", { raw: distErr, context: "save owner distribution" }); return; }

  const memoRef = userRef ? " (ref " + userRef + ")" : "";
  const distResult = await atomicPostJEAndLedger({ companyId,
  date: today,
  description: `Owner distribution — ${owner.name}${memoRef}`,
  reference: distRef,
  property: "",
  lines: [
  { account_id: "2200", account_name: "Owner Distributions Payable", debit: amt, credit: 0, class_id: classId, memo: `Distribution to ${owner.name}${memoRef}` },
  { account_id: "1000", account_name: "Checking Account", debit: 0, credit: amt, class_id: classId, memo: `Paid to ${owner.name} via ${distForm.method}${memoRef}` },
  ], requireJE: false });
  if (!distResult.jeId) {
  // Roll back the dist row so owner_statements + GL stay consistent.
  if (distRow?.id) await supabase.from("owner_distributions").delete().eq("id", distRow.id).eq("company_id", companyId);
  pmError("PM-6004", { raw: { message: "JE failed — dist row rolled back" }, context: "payOwner manual distribution" });
  showToast("Distribution GL entry failed — the distribution was not recorded. Please retry.", "error");
  return;
  }

  addNotification("💰", `$${amt.toLocaleString()} distributed to ${owner.name}`);
  // Owner-facing copy — lands in the owner portal's inbox.
  if (owner.email) addNotification("💰", `A distribution of $${amt.toLocaleString()} (${distForm.method}) was sent to you.`, { recipient: owner.email, type: "owner_distribution" });
  logAudit("create", "owner_distributions", `Distribution: $${amt} to ${owner.name} via ${distForm.method} (${distRef})`, "", userProfile?.email, userRole, companyId);
  setShowDistForm(null);
  setDistForm({ amount: "", method: "check", reference: "", notes: "" });
  fetchData();
  } finally { guardRelease("payOwner"); }
  }

  if (loading) return <Spinner />;

  return (
  <div>
  <div className="flex justify-between items-center mb-5">
  <PageHeader title="Owners & Statements" />
  <div className="flex gap-2">
  <Btn onClick={() => { resetForm(); setShowForm(true); }}>+ New Owner</Btn>
  </div>
  </div>

  <div className="grid grid-cols-2 gap-3 mb-5 md:grid-cols-4">
  <StatCard label="Owners" value={owners.length} color="text-brand-600" />
  <StatCard label="Statements" value={statements.length} color="text-info-600" sub={statements.filter(s => s.status === "draft").length + " drafts"} />
  {/* Payouts only, voided excluded: owner_distributions also holds the fee
      ACCRUALS booked on each rent receipt, and summing both counted every
      paid dollar twice. */}
  <StatCard label="Distributed (YTD)" value={formatCurrency(sumPayouts(distributions, { year: formatLocalDate(new Date()).slice(0, 4) }))} color="text-positive-600" sub="payouts this year" />
  <StatCard label="Properties" value={properties.filter(p => p.owner_id).length} color="text-neutral-500" sub="with owners" />
  </div>

  <div className="flex gap-1 mb-4 border-b border-brand-50">
  <TabBar tabs={[["owners","Owners"],["statements","Statements"],["distributions","Distributions"]]} active={activeTab} onChange={setActiveTab} size="md" />
  </div>

  {/* Owner Form */}
  {showForm && (
  <div className="bg-white rounded-xl border border-neutral-200 shadow-card p-4 mb-5">
  <div className="flex items-center justify-between mb-4"><h3 className="font-display font-semibold text-neutral-800">{editingOwner ? "Edit Owner" : "Add New Owner"}</h3><Btn variant="ghost" onClick={resetForm} title="Close">✕</Btn></div>
  <div className="grid grid-cols-2 gap-3 mb-4">
  <div className="col-span-2"><div className="grid grid-cols-6 gap-3">
  <div className="col-span-2"><label className="text-xs font-medium text-neutral-400 mb-1 block">First Name *</label><Input value={form.first_name} onChange={e => { const v = e.target.value; setForm(f => ({ ...f, first_name: v, name: formatPersonName(v, f.mi, f.last_name) })); }} placeholder="First" /></div>
  <div className="col-span-1"><label className="text-xs font-medium text-neutral-400 mb-1 block">MI</label><Input maxLength={1} value={form.mi} onChange={e => { const v = e.target.value.toUpperCase(); setForm(f => ({ ...f, mi: v, name: formatPersonName(f.first_name, v, f.last_name) })); }} placeholder="M" className="text-center" /></div>
  <div className="col-span-3"><label className="text-xs font-medium text-neutral-400 mb-1 block">Last Name *</label><Input value={form.last_name} onChange={e => { const v = e.target.value; setForm(f => ({ ...f, last_name: v, name: formatPersonName(f.first_name, f.mi, v) })); }} placeholder="Last" /></div>
  </div></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Company</label><Input value={form.company} onChange={e => setForm({...form, company: e.target.value})} placeholder="LLC or Company name" /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Email</label><Input type="email" value={form.email} onChange={e => setForm({...form, email: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Phone</label><Input type="tel" value={form.phone} onChange={e => setForm({...form, phone: formatPhoneInput(e.target.value)})} maxLength={14} /></div>
  <div className="col-span-2"><label className="text-xs text-neutral-400 mb-1 block">Address</label><Input value={form.address} onChange={e => setForm({...form, address: e.target.value})} placeholder="Mailing address" /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Management Fee %</label><Input type="number" min="0" max="100" step="0.01" value={form.management_fee_pct} onChange={e => setForm({...form, management_fee_pct: e.target.value})} placeholder="Not set (0% charged)" />{String(form.management_fee_pct).trim() === "" && <div className="text-2xs text-warn-600 mt-0.5">Fee not set — no fee will be charged. Enter 0 to record a deliberate 0%.</div>}</div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Payment Method</label>
  <Select value={form.payment_method} onChange={e => setForm({...form, payment_method: e.target.value})}>
  <option value="check">Check</option><option value="ach">ACH</option><option value="wire">Wire</option>
  </Select>
  </div>
  <div className="col-span-2"><label className="text-xs text-neutral-400 mb-1 block">Notes</label><Textarea value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} className="w-full border border-brand-100 rounded-xl px-3 py-1.5 text-sm" rows={2} /></div>
  </div>
  <div className="flex gap-2">
  <Btn onClick={saveOwner}>{editingOwner ? "Update" : "Add Owner"}</Btn>
  <Btn variant="ghost" onClick={resetForm}>Cancel</Btn>
  </div>
  </div>
  )}

  {/* OWNERS TAB */}
  {activeTab === "owners" && (
  <div className="space-y-3">
  {owners.map(owner => {
  const ownerProps = properties.filter(p => String(p.owner_id) === String(owner.id));
  const ownerStmts = statements.filter(s => String(s.owner_id) === String(owner.id));
  const lastDist = distributions.find(d => String(d.owner_id) === String(owner.id) && isLivePayout(d));
  const feeRule = resolveMgmtFeePct(owner);
  return (
  <div key={owner.id} className="bg-white rounded-xl border border-neutral-200 shadow-card p-4">
  <div className="flex justify-between items-start mb-2">
  <div>
  <div className="text-sm font-bold text-neutral-800">{owner.name}{owner.company ? " — " + owner.company : ""}</div>
  <div className="text-xs text-neutral-400">{owner.email}{owner.phone ? " · " + owner.phone : ""}</div>
  </div>
  <div className="text-right">
  <div className={"text-xs font-bold " + (feeRule.isSet ? "text-brand-600" : "text-warn-600")} title={feeRule.isSet ? "" : "No management fee is set on this owner, so none is charged. Edit the owner to set one (0 is allowed)."}>{feeLabel(owner)}</div>
  <div className="text-xs text-neutral-400">{ownerProps.length} properties</div>
  </div>
  </div>
  {ownerProps.length > 0 && (
  <div className="flex flex-wrap gap-1 mb-2">
  {ownerProps.map(p => (
  <span key={p.id} className="text-xs bg-brand-50 text-brand-600 px-2 py-0.5 rounded-full">{p.address?.length > 25 ? p.address.slice(0, 25) + "..." : p.address}</span>
  ))}
  </div>
  )}
  <div className="grid grid-cols-3 gap-2 text-xs mb-2">
  <div><span className="text-neutral-400">Statements</span><div className="font-semibold text-neutral-700">{ownerStmts.length}</div></div>
  <div><span className="text-neutral-400">Last Distribution</span><div className="font-semibold text-neutral-700">{lastDist ? formatCurrency(lastDist.amount) + " on " + lastDist.date : "—"}</div></div>
  <div><span className="text-neutral-400">Payment</span><div className="font-semibold text-neutral-700 capitalize">{owner.payment_method || "check"}</div></div>
  </div>
  <div className="flex flex-wrap gap-2 pt-2 border-t border-brand-50/50">
  <Btn variant="secondary" size="xs" onClick={() => startEdit(owner)}>Edit</Btn>
  <Btn variant="secondary" size="xs" onClick={() => setShowStatementGen(owner)}>Generate Statement</Btn>
  {canManage(userRole) && <Btn variant="secondary" size="xs" onClick={() => { setShowDistForm(owner); setDistForm({ amount: "", method: owner.payment_method || "check", reference: "", notes: "" }); }}>Pay Owner</Btn>}
  {canManage(userRole) && <Btn variant="danger" size="xs" onClick={() => archiveOwner(owner)}>Archive</Btn>}
  </div>
  </div>
  );
  })}
  {owners.length === 0 && <EmptyState size="page" title={"No owners yet. Add one above."} />}
  </div>
  )}

  {/* Statement Generation Modal */}
  {showStatementGen && (
  <Modal title={"Generate Statement — " + showStatementGen.name} onClose={() => setShowStatementGen(null)}>
  <div className="space-y-4">
  <div><label className="text-xs font-medium text-neutral-400 block mb-1">Period</label><Input type="month" value={statementPeriod} onChange={e => setStatementPeriod(e.target.value)} /></div>
  <div className="bg-brand-50/30 rounded-lg p-3 text-sm">
  <div className="text-xs text-neutral-400 mb-1">Properties included:</div>
  {properties.filter(p => String(p.owner_id) === String(showStatementGen.id)).map(p => (
  <div key={p.id} className="text-neutral-700">{p.address}</div>
  ))}
  {properties.filter(p => String(p.owner_id) === String(showStatementGen.id)).length === 0 && <div className="text-neutral-400">No properties assigned to this owner</div>}
  </div>
  <Btn onClick={() => generateStatement(showStatementGen)} className="w-full">Generate Statement</Btn>
  </div>
  </Modal>
  )}

  {/* Distribution Form Modal */}
  {showDistForm && (
  <Modal title={"Pay Owner — " + showDistForm.name} onClose={() => setShowDistForm(null)}>
  <div className="space-y-3">
  <div><label className="text-xs text-neutral-400 block mb-1">Amount ($) *</label><MoneyInput value={distForm.amount} onChange={v => setDistForm({...distForm, amount: v})} placeholder="0.00" /></div>
  <div><label className="text-xs text-neutral-400 block mb-1">Method</label>
  <Select value={distForm.method} onChange={e => setDistForm({...distForm, method: e.target.value})}>
  <option value="check">Check</option><option value="ach">ACH</option><option value="wire">Wire</option>
  </Select>
  </div>
  <div><label className="text-xs text-neutral-400 block mb-1">Reference #</label><Input value={distForm.reference} onChange={e => setDistForm({...distForm, reference: e.target.value})} placeholder="Check # or ACH ref" /></div>
  <div><label className="text-xs text-neutral-400 block mb-1">Notes</label><Input value={distForm.notes} onChange={e => setDistForm({...distForm, notes: e.target.value})} /></div>
  {canManage(userRole) && <Btn onClick={() => payOwner(showDistForm)} className="w-full">Process Distribution</Btn>}
  </div>
  </Modal>
  )}

  {/* STATEMENTS TAB */}
  {activeTab === "statements" && !viewStatement && (
  <div className="space-y-2">
  {statements.map(s => (
  <div key={s.id} className="bg-white rounded-xl border border-neutral-200 px-4 py-3 flex justify-between items-center cursor-pointer hover:border-brand-200" onClick={() => setViewStatement(s)}>
  <div>
  <div className="text-sm font-semibold text-neutral-800">{s.owner_name} — {s.period}</div>
  <div className="text-xs text-neutral-400">{fmtDate(s.created_at)}</div>
  </div>
  <div className="flex items-center gap-4">
  <div className="text-right">
  <div className="text-xs text-neutral-400">Net: <span className="text-brand-600 font-bold">${safeNum(s.net_to_owner).toLocaleString()}</span></div>
  </div>
  {s.status === "draft" && <Btn variant="secondary" size="xs" onClick={e => { e.stopPropagation(); sendStatement(s); }}>📧 Send</Btn>}
  <Btn variant="secondary" size="xs" onClick={e => { e.stopPropagation(); printStatement(s); }}><span className="material-icons-outlined text-xs align-middle">print</span></Btn>
  <Btn variant="secondary" size="xs" title="Export to Excel" onClick={e => { e.stopPropagation(); exportStatement(s); }}><span className="material-icons-outlined text-xs align-middle">download</span></Btn>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (s.status === "paid" ? "bg-positive-100 text-positive-700" : s.status === "sent" ? "bg-info-100 text-info-700" : "bg-warn-100 text-warn-700")}>{s.status}</span>
  </div>
  </div>
  ))}
  {statements.length === 0 && <EmptyState size="compact" title={"No statements generated yet"} />}
  </div>
  )}

  {/* Statement Detail */}
  {activeTab === "statements" && viewStatement && (
  <div>
  <Btn variant="ghost" size="sm" onClick={() => setViewStatement(null)}>← Back to Statements</Btn>
  <div className="bg-white rounded-xl border border-neutral-200 p-4">
  <div className="flex justify-between items-start mb-4">
  <div>
  <h3 className="font-bold text-neutral-800">Owner Statement — {viewStatement.period}</h3>
  <div className="text-xs text-neutral-400">{viewStatement.owner_name} · Generated {fmtDate(viewStatement.created_at)}</div>
  </div>
  <div className="flex items-center gap-2">
  {viewStatement.status === "draft" && <Btn variant="secondary" size="xs" onClick={() => sendStatement(viewStatement)}>📧 Send</Btn>}
  <Btn onClick={() => printStatement(viewStatement)} variant="secondary" size="xs"><span className="material-icons-outlined text-xs align-middle">print</span></Btn>
  <Btn onClick={() => exportStatement(viewStatement)} variant="secondary" size="xs" title="Export to Excel"><span className="material-icons-outlined text-xs align-middle">download</span></Btn>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (viewStatement.status === "paid" ? "bg-positive-100 text-positive-700" : "bg-warn-100 text-warn-700")}>{viewStatement.status}</span>
  </div>
  </div>
  <div className="grid grid-cols-4 gap-3 mb-4">
  <div className="bg-positive-50 rounded-lg p-3 text-center"><div className="text-xs text-neutral-400">Income (billed)</div><div className="text-lg font-bold text-positive-600">${safeNum(viewStatement.total_income).toLocaleString()}</div></div>
  <div className="bg-danger-50 rounded-lg p-3 text-center"><div className="text-xs text-neutral-400">Expenses</div><div className="text-lg font-bold text-danger-500">${safeNum(viewStatement.total_expenses).toLocaleString()}</div></div>
  <div className="bg-highlight-50 rounded-lg p-3 text-center"><div className="text-xs text-neutral-400">Mgmt Fee (on collected)</div><div className="text-lg font-bold text-highlight-600">${safeNum(viewStatement.management_fee).toLocaleString()}</div></div>
  <div className="bg-brand-50 rounded-lg p-3 text-center"><div className="text-xs text-neutral-400">Net to Owner (collected)</div><div className="text-lg font-bold text-brand-700">${safeNum(viewStatement.net_to_owner).toLocaleString()}</div></div>
  </div>
  {/* Line items */}
  {(() => { const items = statementCategories(viewStatement); return items.map((cat, ci) => (
  <div key={ci} className="mb-3">
  <div className="text-xs font-bold text-neutral-400 uppercase tracking-wider mb-1">{cat.category}</div>
  {(cat.items || []).map((item, ii) => (
  <div key={ii} className="flex justify-between text-xs py-1 border-b border-brand-50/50">
  <span className="text-neutral-500">{fmtDate(item.date)} — {item.description}</span>
  <span className={"font-bold " + (item.amount >= 0 ? "text-positive-600" : "text-danger-500")}>${Math.abs(item.amount).toLocaleString()}</span>
  </div>
  ))}
  </div>
  )); })()}
  </div>
  </div>
  )}

  {/* DISTRIBUTIONS TAB */}
  {activeTab === "distributions" && (
  <div className="space-y-2">
  {distributions.map(d => (
  <div key={d.id} className="bg-white rounded-xl border border-neutral-200 px-4 py-3 flex justify-between items-center">
  <div>
  {/* owner_distributions stores only owner_id — resolve the display
      name from the owners list rather than a non-existent column. */}
  <div className={"text-sm font-medium text-neutral-800" + (d.voided_at ? " line-through text-neutral-400" : "")}>{owners.find(o => String(o.id) === String(d.owner_id))?.name || "Unknown owner"} — ${safeNum(d.amount).toLocaleString()}</div>
  <div className="text-xs text-neutral-400">{d.reference} · {fmtDate(d.date)}{d.notes ? " · " + d.notes : ""}</div>
  </div>
  <div className="flex items-center gap-2">
  {d.voided_at && <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-danger-100 text-danger-700">VOIDED</span>}
  {distributionKind(d) === "accrual"
    ? <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-neutral-100 text-neutral-500" title="Owner's share accrued from a rent receipt (net of management fee). Not a payment.">ACCRUED</span>
    : <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-positive-100 text-positive-700">PAID · {d.method?.toUpperCase()}</span>}
  </div>
  </div>
  ))}
  {distributions.length === 0 && <EmptyState size="compact" title={"No distributions yet"} />}
  </div>
  )}
  </div>
  );
}

function OwnerMaintenanceView({ companyId, properties }) {
  const [workOrders, setWorkOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
  async function load() {
  const addrs = properties.map(p => p.address);
  if (addrs.length === 0) { setLoading(false); return; }
  const { data } = await supabase.from("work_orders").select("*").eq("company_id", companyId).in("property", addrs).is("archived_at", null).order("created", { ascending: false }).limit(100);
  setWorkOrders(data || []);
  setLoading(false);
  }
  load();
  }, [companyId, properties]);
  if (loading) return <Spinner />;
  const statusIcon = { open: "🔴", in_progress: "🟡", completed: "🟢" };
  return (
  <div className="space-y-2">
  {workOrders.map(wo => (
  <div key={wo.id} className="bg-white border border-brand-50 rounded-xl p-4">
  <div className="flex justify-between items-start">
  <div>
  <div className="text-sm font-semibold text-neutral-800">{wo.issue}</div>
  <div className="text-xs text-neutral-400">{wo.property} · {fmtDate(wo.created, "—")}</div>
  </div>
  <div className="text-right">
  <span className="text-xs">{statusIcon[wo.status] || "⚪"} {wo.status}</span>
  {wo.cost > 0 && <div className="text-xs font-bold text-danger-500 mt-0.5">${safeNum(wo.cost).toLocaleString()}</div>}
  </div>
  </div>
  {wo.notes && <div className="text-xs text-neutral-400 mt-1">{wo.notes}</div>}
  </div>
  ))}
  {workOrders.length === 0 && <EmptyState size="compact" title={"No maintenance activity"} />}
  </div>
  );
}

function OwnerPortal({ currentUser, companyId, showToast, showConfirm }) {
  const [ownerData, setOwnerData] = useState(null);
  const [properties, setProperties] = useState([]);
  const [statements, setStatements] = useState([]);
  const [distributions, setDistributions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");
  const [viewStatement, setViewStatement] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => { loadOwnerData(); }, [currentUser]);

  async function loadOwnerData() {
  if (!currentUser?.email) { setError("Not logged in"); setLoading(false); return; }
  const { data: owner } = await supabase.from("owners").select("*").eq("company_id", companyId).ilike("email", emailFilterValue(currentUser.email)).maybeSingle();
  if (!owner) { setError("No owner account found for " + currentUser.email); setLoading(false); return; }
  setOwnerData(owner);

  const [p, s, d] = await Promise.all([
  supabase.from("properties").select("*").eq("company_id", companyId).eq("owner_id", owner.id),
  supabase.from("owner_statements").select("*").eq("company_id", companyId).eq("owner_id", owner.id).order("created_at", { ascending: false }),
  supabase.from("owner_distributions").select("*").eq("company_id", companyId).eq("owner_id", owner.id).order("date", { ascending: false }),
  ]);
  setProperties(p.data || []);
  setStatements(s.data || []);
  // The owner sees what was PAID to them. Fee accruals are internal
  // bookkeeping, and a voided payout was never paid.
  setDistributions((d.data || []).filter(isLivePayout));
  setLoading(false);
  }

  if (loading) return <div className="flex items-center justify-center h-64"><Spinner /></div>;

  if (error) return (
  <div className="max-w-lg mx-auto mt-16 text-center">
  <div className="text-5xl mb-4">🏠</div>
  <PageHeader title="Owner Portal" />
  <p className="text-neutral-400 mb-4">{error}</p>
  <p className="text-sm text-neutral-400">Please contact your property manager to set up your owner portal access.</p>
  </div>
  );

  const totalIncome = statements.reduce((s, st) => s + safeNum(st.total_income), 0);
  const totalExpenses = statements.reduce((s, st) => s + safeNum(st.total_expenses), 0);
  const totalDistributed = distributions.reduce((s, d) => s + safeNum(d.amount), 0);
  const pendingStatements = statements.filter(s => s.status === "draft" || s.status === "sent");

  return (
  <div className="max-w-4xl mx-auto">
  {/* Header */}
  <div className="bg-gradient-to-r from-brand-600 to-highlight-600 rounded-2xl p-6 mb-6 text-white">
  <div className="flex justify-between items-start">
  <div>
  <h1 className="text-2xl font-bold mb-1">Welcome, {ownerData.name}</h1>
  <p className="text-brand-200 text-sm">{properties.length} {properties.length === 1 ? "property" : "properties"} · {ownerData.company || "Individual Owner"}</p>
  </div>
  <div className="text-right">
  <div className="text-sm text-brand-200">Management Fee</div>
  <div className="text-lg font-bold">{resolveMgmtFeePct(ownerData).isSet ? resolveMgmtFeePct(ownerData).pct + "%" : "Not set"}</div>
  </div>
  </div>
  </div>

  {/* Stats */}
  <div className="grid grid-cols-2 gap-3 mb-6 md:grid-cols-4">
  <div className="bg-white rounded-xl border border-neutral-200 p-4 text-center">
  <div className="text-xs text-neutral-400 mb-1">Total Income</div>
  <div className="text-lg font-bold text-positive-600">${totalIncome.toLocaleString()}</div>
  </div>
  <div className="bg-white rounded-xl border border-neutral-200 p-4 text-center">
  <div className="text-xs text-neutral-400 mb-1">Total Expenses</div>
  <div className="text-lg font-bold text-danger-500">${totalExpenses.toLocaleString()}</div>
  </div>
  <div className="bg-white rounded-xl border border-neutral-200 p-4 text-center">
  <div className="text-xs text-neutral-400 mb-1">Distributions</div>
  <div className="text-lg font-bold text-brand-600">${totalDistributed.toLocaleString()}</div>
  </div>
  <div className="bg-white rounded-xl border border-neutral-200 p-4 text-center">
  <div className="text-xs text-neutral-400 mb-1">Pending</div>
  <div className="text-lg font-bold text-warn-600">{pendingStatements.length}</div>
  </div>
  </div>

  {/* Tabs */}
  {/* Scrolls horizontally instead of crushing five tabs into a phone
      width. At 390px the labels collided -- "Distributions" ran into
      "Properties" -- and "Maintenance" was clipped off the right edge
      entirely, so the tab existed but could not be read or reached.
      whitespace-nowrap on the buttons stops the labels wrapping mid-word. */}
  <div className="flex gap-1 mb-5 border-b border-brand-50 overflow-x-auto">
  <TabBar tabs={[["overview","🏠 Overview"],["statements","\ud83d\udcca Statements"],["distributions","💰 Distributions"],["properties","\ud83c\udfe2 Properties"],["maintenance","🔧 Maintenance"]]} active={activeTab} onChange={setActiveTab} size="md" />
  </div>

  {/* OVERVIEW TAB */}
  {activeTab === "overview" && (
  <div className="space-y-4">
  <h3 className="font-semibold text-neutral-700">Your Properties</h3>
  <div className="grid gap-3 md:grid-cols-2">
  {properties.map(p => (
  <div key={p.id} className="bg-white rounded-xl border border-neutral-200 p-4">
  <div className="flex justify-between items-start">
  <div>
  <div className="font-semibold text-neutral-800 text-sm">{p.address}</div>
  <div className="text-xs text-neutral-400">{p.type || "Residential"}</div>
  </div>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (p.status === "occupied" ? "bg-positive-100 text-positive-700" : p.status === "vacant" ? "bg-warn-100 text-warn-700" : "bg-neutral-100 text-neutral-400")}>{p.status || "active"}</span>
  </div>
  {p.rent && <div className="text-sm font-bold text-positive-600 mt-2">${safeNum(p.rent).toLocaleString()}/mo</div>}
  </div>
  ))}
  {properties.length === 0 && <EmptyState size="compact" title={"No properties assigned yet"} />}
  </div>

  {/* Recent statements */}
  {statements.length > 0 && (
  <div>
  <h3 className="font-semibold text-neutral-700 mt-4 mb-2">Recent Statements</h3>
  {statements.slice(0, 3).map(s => (
  <div key={s.id} className="bg-white rounded-xl border border-neutral-200 px-4 py-3 flex justify-between items-center mb-2 cursor-pointer hover:border-brand-200" onClick={() => { setActiveTab("statements"); setViewStatement(s); }}>
  <div>
  <div className="text-sm font-medium text-neutral-800">{s.period}</div>
  <div className="text-xs text-neutral-400">Net: ${safeNum(s.net_to_owner).toLocaleString()}</div>
  </div>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (s.status === "paid" ? "bg-positive-100 text-positive-700" : s.status === "sent" ? "bg-info-100 text-info-700" : "bg-warn-100 text-warn-700")}>{s.status}</span>
  </div>
  ))}
  </div>
  )}
  </div>
  )}

  {/* STATEMENTS TAB */}
  {activeTab === "statements" && !viewStatement && (
  <div className="space-y-2">
  {statements.map(s => (
  <div key={s.id} className="bg-white rounded-xl border border-neutral-200 px-4 py-3 flex justify-between items-center cursor-pointer hover:border-brand-200" onClick={() => setViewStatement(s)}>
  <div>
  <div className="text-sm font-semibold text-neutral-800">{s.period}</div>
  <div className="text-xs text-neutral-400">{fmtDate(s.created_at)}</div>
  </div>
  <div className="flex items-center gap-4">
  <div className="text-right">
  <div className="text-xs text-neutral-400">Income: <span className="text-positive-600 font-bold">${safeNum(s.total_income).toLocaleString()}</span></div>
  <div className="text-xs text-neutral-400">Net: <span className="text-brand-600 font-bold">${safeNum(s.net_to_owner).toLocaleString()}</span></div>
  </div>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (s.status === "paid" ? "bg-positive-100 text-positive-700" : s.status === "sent" ? "bg-info-100 text-info-700" : "bg-warn-100 text-warn-700")}>{s.status}</span>
  </div>
  </div>
  ))}
  {statements.length === 0 && <EmptyState size="compact" title={"No statements yet"} />}
  </div>
  )}

  {/* STATEMENT DETAIL */}
  {activeTab === "statements" && viewStatement && (
  <div>
  <Btn variant="ghost" size="sm" onClick={() => setViewStatement(null)}>{"\u2190"} Back to Statements</Btn>
  <div className="bg-white rounded-xl border border-neutral-200 p-4">
  <div className="flex justify-between items-start mb-4">
  <div>
  <h3 className="font-bold text-neutral-800">Owner Statement — {viewStatement.period}</h3>
  <div className="text-xs text-neutral-400">{viewStatement.owner_name} · Generated {fmtDate(viewStatement.created_at)}</div>
  </div>
  <div className="flex items-center gap-2">
  <Btn onClick={() => openStatementPrint(viewStatement, companyId)} variant="secondary" size="xs"><span className="material-icons-outlined text-xs align-middle">print</span></Btn>
  <Btn onClick={() => exportStatementExcel(viewStatement).catch(e => pmError("PM-8006", { raw: e, context: "owner portal statement Excel export" }))} variant="secondary" size="xs" title="Export to Excel"><span className="material-icons-outlined text-xs align-middle">download</span></Btn>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (viewStatement.status === "paid" ? "bg-positive-100 text-positive-700" : "bg-warn-100 text-warn-700")}>{viewStatement.status}</span>
  </div>
  </div>
  <div className="grid grid-cols-4 gap-3 mb-4">
  <div className="bg-positive-50 rounded-lg p-3 text-center"><div className="text-xs text-neutral-400">Income (billed)</div><div className="text-lg font-bold text-positive-600">${safeNum(viewStatement.total_income).toLocaleString()}</div></div>
  <div className="bg-danger-50 rounded-lg p-3 text-center"><div className="text-xs text-neutral-400">Expenses</div><div className="text-lg font-bold text-danger-500">${safeNum(viewStatement.total_expenses).toLocaleString()}</div></div>
  <div className="bg-highlight-50 rounded-lg p-3 text-center"><div className="text-xs text-neutral-400">Mgmt Fee (on collected)</div><div className="text-lg font-bold text-highlight-600">${safeNum(viewStatement.management_fee).toLocaleString()}</div></div>
  <div className="bg-brand-50 rounded-lg p-3 text-center"><div className="text-xs text-neutral-400">Net to You (collected)</div><div className="text-lg font-bold text-brand-700">${safeNum(viewStatement.net_to_owner).toLocaleString()}</div></div>
  </div>
  {/* Line items */}
  {(() => { const items = statementCategories(viewStatement); return items.map((cat, ci) => (
  <div key={ci} className="mb-3">
  <div className="text-xs font-bold text-neutral-400 uppercase tracking-wider mb-1">{cat.category}</div>
  {(cat.items || []).map((item, ii) => (
  <div key={ii} className="flex justify-between text-xs py-1 border-b border-brand-50/50">
  <span className="text-neutral-500">{fmtDate(item.date)} — {item.description}</span>
  <span className={"font-bold " + (item.amount >= 0 ? "text-positive-600" : "text-danger-500")}>${Math.abs(item.amount).toLocaleString()}</span>
  </div>
  ))}
  </div>
  )); })()}
  </div>
  </div>
  )}

  {/* DISTRIBUTIONS TAB */}
  {activeTab === "distributions" && (
  <div className="space-y-2">
  {distributions.map(d => (
  <div key={d.id} className="bg-white rounded-xl border border-neutral-200 px-4 py-3 flex justify-between items-center">
  <div>
  <div className="text-sm font-medium text-neutral-800">${safeNum(d.amount).toLocaleString()}</div>
  <div className="text-xs text-neutral-400">{d.reference} · {fmtDate(d.date)}</div>
  </div>
  <div className="text-right">
  <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-positive-100 text-positive-700">{d.method?.toUpperCase()}</span>
  </div>
  </div>
  ))}
  {distributions.length === 0 && <EmptyState size="compact" title={"No distributions yet"} />}
  </div>
  )}

  {/* MAINTENANCE TAB */}
  {activeTab === "maintenance" && (
  <div>
  <h3 className="font-display font-bold text-neutral-700 mb-3">Maintenance Activity</h3>
  <OwnerMaintenanceView companyId={companyId} properties={properties} />
  </div>
  )}

  {/* PROPERTIES TAB */}
  {activeTab === "properties" && (
  <div className="space-y-3">
  {properties.map(p => (
  <div key={p.id} className="bg-white rounded-xl border border-neutral-200 p-4">
  <div className="flex justify-between items-start mb-2">
  <div>
  <div className="font-semibold text-neutral-800">{p.address}</div>
  <div className="text-xs text-neutral-400">{p.type || "Residential"} · {p.bedrooms || "?"} bd / {p.bathrooms || "?"} ba · {p.sqft || "?"} sqft</div>
  </div>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (p.status === "occupied" ? "bg-positive-100 text-positive-700" : "bg-warn-100 text-warn-700")}>{p.status}</span>
  </div>
  {p.rent && <div className="text-sm">Rent: <span className="font-bold text-positive-600">${safeNum(p.rent).toLocaleString()}/mo</span></div>}
  </div>
  ))}
  {properties.length === 0 && <EmptyState size="compact" title={"No properties assigned"} />}
  </div>
  )}
  </div>
  );
}

export { OwnerManagement, OwnerMaintenanceView, OwnerPortal };
