// ARCHITECTURE NOTE: This app is a single-file React application (~11,400 lines).
// This is a deliberate choice for deployment simplicity (single push to Vercel).
// For production hardening, the recommended migration path is:
// 1. Move all financial writes (payments, accounting, distributions) to Supabase RPCs
// 2. Move all membership/access changes to server-side functions (already partially done)
// 3. Split UI components into separate files only if team size grows beyond 1 developer
// Business-critical writes that should be server-side:
//   - autoPostJournalEntry → RPC (partially done)
//   - autoOwnerDistribution → RPC
//   - autoPostRentCharges → pg_cron + RPC (partially done)
//   - All company_members mutations → RPCs (done)
//   - Tenant balance updates → RPC (done: update_tenant_balance)

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { supabase } from "./supabase";

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null }; }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  componentDidCatch(error, info) { console.error("ErrorBoundary caught:", error, info); }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center min-h-screen bg-gray-50">
          <div className="text-center p-8 max-w-md">
            <div className="text-5xl mb-4">⚠️</div>
            <h2 className="text-xl font-bold text-gray-800 mb-2">Something went wrong</h2>
            <p className="text-sm text-gray-500 mb-4">{this.state.error?.message || "An unexpected error occurred"}</p>
            <button onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }} className="bg-indigo-600 text-white px-6 py-2 rounded-lg hover:bg-indigo-700">Reload App</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Safe number conversion - prevents NaN from breaking calculations
const safeNum = (val) => { const n = Number(val); return isNaN(n) ? 0 : n; };
// Parse "YYYY-MM-DD" as LOCAL date (not UTC) to avoid timezone day-shift
function parseLocalDate(str) {
  if (!str) return new Date(NaN);
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d || 1);
}
function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
const _submitGuards = {};
function guardSubmit(key, recordId) {
  const guardKey = recordId ? key + ":" + recordId : key;
  if (_submitGuards[guardKey]) return false;
  _submitGuards[guardKey] = true;
  // Fallback: release after 8s if not manually released
  setTimeout(() => { _submitGuards[guardKey] = false; }, 8000);
  return true;
}
function guardRelease(key, recordId) {
  const guardKey = recordId ? key + ":" + recordId : key;
  _submitGuards[guardKey] = false;
}
// Wrapper: use in async functions to auto-release on completion or error
async function guarded(key, fn) {
  if (!guardSubmit(key)) return;
  try { await fn(); } finally { guardRelease(key); }
}

async function safeLedgerInsert(entry) {
  const { error } = await supabase.from("ledger_entries").insert([entry]);
  if (error) {
    console.error("LEDGER ENTRY FAILED:", error.message, entry);
    // Alert user so they know balance and ledger may be out of sync
    alert("Warning: Ledger entry failed to save for " + (entry.tenant || "unknown") + ": " + error.message + ". Balance may be out of sync — please check the tenant ledger.");
  }
  return !error;
}

// ============ COMPANY-SCOPED SUPABASE HELPERS ============
// Use these instead of raw supabase.from() to automatically filter by company_id
function companyQuery(table, companyId) {
  if (!companyId) throw new Error("companyQuery: companyId is required");
  return supabase.from(table).select("*").eq("company_id", companyId);
}
function companyInsert(table, rows, companyId) {
  if (!companyId) throw new Error("companyInsert: companyId is required");
  const cid = companyId;
  const withCompany = (Array.isArray(rows) ? rows : [rows]).map(r => ({ ...r, company_id: cid }));
  return supabase.from(table).insert(withCompany);
}
function companyUpsert(table, rows, companyId, onConflict) {
  if (!companyId) throw new Error("companyUpsert: companyId is required");
  const cid = companyId;
  const withCompany = (Array.isArray(rows) ? rows : [rows]).map(r => ({ ...r, company_id: cid }));
  return supabase.from(table).upsert(withCompany, onConflict ? { onConflict } : undefined);
}

// Short random ID for references (avoids Date.now() collisions)
function shortId() {
  const arr = new Uint8Array(6);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(arr);
  else for (let i = 0; i < 6; i++) arr[i] = Math.floor(Math.random() * 256);
  return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

// Generate secure random ID (better than Date.now + Math.random)
const CLASS_COLORS = ["#3B82F6","#10B981","#F59E0B","#EF4444","#8B5CF6","#06B6D4","#F97316","#EC4899"];
function pickColor(str) {
  let hash = 0;
  for (let i = 0; i < (str || "").length; i++) hash = ((hash << 5) - hash) + str.charCodeAt(i);
  return CLASS_COLORS[Math.abs(hash) % CLASS_COLORS.length];
}
function generateId(prefix = "") {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  const arr = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < 16; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < 16; i++) id += chars[arr[i] % chars.length];
  return (prefix ? prefix + "-" : "") + id;
}


// RPC Health Check — validates critical database dependencies on app load
async function checkRPCHealth(companyId) {
  try {
    const requiredRPCs = [
      "create_company_atomic",
      "archive_property", 
      "update_tenant_balance",
      "sign_lease",
    ];
    const missing = [];
    for (const rpc of requiredRPCs) {
      try {
        const { error } = await supabase.rpc(rpc, {});
        if (error?.message?.includes("does not exist") || error?.message?.includes("could not find")) {
          missing.push(rpc);
        }
      } catch (e) {
        if (e.message?.includes("does not exist") || e.message?.includes("could not find")) {
          missing.push(rpc);
        }
        // Other errors (network, etc.) — skip silently
      }
    }
    if (missing.length > 0) {
      console.warn("Missing RPCs:", missing.join(", "));
    }
    return missing;
  } catch (e) {
    console.warn("RPC health check failed:", e.message);
    return []; // Never crash the app over a health check
  }
}

// Sanitize error messages for user display — prevents leaking internal DB details to users
// TODO: Replace remaining browser alert() calls with non-blocking toast notifications
// Currently 257 alert() and 40 confirm() calls exist. Priority replacements:
// 1. Success confirmations → addNotification toast (non-blocking)
// 2. Error messages → wrap in userError() to strip internals
// 3. Destructive confirms → keep window.confirm() for now (blocking is intentional) — strip internal details
function userError(msg) {
  if (!msg) return "An unexpected error occurred. Please try again.";
  // Strip Supabase internal details
  const cleaned = String(msg)
    .replace(/row-level security/gi, "permission")
    .replace(/violates.*constraint/gi, "a validation rule was not met")
    .replace(/duplicate key.*detail:/gi, "this record already exists.")
    .replace(/relation ".*?" does not exist/gi, "a required database table is missing")
    .replace(/function ".*?" does not exist/gi, "a required server function is missing");
  return cleaned.length > 200 ? cleaned.slice(0, 200) + "..." : cleaned;
}
// Guard: require companyId — FAIL CLOSED if missing (no silent fallback)
function normalizeEmail(email) {
  return (email || "").toLowerCase().trim();
}
function formatCurrency(amount) {
  return "$" + safeNum(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Generate a time-limited signed URL for private storage files (1 hour expiry)
async function getSignedUrl(bucket, filePath, expiresIn = 3600) {
  if (!filePath) return "";
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(filePath, expiresIn);
  if (error) { console.warn("Signed URL failed for", filePath, error.message); return ""; }
  return data?.signedUrl || "";
}

// Format phone: accepts digits, adds +1 prefix, formats as (XXX) XXX-XXXX
function formatPhoneInput(value) {
  // Strip everything except digits and +
  let digits = value.replace(/[^\d+]/g, "");
  // If they typed +, keep the country code portion
  if (digits.startsWith("+")) {
    // International format — limit to 15 digits total (E.164 max)
    return digits.slice(0, 16);
  }
  // US format — strip to 10 digits
  digits = digits.replace(/\D/g, "");
  if (digits.length > 10) digits = digits.slice(0, 10);
  // Format as (XXX) XXX-XXXX
  if (digits.length >= 7) return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  if (digits.length >= 4) return `(${digits.slice(0,3)}) ${digits.slice(3)}`;
  if (digits.length > 0) return `(${digits}`;
  return "";
}

// Validate phone — must be 10 digits (US) or start with + (international)

// Format phone: strips non-digits, limits to 10 digits, formats as (xxx) xxx-xxxx

function sanitizeFileName(name) {
  if (!name) return "file";
  return String(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}
// ============ CSV EXPORT HELPER ============
function exportToCSV(data, columns, filename) {
  if (!data || data.length === 0) { alert("No data to export."); return; }
  const header = columns.map(c => c.label).join(",");
  const rows = data.map(row => columns.map(c => {
    let val = typeof c.key === "function" ? c.key(row) : row[c.key];
    if (val === null || val === undefined) val = "";
    val = String(val).replace(/"/g, '""');
    return val.includes(",") || val.includes('"') || val.includes("\n") ? `"${val}"` : val;
  }).join(","));
  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename + ".csv"; a.click();
  URL.revokeObjectURL(url);
}

function buildAddress(p) {
  const parts = [p.address_line_1, p.address_line_2, p.city, (p.state && p.zip) ? p.state + " " + p.zip : p.state || p.zip].filter(Boolean);
  return parts.join(", ") || p.address || "";
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}
function requireCompanyId(companyId, context = "") {
  if (!companyId) {
    const msg = "CRITICAL: Missing companyId" + (context ? " in " + context : "") + " — operation blocked";
    console.error(msg);
    throw new Error(msg);
  }
  return companyId;
}

// ============ AUDIT TRAIL HELPER ============
// Call this from any module to log an action
const AUDIT_ACTIONS = new Set(["create","update","delete","approve","reject","login","logout","invite","void","request"]);
const AUDIT_MODULES = new Set(["properties","tenants","payments","maintenance","leases","vendors","owners","accounting","documents","team","pm_requests","bank_reconciliation","owner_distributions","settings"]);
async function logAudit(action, module, details = "", recordId = "", userEmail = "", userRoleVal = "unknown", companyId) {
  try {
    // Validate action and module to prevent injection of arbitrary audit entries
    if (!AUDIT_ACTIONS.has(action)) { console.warn("logAudit: invalid action:", action); return; }
    if (!AUDIT_MODULES.has(module)) { console.warn("logAudit: invalid module:", module); return; }
    if (!userEmail) {
      const { data: { user } } = await supabase.auth.getUser();
      userEmail = user?.email || "unknown";
    }
    if (!companyId) { console.warn("logAudit: missing companyId — skipping"); return; }
    // Sanitize audit details: truncate and strip potential injection
    const safeDetails = String(details || "").replace(/<[^>]*>/g, "").slice(0, 500);
    const { error: _err130 } = await supabase.from("audit_trail").insert([{ company_id: companyId, action, module, details: safeDetails, record_id: String(recordId), user_email: normalizeEmail(userEmail), user_role: userRoleVal }]);
    if (_err130) console.warn("Audit log insert failed:", _err130.message);
  } catch (e) { console.warn("Audit log failed:", e); }
}

// ============ UNIFIED AUTO-POSTING TO ACCOUNTING ============
async function autoPostJournalEntry({ date, description, reference, property, lines, status = "posted", companyId }) {
  try {
    if (!companyId) { console.error("autoPostJournalEntry: missing companyId — blocked"); return null; }
    const cid = companyId;
    // Resolve bare account IDs — work on a COPY to avoid mutating caller's data
    const resolvedLines = lines?.length > 0 ? lines.map(l => ({ ...l })) : [];
    for (let i = 0; i < resolvedLines.length; i++) {
      if (resolvedLines[i].account_id && /^\d{4}$/.test(resolvedLines[i].account_id)) {
        resolvedLines[i].account_id = await resolveAccountId(resolvedLines[i].account_id, cid);
      }
    }
    // Try atomic server-side function first (fixes race condition + transactional)
    try {
      const { data: jeId, error: rpcErr } = await supabase.rpc("create_journal_entry", {
        p_company_id: cid,
        p_date: date,
        p_description: description,
        p_reference: reference || "",
        p_property: property || "",
        p_status: status,
        p_lines: JSON.stringify(resolvedLines || []),
      });
      if (!rpcErr && jeId) return jeId;
      console.warn("JE RPC fallback:", rpcErr?.message);
    } catch (e) {
      console.error("Journal entry RPC failed:", e.message);
      return null; // RPC is required — no client-side fallback
    }
    return null;
  } catch (e) { console.warn("Auto-post JE failed:", e); return null; }
  // Note: callers should check return value if JE posting is critical
}

// Batch check if AR accrual exists for a tenant in a given month — avoids N+1 queries
async function checkAccrualExists(companyId, month, tenantName) {
  const { data: accrualJEs } = await supabase.from("acct_journal_entries")
    .select("id, reference").eq("company_id", companyId)
    .like("reference", `ACCR-${month}%`).neq("status", "voided");
  if (!accrualJEs || accrualJEs.length === 0) return false;
  const jeIds = accrualJEs.map(je => je.id);
  const { data: allLines } = await supabase.from("acct_journal_lines")
    .select("journal_entry_id, memo").in("journal_entry_id", jeIds);
  if (!allLines) return false;
  return allLines.some(l => l.memo && l.memo.includes(tenantName));
}

// ============ NOTIFICATION QUEUE ============
// Queues email notifications for async processing by Supabase Edge Function
// NOTE: queueNotification inserts into notification_queue but does NOT deliver.
// Delivery requires a separate worker (Supabase Edge Function, Cloudflare Worker, or cron job)
// that reads pending items and sends via email/SMS/push. The Notifications page shows queue status.
async function queueNotification(type, recipientEmail, data, companyId) {
  if (!recipientEmail || !companyId) return;
  try {
    const { error: _notifWriteErr } = await supabase.from("notification_queue").insert([{
      company_id: companyId,
      type,
      recipient_email: recipientEmail.toLowerCase(),
      data: typeof data === "string" ? data : JSON.stringify(data),
      status: "pending",
    }]);
  } catch (e) { console.warn("queueNotification failed:", e.message); }
}

// ============ OWNER DISTRIBUTION AUTOMATION ============
// Auto-calculates management fee + owner net when rent is received
async function autoOwnerDistribution(companyId, propertyAddress, paymentAmount, paymentDate, tenantName) {
  try {
    const { data: prop } = await supabase.from("properties")
      .select("owner_id").eq("company_id", companyId).eq("address", propertyAddress).maybeSingle();
    if (!prop?.owner_id) { console.warn("autoOwnerDistribution: No owner assigned for property " + propertyAddress + " — skipping distribution"); return; }
    const { data: owner } = await supabase.from("owners")
      .select("id, name, email, management_fee_pct").eq("id", prop.owner_id).maybeSingle();
    if (!owner) return;
    const feePct = safeNum(owner.management_fee_pct || 10);
    const mgmtFee = Math.round(paymentAmount * (feePct / 100) * 100) / 100;
    const ownerNet = Math.round((paymentAmount - mgmtFee) * 100) / 100;
    const classId = await getPropertyClassId(propertyAddress, companyId);
    // Post GL: reclassify rental income → owner distribution payable + mgmt fee income
    const _distJeOk = await autoPostJournalEntry({
      companyId, date: paymentDate,
      description: `Owner distribution accrual — ${owner.name} — ${tenantName}`,
      reference: `ODIST-${shortId()}`,
      property: propertyAddress,
      lines: [
        { account_id: "4000", account_name: "Rental Income", debit: paymentAmount, credit: 0, class_id: classId, memo: `Reclassify to owner dist — ${tenantName}` },
        { account_id: "4200", account_name: "Management Fee Income", debit: 0, credit: mgmtFee, class_id: classId, memo: `Mgmt fee ${feePct}% — ${owner.name}` },
        { account_id: "2200", account_name: "Owner Distributions Payable", debit: 0, credit: ownerNet, class_id: classId, memo: `Net to ${owner.name}` },
      ]
    });
    // Create owner statement line item — only if JE succeeded
    if (!_distJeOk) { console.warn("Owner distribution JE failed — skipping distribution record to prevent accounting drift"); return; }
    const month = paymentDate.slice(0, 7);
    await supabase.from("owner_distributions").insert([{
      company_id: companyId, owner_id: owner.id, property: propertyAddress,
      period: month, type: "rent", gross_amount: paymentAmount,
      management_fee: mgmtFee, net_amount: ownerNet, status: "pending",
    }]).then(({ error }) => { if (error) console.warn("Owner dist insert:", error.message); });
  } catch (e) { console.warn("autoOwnerDistribution failed:", e.message); }
}

async function getPropertyClassId(propertyAddress, companyId) {
  if (!propertyAddress) return null;
  const { data } = await supabase.from("acct_classes").select("id").eq("name", propertyAddress).eq("company_id", companyId).limit(1);
  return data?.[0]?.id || null;
}

// Resolve bare account codes (1000, 1100, etc.) to actual DB IDs for this company
const _acctIdCache = {};
async function resolveAccountId(bareCode, companyId) {
  if (!companyId) return bareCode;
  const cid = companyId;
  // Key cache by company to prevent cross-company stale hits
  if (!_acctIdCache[cid]) _acctIdCache[cid] = {};
  if (_acctIdCache[cid]?.[bareCode]) return _acctIdCache[cid][bareCode];
  // Try prefixed format first (co-abc12-1000), then bare code
  const prefix = cid.slice(0, 8) + "-" + bareCode;
  let resolved = bareCode;
  const { data: d1 } = await supabase.from("acct_accounts").select("id").eq("company_id", cid).eq("id", prefix).limit(1);
  if (d1?.length > 0) { resolved = d1[0].id; }
  else {
    const { data: d2 } = await supabase.from("acct_accounts").select("id").eq("company_id", cid).eq("id", bareCode).limit(1);
    if (d2?.length > 0) resolved = d2[0].id;
  }
  _acctIdCache[cid][bareCode] = resolved;
  return resolved;
}

// ============ AUTOMATIC RENT CHARGE ENGINE ============
// Runs on app load. For every active lease, posts monthly rent charges
// (DR Accounts Receivable / CR Rental Income) for each month in the lease term
// up to the current month. Idempotent — won't double-post.
// DEFERRED: autoPostLateFees() — not in MVP scope.
// When implemented, it should:
// 1. Query late_fee_rules for each company
// 2. Compare against unpaid rent charges past the grace period
// 3. Auto-post late fee charges to tenant ledger + GL
// 4. Run via pg_cron alongside autoPostRentCharges
// Current state: late fees are added manually via the tenant ledger.
// This is acceptable for launch — most small PMs apply late fees manually.

async function autoPostRentCharges(companyId) {
  if (!companyId) { console.error("autoPostRentCharges: missing companyId — blocked"); return; }
  try {
    const cid = companyId;
    const today = new Date();
    const currentMonth = formatLocalDate(today).slice(0, 7); // "2026-03"

    // 1. Fetch all active leases and auto-expire any past end_date
    const { data: leases } = await supabase.from("leases").select("*").eq("company_id", cid).eq("status", "active");
    if (!leases || leases.length === 0) return;

    const todayStr = formatLocalDate(today);
    const expiredLeases = leases.filter(l => l.end_date && l.end_date < todayStr);
    if (expiredLeases.length > 0) {
      for (const el of expiredLeases) {
        await supabase.from("leases").update({ status: "expired" }).eq("id", el.id).eq("company_id", cid);
      }
      logAudit("update", "leases", `Auto-expired ${expiredLeases.length} lease(s) past end date`, "", "system", "system", cid);
    }
    const activeLeases = leases.filter(l => !expiredLeases.find(e => e.id === l.id));
    if (activeLeases.length === 0) return;

    // 2. Fetch existing rent charge JEs to avoid duplicates
    const { data: existingJEs } = await supabase.from("acct_journal_entries").select("reference").eq("company_id", cid)
      .like("reference", "RENT-AUTO-%").neq("status", "voided");
    const postedRefs = new Set((existingJEs || []).map(j => j.reference));

    let posted = 0;
    let failed = 0;
    const MAX_CHARGES_PER_RUN = 50; // Safety cap — prevents runaway posting

    for (const lease of activeLeases) {
      if (posted >= MAX_CHARGES_PER_RUN) {
        console.warn("Rent charge cap reached (" + MAX_CHARGES_PER_RUN + "). Remaining charges will post on next run.");
        break;
      }
      if (!lease.rent_amount || lease.rent_amount <= 0) continue;
      if (!lease.start_date || !lease.end_date) continue;

      const leaseStart = parseLocalDate(lease.start_date);
      const leaseEnd = parseLocalDate(lease.end_date);
      const rent = safeNum(lease.rent_amount);
      const classId = await getPropertyClassId(lease.property, companyId);

      // Calculate rent with escalation for each year
      function getRentForDate(date) {
        if (!lease.rent_escalation_pct || lease.rent_escalation_pct <= 0) return rent;
        const yearsElapsed = (date - leaseStart) / (365.25 * 86400000);
        const freq = lease.escalation_frequency || "annual";
        // Calculate periods elapsed based on frequency (capped at 50 to prevent overflow)
        let periods;
        if (freq === "quarterly") periods = Math.min(Math.floor(yearsElapsed * 4), 200);
        else if (freq === "semi-annual") periods = Math.min(Math.floor(yearsElapsed * 2), 100);
        else periods = Math.min(Math.floor(yearsElapsed), 50); // annual
        return Math.round(rent * Math.pow(1 + lease.rent_escalation_pct / 100, periods) * 100) / 100;
      }

      // 3. Walk through each month in the lease term up to current month
      let cursor = new Date(leaseStart.getFullYear(), leaseStart.getMonth(), 1);
      const endCap = new Date(Math.min(leaseEnd.getTime(), today.getTime()));

      while (cursor <= endCap) {
        const monthStr = formatLocalDate(cursor).slice(0, 7); // "2025-06"
        // Clamp payment_due_day to valid day for this month (avoids Feb 30 etc)
        const year = cursor.getFullYear();
        const month = cursor.getMonth() + 1; // 1-based month for Date constructor
        const dueDay = Math.min(lease.payment_due_day || 1, new Date(year, month, 0).getDate());
        const chargeDate = monthStr + "-" + String(dueDay).padStart(2, "0");
        const ref = "RENT-AUTO-" + lease.id + "-" + monthStr;

        // Skip if already posted
        if (!postedRefs.has(ref)) {
          const monthRent = getRentForDate(cursor);
          const jeResult = await autoPostJournalEntry({
            companyId,
            date: chargeDate,
            description: "Rent charge — " + lease.tenant_name + " — " + lease.property + " — " + monthStr,
            reference: ref,
            property: lease.property,
            lines: [
              { account_id: "1100", account_name: "Accounts Receivable", debit: monthRent, credit: 0, class_id: classId, memo: lease.tenant_name + " rent " + monthStr },
              { account_id: "4000", account_name: "Rental Income", debit: 0, credit: monthRent, class_id: classId, memo: lease.property + " " + monthStr },
            ]
          });
          if (!jeResult) { console.warn("Rent JE failed for", lease.tenant_name, monthStr, "— skipping balance update"); failed++; cursor.setMonth(cursor.getMonth() + 1); continue; }

          // Create ledger entry for this rent charge (always, even without tenant_id)
          await safeLedgerInsert({ company_id: cid,
            tenant: lease.tenant_name, property: lease.property,
            date: chargeDate, description: "Rent charge — " + monthStr,
            amount: monthRent, type: "charge", balance: 0,
          });

          // Update tenant balance atomically (prevents drift)
          if (lease.tenant_id) {
            const { error: balErr } = await supabase.rpc("update_tenant_balance", { p_tenant_id: lease.tenant_id, p_amount_change: monthRent });
            if (balErr) console.error("Balance update failed for " + lease.tenant_name + ": " + balErr.message);
          } else {
            // Try to find tenant by name and update balance
            const { data: tenantRow } = await supabase.from("tenants").select("id").eq("company_id", cid).ilike("name", lease.tenant_name).eq("property", lease.property).maybeSingle();
            if (tenantRow) {
              const { error: balErr } = await supabase.rpc("update_tenant_balance", { p_tenant_id: tenantRow.id, p_amount_change: monthRent });
              if (balErr) console.error("Balance update failed for " + lease.tenant_name + ": " + balErr.message);
            }
          }

          posted++;
          postedRefs.add(ref); // prevent re-posting within same run
        }

        // Advance to next month
        cursor.setMonth(cursor.getMonth() + 1);
      }
    }

    if (posted > 0) {
      console.log("🏠 Auto-posted " + posted + " rent charge(s) to accounting");
      logAudit("create", "accounting", "Auto-posted " + posted + " monthly rent charges from active leases", "", "system", "system", companyId);
    }
    if (failed > 0) console.warn("autoPostRentCharges:", failed, "charges failed");
    return { posted, failed };
  } catch (e) {
    console.warn("Auto rent charge posting failed:", e);
    return { posted: 0, failed: -1 };
  }
}

// ============ STYLES ============
const US_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];
const STATE_NAMES = {AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",DC:"District of Columbia",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming"};

const statusColors = {
  occupied: "bg-green-100 text-green-700",
  vacant: "bg-yellow-100 text-yellow-700",
  maintenance: "bg-red-100 text-red-700",
  "notice given": "bg-orange-100 text-orange-700",
  active: "bg-green-100 text-green-700",
  notice: "bg-orange-100 text-orange-700",
  open: "bg-blue-100 text-blue-700",
  in_progress: "bg-purple-100 text-purple-700",
  completed: "bg-slate-100 text-slate-500",
  paid: "bg-green-100 text-green-700",
  partial: "bg-yellow-100 text-yellow-700",
  unpaid: "bg-red-100 text-red-700",
  pending: "bg-yellow-100 text-yellow-700",
  approved: "bg-green-100 text-green-700",
  eviction: "bg-red-100 text-red-700",
};

const priorityColors = {
  emergency: "bg-red-500 text-white",
  normal: "bg-blue-100 text-blue-700",
  low: "bg-slate-100 text-slate-500",
};

// ============ SHARED COMPONENTS ============
function Badge({ status, label }) {
  const color = statusColors[status] || "bg-slate-100 text-slate-600";
  return <span className={`px-2.5 py-1 rounded-full text-xs font-semibold uppercase tracking-wide ${color}`}>{label || status}</span>;
}

function StatCard({ label, value, sub, color = "text-slate-800", onClick }) {
  return (
    <div onClick={onClick} className={"bg-white rounded-3xl shadow-card border border-indigo-50 p-5" + (onClick ? " cursor-pointer hover:border-indigo-200 hover:shadow-md transition-all" : "")}>
      <div className="text-xs text-slate-400 font-medium uppercase tracking-widest mb-1">{label}</div>
      <div className={`text-2xl font-manrope font-bold ${color}`}>{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
    </div>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-card border border-indigo-50 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-indigo-50 sticky top-0 bg-white rounded-t-3xl">
          <h3 className="font-manrope font-bold text-slate-800 text-lg">{title}</h3>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 transition-colors"><span className="material-icons-outlined text-lg">close</span></button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

// ============ SHARED PROPERTY DROPDOWN ============
function PropertyDropdown({ value, onChange, className = "", required = false, label = "Property", companyId }) {
  const [properties, setProperties] = useState([]);
  useEffect(() => {
    supabase.from("properties").select("id, address, type, status").eq("company_id", companyId).order("address").then(({ data }) => setProperties(data || []));
  }, [companyId]);
  return (
    <div>
      {label && <label className="text-xs font-medium text-slate-500 uppercase tracking-widest block mb-1">{label} {required && "*"}</label>}
      <select value={value || ""} onChange={e => { const sel = properties.find(p => p.address === e.target.value); onChange(e.target.value, sel ? sel.id : null); }} className={`border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full focus:border-indigo-300 focus:outline-none transition-colors ${className}`} required={required}>
        <option value="">Select property...</option>
        {properties.map(p => <option key={p.id} value={p.address}>{p.address} ({p.type})</option>)}
      </select>
    </div>
  );
}

// ARCHITECTURE NOTE: Property relationships are keyed by address strings (mutable).
// This is a known technical debt. The proper fix is to use property_id (integer FK)
// everywhere. A rename_property_v2 RPC handles cascading address changes across
// all related tables, but migrating to property_id requires:
// 1. Add property_id FK to tenants, payments, work_orders, utilities, documents, leases
// 2. Backfill property_id from address lookups
// 3. Update all queries to use property_id instead of address string matching
// 4. Keep address as display-only field
// This is tracked as a future migration.

function PropertySelect({ value, onChange, className = "", companyId }) {
  const [properties, setProperties] = useState([]);
  useEffect(() => {
    supabase.from("properties").select("id, address, type").eq("company_id", companyId).order("address").then(({ data }) => setProperties(data || []));
  }, [companyId]);
  return (
    <select value={value || ""} onChange={e => { const sel = properties.find(p => p.address === e.target.value); onChange(e.target.value, sel ? sel.id : null); }} className={`border border-indigo-100 rounded-2xl px-3 py-2 text-sm ${className}`}>
      <option value="">Select property...</option>
      {properties.map(p => <option key={p.id} value={p.address}>{p.address}</option>)}
    </select>
  );
}

// ============ LANDING PAGE ============
function LandingPage({ onGetStarted }) {
  return (
    <div className="min-h-screen bg-[#fcf8ff]">
      <nav className="flex items-center justify-between px-8 py-4 bg-white/80 backdrop-blur-md border-b border-indigo-50">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-200">
            <span className="material-icons-outlined text-white text-sm">domain</span>
          </div>
          <span className="font-manrope font-extrabold text-xl tracking-tight text-indigo-900">Estate Logic</span>
        </div>
        <button onClick={() => onGetStarted("login")} className="bg-indigo-600 text-white text-sm px-5 py-2.5 rounded-2xl hover:bg-indigo-700 font-semibold transition-colors">Sign In</button>
      </nav>
      <div className="bg-gradient-to-br from-indigo-50/50 to-[#fcf8ff] px-8 py-16 text-center">
        <p className="text-indigo-600 font-semibold text-sm uppercase tracking-widest mb-3">Property Management Platform</p>
        <h1 className="text-4xl md:text-5xl font-manrope font-extrabold text-slate-900 mb-4 leading-tight">Property Management<br />Made Simple</h1>
        <p className="text-lg text-slate-400 mb-12 max-w-xl mx-auto">Manage properties, tenants, rent, maintenance, and accounting — all in one place.</p>

        <h2 className="text-lg font-manrope font-manrope font-bold text-slate-700 mb-6">I am a...</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto">
          <button onClick={() => onGetStarted("signup_pm")} className="bg-white rounded-3xl border border-indigo-100 p-8 text-center hover:border-indigo-300 hover:shadow-card transition-all group">
            <div className="w-16 h-16 rounded-2xl bg-indigo-50 flex items-center justify-center mx-auto mb-4 group-hover:scale-110 transition-transform">
              <span className="material-icons-outlined text-indigo-600 text-3xl">business</span>
            </div>
            <div className="text-lg font-manrope font-bold text-slate-800 mb-2">Property Manager</div>
            <p className="text-sm text-slate-400">I manage properties on behalf of owners. Full access to all management tools.</p>
            <div className="mt-4 text-indigo-600 text-sm font-bold">Get Started →</div>
          </button>

          <button onClick={() => onGetStarted("signup_owner")} className="bg-white rounded-3xl border border-emerald-100 p-8 text-center hover:border-emerald-300 hover:shadow-card transition-all group">
            <div className="w-16 h-16 rounded-2xl bg-emerald-50 flex items-center justify-center mx-auto mb-4 group-hover:scale-110 transition-transform">
              <span className="material-icons-outlined text-emerald-600 text-3xl">home</span>
            </div>
            <div className="text-lg font-manrope font-bold text-slate-800 mb-2">Property Owner</div>
            <p className="text-sm text-slate-400">I own properties and want to manage them directly or assign a property manager.</p>
            <div className="mt-4 text-emerald-600 text-sm font-bold">Get Started →</div>
          </button>

          <button onClick={() => onGetStarted("signup_tenant")} className="bg-white rounded-3xl border border-amber-100 p-8 text-center hover:border-amber-300 hover:shadow-card transition-all group">
            <div className="w-16 h-16 rounded-2xl bg-amber-50 flex items-center justify-center mx-auto mb-4 group-hover:scale-110 transition-transform">
              <span className="material-icons-outlined text-amber-600 text-3xl">vpn_key</span>
            </div>
            <div className="text-lg font-manrope font-bold text-slate-800 mb-2">Tenant</div>
            <p className="text-sm text-slate-400">I have an invite code from my landlord or property manager to access my portal.</p>
            <div className="mt-4 text-amber-600 text-sm font-bold">Enter Invite Code →</div>
          </button>
        </div>

        <div className="mt-10">
          <button onClick={() => onGetStarted("login")} className="text-sm text-slate-400 hover:text-indigo-600 transition-colors">Already have an account? <span className="font-bold">Sign In</span></button>
        </div>
      </div>

      <div className="px-8 py-16 bg-white/50">
        <h2 className="text-2xl font-manrope font-bold text-center text-slate-800 mb-10">Everything You Need</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {[
            { icon: "apartment", title: "Property Management", desc: "Track all your properties, units, and their status in one place." },
            { icon: "people", title: "Tenant Management", desc: "Manage tenant profiles, leases, and communication effortlessly." },
            { icon: "payments", title: "Rent Collection", desc: "Collect rent via ACH, card, or autopay with automated reminders." },
            { icon: "build", title: "Maintenance Tracking", desc: "Handle work orders from submission to completion with ease." },
            { icon: "bolt", title: "Utility Management", desc: "Track and pay utility bills with full audit logs." },
            { icon: "account_balance", title: "Full Accounting", desc: "General ledger, bank reconciliation, and financial reports." },
          ].map(f => (
            <div key={f.title} className="bg-white rounded-3xl p-6 shadow-card border border-indigo-50 hover:border-indigo-200 transition-all">
              <div className="w-12 h-12 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center mb-3">
                <span className="material-icons-outlined text-xl">{f.icon}</span>
              </div>
              <div className="font-manrope font-bold text-slate-800 mb-1">{f.title}</div>
              <div className="text-sm text-slate-400">{f.desc}</div>
            </div>
          ))}
        </div>
      </div>
      <footer className="border-t border-indigo-50 px-8 py-6 text-center text-xs text-slate-400">
        © 2025 Estate Logic by Sigma Housing LLC. All rights reserved.
      </footer>
    </div>
  );
}

// ============ LOGIN / SIGNUP PAGE (Role-Aware) ============
function LoginPage({ onLogin, onBack, initialMode = "login" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState(initialMode); // "login", "signup_pm", "signup_owner", "signup_tenant"
  const [signupSuccess, setSignupSuccess] = useState(false);
  const [inviteCode, setInviteCode] = useState("");

  const handleLogin = async () => {
    setLoading(true);
    setError("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
    } else {
      onLogin();
    }
    setLoading(false);
  };

  const handleSignup = async (userType) => {
    if (!email || !password) { setError("Email and password are required."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (!name.trim()) { setError("Name is required."); return; }
    setLoading(true);
    setError("");

    // For tenant signup: validate AND redeem invite code BEFORE creating auth account
    // This prevents orphaned auth accounts if redemption fails
    let tenantRedemption = null;
    if (userType === "tenant") {
      if (!inviteCode.trim()) { setError("Invite code is required."); setLoading(false); return; }
      // Validate invite code (but don't redeem yet)
      const { data: valResult, error: valErr } = await supabase.rpc("validate_invite_code", { p_code: inviteCode.trim().toUpperCase() });
      if (valErr || !valResult?.valid) { setError("Invalid or expired invite code."); setLoading(false); return; }
    }

    // Create auth account FIRST (before redeeming invite to prevent orphaned invites)
    const { data: signupData, error: signupErr } = await supabase.auth.signUp({
      email, password,
      options: { data: { name: name.trim(), user_type: userType } }
    });
    if (signupErr) { setError(signupErr.message); setLoading(false); return; }

    // NOW redeem the invite (auth account exists, safe to consume)
    if (userType === "tenant" && inviteCode) {
      const { data: redeemResult, error: redeemErr } = await supabase.rpc("redeem_invite_code", {
        p_code: inviteCode.trim().toUpperCase(),
        p_email: email.toLowerCase(),
        p_name: name.trim(),
      });
      if (redeemErr || !redeemResult?.success) {
        setError("Account created but invite code failed: " + (redeemErr?.message || "already used") + ". Contact your property manager for a new invite.");
        setLoading(false);
        return;
      }
      tenantRedemption = redeemResult;
    }

    // For tenants: auto-join their company using the invite redemption data
    if (tenantRedemption?.company_id) {
      const { error: memErr } = await supabase.from("company_members").upsert([{
        company_id: tenantRedemption.company_id,
        user_email: email.toLowerCase(),
        user_name: name.trim(),
        role: "tenant",
        status: "active",  // Invite was redeemed — full access immediately
        invited_by: "invite_code",
      }], { onConflict: "company_id,user_email" });
      if (memErr) console.warn("Auto-join from invite failed:", memErr.message);
    }

    // Save user_type to app_users
    const { error: appUserErr } = await supabase.from("app_users").insert([{
      email: email.toLowerCase(), name: name.trim(), role: userType === "tenant" ? "tenant" : userType === "owner" ? "owner" : "pm",
      user_type: userType,
    }]).select();
    if (appUserErr && !appUserErr.message.includes("duplicate")) { console.warn("app_users write failed:", appUserErr.message); }

    setSignupSuccess(true);
    setLoading(false);
  };

  const userTypeLabels = {
    signup_pm: { title: "Property Manager Sign Up", subtitle: "Create your management account", color: "indigo", icon: "🏢" },
    signup_owner: { title: "Property Owner Sign Up", subtitle: "Create your owner account", color: "emerald", icon: "🏠" },
    signup_tenant: { title: "Tenant Sign Up", subtitle: "Join with your invite code", color: "amber", icon: "🔑" },
  };

  if (signupSuccess) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-white flex flex-col">
        <nav className="flex items-center justify-between px-8 py-4">
          <button onClick={onBack} className="text-xl font-bold text-indigo-700">🏡 PropManager</button>
        </nav>
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="bg-white rounded-3xl shadow-card border border-indigo-50 p-8 w-full max-w-sm text-center">
            <div className="text-4xl mb-3">✅</div>
            <h2 className="text-2xl font-manrope font-bold text-slate-800 mb-2">Account Created!</h2>
            <p className="text-sm text-slate-400 mb-4">Check your email for a confirmation link. Once confirmed, you can sign in.</p>
            <button onClick={() => { setSignupSuccess(false); setMode("login"); setError(""); }} className="bg-indigo-600 text-white py-2.5 px-6 rounded-lg font-semibold text-sm hover:bg-indigo-700">Back to Sign In</button>
          </div>
        </div>
      </div>
    );
  }

  const isSignup = mode.startsWith("signup_");
  const typeInfo = userTypeLabels[mode] || {};

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-white flex flex-col">
      <nav className="flex items-center justify-between px-8 py-4">
        <button onClick={onBack} className="text-xl font-bold text-indigo-700">🏡 PropManager</button>
      </nav>
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="bg-white rounded-3xl shadow-card border border-indigo-50 p-8 w-full max-w-sm">
          {isSignup && (
            <div className="text-center mb-4">
              <span className="text-3xl">{typeInfo.icon}</span>
              <h2 className="text-2xl font-manrope font-bold text-slate-800 mt-2">{typeInfo.title}</h2>
              <p className="text-sm text-slate-400">{typeInfo.subtitle}</p>
            </div>
          )}
          {!isSignup && (
            <>
              <h2 className="text-2xl font-manrope font-bold text-slate-800 mb-1">Welcome back</h2>
              <p className="text-sm text-slate-400 mb-6">Sign in to your account</p>
            </>
          )}
          {error && <div className="bg-red-50 text-red-600 text-xs rounded-lg px-3 py-2 mb-4">{error}</div>}

          {isSignup && (
            <div className="mb-4">
              <label className="text-xs font-medium text-slate-500 block mb-1">Full Name</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="John Smith" className="w-full border border-indigo-100 rounded-2xl px-3 py-2.5 text-sm focus:outline-none focus:border-indigo-400" />
            </div>
          )}
          <div className="mb-4">
            <label className="text-xs font-medium text-slate-500 block mb-1">Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" className="w-full border border-indigo-100 rounded-2xl px-3 py-2.5 text-sm focus:outline-none focus:border-indigo-400" />
          </div>
          <div className="mb-4">
            <label className="text-xs font-medium text-slate-500 block mb-1">Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" className="w-full border border-indigo-100 rounded-2xl px-3 py-2.5 text-sm focus:outline-none focus:border-indigo-400" onKeyDown={e => e.key === "Enter" && (isSignup ? handleSignup(mode.replace("signup_", "")) : handleLogin())} />
          </div>

          {mode === "signup_tenant" && (
            <div className="mb-4">
              <label className="text-xs font-medium text-slate-500 block mb-1">Invite Code *</label>
              <input value={inviteCode} onChange={e => setInviteCode(e.target.value.toUpperCase())} placeholder="e.g. TNT-38472916" className="w-full border border-amber-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-amber-500 bg-amber-50 font-mono tracking-wider" />
              <p className="text-xs text-slate-400 mt-1">Check your invite email from your landlord or property manager</p>
            </div>
          )}

          <button onClick={isSignup ? () => handleSignup(mode.replace("signup_", "")) : handleLogin} disabled={loading} className={`w-full text-white py-2.5 rounded-lg font-semibold text-sm disabled:opacity-50 ${isSignup ? (mode === "signup_pm" ? "bg-indigo-600 hover:bg-indigo-700" : mode === "signup_owner" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-amber-600 hover:bg-amber-700") : "bg-indigo-600 hover:bg-indigo-700"}`}>
            {loading ? "Please wait..." : isSignup ? "Create Account" : "Sign In"}
          </button>

          <div className="text-center mt-4 space-y-2">
            {isSignup ? (
              <button onClick={() => { setMode("login"); setError(""); }} className="text-xs text-indigo-600 hover:underline">Already have an account? Sign in</button>
            ) : (
              <button onClick={onBack} className="text-xs text-indigo-600 hover:underline">Back to role selection</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============ DASHBOARD ============
function Dashboard({ notifications, setPage, companyId }) {
  const [properties, setProperties] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [workOrders, setWorkOrders] = useState([]);
  const [payments, setPayments] = useState([]);
  const [utilities, setUtilities] = useState([]);
  const [loading, setLoading] = useState(true);

  const [acctRevenue, setAcctRevenue] = useState(0);
  const [acctExpenses, setAcctExpenses] = useState(0);


  useEffect(() => {
    async function fetchData() {
      const [p, t, w, pay, u] = await Promise.all([
        companyQuery("properties", companyId),
        companyQuery("tenants", companyId),
        companyQuery("work_orders", companyId),
        companyQuery("payments", companyId),
        companyQuery("utilities", companyId),
      ]);
      // Also fetch PM-managed properties from other companies
      const { data: managedProps } = await supabase.from("properties").select("*").eq("pm_company_id", companyId).limit(500);
      const allProps = (p.data || []).map(x => ({ ...x, _ownership: "owned" }));
      (managedProps || []).forEach(mp => { if (!allProps.find(x => x.id === mp.id)) allProps.push({ ...mp, _ownership: "managed", _readOnly: true }); });
      setProperties(allProps);
      setTenants(t.data || []);
      setWorkOrders(w.data || []);
      setPayments(pay.data || []);
      setUtilities(u.data || []);
      // Pull financials from accounting module (journal entries are the GL source of truth,
      // but dashboard stats also reference payments/tenants tables for quick metrics)
      try {
        const { data: jeHeaders } = await supabase.from("acct_journal_entries").select("id").eq("company_id", companyId).eq("status", "posted");
        const jeIds = (jeHeaders || []).map(j => j.id);
        const { data: jeLines } = jeIds.length > 0 ? await supabase.from("acct_journal_lines").select("account_id, debit, credit").in("journal_entry_id", jeIds) : { data: [] };
        const { data: accounts } = await supabase.from("acct_accounts").select("id, type").eq("company_id", companyId);
        if (jeLines && accounts) {
          const acctMap = {};
          accounts.forEach(a => { acctMap[a.id] = a.type; });
          let rev = 0, exp = 0;
          jeLines.forEach(l => {
            const type = acctMap[l.account_id];
            if (type === "Revenue" || type === "Other Income") rev += safeNum(l.credit) - safeNum(l.debit);
            if (type === "Expense" || type === "Cost of Goods Sold" || type === "Other Expense") exp += safeNum(l.debit) - safeNum(l.credit);
          });
          setAcctRevenue(rev);
          setAcctExpenses(exp);
        }
      } catch(e) { console.warn("Dashboard accounting fetch:", e); }
      setLoading(false);
    }
    fetchData();
  }, [companyId]);

  if (loading) return <Spinner />;

  const occupied = properties.filter(p => p.status === "occupied").length;
  const dashMonth = formatLocalDate(new Date()).slice(0, 7);
  const totalRent = payments.filter(p => p.type === "rent" && p.status === "paid" && p.date?.startsWith(dashMonth)).reduce((s, p) => s + safeNum(p.amount), 0);
  const delinquent = tenants.filter(t => t.balance > 0).length;
  const openWO = workOrders.filter(w => w.status !== "completed").length;

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-2xl font-manrope font-bold text-slate-800">Dashboard</h2>
      </div>

      {/* Notifications Banner */}
      {notifications.length > 0 && (
        <div className="mb-5 space-y-2">
          {notifications.slice(0, 3).map(n => (
            <div key={n.id} className="bg-indigo-50 border border-indigo-100 rounded-2xl px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span>{n.icon}</span>
                <span className="text-sm text-indigo-800">{n.message}</span>
              </div>
              <span className="text-xs text-indigo-400">{n.time}</span>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 mb-4 md:grid-cols-4">
        <StatCard onClick={() => setPage("properties")} label="Occupancy" value={`${occupied}/${properties.length}`} sub={`${properties.length ? Math.round(occupied / properties.length * 100) : 0}% occupied`} color="text-green-600" />
        <StatCard onClick={() => setPage("accounting")} label="Revenue (Acctg)" value={`${formatCurrency(acctRevenue)}`} sub="from journal entries" color="text-blue-600" />
        <StatCard onClick={() => setPage("accounting")} label="Expenses (Acctg)" value={`${formatCurrency(acctExpenses)}`} sub="from journal entries" color="text-red-500" />
        <StatCard onClick={() => setPage("accounting")} label="Net Income" value={`$${(acctRevenue - acctExpenses).toLocaleString()}`} sub="revenue - expenses" color={acctRevenue - acctExpenses >= 0 ? "text-emerald-600" : "text-red-600"} />
      </div>
      <div className="grid grid-cols-2 gap-3 mb-6 md:grid-cols-4">
        <StatCard onClick={() => setPage("payments")} label="Rent Collected" value={`${formatCurrency(totalRent)}`} sub="payments table" color="text-indigo-600" />
        <StatCard onClick={() => setPage("tenants")} label="Delinquent" value={delinquent} sub="tenants with balance" color="text-orange-500" />
        <StatCard onClick={() => setPage("maintenance")} label="Open Work Orders" value={openWO} sub={`${workOrders.filter(w => w.priority === "emergency").length} emergency`} color="text-orange-500" />
        <StatCard onClick={() => setPage("utilities")} label="Pending Utilities" value={utilities.filter(u => u.status === "pending").length} sub="awaiting payment" color="text-yellow-600" />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="bg-white rounded-3xl shadow-card border border-indigo-50 p-4">
          <h3 className="font-semibold text-slate-700 mb-3">Lease Expirations</h3>
          {tenants.filter(t => (t.lease_end_date || t.move_out) && parseLocalDate(t.lease_end_date || t.move_out) >= new Date() && Math.ceil((parseLocalDate(t.lease_end_date || t.move_out) - new Date()) / 86400000) <= 90).map(t => (
            <div key={t.id} className="flex justify-between items-center py-2 border-b border-indigo-50/50 last:border-0">
              <div>
                <div className="text-sm font-medium text-slate-800">{t.name}</div>
                <div className="text-xs text-slate-400">{t.property}</div>
              </div>
              <div className="text-sm text-orange-500 font-semibold">{t.move_out}</div>
            </div>
          ))}
          {tenants.filter(t => t.move_out).length === 0 && <div className="text-sm text-slate-400 text-center py-4">No upcoming expirations</div>}
        </div>
        <div className="bg-white rounded-3xl shadow-card border border-indigo-50 p-4">
          <h3 className="font-semibold text-slate-700 mb-3">Recent Maintenance</h3>
          {workOrders.slice(0, 3).map(w => (
            <div key={w.id} className="flex justify-between items-center py-2 border-b border-indigo-50/50 last:border-0">
              <div>
                <div className="text-sm font-medium text-slate-800">{w.issue}</div>
                <div className="text-xs text-slate-400">{w.property}</div>
              </div>
              <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${priorityColors[w.priority]}`}>{w.priority}</span>
            </div>
          ))}
        </div>
        <div className="bg-white rounded-3xl shadow-card border border-indigo-50 p-4">
          <h3 className="font-semibold text-slate-700 mb-3">Utilities Due</h3>
          {utilities.filter(u => u.status === "pending").map(u => (
            <div key={u.id} className="flex justify-between items-center py-2 border-b border-indigo-50/50 last:border-0">
              <div>
                <div className="text-sm font-medium text-slate-800">{u.provider}</div>
                <div className="text-xs text-slate-400">{u.property} · {u.responsibility}</div>
              </div>
              <div className="text-right">
                <div className="text-sm font-semibold text-slate-800">${u.amount}</div>
                <Badge status={u.status} />
              </div>
            </div>
          ))}
          {utilities.filter(u => u.status === "pending").length === 0 && <div className="text-sm text-slate-400 text-center py-4">No pending utilities</div>}
        </div>
        <div className="bg-white rounded-3xl shadow-card border border-indigo-50 p-4">
          <h3 className="font-semibold text-slate-700 mb-3">Net Operating Income</h3>
          <div className="space-y-2">
            {[
              ["Gross Rent Collected", `${formatCurrency(totalRent)}`, "text-green-600"],
              ["Maintenance Costs", `-$${workOrders.reduce((s, w) => s + safeNum(w.cost), 0).toLocaleString()}`, "text-red-500"],
              ["Utility Expenses", `-$${utilities.reduce((s, u) => s + safeNum(u.amount), 0).toLocaleString()}`, "text-red-500"],
              ["NOI", `$${(totalRent - workOrders.reduce((s, w) => s + safeNum(w.cost), 0) - utilities.reduce((s, u) => s + safeNum(u.amount), 0)).toLocaleString()}`, "text-blue-700 font-bold"],
            ].map(([l, v, c]) => (
              <div key={l} className="flex justify-between">
                <span className="text-sm text-slate-500">{l}</span>
                <span className={`text-sm ${c}`}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============ PROPERTIES (Admin-Controlled with Approval Workflow) ============
function Properties({ addNotification, userRole, userProfile, companyId }) {
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [showForm, setShowForm] = useState(false);
  const [editingProperty, setEditingProperty] = useState(null);
  const [timelineProperty, setTimelineProperty] = useState(null);
  const [timelineData, setTimelineData] = useState([]);
  const [form, setForm] = useState({ address_line_1: "", address_line_2: "", city: "", state: "", zip: "", type: "Single Family", status: "vacant", rent: "", security_deposit: "", tenant: "", tenant_email: "", tenant_phone: "", lease_start: "", lease_end: "", notes: "" });
  // Approval workflow
  const [changeRequests, setChangeRequests] = useState([]);
  const [showRequests, setShowRequests] = useState(false);
  const [reviewNotes, setReviewNotes] = useState({});

  const isAdmin = userRole === "admin";

  useEffect(() => { fetchProperties(); fetchChangeRequests(); }, [companyId]);

  async function fetchProperties() {
    // Fetch properties owned by this company
    const { data: ownedProps } = await supabase.from("properties").select("*").eq("company_id", companyId).is("archived_at", null);
    // Also fetch properties where this company is assigned as PM (cross-company)
    const { data: managedProps } = await supabase.from("properties").select("*").eq("pm_company_id", companyId);
    // Merge, deduplicate, and tag ownership type
    const allProps = (ownedProps || []).map(p => ({ ...p, _ownership: "owned" }));
    (managedProps || []).forEach(mp => {
      if (!allProps.find(p => p.id === mp.id)) allProps.push({ ...mp, _ownership: "managed" });
    });
    // Enrich with tenant email/phone for edit forms
    if (allProps.length > 0) {
      const { data: tenantData } = await supabase.from("tenants").select("name, email, phone, property").eq("company_id", companyId);
      if (tenantData) {
        for (const p of allProps) {
          const t = tenantData.find(t => t.property === p.address && t.name === p.tenant);
          if (t) { p._tenantEmail = t.email || ""; p._tenantPhone = t.phone || ""; }
        }
      }
    }
    setProperties(allProps);
    setLoading(false);
  }

  async function openPropertyDetail(p) {
    setSelectedProperty(p);
    const { data: docs } = await supabase.from("documents").select("*").eq("company_id", companyId).eq("property", p.address).order("created_at", { ascending: false }).limit(100);
    setPropertyDocs(docs || []);
    const { data: wos } = await supabase.from("work_orders").select("*").eq("company_id", companyId).eq("property", p.address).order("created_at", { ascending: false }).limit(100);
    setPropertyWorkOrders(wos || []);
  }

  async function fetchChangeRequests() {
    const { data } = await supabase.from("property_change_requests").select("*").eq("company_id", companyId).order("requested_at", { ascending: false }).limit(100);
    setChangeRequests(data || []);
  }

  async function saveProperty() {
      if (!guardSubmit("saveProperty")) return;
      try {
    // Block writes to managed (cross-company) properties
    if (editingProperty && isReadOnly(editingProperty)) {
      alert("This is a managed property. You can only view it, not edit. Contact the property owner to make changes.");
      guardRelease("saveProperty");
      return;
    }
    if (!form.address_line_1.trim()) { alert("Address Line 1 is required."); return; }
    if (!form.city.trim()) { alert("City is required."); return; }
    if (!form.state) { alert("State is required."); return; }
    if (!form.zip.trim()) { alert("ZIP code is required."); return; }
    if (form.status === "occupied") {
      if (!form.tenant.trim()) { alert("Tenant name is required for occupied properties."); return; }
      if (!form.tenant_email.trim() || !form.tenant_email.includes("@")) { alert("A valid tenant email is required for occupied properties."); return; }
      if (!form.tenant_phone.trim()) { alert("Tenant phone number is required for occupied properties."); return; }
      if (!form.rent || isNaN(Number(form.rent)) || Number(form.rent) <= 0) { alert("Monthly rent is required for occupied properties."); return; }
      if (!form.security_deposit || isNaN(Number(form.security_deposit))) { alert("Security deposit amount is required for occupied properties."); return; }
      if (!form.lease_start) { alert("Lease start date is required for occupied properties."); return; }
      if (!form.lease_end) { alert("Lease end date is required for occupied properties."); return; }
      if (form.lease_start >= form.lease_end) { alert("Lease end date must be after lease start date."); return; }
    }
    // Build composite address for backward compatibility
    const compositeAddress = [form.address_line_1, form.address_line_2, form.city, form.state + " " + form.zip].filter(Boolean).join(", ");

    if (isAdmin) {
      // Guard: block edits to managed (cross-company) properties
      if (editingProperty && editingProperty.company_id !== companyId) {
        alert("This property belongs to another company and cannot be edited here.");
        return;
      }
      // Admin: direct save
      const { error } = editingProperty
        ? await supabase.from("properties").update({ address: compositeAddress, address_line_1: form.address_line_1, address_line_2: form.address_line_2, city: form.city, state: form.state, zip: form.zip, type: form.type, status: form.status, rent: form.status === "occupied" ? form.rent : null, security_deposit: form.status === "occupied" ? form.security_deposit : null, tenant: form.status === "occupied" ? form.tenant : "", lease_start: form.status === "occupied" ? form.lease_start : "", lease_end: form.status === "occupied" ? form.lease_end : "", notes: form.notes }).eq("id", editingProperty.id).eq("company_id", companyId)
        : await supabase.from("properties").insert([{ address: compositeAddress, address_line_1: form.address_line_1, address_line_2: form.address_line_2, city: form.city, state: form.state, zip: form.zip, type: form.type, status: form.status, rent: form.status === "occupied" ? form.rent : null, security_deposit: form.status === "occupied" ? form.security_deposit : null, tenant: form.status === "occupied" ? form.tenant : "", lease_start: form.status === "occupied" ? form.lease_start : "", lease_end: form.status === "occupied" ? form.lease_end : "", notes: form.notes, company_id: companyId }]);
      if (error) { alert(userError(error.message)); return; }
      // Show document checklist for occupied properties
      if (form.status === "occupied") {
        setShowDocChecklist({ name: form.tenant, property: compositeAddress, isNew: !editingProperty });
      }
      // Auto-create tenant on tenant page when property becomes occupied
      if (form.status === "occupied" && form.tenant.trim()) {
        const { data: existingTenant } = await supabase.from("tenants").select("id").eq("company_id", companyId).ilike("name", form.tenant.trim()).eq("property", compositeAddress).maybeSingle();
        let tenantId = existingTenant?.id;
        if (!existingTenant) {
          const { data: newT } = await supabase.from("tenants").insert([{ company_id: companyId, name: form.tenant.trim(), email: (form.tenant_email || "").toLowerCase(), phone: form.tenant_phone || "", property: compositeAddress, rent: Number(form.rent) || 0, lease_status: "active", lease_start: form.lease_start || "", lease_end_date: form.lease_end || "", move_in: form.lease_start || "", move_out: form.lease_end || "", balance: 0 }]).select("id").maybeSingle();
          tenantId = newT?.id;
        } else {
          await supabase.from("tenants").update({ email: (form.tenant_email || "").toLowerCase(), phone: form.tenant_phone || "", rent: Number(form.rent) || 0, lease_status: "active", lease_start: form.lease_start || "", lease_end_date: form.lease_end || "", move_in: form.lease_start || "", move_out: form.lease_end || "" }).eq("id", existingTenant.id).eq("company_id", companyId);
        }
        // Auto-create lease record if dates are provided and no active lease exists
        if (form.lease_start && form.lease_end && form.rent) {
          const { data: existingLease } = await supabase.from("leases").select("id").eq("company_id", companyId).eq("property", compositeAddress).eq("status", "active").maybeSingle();
          if (!existingLease) {
            await supabase.from("leases").insert([{ company_id: companyId, tenant_name: form.tenant.trim(), tenant_id: tenantId || null, property: compositeAddress, start_date: form.lease_start, end_date: form.lease_end, rent_amount: Number(form.rent), security_deposit: Number(form.security_deposit) || 0, status: "active", payment_due_day: 1, rent_escalation_pct: 3, escalation_frequency: "annual" }]);
          }
        }
      }
      // #12: Sync security deposit to active lease when editing property
      if (editingProperty && form.status === "occupied" && form.security_deposit) {
        await supabase.from("leases").update({ security_deposit: Number(form.security_deposit) || 0 }).eq("company_id", companyId).eq("property", compositeAddress).eq("status", "active");
      }
      // Cascade address change to all related tables
      if (editingProperty && editingProperty.address !== compositeAddress) {
        // Atomic cascade rename — server-side RPC required (no client fallback)
        const { error: renameErr } = await supabase.rpc("rename_property_v2", {
          p_company_id: companyId, p_property_id: editingProperty.id,
          p_new_address: compositeAddress
        });
        if (renameErr) {
          // #13: Client-side fallback — cascade rename to tables the RPC may not cover
          console.warn("Property rename RPC failed, running client-side fallback:", renameErr.message);
          const oldAddr = editingProperty.address;
          await Promise.all([
            supabase.from("tenants").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
            supabase.from("payments").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
            supabase.from("leases").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
            supabase.from("work_orders").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
            supabase.from("documents").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
            supabase.from("autopay_schedules").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
            supabase.from("utilities").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
            supabase.from("eviction_cases").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
            supabase.from("ledger_entries").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
            supabase.from("messages").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
          ]);
        }
      }
      // Auto-create accounting class for new properties
      if (!editingProperty) {
        const classId = generateId("PROP");
        await supabase.from("acct_classes").upsert([{ id: classId, name: form.address, description: `${form.type} · ${formatCurrency(form.rent)}/mo`, color: pickColor(form.address || ""), is_active: true, company_id: companyId }], { onConflict: "id" });
      }
      addNotification("🏠", editingProperty ? `Property updated: ${form.address}` : `New property added: ${form.address}`);
      logAudit(editingProperty ? "update" : "create", "properties", `${editingProperty ? "Updated" : "Added"} property: ${form.address}`, editingProperty?.id || "", userProfile?.email, userRole, companyId);
    } else {
      // Non-admin: submit change request
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase.from("property_change_requests").insert([{ company_id: companyId,
        request_type: editingProperty ? "edit" : "add",
        property_id: editingProperty?.id || null,
        requested_by: user?.email || "unknown",
        address: form.address,
        type: form.type,
        property_status: form.status,
        rent: form.rent,
        tenant: form.tenant,
        lease_end: form.lease_end,
        notes: form.notes,
      }]);
      if (error) { alert("Error submitting request: " + error.message); return; }
      addNotification("📋", `Change request submitted for: ${form.address} — awaiting admin approval`);
      logAudit("request", "properties", `Requested ${editingProperty ? "edit" : "add"}: ${form.address}`, editingProperty?.id || "", userProfile?.email, userRole, companyId);
      fetchChangeRequests();
    }
    setShowForm(false);
    setEditingProperty(null);
    setForm({ address_line_1: "", address_line_2: "", city: "", state: "", zip: "", type: "Single Family", status: "vacant", rent: "", security_deposit: "", tenant: "", tenant_email: "", tenant_phone: "", lease_start: "", lease_end: "", notes: "" });
    fetchProperties();
      } finally { guardRelease("saveProperty"); }
  }

  async function deleteProperty(id, address) {
      if (!guardSubmit("deleteProperty")) return;
      try {
    if (!isAdmin) { alert("Only admins can archive properties."); return; }
    const targetProp = properties.find(p => String(p.id) === String(id));
    if (targetProp && targetProp.company_id !== companyId) {
      alert("This property belongs to another company and cannot be archived here.");
      return;
    }
    if (!window.confirm(`Archive property "${address}"?\n\nThis will hide it from the active list. You can restore it from the Archive page within 180 days.`)) return;
    // #17: Check if tenants have outstanding balance before archive
    const { data: propertyTenants } = await supabase.from("tenants").select("id, name, balance").eq("company_id", companyId).eq("property", address).is("archived_at", null);
    const tenantsWithBalance = (propertyTenants || []).filter(t => safeNum(t.balance) > 0);
    if (tenantsWithBalance.length > 0) {
      const balMsg = tenantsWithBalance.map(t => `${t.name}: $${safeNum(t.balance).toFixed(2)}`).join(", ");
      if (!window.confirm(`Warning: ${tenantsWithBalance.length} tenant(s) have outstanding balances:\n${balMsg}\n\nArchiving will make these balances harder to collect. Continue anyway?`)) return;
    }
    let archiveTenant = false;
    if (propertyTenants?.length > 0) {
      archiveTenant = window.confirm(`This property has ${propertyTenants.length} tenant(s): ${propertyTenants.map(t => t.name).join(", ")}\n\nWould you also like to archive the tenant(s)?\n\nClick OK to archive tenant(s) too, or Cancel to keep them.`);
    }
    // Use archive RPC (soft delete)
    const { error: archiveErr } = await supabase.rpc("archive_property", {
      p_company_id: companyId,
      p_property_id: String(id),
      p_address: address,
      p_archive_tenant: archiveTenant,
      p_user_email: userProfile?.email || "admin"
    });
    if (archiveErr) {
      // Fallback: direct soft delete if RPC not deployed yet
      const { error: fallbackErr } = await supabase.from("properties").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email }).eq("id", id).eq("company_id", companyId);
      if (fallbackErr) { alert("Failed to archive property: " + fallbackErr.message); return; }
      if (archiveTenant && propertyTenants) {
        for (const t of propertyTenants) {
          await supabase.from("tenants").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email, lease_status: "inactive" }).eq("id", t.id).eq("company_id", companyId);
        }
      }
      // Cascade: terminate active leases and deactivate autopay for this property
      await supabase.from("leases").update({ status: "terminated" }).eq("company_id", companyId).eq("property", address).eq("status", "active");
      await supabase.from("autopay_schedules").update({ enabled: false }).eq("company_id", companyId).eq("property", address);
    }
    addNotification("📦", `Property archived: ${address}`);
    logAudit("archive", "properties", `Archived property: ${address}` + (archiveTenant ? " (with tenant)" : ""), id, userProfile?.email, userRole, companyId);
    fetchProperties();
      } finally { guardRelease("deleteProperty"); }
  }

  // Admin: approve change request
  async function approveRequest(req) {
      if (!guardSubmit("approveRequest")) return;
      try {
    if (req.request_type === "add") {
      const { error: apErr } = await supabase.from("properties").insert([{ company_id: companyId, address: req.address, type: req.type, status: req.property_status, rent: req.rent, tenant: req.tenant, lease_end: req.lease_end, notes: req.notes }]);
      if (apErr) { alert("Error adding property: " + apErr.message); return; }
      // Auto-create accounting class for this property
      const classId = generateId("PROP");
      const { error: classErr } = await supabase.from("acct_classes").upsert([{ id: classId, name: req.address, description: `${req.type} · ${formatCurrency(req.rent)}/mo`, color: pickColor(req?.address || ""), is_active: true, company_id: companyId }], { onConflict: "id" });
      if (classErr) console.warn("Accounting class creation failed:", classErr.message);
      addNotification("✅", `Property approved & added: ${req.address}`);
    } else if (req.request_type === "edit" && req.property_id) {
      // Check if address changed and cascade
      const { data: oldProp } = await supabase.from("properties").select("address").eq("company_id", companyId).eq("id", req.property_id).maybeSingle();
      const { error: editErr } = await supabase.from("properties").update({ address: req.address, type: req.type, status: req.property_status, rent: req.rent, tenant: req.tenant, lease_end: req.lease_end, notes: req.notes }).eq("id", req.property_id).eq("company_id", companyId);
      if (editErr) { alert("Error updating property: " + editErr.message); return; }
      if (oldProp && oldProp.address !== req.address) {
        // Atomic cascade rename via RPC
        const { error: cascErr } = await supabase.rpc("rename_property_v2", {
          p_company_id: companyId, p_property_id: req.property_id,
          p_new_address: req.address
        });
        if (cascErr) alert("Property updated but cascade rename failed: " + cascErr.message + ". Some related records may still show the old address.");
      }
      addNotification("✅", `Property edit approved: ${req.address}`);
    }
    const { data: { user } } = await supabase.auth.getUser();
    const { error: statusErr } = await supabase.from("property_change_requests").update({ status: "approved", reviewed_by: user?.email || "admin", reviewed_at: new Date().toISOString(), review_note: reviewNotes[req.id] || "" }).eq("company_id", companyId).eq("id", req.id);
    if (statusErr) alert("Warning: Property was updated but the request status could not be marked as approved: " + statusErr.message);
    logAudit("approve", "properties", `Approved ${req.request_type} request: ${req.address} (requested by ${req.requested_by})`, req.id, user?.email, "admin", companyId);
    setReviewNotes(prev => { const n = {...prev}; delete n[req.id]; return n; });
    fetchProperties();
    fetchChangeRequests();
      } finally { guardRelease("approveRequest"); }
  }

  // Admin: reject change request
  async function rejectRequest(req) {
      if (!guardSubmit("rejectRequest")) return;
      try {
    const { data: { user } } = await supabase.auth.getUser();
    const { error: rejStatusErr } = await supabase.from("property_change_requests").update({ status: "rejected", reviewed_by: user?.email || "admin", reviewed_at: new Date().toISOString(), review_note: reviewNotes[req.id] || "" }).eq("company_id", companyId).eq("id", req.id);
    if (rejStatusErr) alert("Warning: Could not mark request as rejected: " + rejStatusErr.message);
    addNotification("❌", `Property request rejected: ${req.address}`);
    logAudit("reject", "properties", `Rejected ${req.request_type} request: ${req.address} (requested by ${req.requested_by})`, req.id, user?.email, "admin", companyId);
    setReviewNotes(prev => { const n = {...prev}; delete n[req.id]; return n; });
    fetchChangeRequests();
      } finally { guardRelease("rejectRequest"); }
  }

  // Timeline (same as before)
  async function loadTimeline(p) {
    setTimelineProperty(p);
    const [pay, wo, docs] = await Promise.all([
      supabase.from("payments").select("*").eq("company_id", companyId).eq("property", p.address).limit(200),
      supabase.from("work_orders").select("*").eq("company_id", companyId).eq("property", p.address),
      supabase.from("documents").select("*").eq("company_id", companyId).eq("property", p.address),
    ]);
    const all = [
      ...(pay.data || []).map(x => ({ ...x, _type: "payment", _date: x.date })),
      ...(wo.data || []).map(x => ({ ...x, _type: "work_order", _date: x.created_at })),
      ...(docs.data || []).map(x => ({ ...x, _type: "document", _date: x.created_at })),
    ].sort((a, b) => new Date(b._date) - new Date(a._date));
    setTimelineData(all);
  }

  async function assignPM(property) {
    if (!guardSubmit("assignPM")) return;
    if (!pmCode.trim()) { alert("Please enter the PM company's 8-digit code."); return; }
    const { data: pmCompany } = await supabase.from("companies").select("id, name, company_role").eq("company_code", pmCode.trim()).maybeSingle();
    if (!pmCompany) { alert("No company found with that code."); return; }
    if (pmCompany.company_role !== "management") { alert(pmCompany.name + " is not a management company. Only management companies can be assigned as PM."); return; }
    // Check for existing pending or accepted assignment
    const { data: existingReq } = await supabase.from("pm_assignment_requests").select("id, status")
      .eq("owner_company_id", companyId).eq("pm_company_id", pmCompany.id).eq("property_id", property.id)
      .in("status", ["pending", "accepted"]).maybeSingle();
    if (existingReq?.status === "pending") { alert("A request to assign " + pmCompany.name + " is already pending for this property."); return; }
    if (existingReq?.status === "accepted") { alert(pmCompany.name + " is already assigned as PM for this property."); return; }
    // Also check if property already has this PM directly assigned
    if (property.pm_company_id === pmCompany.id) { alert(pmCompany.name + " is already the property manager for this property."); return; }
    if (!window.confirm("Request " + pmCompany.name + " to manage " + property.address + "?\n\nThey will need to accept before getting access to this property.")) return;
    // Create assignment REQUEST (not direct assignment)
    const { error: reqErr } = await supabase.from("pm_assignment_requests").insert([{
      owner_company_id: companyId,
      pm_company_id: pmCompany.id,
      pm_company_name: pmCompany.name,
      property_id: property.id,
      property_address: property.address,
      requested_by: normalizeEmail(userProfile?.email),
    }]);
    if (reqErr) { alert("Error creating PM request: " + reqErr.message); return; }
    addNotification("📨", "PM assignment request sent to " + pmCompany.name + " for " + property.address);
    logAudit("create", "pm_requests", "Requested PM: " + pmCompany.name + " for " + property.address, property.id, userProfile?.email, userRole, companyId);
    setShowPmAssign(null);
    setPmCode("");
    fetchProperties();
  }

  async function removePM(property) {
      if (!guardSubmit("removePM")) return;
      try {
    if (!window.confirm("Remove " + (property.pm_company_name || "PM") + " as property manager for " + property.address + "?\n\nYou will regain full operational control.")) return;
    const { error: rmErr } = await supabase.from("properties").update({ pm_company_id: null, pm_company_name: null }).eq("id", property.id).eq("company_id", companyId);
    if (rmErr) { alert("Error removing PM: " + rmErr.message); return; }
    addNotification("🏠", "PM removed from " + property.address + ". You now have full control.");
    logAudit("update", "properties", "Removed PM from " + property.address, property.id, userProfile?.email, userRole, companyId);
    fetchProperties();
      } finally { guardRelease("removePM"); }
  }

  // Check if current company is an owner company viewing a PM-managed property
  function isReadOnly(property) {
    // Property is read-only if its company_id differs from the active company
    // This makes PM-managed properties read-only for the PM, and owned properties editable for the owner
    return property.company_id !== (companyId);
  }

  const [viewMode, setViewMode] = useState("card");
  const [filterType, setFilterType] = useState("all");
  const [filterOwnership, setFilterOwnership] = useState("all");
  const [filterOwner, setFilterOwner] = useState("all");
  const [filterCity, setFilterCity] = useState("all");
  const [visibleCols, setVisibleCols] = useState(["address","type","status","rent","tenant","lease_end"]);
  const [showColPicker, setShowColPicker] = useState(false);
  const [showPmAssign, setShowPmAssign] = useState(null);
  const [showRecurringSetup, setShowRecurringSetup] = useState(null); // { tenant, property, rent }
  const [showDocChecklist, setShowDocChecklist] = useState(null);
  const [selectedProperty, setSelectedProperty] = useState(null);
  const [propertyDocs, setPropertyDocs] = useState([]);
  const [propertyWorkOrders, setPropertyWorkOrders] = useState([]); // property/tenant that needs docs
  const [pmCode, setPmCode] = useState("");
  const allCols = [
    { id: "address", label: "Address" }, { id: "type", label: "Type" }, { id: "status", label: "Status" },
    { id: "rent", label: "Rent" }, { id: "tenant", label: "Tenant" }, { id: "lease_end", label: "Lease End" },
    { id: "notes", label: "Notes" }, { id: "owner_name", label: "Owner" },
  ];
  const propertyTypes = [...new Set(properties.map(p => p.type).filter(Boolean))];
  const propertyOwners = [...new Set(properties.map(p => p.owner_name).filter(Boolean))];
  const propertyCities = [...new Set(properties.map(p => {
    const parts = (p.address || "").split(",").map(s => s.trim());
    return parts.length >= 2 ? parts[parts.length - 2] : "";
  }).filter(Boolean))].sort();
  const hasManagedProps = properties.some(p => p._ownership === "managed");
  const pendingRequests = changeRequests.filter(r => r.status === "pending");

  if (loading) return <Spinner />;
  const filtered = properties.filter(p => {
    if (filter !== "all" && p.status !== filter) return false;
    if (filterType !== "all" && p.type !== filterType) return false;
    if (filterOwnership !== "all" && p._ownership !== filterOwnership) return false;
    if (filterOwner !== "all" && p.owner_name !== filterOwner) return false;
    if (filterCity !== "all") {
      const parts = (p.address || "").split(",").map(s => s.trim());
      const city = parts.length >= 2 ? parts[parts.length - 2] : "";
      if (city !== filterCity) return false;
    }
    const q = search.toLowerCase();
    if (q && !p.address?.toLowerCase().includes(q) && !p.type?.toLowerCase().includes(q) && !p.tenant?.toLowerCase()?.includes(q) && !p.owner_name?.toLowerCase()?.includes(q)) return false;
    return true;
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-manrope font-bold text-slate-800">Properties</h2>
        <div className="text-xs text-slate-400">
          {filtered.length} of {properties.length} properties
          {hasManagedProps && <span> · {properties.filter(p => p._ownership === "managed").length} PM-managed</span>}
        </div>
      </div>

      {isAdmin && pendingRequests.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 flex items-center justify-between">
          <span className="text-sm text-amber-800">📋 <strong>{pendingRequests.length}</strong> property change {pendingRequests.length === 1 ? "request" : "requests"} awaiting review</span>
          <button onClick={() => setShowRequests(!showRequests)} className="text-xs bg-amber-200 text-amber-800 px-3 py-1.5 rounded-lg font-medium hover:bg-amber-300">{showRequests ? "Hide" : "Review"}</button>
        </div>
      )}
      {!isAdmin && changeRequests.filter(r => r.status === "pending").length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 mb-4">
          <span className="text-sm text-blue-800">📋 You have <strong>{changeRequests.filter(r => r.status === "pending").length}</strong> pending request(s)</span>
        </div>
      )}

      {isAdmin && showRequests && pendingRequests.length > 0 && (
        <div className="bg-white rounded-3xl shadow-card border border-indigo-50 p-4 mb-4 space-y-3">
          <h3 className="font-semibold text-slate-800">Pending Approval</h3>
          {pendingRequests.map(req => (
            <div key={req.id} className="border border-amber-100 rounded-3xl p-4 bg-amber-50/30">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${req.request_type === "add" ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700"}`}>{req.request_type === "add" ? "New" : "Edit"}</span>
                    <span className="text-xs text-slate-400">by {req.requested_by}</span>
                  </div>
                  <p className="font-semibold text-slate-800">{req.address}</p>
                  <p className="text-xs text-slate-400 mt-1">{req.type} · ${req.rent}/mo</p>
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  <input value={reviewNotes[req.id] || ""} onChange={e => setReviewNotes(prev => ({...prev, [req.id]: e.target.value}))} placeholder="Note" className="border border-indigo-100 rounded-2xl px-2 py-1 text-xs w-32" />
                  <div className="flex gap-1">
                    <button onClick={() => approveRequest(req)} className="bg-emerald-600 text-white text-xs px-3 py-1.5 rounded-lg">✓ Approve</button>
                    <button onClick={() => rejectRequest(req)} className="bg-red-500 text-white text-xs px-3 py-1.5 rounded-lg">✕ Reject</button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col md:flex-row gap-3 mb-4">
        <input placeholder="Search properties..." value={search} onChange={e => setSearch(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm flex-1" />
        <select value={filter} onChange={e => setFilter(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
          <option value="all">All Status</option><option value="occupied">Occupied</option><option value="vacant">Vacant</option><option value="maintenance">Maintenance</option>
        </select>
        <select value={filterType} onChange={e => setFilterType(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
          <option value="all">All Types</option>
          {propertyTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        {hasManagedProps && (
          <select value={filterOwnership} onChange={e => setFilterOwnership(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
            <option value="all">All Properties</option>
            <option value="owned">Owned by Us</option>
            <option value="managed">PM-Managed</option>
          </select>
        )}
        {propertyOwners.length > 1 && (
          <select value={filterOwner} onChange={e => setFilterOwner(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
            <option value="all">All Owners</option>
            {propertyOwners.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        )}
        {propertyCities.length > 1 && (
          <select value={filterCity} onChange={e => setFilterCity(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
            <option value="all">All Cities</option>
            {propertyCities.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <div className="flex bg-indigo-50 rounded-2xl p-0.5">
          {[["card","▦"],["table","☰"],["compact","≡"]].map(([m,icon]) => (
            <button key={m} onClick={() => setViewMode(m)} className={`px-3 py-1.5 text-sm rounded-md ${viewMode === m ? "bg-white shadow-sm text-indigo-700 font-semibold" : "text-slate-400"}`} title={m}>{icon}</button>
          ))}
        </div>
        {viewMode === "table" && (
          <div className="relative">
            <button onClick={() => setShowColPicker(!showColPicker)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-xs text-slate-400 hover:bg-indigo-50/30">⚙️ Columns</button>
            {showColPicker && (
              <div className="absolute right-0 top-10 bg-white border border-indigo-100 rounded-3xl shadow-lg p-3 z-50 w-48">
                {allCols.map(c => (
                  <label key={c.id} className="flex items-center gap-2 py-1 text-xs text-slate-700 cursor-pointer">
                    <input type="checkbox" checked={visibleCols.includes(c.id)} onChange={() => setVisibleCols(prev => prev.includes(c.id) ? prev.filter(x => x !== c.id) : [...prev, c.id])} className="rounded" />
                    {c.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        <button onClick={() => { setEditingProperty(null); setForm({ address_line_1: "", address_line_2: "", city: "", state: "", zip: "", type: "Single Family", status: "vacant", rent: "", security_deposit: "", tenant: "", tenant_email: "", tenant_phone: "", lease_start: "", lease_end: "", notes: "" }); setShowForm(!showForm); }} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-indigo-700 whitespace-nowrap">
          {isAdmin ? "+ Add" : "+ Request"}
        </button>
      </div>

      {/* ===== PROPERTY DETAIL PANEL ===== */}
      {selectedProperty && (
        <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex justify-end">
          <div className="bg-white w-full max-w-lg h-full flex flex-col shadow-2xl overflow-y-auto">
            {/* Header */}
            <div className={"p-6 text-white " + (selectedProperty.status === "occupied" ? "bg-gradient-to-r from-emerald-600 to-emerald-800" : selectedProperty.status === "vacant" ? "bg-gradient-to-r from-amber-500 to-amber-700" : "bg-gradient-to-r from-gray-600 to-gray-800")}>
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold">{selectedProperty.address_line_1 || selectedProperty.address}</h2>
                  <div className="text-sm opacity-80">{[selectedProperty.city, selectedProperty.state, selectedProperty.zip].filter(Boolean).join(", ")}</div>
                  {selectedProperty.address_line_2 && <div className="text-xs opacity-60">{selectedProperty.address_line_2}</div>}
                </div>
                <button onClick={() => setSelectedProperty(null)} className="text-white/70 hover:text-white text-2xl">✕</button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
                <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs opacity-70">Status</div><div className="text-sm font-bold capitalize">{selectedProperty.status}</div></div>
                <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs opacity-70">Type</div><div className="text-sm font-bold">{selectedProperty.type}</div></div>
                <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs opacity-70">Rent</div><div className="text-sm font-bold">{selectedProperty.rent ? "$" + safeNum(selectedProperty.rent).toLocaleString() : "—"}</div></div>
                <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs opacity-70">Lease End</div><div className="text-sm font-bold">{selectedProperty.lease_end || "—"}</div></div>
              </div>
            </div>

            {/* Tenant Info */}
            {selectedProperty.tenant && (
              <div className="px-6 py-4 border-b border-indigo-50">
                <div className="text-xs font-semibold text-slate-400 uppercase mb-2">Current Tenant</div>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold">{selectedProperty.tenant?.[0]}</div>
                  <div>
                    <div className="font-semibold text-slate-800">{selectedProperty.tenant}</div>
                    <div className="text-xs text-slate-400">{selectedProperty._tenantEmail || ""} · {selectedProperty._tenantPhone || ""}</div>
                  </div>
                </div>
              </div>
            )}

            {/* Property Details */}
            <div className="px-6 py-4 border-b border-indigo-50">
              <div className="text-xs font-semibold text-slate-400 uppercase mb-2">Details</div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-slate-400 text-xs block">Security Deposit</span><span className="font-semibold text-slate-700">{selectedProperty.security_deposit ? "$" + safeNum(selectedProperty.security_deposit).toLocaleString() : "—"}</span></div>
                <div><span className="text-slate-400 text-xs block">Lease Start</span><span className="font-semibold text-slate-700">{selectedProperty.lease_start || "—"}</span></div>
                {selectedProperty.pm_company_name && <div><span className="text-slate-400 text-xs block">Property Manager</span><span className="font-semibold text-purple-700">{selectedProperty.pm_company_name}</span></div>}
                {selectedProperty.notes && <div className="col-span-2"><span className="text-slate-400 text-xs block">Notes</span><span className="text-slate-500">{selectedProperty.notes}</span></div>}
              </div>
            </div>

            {/* Documents */}
            <div className="px-6 py-4 border-b border-indigo-50">
              <div className="text-xs font-semibold text-slate-400 uppercase mb-2">Documents ({propertyDocs.length})</div>
              {propertyDocs.length === 0 ? (
                <div className="text-sm text-slate-400">No documents uploaded</div>
              ) : (
                <div className="space-y-1">
                  {propertyDocs.slice(0, 5).map(d => (
                    <div key={d.id} className="flex items-center justify-between bg-indigo-50/30 rounded-lg px-3 py-2">
                      <div className="text-sm text-slate-700">{d.name}</div>
                      <button onClick={async () => { const url = await getSignedUrl("documents", d.file_name || d.url); if (url) window.open(url, "_blank", "noopener,noreferrer"); }} className="text-xs text-indigo-600 hover:underline">View</button>
                    </div>
                  ))}
                  {propertyDocs.length > 5 && <div className="text-xs text-slate-400">+ {propertyDocs.length - 5} more</div>}
                </div>
              )}
            </div>

            {/* Work Orders */}
            <div className="px-6 py-4 border-b border-indigo-50">
              <div className="text-xs font-semibold text-slate-400 uppercase mb-2">Work Orders ({propertyWorkOrders.length})</div>
              {propertyWorkOrders.length === 0 ? (
                <div className="text-sm text-slate-400">No work orders</div>
              ) : (
                <div className="space-y-1">
                  {propertyWorkOrders.slice(0, 5).map(w => (
                    <div key={w.id} className="flex items-center justify-between bg-indigo-50/30 rounded-lg px-3 py-2">
                      <div><div className="text-sm text-slate-700">{w.issue}</div><div className="text-xs text-slate-400">{w.status} · {w.priority}</div></div>
                      <Badge status={w.status} />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="px-6 py-4">
              <div className="flex gap-2 flex-wrap">
                {!isReadOnly(selectedProperty) && <button onClick={() => { setEditingProperty(selectedProperty); setForm({ address_line_1: selectedProperty.address_line_1 || selectedProperty.address || "", address_line_2: selectedProperty.address_line_2 || "", city: selectedProperty.city || "", state: selectedProperty.state || "", zip: selectedProperty.zip || "", type: selectedProperty.type, status: selectedProperty.status, rent: selectedProperty.rent || "", security_deposit: selectedProperty.security_deposit || "", tenant: selectedProperty.tenant || "", tenant_email: selectedProperty._tenantEmail || "", tenant_phone: selectedProperty._tenantPhone || "", lease_start: selectedProperty.lease_start || "", lease_end: selectedProperty.lease_end || "", notes: selectedProperty.notes || "" }); setShowForm(true); setSelectedProperty(null); }} className="bg-indigo-600 text-white text-xs px-4 py-2 rounded-2xl hover:bg-indigo-700">Edit Property</button>}
                <button onClick={() => { setPage("documents"); setSelectedProperty(null); }} className="bg-slate-100 text-slate-500 text-xs px-4 py-2 rounded-2xl hover:bg-slate-100">Upload Document</button>
                <button onClick={() => { setPage("maintenance"); setSelectedProperty(null); }} className="bg-slate-100 text-slate-500 text-xs px-4 py-2 rounded-2xl hover:bg-slate-100">New Work Order</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <div className="bg-white p-4 rounded-xl border border-indigo-50 shadow-sm mb-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">{editingProperty ? "Edit Property" : "Add Property"}</h3>
          {!isAdmin && <p className="text-xs text-blue-600 bg-blue-50 rounded-lg px-3 py-2 mb-3">Submitted for admin approval.</p>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="col-span-1 sm:col-span-2"><label className="text-xs font-medium text-slate-400 mb-1 block">Address Line 1 *</label><input placeholder="123 Main St" value={form.address_line_1} onChange={e => setForm({ ...form, address_line_1: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" required /></div>
            <div className="col-span-1 sm:col-span-2"><label className="text-xs font-medium text-slate-400 mb-1 block">Address Line 2</label><input placeholder="Apt 4B, Suite 200, etc." value={form.address_line_2} onChange={e => setForm({ ...form, address_line_2: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">City *</label><input placeholder="Greenbelt" value={form.city} onChange={e => setForm({ ...form, city: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" required /></div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="text-xs font-medium text-slate-400 mb-1 block">State *</label><select value={form.state} onChange={e => setForm({ ...form, state: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" required><option value="">--</option>{US_STATES.map(s => <option key={s} value={s}>{s}</option>)}</select></div>
              <div><label className="text-xs font-medium text-slate-400 mb-1 block">ZIP *</label><input placeholder="20770" value={form.zip} onChange={e => setForm({ ...form, zip: e.target.value.replace(/[^\d-]/g, "").slice(0, 10) })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" required /></div>
            </div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Type *</label><select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full"><option>Single Family</option><option>Multi-Family</option><option>Apartment</option><option>Townhouse</option><option>Commercial</option></select></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Status *</label><select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full"><option value="vacant">Vacant</option><option value="occupied">Occupied</option><option value="maintenance">Maintenance</option></select></div>
            {form.status === "occupied" && (<>
              <div className="col-span-1 sm:col-span-2 bg-indigo-50 rounded-lg px-3 py-2"><div className="text-xs font-semibold text-indigo-700">Tenant Information</div></div>
              <div><label className="text-xs font-medium text-slate-400 mb-1 block">Tenant Name *</label><input placeholder="Jane Doe" value={form.tenant} onChange={e => setForm({ ...form, tenant: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" required /></div>
              <div><label className="text-xs font-medium text-slate-400 mb-1 block">Tenant Email *</label><input type="email" placeholder="tenant@email.com" value={form.tenant_email} onChange={e => setForm({ ...form, tenant_email: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" required /></div>
              <div><label className="text-xs font-medium text-slate-400 mb-1 block">Tenant Phone *</label><input type="tel" placeholder="(555) 123-4567" value={form.tenant_phone} onChange={e => setForm({ ...form, tenant_phone: formatPhoneInput(e.target.value) })} maxLength={14} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" required /></div>
              <div className="col-span-1 sm:col-span-2 bg-indigo-50 rounded-lg px-3 py-2 mt-1"><div className="text-xs font-semibold text-indigo-700">Lease Details</div></div>
              <div><label className="text-xs font-medium text-slate-400 mb-1 block">Monthly Rent ($) *</label><input placeholder="1500" value={form.rent} onChange={e => setForm({ ...form, rent: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" required /></div>
              <div><label className="text-xs font-medium text-slate-400 mb-1 block">Security Deposit ($) *</label><input placeholder="1500" value={form.security_deposit} onChange={e => setForm({ ...form, security_deposit: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" required /></div>
              <div><label className="text-xs font-medium text-slate-400 mb-1 block">Lease Start Date *</label><input type="date" value={form.lease_start} onChange={e => setForm({ ...form, lease_start: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" required /></div>
              <div><label className="text-xs font-medium text-slate-400 mb-1 block">Lease End Date *</label><input type="date" value={form.lease_end} onChange={e => { if (form.lease_start && e.target.value && e.target.value <= form.lease_start) { alert("Lease end date must be after lease start date."); return; } setForm({ ...form, lease_end: e.target.value }); }} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" required /></div>
            </>)}
            <div className="col-span-1 sm:col-span-2"><label className="text-xs font-medium text-slate-400 mb-1 block">Notes</label><textarea placeholder="Any additional notes" value={form.notes || ""} onChange={e => setForm({ ...form, notes: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" rows={2} /></div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={saveProperty} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg">{isAdmin ? "Save" : "Submit"}</button>
            <button onClick={() => { setShowForm(false); setEditingProperty(null); }} className="bg-slate-100 text-slate-500 text-sm px-4 py-2 rounded-lg">Cancel</button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        <div className="bg-white rounded-3xl border border-indigo-50 px-3 py-2 text-center"><div className="text-lg font-manrope font-bold text-slate-800">{properties.length}</div><div className="text-xs text-slate-400">Total</div></div>
        <div className="bg-white rounded-3xl border border-indigo-50 px-3 py-2 text-center"><div className="text-lg font-bold text-emerald-600">{properties.filter(p => p.status === "occupied").length}</div><div className="text-xs text-slate-400">Occupied</div></div>
        <div className="bg-white rounded-3xl border border-indigo-50 px-3 py-2 text-center"><div className="text-lg font-bold text-amber-600">{properties.filter(p => p.status === "vacant").length}</div><div className="text-xs text-slate-400">Vacant</div></div>
        <div className="bg-white rounded-3xl border border-indigo-50 px-3 py-2 text-center"><div className="text-lg font-bold text-indigo-600">${properties.reduce((s, p) => s + safeNum(p.rent), 0).toLocaleString()}</div><div className="text-xs text-slate-400">Total Rent</div></div>
      </div>

      {showDocChecklist && (
        <div className="bg-amber-50 border border-amber-200 rounded-3xl p-4 mb-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-bold text-amber-800">📋 Required Documents for {showDocChecklist.name}</div>
            <button onClick={() => setShowDocChecklist(null)} className="text-amber-400 hover:text-amber-600">✕</button>
          </div>
          <p className="text-xs text-amber-600 mb-3">The following documents are required for lease compliance. Please upload them in the Documents section.</p>
          <div className="space-y-2">
            {["Signed Lease Agreement", "Government-Issued ID", "Renters Insurance Certificate", "Proof of Utility Transfer"].map(doc => (
              <div key={doc} className="flex items-center gap-2 bg-white rounded-lg px-3 py-2 border border-amber-100">
                <span className="text-amber-400">☐</span>
                <span className="text-sm text-slate-700">{doc}</span>
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={() => { setPage("documents"); setShowDocChecklist(null); }} className="bg-amber-600 text-white text-xs px-4 py-2 rounded-lg hover:bg-amber-700">Upload Documents Now</button>
            <button onClick={() => { if (isAdmin || window.confirm("Skip document upload? This will require admin approval later.")) setShowDocChecklist(null); }} className="bg-slate-100 text-slate-500 text-xs px-4 py-2 rounded-lg">Skip for Now</button>
          </div>
        </div>
      )}

      {viewMode === "card" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(p => (
            <div key={p.id} onClick={() => openPropertyDetail(p)} className={`bg-white rounded-xl border shadow-sm p-4 cursor-pointer hover:shadow-md hover:border-indigo-200 transition-all ${isReadOnly(p) ? "border-purple-200 bg-purple-50/30" : "border-indigo-50"}`}>
              <div className="flex items-start justify-between mb-2">
                <div>
                  <h3 className="font-semibold text-slate-800 text-sm">{p.address_line_1 || p.address}</h3>{(p.city || p.state) && <div className="text-xs text-slate-400">{[p.city, p.state, p.zip].filter(Boolean).join(", ")}</div>}
                  <p className="text-xs text-slate-400">{p.type}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge status={p.status} label={p.status} />
                  {p.pm_company_name && <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">PM: {p.pm_company_name}</span>}
                </div>
              </div>
              <div className="text-sm text-slate-500 space-y-1">
                <div className="flex justify-between"><span>Rent:</span><span className="font-semibold">${safeNum(p.rent).toLocaleString()}</span></div>
                {p.tenant && <div className="flex justify-between"><span>Tenant:</span><span>{p.tenant}</span></div>}
                {p.lease_end && <div className="flex justify-between"><span>Lease End:</span><span>{p.lease_end}</span></div>}
              </div>
              {isReadOnly(p) && <div className="mt-2 text-xs text-purple-600 bg-purple-50 rounded-lg px-2 py-1">🔒 Managed property — view only</div>}
              <div className="flex gap-2 mt-3 pt-3 border-t border-indigo-50/50 flex-wrap" onClick={e => e.stopPropagation()}>
                {!isReadOnly(p) && <button onClick={() => { setEditingProperty(p); setForm({ address_line_1: p.address_line_1 || p.address || "", address_line_2: p.address_line_2 || "", city: p.city || "", state: p.state || "", zip: p.zip || "", type: p.type, status: p.status, rent: p.rent || "", security_deposit: p.security_deposit || "", tenant: p.tenant || "", tenant_email: p._tenantEmail || "", tenant_phone: p._tenantPhone || "", lease_start: p.lease_start || "", lease_end: p.lease_end || "", notes: p.notes || "" }); setShowForm(true); }} className="text-xs text-indigo-600 hover:underline">Edit</button>}
                {!isReadOnly(p) && isAdmin && <button onClick={() => deleteProperty(p.id, p.address)} className="text-xs text-red-500 hover:underline">Archive</button>}
                {!p.pm_company_id && !isReadOnly(p) && isAdmin && <button onClick={() => { setShowPmAssign(p); setPmCode(""); }} className="text-xs text-purple-600 hover:underline">Assign PM</button>}
                {p.pm_company_id && !isReadOnly(p) && isAdmin && <button onClick={() => removePM(p)} className="text-xs text-orange-600 hover:underline">Remove PM</button>}
                <button onClick={() => loadTimeline(p)} className="text-xs text-slate-400 hover:underline ml-auto">Timeline</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {viewMode === "table" && (
        <div className="bg-white rounded-3xl shadow-card border border-indigo-50 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-indigo-50/30 text-xs text-slate-400 uppercase">
              <tr>
                {visibleCols.includes("address") && <th className="px-4 py-3 text-left">Address</th>}
                {visibleCols.includes("type") && <th className="px-4 py-3 text-left">Type</th>}
                {visibleCols.includes("status") && <th className="px-4 py-3 text-left">Status</th>}
                {visibleCols.includes("rent") && <th className="px-4 py-3 text-right">Rent</th>}
                {visibleCols.includes("tenant") && <th className="px-4 py-3 text-left">Tenant</th>}
                {visibleCols.includes("lease_end") && <th className="px-4 py-3 text-left">Lease End</th>}
                {visibleCols.includes("owner_name") && <th className="px-4 py-3 text-left">Owner</th>}
                {visibleCols.includes("notes") && <th className="px-4 py-3 text-left">Notes</th>}
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => (
                <tr key={p.id} className="border-t border-indigo-50/50 hover:bg-indigo-50/30/50">
                  {visibleCols.includes("address") && <td className="px-4 py-2.5 font-medium text-slate-800">{p.address}</td>}
                  {visibleCols.includes("type") && <td className="px-4 py-2.5 text-slate-500">{p.type}</td>}
                  {visibleCols.includes("status") && <td className="px-4 py-2.5"><Badge status={p.status} label={p.status} /></td>}
                  {visibleCols.includes("rent") && <td className="px-4 py-2.5 text-right font-semibold">${safeNum(p.rent).toLocaleString()}</td>}
                  {visibleCols.includes("tenant") && <td className="px-4 py-2.5 text-slate-500">{p.tenant || "—"}</td>}
                  {visibleCols.includes("lease_end") && <td className="px-4 py-2.5 text-slate-400">{p.lease_end || "—"}</td>}
                  {visibleCols.includes("owner_name") && <td className="px-4 py-2.5 text-slate-500">{p.owner_name || "—"}</td>}
                  {visibleCols.includes("notes") && <td className="px-4 py-2.5 text-xs text-slate-400 max-w-32 truncate">{p.notes || "—"}</td>}
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    {p.pm_company_name && <span className="text-xs bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded mr-2">PM</span>}
                    {isReadOnly(p) && <span className="text-xs text-purple-500 mr-2">🔒 view only</span>}
                    {!isReadOnly(p) && <button onClick={() => { setEditingProperty(p); setForm({ address_line_1: p.address_line_1 || p.address || "", address_line_2: p.address_line_2 || "", city: p.city || "", state: p.state || "", zip: p.zip || "", type: p.type, status: p.status, rent: p.rent || "", security_deposit: p.security_deposit || "", tenant: p.tenant || "", tenant_email: p._tenantEmail || "", tenant_phone: p._tenantPhone || "", lease_start: p.lease_start || "", lease_end: p.lease_end || "", notes: p.notes || "" }); setShowForm(true); }} className="text-xs text-indigo-600 hover:underline mr-2">Edit</button>}
                    {!isReadOnly(p) && isAdmin && <button onClick={() => deleteProperty(p.id, p.address)} className="text-xs text-red-500 hover:underline mr-2">Archive</button>}
                    {!p.pm_company_id && !isReadOnly(p) && isAdmin && <button onClick={() => { setShowPmAssign(p); setPmCode(""); }} className="text-xs text-purple-600 hover:underline mr-2">PM</button>}
                    {p.pm_company_id && !isReadOnly(p) && isAdmin && <button onClick={() => removePM(p)} className="text-xs text-orange-600 hover:underline mr-2">-PM</button>}
                    <button onClick={() => loadTimeline(p)} className="text-xs text-slate-400 hover:underline">TL</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && <div className="text-center py-8 text-slate-400 text-sm">No properties found</div>}
        </div>
      )}

      {viewMode === "compact" && (
        <div className="bg-white rounded-3xl shadow-card border border-indigo-50 divide-y divide-indigo-50/50">
          {filtered.map(p => (
            <div key={p.id} className={`flex items-center gap-3 px-4 py-2.5 hover:bg-indigo-50/30/50 ${isReadOnly(p) ? "bg-purple-50/30" : ""}`}>
              <div className={`w-2 h-2 rounded-full ${p.status === "occupied" ? "bg-emerald-500" : p.status === "vacant" ? "bg-amber-500" : "bg-red-500"}`} />
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-slate-800">{p.address}</span>
                <span className="text-xs text-slate-400 ml-2">{p.type}</span>
                {p.pm_company_name && <span className="text-xs bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded ml-2">PM: {p.pm_company_name}</span>}
              </div>
              <span className="text-sm font-semibold text-slate-700">${safeNum(p.rent).toLocaleString()}</span>
              <span className="text-xs text-slate-400 w-28 truncate">{p.tenant || "—"}</span>
              <Badge status={p.status} label={p.status} />
              {!isReadOnly(p) && <button onClick={() => { setEditingProperty(p); setForm({ address_line_1: p.address_line_1 || p.address || "", address_line_2: p.address_line_2 || "", city: p.city || "", state: p.state || "", zip: p.zip || "", type: p.type, status: p.status, rent: p.rent || "", security_deposit: p.security_deposit || "", tenant: p.tenant || "", tenant_email: p._tenantEmail || "", tenant_phone: p._tenantPhone || "", lease_start: p.lease_start || "", lease_end: p.lease_end || "", notes: p.notes || "" }); setShowForm(true); }} className="text-xs text-indigo-600 hover:underline">Edit</button>}
              {isReadOnly(p) && <span className="text-xs text-purple-400">🔒</span>}
            </div>
          ))}
          {filtered.length === 0 && <div className="text-center py-8 text-slate-400 text-sm">No properties found</div>}
        </div>
      )}

      {/* PM Assignment Modal */}
      {showPmAssign && (
        <Modal title={`Assign Property Manager — ${showPmAssign.address}`} onClose={() => setShowPmAssign(null)}>
          <div className="space-y-4">
            <div className="bg-purple-50 rounded-xl p-3 text-sm">
              <div className="font-semibold text-purple-800 mb-1">What this does:</div>
              <div className="text-xs text-purple-600 space-y-1">
                <div>The PM company gets operational control (tenants, leases, maintenance, payments)</div>
                <div>You retain financial oversight and can view statements</div>
                <div>You can remove the PM at any time to regain full control</div>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500 block mb-1">PM Company's 8-Digit Code</label>
              <input value={pmCode} onChange={e => setPmCode(e.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="e.g. 12345678" maxLength={8} className="w-full border border-indigo-100 rounded-2xl px-3 py-2.5 text-sm font-mono tracking-wider" />
              <p className="text-xs text-slate-400 mt-1">Ask the property manager for their company code</p>
            </div>
            <button onClick={() => assignPM(showPmAssign)} className="w-full bg-purple-600 text-white text-sm py-2.5 rounded-lg hover:bg-purple-700 font-semibold">Assign Property Manager</button>
          </div>
        </Modal>
      )}

      {timelineProperty && (
        <Modal title={`Timeline: ${timelineProperty.address}`} onClose={() => setTimelineProperty(null)}>
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {timelineData.map((item, i) => (
              <div key={i} className="flex gap-3 items-start">
                <span className="text-lg">{item._type === "payment" ? "💰" : item._type === "work_order" ? "🔧" : "📄"}</span>
                <div>
                  <p className="text-sm font-medium text-slate-800">{item._type === "payment" ? `${formatCurrency(item.amount)} - ${item.type}` : item._type === "work_order" ? item.issue : item.name}</p>
                  <p className="text-xs text-slate-400">{new Date(item._date).toLocaleDateString()}</p>
                </div>
              </div>
            ))}
            {timelineData.length === 0 && <p className="text-sm text-slate-400 text-center py-4">No activity found.</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}

// ============ TENANTS ============
function Tenants({ addNotification, userProfile, userRole, companyId, setPage, initialTab }) {
  const [tenants, setTenants] = useState([]);
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingTenant, setEditingTenant] = useState(null);
  const [selectedTenant, setSelectedTenant] = useState(null);
  const [activePanel, setActivePanel] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [newCharge, setNewCharge] = useState({ description: "", amount: "", type: "charge" });
  const [form, setForm] = useState({ name: "", email: "", phone: "", property: "", lease_status: "active", lease_start: "", lease_end: "", rent: "" });
  const [tenantView, setTenantView] = useState("card");
  const [tenantSearch, setTenantSearch] = useState("");
  const [tenantFilter, setTenantFilter] = useState("all");
  const [tenantFilterProp, setTenantFilterProp] = useState("all");
  const [tenantFilterBalance, setTenantFilterBalance] = useState("all");
  const [tenantFilterLeaseExpiry, setTenantFilterLeaseExpiry] = useState("all");
  // Bulk selection
  const [selectedTenants, setSelectedTenants] = useState(new Set());
  const [bulkAction, setBulkAction] = useState(null);
  const [leaseModal, setLeaseModal] = useState(null);
  const [tenantDocs, setTenantDocs] = useState([]);
  const [tenantTab, setTenantTab] = useState(initialTab || "tenants");
  const [showTenantDocPrompt, setShowTenantDocPrompt] = useState(null); // 'renew' | 'notice'
  const [leaseInput, setLeaseInput] = useState("");
  // eslint-disable-next-line no-unused-vars
  const [error, setError] = useState("");

  useEffect(() => {
    fetchTenants();
    supabase.from("properties").select("*").eq("company_id", companyId)
      .then(({ data, error }) => { if (error) console.warn("Tenants property fetch:", error.message); setProperties(data || []); });
  }, [companyId]);

  async function fetchTenants() {
    const { data } = await supabase.from("tenants").select("*").eq("company_id", companyId).is("archived_at", null);
    setTenants(data || []);
    setLoading(false);
  }

  async function saveTenant() {
      if (!guardSubmit("saveTenant")) return;
      try {
    if (!form.name.trim()) { alert("Tenant name is required."); return; }
    if (!form.email.trim() || !form.email.includes("@") || !form.email.includes(".")) { alert("Please enter a valid email address."); return; }
    if (!form.property) { alert("Please select a property."); return; }
    if (form.rent && (isNaN(Number(form.rent)) || Number(form.rent) < 0)) { alert("Rent must be a valid positive number."); return; }
    // #27: Stale data check — verify record hasn't been modified by another user
    if (editingTenant) {
      const { data: freshTenant } = await supabase.from("tenants").select("updated_at").eq("id", editingTenant.id).eq("company_id", companyId).maybeSingle();
      if (freshTenant?.updated_at && editingTenant.updated_at && freshTenant.updated_at !== editingTenant.updated_at) {
        if (!window.confirm("This tenant was modified by another user since you started editing. Your changes may overwrite theirs. Continue?")) return;
      }
    }
    const { error } = editingTenant
      ? await supabase.from("tenants").update({ name: form.name, email: normalizeEmail(form.email), phone: form.phone, property: form.property, lease_status: form.lease_status, move_in: form.lease_start, move_out: form.lease_end, lease_end_date: form.lease_end, rent: form.rent }).eq("id", editingTenant.id).eq("company_id", companyId)
      : await supabase.from("tenants").insert([{ ...form, email: normalizeEmail(form.email), balance: 0, company_id: companyId }]);
    if (error) { alert("Error saving tenant: " + error.message); return; }
    if (editingTenant) {
      // Cascade name change to all related tables
      if (editingTenant.name !== form.name) {
        // Atomic cascade rename via server-side RPC
        // Atomic cascade rename — server-side RPC required
        const { error: tenantRenameErr } = await supabase.rpc("rename_tenant_cascade", {
          p_company_id: companyId, p_old_name: editingTenant.name, p_new_name: form.name
        });
        if (tenantRenameErr) {
          // #13: Client-side fallback — cascade rename to tables the RPC may not cover
          console.warn("Tenant rename RPC failed, running client-side fallback:", tenantRenameErr.message);
          const oldName = editingTenant.name;
          await Promise.all([
            supabase.from("payments").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName),
            supabase.from("leases").update({ tenant_name: form.name }).eq("company_id", companyId).eq("tenant_name", oldName),
            supabase.from("work_orders").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName),
            supabase.from("documents").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName),
            supabase.from("autopay_schedules").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName),
            supabase.from("ledger_entries").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName),
            supabase.from("messages").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName),
            supabase.from("eviction_cases").update({ tenant_name: form.name }).eq("company_id", companyId).eq("tenant_name", oldName),
            supabase.from("properties").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName),
          ]);
        }
      }
      addNotification("👤", `Tenant updated: ${form.name}`);
      logAudit("update", "tenants", `Updated tenant: ${form.name}`, editingTenant?.id, userProfile?.email, userRole, companyId);
    } else {
      addNotification("👤", `New tenant added: ${form.name}`);
      // Prompt for required documents
      // Show document requirements panel
      setShowTenantDocPrompt(form.name);
      logAudit("create", "tenants", `Added tenant: ${form.name} at ${form.property}`, "", userProfile?.email, userRole, companyId);
    }
    setShowForm(false);
    setEditingTenant(null);
    setForm({ name: "", email: "", phone: "", property: "", lease_status: "active", lease_start: "", lease_end: "", rent: "" });
    fetchTenants();
      } finally { guardRelease("saveTenant"); }
  }

  async function deleteTenant(id, name) {
      if (!guardSubmit("deleteTenant")) return;
      try {
    // Check for outstanding balance before allowing deletion
    const { data: tenantRow } = await supabase.from("tenants").select("balance").eq("id", id).eq("company_id", companyId).maybeSingle();
    if (tenantRow && safeNum(tenantRow.balance) > 0) {
      alert(`Cannot delete tenant "${name}" with an outstanding balance of $${safeNum(tenantRow.balance).toFixed(2)}. Please settle the balance first.`);
      return;
    }
    if (tenantRow && safeNum(tenantRow.balance) < 0) {
      if (!window.confirm(`Tenant "${name}" has a credit balance of $${Math.abs(safeNum(tenantRow.balance)).toFixed(2)}. Deleting will forfeit this credit. Continue?`)) return;
    }
    if (!window.confirm(`Archive tenant "${name}"?\n\nThis will hide the tenant and terminate their lease. You can restore from the Archive page within 180 days.`)) return;
    // Get tenant's property before archiving for cascade updates
    const { data: tenantDetail } = await supabase.from("tenants").select("property, balance").eq("id", id).eq("company_id", companyId).maybeSingle();
    const tenantProperty = tenantDetail?.property;
    // Soft-delete: archive instead of permanent deletion
    const { error: archiveErr } = await supabase.from("tenants").update({ 
      archived_at: new Date().toISOString(), 
      archived_by: userProfile?.email,
      lease_status: "inactive" 
    }).eq("id", id).eq("company_id", companyId);
    if (archiveErr) { alert("Failed to archive tenant: " + archiveErr.message); return; }
    // Update property to vacant when tenant archived
    if (tenantProperty) {
      const { error: propErr } = await supabase.from("properties").update({ status: "vacant", tenant: "", lease_end: null, lease_start: "" }).eq("company_id", companyId).eq("address", tenantProperty).eq("tenant", name);
      if (propErr) console.warn("Failed to update property to vacant:", propErr.message);
    }
    // Terminate active leases for this tenant
    const { error: leaseErr } = await supabase.from("leases").update({ status: "terminated", archived_at: new Date().toISOString() }).eq("company_id", companyId).eq("tenant_name", name).eq("status", "active");
    if (leaseErr) console.warn("Failed to terminate leases:", leaseErr.message);
    // Archive autopay for this tenant
    await supabase.from("autopay_schedules").update({ enabled: false }).eq("company_id", companyId).eq("tenant", name);
    addNotification("🗑️", `Tenant deleted: ${name}`);
    logAudit("delete", "tenants", `Deleted tenant: ${name} (property→vacant, lease terminated, autopay disabled)`, id, userProfile?.email, userRole, companyId);
    fetchTenants();
      } finally { guardRelease("deleteTenant"); }
  }

  async function inviteTenant(tenant) {
      if (!guardSubmit("inviteTenant")) return;
      try {
    if (!tenant.email) { alert("This tenant has no email address. Please add one first."); return; }
    if (!window.confirm("Send portal invite to " + tenant.email + "?\n\nThis will:\n1. Generate a unique invite code for this tenant\n2. Send a magic link to their email\n3. They can sign up using the invite code to access their portal")) return;
    try {
      // Generate unique invite code
      // Generate unique invite code with collision retry
      let code, codeInsertErr;
      for (let attempt = 0; attempt < 5; attempt++) {
        const codeArr = new Uint32Array(1); crypto.getRandomValues(codeArr);
        code = "TNT-" + String(10000000 + (codeArr[0] % 89999999));
        const { data: existing } = await supabase.from("tenant_invite_codes").select("id").eq("code", code).maybeSingle();
        if (!existing) break; // No collision — code is unique
        if (attempt === 4) { alert("Could not generate unique invite code. Please try again."); return; }
      }
      const { error: codeInsertError } = await supabase.from("tenant_invite_codes").insert([{
        code: code,
        company_id: companyId,
        property: tenant.property || "",
        tenant_id: tenant.id,
        tenant_name: tenant.name,
        tenant_email: tenant.email,
        created_by: userProfile?.email || "admin",
        used: false,
      }]);

      // Also send magic link — but only if invite code was created successfully
      if (codeInsertError) { alert("Failed to create invite code: " + codeInsertError.message); return; }
      const { error: authErr } = await supabase.auth.signInWithOtp({
        email: tenant.email,
        options: { data: { name: tenant.name, role: "tenant" } }
      });
      if (authErr) {
        // Auth failed — do NOT create membership records for a non-deliverable invite
        alert("Failed to send invitation email to " + tenant.email + ": " + authErr.message + "\n\nPlease verify the email address and try again. No access records were created.");
        return;
      }
      // Create membership as "invited" — this is a placeholder record only.
      // Status "invited" grants NO app access (checked in role resolution).
      // The record is upgraded to "active" only when the user completes signup.
      // Stale invites (>30 days, never accepted) can be cleaned up by admin.
      const { error: memErr } = await supabase.from("company_members").upsert([{
        company_id: companyId,
        user_email: (tenant.email || "").toLowerCase(),
        user_name: tenant.name,
        role: "tenant",
        status: "invited",
        invited_by: userProfile?.email || "admin",
      }], { onConflict: "company_id,user_email" });
      if (memErr) { alert("Error creating invite: " + memErr.message); return; }
      addNotification("✉️", "Invite code generated for " + tenant.email);
      logAudit("create", "tenants", "Invited tenant to portal: " + tenant.email, tenant.id, userProfile?.email, userRole, companyId);
      // Show masked code — full code sent via email only
      const maskedCode = code.slice(0, 2) + "****" + code.slice(-2);
      alert("Tenant invite created!\n\nA magic link and invite code have been sent to " + tenant.email + ".\n\nCode hint: " + maskedCode + " (full code in their email)\n\n" + tenant.name + " can sign up by selecting 'I'm a Tenant' and entering the code from their email.");
    } catch (e) {
      alert("Error inviting tenant: " + e.message);
    }
      } finally { guardRelease("inviteTenant"); }
  }

  function startEdit(t) {
    setEditingTenant(t);
    setForm({ name: t.name, email: t.email, phone: t.phone, property: t.property, lease_status: t.lease_status, lease_start: t.lease_start || t.move_in || "", lease_end: t.lease_end_date || t.move_out || "", rent: t.rent || "" });
    setShowForm(true);
  }

  async function fetchTenantDocs(tenant) {
    const { data } = await supabase.from("documents").select("*").eq("company_id", companyId).ilike("tenant", tenant.name).order("created_at", { ascending: false }).limit(50);
    setTenantDocs(data || []);
  }

  async function openLedger(tenant) {
    setSelectedTenant(tenant);
    setActivePanel("detail");
    fetchTenantDocs(tenant);
    const { data } = await supabase.from("ledger_entries").select("*").eq("company_id", companyId).eq("tenant", tenant.name).eq("property", tenant.property || "").order("date", { ascending: false }).limit(200);
    setLedger(data || []);
  }

  async function openMessages(tenant) {
    setSelectedTenant(tenant);
    setActivePanel("messages");
    const { data } = await supabase.from("messages").select("*").eq("company_id", companyId).eq("tenant", tenant.name).order("created_at", { ascending: true }).limit(100);
    setMessages(data || []);
    const { error: _err1494 } = await supabase.from("messages").update({ read: true }).eq("company_id", companyId).eq("tenant", tenant.name);
    if (_err1494) console.warn("messages write failed:", _err1494.message);
  }

  async function sendMessage() {
    if (!guardSubmit("sendMessage")) return;
    if (!newMessage.trim()) { guardRelease("sendMessage"); return; }
    const { error: _err_messages_1499 } = await supabase.from("messages").insert([{ company_id: companyId,
      tenant: selectedTenant.name,
      property: selectedTenant.property,
      sender: "admin",
      message: newMessage,
      read: false,
    }]);
    if (_err_messages_1499) console.warn("messages write failed:", _err_messages_1499.message);
    setNewMessage("");
    const { data } = await supabase.from("messages").select("*").eq("company_id", companyId).eq("tenant", selectedTenant.name).order("created_at", { ascending: true });
    setMessages(data || []);
  }

  async function addLedgerEntry() {
    if (!guardSubmit("addLedgerEntry")) return;
    try {
    if (!newCharge.description || !newCharge.amount) return;
    const amount = newCharge.type === "payment" || newCharge.type === "credit"
      ? -Math.abs(Number(newCharge.amount))
      : Math.abs(Number(newCharge.amount));
    const currentBalance = ledger.length > 0 ? ledger[0].balance : 0;
    const newBalance = currentBalance + amount;
    const ledgerOk = await safeLedgerInsert({ company_id: companyId,
      tenant: selectedTenant.name,
      property: selectedTenant.property,
      date: formatLocalDate(new Date()),
      description: newCharge.description,
      amount,
      type: newCharge.type,
      balance: 0,
    });
    if (!ledgerOk) { alert("Failed to create ledger entry. Please try again."); return; }
    // Atomic balance update (prevents drift from concurrent writes)
    try {
      const { error: balErr } = await supabase.rpc("update_tenant_balance", { p_tenant_id: selectedTenant.id, p_amount_change: amount });
      if (balErr) { alert("Balance update failed: " + balErr.message); }
    } catch (e) { alert("Balance update failed: " + e.message); }
    // Post accounting JE for manual charges/credits
    if (Math.abs(amount) > 0) {
      const classId = await getPropertyClassId(selectedTenant.property, companyId);
      if (newCharge.type === "charge") {
        const _jeOk = await autoPostJournalEntry({ companyId, date: formatLocalDate(new Date()), description: "Manual charge — " + selectedTenant.name + " — " + newCharge.description, reference: "MANUAL-" + shortId(), property: selectedTenant.property || "",
          lines: [
            { account_id: "1100", account_name: "Accounts Receivable", debit: Math.abs(amount), credit: 0, class_id: classId, memo: selectedTenant.name + ": " + newCharge.description },
            { account_id: "4100", account_name: "Other Income", debit: 0, credit: Math.abs(amount), class_id: classId, memo: newCharge.description },
          ]
        });
        if (!_jeOk) { alert("Accounting entry failed. The transaction was recorded but the journal entry could not be posted. Please check the accounting module."); }
        
      } else if (newCharge.type === "payment" || newCharge.type === "credit") {
        const _jeOk = await autoPostJournalEntry({ companyId, date: formatLocalDate(new Date()), description: "Manual " + newCharge.type + " — " + selectedTenant.name + " — " + newCharge.description, reference: "MANUAL-" + shortId(), property: selectedTenant.property || "",
          lines: [
            { account_id: "1000", account_name: "Checking Account", debit: Math.abs(amount), credit: 0, class_id: classId, memo: selectedTenant.name + ": " + newCharge.description },
            { account_id: "1100", account_name: "Accounts Receivable", debit: 0, credit: Math.abs(amount), class_id: classId, memo: newCharge.description },
          ]
        });
        if (!_jeOk) { alert("Accounting entry failed. The transaction was recorded but the journal entry could not be posted. Please check the accounting module."); }
        
      }
    }
    setSelectedTenant({ ...selectedTenant, balance: newBalance });
    setNewCharge({ description: "", amount: "", type: "charge" });
    openLedger(selectedTenant);
    fetchTenants();
    } finally { guardRelease("addLedgerEntry"); }
  }

  async function renewLease(newMoveOut) {
    if (!guardSubmit("renewLease")) return;
    if (!newMoveOut) { guardRelease("renewLease"); return; }
    const { error } = await supabase.from("tenants").update({ move_out: newMoveOut, lease_end_date: newMoveOut, lease_status: "active" }).eq("company_id", companyId).eq("id", selectedTenant.id);
    if (error) { setError("Failed to renew lease: " + error.message); return; }
    // #4: Update active lease end_date if one exists, or create one
    const { data: activeLease } = await supabase.from("leases").select("id, rent_amount").eq("company_id", companyId).eq("tenant_name", selectedTenant.name).eq("status", "active").limit(1);
    if (activeLease?.[0]) {
      await supabase.from("leases").update({ end_date: newMoveOut }).eq("company_id", companyId).eq("id", activeLease[0].id);
    } else if (selectedTenant.property && selectedTenant.rent) {
      // No active lease — create one (#19 fix: prevent lease-tenant mismatch)
      await supabase.from("leases").insert([{ company_id: companyId, tenant_name: selectedTenant.name, tenant_id: selectedTenant.id, property: selectedTenant.property, start_date: formatLocalDate(new Date()), end_date: newMoveOut, rent_amount: safeNum(selectedTenant.rent), status: "active", payment_due_day: 1 }]);
    }
    // Update property lease_end
    if (selectedTenant.property) {
      await supabase.from("properties").update({ lease_end: newMoveOut }).eq("company_id", companyId).eq("address", selectedTenant.property);
    }
    // #4: Sync autopay schedule end_date
    await supabase.from("autopay_schedules").update({ end_date: newMoveOut }).eq("company_id", companyId).eq("tenant", selectedTenant.name);
    addNotification("📄", `Lease extended for ${selectedTenant.name} until ${newMoveOut}`);
    logAudit("update", "tenants", `Lease renewed for ${selectedTenant.name} until ${newMoveOut}`, selectedTenant.id, userProfile?.email, userRole, companyId);
    setLeaseModal(null);
    fetchTenants();
    setSelectedTenant({ ...selectedTenant, move_out: newMoveOut, lease_status: "active" });
  }

  async function generateMoveOutNotice(days) {
    if (!days) return;
    const noticeDate = new Date();
    noticeDate.setDate(noticeDate.getDate() + parseInt(days));
    const moveOutDate = formatLocalDate(noticeDate);
    const { error } = await supabase.from("tenants").update({ lease_status: "notice", move_out: moveOutDate }).eq("company_id", companyId).eq("id", selectedTenant.id);
    if (error) { setError("Failed to generate notice: " + error.message); return; }
    // #8: Also update lease status to reflect notice
    await supabase.from("leases").update({ status: "notice" }).eq("company_id", companyId).eq("tenant_name", selectedTenant.name).eq("status", "active");
    addNotification("📋", `${days}-day move-out notice generated for ${selectedTenant.name}`);
    logAudit("update", "tenants", `${days}-day notice issued for ${selectedTenant.name}`, selectedTenant.id, userProfile?.email, userRole, companyId);
    setLeaseModal(null);
    fetchTenants();
  }

  function closePanel() {
    setActivePanel(null);
    setSelectedTenant(null);
    setLedger([]);
    setMessages([]);
  }

  function openLeaseForSigning(tenant) {
    // Open in new tab with signing canvas
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Lease Agreement — ${escapeHtml(tenant.name)}</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; color: #333; }
          h1 { text-align: center; color: #1e3a5f; border-bottom: 2px solid #1e3a5f; padding-bottom: 10px; }
          h2 { color: #1e3a5f; margin-top: 30px; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; }
          .field { background: #f8f9fa; border: 1px solid #dee2e6; padding: 8px 12px; margin: 5px 0; border-radius: 4px; }
          .clause { margin: 10px 0; font-size: 13px; line-height: 1.6; }
          .signature-section { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 30px; }
          canvas { border: 2px solid #333; border-radius: 4px; cursor: crosshair; background: white; }
          .btn { padding: 8px 20px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; }
          .btn-primary { background: #4f46e5; color: white; }
          .btn-clear { background: #e5e7eb; color: #374151; }
          .signed-badge { display:none; background: #4ade80; color: white; padding: 6px 16px; border-radius: 20px; font-weight: bold; }
          @media print { .no-print { display: none; } }
        </style>
      </head>
      <body>
        <h1>RESIDENTIAL LEASE AGREEMENT</h1>
        <p style="text-align:center;color:#666;">Generated on ${new Date().toLocaleDateString()}</p>
        <h2>Parties</h2>
        <div class="field"><strong>Tenant:</strong> ${escapeHtml(tenant.name)}</div>
        <div class="field"><strong>Email:</strong> ${escapeHtml(tenant.email)}</div>
        <div class="field"><strong>Property:</strong> ${escapeHtml(tenant.property)}</div>
        <h2>Lease Terms</h2>
        <div class="field"><strong>Monthly Rent:</strong> $${escapeHtml(String(tenant.rent))}/month</div>
        <div class="field"><strong>Move-In Date:</strong> ${escapeHtml(tenant.move_in || "—")}</div>
        <div class="field"><strong>Move-Out Date:</strong> ${escapeHtml(tenant.move_out || "—")}</div>
        <h2>Terms & Conditions</h2>
        <div class="clause">1. <strong>Rent Payment.</strong> Tenant agrees to pay $${escapeHtml(String(tenant.rent))} per month on the 1st of each month. A late fee will be applied after the grace period.</div>
        <div class="clause">2. <strong>Security Deposit.</strong> A security deposit equal to one month's rent is required prior to occupancy and will be returned within 30 days of move-out, less any deductions for damages.</div>
        <div class="clause">3. <strong>Property Use.</strong> The property shall be used solely as a private residence. No illegal activities are permitted on the premises.</div>
        <div class="clause">4. <strong>Maintenance.</strong> Tenant is responsible for minor maintenance. Landlord is responsible for major repairs.</div>
        <div class="clause">5. <strong>Entry.</strong> Landlord may enter the property with 24-hour notice for inspections, repairs, or showings.</div>
        <div class="clause">6. <strong>Termination.</strong> Either party may terminate this lease with 30 days written notice.</div>
        <div class="signature-section">
          <div>
            <h2>Landlord Signature</h2>
            <canvas id="landlord-canvas" width="320" height="100"></canvas>
            <div class="no-print" style="margin-top:8px;display:flex;gap:8px;">
              <button class="btn btn-clear" onclick="clearCanvas('landlord-canvas')">Clear</button>
            </div>
          </div>
          <div>
            <h2>Tenant Signature</h2>
            <canvas id="tenant-canvas" width="320" height="100"></canvas>
            <div class="no-print" style="margin-top:8px;display:flex;gap:8px;">
              <button class="btn btn-clear" onclick="clearCanvas('tenant-canvas')">Clear</button>
            </div>
          </div>
        </div>
        <div class="no-print" style="text-align:center;margin-top:30px;display:flex;gap:12px;justify-content:center;">
          <button class="btn btn-primary" onclick="saveAndPrint()">✓ Sign & Save as PDF</button>
          <button class="btn btn-clear" onclick="window.print()">🖨️ Print</button>
        </div>
        <div id="signed-badge" class="signed-badge" style="text-align:center;margin-top:20px;">✅ SIGNED — ${new Date().toLocaleDateString()}</div>
        <script>
          function makeDrawable(canvasId) {
            const canvas = document.getElementById(canvasId);
            const ctx = canvas.getContext('2d');
            let drawing = false;
            canvas.addEventListener('mousedown', e => { drawing = true; ctx.beginPath(); ctx.moveTo(e.offsetX, e.offsetY); });
            canvas.addEventListener('mousemove', e => { if (!drawing) return; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#1e3a5f'; ctx.lineTo(e.offsetX, e.offsetY); ctx.stroke(); });
            canvas.addEventListener('mouseup', () => drawing = false);
            canvas.addEventListener('mouseleave', () => drawing = false);
            // Touch support
            canvas.addEventListener('touchstart', e => { e.preventDefault(); drawing = true; const r = canvas.getBoundingClientRect(); ctx.beginPath(); ctx.moveTo(e.touches[0].clientX - r.left, e.touches[0].clientY - r.top); });
            canvas.addEventListener('touchmove', e => { e.preventDefault(); if (!drawing) return; const r = canvas.getBoundingClientRect(); ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#1e3a5f'; ctx.lineTo(e.touches[0].clientX - r.left, e.touches[0].clientY - r.top); ctx.stroke(); });
            canvas.addEventListener('touchend', () => drawing = false);
          }
          function clearCanvas(id) { const c = document.getElementById(id); c.getContext('2d').clearRect(0, 0, c.width, c.height); }
          function saveAndPrint() {
            document.getElementById('signed-badge').style.display = 'block';
            setTimeout(() => window.print(), 300);
          }
          makeDrawable('landlord-canvas');
          makeDrawable('tenant-canvas');
        </script>
      </body>
      </html>
    `;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const safeWin = window.open(url, "_blank", "noopener,noreferrer");
    if (safeWin) safeWin.onload = () => URL.revokeObjectURL(url);
  }

  if (loading) return <Spinner />;

  return (
    <div>
      {activePanel && selectedTenant && activePanel === "lease" && (
        <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex justify-end">
          <div className="bg-white w-full max-w-lg h-full flex flex-col shadow-2xl">
            <div className="px-5 py-4 border-b border-indigo-50 flex items-center justify-between bg-indigo-600 text-white">
              <div>
                <div className="font-bold">{selectedTenant.name}</div>
                <div className="text-xs text-indigo-200">{selectedTenant.property}</div>
              </div>
              <button onClick={closePanel} className="text-indigo-200 hover:text-white text-xl">✕</button>
            </div>
            <div className="flex border-b border-indigo-50">
              {[["ledger", "📒 Ledger"], ["messages", "💬 Messages"], ["lease", "📄 Lease"]].map(([id, label]) => (
                <button key={id} onClick={() => {
                  setActivePanel(id);
                  if (id === "ledger") openLedger(selectedTenant);
                  if (id === "messages") openMessages(selectedTenant);
                }} className={`flex-1 py-2.5 text-xs font-medium ${activePanel === id ? "border-b-2 border-indigo-600 text-indigo-700" : "text-slate-400 hover:text-slate-700"}`}>{label}</button>
              ))}
            </div>

            {/* LEDGER */}
            {activePanel === "ledger" && (
              <div className="flex-1 overflow-y-auto p-4">
                <div className={`rounded-3xl p-4 mb-4 text-center ${selectedTenant.balance > 0 ? "bg-red-50" : selectedTenant.balance < 0 ? "bg-green-50" : "bg-indigo-50/30"}`}>
                  <div className="text-xs text-slate-400 mb-1">Current Balance</div>
                  <div className={`text-3xl font-bold ${selectedTenant.balance > 0 ? "text-red-500" : selectedTenant.balance < 0 ? "text-green-600" : "text-slate-700"}`}>
                    {selectedTenant.balance > 0 ? `-${formatCurrency(selectedTenant.balance)}` : selectedTenant.balance < 0 ? `Credit ${formatCurrency(Math.abs(selectedTenant.balance))}` : "$0 Current"}
                  </div>
                </div>
                <div className="bg-indigo-50/30 rounded-xl p-3 mb-4">
                  <div className="text-xs font-semibold text-slate-500 mb-2">Add Transaction</div>
                  <div className="grid grid-cols-3 gap-2">
                    <select value={newCharge.type} onChange={e => setNewCharge({ ...newCharge, type: e.target.value })} className="border border-indigo-100 rounded-2xl px-2 py-2 text-xs">
                      <option value="charge">Charge</option>
                      <option value="payment">Payment</option>
                      <option value="credit">Credit</option>
                      <option value="late_fee">Late Fee</option>
                    </select>
                    <input placeholder="e.g. Rent, Late fee, Repair" value={newCharge.description} title="Description" onChange={e => setNewCharge({ ...newCharge, description: e.target.value })} className="border border-indigo-100 rounded-2xl px-2 py-2 text-xs" />
                    <input placeholder="0.00" value={newCharge.amount} title="Amount ($)" onChange={e => setNewCharge({ ...newCharge, amount: e.target.value })} className="border border-indigo-100 rounded-2xl px-2 py-2 text-xs" />
                  </div>
                  <button onClick={addLedgerEntry} className="mt-2 w-full bg-indigo-600 text-white text-xs py-2 rounded-2xl hover:bg-indigo-700">Add Transaction</button>
                </div>
                <div className="space-y-2">
                  {ledger.map(e => (
                    <div key={e.id} className="bg-white border border-indigo-50 rounded-lg px-3 py-2.5">
                      <div className="flex justify-between items-start">
                        <div>
                          <div className="text-sm font-medium text-slate-800">{e.description}</div>
                          <div className="text-xs text-slate-400">{e.date}</div>
                        </div>
                        <div className="text-right">
                          <div className={`text-sm font-bold ${e.amount > 0 ? "text-red-500" : "text-green-600"}`}>
                            {e.amount > 0 ? `+${formatCurrency(e.amount)}` : `-${formatCurrency(Math.abs(e.amount))}`}
                          </div>
                          <div className="text-xs text-slate-400">Bal: ${e.balance}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                  {ledger.length === 0 && <div className="text-center py-6 text-slate-400 text-sm">No ledger entries yet</div>}
                </div>
              </div>
            )}

            {/* MESSAGES */}
            {activePanel === "messages" && (
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {messages.map(m => (
                    <div key={m.id} className={`flex ${m.sender === "admin" ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-xs rounded-2xl px-4 py-2.5 ${m.sender === "admin" ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-800"}`}>
                        <div className="text-sm">{m.message}</div>
                        <div className={`text-xs mt-1 ${m.sender === "admin" ? "text-indigo-200" : "text-slate-400"}`}>
                          {m.sender === "admin" ? "You" : selectedTenant.name} · {new Date(m.created_at).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                  ))}
                  {messages.length === 0 && <div className="text-center py-6 text-slate-400 text-sm">No messages yet</div>}
                </div>
                <div className="p-4 border-t border-indigo-50 flex gap-2">
                  <input value={newMessage} onChange={e => setNewMessage(e.target.value)} onKeyDown={e => e.key === "Enter" && sendMessage()} placeholder="Type a message..." className="flex-1 border border-indigo-100 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-400" />
                  <button onClick={sendMessage} className="bg-indigo-600 text-white px-4 py-2.5 rounded-2xl hover:bg-indigo-700 text-sm font-medium">Send</button>
                </div>
              </div>
            )}

            {/* LEASE */}
            {activePanel === "lease" && (
              <div className="flex-1 overflow-y-auto p-4">
                <div className="bg-white border border-indigo-50 rounded-3xl p-4 mb-4">
                  <h4 className="font-semibold text-slate-700 mb-3">Lease Details</h4>
                  <div className="space-y-2 text-sm">
                    {[
                      ["Tenant", selectedTenant.name],
                      ["Property", selectedTenant.property],
                      ["Monthly Rent", selectedTenant.rent ? `${formatCurrency(selectedTenant.rent)}/mo` : "—"],
                      ["Move-In Date", selectedTenant.move_in || "—"],
                      ["Move-Out Date", selectedTenant.move_out || "—"],
                      ["Lease Status", selectedTenant.lease_status],
                    ].map(([l, v]) => (
                      <div key={l} className="flex justify-between py-1.5 border-b border-indigo-50/50">
                        <span className="text-slate-400">{l}</span>
                        <span className="font-medium text-slate-800 capitalize">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
                {leaseModal === "renew" && (
                  <div className="bg-indigo-50 rounded-3xl p-4 mb-3 border border-indigo-100">
                    <div className="text-sm font-semibold text-indigo-700 mb-2">Enter New Lease End Date</div>
                    <input type="date" value={leaseInput} onChange={e => setLeaseInput(e.target.value)} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mb-2" />
                    <div className="flex gap-2">
                      <button onClick={() => renewLease(leaseInput)} className="bg-indigo-600 text-white text-xs px-4 py-2 rounded-2xl hover:bg-indigo-700">Confirm Renewal</button>
                      <button onClick={() => setLeaseModal(null)} className="bg-slate-200 text-slate-500 text-xs px-4 py-2 rounded-lg">Cancel</button>
                    </div>
                  </div>
                )}
                {leaseModal === "notice" && (
                  <div className="bg-orange-50 rounded-3xl p-4 mb-3 border border-orange-100">
                    <div className="text-sm font-semibold text-orange-700 mb-2">Select Notice Period</div>
                    <div className="flex gap-2 mb-2">
                      <button onClick={() => setLeaseInput("30")} className={`flex-1 py-2 rounded-lg text-sm font-medium ${leaseInput === "30" ? "bg-orange-500 text-white" : "bg-white border border-orange-200 text-orange-700"}`}>30 Days</button>
                      <button onClick={() => setLeaseInput("60")} className={`flex-1 py-2 rounded-lg text-sm font-medium ${leaseInput === "60" ? "bg-orange-500 text-white" : "bg-white border border-orange-200 text-orange-700"}`}>60 Days</button>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => generateMoveOutNotice(leaseInput)} className="bg-orange-500 text-white text-xs px-4 py-2 rounded-lg hover:bg-orange-600">Generate Notice</button>
                      <button onClick={() => setLeaseModal(null)} className="bg-slate-200 text-slate-500 text-xs px-4 py-2 rounded-lg">Cancel</button>
                    </div>
                  </div>
                )}
                <div className="space-y-2">
                  <button onClick={() => openLeaseForSigning(selectedTenant)} className="w-full flex items-center justify-between bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-2xl px-4 py-3 text-left">
                    <div>
                      <div className="text-sm font-medium text-indigo-800">✍️ Generate & E-Sign Lease</div>
                      <div className="text-xs text-indigo-400">Opens PDF with signature canvas</div>
                    </div>
                    <span className="text-indigo-300">→</span>
                  </button>
                  {[
                    { label: "🔄 Renew Lease", desc: "Extend lease term", modal: "renew" },
                    { label: "📋 Generate Move-Out Notice", desc: "30/60 day notice", modal: "notice" },
                  ].map(item => (
                    <button key={item.label} onClick={() => { setLeaseModal(item.modal); setLeaseInput(""); }} className="w-full flex items-center justify-between bg-indigo-50/30 hover:bg-indigo-50 border border-indigo-50 hover:border-indigo-200 rounded-2xl px-4 py-3 text-left">
                      <div>
                        <div className="text-sm font-medium text-slate-800">{item.label}</div>
                        <div className="text-xs text-slate-400">{item.desc}</div>
                      </div>
                      <span className="text-slate-300">→</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== TENANT DETAIL VIEW ===== */}
      {selectedTenant && ["detail","ledger","documents","messages","actions"].includes(activePanel) && (
        <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex justify-end">
          <div className="bg-white w-full max-w-lg h-full flex flex-col shadow-2xl overflow-y-auto">
            {/* Header */}
            <div className="bg-gradient-to-r from-indigo-600 to-indigo-800 p-6 text-white">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 rounded-full bg-white/20 flex items-center justify-center text-2xl font-bold">{selectedTenant.name?.[0]}</div>
                  <div>
                    <h2 className="text-xl font-bold">{selectedTenant.name}</h2>
                    <div className="text-indigo-200 text-sm">{selectedTenant.property}</div>
                  </div>
                </div>
                <button onClick={() => { setSelectedTenant(null); setActivePanel(null); }} className="text-white/70 hover:text-white text-2xl">✕</button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
                <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs text-indigo-200">Rent</div><div className="text-lg font-bold">{selectedTenant.rent ? formatCurrency(selectedTenant.rent) : "—"}</div></div>
                <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs text-indigo-200">Balance</div><div className={"text-lg font-bold " + (selectedTenant.balance > 0 ? "text-red-300" : "text-green-300")}>{selectedTenant.balance > 0 ? formatCurrency(selectedTenant.balance) : "Current"}</div></div>
                <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs text-indigo-200">Status</div><div className="text-lg font-bold capitalize">{selectedTenant.lease_status}</div></div>
                <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs text-indigo-200">Lease End</div><div className="text-lg font-bold">{selectedTenant.lease_end_date || selectedTenant.move_out || "—"}</div></div>
              </div>
            </div>

            {/* Contact Info */}
            <div className="px-6 py-4 border-b border-indigo-50">
              <div className="space-y-2 text-sm">
                <div><span className="text-xs text-slate-400 block">Email</span><a href={"mailto:" + selectedTenant.email} className="text-indigo-600 hover:underline break-all">{selectedTenant.email || "—"}</a></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><span className="text-xs text-slate-400 block">Phone</span><a href={"tel:" + selectedTenant.phone} className="text-indigo-600 hover:underline">{selectedTenant.phone || "—"}</a></div>
                  <div><span className="text-xs text-slate-400 block">Lease Start</span><span className="text-slate-700">{selectedTenant.lease_start || selectedTenant.move_in || "—"}</span></div>
                </div>
              </div>
            </div>

            {/* Tab navigation */}
            <div className="flex border-b border-indigo-50 px-6 overflow-x-auto">
              {[["ledger","Ledger"],["documents","Documents"],["messages","Messages"],["actions","Actions"]].map(([id, label]) => (
                <button key={id} onClick={() => setActivePanel(id)} className={"px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap " + ((activePanel === id || (id === "ledger" && activePanel === "detail")) ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-400 hover:text-slate-500")}>{label}</button>
              ))}
            </div>

            {/* Tab content */}
            <div className="px-6 py-4 flex-1 overflow-y-auto">

              {/* Ledger tab (default) */}
              {(activePanel === "detail" || activePanel === "ledger") && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-slate-700">Transaction History</h3>
                    <div className="flex items-center gap-2">
                      <select value={newCharge.type} onChange={e => setNewCharge({...newCharge, type: e.target.value})} className="border border-indigo-100 rounded-2xl px-2 py-1.5 text-xs">
                        <option value="charge">Charge</option><option value="payment">Payment</option><option value="credit">Credit</option><option value="late_fee">Late Fee</option>
                      </select>
                      <input placeholder="Description" value={newCharge.description} onChange={e => setNewCharge({...newCharge, description: e.target.value})} className="border border-indigo-100 rounded-2xl px-2 py-1.5 text-xs w-32" />
                      <input placeholder="$0.00" value={newCharge.amount} onChange={e => setNewCharge({...newCharge, amount: e.target.value})} className="border border-indigo-100 rounded-2xl px-2 py-1.5 text-xs w-20" />
                      <button onClick={addLedgerEntry} className="bg-indigo-600 text-white text-xs px-3 py-1.5 rounded-lg">Add</button>
                    </div>
                  </div>
                  {ledger.length === 0 ? <div className="text-center py-6 text-slate-400 text-sm">No transactions yet</div> : (
                    <div className="space-y-1">
                      {ledger.slice(0, 20).map((e, i) => (
                        <div key={i} className="flex items-center justify-between py-2 border-b border-indigo-50/50 text-sm">
                          <div><div className="font-medium text-slate-700">{e.description}</div><div className="text-xs text-slate-400">{e.date}</div></div>
                          <div className={"font-semibold " + (e.type === "charge" || e.type === "late_fee" ? "text-red-500" : "text-green-600")}>{e.type === "charge" || e.type === "late_fee" ? "+" : "-"}{formatCurrency(Math.abs(e.amount))}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Documents tab */}
              {activePanel === "documents" && (
                <div>
                  <h3 className="text-sm font-semibold text-slate-700 mb-3">Tenant Documents</h3>
                  {/* Required docs checklist */}
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4">
                    <div className="text-xs font-bold text-amber-800 mb-2">Required Documents</div>
                    {["Signed Lease Agreement", "Government-Issued ID", "Renters Insurance", "Proof of Utility Transfer"].map(doc => {
                      const uploaded = tenantDocs.some(d => d.name?.toLowerCase().includes(doc.toLowerCase().split(" ")[0]));
                      return (
                        <div key={doc} className="flex items-center gap-2 py-1 text-sm">
                          <span className={uploaded ? "text-green-500" : "text-amber-400"}>{uploaded ? "✅" : "☐"}</span>
                          <span className={uploaded ? "text-slate-700" : "text-amber-700"}>{doc}</span>
                          {uploaded && <span className="text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded-full">Uploaded</span>}
                        </div>
                      );
                    })}
                  </div>
                  {/* Uploaded docs list */}
                  {tenantDocs.length === 0 ? <div className="text-center py-4 text-slate-400 text-sm">No documents uploaded for this tenant</div> : (
                    <div className="space-y-2">
                      {tenantDocs.map(d => (
                        <div key={d.id} className="flex items-center justify-between bg-indigo-50/30 rounded-lg px-3 py-2">
                          <div><div className="text-sm font-medium text-slate-700">{d.name}</div><div className="text-xs text-slate-400">{d.type} · {d.uploaded_at?.slice(0, 10)}</div></div>
                          <button onClick={async () => { const url = await getSignedUrl("documents", d.file_name || d.url); if (url) window.open(url, "_blank", "noopener,noreferrer"); }} className="text-xs text-indigo-600 hover:underline">View</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <button onClick={() => { setPage("documents"); setSelectedTenant(null); setActivePanel(null); }} className="mt-3 bg-indigo-600 text-white text-xs px-4 py-2 rounded-2xl hover:bg-indigo-700">Upload Documents</button>
                </div>
              )}

              {/* Messages tab */}
              {activePanel === "messages" && (
                <div>
                  <h3 className="text-sm font-semibold text-slate-700 mb-3">Messages</h3>
                  <div className="space-y-2 max-h-48 overflow-y-auto mb-3">
                    {messages.length === 0 ? <div className="text-center py-4 text-slate-400 text-sm">No messages</div> : messages.map((m, i) => (
                      <div key={i} className={"rounded-2xl px-3 py-2 text-sm max-w-xs " + (m.sender === selectedTenant.name ? "bg-slate-100 text-slate-700 mr-auto" : "bg-indigo-600 text-white ml-auto")}>
                        <div className="text-xs opacity-60 mb-0.5">{m.sender}</div>
                        {m.message}
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input value={newMessage} onChange={e => setNewMessage(e.target.value)} placeholder="Type a message..." className="flex-1 border border-indigo-100 rounded-2xl px-3 py-2 text-sm" onKeyDown={e => e.key === "Enter" && sendMessage()} />
                    <button onClick={sendMessage} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg">Send</button>
                  </div>
                </div>
              )}

              {/* Actions tab */}
              {activePanel === "actions" && (
                <div className="grid grid-cols-2 gap-3">
                  <button onClick={() => startEdit(selectedTenant)} className="bg-indigo-50/30 rounded-3xl p-4 text-center hover:bg-indigo-50/50 transition-all">
                    <div className="text-2xl mb-1">✏️</div><div className="text-sm font-semibold text-slate-700">Edit Tenant</div>
                  </button>
                  <button onClick={() => inviteTenant(selectedTenant)} className="bg-purple-50 rounded-3xl p-4 text-center hover:bg-purple-100 transition-all">
                    <div className="text-2xl mb-1">✉️</div><div className="text-sm font-semibold text-purple-700">Send Invite</div>
                  </button>
                  <button onClick={() => { setLeaseModal("renew"); setLeaseInput(""); }} className="bg-green-50 rounded-3xl p-4 text-center hover:bg-green-100 transition-all">
                    <div className="text-2xl mb-1">🔄</div><div className="text-sm font-semibold text-green-700">Renew Lease</div>
                  </button>
                  <button onClick={() => setPage("moveout")} className="bg-orange-50 rounded-3xl p-4 text-center hover:bg-orange-100 transition-all">
                    <div className="text-2xl mb-1"><span className="material-icons-outlined text-orange-600">exit_to_app</span></div><div className="text-sm font-semibold text-orange-700">Move-Out</div>
                  </button>
                  <button onClick={() => deleteTenant(selectedTenant.id, selectedTenant.name)} className="bg-red-50 rounded-3xl p-4 text-center hover:bg-red-100 transition-all">
                    <div className="text-2xl mb-1">📦</div><div className="text-sm font-semibold text-red-700">Archive Tenant</div>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tab Navigation */}
      <div className="flex items-center gap-4 mb-4 border-b border-indigo-50 pb-3">
        <h2 className="text-xl font-bold text-gray-800">Tenants</h2>
        <div className="flex gap-1 ml-2">
          {[["tenants", "Tenants"], ["leases", "Leases"], ["moveout", "Move-Out"], ["evictions", "Evictions"]].map(([id, label]) => (
            <button key={id} onClick={() => setTenantTab(id)} className={"px-3 py-1.5 text-xs font-medium rounded-lg " + (tenantTab === id ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200")}>{label}</button>
          ))}
        </div>
      </div>

      {tenantTab === "leases" && <LeaseManagement addNotification={addNotification} userProfile={userProfile} userRole={userRole} companyId={companyId} />}
      {tenantTab === "moveout" && <MoveOutWizard addNotification={addNotification} userProfile={userProfile} userRole={userRole} companyId={companyId} />}
      {tenantTab === "evictions" && <EvictionWorkflow addNotification={addNotification} userProfile={userProfile} userRole={userRole} companyId={companyId} />}

      {tenantTab === "tenants" && (<>
      {/* Recurring Rent Setup Modal */}
      {showRecurringSetup && (
        <Modal title="Set Up Recurring Rent" onClose={() => setShowRecurringSetup(null)}>
          <div className="space-y-4">
            <p className="text-sm text-gray-600">Would you like to set up automatic monthly rent posting for <strong>{showRecurringSetup.tenant}</strong> at <strong>{showRecurringSetup.property}</strong>?</p>
            <div className="bg-indigo-50 rounded-lg p-3">
              <div className="grid grid-cols-2 gap-3">
                <div><div className="text-xs text-gray-500">Monthly Rent</div><div className="font-bold text-gray-800">${safeNum(showRecurringSetup.rent).toLocaleString()}</div></div>
                <div><div className="text-xs text-gray-500">Posts On</div><div className="font-bold text-gray-800">1st of each month</div></div>
              </div>
            </div>
            <div className="bg-amber-50 rounded-lg p-3">
              <div className="text-xs font-semibold text-amber-700 mb-1">Late Fee Settings</div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs text-gray-500">Grace Period (days)</label><input type="number" defaultValue={5} id="rr-grace" className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm w-full mt-1" /></div>
                <div><label className="text-xs text-gray-500">Late Fee ($)</label><input type="number" defaultValue={50} id="rr-latefee" className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm w-full mt-1" /></div>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={async () => {
                const grace = Number(document.getElementById("rr-grace")?.value) || 5;
                const lateFee = Number(document.getElementById("rr-latefee")?.value) || 50;
                const { error } = await supabase.from("recurring_journal_entries").insert([{
                  company_id: companyId,
                  description: "Monthly rent — " + showRecurringSetup.tenant + " — " + showRecurringSetup.property,
                  frequency: "monthly",
                  day_of_month: 1,
                  amount: showRecurringSetup.rent,
                  tenant_name: showRecurringSetup.tenant,
                  tenant_id: showRecurringSetup.tenantId,
                  property: showRecurringSetup.property,
                  debit_account_id: "1200",
                  debit_account_name: "Accounts Receivable",
                  credit_account_id: "4000",
                  credit_account_name: "Rental Income",
                  status: "active",
                  late_fee_enabled: true,
                  grace_period_days: grace,
                  late_fee_amount: lateFee,
                  next_post_date: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString().split("T")[0],
                  created_by: userProfile?.email || "",
                }]);
                if (error) { alert("Failed to create recurring entry: " + userError(error.message)); }
                else { addNotification("🔄", "Recurring rent set up for " + showRecurringSetup.tenant); }
                setShowRecurringSetup(null);
              }} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700 flex-1">Yes, Set Up Recurring Rent</button>
              <button onClick={() => setShowRecurringSetup(null)} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg flex-1">Skip for Now</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Required Documents Prompt */}
      {showTenantDocPrompt && (
        <div className="bg-amber-50 border border-amber-200 rounded-3xl p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-bold text-amber-800">📋 Required Documents for {showTenantDocPrompt}</div>
            <button onClick={() => setShowTenantDocPrompt(null)} className="text-amber-400 hover:text-amber-600">✕</button>
          </div>
          <p className="text-xs text-amber-600 mb-3">Before this tenant can move in, the following documents must be uploaded. These are required for lease compliance.</p>
          <div className="space-y-2">
            {["Signed Lease Agreement", "Government-Issued ID", "Renters Insurance Certificate", "Proof of Utility Transfer"].map(doc => (
              <div key={doc} className="flex items-center gap-2 bg-white rounded-lg px-3 py-2 border border-amber-100">
                <span className="text-amber-400">☐</span>
                <span className="text-sm text-slate-700">{doc}</span>
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={() => { setPage("documents"); setShowTenantDocPrompt(null); }} className="bg-amber-600 text-white text-xs px-4 py-2 rounded-lg hover:bg-amber-700">Upload Documents Now</button>
            {isAdmin ? (
              <button onClick={() => setShowTenantDocPrompt(null)} className="bg-slate-100 text-slate-500 text-xs px-4 py-2 rounded-lg">Admin: Skip for Now</button>
            ) : (
              <button onClick={() => { if (window.confirm("Skipping requires admin approval. An approval request will be sent. Continue?")) { setShowTenantDocPrompt(null); addNotification("📋", "Document skip request sent for " + showTenantDocPrompt); } }} className="bg-slate-100 text-slate-500 text-xs px-4 py-2 rounded-lg">Request Exception</button>
            )}
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-manrope font-bold text-slate-800">Tenants</h2>
        <div className="flex gap-2 items-center">
          <div className="flex bg-indigo-50 rounded-2xl p-0.5">
            {[["card","\u25a6"],["table","\u2630"],["compact","\u2261"]].map(([m,icon]) => (
              <button key={m} onClick={() => setTenantView(m)} className={`px-3 py-1.5 text-sm rounded-md ${tenantView === m ? "bg-white shadow-sm text-indigo-700 font-semibold" : "text-slate-400"}`}>{icon}</button>
            ))}
          </div>
          <button onClick={() => { setEditingTenant(null); setForm({ name: "", email: "", phone: "", property: "", lease_status: "active", lease_start: "", lease_end: "", rent: "" }); setShowForm(!showForm); }} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-indigo-700 whitespace-nowrap">+ Add</button>
        </div>
      </div>
      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <input placeholder="Search name, email, phone, property..." value={tenantSearch || ""} onChange={e => setTenantSearch(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm flex-1 min-w-48" />
        <select value={tenantFilter || "all"} onChange={e => setTenantFilter(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
          <option value="all">All Status</option><option value="active">Active</option><option value="notice">Notice</option><option value="expired">Expired</option><option value="inactive">Inactive</option>
        </select>
        <select value={tenantFilterProp} onChange={e => setTenantFilterProp(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
          <option value="all">All Properties</option>
          {[...new Set(tenants.map(t => t.property).filter(Boolean))].sort().map(p => <option key={p} value={p}>{p.length > 30 ? p.slice(0, 30) + "..." : p}</option>)}
        </select>
        <select value={tenantFilterBalance} onChange={e => setTenantFilterBalance(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
          <option value="all">All Balances</option><option value="delinquent">Delinquent (owes)</option><option value="current">Current ($0)</option><option value="credit">Credit (overpaid)</option>
        </select>
        <select value={tenantFilterLeaseExpiry} onChange={e => setTenantFilterLeaseExpiry(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
          <option value="all">All Leases</option><option value="30">Expires in 30 days</option><option value="60">Expires in 60 days</option><option value="90">Expires in 90 days</option><option value="expired">Expired</option><option value="no_lease">No lease date</option>
        </select>
        {(tenantFilter !== "all" || tenantFilterProp !== "all" || tenantFilterBalance !== "all" || tenantFilterLeaseExpiry !== "all" || tenantSearch) && (
          <button onClick={() => { setTenantFilter("all"); setTenantFilterProp("all"); setTenantFilterBalance("all"); setTenantFilterLeaseExpiry("all"); setTenantSearch(""); }} className="text-xs text-red-500 border border-red-200 px-3 py-2 rounded-2xl hover:bg-red-50">Clear Filters</button>
        )}
      </div>
      {/* Bulk action bar */}
      {selectedTenants.size > 0 && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-2xl px-4 py-3 mb-4 flex items-center justify-between">
          <span className="text-sm font-medium text-indigo-800">{selectedTenants.size} tenant{selectedTenants.size > 1 ? "s" : ""} selected</span>
          <div className="flex gap-2">
            <button onClick={() => setBulkAction("notice")} className="text-xs bg-orange-100 text-orange-700 px-3 py-1.5 rounded-lg hover:bg-orange-200 font-medium">Send Notice</button>
            <button onClick={() => setBulkAction("charge")} className="text-xs bg-blue-100 text-blue-700 px-3 py-1.5 rounded-lg hover:bg-blue-200 font-medium">Add Charge</button>
            <button onClick={() => setBulkAction("status")} className="text-xs bg-purple-100 text-purple-700 px-3 py-1.5 rounded-lg hover:bg-purple-200 font-medium">Change Status</button>
            <button onClick={() => setBulkAction("archive")} className="text-xs bg-red-100 text-red-700 px-3 py-1.5 rounded-lg hover:bg-red-200 font-medium">Archive</button>
            <button onClick={() => setSelectedTenants(new Set())} className="text-xs text-slate-500 px-3 py-1.5 rounded-lg hover:bg-slate-100">Deselect All</button>
          </div>
        </div>
      )}
      {/* Bulk action modals */}
      {bulkAction === "notice" && (
        <Modal title={`Send Notice to ${selectedTenants.size} Tenant(s)`} onClose={() => setBulkAction(null)}>
          <div className="space-y-3">
            <p className="text-sm text-slate-500">This will set the selected tenants' status to "notice" and generate a move-out date.</p>
            <div><label className="text-xs font-medium text-slate-400 block mb-1">Notice Period (days)</label>
              <select id="bulk-notice-days" className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full">
                <option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option>
              </select>
            </div>
            <button onClick={async () => {
              const days = parseInt(document.getElementById("bulk-notice-days").value);
              const noticeDate = new Date(); noticeDate.setDate(noticeDate.getDate() + days);
              const moveOutDate = formatLocalDate(noticeDate);
              let count = 0;
              for (const tid of selectedTenants) {
                const { error } = await supabase.from("tenants").update({ lease_status: "notice", move_out: moveOutDate }).eq("company_id", companyId).eq("id", tid);
                if (!error) count++;
              }
              addNotification("📋", `${days}-day notice sent to ${count} tenant(s)`);
              logAudit("update", "tenants", `Bulk ${days}-day notice to ${count} tenants`, "", userProfile?.email, userRole, companyId);
              setBulkAction(null); setSelectedTenants(new Set()); fetchTenants();
            }} className="w-full bg-orange-600 text-white text-sm py-2.5 rounded-lg hover:bg-orange-700 font-semibold">Send Notices</button>
          </div>
        </Modal>
      )}
      {bulkAction === "charge" && (
        <Modal title={`Add Charge to ${selectedTenants.size} Tenant(s)`} onClose={() => setBulkAction(null)}>
          <div className="space-y-3">
            <div><label className="text-xs font-medium text-slate-400 block mb-1">Description</label><input id="bulk-charge-desc" placeholder="Late fee, utility charge, etc." className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 block mb-1">Amount ($)</label><input id="bulk-charge-amt" type="number" placeholder="50.00" className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <button onClick={async () => {
              const desc = document.getElementById("bulk-charge-desc").value;
              const amt = Math.abs(Number(document.getElementById("bulk-charge-amt").value));
              if (!desc || !amt) { alert("Description and amount required."); return; }
              let count = 0;
              for (const tid of selectedTenants) {
                const t = tenants.find(x => x.id === tid);
                if (!t) continue;
                const ledgerOk = await safeLedgerInsert({ company_id: companyId, tenant: t.name, property: t.property, date: formatLocalDate(new Date()), description: desc, amount: amt, type: "charge", balance: 0 });
                if (ledgerOk) {
                  await supabase.rpc("update_tenant_balance", { p_tenant_id: tid, p_amount_change: amt }).catch(() => {});
                  count++;
                }
              }
              addNotification("💰", `Charge of ${formatCurrency(amt)} added to ${count} tenant(s)`);
              logAudit("create", "tenants", `Bulk charge $${amt} "${desc}" to ${count} tenants`, "", userProfile?.email, userRole, companyId);
              setBulkAction(null); setSelectedTenants(new Set()); fetchTenants();
            }} className="w-full bg-blue-600 text-white text-sm py-2.5 rounded-lg hover:bg-blue-700 font-semibold">Add Charges</button>
          </div>
        </Modal>
      )}
      {bulkAction === "status" && (
        <Modal title={`Change Status — ${selectedTenants.size} Tenant(s)`} onClose={() => setBulkAction(null)}>
          <div className="space-y-3">
            <div><label className="text-xs font-medium text-slate-400 block mb-1">New Status</label>
              <select id="bulk-status-val" className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full">
                <option value="active">Active</option><option value="notice">Notice</option><option value="expired">Expired</option><option value="inactive">Inactive</option>
              </select>
            </div>
            <button onClick={async () => {
              const newStatus = document.getElementById("bulk-status-val").value;
              let count = 0;
              for (const tid of selectedTenants) {
                const { error } = await supabase.from("tenants").update({ lease_status: newStatus }).eq("company_id", companyId).eq("id", tid);
                if (!error) count++;
              }
              addNotification("👤", `Status changed to "${newStatus}" for ${count} tenant(s)`);
              logAudit("update", "tenants", `Bulk status change to ${newStatus} for ${count} tenants`, "", userProfile?.email, userRole, companyId);
              setBulkAction(null); setSelectedTenants(new Set()); fetchTenants();
            }} className="w-full bg-purple-600 text-white text-sm py-2.5 rounded-lg hover:bg-purple-700 font-semibold">Update Status</button>
          </div>
        </Modal>
      )}
      {bulkAction === "archive" && (
        <Modal title={`Archive ${selectedTenants.size} Tenant(s)?`} onClose={() => setBulkAction(null)}>
          <div className="space-y-3">
            <p className="text-sm text-red-600">This will archive the selected tenants. They can be restored from the Archive page within 180 days.</p>
            <div className="bg-red-50 rounded-lg p-3 text-xs text-red-700 space-y-1">
              {[...selectedTenants].map(tid => { const t = tenants.find(x => x.id === tid); return t ? <div key={tid}>{t.name} — {t.property}{safeNum(t.balance) > 0 ? ` (owes ${formatCurrency(t.balance)})` : ""}</div> : null; })}
            </div>
            <button onClick={async () => {
              let count = 0;
              for (const tid of selectedTenants) {
                const t = tenants.find(x => x.id === tid);
                if (safeNum(t?.balance) > 0) continue;
                const { error } = await supabase.from("tenants").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email, lease_status: "inactive" }).eq("id", tid).eq("company_id", companyId);
                if (!error) count++;
              }
              addNotification("📦", `${count} tenant(s) archived`);
              logAudit("archive", "tenants", `Bulk archived ${count} tenants`, "", userProfile?.email, userRole, companyId);
              setBulkAction(null); setSelectedTenants(new Set()); fetchTenants();
            }} className="w-full bg-red-600 text-white text-sm py-2.5 rounded-lg hover:bg-red-700 font-semibold">Confirm Archive</button>
          </div>
        </Modal>
      )}

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-slate-700 mb-3">{editingTenant ? "Edit Tenant" : "New Tenant"}</h3>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Full Name *</label><input placeholder="Jane Doe" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Email</label><input type="email" placeholder="tenant@email.com" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Phone</label><input type="tel" placeholder="(555) 123-4567" value={form.phone} onChange={e => setForm({ ...form, phone: formatPhoneInput(e.target.value) })} maxLength={14} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Property *</label><PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} companyId={companyId} /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Monthly Rent ($)</label><input placeholder="1500" value={form.rent} onChange={e => setForm({ ...form, rent: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Lease Status</label><select value={form.lease_status} onChange={e => setForm({ ...form, lease_status: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
              {["active", "notice", "expired"].map(s => <option key={s}>{s}</option>)}
            </select></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Move-in Date</label><input type="date" value={form.lease_start} onChange={e => setForm({ ...form, move_in: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Move-out Date</label><input type="date" value={form.lease_end} onChange={e => setForm({ ...form, move_out: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={saveTenant} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg">Save</button>
            <button onClick={() => { setShowForm(false); setEditingTenant(null); }} className="bg-slate-100 text-slate-500 text-sm px-4 py-2 rounded-lg">Cancel</button>
          </div>
        </div>
      )}

      {(() => {
        const ft = tenants.filter(t => {
          if (tenantFilter !== "all" && tenantFilter && t.lease_status !== tenantFilter) return false;
          if (tenantFilterProp !== "all" && t.property !== tenantFilterProp) return false;
          if (tenantFilterBalance === "delinquent" && !(safeNum(t.balance) > 0)) return false;
          if (tenantFilterBalance === "current" && safeNum(t.balance) > 0) return false;
          if (tenantFilterBalance === "credit" && !(safeNum(t.balance) < 0)) return false;
          if (tenantFilterLeaseExpiry !== "all") {
            const endDate = t.lease_end_date || t.move_out;
            if (!endDate) return tenantFilterLeaseExpiry === "no_lease" ? true : false;
            if (tenantFilterLeaseExpiry === "no_lease") return false;
            const daysLeft = Math.ceil((parseLocalDate(endDate) - new Date()) / 86400000);
            if (tenantFilterLeaseExpiry === "30" && daysLeft > 30) return false;
            if (tenantFilterLeaseExpiry === "60" && daysLeft > 60) return false;
            if (tenantFilterLeaseExpiry === "90" && daysLeft > 90) return false;
            if (tenantFilterLeaseExpiry === "expired" && daysLeft > 0) return false;
          }
          if (tenantSearch) {
            const q = tenantSearch.toLowerCase();
            if (!t.name?.toLowerCase().includes(q) && !t.email?.toLowerCase().includes(q) && !t.property?.toLowerCase().includes(q) && !t.phone?.toLowerCase().includes(q)) return false;
          }
          return true;
        });
        const TenantActions = ({t}) => (
          <div className="flex gap-1.5 flex-wrap">
            <button onClick={() => openLedger(t)} className="text-xs text-indigo-600 border border-indigo-200 px-2 py-1 rounded-lg hover:bg-indigo-50">Ledger</button>
            <button onClick={() => openMessages(t)} className="text-xs text-slate-500 border border-indigo-100 px-2 py-1 rounded-lg hover:bg-indigo-50/30">Msg</button>
            <button onClick={() => { setSelectedTenant(t); setActivePanel("lease"); }} className="text-xs text-slate-500 border border-indigo-100 px-2 py-1 rounded-lg hover:bg-indigo-50/30">Lease</button>
            <button onClick={() => startEdit(t)} className="text-xs text-blue-600 hover:underline">Edit</button>
            <button onClick={() => deleteTenant(t.id, t.name)} className="text-xs text-red-500 hover:underline">Archive</button>
            <button onClick={() => inviteTenant(t)} className="text-xs text-purple-600 hover:underline">Invite</button>
          </div>
        );
        return <>
          {tenantView === "card" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {ft.map(t => (
                <div key={t.id} onClick={() => { setSelectedTenant(t); setActivePanel("detail"); openLedger(t); }} className="bg-white rounded-3xl shadow-card border border-indigo-50 p-4 cursor-pointer hover:border-indigo-200 hover:shadow-md transition-all">
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-lg">{t.name?.[0]}</div>
                      <div><div className="font-semibold text-slate-800">{t.name}</div><div className="text-xs text-slate-400">{t.property}</div></div>
                    </div>
                    <Badge status={t.lease_status} />
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs mt-2">
                    <div><span className="text-slate-400">Email</span><div className="font-semibold text-slate-700 truncate">{t.email || "—"}</div></div>
                    <div><span className="text-slate-400">Balance</span><div className={`font-semibold ${t.balance > 0 ? "text-red-500" : "text-slate-700"}`}>{t.balance > 0 ? `-${formatCurrency(t.balance)}` : "Current"}</div></div>
                    <div><span className="text-slate-400">Rent</span><div className="font-semibold text-slate-700">{t.rent ? `${formatCurrency(t.rent)}/mo` : "\u2014"}</div></div>
                  </div>
                  <div className="mt-2 text-xs text-indigo-400 text-center">Click to view details →</div>
                </div>
              ))}
            </div>
          )}
          {tenantView === "table" && (
            <div className="bg-white rounded-3xl shadow-card border border-indigo-50 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-indigo-50/30 text-xs text-slate-400 uppercase">
                  <tr>
                    <th className="px-3 py-3 text-left w-8"><input type="checkbox" checked={ft.length > 0 && ft.every(t => selectedTenants.has(t.id))} onChange={e => { if (e.target.checked) setSelectedTenants(new Set(ft.map(t => t.id))); else setSelectedTenants(new Set()); }} className="rounded" /></th>
                    <th className="px-4 py-3 text-left">Name</th><th className="px-4 py-3 text-left">Property</th><th className="px-4 py-3 text-left">Email</th><th className="px-4 py-3 text-left">Status</th><th className="px-4 py-3 text-right">Rent</th><th className="px-4 py-3 text-right">Balance</th><th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {ft.map(t => (
                    <tr key={t.id} className={`border-t border-indigo-50/50 hover:bg-indigo-50/50 cursor-pointer ${selectedTenants.has(t.id) ? "bg-indigo-50/60" : ""}`}>
                      <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}><input type="checkbox" checked={selectedTenants.has(t.id)} onChange={e => { const next = new Set(selectedTenants); if (e.target.checked) next.add(t.id); else next.delete(t.id); setSelectedTenants(next); }} className="rounded" /></td>
                      <td className="px-4 py-2.5 font-medium text-indigo-600" onClick={() => { setSelectedTenant(t); setActivePanel("detail"); openLedger(t); }}>{t.name}</td>
                      <td className="px-4 py-2.5 text-slate-500">{t.property}</td>
                      <td className="px-4 py-2.5 text-slate-400 text-xs">{t.email}</td>
                      <td className="px-4 py-2.5"><Badge status={t.lease_status} /></td>
                      <td className="px-4 py-2.5 text-right font-semibold">{t.rent ? `${formatCurrency(t.rent)}` : "\u2014"}</td>
                      <td className={`px-4 py-2.5 text-right font-semibold ${t.balance > 0 ? "text-red-500" : "text-slate-700"}`}>{t.balance > 0 ? `-${formatCurrency(t.balance)}` : "Current"}</td>
                      <td className="px-4 py-2.5 text-right"><TenantActions t={t} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {tenantView === "compact" && (
            <div className="bg-white rounded-3xl shadow-card border border-indigo-50 divide-y divide-indigo-50/50">
              {ft.map(t => (
                <div key={t.id} onClick={() => { setSelectedTenant(t); setActivePanel("detail"); openLedger(t); }} className="flex items-center gap-3 px-4 py-2.5 hover:bg-indigo-50/50 cursor-pointer">
                  <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-xs">{t.name?.[0]}</div>
                  <div className="flex-1 min-w-0"><span className="text-sm font-medium text-slate-800">{t.name}</span><span className="text-xs text-slate-400 ml-2">{t.property}</span></div>
                  <span className="text-sm font-semibold text-slate-700">{t.rent ? `${formatCurrency(t.rent)}/mo` : "\u2014"}</span>
                  <span className={`text-xs font-semibold ${t.balance > 0 ? "text-red-500" : "text-slate-400"}`}>{t.balance > 0 ? `-${formatCurrency(t.balance)}` : "Current"}</span>
                  <Badge status={t.lease_status} />
                  <button onClick={() => openLedger(t)} className="text-xs text-indigo-600 hover:underline">Ledger</button>
                  <button onClick={() => startEdit(t)} className="text-xs text-blue-600 hover:underline">Edit</button>
                </div>
              ))}
            </div>
          )}
          {ft.length === 0 && <div className="text-center py-8 text-slate-400">No tenants found</div>}
        </>;
      })()}
    </>)}
    </div>
  );
}

// ============ PAYMENTS ============
function Payments({ addNotification, userProfile, userRole, companyId }) {
  const [payTab, setPayTab] = useState("payments");
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ tenant: "", property: "", amount: "", type: "rent", method: "ACH", status: "paid", date: formatLocalDate(new Date()) });
  const [paySearch, setPaySearch] = useState("");
  const [payFilterStatus, setPayFilterStatus] = useState("all");
  const [payFilterType, setPayFilterType] = useState("all");
  const [payFilterMethod, setPayFilterMethod] = useState("all");
  const [payDateFrom, setPayDateFrom] = useState("");
  const [payDateTo, setPayDateTo] = useState("");
  const [selectedPayments, setSelectedPayments] = useState(new Set());

  useEffect(() => { fetchPayments(); }, [companyId]);

  async function fetchPayments() {
    const { data } = await supabase.from("payments").select("*").eq("company_id", companyId).order("date", { ascending: false }).limit(500);
    setPayments(data || []);
    setLoading(false);
  }

  async function addPayment() {
    if (!guardSubmit("addPayment")) return;
    try {
    if (!form.tenant.trim()) { alert("Tenant name is required."); return; }
    if (!form.property.trim()) { alert("Property is required."); return; }
    if (!form.amount || isNaN(Number(form.amount)) || Number(form.amount) <= 0) { alert("Please enter a valid amount."); return; }
    if (!form.date) { alert("Payment date is required."); return; }
    if (!["rent","deposit","late_fee","other"].includes(form.type)) { form.type = "rent"; }
    // #18: Check if tenant is archived
    const { data: tenantCheck } = await supabase.from("tenants").select("id, archived_at").eq("company_id", companyId).ilike("name", form.tenant.trim()).maybeSingle();
    if (tenantCheck?.archived_at) {
      if (!window.confirm(`Warning: "${form.tenant}" is an archived tenant. Recording a payment for an archived tenant is unusual. Continue?`)) return;
    }
    // Duplicate detection: check for same tenant + amount + date in last 5 minutes
    const { data: recentDup } = await supabase.from("payments").select("id").eq("company_id", companyId).eq("tenant", form.tenant).eq("amount", Number(form.amount)).eq("date", form.date).limit(1);
    if (recentDup && recentDup.length > 0) {
      if (!window.confirm("A payment for $" + form.amount + " from " + form.tenant + " on " + form.date + " already exists. Record another?")) return;
    }
    const { error } = await supabase.from("payments").insert([{ ...form, amount: Number(form.amount), company_id: companyId }]);
    if (error) { alert("Error recording payment: " + error.message); return; }
    // Only auto-post to accounting if payment is actually paid (not unpaid/partial)
    if (form.status !== "paid") {
      addNotification("💳", `Payment recorded (${form.status}): ${formatCurrency(form.amount)} from ${form.tenant}`);
      logAudit("create", "payments", `Payment (${form.status}): ${formatCurrency(form.amount)} from ${form.tenant} at ${form.property}`, "", userProfile?.email, userRole, companyId);
      setShowForm(false);
      setForm({ tenant: "", property: "", amount: "", type: "rent", method: "ACH", status: "paid", date: formatLocalDate(new Date()) });
      fetchPayments();
      return;
    }
    // AUTO-POST TO ACCOUNTING: Smart posting - settle AR if accrual exists, else direct revenue
    const classId = await getPropertyClassId(form.property, companyId);
    const amt = Number(form.amount);
    const isLateFee = form.type === "late_fee";
    // Check if an accrual (AR) entry exists for this tenant/property this month
    const month = form.date.slice(0, 7);
    let hasAccrual = false;
    if (!isLateFee) {
      hasAccrual = await checkAccrualExists(companyId, month, form.tenant);
    } else {
      const { data: lateJEs } = await supabase.from("acct_journal_entries").select("id").eq("company_id", companyId).ilike("description", `%Late fee%${form.tenant}%`);
      if (lateJEs && lateJEs.length > 0) hasAccrual = true;
    }
    // Post GL entry FIRST — only update tenant balance if GL succeeds
    let jeId = null;
    if (hasAccrual) {
      jeId = await autoPostJournalEntry({
        companyId,
        date: form.date,
        description: `Payment received — ${form.tenant} — ${form.property} (settling AR)`,
        reference: `PAY-${shortId()}`,
        property: form.property,
        lines: [
          { account_id: "1000", account_name: "Checking Account", debit: amt, credit: 0, class_id: classId, memo: `${form.method} from ${form.tenant}` },
          { account_id: "1100", account_name: "Accounts Receivable", debit: 0, credit: amt, class_id: classId, memo: `AR settlement — ${form.tenant}` },
        ]
      });
    } else {
      const revenueAcct = isLateFee ? "4010" : "4000";
      const revenueAcctName = isLateFee ? "Late Fee Income" : "Rental Income";
      jeId = await autoPostJournalEntry({
        companyId,
        date: form.date,
        description: `${form.type === "rent" ? "Rent" : form.type} payment — ${form.tenant} — ${form.property}`,
        reference: `PAY-${shortId()}`,
        property: form.property,
        lines: [
          { account_id: "1000", account_name: "Checking Account", debit: amt, credit: 0, class_id: classId, memo: `${form.method} from ${form.tenant}` },
          { account_id: revenueAcct, account_name: revenueAcctName, debit: 0, credit: amt, class_id: classId, memo: `${form.tenant} — ${form.property}` },
        ]
      });
    }
    if (!jeId) {
      console.error("GL posting failed for payment — tenant balance NOT updated to prevent drift");
      alert("Payment was saved but the accounting entry failed to post. Tenant balance was NOT updated. Please check the Accounting module and post manually if needed.");
    }
    addNotification("💳", `Payment recorded: ${formatCurrency(form.amount)} from ${form.tenant}`);
    logAudit("create", "payments", `Payment: ${formatCurrency(form.amount)} from ${form.tenant} at ${form.property}`, "", userProfile?.email, userRole, companyId);

    // Update tenant balance and create ledger entry ONLY if GL posted successfully
    if (jeId) {
      const { data: tenantRow } = await supabase.from("tenants").select("id, balance, email").eq("name", form.tenant).eq("company_id", companyId).maybeSingle();
      if (tenantRow) {
        const payAmt = Number(form.amount);
        try {
          const { error: balErr } = await supabase.rpc("update_tenant_balance", { p_tenant_id: tenantRow.id, p_amount_change: -payAmt });
          if (balErr) alert("Balance update failed: " + balErr.message + ". Please verify the tenant balance.");
        } catch (e) { console.warn("Balance RPC error:", e.message); }
        await safeLedgerInsert({ company_id: companyId,
          tenant: form.tenant, property: form.property,
          date: form.date, description: `${form.type} payment (${form.method})`,
          amount: -payAmt, type: "payment", balance: safeNum(tenantRow.balance) - payAmt,
        });
        // Queue payment receipt notification to tenant
        if (tenantRow.email) {
          queueNotification("payment_received", tenantRow.email, { tenant: form.tenant, amount: payAmt, date: form.date, property: form.property, method: form.method }, companyId);
        }
      }
      // Auto-create owner distribution for rent payments
      if (form.type === "rent") {
        await autoOwnerDistribution(companyId, form.property, Number(form.amount), form.date, form.tenant);
      }
    }

    setShowForm(false);
    setForm({ tenant: "", property: "", amount: "", type: "rent", method: "ACH", status: "paid", date: formatLocalDate(new Date()) });
    fetchPayments();
    } finally { guardRelease("addPayment"); }
  }

  if (loading) return <Spinner />;

  const thisMonth = formatLocalDate(new Date()).slice(0, 7);
  const totalExpected = payments.filter(p => p.type === "rent" && p.date?.startsWith(thisMonth)).reduce((s, p) => s + safeNum(p.amount), 0);
  const totalCollected = payments.filter(p => p.status === "paid" && p.date?.startsWith(thisMonth)).reduce((s, p) => s + safeNum(p.amount), 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-2xl font-manrope font-bold text-slate-800">Payments & Rent</h2>
        <div className="flex gap-2">
          <button onClick={() => exportToCSV(payments, [
            { label: "Date", key: "date" }, { label: "Tenant", key: "tenant" }, { label: "Property", key: "property" },
            { label: "Amount", key: "amount" }, { label: "Type", key: "type" }, { label: "Method", key: "method" }, { label: "Status", key: "status" },
          ], "payments-export")} className="text-sm text-indigo-600 border border-indigo-200 px-3 py-2 rounded-2xl hover:bg-indigo-50 font-medium"><span className="material-icons-outlined text-sm align-middle mr-1">download</span>Export</button>
          <button onClick={() => setShowForm(!showForm)} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-indigo-700">+ Record Payment</button>
        </div>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-slate-700 mb-3">New Payment</h3>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Tenant *</label><input placeholder="Jane Doe" value={form.tenant} onChange={e => setForm({ ...form, tenant: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Property *</label><PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} companyId={companyId} /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Amount ($) *</label><input placeholder="1500.00" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Date</label><input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Method</label><select value={form.method} onChange={e => setForm({ ...form, method: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
              {["ACH", "card", "autopay", "cash", "check"].map(m => <option key={m}>{m}</option>)}
            </select></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Payment Type</label><select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
              {["rent", "late_fee", "deposit", "other"].map(t => <option key={t}>{t}</option>)}
            </select></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Status</label><select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
              {["paid", "unpaid", "partial"].map(s => <option key={s}>{s}</option>)}
            </select></div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={addPayment} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-indigo-700">Save</button>
            <button onClick={() => setShowForm(false)} className="bg-slate-100 text-slate-500 text-sm px-4 py-2 rounded-2xl hover:bg-slate-100">Cancel</button>
          </div>
        </div>
      )}

      {payTab === "autopay" && <Autopay addNotification={addNotification} userProfile={userProfile} userRole={userRole} companyId={companyId} />}
      {payTab === "payments" && (<>
      <div className="grid grid-cols-3 gap-3 mb-5">
        <StatCard label="Expected" value={`${formatCurrency(totalExpected)}`} color="text-slate-700" />
        <StatCard label="Collected" value={`${formatCurrency(totalCollected)}`} color="text-green-600" />
        <StatCard label="Outstanding" value={`$${(totalExpected - totalCollected).toLocaleString()}`} color="text-red-500" />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <input placeholder="Search tenant or property..." value={paySearch} onChange={e => setPaySearch(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm flex-1 min-w-40" />
        <select value={payFilterStatus} onChange={e => setPayFilterStatus(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
          <option value="all">All Status</option><option value="paid">Paid</option><option value="unpaid">Unpaid</option><option value="partial">Partial</option>
        </select>
        <select value={payFilterType} onChange={e => setPayFilterType(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
          <option value="all">All Types</option><option value="rent">Rent</option><option value="late_fee">Late Fee</option><option value="deposit">Deposit</option><option value="other">Other</option>
        </select>
        <select value={payFilterMethod} onChange={e => setPayFilterMethod(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
          <option value="all">All Methods</option><option value="ACH">ACH</option><option value="card">Card</option><option value="autopay">Autopay</option><option value="cash">Cash</option><option value="check">Check</option>
        </select>
        <input type="date" value={payDateFrom} onChange={e => setPayDateFrom(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm" title="From date" />
        <input type="date" value={payDateTo} onChange={e => setPayDateTo(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm" title="To date" />
        {(paySearch || payFilterStatus !== "all" || payFilterType !== "all" || payFilterMethod !== "all" || payDateFrom || payDateTo) && (
          <button onClick={() => { setPaySearch(""); setPayFilterStatus("all"); setPayFilterType("all"); setPayFilterMethod("all"); setPayDateFrom(""); setPayDateTo(""); }} className="text-xs text-red-500 border border-red-200 px-3 py-2 rounded-2xl hover:bg-red-50">Clear</button>
        )}
      </div>

      {/* Bulk bar */}
      {selectedPayments.size > 0 && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-2xl px-4 py-3 mb-4 flex items-center justify-between">
          <span className="text-sm font-medium text-indigo-800">{selectedPayments.size} payment{selectedPayments.size > 1 ? "s" : ""} selected</span>
          <div className="flex gap-2">
            <button onClick={() => {
              const selected = payments.filter(p => selectedPayments.has(p.id));
              exportToCSV(selected, [
                { label: "Date", key: "date" }, { label: "Tenant", key: "tenant" }, { label: "Property", key: "property" },
                { label: "Amount", key: "amount" }, { label: "Type", key: "type" }, { label: "Method", key: "method" }, { label: "Status", key: "status" },
              ], "selected-payments-export");
              setSelectedPayments(new Set());
            }} className="text-xs bg-green-100 text-green-700 px-3 py-1.5 rounded-lg hover:bg-green-200 font-medium">Export Selected</button>
            <button onClick={() => setSelectedPayments(new Set())} className="text-xs text-slate-500 px-3 py-1.5 rounded-lg hover:bg-slate-100">Deselect</button>
          </div>
        </div>
      )}

      {(() => {
        const fp = payments.filter(p => {
          if (payFilterStatus !== "all" && p.status !== payFilterStatus) return false;
          if (payFilterType !== "all" && p.type !== payFilterType) return false;
          if (payFilterMethod !== "all" && p.method !== payFilterMethod) return false;
          if (payDateFrom && p.date < payDateFrom) return false;
          if (payDateTo && p.date > payDateTo) return false;
          if (paySearch) {
            const q = paySearch.toLowerCase();
            if (!p.tenant?.toLowerCase().includes(q) && !p.property?.toLowerCase().includes(q)) return false;
          }
          return true;
        });
        return (
      <div className="bg-white rounded-3xl shadow-card border border-indigo-50 overflow-hidden">
        <div className="px-4 py-2 text-xs text-slate-400 border-b border-indigo-50">{fp.length} of {payments.length} payments</div>
        <table className="w-full text-sm">
          <thead className="bg-indigo-50/30 text-xs text-slate-400 uppercase">
            <tr>
              <th className="px-3 py-2 text-left w-8"><input type="checkbox" checked={fp.length > 0 && fp.every(p => selectedPayments.has(p.id))} onChange={e => { if (e.target.checked) setSelectedPayments(new Set(fp.map(p => p.id))); else setSelectedPayments(new Set()); }} className="rounded" /></th>
              {["Tenant", "Property", "Amount", "Date", "Type", "Method", "Status", ""].map(h => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {fp.map(p => (
              <tr key={p.id} className={`border-t border-indigo-50/50 hover:bg-indigo-50/30 ${selectedPayments.has(p.id) ? "bg-indigo-50/60" : ""}`}>
                <td className="px-3 py-2.5"><input type="checkbox" checked={selectedPayments.has(p.id)} onChange={e => { const next = new Set(selectedPayments); if (e.target.checked) next.add(p.id); else next.delete(p.id); setSelectedPayments(next); }} className="rounded" /></td>
                <td className="px-3 py-2.5 font-medium text-slate-800">{p.tenant}</td>
                <td className="px-3 py-2.5 text-slate-400">{p.property}</td>
                <td className="px-3 py-2.5 font-semibold">${p.amount}</td>
                <td className="px-3 py-2.5 text-slate-400">{p.date}</td>
                <td className="px-3 py-2.5 capitalize text-slate-500">{p.type?.replace("_", " ")}</td>
                <td className="px-3 py-2.5 text-slate-400">{p.method}</td>
                <td className="px-3 py-2.5"><Badge status={p.status} /></td>
                <td className="px-3 py-2.5">{p.status === "paid" && <button onClick={() => generatePaymentReceipt(p)} className="text-xs text-green-600 border border-green-200 px-2 py-0.5 rounded hover:bg-green-50">Receipt</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {fp.length === 0 && <div className="text-center py-8 text-slate-400 text-sm">No payments match filters</div>}
      </div>
        );
      })()}
    </>)}
    </div>
  );
}

// ============ MAINTENANCE ============
function Maintenance({ addNotification, userProfile, userRole, companyId }) {
  const [maintTab, setMaintTab] = useState("workorders");
  const [workOrders, setWorkOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [showForm, setShowForm] = useState(false);
  const [editingWO, setEditingWO] = useState(null);
  const [viewingPhotos, setViewingPhotos] = useState(null);
  const [woPhotos, setWoPhotos] = useState([]);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const photoRef = useRef();
  const [form, setForm] = useState({ property: "", tenant: "", issue: "", priority: "normal", status: "open", assigned: "", cost: 0, notes: "" });
  const [woSearch, setWoSearch] = useState("");
  const [woFilterProp, setWoFilterProp] = useState("all");
  const [woFilterAssigned, setWoFilterAssigned] = useState("all");

  useEffect(() => { fetchWorkOrders(); }, [companyId]);

  async function fetchWorkOrders() {
    const { data } = await supabase.from("work_orders").select("*").eq("company_id", companyId).is("archived_at", null).order("created_at", { ascending: false }).limit(500);
    setWorkOrders(data || []);
    setLoading(false);
  }

  async function saveWorkOrder() {
      if (!guardSubmit("saveWorkOrder")) return;
      try {
    if (!form.property.trim()) { alert("Property is required."); return; }
    if (!form.issue.trim()) { alert("Issue description is required."); return; }
    // #18: Check if property is archived
    if (!editingWO) {
      const { data: propCheck } = await supabase.from("properties").select("archived_at").eq("company_id", companyId).eq("address", form.property).maybeSingle();
      if (propCheck?.archived_at) { alert("Cannot create a work order for an archived property."); return; }
    }
    // #20: Warn when editing cost on a completed work order (GL already posted)
    if (editingWO && editingWO.status === "completed" && safeNum(form.cost) !== safeNum(editingWO.cost)) {
      if (!window.confirm(`This work order is completed and its cost was already posted to accounting ($${safeNum(editingWO.cost)}). Changing the cost to $${safeNum(form.cost)} will NOT update the GL entry.\n\nYou may need to void and re-post the journal entry manually. Continue?`)) return;
    }
    const payload = editingWO ? form : { ...form, created: formatLocalDate(new Date()) };
    const { error } = editingWO
      ? await supabase.from("work_orders").update({ property: payload.property, tenant: payload.tenant, issue: payload.issue, priority: payload.priority, status: payload.status, assigned: payload.assigned, cost: payload.cost, notes: payload.notes }).eq("id", editingWO.id).eq("company_id", companyId)
      : await supabase.from("work_orders").insert([{ ...payload, company_id: companyId }]);
    if (error) { alert("Error saving work order: " + error.message); return; }
    if (editingWO) {
      const costChanged = safeNum(form.cost) !== safeNum(editingWO.cost);
      addNotification("🔧", `Work order updated: ${form.issue}`);
      logAudit("update", "maintenance", `Updated work order: ${form.issue}${costChanged ? " (cost changed: $" + safeNum(editingWO.cost) + " → $" + safeNum(form.cost) + ")" : ""}`, editingWO?.id, userProfile?.email, userRole, companyId);
    } else {
      addNotification("🔧", `New work order: ${form.issue} at ${form.property}`);
      logAudit("create", "maintenance", `Work order: ${form.issue} at ${form.property}`, "", userProfile?.email, userRole, companyId);
      // #24: Queue notification for tenant about new work order
      if (form.tenant) {
        const { data: woTenant } = await supabase.from("tenants").select("email").eq("company_id", companyId).ilike("name", form.tenant).maybeSingle();
        if (woTenant?.email) queueNotification("work_order_created", woTenant.email, { tenant: form.tenant, issue: form.issue, property: form.property, priority: form.priority }, companyId);
      }
    }
    setShowForm(false);
    setEditingWO(null);
    setForm({ property: "", tenant: "", issue: "", priority: "normal", status: "open", assigned: "", cost: 0, notes: "" });
    fetchWorkOrders();
      } finally { guardRelease("saveWorkOrder"); }
  }

  async function updateStatus(wo, newStatus) {
    const { error } = await supabase.from("work_orders").update({ status: newStatus }).eq("company_id", companyId).eq("id", wo.id);
    if (error) { alert("Error updating status: " + error.message); return; }
    // AUTO-POST TO ACCOUNTING when completed with a cost (with duplicate guard)
    if (newStatus === "completed" && safeNum(wo.cost) > 0) {
      const { data: existingWoJE } = await supabase.from("acct_journal_entries").select("id").eq("company_id", companyId).eq("reference", "WO-" + wo.id).limit(1);
      if (existingWoJE && existingWoJE.length > 0) { addNotification("⚠️", "Accounting entry already exists for this work order"); fetchWorkOrders(); return; }
      const classId = await getPropertyClassId(wo.property, companyId);
      const amt = safeNum(wo.cost);
      const _jeOk = await autoPostJournalEntry({
        companyId,
        date: formatLocalDate(new Date()),
        description: `Maintenance: ${wo.issue} — ${wo.property}`,
        reference: `WO-${wo.id}`,
        property: wo.property,
        lines: [
          { account_id: "5300", account_name: "Repairs & Maintenance", debit: amt, credit: 0, class_id: classId, memo: `${wo.issue} — ${wo.assigned || "unassigned"}` },
          { account_id: "1000", account_name: "Checking Account", debit: 0, credit: amt, class_id: classId, memo: `Paid for: ${wo.issue}` },
        ]
      });
      if (!_jeOk) { alert("Accounting entry failed. The record was saved but the journal entry could not be posted. Please check the accounting module."); }
      
    }
    addNotification("🔧", `Work order "${wo.issue}" marked as ${newStatus.replace("_", " ")}`);
    logAudit("update", "maintenance", `Work order status: ${wo.issue} → ${newStatus}${safeNum(wo.cost) > 0 ? " ($" + safeNum(wo.cost) + ")" : ""}`, wo.id, userProfile?.email, userRole, companyId);
    // #24: Notify tenant when work order completed
    if (newStatus === "completed" && wo.tenant) {
      const { data: woT } = await supabase.from("tenants").select("email").eq("company_id", companyId).ilike("name", wo.tenant).maybeSingle();
      if (woT?.email) queueNotification("work_order_completed", woT.email, { tenant: wo.tenant, issue: wo.issue, property: wo.property }, companyId);
    }
    fetchWorkOrders();
  }

  function startEdit(w) {
    setEditingWO(w);
    setForm({ property: w.property, tenant: w.tenant, issue: w.issue, priority: w.priority, status: w.status, assigned: w.assigned || "", cost: w.cost || 0, notes: w.notes || "" });
    setShowForm(true);
  }

  async function openPhotos(wo) {
    setViewingPhotos(wo);
    const { data } = await supabase.from("work_order_photos").select("*").eq("work_order_id", wo.id).order("created_at", { ascending: false });
    // Resolve signed URLs for photos (handles both old public URLs and new file paths)
    const photos = await Promise.all((data || []).map(async (p) => {
      if (p.url && p.url.startsWith("http")) return p; // Old public URL — still works
      const bucket = p.storage_bucket || "maintenance-photos";
      const signedUrl = await getSignedUrl(bucket, p.url);
      return { ...p, url: signedUrl || p.url };
    }));
    setWoPhotos(photos);
  }

  async function uploadPhoto() {
      if (!guardSubmit("uploadPhoto")) return;
      try {
    const file = photoRef.current?.files?.[0];
    if (!file || !viewingPhotos) return;
    setUploadingPhoto(true);
    const fileName = `wo_${viewingPhotos.id}_${shortId()}_${sanitizeFileName(file.name)}`;
    const { error: uploadError } = await supabase.storage.from("maintenance-photos").upload(fileName, file);
    if (uploadError) { alert("Upload failed: " + uploadError.message); setUploadingPhoto(false); return; }
    // Store file path (not public URL) — signed URLs generated on display
    const storagePath = fileName;
    const { error: _photoErr } = await supabase.from("work_order_photos").insert([{ work_order_id: viewingPhotos.id, property: viewingPhotos.property, url: storagePath, caption: file.name, company_id: companyId, storage_bucket: "maintenance-photos" }]);
    if (_photoErr) { alert("Error saving photo: " + _photoErr.message); setUploadingPhoto(false); return; }
    addNotification("📸", `Photo uploaded for: ${viewingPhotos.issue}`);
    setUploadingPhoto(false);
    if (photoRef.current) photoRef.current.value = "";
    openPhotos(viewingPhotos);
      } finally { guardRelease("uploadPhoto"); }
  }

  async function deletePhoto(id) {
      if (!guardSubmit("deletePhoto")) return;
      try {
    // Photos DO have company_id — delete is scoped to current company
    const { error: _photoDelErr } = await supabase.from("work_order_photos").delete().eq("company_id", companyId).eq("id", id);
    if (_photoDelErr) { alert("Error deleting photo: " + _photoDelErr.message); return; }
    openPhotos(viewingPhotos);
      } finally { guardRelease("deletePhoto"); }
  }

  if (loading) return <Spinner />;

  const filtered = workOrders.filter(w => {
    if (filter !== "all" && w.status !== filter && w.priority !== filter) return false;
    if (woFilterProp !== "all" && w.property !== woFilterProp) return false;
    if (woFilterAssigned !== "all") {
      if (woFilterAssigned === "_unassigned" && w.assigned) return false;
      if (woFilterAssigned !== "_unassigned" && w.assigned !== woFilterAssigned) return false;
    }
    if (woSearch) {
      const q = woSearch.toLowerCase();
      if (!w.issue?.toLowerCase().includes(q) && !w.property?.toLowerCase().includes(q) && !w.tenant?.toLowerCase().includes(q) && !w.assigned?.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <div>
      {viewingPhotos && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-indigo-50 sticky top-0 bg-white">
              <div><h3 className="font-bold text-slate-800">📸 Photos — {viewingPhotos.issue}</h3><p className="text-xs text-slate-400">{viewingPhotos.property}</p></div>
              <button onClick={() => setViewingPhotos(null)} className="text-slate-400 hover:text-slate-500 text-xl">✕</button>
            </div>
            <div className="p-6">
              <div className="bg-indigo-50/30 rounded-3xl p-4 mb-4">
                <div className="text-xs font-semibold text-slate-500 mb-2">Upload New Photo</div>
                <div className="flex gap-2">
                  <input type="file" accept="image/*" ref={photoRef} className="flex-1 border border-indigo-100 rounded-2xl px-3 py-2 text-sm" />
                  <button onClick={uploadPhoto} disabled={uploadingPhoto} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-indigo-700 disabled:opacity-50">{uploadingPhoto ? "Uploading..." : "Upload"}</button>
                </div>
              </div>
              {woPhotos.length === 0 ? (
                <div className="text-center py-8 text-slate-400">No photos yet.</div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {woPhotos.map(p => (
                    <div key={p.id} className="relative group rounded-3xl overflow-hidden border border-indigo-50">
                      <img src={p.url} alt={p.caption} className="w-full h-40 object-cover" />
                      <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-40 transition-all flex items-center justify-center">
                        <button onClick={() => deletePhoto(p.id)} className="opacity-0 group-hover:opacity-100 bg-red-500 text-white text-xs px-3 py-1.5 rounded-lg">Delete</button>
                      </div>
                      <div className="p-2 text-xs text-slate-400 truncate">{p.caption}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-2xl font-manrope font-bold text-slate-800">Maintenance</h2>
        <div className="flex gap-1">
          {[["workorders", "Work Orders"], ["inspections", "Inspections"], ["vendors", "Vendors"]].map(([id, label]) => (
            <button key={id} onClick={() => setMaintTab(id)} className={"px-3 py-1.5 text-xs font-medium rounded-lg " + (maintTab === id ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200")}>{label}</button>
          ))}
        </div>
      </div>

      {maintTab === "inspections" && <Inspections addNotification={addNotification} userProfile={userProfile} userRole={userRole} companyId={companyId} />}
      {maintTab === "vendors" && <VendorManagement addNotification={addNotification} userProfile={userProfile} userRole={userRole} companyId={companyId} />}
      {maintTab === "workorders" && (<>
      <div className="flex items-center justify-between mb-4">
        <div></div>
        <button onClick={() => { setEditingWO(null); setForm({ property: "", tenant: "", issue: "", priority: "normal", status: "open", assigned: "", cost: 0, notes: "" }); setShowForm(!showForm); }} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-indigo-700">+ New Work Order</button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-slate-700 mb-3">{editingWO ? "Edit Work Order" : "New Work Order"}</h3>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Property *</label><PropertySelect value={form.property} onChange={(v) => {
              const prop = properties.find(p => p.address === v || buildAddress(p) === v);
              const tenant = prop?.tenant || "";
              setForm({ ...form, property: v, tenant: tenant });
            }} companyId={companyId} /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Tenant</label><input placeholder={form.property && !form.tenant ? "Vacant — no tenant" : "Tenant name"} value={form.tenant} onChange={e => setForm({ ...form, tenant: e.target.value })} className={"border rounded-lg px-3 py-2 text-sm w-full " + (!form.tenant && form.property ? "border-gray-100 bg-indigo-50/30 text-slate-400" : "border-indigo-100")} readOnly={!!(form.property && !form.tenant)} /></div>
            <div className="col-span-2"><label className="text-xs font-medium text-slate-400 mb-1 block">Issue *</label><input placeholder="Describe the maintenance issue" value={form.issue} onChange={e => setForm({ ...form, issue: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Priority</label><select value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
              {["normal", "emergency", "low"].map(p => <option key={p}>{p}</option>)}
            </select></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Status</label><select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full">
              {["open", "in_progress", "completed"].map(s => <option key={s}>{s}</option>)}
            </select></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Assigned To</label><input placeholder="Vendor or staff name" value={form.assigned} onChange={e => setForm({ ...form, assigned: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Cost ($)</label><input placeholder="0.00" type="number" value={form.cost} onChange={e => setForm({ ...form, cost: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div className="col-span-2"><label className="text-xs font-medium text-slate-400 mb-1 block">Notes</label><textarea placeholder="Completion details, parts used, etc." value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" rows={2} /></div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={saveWorkOrder} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-indigo-700">Save</button>
            <button onClick={() => { setShowForm(false); setEditingWO(null); }} className="bg-slate-100 text-slate-500 text-sm px-4 py-2 rounded-2xl hover:bg-slate-100">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4">
        {["all", "open", "in_progress", "completed", "emergency"].map(s => (
          <button key={s} onClick={() => setFilter(s)} className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize ${filter === s ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}>{s.replace("_", " ")}</button>
        ))}
        <div className="flex-1" />
        <input placeholder="Search issue, property, tenant..." value={woSearch} onChange={e => setWoSearch(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-1.5 text-sm min-w-40" />
        <select value={woFilterProp} onChange={e => setWoFilterProp(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-1.5 text-sm">
          <option value="all">All Properties</option>
          {[...new Set(workOrders.map(w => w.property).filter(Boolean))].sort().map(p => <option key={p} value={p}>{p.length > 30 ? p.slice(0, 30) + "..." : p}</option>)}
        </select>
        <select value={woFilterAssigned} onChange={e => setWoFilterAssigned(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-1.5 text-sm">
          <option value="all">All Assigned</option><option value="_unassigned">Unassigned</option>
          {[...new Set(workOrders.map(w => w.assigned).filter(Boolean))].sort().map(a => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      <div className="text-xs text-slate-400 mb-3">{filtered.length} of {workOrders.length} work orders</div>
      <div className="space-y-3">
        {filtered.map(w => (
          <div key={w.id} className="bg-white rounded-3xl shadow-card border border-indigo-50 p-4">
            <div className="flex justify-between items-start">
              <div>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${priorityColors[w.priority]}`}>{w.priority}</span>
                  <span className="font-semibold text-slate-800">{w.issue}</span>
                </div>
                <div className="text-xs text-slate-400 mt-1">{w.property} · {w.tenant}{!w.assigned && w.tenant && <span className="ml-1 text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">Tenant Request</span>}</div>
              </div>
              <Badge status={w.status} label={w.status?.replace("_", " ")} />
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <div><span className="text-slate-400">Assigned</span><div className="font-semibold text-slate-700">{w.assigned || "Unassigned"}</div></div>
              <div><span className="text-slate-400">Created</span><div className="font-semibold text-slate-700">{w.created_at ? new Date(w.created_at).toLocaleDateString() : w.created || "—"}</div></div>
              <div><span className="text-slate-400">Cost</span><div className="font-semibold text-slate-700">{w.cost ? `${formatCurrency(w.cost)}` : "—"}</div></div>
            </div>
            {w.notes && <div className="mt-2 text-xs text-slate-400 italic">{w.notes}</div>}
            <div className="mt-3 flex gap-2 flex-wrap">
              {w.status === "open" && <button onClick={() => updateStatus(w, "in_progress")} className="text-xs text-purple-600 border border-purple-200 px-3 py-1 rounded-lg hover:bg-purple-50">▶ In Progress</button>}
              {w.status === "in_progress" && <button onClick={() => updateStatus(w, "completed")} className="text-xs text-green-600 border border-green-200 px-3 py-1 rounded-lg hover:bg-green-50">✓ Complete</button>}
              {w.status === "completed" && <button onClick={() => updateStatus(w, "open")} className="text-xs text-slate-400 border border-indigo-100 px-3 py-1 rounded-lg hover:bg-indigo-50/30">↩ Reopen</button>}
              <button onClick={() => openPhotos(w)} className="text-xs text-purple-600 border border-purple-200 px-3 py-1 rounded-lg hover:bg-purple-50">📸 Photos</button>
              <button onClick={() => startEdit(w)} className="text-xs text-blue-600 border border-blue-200 px-3 py-1 rounded-lg hover:bg-blue-50">✏️ Edit</button>
            </div>
          </div>
        ))}
      </div>
    </>)}
    </div>
  );
}

// ============ UTILITIES ============
function Utilities({ addNotification, userProfile, userRole, companyId }) {
  const [utilities, setUtilities] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [showAudit, setShowAudit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ property: "", provider: "", amount: "", due: "", responsibility: "owner", status: "pending" });
  const [utilView, setUtilView] = useState("card");
  const [utilSearch, setUtilSearch] = useState("");
  const [utilFilterStatus, setUtilFilterStatus] = useState("all");
  const [utilFilterProp, setUtilFilterProp] = useState("all");
  
  // === Utility Automation ===
  const [utilTab, setUtilTab] = useState("bills"); // bills / automation / jobs
  const [utilAccounts, setUtilAccounts] = useState([]);
  const [autoBills, setAutoBills] = useState([]);
  const [autoJobs, setAutoJobs] = useState([]);
  const [providers, setProviders] = useState([]);
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null);
  const [accountForm, setAccountForm] = useState({ property: "", provider: "", account_number: "", username: "", password: "", account_type: "electric", check_frequency: "weekly", two_factor_method: "none", notes: "" });
  const [show2FAPrompt, setShow2FAPrompt] = useState(null); // job awaiting 2FA
  const [twoFACode, setTwoFACode] = useState("");
  const [billViewModal, setBillViewModal] = useState(null); // bill being reviewed
  const [paymentMethodModal, setPaymentMethodModal] = useState(null); // bill for payment auth

  useEffect(() => { fetchUtilities(); fetchAutomationData(); }, [companyId]);

  async function fetchAutomationData() {
    const [accts, bills, jobs, provs] = await Promise.all([
      supabase.from("utility_accounts").select("*").eq("company_id", companyId).is("archived_at", null).order("property"),
      supabase.from("utility_bills").select("*").eq("company_id", companyId).is("archived_at", null).order("created_at", { ascending: false }).limit(100),
      supabase.from("automation_jobs").select("*").eq("company_id", companyId).order("created_at", { ascending: false }).limit(50),
      supabase.from("utility_providers").select("*").eq("is_active", true).order("display_name"),
    ]);
    setUtilAccounts(accts.data || []);
    setAutoBills(bills.data || []);
    setAutoJobs(jobs.data || []);
    setProviders(provs.data || []);
  }

  async function saveAccount() {
    if (!accountForm.property || !accountForm.provider || !accountForm.username || !accountForm.password) {
      alert("Property, provider, username, and password are required."); return;
    }
    // Encrypt credentials client-side before sending
    // In production, this should be done server-side via Edge Function
    // For now, we use a simple encoding (NOT production-grade encryption)
    const iv = Array.from(crypto.getRandomValues(new Uint8Array(12))).map(b => b.toString(16).padStart(2, "0")).join("");
    const providerInfo = providers.find(p => p.id === accountForm.provider);
    const payload = {
      company_id: companyId,
      property: accountForm.property,
      provider: accountForm.provider,
      provider_display: providerInfo?.display_name || accountForm.provider,
      account_number: accountForm.account_number,
      // SECURITY: Credentials are encoded before storage. In production, use a Supabase Edge Function
      // with server-side AES-256-GCM encryption. The current encoding prevents casual viewing but 
      // is NOT cryptographically secure. Deploy the encrypt-credentials Edge Function for production use.
      username_encrypted: btoa(unescape(encodeURIComponent(accountForm.username))),
      password_encrypted: btoa(unescape(encodeURIComponent(accountForm.password))),
      encryption_iv: iv,
      login_url: providerInfo?.login_url || "",
      account_type: accountForm.account_type,
      check_frequency: accountForm.check_frequency,
      two_factor_method: accountForm.two_factor_method,
      notes: accountForm.notes,
    };
    let error;
    if (editingAccount) {
      ({ error } = await supabase.from("utility_accounts").update(payload).eq("id", editingAccount.id).eq("company_id", companyId));
    } else {
      ({ error } = await supabase.from("utility_accounts").insert([payload]));
    }
    if (error) { alert("Error saving account: " + error.message); return; }
    addNotification("⚡", (editingAccount ? "Updated" : "Added") + " utility account: " + (providerInfo?.display_name || accountForm.provider));
    setShowAccountForm(false);
    setEditingAccount(null);
    setAccountForm({ property: "", provider: "", account_number: "", username: "", password: "", account_type: "electric", check_frequency: "weekly", two_factor_method: "none", notes: "" });
    fetchAutomationData();
  }

  async function deleteAccount(acct) {
    if (!window.confirm("Archive this utility account? Automation will stop for this account.")) return;
    await supabase.from("utility_accounts").update({ archived_at: new Date().toISOString() }).eq("id", acct.id).eq("company_id", companyId);
    addNotification("📦", "Utility account archived: " + acct.provider_display);
    fetchAutomationData();
  }

  async function triggerManualCheck(acct) {
    // Queue a manual bill check job
    const { error } = await supabase.from("automation_jobs").insert([{
      company_id: companyId,
      utility_account_id: acct.id,
      job_type: "fetch_bill",
      status: "queued",
      triggered_by: userProfile?.email || "manual",
    }]);
    if (error) { alert("Error queuing job: " + error.message); return; }
    addNotification("🔄", "Bill check queued for " + acct.provider_display + " at " + acct.property);
    fetchAutomationData();
  }

  async function authorizeBillPayment(bill, paymentMethod) {
    const { error } = await supabase.from("utility_bills").update({
      status: "authorized",
      payment_method_selected: paymentMethod,
      authorized_by: userProfile?.email,
      authorized_at: new Date().toISOString(),
    }).eq("id", bill.id).eq("company_id", companyId);
    if (error) { alert("Error authorizing: " + error.message); return; }
    // Queue payment job
    await supabase.from("automation_jobs").insert([{
      company_id: companyId,
      utility_account_id: bill.utility_account_id,
      bill_id: bill.id,
      job_type: "pay_bill",
      status: "queued",
      triggered_by: userProfile?.email || "manual",
    }]);
    // Auto-post journal entry for utility payment (DR Utilities Expense, CR Checking)
    const classId = await getPropertyClassId(bill.property, companyId);
    const _jeOk = await autoPostJournalEntry({
      companyId,
      date: formatLocalDate(new Date()),
      description: "Utility payment — " + (bill.provider_display || bill.provider) + " — " + bill.property,
      reference: "UTIL-" + bill.id,
      property: bill.property,
      lines: [
        { account_id: "5400", account_name: "Utilities Expense", debit: safeNum(bill.amount), credit: 0, class_id: classId, memo: (bill.provider_display || bill.provider) + " bill" },
        { account_id: "1000", account_name: "Checking Account", debit: 0, credit: safeNum(bill.amount), class_id: classId, memo: "Utility payment" },
      ]
    });
    if (!_jeOk) { alert("Payment authorized but accounting entry failed. Please check the Accounting module."); }
    addNotification("✅", "Payment authorized: " + (bill.provider_display || bill.provider) + " $" + bill.amount);
    setPaymentMethodModal(null);
    fetchAutomationData();
  }

  async function fetchUtilities() {
    const { data } = await supabase.from("utilities").select("*").eq("company_id", companyId).order("due", { ascending: true }).limit(500);
    setUtilities(data || []);
    setLoading(false);
  }

  async function addUtility() {
      if (!guardSubmit("addUtility")) return;
      try {
    if (!form.property.trim()) { alert("Property is required."); return; }
    if (!form.provider.trim()) { alert("Provider name is required."); return; }
    if (!form.amount || isNaN(Number(form.amount)) || Number(form.amount) <= 0) { alert("Please enter a valid amount."); return; }
    if (!form.due) { alert("Due date is required."); return; }
    const { error } = await supabase.from("utilities").insert([{ ...form, amount: Number(form.amount), company_id: companyId }]);
    if (error) { alert("Error adding utility: " + error.message); return; }
    addNotification("⚡", `Utility bill added: ${form.provider} at ${form.property}`);
    logAudit("create", "utilities", `Utility added: ${form.provider} ${formatCurrency(form.amount)} at ${form.property}`, "", userProfile?.email, userRole, companyId);
    setShowForm(false);
    setForm({ property: "", provider: "", amount: "", due: "", responsibility: "owner", status: "pending" });
    fetchUtilities();
      } finally { guardRelease("addUtility"); }
  }

  async function approvePay(u) {
      if (!guardSubmit("approvePay")) return;
      try {
    if (u.status === "paid") { alert("This utility is already marked as paid."); return; }
    const now = new Date().toISOString();
    const { error } = await supabase.from("utilities").update({ status: "paid", paid_at: now }).eq("company_id", companyId).eq("id", u.id);
    if (error) { alert("Error approving payment: " + error.message); return; }
    await supabase.from("utility_audit").insert([{ company_id: companyId,
      utility_id: u.id,
      property: u.property,
      provider: u.provider,
      amount: u.amount,
      action: "Approved & Paid",
      paid_at: now,
    }]);
    addNotification("✅", `Utility paid: ${u.provider} ${formatCurrency(u.amount)} for ${u.property}`);
    // AUTO-POST TO ACCOUNTING: DR Utilities Expense, CR Bank
    const classId = await getPropertyClassId(u.property, companyId);
    const amt = safeNum(u.amount);
    if (amt > 0) {
      const _jeOk = await autoPostJournalEntry({
        companyId,
        date: formatLocalDate(new Date()),
        description: `Utility: ${u.provider} — ${u.property}`,
        reference: `UTIL-${u.id}`,
        property: u.property,
        lines: [
          { account_id: "5400", account_name: "Utilities", debit: amt, credit: 0, class_id: classId, memo: `${u.provider} — ${u.property}` },
          { account_id: "1000", account_name: "Checking Account", debit: 0, credit: amt, class_id: classId, memo: `Paid: ${u.provider}` },
        ]
      });
      if (!_jeOk) { alert("Accounting entry failed. The record was saved but the journal entry could not be posted. Please check the accounting module."); }
      // #15: Create ledger entry for utility payment
      await safeLedgerInsert({ company_id: companyId, tenant: "", property: u.property, date: formatLocalDate(new Date()), description: `Utility: ${u.provider}`, amount: amt, type: "expense", balance: 0 });
    }
    // #14: Add audit trail logging for utility payment
    logAudit("update", "utilities", `Utility paid: ${u.provider} ${formatCurrency(u.amount)} for ${u.property}`, u.id, userProfile?.email, userRole, companyId);
    fetchUtilities();
      } finally { guardRelease("approvePay"); }
  }

  async function openAuditLog(u) {
    const { data } = await supabase.from("utility_audit").select("*").eq("utility_id", u.id).order("paid_at", { ascending: false });
    setAuditLog(data || []);
    setShowAudit(u);
  }

  if (loading) return <Spinner />;

  return (
    <div>
      {showAudit && (
        <Modal title={`Audit Log — ${showAudit.provider}`} onClose={() => setShowAudit(null)}>
          {auditLog.length === 0 ? (
            <div className="text-center text-slate-400 py-6">No audit entries yet</div>
          ) : (
            <div className="space-y-3">
              {auditLog.map((a, i) => (
                <div key={i} className="bg-indigo-50/30 rounded-lg px-4 py-3">
                  <div className="flex justify-between">
                    <span className="text-sm font-semibold text-green-600">{a.action}</span>
                    <span className="text-xs text-slate-400">{new Date(a.paid_at).toLocaleString()}</span>
                  </div>
                  <div className="text-sm text-slate-500 mt-1">${a.amount} — {a.property}</div>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}

      {/* Tab Navigation */}
      <div className="flex items-center gap-4 mb-5 border-b border-indigo-50 pb-3">
        <h2 className="text-2xl font-manrope font-bold text-slate-800">Utilities</h2>
        <div className="flex gap-1 ml-2">
          {[["bills", "Manual Bills"], ["automation", "⚡ Automation"], ["jobs", "Job History"]].map(([id, label]) => (
            <button key={id} onClick={() => setUtilTab(id)} className={"px-3 py-1.5 text-xs font-medium rounded-lg " + (utilTab === id ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200")}>{label}</button>
          ))}
        </div>
      </div>

      {/* ===== AUTOMATION TAB ===== */}
      {utilTab === "automation" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-gray-700">Connected Utility Accounts</h3>
              <p className="text-xs text-gray-400 mt-0.5">{utilAccounts.length} account{utilAccounts.length !== 1 ? "s" : ""} connected</p>
            </div>
            <button onClick={() => { setEditingAccount(null); setAccountForm({ property: "", provider: "", account_number: "", username: "", password: "", account_type: "electric", check_frequency: "weekly", two_factor_method: "none", notes: "" }); setShowAccountForm(true); }} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">+ Add Account</button>
          </div>

          {showAccountForm && (
            <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
              <h3 className="font-semibold text-gray-700 mb-3">{editingAccount ? "Edit Account" : "Connect Utility Account"}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div><label className="text-xs font-medium text-gray-500 mb-1 block">Property *</label><PropertySelect value={accountForm.property} onChange={v => setAccountForm({...accountForm, property: v})} companyId={companyId} /></div>
                <div><label className="text-xs font-medium text-gray-500 mb-1 block">Provider *</label><select value={accountForm.provider} onChange={e => { const p = providers.find(x => x.id === e.target.value); setAccountForm({...accountForm, provider: e.target.value, account_type: p?.account_type || "electric"}); }} className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full"><option value="">Select provider...</option>{providers.map(p => <option key={p.id} value={p.id}>{p.display_name} ({p.region})</option>)}</select></div>
                <div><label className="text-xs font-medium text-gray-500 mb-1 block">Account Number</label><input placeholder="e.g. 1234567890" value={accountForm.account_number} onChange={e => setAccountForm({...accountForm, account_number: e.target.value})} className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full" /></div>
                <div><label className="text-xs font-medium text-gray-500 mb-1 block">Account Type</label><select value={accountForm.account_type} onChange={e => setAccountForm({...accountForm, account_type: e.target.value})} className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full"><option value="electric">Electric</option><option value="gas">Gas</option><option value="water_sewer">Water/Sewer</option><option value="electric_gas">Electric + Gas</option><option value="trash">Trash</option></select></div>
                <div className="col-span-1 sm:col-span-2 bg-amber-50 rounded-lg px-3 py-2"><div className="text-xs font-semibold text-amber-700">🔐 Login Credentials (encrypted before storage)</div></div>
                <div><label className="text-xs font-medium text-gray-500 mb-1 block">Username / Email *</label><input placeholder="your-login@email.com" value={accountForm.username} onChange={e => setAccountForm({...accountForm, username: e.target.value})} className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full" autoComplete="off" /></div>
                <div><label className="text-xs font-medium text-gray-500 mb-1 block">Password *</label><input type="password" placeholder="••••••••" value={accountForm.password} onChange={e => setAccountForm({...accountForm, password: e.target.value})} className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full" autoComplete="new-password" /></div>
                <div><label className="text-xs font-medium text-gray-500 mb-1 block">Check Frequency</label><select value={accountForm.check_frequency} onChange={e => setAccountForm({...accountForm, check_frequency: e.target.value})} className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full"><option value="weekly">Weekly</option><option value="biweekly">Every 2 Weeks</option><option value="monthly">Monthly</option></select></div>
                <div><label className="text-xs font-medium text-gray-500 mb-1 block">2FA Method</label><select value={accountForm.two_factor_method} onChange={e => setAccountForm({...accountForm, two_factor_method: e.target.value})} className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full"><option value="none">None</option><option value="sms">SMS</option><option value="email">Email</option></select></div>
              </div>
              <div className="flex gap-2 mt-3">
                <button onClick={saveAccount} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">Save Account</button>
                <button onClick={() => { setShowAccountForm(false); setEditingAccount(null); }} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg">Cancel</button>
              </div>
            </div>
          )}

          {utilAccounts.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-xl border border-gray-100">
              <div className="text-4xl mb-3">⚡</div>
              <div className="text-gray-500 font-medium">No utility accounts connected</div>
              <div className="text-xs text-gray-400 mt-1">Add your first account to start automated bill fetching</div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
              {utilAccounts.map(acct => (
                <div key={acct.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div><div className="font-semibold text-gray-800 text-sm">{acct.provider_display}</div><div className="text-xs text-gray-400">{acct.property}</div></div>
                    <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (acct.last_check_status === "success" ? "bg-green-100 text-green-700" : acct.last_check_status === "failed" ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-500")}>{acct.last_check_status || "never"}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs mt-2">
                    <div><span className="text-gray-400">Account #</span><div className="font-semibold text-gray-700">{acct.account_number || "—"}</div></div>
                    <div><span className="text-gray-400">Type</span><div className="font-semibold text-gray-700 capitalize">{acct.account_type?.replace("_", "/")}</div></div>
                    <div><span className="text-gray-400">Last Checked</span><div className="font-semibold text-gray-700">{acct.last_checked_at ? new Date(acct.last_checked_at).toLocaleDateString() : "Never"}</div></div>
                    <div><span className="text-gray-400">Frequency</span><div className="font-semibold text-gray-700 capitalize">{acct.check_frequency}</div></div>
                  </div>
                  <div className="flex gap-2 mt-3 pt-3 border-t border-gray-50">
                    <button onClick={() => triggerManualCheck(acct)} className="text-xs text-indigo-600 border border-indigo-200 px-3 py-1 rounded-lg hover:bg-indigo-50">🔄 Check Now</button>
                    <button onClick={() => deleteAccount(acct)} className="text-xs text-red-500 hover:underline ml-auto">Archive</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {autoBills.length > 0 && (
            <div>
              <h3 className="font-semibold text-gray-700 mb-3">Fetched Bills</h3>
              <div className="space-y-2">
                {autoBills.map(bill => (
                  <div key={bill.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 flex items-center gap-4">
                    <div className="flex-1"><div className="font-semibold text-gray-800 text-sm">{bill.provider_display || bill.provider}</div><div className="text-xs text-gray-400">{bill.property} · Due {bill.due_date || "—"}</div></div>
                    <div className="text-lg font-bold text-gray-800">${safeNum(bill.amount).toLocaleString()}</div>
                    <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (bill.status === "paid" ? "bg-green-100 text-green-700" : bill.status === "authorized" ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700")}>{bill.status?.replace("_", " ")}</span>
                    {bill.status === "pending_review" && <button onClick={() => authorizeBillPayment(bill, "default_on_file")} className="text-xs bg-green-50 text-green-700 px-3 py-1.5 rounded-lg hover:bg-green-100 border border-green-200">Authorize Pay</button>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== JOB HISTORY TAB ===== */}
      {utilTab === "jobs" && (
        <div>
          <h3 className="font-semibold text-gray-700 mb-3">Automation Job History</h3>
          {autoJobs.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-xl border border-gray-100"><div className="text-gray-400">No automation jobs yet</div></div>
          ) : (
            <div className="space-y-2">
              {autoJobs.map(job => (
                <div key={job.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 flex items-center gap-4">
                  <div className="flex-1"><div className="font-semibold text-gray-800 text-sm capitalize">{job.job_type?.replace("_", " ")}</div><div className="text-xs text-gray-400">{job.triggered_by} · {job.created_at ? new Date(job.created_at).toLocaleString() : ""}</div></div>
                  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (job.status === "completed" ? "bg-green-100 text-green-700" : job.status === "failed" ? "bg-red-100 text-red-700" : job.status === "running" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500")}>{job.status}</span>
                  {job.error_message && <div className="text-xs text-red-500 max-w-xs truncate">{job.error_message}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ===== MANUAL BILLS TAB ===== */}
      {utilTab === "bills" && (<>
      {/* Toolbar */}
      <div className="flex flex-col md:flex-row gap-3 mb-4">
        <div className="mr-auto"></div>
        <input placeholder="Search..." value={utilSearch} onChange={e => setUtilSearch(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-40" />
        <select value={utilFilterStatus} onChange={e => setUtilFilterStatus(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
          <option value="all">All Status</option><option value="pending">Pending</option><option value="paid">Paid</option>
        </select>
        <select value={utilFilterProp} onChange={e => setUtilFilterProp(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
          <option value="all">All Properties</option>
          {[...new Set(utilities.map(u => u.property).filter(Boolean))].map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <div className="flex bg-indigo-50 rounded-2xl p-0.5">
          {[["card","▦"],["table","☰"]].map(([m,icon]) => (
            <button key={m} onClick={() => setUtilView(m)} className={`px-3 py-1.5 text-sm rounded-md ${utilView === m ? "bg-white shadow-sm text-indigo-700 font-semibold" : "text-slate-400"}`}>{icon}</button>
          ))}
        </div>
        <button onClick={() => setShowForm(!showForm)} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-indigo-700 whitespace-nowrap">+ Add Bill</button>
      </div>

      {/* Stats */}
      <div className="flex gap-3 mb-4">
        <div className="bg-white rounded-3xl border border-indigo-50 px-3 py-2 text-center flex-1"><div className="text-lg font-manrope font-bold text-slate-800">{utilities.length}</div><div className="text-xs text-slate-400">Total</div></div>
        <div className="bg-white rounded-3xl border border-indigo-50 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-amber-600">{utilities.filter(u => u.status === "pending").length}</div><div className="text-xs text-slate-400">Pending</div></div>
        <div className="bg-white rounded-3xl border border-indigo-50 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-emerald-600">${utilities.filter(u => u.status === "paid").reduce((s,u) => s + safeNum(u.amount), 0).toLocaleString()}</div><div className="text-xs text-slate-400">Paid</div></div>
        <div className="bg-white rounded-3xl border border-indigo-50 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-red-500">${utilities.filter(u => u.status === "pending").reduce((s,u) => s + safeNum(u.amount), 0).toLocaleString()}</div><div className="text-xs text-slate-400">Outstanding</div></div>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-slate-700 mb-3">New Utility Bill</h3>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Property *</label><PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} companyId={companyId} /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Provider</label><input placeholder="e.g. PEPCO, Washington Gas" value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Amount ($)</label><input placeholder="150.00" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Due Date</label><input type="date" value={form.due} onChange={e => setForm({ ...form, due: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Responsibility</label><select value={form.responsibility} onChange={e => setForm({ ...form, responsibility: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full">
              {["owner", "tenant", "shared"].map(r => <option key={r}>{r}</option>)}
            </select></div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={addUtility} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg">Save</button>
            <button onClick={() => setShowForm(false)} className="bg-slate-100 text-slate-500 text-sm px-4 py-2 rounded-lg">Cancel</button>
          </div>
        </div>
      )}

      {(() => {
        const fu = utilities.filter(u =>
          (utilFilterStatus === "all" || u.status === utilFilterStatus) &&
          (utilFilterProp === "all" || u.property === utilFilterProp) &&
          (!utilSearch || u.provider?.toLowerCase().includes(utilSearch.toLowerCase()) || u.property?.toLowerCase().includes(utilSearch.toLowerCase()))
        );
        return <>
          {utilView === "card" && (
            <div className="space-y-3">
              {fu.map(u => (
                <div key={u.id} className="bg-white rounded-3xl shadow-card border border-indigo-50 p-4">
                  <div className="flex justify-between items-start">
                    <div><div className="font-semibold text-slate-800">{u.provider}</div><div className="text-xs text-slate-400 mt-0.5">{u.property}</div></div>
                    <div className="text-right"><div className="text-lg font-manrope font-bold text-slate-800">${u.amount}</div><Badge status={u.status} /></div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <div><span className="text-slate-400">Due</span><div className="font-semibold text-slate-700">{u.due}</div></div>
                    <div><span className="text-slate-400">Responsibility</span><div className="font-semibold capitalize text-slate-700">{u.responsibility}</div></div>
                    <div><span className="text-slate-400">Paid</span><div className="font-semibold text-slate-700">{u.paid_at ? new Date(u.paid_at).toLocaleDateString() : "—"}</div></div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    {u.status === "pending" && <button onClick={() => approvePay(u)} className="text-xs text-green-600 border border-green-200 px-3 py-1 rounded-lg hover:bg-green-50">✓ Pay</button>}
                    <button onClick={() => openAuditLog(u)} className="text-xs text-slate-500 border border-indigo-100 px-3 py-1 rounded-lg hover:bg-indigo-50/30">Audit</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {utilView === "table" && (
            <div className="bg-white rounded-3xl shadow-card border border-indigo-50 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-indigo-50/30 text-xs text-slate-400 uppercase">
                  <tr><th className="px-4 py-3 text-left">Provider</th><th className="px-4 py-3 text-left">Property</th><th className="px-4 py-3 text-right">Amount</th><th className="px-4 py-3 text-left">Due</th><th className="px-4 py-3 text-left">Status</th><th className="px-4 py-3 text-left">Resp.</th><th className="px-4 py-3 text-right">Actions</th></tr>
                </thead>
                <tbody>
                  {fu.map(u => (
                    <tr key={u.id} className="border-t border-indigo-50/50 hover:bg-indigo-50/30/50">
                      <td className="px-4 py-2.5 font-medium text-slate-800">{u.provider}</td>
                      <td className="px-4 py-2.5 text-slate-500">{u.property}</td>
                      <td className="px-4 py-2.5 text-right font-semibold">${u.amount}</td>
                      <td className="px-4 py-2.5 text-slate-400">{u.due}</td>
                      <td className="px-4 py-2.5"><Badge status={u.status} /></td>
                      <td className="px-4 py-2.5 text-slate-500 capitalize">{u.responsibility}</td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        {u.status === "pending" && <button onClick={() => approvePay(u)} className="text-xs text-green-600 hover:underline mr-2">Pay</button>}
                        <button onClick={() => openAuditLog(u)} className="text-xs text-slate-400 hover:underline">Audit</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {fu.length === 0 && <div className="text-center py-8 text-slate-400">No utility bills found</div>}
        </>;
      })()}
    </>)}
    </div>
  );
}


// ============ RECURRING JOURNAL ENTRIES ============
function RecurringJournalEntries({ companyId, addNotification, userProfile }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingEntry, setEditingEntry] = useState(null);
  const [form, setForm] = useState({
    description: "", frequency: "monthly", day_of_month: 1, amount: "",
    tenant_name: "", property: "", debit_account_id: "1200", debit_account_name: "Accounts Receivable",
    credit_account_id: "4000", credit_account_name: "Rental Income",
    late_fee_enabled: true, grace_period_days: 5, late_fee_amount: 50,
  });

  useEffect(() => { fetchEntries(); }, [companyId]);

  async function fetchEntries() {
    setLoading(true);
    const { data } = await supabase.from("recurring_journal_entries").select("*")
      .eq("company_id", companyId).order("created_at", { ascending: false }).limit(200);
    setEntries(data || []);
    setLoading(false);
  }

  async function saveEntry() {
    if (!form.description.trim() || !form.amount) { alert("Description and amount are required."); return; }
    const payload = {
      company_id: companyId,
      description: form.description, frequency: form.frequency,
      day_of_month: Number(form.day_of_month) || 1, amount: Number(form.amount),
      tenant_name: form.tenant_name, property: form.property,
      debit_account_id: form.debit_account_id, debit_account_name: form.debit_account_name,
      credit_account_id: form.credit_account_id, credit_account_name: form.credit_account_name,
      status: "active", late_fee_enabled: form.late_fee_enabled,
      grace_period_days: Number(form.grace_period_days) || 5,
      late_fee_amount: Number(form.late_fee_amount) || 0,
      next_post_date: new Date(new Date().getFullYear(), new Date().getMonth() + 1, Number(form.day_of_month) || 1).toISOString().split("T")[0],
      created_by: userProfile?.email || "",
    };
    if (editingEntry) {
      const { error } = await supabase.from("recurring_journal_entries").update(payload).eq("id", editingEntry.id).eq("company_id", companyId);
      if (error) { alert(userError(error.message)); return; }
      addNotification("✏️", "Updated recurring entry: " + form.description);
    } else {
      const { error } = await supabase.from("recurring_journal_entries").insert([payload]);
      if (error) { alert(userError(error.message)); return; }
      addNotification("🔄", "Created recurring entry: " + form.description);
    }
    setShowForm(false); setEditingEntry(null);
    setForm({ description: "", frequency: "monthly", day_of_month: 1, amount: "", tenant_name: "", property: "", debit_account_id: "1200", debit_account_name: "Accounts Receivable", credit_account_id: "4000", credit_account_name: "Rental Income", late_fee_enabled: true, grace_period_days: 5, late_fee_amount: 50 });
    fetchEntries();
  }

  async function toggleStatus(entry) {
    const newStatus = entry.status === "active" ? "paused" : "active";
    const { error } = await supabase.from("recurring_journal_entries").update({ status: newStatus }).eq("id", entry.id).eq("company_id", companyId);
    if (error) { alert(userError(error.message)); return; }
    addNotification(newStatus === "active" ? "▶️" : "⏸️", (newStatus === "active" ? "Resumed" : "Paused") + ": " + entry.description);
    fetchEntries();
  }

  async function deleteEntry(entry) {
    if (!window.confirm("Delete this recurring entry? This cannot be undone.")) return;
    const { error } = await supabase.from("recurring_journal_entries").delete().eq("id", entry.id).eq("company_id", companyId);
    if (error) { alert(userError(error.message)); return; }
    addNotification("🗑️", "Deleted: " + entry.description);
    fetchEntries();
  }

  async function runNow() {
    if (!window.confirm("Post all active recurring entries for this month now?")) return;
    const result = await autoPostRentCharges(companyId);
    if (result?.posted > 0) addNotification("⚡", "Posted " + result.posted + " charge(s)");
    else addNotification("ℹ️", "No new charges needed for this period");
    fetchEntries();
  }

  if (loading) return <Spinner />;

  const active = entries.filter(e => e.status === "active");
  const paused = entries.filter(e => e.status === "paused");

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-sm text-gray-500">{active.length} active · {paused.length} paused</div>
        </div>
        <div className="flex gap-2">
          <button onClick={runNow} className="bg-amber-50 text-amber-700 text-xs px-3 py-1.5 rounded-lg border border-amber-200 hover:bg-amber-100">⚡ Post Now</button>
          <button onClick={() => { setEditingEntry(null); setForm({ description: "", frequency: "monthly", day_of_month: 1, amount: "", tenant_name: "", property: "", debit_account_id: "1200", debit_account_name: "Accounts Receivable", credit_account_id: "4000", credit_account_name: "Rental Income", late_fee_enabled: true, grace_period_days: 5, late_fee_amount: 50 }); setShowForm(true); }} className="bg-indigo-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-indigo-700">+ Add Entry</button>
        </div>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-gray-700 mb-3">{editingEntry ? "Edit Recurring Entry" : "New Recurring Entry"}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="col-span-2"><label className="text-xs text-gray-500 mb-1 block">Description *</label><input value={form.description} onChange={e => setForm({...form, description: e.target.value})} className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full" placeholder="Monthly rent — John Doe — 123 Main St" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Amount *</label><input type="number" value={form.amount} onChange={e => setForm({...form, amount: e.target.value})} className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Day of Month</label><input type="number" min="1" max="28" value={form.day_of_month} onChange={e => setForm({...form, day_of_month: e.target.value})} className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Tenant</label><input value={form.tenant_name} onChange={e => setForm({...form, tenant_name: e.target.value})} className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Property</label><PropertySelect value={form.property} onChange={v => setForm({...form, property: v})} companyId={companyId} /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Debit Account</label><input value={form.debit_account_name} onChange={e => setForm({...form, debit_account_name: e.target.value})} className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Credit Account</label><input value={form.credit_account_name} onChange={e => setForm({...form, credit_account_name: e.target.value})} className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full" /></div>
            <div className="col-span-2 bg-amber-50 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-2">
                <input type="checkbox" checked={form.late_fee_enabled} onChange={e => setForm({...form, late_fee_enabled: e.target.checked})} />
                <span className="text-xs font-semibold text-amber-700">Enable Auto Late Fees</span>
              </div>
              {form.late_fee_enabled && (
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="text-xs text-gray-500 mb-1 block">Grace Period (days)</label><input type="number" value={form.grace_period_days} onChange={e => setForm({...form, grace_period_days: e.target.value})} className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm w-full" /></div>
                  <div><label className="text-xs text-gray-500 mb-1 block">Late Fee ($)</label><input type="number" value={form.late_fee_amount} onChange={e => setForm({...form, late_fee_amount: e.target.value})} className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm w-full" /></div>
                </div>
              )}
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={saveEntry} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">{editingEntry ? "Update" : "Create"}</button>
            <button onClick={() => { setShowForm(false); setEditingEntry(null); }} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg">Cancel</button>
          </div>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-gray-100">
          <div className="text-4xl mb-3">🔄</div>
          <div className="text-gray-500 font-medium">No recurring entries</div>
          <div className="text-xs text-gray-400 mt-1">Recurring entries are created automatically when you add a tenant, or you can add them manually.</div>
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map(e => (
            <div key={e.id} className={"bg-white rounded-xl border shadow-sm p-4 " + (e.status === "paused" ? "opacity-60 border-gray-200" : "border-gray-100")}>
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <div className="font-semibold text-gray-800 text-sm">{e.description}</div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {e.tenant_name && <span>{e.tenant_name} · </span>}
                    {e.property && <span>{e.property} · </span>}
                    Day {e.day_of_month} · {e.frequency}
                    {e.late_fee_enabled && <span> · Late fee: ${safeNum(e.late_fee_amount)} after {e.grace_period_days}d</span>}
                  </div>
                </div>
                <div className="text-lg font-bold text-gray-800">${safeNum(e.amount).toLocaleString()}</div>
                <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (e.status === "active" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500")}>{e.status}</span>
                <div className="flex gap-1">
                  <button onClick={() => toggleStatus(e)} className={"text-xs px-2 py-1 rounded-lg " + (e.status === "active" ? "text-amber-600 hover:bg-amber-50" : "text-green-600 hover:bg-green-50")}>{e.status === "active" ? "⏸ Pause" : "▶ Resume"}</button>
                  <button onClick={() => { setEditingEntry(e); setForm({ description: e.description, frequency: e.frequency, day_of_month: e.day_of_month, amount: e.amount, tenant_name: e.tenant_name || "", property: e.property || "", debit_account_id: e.debit_account_id || "1200", debit_account_name: e.debit_account_name || "Accounts Receivable", credit_account_id: e.credit_account_id || "4000", credit_account_name: e.credit_account_name || "Rental Income", late_fee_enabled: e.late_fee_enabled !== false, grace_period_days: e.grace_period_days || 5, late_fee_amount: e.late_fee_amount || 50 }); setShowForm(true); }} className="text-xs text-indigo-600 px-2 py-1 rounded-lg hover:bg-indigo-50">Edit</button>
                  <button onClick={() => deleteEntry(e)} className="text-xs text-red-500 px-2 py-1 rounded-lg hover:bg-red-50">Delete</button>
                </div>
              </div>
              {e.next_post_date && <div className="text-xs text-gray-400 mt-2">Next post: {e.next_post_date}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============ ACCOUNTING (QuickBooks-Style with Supabase) ============

// --- Accounting Utility Functions ---
const DEFAULT_ACCOUNT_TYPES = ["Asset","Liability","Equity","Revenue","Cost of Goods Sold","Expense","Other Income","Other Expense"];
const DEFAULT_ACCOUNT_SUBTYPES = {
  Asset: ["Bank","Accounts Receivable","Other Current Asset","Fixed Asset","Other Asset"],
  Liability: ["Accounts Payable","Credit Card","Other Current Liability","Long Term Liability"],
  Equity: ["Owners Equity","Retained Earnings","Common Stock"],
  Revenue: ["Rental Income","Other Primary Income","Service Income"],
  "Cost of Goods Sold": ["Cost of Goods Sold","Supplies & Materials"],
  Expense: ["Advertising & Marketing","Auto","Bank Charges","Depreciation","Insurance","Maintenance & Repairs","Meals & Entertainment","Office Supplies","Professional Fees","Property Tax","Rent & Lease","Utilities","Wages & Salaries","Other Expense"],
  "Other Income": ["Interest Earned","Late Fees","Other Miscellaneous Income"],
  "Other Expense": ["Depreciation","Other Miscellaneous Expense"],
};

// Build dynamic types/subtypes from existing accounts + defaults
const getAccountTypes = (accounts) => {
  const types = new Set(DEFAULT_ACCOUNT_TYPES);
  (accounts || []).forEach(a => { if (a.type) types.add(a.type); });
  return [...types];
};
const getAccountSubtypes = (accounts, type) => {
  const subs = new Set(DEFAULT_ACCOUNT_SUBTYPES[type] || []);
  (accounts || []).filter(a => a.type === type && a.subtype).forEach(a => subs.add(a.subtype));
  return [...subs];
};
const ACCOUNT_TYPES = DEFAULT_ACCOUNT_TYPES; // kept for backward compat in non-dynamic contexts
const ACCOUNT_SUBTYPES = DEFAULT_ACCOUNT_SUBTYPES;
const DEBIT_NORMAL = ["Asset","Cost of Goods Sold","Expense","Other Expense"];
const acctFmt = (amount, showSign = false) => {
  const abs = Math.abs(amount);
  const str = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(abs);
  if (showSign && amount < 0) return `(${str})`;
  if (amount < 0) return `-${str}`;
  return str;
};
const acctFmtDate = (d) => { if (!d) return ""; const [y,m,dd] = d.split("-"); return `${m}/${dd}/${y}`; };
const acctToday = () => formatLocalDate(new Date());
const getNormalBalance = (type) => DEBIT_NORMAL.includes(type) ? "debit" : "credit";

// Build a single-pass index of account balances from journal lines — O(n) instead of O(accounts × lines)
const buildBalanceIndex = (journalEntries, filterFn = null) => {
  const index = {};
  const classIndex = {};
  for (const je of journalEntries) {
    if (je.status !== "posted") continue;
    if (filterFn && !filterFn(je)) continue;
    for (const l of (je.lines || [])) {
      const aid = l.account_id;
      if (!index[aid]) index[aid] = { debit: 0, credit: 0 };
      index[aid].debit += safeNum(l.debit);
      index[aid].credit += safeNum(l.credit);
      if (l.class_id) {
        const ck = aid + "_" + l.class_id;
        if (!classIndex[ck]) classIndex[ck] = { debit: 0, credit: 0 };
        classIndex[ck].debit += safeNum(l.debit);
        classIndex[ck].credit += safeNum(l.credit);
      }
    }
  }
  return { index, classIndex };
};

const balanceFromIndex = (idx, accountId, accountType) => {
  const entry = idx[accountId];
  if (!entry) return 0;
  const nb = getNormalBalance(accountType);
  return nb === "debit" ? entry.debit - entry.credit : entry.credit - entry.debit;
};

const calcAccountBalance = (accountId, journalEntries, account) => {
  const { index } = buildBalanceIndex(journalEntries);
  return balanceFromIndex(index, accountId, account.type);
};

const calcAllBalances = (accounts, journalEntries) => {
  const { index } = buildBalanceIndex(journalEntries);
  return accounts.map(a => ({ ...a, computedBalance: balanceFromIndex(index, a.id, a.type) }));
};

const getPLData = (accounts, journalEntries, startDate, endDate, classId = null) => {
  const revTypes = ["Revenue","Other Income"];
  const expTypes = ["Expense","Cost of Goods Sold","Other Expense"];
  const { index, classIndex } = buildBalanceIndex(journalEntries, je => je.date >= startDate && je.date <= endDate);
  const getBalance = (aid, atype) => {
    if (classId) {
      const entry = classIndex[aid + "_" + classId];
      if (!entry) return 0;
      const nb = getNormalBalance(atype);
      return nb === "debit" ? entry.debit - entry.credit : entry.credit - entry.debit;
    }
    return balanceFromIndex(index, aid, atype);
  };
  const revenue = accounts.filter(a => revTypes.includes(a.type) && a.is_active).map(a => ({ ...a, amount: getBalance(a.id, a.type) })).filter(a => a.amount !== 0);
  const expenses = accounts.filter(a => expTypes.includes(a.type) && a.is_active).map(a => ({ ...a, amount: getBalance(a.id, a.type) })).filter(a => a.amount !== 0);
  const totalRevenue = revenue.reduce((s, a) => s + a.amount, 0);
  const totalExpenses = expenses.reduce((s, a) => s + a.amount, 0);
  return { revenue, expenses, totalRevenue, totalExpenses, netIncome: totalRevenue - totalExpenses };
};

const getBalanceSheetData = (accounts, journalEntries, asOfDate) => {
  const filtered = journalEntries.filter(je => je.status === "posted" && je.date <= asOfDate);
  const { index } = buildBalanceIndex(filtered);
  const acctMap = {}; accounts.forEach(a => { acctMap[a.id] = a; });
  const assets = accounts.filter(a => a.type === "Asset" && a.is_active).map(a => ({ ...a, amount: balanceFromIndex(index, a.id, a.type) }));
  const liabilities = accounts.filter(a => a.type === "Liability" && a.is_active).map(a => ({ ...a, amount: balanceFromIndex(index, a.id, a.type) }));
  const equity = accounts.filter(a => a.type === "Equity" && a.is_active).map(a => ({ ...a, amount: balanceFromIndex(index, a.id, a.type) }));
  let netIncome = 0;
  for (const [aid, entry] of Object.entries(index)) {
    const acct = acctMap[aid]; if (!acct) continue;
    if (["Revenue","Other Income"].includes(acct.type)) netIncome += entry.credit - entry.debit;
    if (["Expense","Cost of Goods Sold","Other Expense"].includes(acct.type)) netIncome -= entry.debit - entry.credit;
  }

  // Build AR sub-ledger and aging using dynamic AR account IDs
  const arAccountIds = new Set(accounts.filter(a => a.name === "Accounts Receivable").map(a => a.id));
  const arSubLedger = {};
  filtered.forEach(je => {
    (je.lines || []).filter(l => arAccountIds.has(l.account_id)).forEach(l => {
      // Extract tenant name from memo (format: "TenantName rent 2025-06" or "TenantName — PropertyAddr")
      const memo = l.memo || je.description || "";
      let tenantKey = "Unassigned";
      // Try to extract tenant from "Rent charge — TenantName — Property — Month"
      const descMatch = je.description ? je.description.match(/(?:Rent charge|Payment received|AR Settlement|Security deposit).*?—\s*([^—]+?)(?:\s*—|$)/) : null;
      // Try memo format "TenantName rent YYYY-MM"
      const memoMatch = memo.match(/^(.+?)\s+(?:rent|payment|deposit)/i);
      if (descMatch) tenantKey = descMatch[1].trim();
      else if (memoMatch) tenantKey = memoMatch[1].trim();
      else if (memo && memo !== "") tenantKey = memo.split(" ")[0] + " " + (memo.split(" ")[1] || "");

      if (!arSubLedger[tenantKey]) arSubLedger[tenantKey] = { debits: 0, credits: 0 };
      arSubLedger[tenantKey].debits += safeNum(l.debit);
      arSubLedger[tenantKey].credits += safeNum(l.credit);
    });
  });
  const arByTenant = Object.entries(arSubLedger).map(([tenant, bal]) => ({
    tenant, balance: bal.debits - bal.credits
  })).filter(t => Math.abs(t.balance) > 0.01).sort((a, b) => b.balance - a.balance);

  // AR Aging: bucket by how old the charges are
  const today = new Date();
  const arAging = { current: 0, days30: 0, days60: 0, days90: 0, over90: 0 };
  const arAgingByTenant = {};
  filtered.forEach(je => {
    (je.lines || []).filter(l => arAccountIds.has(l.account_id) && (safeNum(l.debit) > 0 || safeNum(l.credit) > 0)).forEach(l => {
      const jeDate = parseLocalDate(je.date);
      const daysDiff = Math.floor((today - jeDate) / 86400000);
      // Net amount: debits increase AR, credits decrease AR
      const amount = safeNum(l.debit) - safeNum(l.credit);
      const bucket = daysDiff <= 30 ? "current" : daysDiff <= 60 ? "days30" : daysDiff <= 90 ? "days60" : daysDiff <= 120 ? "days90" : "over90";
      arAging[bucket] += amount;

      // Per-tenant aging
      const memo = l.memo || je.description || "";
      const descMatch = je.description ? je.description.match(/(?:Rent charge|Payment|Late fee|Rent accrual).*?—\s*([^—]+?)(?:\s*—|$)/) : null;
      const memoMatch = memo.match(/^(.+?)\s+(?:rent|payment|AR|Late)/i);
      let tenantKey = descMatch ? descMatch[1].trim() : memoMatch ? memoMatch[1].trim() : "Unassigned";
      if (!arAgingByTenant[tenantKey]) arAgingByTenant[tenantKey] = { current: 0, days30: 0, days60: 0, days90: 0, over90: 0, total: 0 };
      arAgingByTenant[tenantKey][bucket] += amount;
      arAgingByTenant[tenantKey].total += amount;
    });
  });

  return { assets, liabilities, equity, totalAssets: assets.reduce((s,a) => s + a.amount, 0), totalLiabilities: liabilities.reduce((s,a) => s + a.amount, 0), totalEquity: equity.reduce((s,a) => s + a.amount, 0) + netIncome, netIncome, arByTenant, arAging, arAgingByTenant };
};

const getTrialBalance = (accounts, journalEntries, endDate) => {
  const { index } = buildBalanceIndex(journalEntries, je => je.date <= endDate);
  return accounts.filter(a => a.is_active).map(a => {
    const entry = index[a.id];
    const net = entry ? entry.debit - entry.credit : 0;
    return { ...a, debitBalance: net > 0 ? net : 0, creditBalance: net < 0 ? Math.abs(net) : 0 };
  }).filter(a => a.debitBalance !== 0 || a.creditBalance !== 0);
};

const getGeneralLedger = (accountId, accounts, journalEntries) => {
  const account = accounts.find(a => a.id === accountId);
  if (!account) return [];
  const nb = getNormalBalance(account.type);
  let running = 0;
  const lines = [];
  journalEntries.filter(je => je.status === "posted").sort((a,b) => a.date.localeCompare(b.date)).forEach(je => {
    (je.lines || []).filter(l => l.account_id === accountId).forEach(l => {
      running += nb === "debit" ? safeNum(l.debit) - safeNum(l.credit) : safeNum(l.credit) - safeNum(l.debit);
      lines.push({ date: je.date, jeId: je.id, description: je.description, reference: je.reference, memo: l.memo, debit: safeNum(l.debit), credit: safeNum(l.credit), balance: running });
    });
  });
  return lines;
};

const getClassReport = (accounts, journalEntries, classes, startDate, endDate) => {
  const acctMap = {}; accounts.forEach(a => { acctMap[a.id] = a; });
  const classData = {};
  for (const je of journalEntries) {
    if (je.status !== "posted" || je.date < startDate || je.date > endDate) continue;
    for (const l of (je.lines || [])) {
      if (!l.class_id) continue;
      if (!classData[l.class_id]) classData[l.class_id] = { revenue: 0, expenses: 0 };
      const acct = acctMap[l.account_id]; if (!acct) continue;
      if (["Revenue","Other Income"].includes(acct.type)) classData[l.class_id].revenue += safeNum(l.credit) - safeNum(l.debit);
      if (["Expense","Cost of Goods Sold","Other Expense"].includes(acct.type)) classData[l.class_id].expenses += safeNum(l.debit) - safeNum(l.credit);
    }
  }
  return classes.map(cls => {
    const d = classData[cls.id] || { revenue: 0, expenses: 0 };
    return { ...cls, revenue: d.revenue, expenses: d.expenses, netIncome: d.revenue - d.expenses };
  });
};

const validateJE = (lines) => {
  const td = lines.reduce((s,l) => s + safeNum(l.debit), 0);
  const tc = lines.reduce((s,l) => s + safeNum(l.credit), 0);
  return { isValid: Math.abs(td - tc) < 0.005, totalDebit: td, totalCredit: tc, difference: Math.abs(td - tc) };
};

const nextJENumber = (journalEntries) => {
  const nums = journalEntries.map(je => parseInt(je.number.replace("JE-",""),10)).filter(n => !isNaN(n));
  return `JE-${String((nums.length > 0 ? Math.max(...nums) : 0) + 1).padStart(4,"0")}`;
};

const nextAccountId = (accounts, type) => {
  const ranges = { Asset:{s:1000,e:1999}, Liability:{s:2000,e:2999}, Equity:{s:3000,e:3999}, Revenue:{s:4000,e:4999}, "Cost of Goods Sold":{s:5000,e:5099}, Expense:{s:5000,e:6999}, "Other Income":{s:7000,e:7999}, "Other Expense":{s:8000,e:8999} };
  const r = ranges[type] || {s:9000,e:9999};
  // Extract bare numeric part from IDs (handles both "1000" and "co-abc12-1000")
  const extractNum = (id) => { const m = String(id).match(/(\d{4,})$/); return m ? parseInt(m[1]) : NaN; };
  const existing = accounts.map(a => extractNum(a.id)).filter(n => !isNaN(n) && n >= r.s && n <= r.e);
  return String((existing.length > 0 ? Math.max(...existing) : r.s - 10) + 10);
};

const getPeriodDates = (period) => {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  switch(period) {
    case "This Month": return { start: `${y}-${String(m+1).padStart(2,"0")}-01`, end: formatLocalDate(new Date(y,m+1,0)) };
    case "Last Month": return { start: `${y}-${String(m).padStart(2,"0")}-01`, end: formatLocalDate(new Date(y,m,0)) };
    case "This Quarter": { const q = Math.floor(m/3); return { start: `${y}-${String(q*3+1).padStart(2,"0")}-01`, end: formatLocalDate(new Date(y,q*3+3,0)) }; }
    case "This Year": return { start: `${y}-01-01`, end: `${y}-12-31` };
    case "Last Year": return { start: `${y-1}-01-01`, end: `${y-1}-12-31` };
    default: return { start: `${y}-01-01`, end: `${y}-12-31` };
  }
};

const PERIODS = ["This Month","Last Month","This Quarter","This Year","Last Year","Custom"];

// --- Accounting Sub-Components ---

function AcctModal({ isOpen, onClose, title, children, size = "md" }) {
  useEffect(() => { const h = e => { if (e.key === "Escape") onClose(); }; if (isOpen) document.addEventListener("keydown", h); return () => document.removeEventListener("keydown", h); }, [isOpen, onClose]);
  if (!isOpen) return null;
  const sizes = { sm:"max-w-md", md:"max-w-xl", lg:"max-w-3xl", xl:"max-w-5xl" };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background:"rgba(0,0,0,0.5)" }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={`bg-white rounded-3xl shadow-card border border-indigo-50 w-full ${sizes[size]} flex flex-col`} style={{ maxHeight:"90vh" }}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-indigo-50 shrink-0">
          <h2 className="text-lg font-manrope font-bold text-slate-900">{title}</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-xl text-slate-400 hover:bg-indigo-50/50 transition-colors"><span className="material-icons-outlined text-lg">close</span></button>
        </div>
        <div className="overflow-y-auto flex-1 px-6 py-4">{children}</div>
      </div>
    </div>
  );
}

function AcctTypeBadge({ type }) {
  const map = { Asset:"bg-blue-50 text-blue-700", Liability:"bg-red-50 text-red-700", Equity:"bg-violet-50 text-violet-700", Revenue:"bg-emerald-50 text-emerald-700", Expense:"bg-orange-50 text-orange-700", "Cost of Goods Sold":"bg-orange-50 text-orange-700", "Other Income":"bg-emerald-50 text-emerald-700", "Other Expense":"bg-orange-50 text-orange-700" };
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[type] || "bg-slate-100 text-slate-700"}`}>{type}</span>;
}

function AcctStatusBadge({ status }) {
  const map = { posted: "bg-emerald-50 text-emerald-700", draft: "bg-amber-50 text-amber-700", voided: "bg-red-50 text-red-700" };
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[status] || "bg-slate-100 text-slate-700"}`}>{status}</span>;
}

// --- Chart of Accounts Sub-Page ---
function AcctChartOfAccounts({ accounts, journalEntries, onAdd, onUpdate, onToggle }) {
  const [modal, setModal] = useState(null);
  const [filter, setFilter] = useState("All");
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState({ name:"", type:"Asset", subtype:"Bank", description:"", customType:"", customSubtype:"" });

  const dynamicTypes = getAccountTypes(accounts);
  const dynamicSubtypes = getAccountSubtypes(accounts, form.type === "__custom__" ? form.customType : form.type);

  const withBalances = calcAllBalances(accounts, journalEntries);
  const filtered = withBalances.filter(a => {
    if (!showInactive && !a.is_active) return false;
    if (filter !== "All" && a.type !== filter) return false;
    return true;
  });

  const grouped = {};
  filtered.forEach(a => { if (!grouped[a.type]) grouped[a.type] = []; grouped[a.type].push(a); });

  const openAdd = () => { setForm({ name:"", type:"Asset", subtype:"Bank", description:"", customType:"", customSubtype:"" }); setModal("add"); };
  const openEdit = (a) => { setForm({ name: a.name, type: a.type, subtype: a.subtype, description: a.description || "", customType:"", customSubtype:"" }); setModal(a); };

  const saveAccount = async () => {
    if (!form.name.trim()) return;
    const finalType = form.type === "__custom__" ? form.customType.trim() : form.type;
    const finalSubtype = form.subtype === "__custom__" ? form.customSubtype.trim() : form.subtype;
    if (!finalType) { alert("Please enter an account type."); return; }
    if (modal === "add") {
      const newId = nextAccountId(accounts, finalType);
      await onAdd({ id: newId, name: form.name, type: finalType, subtype: finalSubtype || "", description: form.description, balance: 0, is_active: true });
    } else {
      await onUpdate({ ...modal, name: form.name, type: finalType, subtype: finalSubtype || "", description: form.description });
    }
    setModal(null);
  };

  const allTypes = [...new Set([...dynamicTypes, ...Object.keys(grouped)])];
  const typeOrder = [...DEFAULT_ACCOUNT_TYPES, ...allTypes.filter(t => !DEFAULT_ACCOUNT_TYPES.includes(t))];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">Chart of Accounts</h3>
          <p className="text-sm text-slate-400">Manage your account structure</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowInactive(!showInactive)} className={`text-xs px-3 py-1.5 rounded-lg border ${showInactive ? "bg-indigo-50 border-indigo-200" : "border-indigo-100 text-slate-400"}`}>{showInactive ? "Hide Inactive" : "Show Inactive"}</button>
          <button onClick={openAdd} className="bg-slate-800 text-white text-xs px-4 py-2 rounded-lg hover:bg-slate-700">+ New Account</button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mb-4">
        {["All", ...typeOrder.filter((t, i, a) => a.indexOf(t) === i)].map(t => (
          <button key={t} onClick={() => setFilter(t)} className={`text-xs px-3 py-1.5 rounded-xl border font-medium ${filter === t ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-400 border-indigo-100 hover:border-indigo-300"}`}>{t}</button>
        ))}
      </div>
      {typeOrder.filter((t, i, a) => a.indexOf(t) === i).map(type => {
        const accts = grouped[type];
        if (!accts?.length) return null;
        return (
          <div key={type} className="bg-white rounded-3xl shadow-card border border-indigo-50 overflow-hidden mb-3">
            <div className="px-4 py-2 bg-indigo-50/30 flex items-center justify-between">
              <div className="flex items-center gap-2"><AcctTypeBadge type={type} /><span className="text-xs text-slate-400">{accts.length} accounts</span></div>
              <span className="font-mono text-xs font-semibold text-slate-500">{acctFmt(accts.filter(a=>a.is_active).reduce((s,a)=>s+a.computedBalance,0))}</span>
            </div>
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-400 uppercase bg-indigo-50/30"><tr><th className="px-4 py-2 text-left">Number</th><th className="px-4 py-2 text-left">Name</th><th className="px-4 py-2 text-left">Subtype</th><th className="px-4 py-2 text-right">Balance</th><th className="px-4 py-2 w-20">Actions</th></tr></thead>
              <tbody>
                {accts.map(a => (
                  <tr key={a.id} className="border-t border-indigo-50/50 hover:bg-blue-50/30 cursor-pointer" onClick={() => openEdit(a)}>
                    <td className="px-4 py-2 font-mono text-xs text-slate-400">{a.id}</td>
                    <td className={`px-4 py-2 font-medium ${!a.is_active ? "text-slate-400 line-through" : "text-slate-800"}`}>{a.name}</td>
                    <td className="px-4 py-2 text-xs text-slate-400">{a.subtype}</td>
                    <td className={`px-4 py-2 text-right font-mono text-sm ${a.computedBalance < 0 ? "text-red-600" : "text-slate-800"}`}>{acctFmt(a.computedBalance, true)}</td>
                    <td className="px-4 py-2 text-center">
                      <button onClick={e => { e.stopPropagation(); onToggle(a.id, a.is_active); }} className="text-slate-400 hover:text-slate-700 text-xs">{a.is_active ? "🟢" : "⚪"}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      <AcctModal isOpen={!!modal} onClose={() => setModal(null)} title={modal === "add" ? "New Account" : "Edit Account"} size="md">
        <div className="space-y-3">
          <div><label className="text-xs font-medium text-slate-500">Account Name *</label><input value={form.name} onChange={e => setForm({...form, name:e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mt-1" placeholder="e.g. Operating Checking" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500">Type *</label>
              <select value={form.type} onChange={e => { const v = e.target.value; setForm({...form, type: v, subtype: v === "__custom__" ? "" : (getAccountSubtypes(accounts, v)[0] || ""), customType: v === "__custom__" ? form.customType : "" }); }} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mt-1">
                {dynamicTypes.map(t => <option key={t} value={t}>{t}</option>)}
                <option value="__custom__">+ Add Custom Type...</option>
              </select>
              {form.type === "__custom__" && <input value={form.customType} onChange={e => setForm({...form, customType: e.target.value})} className="w-full border border-indigo-300 rounded-lg px-3 py-2 text-sm mt-1 bg-indigo-50" placeholder="Enter new account type" autoFocus />}
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Subtype</label>
              <select value={form.subtype} onChange={e => setForm({...form, subtype: e.target.value, customSubtype: e.target.value === "__custom__" ? form.customSubtype : ""})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mt-1">
                {(form.type === "__custom__" ? [] : dynamicSubtypes).map(s => <option key={s} value={s}>{s}</option>)}
                <option value="__custom__">+ Add Custom Subtype...</option>
                <option value="">None</option>
              </select>
              {form.subtype === "__custom__" && <input value={form.customSubtype} onChange={e => setForm({...form, customSubtype: e.target.value})} className="w-full border border-indigo-300 rounded-lg px-3 py-2 text-sm mt-1 bg-indigo-50" placeholder="Enter new subtype" />}
            </div>
          </div>
          <div><label className="text-xs font-medium text-slate-500">Description</label><textarea value={form.description} onChange={e => setForm({...form, description:e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mt-1" rows={2} /></div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setModal(null)} className="bg-slate-100 text-slate-500 text-sm px-4 py-2 rounded-lg">Cancel</button>
            <button onClick={saveAccount} className="bg-slate-800 text-white text-sm px-4 py-2 rounded-lg hover:bg-slate-700">{modal === "add" ? "Create" : "Save"}</button>
          </div>
        </div>
      </AcctModal>
    </div>
  );
}

// --- Journal Entries Sub-Page ---
function AcctJournalEntries({ accounts, journalEntries, classes, onAdd, onUpdate, onPost, onVoid, companyId }) {
  const [modal, setModal] = useState(null);
  const [filterStatus, setFilterStatus] = useState("all");
  const [searchProperty, setSearchProperty] = useState("");
  const [properties, setProperties] = useState([]);
  const [form, setForm] = useState({ date: acctToday(), description: "", reference: "", property: "", lines: [{ account_id:"", account_name:"", debit:"", credit:"", class_id:"", memo:"" }, { account_id:"", account_name:"", debit:"", credit:"", class_id:"", memo:"" }] });

  useEffect(() => { let q = supabase.from("properties").select("address"); if (companyId) q = q.eq("company_id", companyId); q.then(r => setProperties((r.data || []).map(p => p.address))); }, [companyId]);

  const filtered = [...journalEntries].sort((a,b) => b.date.localeCompare(a.date))
    .filter(je => filterStatus === "all" || je.status === filterStatus)
    .filter(je => !searchProperty || (je.property || "").toLowerCase().includes(searchProperty.toLowerCase()));
  const counts = { all: journalEntries.length, posted: journalEntries.filter(j=>j.status==="posted").length, draft: journalEntries.filter(j=>j.status==="draft").length, voided: journalEntries.filter(j=>j.status==="voided").length };

  // Get unique properties from existing JEs for the filter dropdown
  const jeProperties = [...new Set(journalEntries.map(je => je.property).filter(Boolean))].sort();

  const openAdd = () => {
    setForm({ date: acctToday(), description: "", reference: "", property: "", lines: [{ account_id:"", account_name:"", debit:"", credit:"", class_id:"", memo:"" }, { account_id:"", account_name:"", debit:"", credit:"", class_id:"", memo:"" }] });
    setModal("add");
  };

  const openEdit = (je) => {
    setForm({ date: je.date, description: je.description, reference: je.reference || "", property: je.property || "", lines: (je.lines || []).map(l => ({ ...l, debit: l.debit || "", credit: l.credit || "" })) });
    setModal({ mode: "edit", je });
  };

  const openView = (je) => setModal({ mode: "view", je });

  const setLine = (i, k, v) => {
    const lines = [...form.lines];
    lines[i] = { ...lines[i], [k]: v };
    if (k === "account_id") { const acct = accounts.find(a => a.id === v); lines[i].account_name = acct?.name || ""; }
    setForm(f => ({ ...f, lines }));
  };

  const addLine = () => setForm(f => ({ ...f, lines: [...f.lines, { account_id:"", account_name:"", debit:"", credit:"", class_id:"", memo:"" }] }));
  const removeLine = (i) => { if (form.lines.length <= 2) return; setForm(f => ({ ...f, lines: f.lines.filter((_,idx) => idx !== i) })); };

  const totalDebit = form.lines.reduce((s,l) => s + (parseFloat(l.debit) || 0), 0);
  const totalCredit = form.lines.reduce((s,l) => s + (parseFloat(l.credit) || 0), 0);
  const validation = validateJE(form.lines.filter(l => l.account_id));

  const saveEntry = async (status) => {
    if (!form.property) { alert("Please select a property."); return; }
    if (!form.description.trim() || !validation.isValid) return;
    const lines = form.lines.filter(l => l.account_id).map(l => ({ ...l, debit: parseFloat(l.debit) || 0, credit: parseFloat(l.credit) || 0 }));
    if (modal === "add") {
      await onAdd({ ...form, lines, status });
    } else if (modal?.mode === "edit") {
      await onUpdate({ ...modal.je, ...form, lines, status: status || modal.je.status });
    }
    setModal(null);
  };

  const JEFormUI = () => (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <div><label className="text-xs font-medium text-slate-500">Date *</label><input type="date" value={form.date} onChange={e => setForm({...form, date:e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mt-1" /></div>
        <div><label className="text-xs font-medium text-slate-500">Reference</label><input value={form.reference} onChange={e => setForm({...form, reference:e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mt-1" placeholder="Invoice #, Check #..." /></div>
        <div><label className="text-xs font-medium text-slate-500">Property *</label><select value={form.property} onChange={e => setForm({...form, property:e.target.value})} className={`w-full border rounded-lg px-3 py-2 text-sm mt-1 ${!form.property ? "border-red-300 bg-red-50" : "border-indigo-100"}`}><option value="">-- Select Property --</option>{properties.map(p => <option key={p} value={p}>{p}</option>)}</select></div>
        <div className="col-span-3"><label className="text-xs font-medium text-slate-500">Description *</label><input value={form.description} onChange={e => setForm({...form, description:e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mt-1" placeholder="What is this entry for?" /></div>
      </div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-slate-500 uppercase">Journal Entry Lines</p>
        <button onClick={addLine} className="text-xs text-slate-600 hover:text-slate-800">+ Add Line</button>
      </div>
      <div className="rounded-xl border border-indigo-100 overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="bg-indigo-50/30 border-b border-indigo-100"><th className="px-3 py-2 text-left text-xs font-semibold text-slate-400 w-48">Account</th><th className="px-3 py-2 text-left text-xs font-semibold text-slate-400 w-32">Class</th><th className="px-3 py-2 text-left text-xs font-semibold text-slate-400">Memo</th><th className="px-3 py-2 text-right text-xs font-semibold text-slate-400 w-28">Debit</th><th className="px-3 py-2 text-right text-xs font-semibold text-slate-400 w-28">Credit</th><th className="px-3 py-2 w-8" /></tr></thead>
          <tbody>
            {form.lines.map((line, i) => (
              <tr key={i} className="border-b border-indigo-50/50">
                <td className="px-2 py-1.5"><select value={line.account_id} onChange={e => setLine(i,"account_id",e.target.value)} className="w-full border border-indigo-100 rounded-2xl px-2 py-1.5 text-xs bg-white"><option value="">-- Select --</option>{ACCOUNT_TYPES.map(type => <optgroup key={type} label={type}>{accounts.filter(a=>a.type===type&&a.is_active).map(a => <option key={a.id} value={a.id}>{a.id} - {a.name}</option>)}</optgroup>)}</select></td>
                <td className="px-2 py-1.5"><select value={line.class_id || ""} onChange={e => setLine(i,"class_id",e.target.value||null)} className="w-full border border-indigo-100 rounded-2xl px-2 py-1.5 text-xs bg-white"><option value="">No Class</option>{classes.filter(c=>c.is_active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></td>
                <td className="px-2 py-1.5"><input value={line.memo||""} onChange={e => setLine(i,"memo",e.target.value)} placeholder="Optional..." className="w-full border border-indigo-100 rounded-2xl px-2 py-1.5 text-xs bg-white" /></td>
                <td className="px-2 py-1.5"><input type="number" step="0.01" min="0" value={line.debit} onChange={e => { setLine(i,"debit",e.target.value); if(e.target.value) setLine(i,"credit",""); }} placeholder="0.00" className="w-full border border-indigo-100 rounded-2xl px-2 py-1.5 text-xs text-right bg-white font-mono" /></td>
                <td className="px-2 py-1.5"><input type="number" step="0.01" min="0" value={line.credit} onChange={e => { setLine(i,"credit",e.target.value); if(e.target.value) setLine(i,"debit",""); }} placeholder="0.00" className="w-full border border-indigo-100 rounded-2xl px-2 py-1.5 text-xs text-right bg-white font-mono" /></td>
                <td className="px-2 py-1.5"><button onClick={() => removeLine(i)} disabled={form.lines.length<=2} className="text-slate-300 hover:text-red-500 disabled:opacity-20">✕</button></td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr className="bg-indigo-50/30 border-t border-indigo-100"><td colSpan={3} className="px-3 py-2 text-xs font-semibold text-slate-500 text-right">Totals</td><td className={`px-3 py-2 text-xs font-mono font-bold text-right ${validation.isValid?"text-emerald-700":"text-red-600"}`}>{acctFmt(totalDebit)}</td><td className={`px-3 py-2 text-xs font-mono font-bold text-right ${validation.isValid?"text-emerald-700":"text-red-600"}`}>{acctFmt(totalCredit)}</td><td /></tr></tfoot>
        </table>
      </div>
      {!validation.isValid && totalDebit > 0 && totalCredit > 0 && <div className="text-xs text-red-600 bg-red-50 rounded-2xl px-3 py-2">⚠ Out of balance by {acctFmt(validation.difference)}</div>}
      {validation.isValid && totalDebit > 0 && <div className="text-xs text-emerald-600 bg-emerald-50 rounded-2xl px-3 py-2">✓ Balanced — {acctFmt(totalDebit)}</div>}
      <div className="flex justify-between pt-2">
        <button onClick={() => setModal(null)} className="bg-slate-100 text-slate-500 text-sm px-4 py-2 rounded-lg">Cancel</button>
        <div className="flex gap-2">
          <button onClick={() => saveEntry("draft")} disabled={!form.description || !form.property || !validation.isValid} className="bg-slate-200 text-slate-700 text-sm px-4 py-2 rounded-lg disabled:opacity-50">Save Draft</button>
          <button onClick={() => saveEntry("posted")} disabled={!form.description || !form.property || !validation.isValid} className="bg-emerald-600 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50 hover:bg-emerald-700">Post Entry</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-4">
        <div><h3 className="text-lg font-semibold text-slate-900">Journal Entries</h3><p className="text-sm text-slate-400">Record and manage financial transactions</p></div>
        <button onClick={openAdd} className="bg-slate-800 text-white text-xs px-4 py-2 rounded-lg hover:bg-slate-700">+ New Entry</button>
      </div>
      <div className="flex gap-2 mb-4">
        {[{k:"all",l:`All (${counts.all})`},{k:"posted",l:`Posted (${counts.posted})`},{k:"draft",l:`Drafts (${counts.draft})`},{k:"voided",l:`Voided (${counts.voided})`}].map(f => (
          <button key={f.k} onClick={() => setFilterStatus(f.k)} className={`text-xs px-3 py-1.5 rounded-xl border font-medium ${filterStatus === f.k ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-400 border-indigo-100"}`}>{f.l}</button>
        ))}
        <select value={searchProperty} onChange={e => setSearchProperty(e.target.value)} className="text-xs px-3 py-1.5 rounded-xl border border-indigo-100 bg-white text-slate-500 ml-auto">
          <option value="">All Properties</option>
          {jeProperties.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      <div className="bg-white rounded-3xl shadow-card border border-indigo-50 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-400 uppercase bg-indigo-50/30"><tr><th className="px-4 py-2 text-left">Entry #</th><th className="px-4 py-2 text-left">Date</th><th className="px-4 py-2 text-left">Property</th><th className="px-4 py-2 text-left">Description</th><th className="px-4 py-2 text-left">Ref</th><th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2 text-right">Amount</th><th className="px-4 py-2">Actions</th></tr></thead>
          <tbody>
            {filtered.map(je => {
              const total = (je.lines || []).reduce((s,l) => s + safeNum(l.debit), 0);
              return (
                <tr key={je.id} className="border-t border-indigo-50/50 hover:bg-blue-50/30 cursor-pointer" onClick={() => openView(je)}>
                  <td className="px-4 py-2 font-mono text-xs font-semibold text-slate-700">{je.number}</td>
                  <td className="px-4 py-2 text-slate-500">{acctFmtDate(je.date)}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">{je.property || "—"}</td>
                  <td className="px-4 py-2 font-medium text-slate-800">{je.description}</td>
                  <td className="px-4 py-2 text-xs text-slate-400">{je.reference || "—"}</td>
                  <td className="px-4 py-2"><AcctStatusBadge status={je.status} /></td>
                  <td className="px-4 py-2 text-right font-mono text-sm font-semibold">{acctFmt(total)}</td>
                  <td className="px-4 py-2 text-center">
                    <div className="flex gap-1 justify-center" onClick={e => e.stopPropagation()}>
                      {je.status === "draft" && <button onClick={() => onPost(je.id)} className="text-xs text-emerald-600 hover:underline">Post</button>}
                      {je.status === "posted" && <button onClick={() => onVoid(je.id)} className="text-xs text-red-500 hover:underline">Void</button>}
                      {je.status !== "voided" && <button onClick={() => openEdit(je)} className="text-xs text-indigo-600 hover:underline">Edit</button>}
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">No journal entries found</td></tr>}
          </tbody>
        </table>
      </div>
      {/* Add/Edit Modal */}
      <AcctModal isOpen={modal === "add" || modal?.mode === "edit"} onClose={() => setModal(null)} title={modal === "add" ? "New Journal Entry" : `Edit: ${modal?.je?.number}`} size="xl">
        <JEFormUI />
      </AcctModal>
      {/* View Modal */}
      {modal?.mode === "view" && (
        <AcctModal isOpen={true} onClose={() => setModal(null)} title={`Journal Entry: ${modal.je.number}`} size="xl">
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3 bg-indigo-50/30 rounded-3xl p-4">
              <div><p className="text-xs text-slate-400">Entry #</p><p className="font-mono font-semibold">{modal.je.number}</p></div>
              <div><p className="text-xs text-slate-400">Date</p><p className="font-semibold">{acctFmtDate(modal.je.date)}</p></div>
              <div><p className="text-xs text-slate-400">Property</p><p className="font-semibold">{modal.je.property || "—"}</p></div>
              <div className="col-span-2"><p className="text-xs text-slate-400">Description</p><p className="font-semibold">{modal.je.description}</p></div>
              <div><p className="text-xs text-slate-400">Status</p><AcctStatusBadge status={modal.je.status} /></div>
            </div>
            <table className="w-full text-sm rounded-xl border border-indigo-100 overflow-hidden">
              <thead><tr className="bg-indigo-50/30"><th className="px-4 py-2 text-left text-xs font-semibold text-slate-400">Account</th><th className="px-4 py-2 text-left text-xs font-semibold text-slate-400">Class</th><th className="px-4 py-2 text-left text-xs font-semibold text-slate-400">Memo</th><th className="px-4 py-2 text-right text-xs font-semibold text-slate-400">Debit</th><th className="px-4 py-2 text-right text-xs font-semibold text-slate-400">Credit</th></tr></thead>
              <tbody>
                {(modal.je.lines || []).map((l,i) => {
                  const cls = classes.find(c => c.id === l.class_id);
                  return (
                    <tr key={i} className="border-t border-indigo-50/50">
                      <td className="px-4 py-2"><span className="font-mono text-xs text-slate-400 mr-1">{l.account_id}</span> {l.account_name}</td>
                      <td className="px-4 py-2 text-xs">{cls ? <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{background:cls.color}} />{cls.name}</span> : "—"}</td>
                      <td className="px-4 py-2 text-xs text-slate-400">{l.memo || "—"}</td>
                      <td className="px-4 py-2 text-right font-mono">{safeNum(l.debit) > 0 ? acctFmt(l.debit) : ""}</td>
                      <td className="px-4 py-2 text-right font-mono">{safeNum(l.credit) > 0 ? acctFmt(l.credit) : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="flex gap-2">
              {modal.je.status === "draft" && <button onClick={() => { onPost(modal.je.id); setModal(null); }} className="bg-emerald-600 text-white text-xs px-3 py-1.5 rounded-lg">Post</button>}
              {modal.je.status === "posted" && <button onClick={() => { onVoid(modal.je.id); setModal(null); }} className="bg-red-600 text-white text-xs px-3 py-1.5 rounded-lg">Void</button>}
              {modal.je.status !== "voided" && <button onClick={() => openEdit(modal.je)} className="bg-slate-200 text-slate-700 text-xs px-3 py-1.5 rounded-lg">Edit</button>}
            </div>
          </div>
        </AcctModal>
      )}
    </div>
  );
}

// --- Class Tracking Sub-Page ---
function AcctClassTracking({ accounts, journalEntries, classes, onAdd, onUpdate, onToggle }) {
  const [modal, setModal] = useState(null);
  const [period, setPeriod] = useState("This Year");
  const [form, setForm] = useState({ name:"", description:"", color:"#3B82F6" });
  const COLORS = ["#3B82F6","#10B981","#F59E0B","#EF4444","#8B5CF6","#06B6D4","#F97316","#EC4899"];

  const { start, end } = getPeriodDates(period);
  const classReport = getClassReport(accounts, journalEntries, classes, start, end);
  const activeReport = classReport.filter(c => c.is_active);
  const totalRev = activeReport.reduce((s,c) => s + c.revenue, 0);
  const totalExp = activeReport.reduce((s,c) => s + c.expenses, 0);
  const totalNet = activeReport.reduce((s,c) => s + c.netIncome, 0);

  const openAdd = () => { setForm({ name:"", description:"", color:"#3B82F6" }); setModal("add"); };
  const openEdit = (cls) => { setForm({ name: cls.name, description: cls.description || "", color: cls.color || "#3B82F6" }); setModal({ mode:"edit", cls }); };

  const saveClass = async () => {
    if (!form.name.trim()) return;
    if (modal === "add") {
      await onAdd({ id: `CLS-${shortId().slice(0,8)}`, ...form, is_active: true });
    } else {
      await onUpdate({ ...modal.cls, ...form });
    }
    setModal(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-4">
        <div><h3 className="text-lg font-semibold text-slate-900">Class Tracking</h3><p className="text-sm text-slate-400">Track by unit, property, or department</p></div>
        <button onClick={openAdd} className="bg-slate-800 text-white text-xs px-4 py-2 rounded-lg hover:bg-slate-700">+ New Class</button>
      </div>
      <div className="flex flex-wrap gap-2 mb-4">
        {PERIODS.map(p => <button key={p} onClick={() => setPeriod(p)} className={`text-xs px-3 py-1.5 rounded-xl border font-medium ${period === p ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-400 border-indigo-100"}`}>{p}</button>)}
      </div>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-emerald-50 border border-emerald-100 rounded-3xl p-4"><p className="text-xs text-emerald-600 font-medium">Revenue</p><p className="text-xl font-bold text-emerald-800 font-mono mt-1">{acctFmt(totalRev)}</p></div>
        <div className="bg-red-50 border border-red-100 rounded-3xl p-4"><p className="text-xs text-red-600 font-medium">Expenses</p><p className="text-xl font-bold text-red-800 font-mono mt-1">{acctFmt(totalExp)}</p></div>
        <div className={`border rounded-3xl p-4 ${totalNet >= 0 ? "bg-blue-50 border-blue-100" : "bg-orange-50 border-orange-100"}`}><p className={`text-xs font-medium ${totalNet >= 0 ? "text-blue-600" : "text-orange-600"}`}>Net Income</p><p className={`text-xl font-bold font-mono mt-1 ${totalNet >= 0 ? "text-blue-800" : "text-orange-800"}`}>{acctFmt(totalNet, true)}</p></div>
      </div>
      <div className="bg-white rounded-3xl shadow-card border border-indigo-50 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-400 uppercase bg-indigo-50/30"><tr><th className="px-4 py-2 text-left">Class</th><th className="px-4 py-2 text-left">Description</th><th className="px-4 py-2 text-right">Revenue</th><th className="px-4 py-2 text-right">Expenses</th><th className="px-4 py-2 text-right">Net Income</th><th className="px-4 py-2 w-16" /></tr></thead>
          <tbody>
            {classReport.map(c => (
              <tr key={c.id} className="border-t border-indigo-50/50 hover:bg-blue-50/30">
                <td className="px-4 py-2"><div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full" style={{background:c.color}} /><span className={`font-medium ${!c.is_active?"text-slate-400 line-through":"text-slate-800"}`}>{c.name}</span></div></td>
                <td className="px-4 py-2 text-xs text-slate-400">{c.description}</td>
                <td className="px-4 py-2 text-right font-mono text-sm text-emerald-700">{c.revenue > 0 ? acctFmt(c.revenue) : "—"}</td>
                <td className="px-4 py-2 text-right font-mono text-sm text-red-600">{c.expenses > 0 ? acctFmt(c.expenses) : "—"}</td>
                <td className={`px-4 py-2 text-right font-mono text-sm font-bold ${c.netIncome >= 0 ? "text-blue-700" : "text-red-700"}`}>{acctFmt(c.netIncome, true)}</td>
                <td className="px-4 py-2 flex gap-1"><button onClick={() => openEdit(c)} className="text-xs text-indigo-600 hover:underline">Edit</button><button onClick={() => onToggle(c.id, c.is_active)} className="text-xs">{c.is_active ? "🟢" : "⚪"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <AcctModal isOpen={!!modal} onClose={() => setModal(null)} title={modal === "add" ? "New Class" : "Edit Class"} size="sm">
        <div className="space-y-3">
          <div><label className="text-xs font-medium text-slate-500">Name *</label><input placeholder="e.g. 123 Main St" value={form.name} onChange={e => setForm({...form,name:e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mt-1" /></div>
          <div><label className="text-xs font-medium text-slate-500">Description</label><textarea value={form.description} onChange={e => setForm({...form,description:e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mt-1" rows={2} /></div>
          <div><label className="text-xs font-medium text-slate-500 block mb-2">Color</label><div className="flex gap-2 flex-wrap">{COLORS.map(c => <button key={c} type="button" onClick={() => setForm({...form,color:c})} className={`w-7 h-7 rounded-full border-2 ${form.color===c?"border-gray-800 scale-110":"border-transparent"}`} style={{background:c}} />)}</div></div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setModal(null)} className="bg-slate-100 text-slate-500 text-sm px-4 py-2 rounded-lg">Cancel</button>
            <button onClick={saveClass} className="bg-slate-800 text-white text-sm px-4 py-2 rounded-lg">{modal === "add" ? "Create" : "Save"}</button>
          </div>
        </div>
      </AcctModal>
    </div>
  );
}

// --- Reports Sub-Page ---
function AcctReports({ accounts, journalEntries, classes, companyName }) {
  const [activeReport, setActiveReport] = useState("pl");
  const [period, setPeriod] = useState("This Year");
  const [customDates, setCustomDates] = useState({ start: `${new Date().getFullYear()}-01-01`, end: `${new Date().getFullYear()}-12-31` });
  const [asOfDate, setAsOfDate] = useState(acctToday());
  const [selectedAccountId, setSelectedAccountId] = useState(accounts[0]?.id || "");
  const [classFilter, setClassFilter] = useState("");
  const [showARSub, setShowARSub] = useState(false);

  const { start, end } = period === "Custom" ? customDates : getPeriodDates(period);

  const PeriodPicker = () => (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      {PERIODS.map(p => <button key={p} onClick={() => setPeriod(p)} className={`text-xs px-3 py-1.5 rounded-xl border font-medium ${period === p ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-400 border-indigo-100"}`}>{p}</button>)}
      {period === "Custom" && <><input type="date" value={customDates.start} onChange={e => setCustomDates(d=>({...d,start:e.target.value}))} className="border border-indigo-100 rounded-xl px-3 py-1.5 text-xs" /><span className="text-slate-400 text-xs">to</span><input type="date" value={customDates.end} onChange={e => setCustomDates(d=>({...d,end:e.target.value}))} className="border border-indigo-100 rounded-xl px-3 py-1.5 text-xs" /></>}
    </div>
  );

  // P&L
  const plData = getPLData(accounts, journalEntries, start, end, classFilter || null);
  // Balance Sheet
  const bsData = getBalanceSheetData(accounts, journalEntries, asOfDate);
  const bsBalanced = Math.abs(bsData.totalAssets - (bsData.totalLiabilities + bsData.totalEquity)) < 0.01;
  // Trial Balance
  const tbData = getTrialBalance(accounts, journalEntries, asOfDate);
  const tbTotalDebit = tbData.reduce((s,a) => s + a.debitBalance, 0);
  const tbTotalCredit = tbData.reduce((s,a) => s + a.creditBalance, 0);
  const tbBalanced = Math.abs(tbTotalDebit - tbTotalCredit) < 0.01;
  // General Ledger
  const glLines = getGeneralLedger(selectedAccountId, accounts, journalEntries);
  const glAccount = accounts.find(a => a.id === selectedAccountId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-4">
        <div><h3 className="text-lg font-semibold text-slate-900">Financial Reports</h3><p className="text-sm text-slate-400">P&L, Balance Sheet, Trial Balance, General Ledger</p></div>
        <button onClick={() => window.print()} className="bg-slate-100 text-slate-500 text-xs px-3 py-1.5 rounded-2xl hover:bg-slate-100">🖨️ Print</button>
      </div>
      <div className="flex gap-1 border-b border-indigo-50 mb-4 flex-wrap">
        {[{id:"pl",l:"Profit & Loss"},{id:"bs",l:"Balance Sheet"},{id:"ar",l:"AR Aging"},{id:"tb",l:"Trial Balance"},{id:"gl",l:"General Ledger"}].map(t => (
          <button key={t.id} onClick={() => setActiveReport(t.id)} className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px ${activeReport===t.id ? "border-slate-800 text-slate-800" : "border-transparent text-slate-400 hover:text-slate-500"}`}>{t.l}</button>
        ))}
      </div>

      {/* P&L */}
      {activeReport === "pl" && (
        <div>
          <PeriodPicker />
          <div className="flex gap-2 mb-4"><select value={classFilter} onChange={e => setClassFilter(e.target.value)} className="border border-indigo-100 rounded-xl px-3 py-1.5 text-sm bg-white"><option value="">All Classes</option>{classes.filter(c=>c.is_active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-emerald-50 border border-emerald-100 rounded-3xl p-4"><p className="text-xs text-emerald-600">Total Revenue</p><p className="text-xl font-bold text-emerald-800 font-mono mt-1">{acctFmt(plData.totalRevenue)}</p></div>
            <div className="bg-red-50 border border-red-100 rounded-3xl p-4"><p className="text-xs text-red-600">Total Expenses</p><p className="text-xl font-bold text-red-800 font-mono mt-1">{acctFmt(plData.totalExpenses)}</p></div>
            <div className={`border rounded-3xl p-4 ${plData.netIncome>=0?"bg-blue-50 border-blue-100":"bg-orange-50 border-orange-100"}`}><p className={`text-xs ${plData.netIncome>=0?"text-blue-600":"text-orange-600"}`}>Net Income</p><p className={`text-xl font-bold font-mono mt-1 ${plData.netIncome>=0?"text-blue-800":"text-orange-800"}`}>{acctFmt(plData.netIncome, true)}</p></div>
          </div>
          <div className="bg-white rounded-3xl shadow-card border border-indigo-50 p-5">
            <div className="text-center mb-4"><p className="text-xs text-slate-400 uppercase tracking-widest">Profit & Loss Statement</p><h4 className="text-base font-bold text-slate-900">{companyName}</h4><p className="text-sm text-slate-400">{acctFmtDate(start)} — {acctFmtDate(end)}</p></div>
            <div className="border-t pt-3"><p className="text-sm font-bold text-slate-800 uppercase mb-2">Income</p>{plData.revenue.map(a => <div key={a.id} className="flex justify-between py-1 px-2 hover:bg-indigo-50/30 rounded"><span className="text-sm text-slate-700">{a.name}</span><span className="font-mono text-sm">{acctFmt(a.amount)}</span></div>)}<div className="flex justify-between py-2 border-t-2 border-indigo-200 mt-2 font-bold"><span>Total Income</span><span className="font-mono text-emerald-700">{acctFmt(plData.totalRevenue)}</span></div></div>
            <div className="border-t pt-3 mt-3"><p className="text-sm font-bold text-slate-800 uppercase mb-2">Expenses</p>{plData.expenses.map(a => <div key={a.id} className="flex justify-between py-1 px-2 hover:bg-indigo-50/30 rounded"><span className="text-sm text-slate-700">{a.name}</span><span className="font-mono text-sm">{acctFmt(a.amount)}</span></div>)}<div className="flex justify-between py-2 border-t-2 border-indigo-200 mt-2 font-bold"><span>Total Expenses</span><span className="font-mono text-red-600">{acctFmt(plData.totalExpenses)}</span></div></div>
            <div className={`flex justify-between py-3 mt-3 border-t-4 border-gray-800 px-2 rounded-b-xl font-black ${plData.netIncome>=0?"bg-emerald-50":"bg-red-50"}`}><span>Net Income</span><span className={`font-mono ${plData.netIncome>=0?"text-emerald-700":"text-red-700"}`}>{acctFmt(plData.netIncome, true)}</span></div>
          </div>
        </div>
      )}

      {/* Balance Sheet */}
      {activeReport === "bs" && (
        <div>
          <div className="flex items-center gap-3 mb-4"><span className="text-sm text-slate-500">As of:</span><input type="date" value={asOfDate} onChange={e => setAsOfDate(e.target.value)} className="border border-indigo-100 rounded-xl px-3 py-1.5 text-sm" />{bsBalanced ? <span className="text-xs text-emerald-600 bg-emerald-50 px-3 py-1.5 rounded-xl">✓ Balanced</span> : <span className="text-xs text-red-600 bg-red-50 px-3 py-1.5 rounded-xl">⚠ Out of Balance</span>}</div>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white rounded-3xl shadow-card border border-indigo-50 p-5">
              <p className="text-base font-black text-slate-900 mb-3">ASSETS</p>
              {bsData.assets.filter(a=>a.amount!==0).map(a => (
                <div key={a.id}>
                  <div className="flex justify-between py-1 px-2 hover:bg-indigo-50/30 rounded cursor-pointer" onClick={() => a.id === "1100" && setShowARSub(!showARSub)}>
                    <span className="text-sm text-slate-700">{a.name}{a.id === "1100" && bsData.arByTenant?.length > 0 && <span className="text-xs text-indigo-500 ml-1">{showARSub ? "▾" : "▸"} {bsData.arByTenant.length} tenants</span>}</span>
                    <span className={`font-mono text-sm ${a.amount<0?"text-red-600":"text-slate-800"}`}>{acctFmt(a.amount, true)}</span>
                  </div>
                  {a.id === "1100" && showARSub && bsData.arByTenant?.length > 0 && (
                    <div className="ml-4 mb-2 border-l-2 border-indigo-200 pl-3">
                      <div className="text-xs font-bold text-indigo-600 uppercase tracking-wide py-1">Tenant Sub-Ledger</div>
                      {bsData.arByTenant.map((t, i) => (
                        <div key={i} className="flex justify-between py-0.5 px-1">
                          <span className="text-xs text-slate-500">{t.tenant}</span>
                          <span className={`font-mono text-xs ${t.balance < 0 ? "text-green-600" : "text-slate-700"}`}>{acctFmt(t.balance, true)}</span>
                        </div>
                      ))}
                      <div className="flex justify-between py-1 px-1 border-t border-indigo-200 mt-1">
                        <span className="text-xs font-bold text-indigo-700">Sub-Ledger Total</span>
                        <span className="font-mono text-xs font-bold text-indigo-700">{acctFmt(bsData.arByTenant.reduce((s,t) => s + t.balance, 0), true)}</span>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              <div className="flex justify-between py-3 border-t-4 border-gray-800 bg-blue-50 px-2 rounded-xl mt-3 font-black"><span>TOTAL ASSETS</span><span className="font-mono text-blue-700">{acctFmt(bsData.totalAssets)}</span></div>
            </div>
            <div className="bg-white rounded-3xl shadow-card border border-indigo-50 p-5">
              <p className="text-base font-black text-slate-900 mb-3">LIABILITIES & EQUITY</p>
              <p className="text-xs font-bold text-slate-400 uppercase mt-2 mb-1">Liabilities</p>
              {bsData.liabilities.filter(a=>a.amount!==0).map(a => <div key={a.id} className="flex justify-between py-1 px-2 hover:bg-indigo-50/30 rounded"><span className="text-sm text-slate-700">{a.name}</span><span className="font-mono text-sm">{acctFmt(a.amount, true)}</span></div>)}
              <p className="text-xs font-bold text-slate-400 uppercase mt-3 mb-1">Equity</p>
              {bsData.equity.filter(a=>a.amount!==0).map(a => <div key={a.id} className="flex justify-between py-1 px-2 hover:bg-indigo-50/30 rounded"><span className="text-sm text-slate-700">{a.name}</span><span className="font-mono text-sm">{acctFmt(a.amount, true)}</span></div>)}
              {bsData.netIncome !== 0 && <div className="flex justify-between py-1 px-2 hover:bg-indigo-50/30 rounded"><span className="text-sm text-slate-700 italic">Net Income (Current)</span><span className="font-mono text-sm">{acctFmt(bsData.netIncome, true)}</span></div>}
              <div className="flex justify-between py-3 border-t-4 border-gray-800 bg-violet-50 px-2 rounded-xl mt-3 font-black"><span>TOTAL L + E</span><span className="font-mono text-violet-700">{acctFmt(bsData.totalLiabilities + bsData.totalEquity)}</span></div>
            </div>
          </div>
        </div>
      )}

      {/* AR Aging Report */}
      {activeReport === "ar" && (
        <div>
          <div className="flex items-center gap-3 mb-4"><span className="text-sm text-slate-500">As of:</span><input type="date" value={asOfDate} onChange={e => setAsOfDate(e.target.value)} className="border border-indigo-100 rounded-xl px-3 py-1.5 text-sm" /></div>

          {/* Aging Summary Buckets */}
          <div className="grid grid-cols-5 gap-3 mb-5">
            {[
              { label: "Current (0-30)", val: bsData.arAging?.current || 0, color: "text-green-700 bg-green-50" },
              { label: "31-60 Days", val: bsData.arAging?.days30 || 0, color: "text-yellow-700 bg-yellow-50" },
              { label: "61-90 Days", val: bsData.arAging?.days60 || 0, color: "text-orange-700 bg-orange-50" },
              { label: "91-120 Days", val: bsData.arAging?.days90 || 0, color: "text-red-600 bg-red-50" },
              { label: "120+ Days", val: bsData.arAging?.over90 || 0, color: "text-red-800 bg-red-100" },
            ].map((b, i) => (
              <div key={i} className={`rounded-xl p-3 ${b.color}`}>
                <div className="text-xs font-medium opacity-75">{b.label}</div>
                <div className="text-lg font-bold font-mono">{acctFmt(b.val)}</div>
              </div>
            ))}
          </div>

          {/* Total AR */}
          <div className="bg-indigo-50 rounded-3xl p-4 mb-5 flex justify-between items-center">
            <div><span className="text-sm font-bold text-indigo-800">Total Accounts Receivable</span><span className="text-xs text-indigo-500 ml-2">(Account 1100)</span></div>
            <span className="text-xl font-black font-mono text-indigo-800">{acctFmt((bsData.arAging?.current || 0) + (bsData.arAging?.days30 || 0) + (bsData.arAging?.days60 || 0) + (bsData.arAging?.days90 || 0) + (bsData.arAging?.over90 || 0))}</span>
          </div>

          {/* Per-Tenant Aging Table */}
          <div className="bg-white rounded-3xl shadow-card border border-indigo-50 overflow-hidden">
            <div className="px-5 py-3 bg-indigo-50/30 border-b border-indigo-50">
              <h4 className="text-sm font-bold text-slate-800">AR Aging by Tenant</h4>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-indigo-50 text-xs text-slate-400 uppercase">
                  <th className="px-4 py-2 text-left">Tenant</th>
                  <th className="px-3 py-2 text-right">Current</th>
                  <th className="px-3 py-2 text-right">31-60</th>
                  <th className="px-3 py-2 text-right">61-90</th>
                  <th className="px-3 py-2 text-right">91-120</th>
                  <th className="px-3 py-2 text-right">120+</th>
                  <th className="px-4 py-2 text-right font-bold">Total</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(bsData.arAgingByTenant || {}).filter(([,v]) => v.total > 0.01).sort((a, b) => b[1].total - a[1].total).map(([tenant, aging], i) => (
                  <tr key={i} className="border-b border-indigo-50/50 hover:bg-indigo-50/30">
                    <td className="px-4 py-2 font-medium text-slate-800">{tenant}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{aging.current > 0 ? acctFmt(aging.current) : "—"}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-yellow-700">{aging.days30 > 0 ? acctFmt(aging.days30) : "—"}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-orange-700">{aging.days60 > 0 ? acctFmt(aging.days60) : "—"}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-red-600">{aging.days90 > 0 ? acctFmt(aging.days90) : "—"}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-red-800">{aging.over90 > 0 ? acctFmt(aging.over90) : "—"}</td>
                    <td className="px-4 py-2 text-right font-mono text-sm font-bold">{acctFmt(aging.total)}</td>
                  </tr>
                ))}
                {Object.keys(bsData.arAgingByTenant || {}).length === 0 && (
                  <tr><td colSpan="7" className="px-4 py-6 text-center text-slate-400">No outstanding receivables</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Tenant Sub-Ledger (Net Balances) */}
          {bsData.arByTenant?.length > 0 && (
            <div className="bg-white rounded-3xl shadow-card border border-indigo-50 overflow-hidden mt-4">
              <div className="px-5 py-3 bg-indigo-50/30 border-b border-indigo-50">
                <h4 className="text-sm font-bold text-slate-800">Tenant Sub-Ledger (Net AR Balance)</h4>
                <p className="text-xs text-slate-400">Charges minus payments per tenant — rolls up to master AR on Balance Sheet</p>
              </div>
              <div className="p-4 space-y-1">
                {bsData.arByTenant.map((t, i) => (
                  <div key={i} className="flex justify-between py-1.5 px-3 rounded hover:bg-indigo-50/30">
                    <span className="text-sm text-slate-700">{t.tenant}</span>
                    <span className={`font-mono text-sm font-medium ${t.balance > 0 ? "text-red-600" : "text-green-600"}`}>{t.balance > 0 ? acctFmt(t.balance) + " owed" : acctFmt(Math.abs(t.balance)) + " credit"}</span>
                  </div>
                ))}
                <div className="flex justify-between py-2 px-3 border-t-2 border-indigo-100 mt-2 font-bold">
                  <span className="text-sm text-slate-900">Total AR (must match Balance Sheet 1100)</span>
                  <span className="font-mono text-sm text-indigo-700">{acctFmt(bsData.arByTenant.reduce((s, t) => s + t.balance, 0))}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Trial Balance */}
      {activeReport === "tb" && (
        <div>
          <div className="flex items-center gap-3 mb-4"><span className="text-sm text-slate-500">As of:</span><input type="date" value={asOfDate} onChange={e => setAsOfDate(e.target.value)} className="border border-indigo-100 rounded-xl px-3 py-1.5 text-sm" />{tbBalanced ? <span className="text-xs text-emerald-600 bg-emerald-50 px-3 py-1.5 rounded-xl">✓ Balanced</span> : <span className="text-xs text-red-600 bg-red-50 px-3 py-1.5 rounded-xl">⚠ Out of Balance by {acctFmt(Math.abs(tbTotalDebit - tbTotalCredit))}</span>}</div>
          <div className="bg-white rounded-3xl shadow-card border border-indigo-50 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-indigo-50/30"><tr><th className="px-4 py-3 text-left text-xs font-semibold text-slate-400">#</th><th className="px-4 py-3 text-left text-xs font-semibold text-slate-400">Account</th><th className="px-4 py-3 text-left text-xs font-semibold text-slate-400">Type</th><th className="px-4 py-3 text-right text-xs font-semibold text-slate-400">Debit</th><th className="px-4 py-3 text-right text-xs font-semibold text-slate-400">Credit</th></tr></thead>
              <tbody>{tbData.map(a => <tr key={a.id} className="border-t border-indigo-50/50"><td className="px-4 py-2 font-mono text-xs text-slate-400">{a.id}</td><td className="px-4 py-2 text-slate-700 font-medium">{a.name}</td><td className="px-4 py-2 text-xs text-slate-400">{a.type}</td><td className="px-4 py-2 text-right font-mono">{a.debitBalance > 0 ? acctFmt(a.debitBalance) : ""}</td><td className="px-4 py-2 text-right font-mono">{a.creditBalance > 0 ? acctFmt(a.creditBalance) : ""}</td></tr>)}</tbody>
              <tfoot><tr className="border-t-2 border-gray-800 bg-indigo-50/30"><td colSpan={3} className="px-4 py-3 text-right font-bold">TOTALS</td><td className={`px-4 py-3 text-right font-mono font-black ${tbBalanced?"text-emerald-700":"text-red-600"}`}>{acctFmt(tbTotalDebit)}</td><td className={`px-4 py-3 text-right font-mono font-black ${tbBalanced?"text-emerald-700":"text-red-600"}`}>{acctFmt(tbTotalCredit)}</td></tr></tfoot>
            </table>
          </div>
        </div>
      )}

      {/* General Ledger */}
      {activeReport === "gl" && (
        <div>
          <div className="flex items-center gap-3 mb-4">
            <span className="text-sm text-slate-500">Account:</span>
            <select value={selectedAccountId} onChange={e => setSelectedAccountId(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm bg-white min-w-56">
              {ACCOUNT_TYPES.map(type => <optgroup key={type} label={type}>{accounts.filter(a=>a.type===type&&a.is_active).map(a => <option key={a.id} value={a.id}>{a.id} - {a.name}</option>)}</optgroup>)}
            </select>
          </div>
          {glAccount && (
            <div className="bg-white rounded-3xl shadow-card border border-indigo-50 p-5">
              <div className="flex justify-between mb-4"><div><h4 className="font-semibold text-slate-800">{glAccount.name}</h4><p className="text-xs text-slate-400">#{glAccount.id} · {glAccount.type} — {glAccount.subtype}</p></div>{glLines.length > 0 && <div className="text-right"><p className="text-xs text-slate-400">Ending Balance</p><p className="font-mono font-bold">{acctFmt(glLines[glLines.length-1].balance, true)}</p></div>}</div>
              <table className="w-full text-sm rounded-xl border border-indigo-50 overflow-hidden">
                <thead className="bg-indigo-50/30"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-slate-400">Date</th><th className="px-4 py-2 text-left text-xs font-semibold text-slate-400">Entry</th><th className="px-4 py-2 text-left text-xs font-semibold text-slate-400">Description</th><th className="px-4 py-2 text-left text-xs font-semibold text-slate-400">Memo</th><th className="px-4 py-2 text-right text-xs font-semibold text-slate-400">Debit</th><th className="px-4 py-2 text-right text-xs font-semibold text-slate-400">Credit</th><th className="px-4 py-2 text-right text-xs font-semibold text-slate-400">Balance</th></tr></thead>
                <tbody>
                  {glLines.length === 0 ? <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">No transactions</td></tr> : glLines.map((l,i) => <tr key={i} className="border-t border-indigo-50/50"><td className="px-4 py-2 text-xs text-slate-400">{acctFmtDate(l.date)}</td><td className="px-4 py-2 font-mono text-xs text-slate-400">{l.jeId}</td><td className="px-4 py-2 text-slate-700">{l.description}</td><td className="px-4 py-2 text-xs text-slate-400">{l.memo || "—"}</td><td className="px-4 py-2 text-right font-mono">{l.debit > 0 ? acctFmt(l.debit) : ""}</td><td className="px-4 py-2 text-right font-mono">{l.credit > 0 ? acctFmt(l.credit) : ""}</td><td className={`px-4 py-2 text-right font-mono font-semibold ${l.balance<0?"text-red-600":"text-slate-800"}`}>{acctFmt(l.balance, true)}</td></tr>)}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Bank Import Utilities ---
const KNOWN_BANK_FORMATS = [
  { id:"chase", name:"Chase Bank", sampleHeaders:["Transaction Date","Post Date","Description","Category","Type","Amount","Memo"], mapping:{date:"Transaction Date",description:"Description",amount:"Amount",memo:"Memo"} },
  { id:"bofa", name:"Bank of America", sampleHeaders:["Date","Description","Amount","Running Bal."], mapping:{date:"Date",description:"Description",amount:"Amount"} },
  { id:"wells", name:"Wells Fargo", sampleHeaders:["Date","Amount","* ","* ","Description"], mapping:{date:"Date",description:"Description",amount:"Amount"} },
  { id:"citi", name:"Citibank", sampleHeaders:["Date","Description","Debit","Credit"], mapping:{date:"Date",description:"Description",debit:"Debit",credit:"Credit"} },
  { id:"capital_one", name:"Capital One", sampleHeaders:["Transaction Date","Posted Date","Card No.","Description","Category","Debit","Credit"], mapping:{date:"Transaction Date",description:"Description",debit:"Debit",credit:"Credit"} },
  { id:"usbank", name:"US Bank", sampleHeaders:["Date","Transaction","Name","Memo","Amount"], mapping:{date:"Date",description:"Name",memo:"Memo",amount:"Amount"} },
  { id:"generic", name:"Generic CSV", sampleHeaders:[], mapping:{} },
];

function biParseCSV(csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers:[], rows:[] };
  const parseRow = (line) => { const result=[]; let cur="",inQ=false; for(let i=0;i<line.length;i++){const ch=line[i]; if(ch==='"'){if(inQ&&line[i+1]==='"'){cur+='"';i++;}else inQ=!inQ;}else if(ch===","&&!inQ){result.push(cur.trim());cur="";}else cur+=ch;} result.push(cur.trim()); return result; };
  let hIdx=0; for(let i=0;i<Math.min(5,lines.length);i++){if(lines[i].includes(",")){hIdx=i;break;}}
  const headers = parseRow(lines[hIdx]).map(h=>h.replace(/^"|"$/g,"").trim());
  const rows=[]; for(let i=hIdx+1;i<lines.length;i++){const line=lines[i].trim();if(!line||line.startsWith("#"))continue;const vals=parseRow(line);if(vals.length<2)continue;const obj={};headers.forEach((h,idx)=>{obj[h]=(vals[idx]||"").replace(/^"|"$/g,"").trim();});rows.push(obj);}
  return {headers,rows};
}

function biDetectFormat(headers) {
  const norm = headers.map(h=>h.toLowerCase().trim());
  for(const fmt of KNOWN_BANK_FORMATS){if(fmt.id==="generic")continue;const fh=fmt.sampleHeaders.map(h=>h.toLowerCase().trim());if(fh.filter(h=>h&&norm.includes(h)).length>=2)return fmt;}
  return KNOWN_BANK_FORMATS.find(f=>f.id==="generic");
}

function biParseAmount(rawAmt,rawDebit,rawCredit) {
  const clean=(s)=>{if(!s)return 0;s=String(s).trim().replace(/[$,\s]/g,"");const neg=s.startsWith("(")||s.startsWith("-")||s.toUpperCase().endsWith("DB");s=s.replace(/[()]/g,"").replace(/^-/,"").replace(/DB$/i,"").replace(/CR$/i,"");const v=parseFloat(s)||0;return neg?-v:v;};
  if(rawDebit!==undefined||rawCredit!==undefined){const d=clean(rawDebit),c=clean(rawCredit);if(c>0)return c;if(d>0)return -d;return 0;}
  return clean(rawAmt);
}

function biParseDate(raw) {
  if(!raw)return "";raw=String(raw).trim();
  if(/^\d{4}-\d{2}-\d{2}/.test(raw))return raw.substring(0,10);
  const mdy=raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);if(mdy&&Number(mdy[1])>=1&&Number(mdy[1])<=12&&Number(mdy[2])>=1&&Number(mdy[2])<=31)return `${mdy[3]}-${mdy[1].padStart(2,"0")}-${mdy[2].padStart(2,"0")}`;
  const mdy2=raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);if(mdy2){const yr=parseInt(mdy2[3])>50?"19"+mdy2[3]:"20"+mdy2[3];return `${yr}-${mdy2[1].padStart(2,"0")}-${mdy2[2].padStart(2,"0")}`;}
  try{const d=new Date(raw);if(!isNaN(d))return formatLocalDate(d);}catch(_){}
  return raw;
}

function biApplyMapping(rows,mapping) {
  return rows.map((row,idx)=>{
    const rawD=mapping.date?row[mapping.date]:"",rawDesc=mapping.description?row[mapping.description]:"",rawA=mapping.amount?row[mapping.amount]:undefined,rawDb=mapping.debit?row[mapping.debit]:undefined,rawCr=mapping.credit?row[mapping.credit]:undefined,rawM=mapping.memo?row[mapping.memo]:"";
    return { id:`IMP-${idx+1}`, date:biParseDate(rawD), description:rawDesc||"(no description)", amount:biParseAmount(rawA,rawDb,rawCr), memo:rawM, rawRow:row, accountId:"", accountName:"", classId:"", status:"pending", matchedJEId:null, matchedRule:null };
  });
}

function biDetectDuplicates(importedRows, journalEntries, bankAccountId) {
  return importedRows.map(row=>{
    const absAmt=Math.abs(row.amount);
    const dup=journalEntries.filter(je=>je.status==="posted"&&je.date===row.date).find(je=>(je.lines||[]).some(l=>l.account_id===bankAccountId&&Math.abs(Math.abs(safeNum(l.debit))-absAmt)<0.01));
    return dup?{...row,status:"duplicate",matchedJEId:dup.id}:row;
  });
}

const DEFAULT_IMPORT_RULES = [
  {id:"R001",matchType:"contains",matchValue:"rent",accountId:"4000",accountName:"Rental Income",classId:""},
  {id:"R002",matchType:"contains",matchValue:"late fee",accountId:"4010",accountName:"Late Fee Income",classId:""},
  {id:"R003",matchType:"contains",matchValue:"mortgage",accountId:"5000",accountName:"Mortgage Interest",classId:""},
  {id:"R004",matchType:"contains",matchValue:"insurance",accountId:"5200",accountName:"Insurance Expense",classId:""},
  {id:"R005",matchType:"contains",matchValue:"utility",accountId:"5400",accountName:"Utilities",classId:""},
  {id:"R006",matchType:"contains",matchValue:"electric",accountId:"5400",accountName:"Utilities",classId:""},
  {id:"R007",matchType:"contains",matchValue:"plumb",accountId:"5300",accountName:"Repairs & Maintenance",classId:""},
  {id:"R008",matchType:"contains",matchValue:"repair",accountId:"5300",accountName:"Repairs & Maintenance",classId:""},
  {id:"R009",matchType:"contains",matchValue:"landscap",accountId:"6100",accountName:"Landscaping",classId:""},
  {id:"R010",matchType:"contains",matchValue:"pest",accountId:"6200",accountName:"Pest Control",classId:""},
  {id:"R011",matchType:"contains",matchValue:"bank fee",accountId:"6000",accountName:"Bank Charges",classId:""},
  {id:"R012",matchType:"contains",matchValue:"interest",accountId:"7000",accountName:"Interest Income",classId:""},
];

function biApplyRules(rows,rules) {
  return rows.map(row=>{
    if(row.status==="duplicate")return row;
    for(const rule of rules){const desc=row.description.toLowerCase(),val=rule.matchValue.toLowerCase();let matched=false;
      switch(rule.matchType){case "contains":matched=desc.includes(val);break;case "startsWith":matched=desc.startsWith(val);break;case "equals":matched=desc===val;break;case "regex":try{matched=new RegExp(rule.matchValue,"i").test(row.description);}catch(e){matched=false;}break;default:matched=desc.includes(val);}
      if(matched)return {...row,accountId:rule.accountId,accountName:rule.accountName,classId:rule.classId||"",matchedRule:rule.id};
    }
    return row;
  });
}

// --- Bank Import Component ---
function AcctBankImport({ accounts, journalEntries, classes, onAddJournalEntry }) {
  const [step, setStep] = useState(1);
  const [wizardData, setWizardData] = useState({});
  const [rules, setRules] = useState(DEFAULT_IMPORT_RULES);
  const [importHistory, setImportHistory] = useState([]);
  const fileRef = useRef();

  // Step 1 state
  const [file, setFile] = useState(null);
  const [bankAccountId, setBankAccountId] = useState("");
  const [error, setError] = useState("");

  // Step 2 state
  const [mapping, setMapping] = useState({ date:"",description:"",amount:"",debit:"",credit:"",memo:"" });

  // Step 3 state
  const [transactions, setTransactions] = useState([]);
  const [filterStatus, setFilterStatus] = useState("all");
  const [showRules, setShowRules] = useState(false);
  const [newRule, setNewRule] = useState({ matchType:"contains", matchValue:"", accountId:"", accountName:"", classId:"" });

  // Step 4 state
  const [posting, setPosting] = useState(false);
  const [done, setDone] = useState(false);
  const [postedCount, setPostedCount] = useState(0);

  const bankAccounts = accounts.filter(a => a.type === "Asset" && (a.subtype === "Bank" || a.subtype === "Credit Card") && a.is_active);

  const reset = () => { setStep(1); setWizardData({}); setFile(null); setBankAccountId(""); setError(""); setTransactions([]); setDone(false); setPostedCount(0); setFilterStatus("all"); };

  // --- Step 1: Upload ---
  const handleUpload = () => {
    if(!file) return setError("Please select a CSV file.");
    if(!bankAccountId) return setError("Please select a bank account.");
    const reader = new FileReader();
    reader.onload = (e) => {
      const parsed = biParseCSV(e.target.result);
      if(parsed.headers.length===0) return setError("Could not parse CSV.");
      const detected = biDetectFormat(parsed.headers);
      // Auto-fill mapping
      const m = { date:"",description:"",amount:"",debit:"",credit:"",memo:"" };
      if(detected.id!=="generic"){ Object.entries(detected.mapping).forEach(([k,v])=>{m[k]=v;}); }
      else { parsed.headers.forEach(h=>{const hl=h.toLowerCase();if(!m.date&&(hl.includes("date")))m.date=h;if(!m.description&&(hl.includes("desc")||hl.includes("name")||hl==="payee"))m.description=h;if(!m.amount&&(hl==="amount"||hl==="amt"))m.amount=h;if(!m.debit&&hl.includes("debit"))m.debit=h;if(!m.credit&&hl.includes("credit"))m.credit=h;if(!m.memo&&hl.includes("memo"))m.memo=h;}); }
      setMapping(m);
      setWizardData({ parsed, bankAccountId, detected, fileName: file.name });
      setStep(2);
    };
    reader.readAsText(file);
  };

  // --- Step 2: Confirm mapping and go to review ---
  const mappingValid = mapping.date && mapping.description && (mapping.amount || mapping.debit || mapping.credit);
  const handleMapping = () => {
    if(!mappingValid) return;
    const rows = biApplyMapping(wizardData.parsed.rows, mapping);
    const withDups = biDetectDuplicates(rows, journalEntries, wizardData.bankAccountId);
    const withRules = biApplyRules(withDups, rules);
    setTransactions(withRules);
    setStep(3);
  };

  // --- Step 3 helpers ---
  const setTx = (i,updates) => setTransactions(txs=>txs.map((t,idx)=>idx===i?{...t,...updates}:t));
  const approveAll = () => setTransactions(txs=>txs.map(t=>t.status==="duplicate"?t:{...t,status:"approved"}));
  const skipAll = () => setTransactions(txs=>txs.map(t=>t.status==="duplicate"?t:{...t,status:"skipped"}));
  const reapplyRules = () => setTransactions(txs=>biApplyRules(txs.map(t=>({...t,matchedRule:null})),rules));
  const counts = { total:transactions.length, pending:transactions.filter(t=>t.status==="pending").length, approved:transactions.filter(t=>t.status==="approved").length, skipped:transactions.filter(t=>t.status==="skipped").length, duplicate:transactions.filter(t=>t.status==="duplicate").length, noAccount:transactions.filter(t=>t.status==="approved"&&!t.accountId).length };
  const filtered = filterStatus === "all" ? transactions : transactions.filter(t=>t.status===filterStatus);
  const addRule = () => { if(!newRule.matchValue||!newRule.accountId)return;const acct=accounts.find(a=>a.id===newRule.accountId);setRules(r=>[...r,{...newRule,id:`R${shortId()}`,accountName:acct?.name||""}]);setNewRule({matchType:"contains",matchValue:"",accountId:"",accountName:"",classId:""}); };
  const removeRule = (id) => setRules(r=>r.filter(x=>x.id!==id));

  // --- Step 4: Post ---
  const handlePost = async () => {
    setPosting(true);
    const approved = transactions.filter(t=>t.status==="approved");
    const bankAcct = accounts.find(a=>a.id===wizardData.bankAccountId);
    for(const tx of approved) {
      const isDeposit = tx.amount >= 0;
      const abs = Math.abs(tx.amount);
      const lines = isDeposit
        ? [{ account_id:wizardData.bankAccountId, account_name:bankAcct?.name||"Bank", debit:abs, credit:0, class_id:null, memo:tx.memo||"" },
           { account_id:tx.accountId||"9999", account_name:tx.accountName||"Suspense / Uncategorized", debit:0, credit:abs, class_id:tx.classId||null, memo:tx.memo||"" }]
        : [{ account_id:tx.accountId||"9999", account_name:tx.accountName||"Suspense / Uncategorized", debit:abs, credit:0, class_id:tx.classId||null, memo:tx.memo||"" },
           { account_id:wizardData.bankAccountId, account_name:bankAcct?.name||"Bank", debit:0, credit:abs, class_id:null, memo:tx.memo||"" }];
      await onAddJournalEntry({ date:tx.date, description:tx.description, reference:`IMPORT-${tx.id}`, lines, status:"draft" });
    }
    setPostedCount(approved.length);
    setImportHistory(h=>[{ date:acctToday(), bankAccount:bankAcct?.name, count:approved.length, fileName:wizardData.fileName, net:approved.reduce((s,t)=>s+t.amount,0) },...h]);
    setPosting(false);
    setDone(true);
    setStep(5);
  };

  const bankAcct = accounts.find(a=>a.id===wizardData.bankAccountId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-4">
        <div><h3 className="text-lg font-semibold text-slate-900">Bank Statement Import</h3><p className="text-sm text-slate-400">Import CSV from your bank and post to journal entries</p></div>
        {step > 1 && !done && <button onClick={reset} className="text-xs text-slate-400 hover:text-slate-700 bg-slate-100 px-3 py-1.5 rounded-lg">🔄 Start Over</button>}
      </div>

      {/* Step Bar */}
      <div className="flex items-center gap-0 mb-6">
        {[{n:1,l:"Upload"},{n:2,l:"Map Columns"},{n:3,l:"Review"},{n:4,l:"Post"}].map((s,i)=>(
          <div key={s.n} className="flex items-center flex-1">
            <div className="flex flex-col items-center gap-1">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border-2 ${step>s.n?"bg-emerald-500 border-emerald-500 text-white":step===s.n?"bg-slate-800 border-slate-800 text-white":"bg-white border-indigo-100 text-slate-400"}`}>{step>s.n?"✓":s.n}</div>
              <span className={`text-xs font-medium ${step===s.n?"text-slate-800":"text-slate-400"}`}>{s.l}</span>
            </div>
            {i<3&&<div className={`flex-1 h-0.5 mb-4 mx-2 ${step>s.n?"bg-emerald-400":"bg-slate-200"}`}/>}
          </div>
        ))}
      </div>

      {/* Step 1: Upload */}
      {step === 1 && (
        <div className="space-y-4 max-w-xl mx-auto">
          <div onClick={()=>fileRef.current?.click()} className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center gap-3 cursor-pointer ${file?"border-emerald-300 bg-emerald-50/50":"border-indigo-100 hover:border-indigo-300"}`}>
            <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={e=>{ const f=e.target.files[0]; if(f){setError("");setFile(f);} }} />
            {file ? <><p className="text-2xl">📄</p><p className="font-semibold text-emerald-800">{file.name}</p><p className="text-xs text-emerald-600">{(file.size/1024).toFixed(1)} KB · Click to change</p></> : <><p className="text-2xl">📤</p><p className="font-semibold text-slate-700">Drop CSV here or click to browse</p></>}
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-500 block mb-2">Import into Account *</label>
            {bankAccounts.map(a=>(
              <button key={a.id} onClick={()=>setBankAccountId(a.id)} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 text-left mb-2 ${bankAccountId===a.id?"border-slate-800 bg-slate-50":"border-indigo-100 hover:border-indigo-300"}`}>
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${bankAccountId===a.id?"bg-slate-800 text-white":"bg-slate-100 text-slate-400"}`}>🏦</div>
                <div className="flex-1"><p className="text-sm font-semibold text-slate-800">{a.name}</p><p className="text-xs text-slate-400">#{a.id} · {a.subtype}</p></div>
                {bankAccountId===a.id&&<span className="text-slate-800">✓</span>}
              </button>
            ))}
            {bankAccounts.length===0&&<p className="text-sm text-amber-600 bg-amber-50 rounded-2xl px-4 py-3">No bank accounts found. Add one in Chart of Accounts first.</p>}
          </div>
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-xs text-blue-700"><strong>Supported:</strong> Chase, Bank of America, Wells Fargo, Citibank, Capital One, US Bank, and generic CSV</div>
          {error&&<p className="text-sm text-red-600 bg-red-50 rounded-2xl px-4 py-3">⚠ {error}</p>}
          <div className="flex justify-end"><button onClick={handleUpload} disabled={!file||!bankAccountId} className="bg-slate-800 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50 hover:bg-slate-700">Continue →</button></div>
        </div>
      )}

      {/* Step 2: Map Columns */}
      {step === 2 && wizardData.parsed && (
        <div className="space-y-4 max-w-2xl mx-auto">
          <div className="flex items-center gap-2 mb-2">
            <h4 className="font-semibold text-slate-900">Map CSV Columns</h4>
            {wizardData.detected?.id!=="generic"&&<span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">⚡ Auto-detected: {wizardData.detected.name}</span>}
          </div>
          <div className="bg-indigo-50/30 rounded-xl p-3"><p className="text-xs text-slate-400 mb-2">Headers found:</p><div className="flex flex-wrap gap-1.5">{wizardData.parsed.headers.map(h=><span key={h} className="text-xs bg-slate-200 text-slate-700 px-2 py-0.5 rounded-lg font-mono">{h}</span>)}</div></div>
          <div className="grid grid-cols-2 gap-3">
            {[{f:"date",l:"Date *"},{f:"description",l:"Description *"},{f:"amount",l:"Amount"},{f:"debit",l:"Debit"},{f:"credit",l:"Credit"},{f:"memo",l:"Memo"}].map(({f,l})=>(
              <div key={f}><label className="text-xs font-medium text-slate-500">{l}</label><select value={mapping[f]} onChange={e=>setMapping(m=>({...m,[f]:e.target.value}))} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mt-1"><option value="">— Not mapped —</option>{wizardData.parsed.headers.map(h=><option key={h} value={h}>{h}</option>)}</select></div>
            ))}
          </div>
          {!mappingValid&&<p className="text-xs text-amber-600 bg-amber-50 rounded-2xl px-3 py-2">⚠ Date, Description, and at least one amount column required</p>}
          {/* Preview */}
          {mappingValid && (
            <div className="bg-white rounded-3xl border border-indigo-50 p-3 overflow-x-auto">
              <p className="text-xs font-semibold text-slate-400 mb-2">Preview (first 5 rows)</p>
              <table className="w-full text-xs"><thead><tr className="bg-indigo-50/30"><th className="px-3 py-1 text-left">Date</th><th className="px-3 py-1 text-left">Description</th><th className="px-3 py-1 text-right">Amount</th></tr></thead>
              <tbody>{wizardData.parsed.rows.slice(0,5).map((row,i)=><tr key={i} className="border-t border-indigo-50/50"><td className="px-3 py-1">{mapping.date?row[mapping.date]:""}</td><td className="px-3 py-1">{mapping.description?row[mapping.description]:""}</td><td className="px-3 py-1 text-right font-mono">{mapping.amount?row[mapping.amount]:mapping.debit?row[mapping.debit]:mapping.credit?row[mapping.credit]:""}</td></tr>)}</tbody></table>
            </div>
          )}
          <div className="flex justify-between"><button onClick={()=>setStep(1)} className="bg-slate-100 text-slate-500 text-sm px-4 py-2 rounded-lg">← Back</button><button onClick={handleMapping} disabled={!mappingValid} className="bg-slate-800 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50">Continue →</button></div>
        </div>
      )}

      {/* Step 3: Review */}
      {step === 3 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between"><p className="text-sm text-slate-400">Importing into <strong>{bankAcct?.name}</strong> · {counts.total} transactions</p>
            <div className="flex gap-2"><button onClick={reapplyRules} className="text-xs bg-slate-100 text-slate-500 px-3 py-1.5 rounded-lg">⚡ Re-apply Rules</button><button onClick={()=>setShowRules(!showRules)} className="text-xs bg-slate-100 text-slate-500 px-3 py-1.5 rounded-lg">🏷️ Rules</button></div>
          </div>
          <div className="grid grid-cols-5 gap-2">
            {[{k:"all",l:"All",c:counts.total},{k:"pending",l:"Pending",c:counts.pending},{k:"approved",l:"Approved",c:counts.approved},{k:"skipped",l:"Skipped",c:counts.skipped},{k:"duplicate",l:"Duplicate",c:counts.duplicate}].map(s=>(
              <button key={s.k} onClick={()=>setFilterStatus(s.k)} className={`rounded-xl p-2 text-center border-2 ${filterStatus===s.k?"border-slate-800 bg-slate-50":"border-transparent bg-white"}`}><p className="text-lg font-bold">{s.c}</p><p className="text-xs text-slate-400">{s.l}</p></button>
            ))}
          </div>
          <div className="flex gap-2"><button onClick={approveAll} className="text-xs bg-emerald-100 text-emerald-700 px-3 py-1.5 rounded-lg">✓ Approve All</button><button onClick={skipAll} className="text-xs bg-slate-100 text-slate-500 px-3 py-1.5 rounded-lg">⏭ Skip All</button>
            {counts.noAccount>0&&<span className="text-xs text-amber-600 bg-amber-50 px-3 py-1.5 rounded-lg ml-auto">⚠ {counts.noAccount} approved rows missing account</span>}
          </div>

          {/* Rules Panel */}
          {showRules && (
            <div className="bg-violet-50 border border-violet-100 rounded-3xl p-4 space-y-3">
              <p className="text-xs font-semibold text-violet-700 uppercase">Auto-Categorization Rules</p>
              {rules.map(r=>(
                <div key={r.id} className="flex items-center gap-2 text-xs bg-white rounded-lg p-2 border border-violet-100">
                  <span className="text-slate-400">If</span><span className="bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded">{r.matchType}</span><span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded">"{r.matchValue}"</span><span className="text-slate-400">→</span><span className="bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">{r.accountName||r.accountId}</span>
                  <button onClick={()=>removeRule(r.id)} className="ml-auto text-slate-300 hover:text-red-500">✕</button>
                </div>
              ))}
              <div className="grid grid-cols-4 gap-2">
                <select value={newRule.matchType} onChange={e=>setNewRule(r=>({...r,matchType:e.target.value}))} className="border border-indigo-100 rounded-2xl px-2 py-1.5 text-xs"><option value="contains">Contains</option><option value="startsWith">Starts With</option><option value="equals">Equals</option><option value="regex">Regex</option></select>
                <input value={newRule.matchValue} onChange={e=>setNewRule(r=>({...r,matchValue:e.target.value}))} placeholder="Match text..." className="border border-indigo-100 rounded-2xl px-2 py-1.5 text-xs" />
                <select value={newRule.accountId} onChange={e=>setNewRule(r=>({...r,accountId:e.target.value}))} className="border border-indigo-100 rounded-2xl px-2 py-1.5 text-xs"><option value="">Account...</option>{accounts.filter(a=>a.is_active&&!["Bank"].includes(a.subtype)).map(a=><option key={a.id} value={a.id}>{a.id}-{a.name}</option>)}</select>
                <button onClick={addRule} className="bg-violet-600 text-white text-xs px-3 py-1.5 rounded-lg">+ Add</button>
              </div>
            </div>
          )}

          {/* Transaction Rows */}
          <div className="space-y-2">
            {filtered.map((tx,di)=>{
              const ri=transactions.findIndex(t=>t.id===tx.id);
              const colors={pending:"border-amber-200 bg-amber-50/30",approved:"border-emerald-200 bg-emerald-50/30",skipped:"border-gray-100 bg-indigo-50/30 opacity-60",duplicate:"border-red-200 bg-red-50/30"};
              return (
                <div key={tx.id} className={`rounded-xl border-2 p-3 ${colors[tx.status]}`}>
                  <div className="flex items-start gap-3">
                    <span className="mt-1">{tx.amount>=0?"🟢":"🔴"}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div><p className="text-sm font-semibold text-slate-800">{tx.description}</p><p className="text-xs text-slate-400">{tx.date}{tx.matchedRule&&<span className="ml-1.5 text-violet-500">⚡ rule matched</span>}{tx.status==="duplicate"&&<span className="ml-1.5 text-red-500">⚠ Duplicate</span>}</p></div>
                        <span className={`font-mono font-bold text-sm ${tx.amount>=0?"text-emerald-700":"text-red-700"}`}>{tx.amount>=0?"+":""}{acctFmt(tx.amount)}</span>
                      </div>
                      {tx.status!=="skipped"&&tx.status!=="duplicate"&&(
                        <div className="flex gap-2 mt-2">
                          <select value={tx.accountId||""} onChange={e=>{const a=accounts.find(a=>a.id===e.target.value);setTx(ri,{accountId:e.target.value,accountName:a?.name||""});}} className={`border rounded-lg px-2 py-1 text-xs ${tx.status==="approved"&&!tx.accountId?"border-amber-300":"border-indigo-100"}`}>
                            <option value="">— Assign account —</option>{ACCOUNT_TYPES.map(type=><optgroup key={type} label={type}>{accounts.filter(a=>a.type===type&&a.is_active&&a.id!==wizardData.bankAccountId).map(a=><option key={a.id} value={a.id}>{a.id}–{a.name}</option>)}</optgroup>)}
                          </select>
                          <select value={tx.classId||""} onChange={e=>setTx(ri,{classId:e.target.value})} className="border border-indigo-100 rounded-2xl px-2 py-1 text-xs"><option value="">No class</option>{classes.filter(c=>c.is_active).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-1">
                      {tx.status!=="duplicate"&&<><button onClick={()=>setTx(ri,{status:"approved"})} className={`p-1.5 rounded-lg ${tx.status==="approved"?"bg-emerald-500 text-white":"text-slate-300 hover:text-emerald-600"}`}>✓</button><button onClick={()=>setTx(ri,{status:"skipped"})} className={`p-1.5 rounded-lg ${tx.status==="skipped"?"bg-slate-400 text-white":"text-slate-300 hover:text-slate-400"}`}>⏭</button></>}
                      {tx.status==="duplicate"&&<button onClick={()=>setTx(ri,{status:"pending",matchedJEId:null})} className="p-1.5 rounded-lg text-slate-400 hover:text-blue-600" title="Import anyway">🔄</button>}
                    </div>
                  </div>
                </div>
              );
            })}
            {filtered.length===0&&<p className="text-center py-8 text-slate-400 text-sm">No transactions in this filter</p>}
          </div>
          <div className="flex justify-between"><button onClick={()=>setStep(2)} className="bg-slate-100 text-slate-500 text-sm px-4 py-2 rounded-lg">← Back</button><button onClick={()=>setStep(4)} disabled={counts.approved===0||counts.noAccount>0} className="bg-slate-800 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50">Post {counts.approved} Transactions →</button></div>
        </div>
      )}

      {/* Step 4: Confirm & Post */}
      {step === 4 && !done && (
        <div className="space-y-4 max-w-xl mx-auto">
          <h4 className="font-semibold text-slate-900">Confirm & Post</h4>
          <div className="bg-white rounded-3xl border border-indigo-50 p-4 space-y-2">
            <div className="flex justify-between text-sm"><span className="text-slate-400">Bank Account</span><span className="font-bold">{bankAcct?.name}</span></div>
            <div className="flex justify-between text-sm"><span className="text-slate-400">Deposits</span><span className="font-mono text-emerald-700">+{acctFmt(transactions.filter(t=>t.status==="approved"&&t.amount>=0).reduce((s,t)=>s+t.amount,0))} ({transactions.filter(t=>t.status==="approved"&&t.amount>=0).length})</span></div>
            <div className="flex justify-between text-sm"><span className="text-slate-400">Payments</span><span className="font-mono text-red-700">{acctFmt(transactions.filter(t=>t.status==="approved"&&t.amount<0).reduce((s,t)=>s+t.amount,0))} ({transactions.filter(t=>t.status==="approved"&&t.amount<0).length})</span></div>
            <div className="flex justify-between text-sm border-t pt-2"><span className="font-bold">Entries to create</span><span className="font-bold">{transactions.filter(t=>t.status==="approved").length}</span></div>
          </div>
          <div className="flex justify-between"><button onClick={()=>setStep(3)} className="bg-slate-100 text-slate-500 text-sm px-4 py-2 rounded-lg">← Back</button><button onClick={handlePost} disabled={posting} className="bg-emerald-600 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50">{posting?"Posting...":"✓ Post All Entries"}</button></div>
        </div>
      )}

      {/* Step 5: Done */}
      {done && (
        <div className="flex flex-col items-center py-12 gap-4">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center text-3xl">✓</div>
          <h4 className="text-xl font-bold text-slate-900">Import Complete!</h4>
          <p className="text-sm text-slate-400">{postedCount} journal entries posted to <strong>{bankAcct?.name}</strong></p>
          <button onClick={reset} className="bg-slate-800 text-white text-sm px-4 py-2 rounded-lg mt-2">Import Another File</button>
        </div>
      )}

      {/* Import History */}
      {importHistory.length > 0 && (
        <div className="bg-white rounded-3xl shadow-card border border-indigo-50 p-4 mt-4">
          <h4 className="font-semibold text-slate-700 mb-3">Import History</h4>
          {importHistory.map((h,i)=>(
            <div key={i} className="flex items-center justify-between py-2 border-b border-indigo-50/50 last:border-0">
              <div><p className="text-sm font-medium text-slate-700">{h.fileName}</p><p className="text-xs text-slate-400">{h.date} · {h.bankAccount}</p></div>
              <div className="text-right"><p className={`font-mono text-sm font-semibold ${h.net>=0?"text-emerald-700":"text-red-700"}`}>{acctFmt(h.net,true)}</p><p className="text-xs text-slate-400">{h.count} entries</p></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Main Accounting Component (Supabase-backed) ---
function Accounting({ companyId, activeCompany, addNotification, userProfile }) {
  const [acctAccounts, setAcctAccounts] = useState([]);
  const [journalEntries, setJournalEntries] = useState([]);
  const [acctClasses, setAcctClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");
  const companyName = activeCompany?.name || "My Company";

  useEffect(() => { fetchAll(); }, [companyId]);

  async function fetchAll() {
    setLoading(true);
    try {
    const [acctsRes, jesRes, clsRes] = await Promise.all([
      supabase.from("acct_accounts").select("*").eq("company_id", companyId).order("id"),
      supabase.from("acct_journal_entries").select("*").eq("company_id", companyId).order("date", { ascending: false }),
      supabase.from("acct_classes").select("*").eq("company_id", companyId).order("name"),
    ]);
    const accounts = acctsRes.data || [];
    const jeHeaders = jesRes.data || [];
    const classes = clsRes.data || [];

    // Fetch all journal lines for this company's JEs and attach to entries
    if (jeHeaders.length > 0) {
      const jeIds = jeHeaders.map(je => je.id);
      const { data: allLines } = await supabase.from("acct_journal_lines").select("*").in("journal_entry_id", jeIds);
      const linesByJE = {};
      (allLines || []).forEach(l => { if (!linesByJE[l.journal_entry_id]) linesByJE[l.journal_entry_id] = []; linesByJE[l.journal_entry_id].push(l); });
      jeHeaders.forEach(je => { je.lines = linesByJE[je.id] || []; });
    }

    // Auto-sync property classes (only on first load, not every re-fetch)
    if (!window._propClassesSynced || window._propClassesSyncedFor !== companyId) {
    const { data: allProps } = await supabase.from("properties").select("id, address, type, rent").eq("company_id", companyId);
    if (allProps && allProps.length > 0) {
      const existingNames = new Set(classes.map(c => c.name));
      const colors = ["#3B82F6","#10B981","#F59E0B","#EF4444","#8B5CF6","#06B6D4","#F97316","#EC4899"];
      const missing = allProps.filter(p => !existingNames.has(p.address));
      if (missing.length > 0) {
        const newClasses = missing.map(p => ({
          id: `PROP-${p.id}`,
          name: p.address,
          description: `${p.type || "Property"} · ${formatCurrency(p.rent || 0)}/mo`,
          color: pickColor(p.address),
          is_active: true,
          company_id: companyId,
        }));
        await supabase.from("acct_classes").upsert(newClasses, { onConflict: "id" });
        // Re-fetch classes after sync
        const { data: updatedClasses } = await supabase.from("acct_classes").select("*").eq("company_id", companyId).order("name");
        setAcctClasses(updatedClasses || []);
        setAcctAccounts(accounts);
        setJournalEntries(jeHeaders);
        setLoading(false);
        return;
      }
    }
    } // end _propClassesSynced guard

    setAcctAccounts(accounts);
    setJournalEntries(jeHeaders);
    setAcctClasses(classes);
    } finally { setLoading(false); }
  }

  // --- Account CRUD ---
  async function addAccount(acct) {
      if (!guardSubmit("addAccount")) return;
      try {
    const { error } = await supabase.from("acct_accounts").insert([{ ...acct, company_id: companyId }]);
    if (error) { alert("Error creating account: " + error.message); return; }
    fetchAll();
      } finally { guardRelease("addAccount"); }
  }
  async function updateAccount(acct) {
    const { id } = acct;
    const { error } = await supabase.from("acct_accounts").update({
      name: acct.name, type: acct.type, subtype: acct.subtype, 
      is_active: acct.is_active, description: acct.description || "",
      parent_id: acct.parent_id || null
    }).eq("company_id", companyId).eq("id", id);
    if (error) { alert("Error updating account: " + error.message); return; }
    fetchAll();
  }
  async function toggleAccount(id, currentActive) {
    if (currentActive) {
      // Check if any posted JEs reference this account before deactivating
      const { data: refs } = await supabase.from("acct_journal_lines").select("id").eq("account_id", id).limit(1);
      if (refs?.length > 0 && !window.confirm("This account has journal entries. Deactivating will hide it from reports but existing entries remain. Continue?")) return;
    }
    const { error: _err3877 } = await supabase.from("acct_accounts").update({ is_active: !currentActive }).eq("company_id", companyId).eq("id", id);
    if (_err3877) { alert("Error updating acct_accounts: " + _err3877.message); return; }
    fetchAll();
  }

  // --- Journal Entry CRUD ---
  async function addJournalEntry(data) {
      if (!guardSubmit("addJournalEntry")) return;
      try {
    const { lines, ...header } = data;
    // Try atomic RPC first
    try {
      const { data: jeId, error: rpcErr } = await supabase.rpc("create_journal_entry", {
        p_company_id: companyId,
        p_date: header.date,
        p_description: header.description,
        p_reference: header.reference || "",
        p_property: header.property || "",
        p_status: header.status || "draft",
        p_lines: JSON.stringify(resolvedLines || []),
      });
      if (!rpcErr && jeId) { fetchAll(); return; }
      console.warn("addJE RPC fallback:", rpcErr?.message);
    } catch (e) { console.warn("addJE RPC not available:", e.message); }
    // Fallback: client-side with cleanup
    // Validate DR/CR balance before inserting
    if (lines?.length > 0) {
      const v = validateJE(lines);
      if (!v.isValid) { alert("Journal entry is out of balance by $" + v.difference.toFixed(2) + ". Debits must equal credits."); return; }
    }
    const number = nextJENumber(journalEntries);
    const jeId = generateId("je");
    const { error: headerErr } = await supabase.from("acct_journal_entries").insert([{ company_id: companyId, id: jeId, number, date: header.date, description: header.description, reference: header.reference || "", property: header.property || "", status: header.status || "draft" }]);
    if (headerErr) { alert("Error creating journal entry: " + headerErr.message); return; }
    if (lines?.length > 0) {
      const { error: linesErr } = await supabase.from("acct_journal_lines").insert(lines.map(l => ({ journal_entry_id: jeId, account_id: l.account_id, account_name: l.account_name, debit: safeNum(l.debit), credit: safeNum(l.credit), class_id: l.class_id || null, memo: l.memo || "" })));
      if (linesErr) {
        console.warn("JE lines failed, cleaning up:", linesErr.message);
        const { error: _err3909 } = await supabase.from("acct_journal_entries").delete().eq("company_id", companyId).eq("id", jeId);
        if (_err3909) console.warn("acct_journal_entries write failed:", _err3909.message);
        alert("Error creating journal entry lines: " + linesErr.message);
        return;
      }
    }
    fetchAll();
      } finally { guardRelease("addJournalEntry"); }
  }
  async function updateJournalEntry(data) {
    const { id, lines, ...header } = data;
    delete header.created_at;
    // Validate debit/credit balance before saving
    if (lines?.length > 0) {
      const v = validateJE(lines);
      if (!v.isValid) { alert("Journal entry is out of balance by $" + v.difference.toFixed(2) + ". Debits must equal credits."); return; }
    }
    delete header.number;
    // Save old lines before deleting so we can restore on failure
    const { data: oldLines } = await supabase.from("acct_journal_lines").select("*").eq("journal_entry_id", id);
    await supabase.from("acct_journal_entries").update({ date: header.date, description: header.description, reference: header.reference || "", property: header.property || "", status: header.status }).eq("company_id", companyId).eq("id", id);
    // Replace lines
    const { error: _err3930 } = await supabase.from("acct_journal_lines").delete().eq("journal_entry_id", id);
    if (_err3930) console.warn("acct_journal_lines write failed:", _err3930.message);
    if (lines?.length > 0) {
      const { error: linesErr } = await supabase.from("acct_journal_lines").insert(lines.map(l => ({ journal_entry_id: id, account_id: l.account_id, account_name: l.account_name, debit: safeNum(l.debit), credit: safeNum(l.credit), class_id: l.class_id || null, memo: l.memo || "" })));
      if (linesErr) {
        // Restore old lines
        console.warn("Update lines failed, restoring:", linesErr.message);
        if (oldLines?.length > 0) {
          await supabase.from("acct_journal_lines").insert(oldLines.map(l => ({ journal_entry_id: id, account_id: l.account_id, account_name: l.account_name, debit: l.debit, credit: l.credit, class_id: l.class_id, memo: l.memo })));
        }
        alert("Error updating journal lines: " + linesErr.message);
        fetchAll();
        return;
      }
    }
    fetchAll();
  }
  async function postJournalEntry(id) {
    // Check JE has lines before posting
    const je = journalEntries.find(j => j.id === id);
    if (!je?.lines || je.lines.length === 0) { alert("Cannot post a journal entry with no lines."); return; }
    const v = validateJE(je.lines);
    if (!v.isValid) { alert("Cannot post: journal entry is out of balance by $" + v.difference.toFixed(2)); return; }
    const { error: _err3952 } = await supabase.from("acct_journal_entries").update({ status: "posted" }).eq("company_id", companyId).eq("id", id);
    if (_err3952) { alert("Error updating acct_journal_entries: " + _err3952.message); return; }
    fetchAll();
  }
  async function voidJournalEntry(id) {
    // Find the JE to check if it affected a tenant balance
    const je = journalEntries.find(j => j.id === id);
    const { error: _err3958 } = await supabase.from("acct_journal_entries").update({ status: "voided" }).eq("company_id", companyId).eq("id", id);
    if (_err3958) { alert("Error updating acct_journal_entries: " + _err3958.message); return; }
    // Reverse tenant balance based on JE type
    if (je) {
      const { data: jeLines } = await supabase.from("acct_journal_lines").select("*").eq("journal_entry_id", id);
      const arAccountIds = new Set(accounts.filter(a => a.name === "Accounts Receivable").map(a => a.id));
      // Parse tenant name from description (format: "Action — TenantName — Property ...")
      const descParts = (je.description || "").split(" — ");
      const tenantName = descParts.length >= 2 ? descParts[1] : "";
      
      if (tenantName.trim()) {
        const { data: tenantRow } = await supabase.from("tenants").select("id, balance").ilike("name", tenantName.trim()).eq("company_id", companyId).maybeSingle();
        
        if (tenantRow && jeLines) {
          // Calculate AR impact: net of debits and credits on AR accounts
          const arImpact = jeLines.filter(l => arAccountIds.has(l.account_id))
            .reduce((s, l) => s + safeNum(l.debit) - safeNum(l.credit), 0);
          
          if (Math.abs(arImpact) > 0.01) {
            // Reverse: if charge increased AR (positive), decrease balance; if payment decreased AR (negative), increase balance
            try {
              const { error: balErr } = await supabase.rpc("update_tenant_balance", { p_tenant_id: tenantRow.id, p_amount_change: -arImpact });
              if (balErr) alert("Balance update failed: " + balErr.message + ". Please verify the tenant balance.");
            } catch (e) { console.warn("Void balance RPC error:", e.message); }
            await safeLedgerInsert({ company_id: companyId,
              tenant: tenantName.trim(), property: je.property || "",
              date: formatLocalDate(new Date()),
              description: "Voided: " + (je.description || "").slice(0, 60),
              amount: -arImpact, type: "void", balance: 0,
            });
          }
        }
      }
    }
    fetchAll();
  }

  // --- Class CRUD ---
  async function addClass(cls) {
      if (!guardSubmit("addClass")) return;
      try {
    const { error } = await supabase.from("acct_classes").insert([{ ...cls, company_id: companyId }]);
    if (error) { alert("Error creating class: " + error.message); return; }
    fetchAll();
      } finally { guardRelease("addClass"); }
  }
  async function updateClass(cls) {
    const { id } = cls;
    const { error } = await supabase.from("acct_classes").update({
      name: cls.name, type: cls.type, is_active: cls.is_active,
      description: cls.description || "", color: cls.color || "#3B82F6"
    }).eq("company_id", companyId).eq("id", id);
    if (error) { alert("Error updating class: " + error.message); return; }
    fetchAll();
  }
  async function toggleClass(id, currentActive) {
    const { error: _err4013 } = await supabase.from("acct_classes").update({ is_active: !currentActive }).eq("company_id", companyId).eq("id", id);
    if (_err4013) { alert("Error updating acct_classes: " + _err4013.message); return; }
    fetchAll();
  }

  if (loading) return <Spinner />;

  // --- Overview Dashboard Data ---
  const { start: ytdStart, end: ytdEnd } = getPeriodDates("This Year");
  const plData = getPLData(acctAccounts, journalEntries, ytdStart, ytdEnd);
  const bsData = getBalanceSheetData(acctAccounts, journalEntries, ytdEnd);
  const pendingCount = journalEntries.filter(j => j.status === "draft").length;

  return (
    <div>
      <h2 className="text-2xl font-manrope font-bold text-slate-800 mb-5">Accounting & Financials</h2>
      <div className="flex gap-2 mb-5 border-b border-indigo-50 overflow-x-auto">
        {[["overview","Overview"],["coa","Chart of Accounts"],["journal","Journal Entries"],["recurring","🔄 Recurring"],["bankimport","Bank Import"],["reconcile","Reconcile"],["classes","Class Tracking"],["reports","Reports"]].map(([id,label]) => (
          <button key={id} onClick={() => setActiveTab(id)} className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${activeTab === id ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-400 hover:text-slate-700"}`}>
            {label}
            {id === "journal" && pendingCount > 0 && <span className="ml-1.5 bg-amber-100 text-amber-700 text-xs px-1.5 py-0.5 rounded-full">{pendingCount}</span>}
          </button>
        ))}
      </div>

      {activeTab === "overview" && (
        <div>
          <div className="grid grid-cols-2 gap-3 mb-5 md:grid-cols-4">
            <StatCard label="Total Revenue" value={acctFmt(plData.totalRevenue)} color="text-green-600" sub="Year to date" />
            <StatCard label="Total Expenses" value={acctFmt(plData.totalExpenses)} color="text-red-500" sub="Year to date" />
            <StatCard onClick={() => setPage("accounting")} label="Net Income" value={acctFmt(plData.netIncome)} color={plData.netIncome >= 0 ? "text-blue-700" : "text-red-600"} sub="Year to date" />
            <StatCard label="Total Assets" value={acctFmt(bsData.totalAssets)} color="text-purple-700" sub="Balance sheet" />
          </div>
          {/* Monthly Rent Accrual */}
          <div className="bg-blue-50 border border-blue-100 rounded-3xl p-4 mb-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-blue-800">Monthly Rent Accrual</p>
              <p className="text-xs text-blue-600">Generate AR entries for all active leases this month (DR Accounts Receivable, CR Rental Income)</p>
            </div>
            <button onClick={async () => {
              const { data: activeTenants } = await supabase.from("tenants").select("*").eq("company_id", companyId).eq("lease_status", "active");
              if (!activeTenants || activeTenants.length === 0) { alert("No active leases found."); return; }
              const today = formatLocalDate(new Date());
              const month = today.slice(0, 7);
              // Check if already accrued this month
              const { data: existing } = await supabase.from("acct_journal_entries").select("id").eq("company_id", companyId).like("reference", `ACCR-${month}%`).neq("status", "voided");
              if (existing && existing.length > 0) { alert("Rent already accrued for " + month + ". " + existing.length + " entries exist."); return; }
              // Iterate active LEASES (not tenants) for accurate rent amounts and multi-property support
              const { data: activeLeases } = await supabase.from("leases").select("*").eq("company_id", companyId).eq("status", "active");
              let count = 0;
              for (const lease of (activeLeases || [])) {
                const rent = safeNum(lease.rent_amount);
                if (rent <= 0) continue;
                const classId = await getPropertyClassId(lease.property, companyId);
                const _jeOk = await autoPostJournalEntry({
                  companyId,
                  date: today,
                  description: `Rent accrual ${month} — ${lease.tenant_name} — ${lease.property}`,
                  reference: `ACCR-${month}-${lease.id}`,
                  property: lease.property,
                  lines: [
                    { account_id: "1100", account_name: "Accounts Receivable", debit: rent, credit: 0, class_id: classId, memo: `${lease.tenant_name} rent due` },
                    { account_id: "4000", account_name: "Rental Income", debit: 0, credit: rent, class_id: classId, memo: `${lease.tenant_name} — ${lease.property}` },
                  ]
                });
                if (!_jeOk) { alert("Accounting entry failed. The transaction was recorded but the journal entry could not be posted. Please check the accounting module."); }
                
                // Update tenant balance (they now owe this amount)
                if (lease.tenant_id) {
                  const { error: balErr } = await supabase.rpc("update_tenant_balance", { p_tenant_id: lease.tenant_id, p_amount_change: rent });
                  if (balErr) alert("Balance update failed: " + balErr.message + ". Please verify the tenant balance.");
                }
                // Create ledger entry
                await safeLedgerInsert({ company_id: companyId,
                  tenant: lease.tenant_name, property: lease.property, date: today,
                  description: `Rent accrual — ${month}`, amount: rent, type: "charge", balance: 0,
                });
                count++;
              }
              alert("Accrued rent for " + count + " active leases for " + month);
              fetchAll();
            }} className="bg-blue-600 text-white text-xs px-4 py-2 rounded-lg hover:bg-blue-700 shrink-0">Generate Accruals</button>
          </div>
          {pendingCount > 0 && <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 mb-4 text-sm text-amber-700">⏳ {pendingCount} draft journal {pendingCount === 1 ? "entry" : "entries"} awaiting review</div>}
          <div className="bg-white rounded-3xl shadow-card border border-indigo-50 p-4 mb-4">
            <h3 className="font-semibold text-slate-700 mb-3">Recent Journal Entries</h3>
            {journalEntries.slice(0, 5).map(je => {
              const total = (je.lines || []).reduce((s,l) => s + safeNum(l.debit), 0);
              return (
                <div key={je.id} className="flex items-center justify-between py-2 border-b border-indigo-50/50 last:border-0">
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full ${je.status==="posted"?"bg-emerald-400":je.status==="draft"?"bg-amber-400":"bg-slate-300"}`} />
                    <div><p className="text-sm font-medium text-slate-700">{je.description}</p><p className="text-xs text-slate-400">{je.number} · {je.date}</p></div>
                  </div>
                  <span className="font-mono text-sm font-semibold text-slate-700">{acctFmt(total)}</span>
                </div>
              );
            })}
            {journalEntries.length === 0 && <p className="text-sm text-slate-400 text-center py-4">No journal entries yet. Start by creating one in the Journal Entries tab.</p>}
          </div>
          <div className="bg-white rounded-3xl shadow-card border border-indigo-50 p-4">
            <h3 className="font-semibold text-slate-700 mb-3">Account Summary</h3>
            <div className="grid grid-cols-2 gap-3">
              {["Asset","Liability","Equity","Revenue","Expense"].map(type => {
                const total = calcAllBalances(acctAccounts, journalEntries).filter(a => a.type === type && a.is_active).reduce((s,a) => s + a.computedBalance, 0);
                return (
                  <div key={type} className="flex justify-between items-center py-2 px-3 bg-indigo-50/30 rounded-lg">
                    <span className="text-sm text-slate-500">{type}</span>
                    <span className={`font-mono text-sm font-semibold ${total < 0 ? "text-red-600" : "text-slate-800"}`}>{acctFmt(total, true)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {activeTab === "recurring" && <RecurringJournalEntries companyId={companyId} addNotification={addNotification} userProfile={userProfile} />}
      {activeTab === "coa" && <AcctChartOfAccounts accounts={acctAccounts} journalEntries={journalEntries} onAdd={addAccount} onUpdate={updateAccount} onToggle={toggleAccount} />}
      {activeTab === "journal" && <AcctJournalEntries accounts={acctAccounts} journalEntries={journalEntries} classes={acctClasses} onAdd={addJournalEntry} onUpdate={updateJournalEntry} onPost={postJournalEntry} onVoid={voidJournalEntry} companyId={companyId} />}
      {activeTab === "bankimport" && <AcctBankImport accounts={acctAccounts} journalEntries={journalEntries} classes={acctClasses} onAddJournalEntry={addJournalEntry} />}
      {activeTab === "reconcile" && <AcctBankReconciliation accounts={acctAccounts} journalEntries={journalEntries} companyId={companyId} />}
      {activeTab === "classes" && <AcctClassTracking accounts={acctAccounts} journalEntries={journalEntries} classes={acctClasses} onAdd={addClass} onUpdate={updateClass} onToggle={toggleClass} />}
      {activeTab === "reports" && <AcctReports accounts={acctAccounts} journalEntries={journalEntries} classes={acctClasses} companyName={companyName} />}
    </div>
  );
}

// ============ DOCUMENTS ============
function Documents({ addNotification, userProfile, userRole, companyId }) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState("all");
  const [form, setForm] = useState({ name: "", property: "", tenant: "", type: "Lease", tenant_visible: false });
  const fileRef = useRef();
  const [uploading, setUploading] = useState(false);

  useEffect(() => { fetchDocs(); }, [companyId]);

  async function fetchDocs() {
    const { data } = await supabase.from("documents").select("*").eq("company_id", companyId).order("uploaded_at", { ascending: false }).limit(500);
    setDocs(data || []);
    setLoading(false);
  }

  async function uploadDocument() {
      if (!guardSubmit("uploadDocument")) return;
      try {
    const file = fileRef.current?.files?.[0];
    if (!file || !form.name) return;
    setUploading(true);
    const fileName = `${companyId}/${shortId()}_${sanitizeFileName(file.name)}`;
    const { error: uploadError } = await supabase.storage.from("documents").upload(fileName, file, {
      cacheControl: "3600",
      upsert: false,
    });
    if (uploadError) {
      alert("Upload failed: " + uploadError.message);
      setUploading(false);
      return;
    }
    // Store file path — signed URLs generated on display for security
    const storagePath = fileName;
    const { error: insertError } = await supabase.from("documents").insert([{ company_id: companyId,
      name: form.name,
      file_name: storagePath,
      property: form.property,
      tenant: form.tenant || "",
      type: form.type,
      tenant_visible: form.tenant_visible,
      url: storagePath,
      uploaded_at: new Date().toISOString(),
    }]);
    if (insertError) {
      alert("File uploaded to storage but failed to save record: " + insertError.message);
      setUploading(false);
      return;
    }
    addNotification("📄", `Document uploaded: ${form.name}`);
    setShowForm(false);
    setForm({ name: "", property: "", tenant: "", type: "Lease", tenant_visible: false });
    if (fileRef.current) fileRef.current.value = "";
    setUploading(false);
    fetchDocs();
      } finally { guardRelease("uploadDocument"); }
  }

  async function deleteDoc(id, name, file_name) {
      if (!guardSubmit("deleteDoc")) return;
      try {
    if (!window.confirm(`Delete "${name}"?`)) return;
    // Also delete from storage if file_name is known
    if (file_name) {
      await supabase.storage.from("documents").remove([file_name]);
    }
    const { error } = await supabase.from("documents").delete().eq("id", id).eq("company_id", companyId);
    if (error) { alert("Error deleting document: " + error.message); return; }
    addNotification("🗑️", `Document deleted: ${name}`);
    fetchDocs();
      } finally { guardRelease("deleteDoc"); }
  }

  // Repair existing documents that have empty/broken url
  async function repairUrls() {
    let repaired = 0;
    for (const d of docs) {
      if (d.file_name && !d.url) {
        // Generate signed URL on the fly instead of storing public URL
        repaired++; // Count as needing signed URL generation
      }
    }
    if (repaired > 0) {
      addNotification("🔧", `Repaired URLs for ${repaired} document(s)`);
      fetchDocs();
    } else {
      alert("All document URLs look fine — no repairs needed.");
    }
  }

  if (loading) return <Spinner />;

  const filtered = filter === "all" ? docs : docs.filter(d => d.type === filter);

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-2xl font-manrope font-bold text-slate-800">Document Management</h2>
        <div className="flex gap-2">
          <button onClick={repairUrls} className="bg-amber-500 text-white text-sm px-4 py-2 rounded-lg hover:bg-amber-600" title="Fix broken View links for existing documents">🔧 Repair URLs</button>
          <button onClick={() => setShowForm(!showForm)} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-indigo-700">+ Upload Document</button>
        </div>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-slate-700 mb-3">Upload Document</h3>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Document Name *</label><input placeholder="Lease Agreement 2026" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Property</label><PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} companyId={companyId} /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Tenant</label><input placeholder="Optional — link to a tenant" value={form.tenant} onChange={e => setForm({ ...form, tenant: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Document Type</label><select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full">
              {["Lease", "Inspection", "Maintenance", "Financial", "Notice", "Other"].map(t => <option key={t}>{t}</option>)}
            </select></div>
            <label className="flex items-center gap-2 text-sm text-slate-500 border border-indigo-100 rounded-2xl px-3 py-2 cursor-pointer">
              <input type="checkbox" checked={form.tenant_visible} onChange={e => setForm({ ...form, tenant_visible: e.target.checked })} />
              Visible to Tenant
            </label>
            <input type="file" ref={fileRef} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm col-span-2" />
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={uploadDocument} disabled={uploading} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-indigo-700 disabled:opacity-50">
              {uploading ? "Uploading..." : "Upload"}
            </button>
            <button onClick={() => setShowForm(false)} className="bg-slate-100 text-slate-500 text-sm px-4 py-2 rounded-2xl hover:bg-slate-100">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex gap-2 mb-4 flex-wrap">
        {["all", "Lease", "Inspection", "Maintenance", "Financial", "Notice", "Other"].map(t => (
          <button key={t} onClick={() => setFilter(t)} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${filter === t ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}>{t}</button>
        ))}
      </div>

      <div className="bg-white rounded-3xl shadow-card border border-indigo-50 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-indigo-50/30 text-xs text-slate-400 uppercase">
            <tr>{["Document", "Property", "Type", "Date", "Tenant Visible", "Actions"].map(h => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {filtered.map(d => (
              <tr key={d.id} className="border-t border-indigo-50/50 hover:bg-indigo-50/30">
                <td className="px-3 py-2.5 font-medium text-slate-800">📄 {d.name}</td>
                <td className="px-3 py-2.5 text-slate-400">{d.property}</td>
                <td className="px-3 py-2.5"><span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full text-xs">{d.type}</span></td>
                <td className="px-3 py-2.5 text-slate-400">{d.uploaded_at?.slice(0, 10)}</td>
                <td className="px-3 py-2.5">{d.tenant_visible ? "✅" : "🔒"}</td>
                <td className="px-3 py-2.5">
                  <div className="flex gap-2">
                    {d.url ? (
                      <>
                        <button onClick={async () => {
                          const isFullUrl = d.url && d.url.startsWith("http");
                          if (isFullUrl) { window.open(d.url, "_blank", "noopener,noreferrer"); return; }
                          const path = d.file_name || d.url;
                          if (!path) { alert("No file path available."); return; }
                          const url = await getSignedUrl("documents", path);
                          if (url) window.open(url, "_blank", "noopener,noreferrer");
                          else alert("Could not generate secure download link.");
                        }} className="text-xs text-indigo-600 hover:underline">View</button>
                        <button onClick={async () => {
                          const isFullUrl = d.url && d.url.startsWith("http");
                          if (isFullUrl) { window.open(d.url, "_blank", "noopener,noreferrer"); return; }
                          const path = d.file_name || d.url;
                          if (!path) return;
                          const url = await getSignedUrl("documents", path);
                          if (url) window.open(url, "_blank", "noopener,noreferrer");
                        }} className="text-xs text-green-600 hover:underline">Download</button>
                      </>
                    ) : d.file_name ? (
                      <>
                        <button onClick={async () => {
                          const url = await getSignedUrl("documents", d.file_name);
                          if (url) window.open(url, "_blank", "noopener,noreferrer");
                          else alert("Could not generate secure link for this file.");
                        }} className="text-xs text-indigo-600 hover:underline">View</button>
                      </>
                    ) : (
                      <span className="text-xs text-slate-400">No file</span>
                    )}
                    <button onClick={() => deleteDoc(d.id, d.name, d.file_name)} className="text-xs text-red-400 hover:underline">Delete</button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">No documents yet. Upload one above.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============ INSPECTIONS ============
function Inspections({ addNotification, userProfile, userRole, companyId }) {
  const [inspections, setInspections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [selectedInspection, setSelectedInspection] = useState(null);
  const [form, setForm] = useState({ property: "", type: "Move-In", inspector: "", date: formatLocalDate(new Date()), status: "scheduled", notes: "" });

  const checklistTemplates = {
    "Move-In": ["Front door & locks", "Windows & screens", "Walls & ceilings", "Floors & carpets", "Kitchen appliances", "Bathrooms", "HVAC system", "Smoke detectors", "Garage/parking"],
    "Move-Out": ["Front door & locks", "Windows & screens", "Walls & ceilings", "Floors & carpets", "Kitchen appliances", "Bathrooms", "HVAC system", "Smoke detectors", "Cleaning condition"],
    "Periodic": ["Exterior condition", "Roof & gutters", "HVAC filter", "Plumbing leaks", "Electrical", "Smoke detectors", "Pest signs", "General cleanliness"],
  };

  const [checklist, setChecklist] = useState({});

  useEffect(() => { fetchInspections(); }, [companyId]);

  async function fetchInspections() {
    const { data } = await supabase.from("inspections").select("*").eq("company_id", companyId).order("date", { ascending: false });
    setInspections(data || []);
    setLoading(false);
  }

  async function saveInspection() {
      if (!guardSubmit("saveInspection")) return;
      try {
    if (!form.property.trim()) { alert("Property is required."); return; }
    if (!form.date) { alert("Inspection date is required."); return; }
    const { error } = await supabase.from("inspections").insert([{ ...form, checklist: JSON.stringify(checklist), company_id: companyId }]);
    if (error) { alert("Error saving inspection: " + error.message); return; }
    addNotification("🔍", `Inspection scheduled: ${form.type} at ${form.property}`);
    setShowForm(false);
    setForm({ property: "", type: "Move-In", inspector: "", date: formatLocalDate(new Date()), status: "scheduled", notes: "" });
    setChecklist({});
    fetchInspections();
      } finally { guardRelease("saveInspection"); }
  }

  async function updateStatus(id, status) {
    const { error: usErr } = await supabase.from("inspections").update({ status }).eq("company_id", companyId).eq("id", id);
    if (usErr) { alert("Error updating status: " + usErr.message); return; }
    fetchInspections();
  }

  function initChecklist(type) {
    const items = checklistTemplates[type] || [];
    const initial = {};
    items.forEach(item => { initial[item] = { pass: null, notes: "" }; });
    setChecklist(initial);
  }

  if (loading) return <Spinner />;

  return (
    <div>
      {selectedInspection && (
        <Modal title={`Inspection — ${selectedInspection.property}`} onClose={() => setSelectedInspection(null)}>
          <div className="space-y-2 mb-4">
            <div className="flex justify-between text-sm"><span className="text-slate-400">Type</span><span className="font-medium">{selectedInspection.type}</span></div>
            <div className="flex justify-between text-sm"><span className="text-slate-400">Date</span><span className="font-medium">{selectedInspection.date}</span></div>
            <div className="flex justify-between text-sm"><span className="text-slate-400">Inspector</span><span className="font-medium">{selectedInspection.inspector || "—"}</span></div>
            <div className="flex justify-between text-sm"><span className="text-slate-400">Status</span><Badge status={selectedInspection.status} /></div>
          </div>
          {selectedInspection.notes && <div className="bg-indigo-50/30 rounded-lg p-3 text-sm text-slate-500 mb-4">{selectedInspection.notes}</div>}
          {selectedInspection.checklist && (() => {
            try {
              const cl = JSON.parse(selectedInspection.checklist);
              return (
                <div>
                  <h4 className="font-semibold text-slate-700 mb-2 text-sm">Checklist</h4>
                  <div className="space-y-1">
                    {Object.entries(cl).map(([item, val]) => (
                      <div key={item} className="flex items-center justify-between text-sm py-1 border-b border-indigo-50/50">
                        <span className="text-slate-700">{item}</span>
                        <span className={val.pass === true ? "text-green-600 font-semibold" : val.pass === false ? "text-red-500 font-semibold" : "text-slate-400"}>
                          {val.pass === true ? "✓ Pass" : val.pass === false ? "✗ Fail" : "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            } catch { return null; }
          })()}
        </Modal>
      )}

      <div className="flex items-center justify-between mb-5">
        <h2 className="text-2xl font-manrope font-bold text-slate-800">Inspections</h2>
        <button onClick={() => { setShowForm(!showForm); initChecklist("Move-In"); }} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-indigo-700">+ New Inspection</button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-slate-700 mb-3">New Inspection</h3>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Property *</label><PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} companyId={companyId} /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Inspection Type</label><select value={form.type} onChange={e => { setForm({ ...form, type: e.target.value }); initChecklist(e.target.value); }} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full">
              {["Move-In", "Move-Out", "Periodic"].map(t => <option key={t}>{t}</option>)}
            </select></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Inspector</label><input placeholder="Inspector name" value={form.inspector} onChange={e => setForm({ ...form, inspector: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Date</label><input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div className="col-span-2"><label className="text-xs font-medium text-slate-400 mb-1 block">Notes</label><textarea placeholder="General notes about the inspection" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" rows={2} /></div>
          </div>

          {/* Checklist */}
          <h4 className="font-semibold text-slate-700 mb-2 text-sm">Checklist Items</h4>
          <div className="space-y-2 mb-4">
            {Object.entries(checklist).map(([item, val]) => (
              <div key={item} className="flex items-center gap-3 bg-indigo-50/30 rounded-lg px-3 py-2">
                <span className="text-sm text-slate-700 flex-1">{item}</span>
                <button onClick={() => setChecklist({ ...checklist, [item]: { ...val, pass: true } })} className={`text-xs px-2 py-1 rounded ${val.pass === true ? "bg-green-500 text-white" : "bg-slate-200 text-slate-500"}`}>Pass</button>
                <button onClick={() => setChecklist({ ...checklist, [item]: { ...val, pass: false } })} className={`text-xs px-2 py-1 rounded ${val.pass === false ? "bg-red-500 text-white" : "bg-slate-200 text-slate-500"}`}>Fail</button>
                <input placeholder="Note" value={val.notes} onChange={e => setChecklist({ ...checklist, [item]: { ...val, notes: e.target.value } })} className="border border-indigo-100 rounded px-2 py-1 text-xs w-32" />
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <button onClick={saveInspection} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-indigo-700">Save Inspection</button>
            <button onClick={() => setShowForm(false)} className="bg-slate-100 text-slate-500 text-sm px-4 py-2 rounded-2xl hover:bg-slate-100">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {inspections.map(insp => (
          <div key={insp.id} className="bg-white rounded-3xl shadow-card border border-indigo-50 p-4">
            <div className="flex justify-between items-start">
              <div>
                <div className="font-semibold text-slate-800">{insp.property}</div>
                <div className="text-xs text-slate-400 mt-0.5">{insp.type} Inspection · {insp.inspector}</div>
              </div>
              <Badge status={insp.status} label={insp.status} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div><span className="text-slate-400">Date</span><div className="font-semibold text-slate-700">{insp.date}</div></div>
              <div><span className="text-slate-400">Type</span><div className="font-semibold text-slate-700">{insp.type}</div></div>
            </div>
            <div className="mt-3 flex gap-2 flex-wrap">
              <button onClick={() => setSelectedInspection(insp)} className="text-xs text-indigo-600 border border-indigo-200 px-3 py-1 rounded-lg hover:bg-indigo-50">📋 View Report</button>
              {insp.status === "scheduled" && <button onClick={() => updateStatus(insp.id, "completed")} className="text-xs text-green-600 border border-green-200 px-3 py-1 rounded-lg hover:bg-green-50">✓ Mark Complete</button>}
              {insp.status === "completed" && <button onClick={async () => {
                const items = (() => { try { return JSON.parse(insp.items || "{}"); } catch { return {}; } })();
                const failed = Object.entries(items).filter(([, v]) => v.pass === false).map(([k]) => k);
                if (failed.length === 0) { alert("No failed items in this inspection."); return; }
                if (!window.confirm(`Create work order for ${failed.length} failed item(s)?\n\n${failed.join(", ")}`)) return;
                const { error } = await supabase.from("work_orders").insert([{ company_id: companyId, property: insp.property, issue: `Inspection findings: ${failed.join(", ")}`, priority: "normal", status: "open", notes: `Auto-created from ${insp.type} inspection on ${insp.date}` }]);
                if (error) { alert("Error: " + error.message); return; }
                addNotification("🔧", `Work order created from inspection at ${insp.property}`);
              }} className="text-xs text-orange-600 border border-orange-200 px-3 py-1 rounded-lg hover:bg-orange-50"><span className="material-icons-outlined text-xs align-middle">build</span> Create Work Order</button>}
            </div>
          </div>
        ))}
        {inspections.length === 0 && <div className="text-center py-12 text-slate-400">No inspections yet. Create one above.</div>}
      </div>
    </div>
  );
}

// ============ LEASE MANAGEMENT ============
function LeaseManagement({ addNotification, userProfile, userRole, companyId }) {
  const [leases, setLeases] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("active");
  const [showForm, setShowForm] = useState(false);
  const [editingLease, setEditingLease] = useState(null);
  const [showChecklist, setShowChecklist] = useState(null);
  const [showDepositModal, setShowDepositModal] = useState(null);
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [showESign, setShowESign] = useState(null);

  const defaultChecklist = ["Keys handed over","Smoke detectors tested","Appliances working","Walls condition documented","Floors condition documented","Plumbing checked","Electrical checked","Windows & doors checked","HVAC filter replaced","Photos taken"];
  const defaultMoveOutChecklist = ["Keys returned","All personal items removed","Unit cleaned","Walls patched/repaired","Appliances clean","Carpets cleaned","Final inspection done","Forwarding address collected","Utilities transferred","Security deposit review"];

  const [form, setForm] = useState({
    tenant_name: "", property: "", start_date: "", end_date: "",
    rent_amount: "", security_deposit: "", rent_escalation_pct: "3",
    escalation_frequency: "annual", payment_due_day: "1",
    lease_type: "fixed", auto_renew: false, renewal_notice_days: "60",
    clauses: "", special_terms: "", template_id: "",
    late_fee_amount: "50", late_fee_type: "flat", late_fee_grace_days: "5",
  });
  const [showRentIncrease, setShowRentIncrease] = useState(null);
  const [rentIncreaseForm, setRentIncreaseForm] = useState({ new_amount: "", effective_date: "", reason: "" });
  const [templateForm, setTemplateForm] = useState({ name: "", description: "", clauses: "", special_terms: "", default_deposit_months: "1", default_lease_months: "12", default_escalation_pct: "3", payment_due_day: "1" });
  const [depositForm, setDepositForm] = useState({ amount_returned: "", deductions: "", return_date: formatLocalDate(new Date()) });

  useEffect(() => { fetchData(); }, [companyId]);

  async function fetchData() {
    setLoading(true);
    const [l, t, p, tmpl] = await Promise.all([
      supabase.from("leases").select("*").eq("company_id", companyId).order("created_at", { ascending: false }),
      supabase.from("tenants").select("*").eq("company_id", companyId),
      supabase.from("properties").select("*").eq("company_id", companyId),
      supabase.from("lease_templates").select("*").eq("company_id", companyId).order("name"),
    ]);
    setLeases(l.data || []);
    setTenants(t.data || []);
    setProperties(p.data || []);
    setTemplates(tmpl.data || []);
    setLoading(false);
  }

  function applyTemplate(templateId) {
    const tmpl = templates.find(t => String(t.id) === String(templateId));
    if (!tmpl) return;
    const months = tmpl.default_lease_months || 12;
    const start = form.start_date || formatLocalDate(new Date());
    const endDate = parseLocalDate(start);
    const origDay = endDate.getDate();
    endDate.setMonth(endDate.getMonth() + months);
    // Clamp if month overflow (e.g., Jan 31 + 1 month = Mar 3 → Feb 28)
    if (endDate.getDate() !== origDay) endDate.setDate(0); // setDate(0) = last day of prev month
    setForm({ ...form, template_id: templateId, clauses: tmpl.clauses || "", special_terms: tmpl.special_terms || "", rent_escalation_pct: String(tmpl.default_escalation_pct || 3), payment_due_day: String(tmpl.payment_due_day || 1), end_date: formatLocalDate(endDate) });
  }

  function prefillFromTenant(tenantName) {
    const tenant = tenants.find(t => t.name === tenantName);
    if (tenant) setForm(f => ({ ...f, tenant_name: tenant.name, property: tenant.property || "", rent_amount: String(tenant.rent || "") }));
  }

  async function saveLease() {
    if (!guardSubmit("saveLease")) return;
    try {
    if (!form.tenant_name) { alert("Please select a tenant."); return; }
    if (!form.property) { alert("Please select a property."); return; }
    if (!form.start_date || !form.end_date) { alert("Lease start and end dates are required."); return; }
    if (!form.rent_amount || isNaN(Number(form.rent_amount)) || Number(form.rent_amount) <= 0) { alert("Please enter a valid positive rent amount."); return; }
    if (form.start_date >= form.end_date) { alert("Lease end date must be after start date."); return; }
    if (Number(form.security_deposit || 0) < 0) { alert("Security deposit cannot be negative."); return; }
    if (Number(form.rent_escalation_pct || 0) < 0 || Number(form.rent_escalation_pct || 0) > 25) { alert("Rent escalation must be between 0% and 25%."); return; }
    const tenant = tenants.find(t => t.name === form.tenant_name);
    // Prevent duplicate active leases for same tenant+property
    if (!editingLease) {
      const { data: existingActive } = await supabase.from("leases").select("id").eq("company_id", companyId).eq("tenant_name", form.tenant_name).eq("property", form.property).eq("status", "active").limit(1);
      if (existingActive?.length > 0) {
        if (!window.confirm("An active lease already exists for " + form.tenant_name + " at " + form.property + ". Creating another will result in double rent charges. Continue?")) return;
      }
    }
    const payload = {
      tenant_id: tenant?.id || null, tenant_name: form.tenant_name, property: form.property,
      start_date: form.start_date, end_date: form.end_date, rent_amount: Number(form.rent_amount),
      security_deposit: Number(form.security_deposit || 0), rent_escalation_pct: Number(form.rent_escalation_pct || 0),
      escalation_frequency: form.escalation_frequency, payment_due_day: Math.max(1, Math.min(31, Math.floor(Number(form.payment_due_day || 1)))),
      lease_type: form.lease_type, auto_renew: form.auto_renew, renewal_notice_days: Number(form.renewal_notice_days || 60),
      clauses: form.clauses, special_terms: form.special_terms, status: "active",
      late_fee_amount: Number(form.late_fee_amount || 50), late_fee_type: form.late_fee_type || "flat", late_fee_grace_days: Number(form.late_fee_grace_days || 5),
      move_in_checklist: JSON.stringify(defaultChecklist.map(item => ({ item, checked: false }))),
      move_out_checklist: JSON.stringify(defaultMoveOutChecklist.map(item => ({ item, checked: false }))),
      created_by: normalizeEmail(userProfile?.email),
    };
    let error;
    if (editingLease) {
      ({ error } = await supabase.from("leases").update({ tenant_name: payload.tenant_name, property: payload.property, start_date: payload.start_date, end_date: payload.end_date, rent_amount: payload.rent_amount, security_deposit: payload.security_deposit, rent_escalation_pct: payload.rent_escalation_pct, escalation_frequency: payload.escalation_frequency, payment_due_day: payload.payment_due_day, lease_type: payload.lease_type, auto_renew: payload.auto_renew, renewal_notice_days: payload.renewal_notice_days, clauses: payload.clauses, special_terms: payload.special_terms, late_fee_amount: payload.late_fee_amount, late_fee_type: payload.late_fee_type, late_fee_grace_days: payload.late_fee_grace_days }).eq("id", editingLease.id).eq("company_id", companyId));
    } else {
      ({ error } = await supabase.from("leases").insert([{ ...payload, company_id: companyId }]));
      if (!error && tenant) {
        const { error: tenantErr } = await supabase.from("tenants").update({ lease_status: "active", move_in: form.start_date, move_out: form.end_date, rent: Number(form.rent_amount) }).eq("company_id", companyId).eq("id", tenant.id);
        if (tenantErr) console.warn("Tenant status update failed:", tenantErr.message);
      }
      if (!error && Number(form.security_deposit) > 0) {
        const classId = await getPropertyClassId(form.property, companyId);
        const dep = Number(form.security_deposit);
        const _jeOk = await autoPostJournalEntry({ companyId, date: form.start_date, description: "Security deposit received — " + form.tenant_name + " — " + form.property, reference: "DEP-" + shortId(), property: form.property,
          lines: [
            { account_id: "1000", account_name: "Checking Account", debit: dep, credit: 0, class_id: classId, memo: "Security deposit from " + form.tenant_name },
            { account_id: "2100", account_name: "Security Deposits Held", debit: 0, credit: dep, class_id: classId, memo: form.tenant_name + " — " + form.property },
          ]
        });
        if (!_jeOk) { alert("Accounting entry failed. The operation was recorded but the journal entry could not be posted. Please check the accounting module."); }
        
        // Create ledger entry for deposit collection
        if (tenant?.id) {
          await safeLedgerInsert({ company_id: companyId,
            tenant: form.tenant_name, property: form.property, date: form.start_date,
            description: "Security deposit collected", amount: dep, type: "deposit", balance: 0,
          });
          if (!_jeOk) { alert("Accounting entry failed. The operation was recorded but the journal entry could not be posted. Please check the accounting module."); }
        }
      }
    }
    if (error) { alert("Error saving lease: " + error.message); return; }
    // Update properties table to reflect lease assignment
    if (!editingLease && tenant) {
      const { error: _err4608 } = await supabase.from("properties").update({ tenant: form.tenant_name, lease_end: form.end_date, status: "occupied" }).eq("company_id", companyId).eq("address", form.property);
      if (_err4608) { alert("Error updating properties: " + _err4608.message); return; }
    }
    // (property_id auto-filled by DB trigger from property address)
    // Auto-post rent charges — prompt if backdated
    if (!editingLease) {
      const leaseStartDate = parseLocalDate(form.start_date);
      const today = new Date();
      const monthsBack = Math.max(0, (today.getFullYear() - leaseStartDate.getFullYear()) * 12 + (today.getMonth() - leaseStartDate.getMonth()));
      if (monthsBack > 0) {
        if (window.confirm("This lease starts " + monthsBack + " month(s) in the past.\n\nWould you like to post " + monthsBack + " backdated rent accrual entries now?\n\n• Each month will create an Accounts Receivable charge\n• Tenant balance will be updated\n• You can also do this later from the Dashboard")) {
          const result = await autoPostRentCharges(companyId);
          if (result?.posted > 0) addNotification("⚡", "Posted " + result.posted + " backdated rent charge(s)");
          if (result?.failed > 0) addNotification("⚠️", result.failed + " charge(s) failed");
        }
      } else {
        await autoPostRentCharges(companyId);
      }
    }
    logAudit(editingLease ? "update" : "create", "leases", (editingLease ? "Updated" : "Created") + " lease: " + form.tenant_name + " at " + form.property, editingLease?.id || "", userProfile?.email, userRole, companyId);
    // Queue lease notification
    if (!editingLease) {
      const { data: leaseTenant } = await supabase.from("tenants").select("email").eq("name", form.tenant_name).eq("company_id", companyId).maybeSingle();
      if (leaseTenant?.email) queueNotification("lease_created", leaseTenant.email, { tenant: form.tenant_name, property: form.property, startDate: form.start_date, endDate: form.end_date, rent: form.rent_amount }, companyId);
    }
    resetForm(); fetchData();
    } finally { guardRelease("saveLease"); }
  }

  function resetForm() {
    setShowForm(false); setEditingLease(null);
    setForm({ tenant_name: "", property: "", start_date: "", end_date: "", rent_amount: "", security_deposit: "", rent_escalation_pct: "3", escalation_frequency: "annual", payment_due_day: "1", lease_type: "fixed", auto_renew: false, renewal_notice_days: "60", clauses: "", special_terms: "", template_id: "", late_fee_amount: "50", late_fee_type: "flat", late_fee_grace_days: "5" });
  }

  function startEdit(lease) {
    setEditingLease(lease);
    setForm({ tenant_name: lease.tenant_name, property: lease.property, start_date: lease.start_date, end_date: lease.end_date, rent_amount: String(lease.rent_amount), security_deposit: String(lease.security_deposit || 0), rent_escalation_pct: String(lease.rent_escalation_pct || 0), escalation_frequency: lease.escalation_frequency || "annual", payment_due_day: String(lease.payment_due_day || 1), lease_type: lease.lease_type || "fixed", auto_renew: lease.auto_renew || false, renewal_notice_days: String(lease.renewal_notice_days || 60), clauses: lease.clauses || "", special_terms: lease.special_terms || "", template_id: "", late_fee_amount: String(lease.late_fee_amount || 50), late_fee_type: lease.late_fee_type || "flat", late_fee_grace_days: String(lease.late_fee_grace_days || 5) });
    setShowForm(true);
  }

  async function renewLease(lease) {
    // Apply escalation based on frequency (Bug 19: was ignoring frequency)
    let escalationMultiplier = 1;
    const pct = lease.rent_escalation_pct > 0 ? lease.rent_escalation_pct / 100 : 0;
    if (pct > 0) {
      const freq = lease.escalation_frequency || "annual";
      if (freq === "semi-annual") escalationMultiplier = Math.min(Math.pow(1 + pct, 2), 10);
      else if (freq === "quarterly") escalationMultiplier = Math.min(Math.pow(1 + pct, 4), 10);
      else escalationMultiplier = 1 + pct; // annual or default
    }
    const escalated = lease.rent_amount * escalationMultiplier;
    const newStart = lease.end_date;
    const newEnd = parseLocalDate(newStart); newEnd.setFullYear(newEnd.getFullYear() + 1);
    // Bug 15: Clamp for leap year (Feb 29 in non-leap year → Feb 28)
    const endLastDay = new Date(newEnd.getFullYear(), newEnd.getMonth() + 1, 0).getDate();
    if (newEnd.getDate() > endLastDay) newEnd.setDate(endLastDay);
    if (!window.confirm("Renew lease for " + lease.tenant_name + "?\nNew rent: $" + Math.round(escalated * 100) / 100 + "/mo\nNew term: " + newStart + " to " + formatLocalDate(newEnd))) return;
    // Bug 1-2: Check errors and rollback on failure
    const { error: updateErr } = await supabase.from("leases").update({ status: "renewed" }).eq("company_id", companyId).eq("id", lease.id);
    if (updateErr) { alert("Error updating old lease: " + updateErr.message); return; }
    const { error: insertErr } = await supabase.from("leases").insert([{ company_id: companyId, tenant_id: lease.tenant_id, tenant_name: lease.tenant_name, property: lease.property, start_date: newStart, end_date: formatLocalDate(newEnd), rent_amount: Math.round(escalated * 100) / 100, security_deposit: lease.security_deposit, rent_escalation_pct: lease.rent_escalation_pct, escalation_frequency: lease.escalation_frequency, payment_due_day: lease.payment_due_day, lease_type: "renewal", auto_renew: lease.auto_renew, renewal_notice_days: lease.renewal_notice_days, clauses: lease.clauses, special_terms: lease.special_terms, status: "active", renewed_from: lease.id, created_by: userProfile?.email || "", move_in_checklist: "[]", move_out_checklist: lease.move_out_checklist }]);
    if (insertErr) {
      const { error: _err4650 } = await supabase.from("leases").update({ status: "active" }).eq("company_id", companyId).eq("id", lease.id); // rollback
      if (_err4650) { alert("Error updating leases: " + _err4650.message); return; }
      alert("Error creating renewed lease: " + insertErr.message); return;
    }
    if (lease.tenant_id) await supabase.from("tenants").update({ rent: Math.round(escalated * 100) / 100, move_out: formatLocalDate(newEnd) }).eq("company_id", companyId).eq("id", lease.tenant_id);
    // Sync autopay schedule to new rent amount
    await supabase.from("autopay_schedules").update({ amount: Math.round(escalated * 100) / 100 }).eq("company_id", companyId).eq("tenant", lease.tenant_name).eq("enabled", true);
    // Update property table to reflect new lease end date
    const { error: _err4655 } = await supabase.from("properties").update({ lease_end: formatLocalDate(newEnd) }).eq("company_id", companyId).eq("address", lease.property);
    if (_err4655) { alert("Error updating properties: " + _err4655.message); return; }
    logAudit("create", "leases", "Renewed lease: " + lease.tenant_name + " new rent $" + Math.round(escalated * 100) / 100, lease.id, userProfile?.email, userRole, companyId);
    await autoPostRentCharges(companyId);
    fetchData();
  }

  async function terminateLease(lease) {
    if (!window.confirm("Terminate lease for " + lease.tenant_name + "? This cannot be undone.")) return;
    const { error: termErr } = await supabase.from("leases").update({ status: "terminated" }).eq("company_id", companyId).eq("id", lease.id);
    if (termErr) { alert("Error terminating lease: " + termErr.message); return; }
    if (lease.tenant_id) {
      const { error: _err4666 } = await supabase.from("tenants").update({ lease_status: "inactive" }).eq("company_id", companyId).eq("id", lease.tenant_id);
      if (_err4666) { alert("Error updating tenants: " + _err4666.message); return; }
      // Deactivate any autopay schedules for this tenant
      const { error: _err4668 } = await supabase.from("autopay_schedules").update({ active: false }).eq("company_id", companyId).eq("tenant", lease.tenant_name);
      if (_err4668) { alert("Error updating autopay_schedules: " + _err4668.message); return; }
      // Update property status back to vacant
      const { error: _err4670 } = await supabase.from("properties").update({ status: "vacant", tenant: "", lease_end: "" }).eq("company_id", companyId).eq("address", lease.property);
      if (_err4670) { alert("Error updating properties: " + _err4670.message); return; }
      // Create termination ledger entry
      await safeLedgerInsert({ company_id: companyId,
        tenant: lease.tenant_name, property: lease.property, date: formatLocalDate(new Date()),
        description: "Lease terminated", amount: 0, type: "adjustment", balance: 0,
      });
    }
    logAudit("update", "leases", "Terminated lease: " + lease.tenant_name, lease.id, userProfile?.email, userRole, companyId);
    fetchData();
  }

  async function toggleChecklistItem(lease, type, index) {
    const field = type === "in" ? "move_in_checklist" : "move_out_checklist";
    let checklist = []; try { checklist = JSON.parse(lease[field] || "[]"); } catch { checklist = []; }
    if (checklist[index]) checklist[index].checked = !checklist[index].checked;
    const allDone = checklist.every(c => c.checked);
    const update = { [field]: JSON.stringify(checklist) };
    if (type === "in") update.move_in_completed = allDone;
    if (type === "out") update.move_out_completed = allDone;
    // update only contains checklist field + completion flag — safe
    const { error: _err4690 } = await supabase.from("leases").update(update).eq("id", lease.id).eq("company_id", companyId);
    if (_err4690) { alert("Error updating leases: " + _err4690.message); return; }
    fetchData();
  }

  async function processDepositReturn(lease) {
    if (lease.deposit_status === "returned" || lease.deposit_status === "forfeited") {
      alert("Deposit has already been processed for this lease."); return;
    }
    const returned = Number(depositForm.amount_returned || 0);
    const deposit = safeNum(lease.security_deposit);
    const deducted = deposit - returned;
    if (returned < 0 || deducted < 0) { alert("Amounts cannot be negative."); return; }
    if (returned > deposit) {
      if (!window.confirm("Return amount ($" + returned + ") exceeds the original deposit ($" + deposit + "). Continue?")) return;
    }
    if (!depositForm.return_date) { alert("Return date is required."); return; }
    const status = returned >= deposit ? "returned" : returned > 0 ? "partial_return" : "forfeited";
    const { error: depErr } = await supabase.from("leases").update({ deposit_status: status, deposit_returned: returned, deposit_return_date: depositForm.return_date, deposit_deductions: depositForm.deductions }).eq("company_id", companyId).eq("id", lease.id);
    if (depErr) { alert("Error processing deposit return: " + depErr.message); return; }
    const classId = await getPropertyClassId(lease.property, companyId);
    if (returned > 0) {
      const _jeOk = await autoPostJournalEntry({ companyId, date: depositForm.return_date, description: "Security deposit return — " + lease.tenant_name, reference: "DEPRET-" + shortId(), property: lease.property,
        lines: [
          { account_id: "2100", account_name: "Security Deposits Held", debit: returned, credit: 0, class_id: classId, memo: "Return to " + lease.tenant_name },
          { account_id: "1000", account_name: "Checking Account", debit: 0, credit: returned, class_id: classId, memo: "Deposit refund" },
        ]
      });
      if (!_jeOk) { alert("Accounting entry failed. The operation was recorded but the journal entry could not be posted. Please check the accounting module."); }
      
    }
    if (deducted > 0) {
      const _jeOk = await autoPostJournalEntry({ companyId, date: depositForm.return_date, description: "Deposit deduction — " + lease.tenant_name + " — " + depositForm.deductions, reference: "DEPDED-" + shortId(), property: lease.property,
        lines: [
          { account_id: "2100", account_name: "Security Deposits Held", debit: deducted, credit: 0, class_id: classId, memo: "Deduction: " + depositForm.deductions },
          { account_id: "4100", account_name: "Other Income", debit: 0, credit: deducted, class_id: classId, memo: "Deposit forfeiture: " + lease.tenant_name },
        ]
      });
      if (!_jeOk) { alert("Accounting entry failed. The operation was recorded but the journal entry could not be posted. Please check the accounting module."); }
      
    }
    // Create ledger entry and update balance for deposit return
    if (returned > 0 && lease.tenant_id) {
      await safeLedgerInsert({ company_id: companyId,
        tenant: lease.tenant_name, property: lease.property, date: depositForm.return_date,
        description: "Security deposit returned", amount: -returned, type: "deposit_return", balance: 0,
      });
      if (!_jeOk) { alert("Accounting entry failed. The operation was recorded but the journal entry could not be posted. Please check the accounting module."); }
      const { error: depBalErr } = await supabase.rpc("update_tenant_balance", { p_tenant_id: lease.tenant_id, p_amount_change: -returned });
      if (depBalErr) alert("Deposit return balance update failed: " + depBalErr.message + ". Please verify the tenant balance.");
    }
    if (deducted > 0 && lease.tenant_id) {
      await safeLedgerInsert({ company_id: companyId,
        tenant: lease.tenant_name, property: lease.property, date: depositForm.return_date,
        description: "Deposit deduction: " + depositForm.deductions, amount: deducted, type: "deposit_deduction", balance: 0,
      });
    }
    logAudit("update", "leases", "Deposit return: $" + returned + " to " + lease.tenant_name, lease.id, userProfile?.email, userRole, companyId);
    // Queue deposit return notification
    const { data: depTenant } = await supabase.from("tenants").select("email").eq("name", lease.tenant_name).eq("company_id", companyId).maybeSingle();
    if (depTenant?.email) queueNotification("deposit_returned", depTenant.email, { tenant: lease.tenant_name, returned, deducted, property: lease.property }, companyId);
    setShowDepositModal(null); setDepositForm({ amount_returned: "", deductions: "", return_date: formatLocalDate(new Date()) });
    fetchData();
  }

  async function saveTemplate() {
      if (!guardSubmit("saveTemplate")) return;
      try {
    if (!templateForm.name) { alert("Template name is required."); return; }
    const { error } = await supabase.from("lease_templates").insert([{ ...templateForm, default_deposit_months: Number(templateForm.default_deposit_months || 1), default_lease_months: Number(templateForm.default_lease_months || 12), default_escalation_pct: Number(templateForm.default_escalation_pct || 3), payment_due_day: Math.max(1, Math.min(31, Number(templateForm.payment_due_day || 1))), company_id: companyId }]);
    if (error) { alert("Error: " + error.message); return; }
    setShowTemplateForm(false); setTemplateForm({ name: "", description: "", clauses: "", special_terms: "", default_deposit_months: "1", default_lease_months: "12", default_escalation_pct: "3", payment_due_day: "1" });
    fetchData();
      } finally { guardRelease("saveTemplate"); }
  }

  if (loading) return <Spinner />;

  const today = formatLocalDate(new Date());
  const active = leases.filter(l => l.status === "active");
  const expiringSoon = active.filter(l => { const d = Math.ceil((parseLocalDate(l.end_date) - new Date()) / 86400000); return d <= 90 && d > 0; });
  const expired = leases.filter(l => l.status === "expired" || (l.status === "active" && l.end_date < today));
  const totalDeposits = active.reduce((s, l) => s + safeNum(l.security_deposit), 0);
  const filteredLeases = activeTab === "active" ? active : activeTab === "expiring" ? expiringSoon : activeTab === "expired" ? expired : activeTab === "all" ? leases : leases.filter(l => l.status === activeTab);

  return (
    <div>
      <div className="flex justify-between items-center mb-5">
        <h2 className="text-2xl font-manrope font-bold text-slate-800">Lease Management</h2>
        <div className="flex gap-2">
          <button onClick={() => setShowTemplateForm(true)} className="text-xs border border-indigo-100 text-slate-500 px-3 py-2 rounded-lg hover:bg-indigo-50/30">Manage Templates</button>
          <button onClick={() => { resetForm(); setShowForm(true); }} className="bg-indigo-600 text-white text-xs px-4 py-2 rounded-2xl hover:bg-indigo-700">+ New Lease</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-5 md:grid-cols-4">
        <StatCard label="Active Leases" value={active.length} color="text-green-600" sub="current" />
        <StatCard label="Expiring (90d)" value={expiringSoon.length} color={expiringSoon.length > 0 ? "text-amber-600" : "text-slate-400"} sub="need attention" />
        <StatCard label="Total Deposits" value={"$" + totalDeposits.toLocaleString()} color="text-purple-600" sub="held" />
        <StatCard label="Avg Rent" value={"$" + (active.length > 0 ? Math.round(active.reduce((s, l) => s + safeNum(l.rent_amount), 0) / active.length) : 0)} color="text-blue-600" sub="per lease" />
      </div>

      {expiringSoon.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-3xl p-4 mb-4">
          <div className="font-semibold text-amber-800 text-sm mb-2">Leases Expiring Soon</div>
          {expiringSoon.map(l => { const d = Math.ceil((parseLocalDate(l.end_date) - new Date()) / 86400000); return (
            <div key={l.id} className="flex justify-between items-center py-1 text-sm">
              <span className="text-amber-700">{l.tenant_name} — {l.property}</span>
              <div className="flex items-center gap-2"><span className="text-amber-600 font-bold">{d} days</span><button onClick={() => renewLease(l)} className="text-xs bg-amber-600 text-white px-2 py-1 rounded hover:bg-amber-700">Renew</button></div>
            </div>
          ); })}
        </div>
      )}

      <div className="flex gap-1 mb-4 border-b border-indigo-50 overflow-x-auto">
        {[["active","Active"],["expiring","Expiring"],["expired","Expired"],["renewed","Renewed"],["terminated","Terminated"],["all","All"]].map(([id,label]) => (
          <button key={id} onClick={() => setActiveTab(id)} className={"px-3 py-2 text-xs font-medium border-b-2 whitespace-nowrap " + (activeTab === id ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-400")}>{label}{id === "expiring" && expiringSoon.length > 0 ? " (" + expiringSoon.length + ")" : ""}</button>
        ))}
      </div>

      {showTemplateForm && (
        <Modal title="Lease Template" onClose={() => setShowTemplateForm(false)}>
          <div className="space-y-3">
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Template Name *</label><input placeholder="Standard 12-Month Lease" value={templateForm.name} onChange={e => setTemplateForm({...templateForm, name: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Description</label><input placeholder="Default template for residential leases" value={templateForm.description} onChange={e => setTemplateForm({...templateForm, description: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="text-xs text-slate-400">Lease Length (months)</label><input type="number" min="1" max="120" placeholder="12" value={templateForm.default_lease_months} onChange={e => setTemplateForm({...templateForm, default_lease_months: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
              <div><label className="text-xs text-slate-400">Annual Escalation %</label><input type="number" step="0.1" min="0" max="25" placeholder="3.0" value={templateForm.default_escalation_pct} onChange={e => setTemplateForm({...templateForm, default_escalation_pct: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            </div>
            <textarea placeholder="Standard clauses..." value={templateForm.clauses} onChange={e => setTemplateForm({...templateForm, clauses: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" rows={4} />
            <textarea placeholder="Special terms..." value={templateForm.special_terms} onChange={e => setTemplateForm({...templateForm, special_terms: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" rows={3} />
            <button onClick={saveTemplate} className="bg-indigo-600 text-white text-sm px-6 py-2 rounded-2xl hover:bg-indigo-700">Save Template</button>
          </div>
        </Modal>
      )}

      {showESign && <ESignatureModal lease={showESign} onClose={() => setShowESign(null)} onSigned={() => fetchData()} userProfile={userProfile} companyId={companyId} />}

      {showDepositModal && (
        <Modal title={"Return Deposit — " + showDepositModal.tenant_name} onClose={() => setShowDepositModal(null)}>
          <div className="space-y-3">
            <div className="bg-purple-50 rounded-lg p-3 text-sm"><div className="flex justify-between"><span className="text-slate-400">Original Deposit:</span><span className="font-bold">${safeNum(showDepositModal.security_deposit).toLocaleString()}</span></div></div>
            <div><label className="text-xs text-slate-400">Amount to Return ($)</label><input type="number" value={depositForm.amount_returned} onChange={e => setDepositForm({...depositForm, amount_returned: e.target.value})} placeholder={String(showDepositModal.security_deposit)} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400">Deduction Reasons</label><textarea value={depositForm.deductions} onChange={e => setDepositForm({...depositForm, deductions: e.target.value})} placeholder="Cleaning, damages, unpaid rent..." className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" rows={3} /></div>
            <div><label className="text-xs text-slate-400">Return Date</label><input type="date" value={depositForm.return_date} onChange={e => setDepositForm({...depositForm, return_date: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            {Number(depositForm.amount_returned || 0) < safeNum(showDepositModal.security_deposit) && depositForm.amount_returned && (
              <div className="bg-red-50 rounded-lg p-2 text-xs text-red-700">Deducting ${(safeNum(showDepositModal.security_deposit) - Number(depositForm.amount_returned)).toLocaleString()} from deposit</div>
            )}
            <button onClick={() => processDepositReturn(showDepositModal)} className="bg-purple-600 text-white text-sm px-6 py-2 rounded-lg hover:bg-purple-700">Process Return</button>
          </div>
        </Modal>
      )}

      {showChecklist && (
        <Modal title={(showChecklist.type === "in" ? "Move-In" : "Move-Out") + " Checklist — " + showChecklist.lease.tenant_name} onClose={() => setShowChecklist(null)}>
          <div className="space-y-2">
            {(() => { let items = []; try { items = JSON.parse(showChecklist.lease[showChecklist.type === "in" ? "move_in_checklist" : "move_out_checklist"] || "[]"); } catch {} return items.map((item, i) => (
              <div key={i} onClick={() => toggleChecklistItem(showChecklist.lease, showChecklist.type, i)} className={"flex items-center gap-3 p-2 rounded-lg cursor-pointer border " + (item.checked ? "bg-green-50 border-green-200" : "bg-white border-gray-100 hover:bg-indigo-50/30")}>
                <span className={"w-5 h-5 rounded border flex items-center justify-center text-xs " + (item.checked ? "bg-green-500 border-green-500 text-white" : "border-indigo-200")}>{item.checked ? "✓" : ""}</span>
                <span className={"text-sm " + (item.checked ? "line-through text-slate-400" : "text-slate-700")}>{item.item}</span>
              </div>
            )); })()}
          </div>
        </Modal>
      )}

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-5 mb-5">
          <h3 className="font-manrope font-semibold text-slate-800 mb-4">{editingLease ? "Edit Lease" : "Create New Lease"}</h3>
          {!editingLease && templates.length > 0 && (
            <div className="mb-4"><label className="text-xs text-slate-400 mb-1 block">Apply Template</label>
              <select value={form.template_id} onChange={e => { setForm({...form, template_id: e.target.value}); applyTemplate(e.target.value); }} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
                <option value="">Select template...</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name} — {t.description}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div><label className="text-xs text-slate-400 mb-1 block">Tenant *</label>
              <select value={form.tenant_name} onChange={e => { setForm({...form, tenant_name: e.target.value}); prefillFromTenant(e.target.value); }} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
                <option value="">Select tenant...</option>
                {tenants.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
              </select>
            </div>
            <div><label className="text-xs text-slate-400 mb-1 block">Property *</label><PropertySelect value={form.property} onChange={v => setForm({...form, property: v})} companyId={companyId} /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Lease Start *</label><input type="date" value={form.start_date} onChange={e => setForm({...form, start_date: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Lease End *</label><input type="date" value={form.end_date} onChange={e => setForm({...form, end_date: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Monthly Rent ($) *</label><input type="number" min="0" step="0.01" placeholder="1500.00" value={form.rent_amount} onChange={e => setForm({...form, rent_amount: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Security Deposit ($)</label><input type="number" min="0" step="0.01" placeholder="1500.00" value={form.security_deposit} onChange={e => setForm({...form, security_deposit: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Annual Escalation %</label><input type="number" step="0.1" min="0" max="25" placeholder="3.0" value={form.rent_escalation_pct} onChange={e => setForm({...form, rent_escalation_pct: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Payment Due Day</label><input type="number" min="1" max="31" placeholder="1" value={form.payment_due_day} onChange={e => setForm({...form, payment_due_day: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Lease Type</label>
              <select value={form.lease_type} onChange={e => setForm({...form, lease_type: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm"><option value="fixed">Fixed Term</option><option value="month_to_month">Month-to-Month</option><option value="renewal">Renewal</option></select></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Renewal Notice (days)</label><input type="number" min="0" max="180" placeholder="60" value={form.renewal_notice_days} onChange={e => setForm({...form, renewal_notice_days: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
          </div>
          {/* Late Fee Settings */}
          <div className="bg-amber-50 border border-amber-200 rounded-3xl p-4 mb-4">
            <div className="text-sm font-semibold text-amber-800 mb-2">⚠️ Late Fee Settings</div>
            <div className="grid grid-cols-3 gap-3">
              <div><label className="text-xs text-slate-400 mb-1 block">Grace Period (days)</label><input type="number" min="0" max="30" placeholder="5" value={form.late_fee_grace_days} onChange={e => setForm({...form, late_fee_grace_days: e.target.value})} className="w-full border border-amber-200 rounded-lg px-3 py-2 text-sm bg-white" /></div>
              <div><label className="text-xs text-slate-400 mb-1 block">Fee Type</label><select value={form.late_fee_type} onChange={e => setForm({...form, late_fee_type: e.target.value})} className="w-full border border-amber-200 rounded-lg px-3 py-2 text-sm bg-white"><option value="flat">Flat ($)</option><option value="percent">Percent (%)</option></select></div>
              <div><label className="text-xs text-slate-400 mb-1 block">{form.late_fee_type === "flat" ? "Fee Amount ($)" : "Fee Percentage (%)"}</label><input type="number" step="0.01" min="0" placeholder="50.00" value={form.late_fee_amount} onChange={e => setForm({...form, late_fee_amount: e.target.value})} className="w-full border border-amber-200 rounded-lg px-3 py-2 text-sm bg-white" /></div>
            </div>
            <p className="text-xs text-amber-600 mt-2">Late fees auto-apply to tenant ledger after grace period. Admin can waive from ledger.</p>
          </div>
          <div className="flex items-center gap-2 mb-4"><input type="checkbox" checked={form.auto_renew} onChange={e => setForm({...form, auto_renew: e.target.checked})} className="rounded" /><label className="text-sm text-slate-500">Auto-renew at end of term</label></div>
          <div className="mb-3"><label className="text-xs text-slate-400 mb-1 block">Lease Clauses</label><textarea value={form.clauses} onChange={e => setForm({...form, clauses: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" rows={3} placeholder="Standard clauses..." /></div>
          <div className="mb-4"><label className="text-xs text-slate-400 mb-1 block">Special Terms</label><textarea value={form.special_terms} onChange={e => setForm({...form, special_terms: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" rows={2} placeholder="Pet deposit, parking, storage..." /></div>
          <div className="flex gap-2">
            <button onClick={saveLease} className="bg-indigo-600 text-white text-sm px-6 py-2 rounded-2xl hover:bg-indigo-700">{editingLease ? "Update Lease" : "Create Lease"}</button>
            <button onClick={resetForm} className="text-sm text-slate-400 px-4 py-2 hover:text-slate-700">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {filteredLeases.map(l => {
          const daysLeft = Math.ceil((parseLocalDate(l.end_date) - new Date()) / 86400000);
          const isExpired = daysLeft <= 0 && l.status === "active";
          const sc = { active: "bg-green-100 text-green-700", expired: "bg-red-100 text-red-700", renewed: "bg-blue-100 text-blue-700", terminated: "bg-slate-100 text-slate-500", draft: "bg-amber-100 text-amber-700" };
          const dc = { held: "bg-purple-100 text-purple-700", partial_return: "bg-amber-100 text-amber-700", returned: "bg-green-100 text-green-700", forfeited: "bg-red-100 text-red-700" };
          return (
            <div key={l.id} className={"bg-white rounded-xl border shadow-sm p-4 " + (isExpired ? "border-red-200" : "border-indigo-50")}>
              <div className="flex justify-between items-start mb-3">
                <div><div className="text-sm font-bold text-slate-800">{l.tenant_name}</div><div className="text-xs text-slate-400">{l.property}</div></div>
                <div className="flex items-center gap-2">
                  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (sc[isExpired ? "expired" : l.status] || "bg-slate-100")}>{isExpired ? "EXPIRED" : l.status}</span>
                  {l.lease_type === "renewal" && <span className="px-2 py-0.5 rounded-full text-xs bg-blue-50 text-blue-600">Renewal</span>}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-3 md:grid-cols-4">
                <div><span className="text-slate-400">Term:</span> <span className="font-medium">{l.start_date} to {l.end_date}</span></div>
                <div><span className="text-slate-400">Rent:</span> <span className="font-bold text-slate-800">${safeNum(l.rent_amount).toLocaleString()}/mo</span></div>
                <div><span className="text-slate-400">Deposit:</span> <span className="font-medium">${safeNum(l.security_deposit).toLocaleString()}</span>{l.security_deposit > 0 && <span className={"ml-1 px-1 py-0.5 rounded text-xs " + (dc[l.deposit_status] || "")}>{l.deposit_status}</span>}</div>
                <div><span className="text-slate-400">Escalation:</span> <span className="font-medium">{l.rent_escalation_pct || 0}%/yr</span></div>
                {l.status === "active" && <div><span className="text-slate-400">Days Left:</span> <span className={"font-bold " + (daysLeft <= 30 ? "text-red-600" : daysLeft <= 90 ? "text-amber-600" : "text-green-600")}>{daysLeft}</span></div>}
                <div><span className="text-slate-400">Due Day:</span> <span className="font-medium">{l.payment_due_day || 1}th</span></div>
                <div><span className="text-slate-400">Type:</span> <span className="font-medium capitalize">{(l.lease_type || "fixed").replace("_"," ")}</span></div>
                <div><span className="text-slate-400">Auto-Renew:</span> <span className="font-medium">{l.auto_renew ? "Yes" : "No"}</span></div>
              </div>
              <div className="flex flex-wrap gap-2 pt-2 border-t border-indigo-50/50">
                <button onClick={() => startEdit(l)} className="text-xs text-indigo-600 border border-indigo-200 px-3 py-1 rounded-lg hover:bg-indigo-50">Edit</button>
                <button onClick={() => setShowESign(l)} className={"text-xs border px-3 py-1 rounded-lg " + (l.signature_status === "fully_signed" ? "text-green-600 border-green-200 bg-green-50" : "text-purple-600 border-purple-200 hover:bg-purple-50")}>{l.signature_status === "fully_signed" ? "✓ Signed" : "\u270d\ufe0f E-Sign"}</button>
                {l.status === "active" && <button onClick={() => renewLease(l)} className="text-xs text-green-600 border border-green-200 px-3 py-1 rounded-lg hover:bg-green-50">Renew</button>}
                {l.status === "active" && <button onClick={() => { setShowRentIncrease(l); setRentIncreaseForm({ new_amount: String(l.rent_amount), effective_date: formatLocalDate(new Date()), reason: "" }); }} className="text-xs text-blue-600 border border-blue-200 px-3 py-1 rounded-lg hover:bg-blue-50">📈 Rent Increase</button>}
                {l.status === "active" && <button onClick={() => terminateLease(l)} className="text-xs text-red-600 border border-red-200 px-3 py-1 rounded-lg hover:bg-red-50">Terminate</button>}
                <button onClick={() => setShowChecklist({ lease: l, type: "in" })} className={"text-xs border px-3 py-1 rounded-lg " + (l.move_in_completed ? "text-green-600 border-green-200 bg-green-50" : "text-slate-400 border-indigo-100 hover:bg-indigo-50/30")}>Move-In {l.move_in_completed ? "✓" : ""}</button>
                <button onClick={() => setShowChecklist({ lease: l, type: "out" })} className={"text-xs border px-3 py-1 rounded-lg " + (l.move_out_completed ? "text-green-600 border-green-200 bg-green-50" : "text-slate-400 border-indigo-100 hover:bg-indigo-50/30")}>Move-Out {l.move_out_completed ? "✓" : ""}</button>
                {safeNum(l.security_deposit) > 0 && l.deposit_status === "held" && (l.status === "terminated" || l.status === "expired" || isExpired) && (
                  <button onClick={() => { setShowDepositModal(l); setDepositForm({ amount_returned: String(l.security_deposit), deductions: "", return_date: formatLocalDate(new Date()) }); }} className="text-xs text-purple-600 border border-purple-200 px-3 py-1 rounded-lg hover:bg-purple-50">Return Deposit</button>
                )}
              </div>
            </div>
          );
        })}
        {filteredLeases.length === 0 && <div className="text-center py-10 text-slate-400">No leases found</div>}
      </div>

      {/* Rent Increase Modal */}
      {showRentIncrease && (
        <Modal title={`Rent Increase — ${showRentIncrease.tenant_name}`} onClose={() => setShowRentIncrease(null)}>
          <div className="space-y-3">
            <div className="bg-indigo-50/30 rounded-xl p-3 text-sm">
              <div className="flex justify-between"><span className="text-slate-400">Current Rent:</span><span className="font-bold">${showRentIncrease.rent_amount}/mo</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Property:</span><span>{showRentIncrease.property}</span></div>
            </div>
            <div><label className="text-xs text-slate-400 mb-1 block">New Monthly Rent ($) *</label><input type="number" min="0" step="0.01" placeholder="1600.00" value={rentIncreaseForm.new_amount} onChange={e => setRentIncreaseForm({...rentIncreaseForm, new_amount: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Effective Date *</label><input type="date" value={rentIncreaseForm.effective_date} onChange={e => setRentIncreaseForm({...rentIncreaseForm, effective_date: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Reason</label><input value={rentIncreaseForm.reason} onChange={e => setRentIncreaseForm({...rentIncreaseForm, reason: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" placeholder="Market adjustment, annual increase..." /></div>
            {rentIncreaseForm.new_amount && Number(rentIncreaseForm.new_amount) !== showRentIncrease.rent_amount && (
              <div className={`text-sm font-semibold rounded-lg p-2 text-center ${Number(rentIncreaseForm.new_amount) > showRentIncrease.rent_amount ? "bg-red-50 text-red-600" : "bg-green-50 text-green-600"}`}>
                {Number(rentIncreaseForm.new_amount) > showRentIncrease.rent_amount ? "+" : ""}{Math.round((Number(rentIncreaseForm.new_amount) - showRentIncrease.rent_amount) / showRentIncrease.rent_amount * 100)}% ({Number(rentIncreaseForm.new_amount) > showRentIncrease.rent_amount ? "+" : ""}${Number(rentIncreaseForm.new_amount) - showRentIncrease.rent_amount}/mo)
              </div>
            )}
            <button onClick={async () => {
              if (!rentIncreaseForm.new_amount || !rentIncreaseForm.effective_date) { alert("Amount and date required."); return; }
              const newAmt = Number(rentIncreaseForm.new_amount);
              const { error: _err4960 } = await supabase.from("leases").update({ rent_amount: newAmt, rent_increase_history: JSON.stringify([...(JSON.parse(showRentIncrease.rent_increase_history || "[]")), { from: showRentIncrease.rent_amount, to: newAmt, date: rentIncreaseForm.effective_date, reason: rentIncreaseForm.reason }]) }).eq("company_id", companyId).eq("id", showRentIncrease.id);
              if (_err4960) { alert("Error updating leases: " + _err4960.message); return; }
              if (showRentIncrease.tenant_id) await supabase.from("tenants").update({ rent: newAmt }).eq("company_id", companyId).eq("id", showRentIncrease.tenant_id);
              addNotification("📈", `Rent increased to ${formatCurrency(newAmt)}/mo for ${showRentIncrease.tenant_name}`);
              logAudit("update", "leases", `Rent increase: ${formatCurrency(showRentIncrease.rent_amount)} → ${formatCurrency(newAmt)} for ${showRentIncrease.tenant_name}`, showRentIncrease.id, userProfile?.email, userRole, companyId);
              setShowRentIncrease(null);
              fetchData();
            }} className="w-full bg-indigo-600 text-white text-sm py-2.5 rounded-2xl hover:bg-indigo-700">Apply Rent Increase</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ============ VENDOR MANAGEMENT ============
function VendorManagement({ addNotification, userProfile, userRole, companyId }) {
  const [vendors, setVendors] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [workOrders, setWorkOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("vendors");
  const [showForm, setShowForm] = useState(false);
  const [showInvoiceForm, setShowInvoiceForm] = useState(false);
  const [editingVendor, setEditingVendor] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterSpecialty, setFilterSpecialty] = useState("all");

  const specialties = ["General","Plumbing","Electrical","HVAC","Roofing","Painting","Landscaping","Carpentry","Appliance Repair","Cleaning","Pest Control","Locksmith","Flooring","Drywall","Windows","Other"];

  const [form, setForm] = useState({
    name: "", company: "", email: "", phone: "", address: "",
    specialty: "General", license_number: "", insurance_expiry: "",
    hourly_rate: "", flat_rate: "", notes: "", status: "active",
  });

  const [invoiceForm, setInvoiceForm] = useState({
    vendor_id: "", vendor_name: "", work_order_id: "", property: "",
    description: "", amount: "", invoice_number: "", invoice_date: formatLocalDate(new Date()),
    due_date: "", payment_method: "", notes: "",
  });

  useEffect(() => { fetchData(); }, [companyId]);

  async function fetchData() {
    setLoading(true);
    const [v, inv, wo] = await Promise.all([
      supabase.from("vendors").select("*").eq("company_id", companyId).order("name"),
      supabase.from("vendor_invoices").select("*").eq("company_id", companyId).order("created_at", { ascending: false }),
      supabase.from("work_orders").select("*").eq("company_id", companyId).order("created_at", { ascending: false }).limit(100),
    ]);
    setVendors(v.data || []);
    setInvoices(inv.data || []);
    setWorkOrders(wo.data || []);
    setLoading(false);
  }

  async function saveVendor() {
      if (!guardSubmit("saveVendor")) return;
      try {
    if (!form.name) { alert("Vendor name is required."); return; }
    if (form.hourly_rate && (isNaN(Number(form.hourly_rate)) || Number(form.hourly_rate) < 0)) { alert("Hourly rate must be a valid positive number."); return; }
    if (form.flat_rate && (isNaN(Number(form.flat_rate)) || Number(form.flat_rate) < 0)) { alert("Flat rate must be a valid positive number."); return; }
    const payload = {
      ...form,
      hourly_rate: Number(form.hourly_rate || 0),
      flat_rate: Number(form.flat_rate || 0),
      insurance_expiry: form.insurance_expiry || null,
    };
    let error;
    if (editingVendor) {
      ({ error } = await supabase.from("vendors").update({ name: payload.name, company: payload.company, email: normalizeEmail(payload.email), phone: payload.phone, address: payload.address, specialty: payload.specialty, license_number: payload.license_number, insurance_expiry: payload.insurance_expiry, hourly_rate: payload.hourly_rate, flat_rate: payload.flat_rate, notes: payload.notes, status: payload.status }).eq("id", editingVendor.id).eq("company_id", companyId));
    } else {
      ({ error } = await supabase.from("vendors").insert([{ ...payload, email: normalizeEmail(payload.email), company_id: companyId }]));
    }
    if (error) { alert("Error: " + error.message); return; }
    logAudit(editingVendor ? "update" : "create", "vendors", (editingVendor ? "Updated" : "Added") + " vendor: " + form.name, editingVendor?.id || "", userProfile?.email, userRole, companyId);
    resetVendorForm();
    fetchData();
      } finally { guardRelease("saveVendor"); }
  }

  function resetVendorForm() {
    setShowForm(false);
    setEditingVendor(null);
    setForm({ name: "", company: "", email: "", phone: "", address: "", specialty: "General", license_number: "", insurance_expiry: "", hourly_rate: "", flat_rate: "", notes: "", status: "active" });
  }

  function startEditVendor(v) {
    setEditingVendor(v);
    setForm({ name: v.name, company: v.company || "", email: v.email || "", phone: v.phone || "", address: v.address || "", specialty: v.specialty || "General", license_number: v.license_number || "", insurance_expiry: v.insurance_expiry || "", hourly_rate: String(v.hourly_rate || ""), flat_rate: String(v.flat_rate || ""), notes: v.notes || "", status: v.status || "active" });
    setShowForm(true);
  }

  async function deleteVendor(id, name) {
      if (!guardSubmit("deleteVendor")) return;
      try {
    if (!window.confirm("Delete vendor " + name + "?")) return;
    await supabase.from("vendors").delete().eq("id", id).eq("company_id", companyId);
    logAudit("delete", "vendors", "Deleted vendor: " + name, id, userProfile?.email, userRole, companyId);
    fetchData();
      } finally { guardRelease("deleteVendor"); }
  }

  async function saveInvoice() {
      if (!guardSubmit("saveInvoice")) return;
      try {
    if (!invoiceForm.vendor_id) { alert("Please select a vendor."); return; }
    if (!invoiceForm.amount || isNaN(Number(invoiceForm.amount)) || Number(invoiceForm.amount) <= 0) { alert("Please enter a valid positive amount."); return; }
    const { error } = await supabase.from("vendor_invoices").insert([{
      ...invoiceForm,
      amount: Number(invoiceForm.amount),
      due_date: invoiceForm.due_date || null,
      invoice_date: invoiceForm.invoice_date || formatLocalDate(new Date()),
      status: "pending",
      company_id: companyId,
    }]);
    if (error) { alert("Error: " + error.message); return; }
    logAudit("create", "vendor_invoices", "Invoice: $" + invoiceForm.amount + " from " + invoiceForm.vendor_name, "", userProfile?.email, userRole, companyId);
    setShowInvoiceForm(false);
    setInvoiceForm({ vendor_id: "", vendor_name: "", work_order_id: "", property: "", description: "", amount: "", invoice_number: "", invoice_date: formatLocalDate(new Date()), due_date: "", payment_method: "", notes: "" });
    fetchData();
      } finally { guardRelease("saveInvoice"); }
  }

  async function payInvoice(inv) {
    if (!guardSubmit("payInvoice")) return;
    try {
    if (inv.status === "paid") { alert("This invoice is already paid."); return; }
    if (!window.confirm("Mark invoice #" + (inv.invoice_number || inv.id.slice(0,8)) + " as paid ($" + inv.amount + ")?")) return;
    const today = formatLocalDate(new Date());
    const { error: invErr } = await supabase.from("vendor_invoices").update({ status: "paid", paid_date: today }).eq("company_id", companyId).eq("id", inv.id);
    if (invErr) { alert("Error marking invoice as paid: " + invErr.message); return; }
    // Update vendor total_paid
    const vendor = vendors.find(v => String(v.id) === String(inv.vendor_id));
    if (vendor) {
      // Atomic increment via RPC (prevents concurrent update race)
      try {
        const { error: incErr } = await supabase.rpc("increment_vendor_totals", {
          p_company_id: companyId, p_vendor_id: String(vendor.id), p_amount: safeNum(inv.amount)
        });
        if (incErr) throw new Error(incErr.message);
      } catch (rpcE) {
        console.warn("Vendor increment RPC fallback:", rpcE.message);
        const { data: freshVendor } = await supabase.from("vendors").select("total_paid, total_jobs").eq("company_id", companyId).eq("id", vendor.id).maybeSingle();
        if (freshVendor) {
          const { error: _vendErr } = await supabase.from("vendors").update({
            total_paid: safeNum(freshVendor.total_paid) + safeNum(inv.amount),
            total_jobs: (freshVendor.total_jobs || 0) + 1,
          }).eq("company_id", companyId).eq("id", vendor.id);
          if (_vendErr) console.warn("Vendor totals fallback update failed:", _vendErr.message);
        }
      }
    }
    // Post to accounting
    const classId = await getPropertyClassId(inv.property, companyId);
    const _jeOk = await autoPostJournalEntry({
      companyId,
      date: today,
      description: "Vendor payment — " + inv.vendor_name + " — " + (inv.description || inv.invoice_number),
      reference: "VINV-" + shortId(),
      property: inv.property || "",
      lines: [
        { account_id: "5300", account_name: "Repairs & Maintenance", debit: safeNum(inv.amount), credit: 0, class_id: classId, memo: inv.vendor_name + ": " + inv.description },
        { account_id: "1000", account_name: "Checking Account", debit: 0, credit: safeNum(inv.amount), class_id: classId, memo: "Payment to " + inv.vendor_name },
      ]
    });
    if (!_jeOk) { alert("Accounting entry failed. The transaction was recorded but the journal entry could not be posted. Please check the accounting module."); }
    
    logAudit("update", "vendor_invoices", "Paid invoice: $" + inv.amount + " to " + inv.vendor_name, inv.id, userProfile?.email, userRole, companyId);
    fetchData();
    } finally { guardRelease("payInvoice"); }
  }

  async function rateVendor(vendor, rating) {
    const { error } = await supabase.from("vendors").update({ rating }).eq("company_id", companyId).eq("id", vendor.id);
    if (error) { alert("Failed to update rating: " + error.message); return; }
    fetchData();
  }

  if (loading) return <Spinner />;

  const activeVendors = vendors.filter(v => v.status === "active" || v.status === "preferred");
  const pendingInvoices = invoices.filter(i => i.status === "pending" || i.status === "approved");
  const totalOwed = pendingInvoices.reduce((s, i) => s + safeNum(i.amount), 0);
  const totalPaidAll = invoices.filter(i => i.status === "paid").reduce((s, i) => s + safeNum(i.amount), 0);
  const insuranceExpiring = vendors.filter(v => {
    if (!v.insurance_expiry) return false;
    const days = Math.ceil((parseLocalDate(v.insurance_expiry) - new Date()) / 86400000);
    return days <= 30 && days > 0;
  });

  const filteredVendors = vendors.filter(v =>
    (filterSpecialty === "all" || v.specialty === filterSpecialty) &&
    (!searchTerm || v.name.toLowerCase().includes(searchTerm.toLowerCase()) || (v.company || "").toLowerCase().includes(searchTerm.toLowerCase()) || (v.specialty || "").toLowerCase().includes(searchTerm.toLowerCase()))
  );

  return (
    <div>
      <div className="flex justify-between items-center mb-5">
        <h2 className="text-2xl font-manrope font-bold text-slate-800">Vendor Management</h2>
        <div className="flex gap-2">
          <button onClick={() => setShowInvoiceForm(true)} className="text-xs border border-indigo-100 text-slate-500 px-3 py-2 rounded-lg hover:bg-indigo-50/30">+ Invoice</button>
          <button onClick={() => { resetVendorForm(); setShowForm(true); }} className="bg-indigo-600 text-white text-xs px-4 py-2 rounded-2xl hover:bg-indigo-700">+ New Vendor</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-5 md:grid-cols-4">
        <StatCard label="Active Vendors" value={activeVendors.length} color="text-green-600" sub="available" />
        <StatCard label="Pending Invoices" value={pendingInvoices.length} color={pendingInvoices.length > 0 ? "text-amber-600" : "text-slate-400"} sub={"$" + totalOwed.toLocaleString() + " owed"} />
        <StatCard label="Total Paid (YTD)" value={"$" + totalPaidAll.toLocaleString()} color="text-blue-600" sub="all vendors" />
        <StatCard label="Insurance Alerts" value={insuranceExpiring.length} color={insuranceExpiring.length > 0 ? "text-red-500" : "text-slate-400"} sub="expiring < 30d" />
      </div>

      {insuranceExpiring.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 mb-4">
          <div className="font-semibold text-red-800 text-sm mb-1">Insurance Expiring Soon</div>
          {insuranceExpiring.map(v => (
            <div key={v.id} className="text-xs text-red-700">{v.name} ({v.specialty}) — expires {v.insurance_expiry}</div>
          ))}
        </div>
      )}

      <div className="flex gap-1 mb-4 border-b border-indigo-50">
        {[["vendors","Vendors"],["invoices","Invoices"]].map(([id,label]) => (
          <button key={id} onClick={() => setActiveTab(id)} className={"px-4 py-2 text-sm font-medium border-b-2 " + (activeTab === id ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-400")}>{label}</button>
        ))}
      </div>

      {/* New Vendor Form */}
      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-5 mb-5">
          <h3 className="font-manrope font-semibold text-slate-800 mb-4">{editingVendor ? "Edit Vendor" : "Add New Vendor"}</h3>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div><label className="text-xs text-slate-400 mb-1 block">Name *</label><input value={form.name} onChange={e => setForm({...form, name: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" placeholder="John Smith" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Company</label><input value={form.company} onChange={e => setForm({...form, company: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" placeholder="ABC Plumbing LLC" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Email</label><input type="email" placeholder="vendor@company.com" value={form.email} onChange={e => setForm({...form, email: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Phone</label><input type="tel" placeholder="(555) 123-4567" value={form.phone} onChange={e => setForm({...form, phone: formatPhoneInput(e.target.value)})} maxLength={14} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div className="col-span-2"><label className="text-xs font-medium text-slate-400 mb-1 block">Address</label><input placeholder="123 Main St, City, State ZIP" value={form.address} onChange={e => setForm({...form, address: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Specialty</label>
              <select value={form.specialty} onChange={e => setForm({...form, specialty: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
                {specialties.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div><label className="text-xs text-slate-400 mb-1 block">Status</label>
              <select value={form.status} onChange={e => setForm({...form, status: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
                <option value="active">Active</option><option value="preferred">Preferred</option><option value="inactive">Inactive</option><option value="blocked">Blocked</option>
              </select>
            </div>
            <div><label className="text-xs text-slate-400 mb-1 block">License #</label><input placeholder="e.g. VA-12345" value={form.license_number} onChange={e => setForm({...form, license_number: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Insurance Expiry</label><input type="date" value={form.insurance_expiry} onChange={e => setForm({...form, insurance_expiry: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Hourly Rate ($)</label><input placeholder="0.00" type="number" value={form.hourly_rate} onChange={e => setForm({...form, hourly_rate: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Flat Rate ($)</label><input placeholder="0.00" type="number" value={form.flat_rate} onChange={e => setForm({...form, flat_rate: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
          </div>
          <div className="mb-4"><label className="text-xs text-slate-400 mb-1 block">Notes</label><textarea value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" rows={2} /></div>
          <div className="flex gap-2">
            <button onClick={saveVendor} className="bg-indigo-600 text-white text-sm px-6 py-2 rounded-2xl hover:bg-indigo-700">{editingVendor ? "Update" : "Add Vendor"}</button>
            <button onClick={resetVendorForm} className="text-sm text-slate-400 px-4 py-2">Cancel</button>
          </div>
        </div>
      )}

      {/* Invoice Form */}
      {showInvoiceForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-5 mb-5">
          <h3 className="font-manrope font-semibold text-slate-800 mb-4">New Vendor Invoice</h3>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div><label className="text-xs text-slate-400 mb-1 block">Vendor *</label>
              <select value={invoiceForm.vendor_id} onChange={e => { const v = vendors.find(v => String(v.id) === String(e.target.value)); setInvoiceForm({...invoiceForm, vendor_id: e.target.value, vendor_name: v?.name || ""}); }} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
                <option value="">Select vendor...</option>
                {vendors.filter(v => v.status !== "blocked").map(v => <option key={v.id} value={v.id}>{v.name} ({v.specialty})</option>)}
              </select>
            </div>
            <div><label className="text-xs text-slate-400 mb-1 block">Property</label><PropertySelect value={invoiceForm.property} onChange={v => setInvoiceForm({...invoiceForm, property: v})} companyId={companyId} /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Amount ($) *</label><input type="number" min="0" step="0.01" placeholder="500.00" value={invoiceForm.amount} onChange={e => setInvoiceForm({...invoiceForm, amount: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Invoice #</label><input placeholder="INV-001" value={invoiceForm.invoice_number} onChange={e => setInvoiceForm({...invoiceForm, invoice_number: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Invoice Date</label><input type="date" value={invoiceForm.invoice_date} onChange={e => setInvoiceForm({...invoiceForm, invoice_date: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Due Date</label><input type="date" value={invoiceForm.due_date} onChange={e => setInvoiceForm({...invoiceForm, due_date: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div className="col-span-2"><label className="text-xs text-slate-400 mb-1 block">Description</label><input value={invoiceForm.description} onChange={e => setInvoiceForm({...invoiceForm, description: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" placeholder="Plumbing repair at 123 Main St" /></div>
          </div>
          <div className="flex gap-2">
            <button onClick={saveInvoice} className="bg-indigo-600 text-white text-sm px-6 py-2 rounded-2xl hover:bg-indigo-700">Save Invoice</button>
            <button onClick={() => setShowInvoiceForm(false)} className="text-sm text-slate-400 px-4 py-2">Cancel</button>
          </div>
        </div>
      )}

      {/* VENDORS TAB */}
      {activeTab === "vendors" && (
        <div>
          <div className="flex gap-2 mb-4">
            <input placeholder="Search vendors..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="flex-1 border border-indigo-100 rounded-2xl px-3 py-2 text-sm" />
            <select value={filterSpecialty} onChange={e => setFilterSpecialty(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
              <option value="all">All Specialties</option>
              {specialties.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="space-y-3">
            {filteredVendors.map(v => {
              const insExpired = v.insurance_expiry && parseLocalDate(v.insurance_expiry) < new Date();
              const insExpiring = v.insurance_expiry && !insExpired && Math.ceil((parseLocalDate(v.insurance_expiry) - new Date()) / 86400000) <= 30;
              const sc = { active: "bg-green-100 text-green-700", preferred: "bg-indigo-100 text-indigo-700", inactive: "bg-slate-100 text-slate-400", blocked: "bg-red-100 text-red-700" };
              return (
                <div key={v.id} className="bg-white rounded-3xl shadow-card border border-indigo-50 p-4">
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <div className="text-sm font-bold text-slate-800">{v.name}{v.company ? " — " + v.company : ""}</div>
                      <div className="text-xs text-slate-400">{v.specialty}{v.license_number ? " · Lic: " + v.license_number : ""}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (sc[v.status] || "bg-slate-100")}>{v.status}</span>
                      {v.rating > 0 && <span className="text-xs text-amber-500">{"\u2605".repeat(v.rating)}{"\u2606".repeat(5 - v.rating)}</span>}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-2 md:grid-cols-4">
                    {v.phone && <div><span className="text-slate-400">Phone:</span> <span className="font-medium">{v.phone}</span></div>}
                    {v.email && <div><span className="text-slate-400">Email:</span> <span className="font-medium">{v.email}</span></div>}
                    {v.hourly_rate > 0 && <div><span className="text-slate-400">Rate:</span> <span className="font-medium">${v.hourly_rate}/hr</span></div>}
                    {v.flat_rate > 0 && <div><span className="text-slate-400">Flat:</span> <span className="font-medium">${v.flat_rate}</span></div>}
                    <div><span className="text-slate-400">Jobs:</span> <span className="font-medium">{v.total_jobs || 0}</span></div>
                    <div><span className="text-slate-400">Total Paid:</span> <span className="font-medium">${safeNum(v.total_paid).toLocaleString()}</span></div>
                    {v.insurance_expiry && <div><span className="text-slate-400">Insurance:</span> <span className={"font-medium " + (insExpired ? "text-red-600" : insExpiring ? "text-amber-600" : "text-green-600")}>{v.insurance_expiry}{insExpired ? " (EXPIRED)" : ""}</span></div>}
                  </div>
                  {v.notes && <div className="text-xs text-slate-400 mb-2">{v.notes}</div>}
                  <div className="flex flex-wrap gap-2 pt-2 border-t border-indigo-50/50">
                    <button onClick={() => startEditVendor(v)} className="text-xs text-indigo-600 border border-indigo-200 px-3 py-1 rounded-lg hover:bg-indigo-50">Edit</button>
                    <button onClick={() => deleteVendor(v.id, v.name)} className="text-xs text-red-500 border border-red-200 px-3 py-1 rounded-lg hover:bg-red-50">Delete</button>
                    <div className="flex items-center gap-0.5 ml-2">
                      {[1,2,3,4,5].map(star => (
                        <button key={star} onClick={() => rateVendor(v, star)} className={"text-sm " + (star <= (v.rating || 0) ? "text-amber-400" : "text-slate-300")}>{star <= (v.rating || 0) ? "\u2605" : "\u2606"}</button>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
            {filteredVendors.length === 0 && <div className="text-center py-10 text-slate-400">No vendors found</div>}
          </div>
        </div>
      )}

      {/* INVOICES TAB */}
      {activeTab === "invoices" && (
        <div className="space-y-3">
          {invoices.map(inv => {
            const isOverdue = inv.status === "pending" && inv.due_date && parseLocalDate(inv.due_date) < new Date();
            const sc = { pending: "bg-amber-100 text-amber-700", approved: "bg-blue-100 text-blue-700", paid: "bg-green-100 text-green-700", disputed: "bg-red-100 text-red-700" };
            return (
              <div key={inv.id} className={"bg-white rounded-xl border shadow-sm p-4 " + (isOverdue ? "border-red-200" : "border-indigo-50")}>
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <div className="text-sm font-bold text-slate-800">{inv.vendor_name}</div>
                    <div className="text-xs text-slate-400">{inv.description || "Invoice"}{inv.invoice_number ? " #" + inv.invoice_number : ""}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-slate-800">${safeNum(inv.amount).toLocaleString()}</div>
                    <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (sc[inv.status] || "bg-slate-100")}>{isOverdue ? "OVERDUE" : inv.status}</span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-4 text-xs md:grid-cols-4">
                  {inv.property && <div><span className="text-slate-400">Property:</span> <span className="font-medium">{inv.property}</span></div>}
                  <div><span className="text-slate-400">Date:</span> <span className="font-medium">{inv.invoice_date}</span></div>
                  {inv.due_date && <div><span className="text-slate-400">Due:</span> <span className={"font-medium " + (isOverdue ? "text-red-600" : "")}>{inv.due_date}</span></div>}
                  {inv.paid_date && <div><span className="text-slate-400">Paid:</span> <span className="font-medium text-green-600">{inv.paid_date}</span></div>}
                </div>
                {(inv.status === "pending" || inv.status === "approved") && (
                  <div className="flex gap-2 pt-2 mt-2 border-t border-indigo-50/50">
                    <button onClick={() => payInvoice(inv)} className="text-xs text-green-600 border border-green-200 px-3 py-1 rounded-lg hover:bg-green-50">Mark Paid</button>
                  </div>
                )}
              </div>
            );
          })}
          {invoices.length === 0 && <div className="text-center py-10 text-slate-400">No invoices yet</div>}
        </div>
      )}
    </div>
  );
}

// ============ OWNER MANAGEMENT & STATEMENTS ============
function OwnerManagement({ addNotification, userProfile, userRole, companyId }) {
  const [owners, setOwners] = useState([]);
  const [properties, setProperties] = useState([]);
  const [statements, setStatements] = useState([]);
  const [distributions, setDistributions] = useState([]);
  const [payments, setPayments] = useState([]);
  const [vendorInvoices, setVendorInvoices] = useState([]);
  const [utilities, setUtilities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("owners");
  const [showForm, setShowForm] = useState(false);
  const [editingOwner, setEditingOwner] = useState(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [genOwner, setGenOwner] = useState("");
  const [genMonth, setGenMonth] = useState(formatLocalDate(new Date()).slice(0, 7));
  const [viewStatement, setViewStatement] = useState(null);

  const [form, setForm] = useState({
    name: "", email: "", phone: "", address: "", company: "",
    tax_id: "", payment_method: "check", bank_name: "", bank_routing: "",
    bank_account: "", management_fee_pct: "10", notes: "", status: "active",
  });

  useEffect(() => { fetchData(); }, [companyId]);

  async function fetchData() {
    setLoading(true);
    const [o, p, s, d, pay, vi, u] = await Promise.all([
      supabase.from("owners").select("*").eq("company_id", companyId).order("name"),
      supabase.from("properties").select("*").eq("company_id", companyId),
      supabase.from("owner_statements").select("*").eq("company_id", companyId).order("created_at", { ascending: false }),
      supabase.from("owner_distributions").select("*").eq("company_id", companyId).order("date", { ascending: false }),
      supabase.from("payments").select("*").eq("company_id", companyId).eq("status", "paid"),
      supabase.from("vendor_invoices").select("*").eq("company_id", companyId).eq("status", "paid"),
      supabase.from("utilities").select("*").eq("company_id", companyId).eq("status", "paid"),
    ]);
    setOwners(o.data || []);
    setProperties(p.data || []);
    setStatements(s.data || []);
    setDistributions(d.data || []);
    setPayments(pay.data || []);
    setVendorInvoices(vi.data || []);
    setUtilities(u.data || []);
    setLoading(false);
  }

  async function saveOwner() {
      if (!guardSubmit("saveOwner")) return;
      try {
    if (!form.name) { alert("Owner name is required."); return; }
    if (isNaN(Number(form.management_fee_pct || 10)) || Number(form.management_fee_pct || 10) < 0 || Number(form.management_fee_pct || 10) > 100) { alert("Management fee must be between 0% and 100%."); return; }
    const payload = { ...form, management_fee_pct: Number(form.management_fee_pct || 10) };
    let error;
    if (editingOwner) {
      ({ error } = await supabase.from("owners").update({ name: payload.name, email: normalizeEmail(payload.email), phone: payload.phone, address: payload.address, company: payload.company, tax_id: payload.tax_id, payment_method: payload.payment_method, bank_name: payload.bank_name, bank_routing: payload.bank_routing, bank_account: payload.bank_account, management_fee_pct: payload.management_fee_pct, notes: payload.notes, status: payload.status }).eq("id", editingOwner.id).eq("company_id", companyId));
    } else {
      ({ error } = await supabase.from("owners").insert([{ ...payload, email: normalizeEmail(payload.email), company_id: companyId }]));
    }
    if (error) { alert("Error: " + error.message); return; }
    logAudit(editingOwner ? "update" : "create", "owners", (editingOwner ? "Updated" : "Added") + " owner: " + form.name, editingOwner?.id || "", userProfile?.email, userRole, companyId);
    resetForm(); fetchData();
      } finally { guardRelease("saveOwner"); }
  }

  function resetForm() {
    setShowForm(false); setEditingOwner(null);
    setForm({ name: "", email: "", phone: "", address: "", company: "", tax_id: "", payment_method: "check", bank_name: "", bank_routing: "", bank_account: "", management_fee_pct: "10", notes: "", status: "active" });
  }

  function startEdit(o) {
    setEditingOwner(o);
    setForm({ name: o.name, email: o.email || "", phone: o.phone || "", address: o.address || "", company: o.company || "", tax_id: o.tax_id || "", payment_method: o.payment_method || "check", bank_name: o.bank_name || "", bank_routing: o.bank_routing || "", bank_account: o.bank_account || "", management_fee_pct: String(o.management_fee_pct || 10), notes: o.notes || "", status: o.status || "active" });
    setShowForm(true);
  }

  async function inviteOwner(owner) {
      if (!guardSubmit("inviteOwner")) return;
      try {
    if (!owner.email) { alert("This owner has no email address. Please add one first."); return; }
    if (!window.confirm("Send portal invite to " + owner.name + " (" + owner.email + ")?\n\nThis will:\n1. Create their authentication account\n2. Send a magic link to their email\n3. They can log in and access the Owner Portal")) return;
    try {
      const { error: authErr } = await supabase.auth.signInWithOtp({
        email: owner.email,
        options: { data: { name: owner.name, role: "owner" } }
      });
      if (authErr) {
        alert("Failed to send invitation email to " + owner.email + ": " + authErr.message + "\n\nPlease verify the email address and try again. No access records were created.");
        return;
      }
      // Create membership as "invited" — placeholder only, grants NO access.
      // Upgraded to "active" only after user completes signup.
      const { error: memErr } = await supabase.from("company_members").upsert([{
        company_id: companyId,
        user_email: (owner.email || "").toLowerCase(),
        user_name: owner.name,
        role: "owner",
        status: "invited",
        invited_by: userProfile?.email || "admin",
      }], { onConflict: "company_id,user_email" });
      if (memErr) { alert("Error creating invite: " + memErr.message); return; }
      addNotification("✉️", "Portal invite sent to " + owner.name);
      logAudit("create", "owners", "Invited owner to portal: " + owner.email, owner.id, userProfile?.email, userRole, companyId);
      alert("Owner portal invite sent to " + owner.email + "!\n\nThey can log in and see their properties, statements, and distributions.");
    } catch (e) {
      alert("Error inviting owner: " + e.message);
    }
      } finally { guardRelease("inviteOwner"); }
  }

  async function assignPropertyToOwner(propertyId, ownerId) {
    const owner = owners.find(o => String(o.id) === String(ownerId));
    const { error: _err5445 } = await supabase.from("properties").update({ owner_id: ownerId || null, owner_name: owner?.name || "" }).eq("company_id", companyId).eq("id", propertyId);
    if (_err5445) { alert("Error updating properties: " + _err5445.message); return; }
    fetchData();
  }

  async function generateStatement() {
    if (!genOwner) { alert("Please select an owner."); return; }
    const owner = owners.find(o => String(o.id) === String(genOwner));
    if (!owner) return;
    const startDate = genMonth + "-01";
    const endObj = parseLocalDate(startDate); endObj.setMonth(endObj.getMonth() + 1); endObj.setDate(0);
    const endDate = formatLocalDate(endObj);

    const ownerProps = properties.filter(p => String(p.owner_id) === String(owner.id)).map(p => p.address);
    if (ownerProps.length === 0) { alert("No properties assigned to " + owner.name); return; }

    // Fetch FRESH data from DB for accurate statement (not stale component state)
    const { data: freshPayments } = await supabase.from("payments").select("*").eq("company_id", companyId).eq("status", "paid").gte("date", startDate).lte("date", endDate);
    const monthPayments = (freshPayments || []).filter(p => ownerProps.includes(p.property));
    const totalIncome = monthPayments.reduce((s, p) => s + safeNum(p.amount), 0);

    // Gather expenses (fresh from DB)
    const { data: freshVendor } = await supabase.from("vendor_invoices").select("*").eq("company_id", companyId).eq("status", "paid");
    const monthVendor = (freshVendor || []).filter(v => ownerProps.includes(v.property) && v.paid_date && v.paid_date >= startDate && v.paid_date <= endDate);
    const { data: freshUtils } = await supabase.from("utilities").select("*").eq("company_id", companyId).eq("status", "paid");
    const monthUtils = (freshUtils || []).filter(u => ownerProps.includes(u.property) && u.due >= startDate && u.due <= endDate);
    const totalVendorExp = monthVendor.reduce((s, v) => s + safeNum(v.amount), 0);
    const totalUtilExp = monthUtils.reduce((s, u) => s + safeNum(u.amount), 0);
    const totalExpenses = totalVendorExp + totalUtilExp;

    const mgmtFee = Math.round(totalIncome * (owner.management_fee_pct / 100) * 100) / 100;
    const netToOwner = Math.round((totalIncome - totalExpenses - mgmtFee) * 100) / 100;

    // Build line items
    const lineItems = [];
    lineItems.push({ category: "INCOME", items: [] });
    monthPayments.forEach(p => lineItems[0].items.push({ description: p.type + " — " + (p.tenant || "Unknown") + " — " + p.property, amount: safeNum(p.amount), date: p.date }));
    lineItems.push({ category: "EXPENSES", items: [] });
    monthVendor.forEach(v => lineItems[1].items.push({ description: "Vendor: " + v.vendor_name + " — " + v.description, amount: -safeNum(v.amount), date: v.paid_date }));
    monthUtils.forEach(u => lineItems[1].items.push({ description: "Utility: " + u.provider + " — " + u.property, amount: -safeNum(u.amount), date: u.due }));
    lineItems.push({ category: "FEES", items: [{ description: "Management Fee (" + owner.management_fee_pct + "%)", amount: -mgmtFee, date: endDate }] });

    const { error } = await supabase.from("owner_statements").insert([{ company_id: companyId,
      owner_id: owner.id, owner_name: owner.name, period: genMonth,
      start_date: startDate, end_date: endDate,
      total_income: totalIncome, total_expenses: totalExpenses,
      management_fee: mgmtFee, net_to_owner: netToOwner,
      line_items: JSON.stringify(lineItems), status: "draft",
    }]);
    if (error) { alert("Error: " + error.message); return; }
    logAudit("create", "owner_statements", "Generated statement for " + owner.name + " — " + genMonth, "", userProfile?.email, userRole, companyId);
    setShowGenerate(false);
    fetchData();
  }

  async function markStatementSent(stmt) {
    const { error } = await supabase.from("owner_statements").update({ status: "sent", sent_date: formatLocalDate(new Date()) }).eq("company_id", companyId).eq("id", stmt.id);
    if (error) { alert("Failed to mark statement as sent: " + error.message); return; }
    fetchData();
  }

  async function distributeToOwner(stmt) {
    if (!guardSubmit("distributeToOwner")) return;
    try {
    if (stmt.status === "paid") { alert("This statement has already been distributed."); return; }
    if (stmt.net_to_owner <= 0) { alert("Net amount is $0 or negative. Nothing to distribute."); return; }
    if (!window.confirm("Distribute $" + stmt.net_to_owner.toLocaleString() + " to " + stmt.owner_name + "?")) return;
    const today = formatLocalDate(new Date());
    const owner = owners.find(o => String(o.id) === String(stmt.owner_id));
    // Record distribution
    const { error: distErr } = await supabase.from("owner_distributions").insert([{ company_id: companyId,
      owner_id: stmt.owner_id, statement_id: stmt.id,
      amount: stmt.net_to_owner, method: owner?.payment_method || "check",
      reference: "DIST-" + stmt.period, date: today,
    }]);
    if (distErr) { alert("Error recording distribution: " + distErr.message); return; }
    // Post to accounting BEFORE marking statement as paid
    const distJeOk = await autoPostJournalEntry({
      companyId,
      date: today,
      description: "Owner distribution — " + stmt.owner_name + " — " + stmt.period,
      reference: "ODIST-" + shortId(),
      property: stmt.property || "",
      lines: [
        { account_id: "2200", account_name: "Owner Distributions Payable", debit: safeNum(stmt.net_to_owner), credit: 0, memo: stmt.owner_name + " " + stmt.period },
        { account_id: "1000", account_name: "Checking Account", debit: 0, credit: safeNum(stmt.net_to_owner), memo: "Distribution to " + stmt.owner_name },
      ]
    });
    // Post management fee as revenue
    if (stmt.management_fee > 0) {
      const _jeOk = await autoPostJournalEntry({
        companyId,
        date: today,
        description: "Management fee — " + stmt.owner_name + " — " + stmt.period,
        reference: "MGMT-" + shortId(),
        property: stmt.property || "",
        lines: [
          { account_id: "2200", account_name: "Owner Distributions Payable", debit: safeNum(stmt.management_fee), credit: 0, memo: "Mgmt fee " + stmt.period },
          { account_id: "4200", account_name: "Management Fee Income", debit: 0, credit: safeNum(stmt.management_fee), memo: stmt.owner_name },
        ]
      });
      if (!_jeOk) { alert("Accounting entry failed. The transaction was recorded but the journal entry could not be posted. Please check the accounting module."); }
      
    }
    // Mark statement as paid only AFTER distribution + JE posting succeed
    if (!distJeOk) { alert("Distribution recorded but accounting entry failed. Statement NOT marked as paid."); fetchData(); return; }
    const { error: _err5549 } = await supabase.from("owner_statements").update({ status: "paid", paid_date: today }).eq("company_id", companyId).eq("id", stmt.id);
    if (_err5549) { alert("Error updating owner_statements: " + _err5549.message); return; }
    logAudit("create", "owner_distributions", "Distributed $" + stmt.net_to_owner + " to " + stmt.owner_name, stmt.id, userProfile?.email, userRole, companyId);
    fetchData();
    } finally { guardRelease("distributeToOwner"); }
  }

  if (loading) return <Spinner />;

  const activeOwners = owners.filter(o => o.status === "active");
  const totalDistributed = distributions.reduce((s, d) => s + safeNum(d.amount), 0);
  const pendingStatements = statements.filter(s => s.status === "draft" || s.status === "sent");
  const pendingAmount = pendingStatements.reduce((s, st) => s + safeNum(st.net_to_owner), 0);

  return (
    <div>
      <div className="flex justify-between items-center mb-5">
        <h2 className="text-2xl font-manrope font-bold text-slate-800">Owner Management</h2>
        <div className="flex gap-2">
          <button onClick={() => setShowGenerate(true)} className="text-xs border border-indigo-100 text-slate-500 px-3 py-2 rounded-lg hover:bg-indigo-50/30">Generate Statement</button>
          <button onClick={() => { resetForm(); setShowForm(true); }} className="bg-indigo-600 text-white text-xs px-4 py-2 rounded-2xl hover:bg-indigo-700">+ New Owner</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-5 md:grid-cols-4">
        <StatCard label="Active Owners" value={activeOwners.length} color="text-green-600" sub={properties.filter(p => p.owner_id).length + " properties assigned"} />
        <StatCard label="Pending Statements" value={pendingStatements.length} color={pendingStatements.length > 0 ? "text-amber-600" : "text-slate-400"} sub={"$" + pendingAmount.toLocaleString() + " owed"} />
        <StatCard label="Total Distributed" value={"$" + totalDistributed.toLocaleString()} color="text-blue-600" sub="all time" />
        <StatCard label="Unassigned Props" value={properties.filter(p => !p.owner_id).length} color={properties.filter(p => !p.owner_id).length > 0 ? "text-orange-500" : "text-slate-400"} sub="no owner" />
      </div>

      <div className="flex gap-1 mb-4 border-b border-indigo-50">
        {[["owners","Owners"],["properties","Properties"],["statements","Statements"],["distributions","Distributions"]].map(([id,label]) => (
          <button key={id} onClick={() => setActiveTab(id)} className={"px-3 py-2 text-sm font-medium border-b-2 " + (activeTab === id ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-400")}>{label}</button>
        ))}
      </div>

      {/* Generate Statement Modal */}
      {showGenerate && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-5 mb-5">
          <h3 className="font-manrope font-semibold text-slate-800 mb-4">Generate Owner Statement</h3>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div><label className="text-xs text-slate-400 mb-1 block">Owner *</label>
              <select value={genOwner} onChange={e => setGenOwner(e.target.value)} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
                <option value="">Select owner...</option>
                {activeOwners.map(o => <option key={o.id} value={o.id}>{o.name} ({properties.filter(p => String(p.owner_id) === String(o.id)).length} properties)</option>)}
              </select>
            </div>
            <div><label className="text-xs text-slate-400 mb-1 block">Month</label><input placeholder="Enter name" type="month" value={genMonth} onChange={e => setGenMonth(e.target.value)} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
          </div>
          {genOwner && (
            <div className="bg-indigo-50/30 rounded-lg p-3 mb-4 text-xs text-slate-500">
              <div className="font-semibold mb-1">Properties included:</div>
              {properties.filter(p => String(p.owner_id) === String(genOwner)).map(p => <div key={p.id}>{p.address}</div>)}
              {properties.filter(p => String(p.owner_id) === String(genOwner)).length === 0 && <div className="text-amber-600">No properties assigned to this owner</div>}
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={generateStatement} className="bg-indigo-600 text-white text-sm px-6 py-2 rounded-2xl hover:bg-indigo-700">Generate</button>
            <button onClick={() => setShowGenerate(false)} className="text-sm text-slate-400 px-4 py-2">Cancel</button>
          </div>
        </div>
      )}

      {/* Owner Form */}
      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-5 mb-5">
          <h3 className="font-manrope font-semibold text-slate-800 mb-4">{editingOwner ? "Edit Owner" : "Add New Owner"}</h3>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div><label className="text-xs text-slate-400 mb-1 block">Name *</label><input placeholder="John Smith" value={form.name} onChange={e => setForm({...form, name: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Company</label><input placeholder="Smith Properties LLC" value={form.company} onChange={e => setForm({...form, company: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Email</label><input type="email" placeholder="vendor@company.com" value={form.email} onChange={e => setForm({...form, email: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Phone</label><input type="tel" placeholder="(555) 123-4567" value={form.phone} onChange={e => setForm({...form, phone: formatPhoneInput(e.target.value)})} maxLength={14} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div className="col-span-2"><label className="text-xs font-medium text-slate-400 mb-1 block">Address</label><input placeholder="123 Main St, City, State ZIP" value={form.address} onChange={e => setForm({...form, address: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Tax ID / EIN</label><input placeholder="XX-XXXXXXX" value={form.tax_id} onChange={e => setForm({...form, tax_id: e.target.value})} maxLength={10} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Management Fee %</label><input type="number" step="0.5" min="0" max="50" placeholder="10.0" value={form.management_fee_pct} onChange={e => setForm({...form, management_fee_pct: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Payment Method</label>
              <select value={form.payment_method} onChange={e => setForm({...form, payment_method: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
                <option value="check">Check</option><option value="ach">ACH</option><option value="wire">Wire</option>
              </select>
            </div>
            <div><label className="text-xs text-slate-400 mb-1 block">Status</label>
              <select value={form.status} onChange={e => setForm({...form, status: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
                <option value="active">Active</option><option value="inactive">Inactive</option>
              </select>
            </div>
          </div>
          <div className="mb-4"><label className="text-xs text-slate-400 mb-1 block">Notes</label><textarea value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" rows={2} /></div>
          <div className="flex gap-2">
            <button onClick={saveOwner} className="bg-indigo-600 text-white text-sm px-6 py-2 rounded-2xl hover:bg-indigo-700">{editingOwner ? "Update" : "Add Owner"}</button>
            <button onClick={resetForm} className="text-sm text-slate-400 px-4 py-2">Cancel</button>
          </div>
        </div>
      )}

      {/* Statement Detail View */}
      {viewStatement && (
        <Modal title={"Statement — " + viewStatement.owner_name + " — " + viewStatement.period} onClose={() => setViewStatement(null)}>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-green-50 rounded-lg p-3 text-center"><div className="text-xs text-slate-400">Income</div><div className="text-lg font-bold text-green-700">${safeNum(viewStatement.total_income).toLocaleString()}</div></div>
              <div className="bg-red-50 rounded-lg p-3 text-center"><div className="text-xs text-slate-400">Expenses</div><div className="text-lg font-bold text-red-600">${safeNum(viewStatement.total_expenses).toLocaleString()}</div></div>
              <div className="bg-purple-50 rounded-lg p-3 text-center"><div className="text-xs text-slate-400">Mgmt Fee</div><div className="text-lg font-bold text-purple-700">${safeNum(viewStatement.management_fee).toLocaleString()}</div></div>
              <div className="bg-indigo-50 rounded-lg p-3 text-center"><div className="text-xs text-slate-400">Net to Owner</div><div className={"text-lg font-bold " + (viewStatement.net_to_owner >= 0 ? "text-indigo-700" : "text-red-600")}>${safeNum(viewStatement.net_to_owner).toLocaleString()}</div></div>
            </div>
            {(() => {
              let items = []; try { items = JSON.parse(viewStatement.line_items || "[]"); } catch {}
              return items.map((cat, ci) => (
                <div key={ci}>
                  <div className="font-semibold text-slate-700 text-sm mt-2 mb-1">{cat.category}</div>
                  {(cat.items || []).map((item, ii) => (
                    <div key={ii} className="flex justify-between text-xs py-1 border-b border-indigo-50/50">
                      <div className="text-slate-500">{item.description}<span className="text-slate-400 ml-2">{item.date}</span></div>
                      <div className={"font-bold " + (item.amount >= 0 ? "text-green-600" : "text-red-600")}>{item.amount >= 0 ? "+" : ""}${Math.abs(item.amount).toLocaleString()}</div>
                    </div>
                  ))}
                  {(cat.items || []).length === 0 && <div className="text-xs text-slate-400 py-1">None</div>}
                </div>
              ));
            })()}
            <div className="flex gap-2 pt-3 border-t border-indigo-50">
              {viewStatement.status === "draft" && <button onClick={() => { markStatementSent(viewStatement); setViewStatement(null); }} className="text-xs bg-blue-600 text-white px-4 py-2 rounded-lg">Mark Sent</button>}
              {(viewStatement.status === "draft" || viewStatement.status === "sent") && <button onClick={() => { distributeToOwner(viewStatement); setViewStatement(null); }} className="text-xs bg-green-600 text-white px-4 py-2 rounded-lg">Distribute ${safeNum(viewStatement.net_to_owner).toLocaleString()}</button>}
            </div>
          </div>
        </Modal>
      )}

      {/* OWNERS TAB */}
      {activeTab === "owners" && (
        <div className="space-y-3">
          {owners.map(o => {
            const ownerProps = properties.filter(p => String(p.owner_id) === String(o.id));
            const ownerDist = distributions.filter(d => String(d.owner_id) === String(o.id)).reduce((s, d) => s + safeNum(d.amount), 0);
            return (
              <div key={o.id} className="bg-white rounded-3xl shadow-card border border-indigo-50 p-4">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <div className="text-sm font-bold text-slate-800">{o.name}{o.company ? " — " + o.company : ""}</div>
                    <div className="text-xs text-slate-400">{o.email}{o.phone ? " · " + o.phone : ""}</div>
                  </div>
                  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (o.status === "active" ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-400")}>{o.status}</span>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-2 md:grid-cols-4">
                  <div><span className="text-slate-400">Properties:</span> <span className="font-bold">{ownerProps.length}</span></div>
                  <div><span className="text-slate-400">Mgmt Fee:</span> <span className="font-medium">{o.management_fee_pct}%</span></div>
                  <div><span className="text-slate-400">Total Distributed:</span> <span className="font-medium">${ownerDist.toLocaleString()}</span></div>
                  <div><span className="text-slate-400">Payment:</span> <span className="font-medium capitalize">{o.payment_method}</span></div>
                </div>
                {ownerProps.length > 0 && (
                  <div className="text-xs text-slate-400 mb-2">{ownerProps.map(p => p.address).join(" · ")}</div>
                )}
                <div className="flex gap-2 pt-2 border-t border-indigo-50/50">
                  <button onClick={() => inviteOwner(o)} className="text-xs text-purple-600 border border-purple-200 px-3 py-1 rounded-lg hover:bg-purple-50">✉️ Invite</button>
                  <button onClick={() => startEdit(o)} className="text-xs text-indigo-600 border border-indigo-200 px-3 py-1 rounded-lg hover:bg-indigo-50">Edit</button>
                  <button onClick={() => { setGenOwner(o.id); setShowGenerate(true); }} className="text-xs text-green-600 border border-green-200 px-3 py-1 rounded-lg hover:bg-green-50">Generate Statement</button>
                </div>
              </div>
            );
          })}
          {owners.length === 0 && <div className="text-center py-10 text-slate-400">No owners added yet</div>}
        </div>
      )}

      {/* PROPERTIES TAB - assign owners */}
      {activeTab === "properties" && (
        <div className="space-y-2">
          <div className="text-sm text-slate-400 mb-3">Assign owners to properties. This determines which income and expenses appear on each owner's statement.</div>
          {properties.map(p => (
            <div key={p.id} className="bg-white rounded-3xl border border-indigo-50 px-4 py-3 flex justify-between items-center">
              <div>
                <div className="text-sm font-medium text-slate-800">{p.address}</div>
                <div className="text-xs text-slate-400">{p.type} · {p.status}</div>
              </div>
              <select value={p.owner_id || ""} onChange={e => assignPropertyToOwner(p.id, e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-1.5 text-sm min-w-40">
                <option value="">No owner</option>
                {owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}

      {/* STATEMENTS TAB */}
      {activeTab === "statements" && (
        <div className="space-y-3">
          {statements.map(s => {
            const sc = { draft: "bg-amber-100 text-amber-700", sent: "bg-blue-100 text-blue-700", paid: "bg-green-100 text-green-700" };
            return (
              <div key={s.id} className="bg-white rounded-3xl shadow-card border border-indigo-50 p-4 cursor-pointer hover:border-indigo-200" onClick={() => setViewStatement(s)}>
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <div className="text-sm font-bold text-slate-800">{s.owner_name}</div>
                    <div className="text-xs text-slate-400">Period: {s.period}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-slate-800">${safeNum(s.net_to_owner).toLocaleString()}</div>
                    <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (sc[s.status] || "bg-slate-100")}>{s.status}</span>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div><span className="text-slate-400">Income:</span> <span className="text-green-600 font-medium">${safeNum(s.total_income).toLocaleString()}</span></div>
                  <div><span className="text-slate-400">Expenses:</span> <span className="text-red-600 font-medium">${safeNum(s.total_expenses).toLocaleString()}</span></div>
                  <div><span className="text-slate-400">Mgmt Fee:</span> <span className="text-purple-600 font-medium">${safeNum(s.management_fee).toLocaleString()}</span></div>
                </div>
              </div>
            );
          })}
          {statements.length === 0 && <div className="text-center py-10 text-slate-400">No statements generated yet. Click "Generate Statement" to create one.</div>}
        </div>
      )}

      {/* DISTRIBUTIONS TAB */}
      {activeTab === "distributions" && (
        <div className="space-y-2">
          {distributions.map(d => (
            <div key={d.id} className="bg-white rounded-3xl border border-indigo-50 px-4 py-3 flex justify-between items-center">
              <div>
                <div className="text-sm font-medium text-slate-800">{owners.find(o => String(o.id) === String(d.owner_id))?.name || "Unknown"}</div>
                <div className="text-xs text-slate-400">{d.date} · {d.method} · {d.reference}</div>
              </div>
              <div className="text-sm font-bold text-green-600">${safeNum(d.amount).toLocaleString()}</div>
            </div>
          ))}
          {distributions.length === 0 && <div className="text-center py-10 text-slate-400">No distributions yet</div>}
        </div>
      )}
    </div>
  );
}

// ============ BANK RECONCILIATION ============
function AcctBankReconciliation({ accounts, journalEntries, companyId }) {
  const [reconPeriod, setReconPeriod] = useState(formatLocalDate(new Date()).slice(0, 7));
  const [bankBalance, setBankBalance] = useState("");
  const [reconItems, setReconItems] = useState([]);
  const [reconciliations, setReconciliations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showReconcile, setShowReconcile] = useState(false);
  const [viewRecon, setViewRecon] = useState(null);

  useEffect(() => { fetchRecons(); }, [companyId]);

  async function fetchRecons() {
    const { data } = await supabase.from("bank_reconciliations").select("*").eq("company_id", companyId).order("created_at", { ascending: false });
    setReconciliations(data || []);
    setLoading(false);
  }

  async function startReconciliation() {
    if (!bankBalance || isNaN(Number(bankBalance))) { alert("Please enter the bank ending balance."); return; }
    const startDate = reconPeriod + "-01";
    const endObj = parseLocalDate(startDate); endObj.setMonth(endObj.getMonth() + 1); endObj.setDate(0);
    const endDate = formatLocalDate(endObj);

    // Pull all journal lines hitting the Checking Account (1000) in this period
    const { data: entries } = await supabase.from("acct_journal_entries").select("id, date, description, reference, status").eq("company_id", companyId).gte("date", startDate).lte("date", endDate).eq("status", "posted");
    if (!entries || entries.length === 0) { alert("No posted journal entries found for " + reconPeriod); return; }

    const entryIds = entries.map(e => e.id);
    const { data: lines } = await supabase.from("acct_journal_lines").select("*").in("journal_entry_id", entryIds).eq("account_name", "Checking Account");
    if (!lines || lines.length === 0) { alert("No checking account transactions found for " + reconPeriod); return; }

    // Build reconciliation items
    const items = lines.map(l => {
      const entry = entries.find(e => e.id === l.journal_entry_id);
      const amount = safeNum(l.debit) - safeNum(l.credit);
      return {
        id: l.id,
        journal_entry_id: l.journal_entry_id,
        date: entry?.date || "",
        description: entry?.description || "",
        reference: entry?.reference || "",
        amount: amount,
        memo: l.memo || "",
        reconciled: l.reconciled || false,
      };
    }).sort((a, b) => a.date.localeCompare(b.date));

    setReconItems(items);
    setShowReconcile(true);
  }

  function toggleReconItem(index) {
    const updated = [...reconItems];
    updated[index].reconciled = !updated[index].reconciled;
    setReconItems(updated);
  }

  function toggleAllRecon() {
    const allChecked = reconItems.every(i => i.reconciled);
    setReconItems(reconItems.map(i => ({ ...i, reconciled: !allChecked })));
  }

  async function saveReconciliation() {
    if (!guardSubmit("saveReconciliation")) return;
    try {
    const reconciledTotal = reconItems.filter(i => i.reconciled).reduce((s, i) => s + i.amount, 0);
    const unreconciledTotal = reconItems.filter(i => !i.reconciled).reduce((s, i) => s + i.amount, 0);

    // Calculate book balance from all checking account entries (scoped to this company)
    const cJeIds = journalEntries.filter(j => j.status === "posted").map(j => j.id);
    const { data: allLines } = cJeIds.length > 0
      ? await supabase.from("acct_journal_lines").select("debit, credit, account_id").eq("account_name", "Checking Account").in("journal_entry_id", cJeIds)
      : { data: [] };
    // Also include lines matched by account ID (handles renamed accounts)
    const { data: idLines } = cJeIds.length > 0
      ? await supabase.from("acct_journal_lines").select("debit, credit, account_id").like("account_id", "%-1000").in("journal_entry_id", cJeIds)
      : { data: [] };
    const allCheckingLines = [...(allLines || [])];
    (idLines || []).forEach(l => { if (!allCheckingLines.find(x => x === l)) allCheckingLines.push(l); });
    const bookBal = allCheckingLines.reduce((s, l) => s + safeNum(l.debit) - safeNum(l.credit), 0);
    const bankBal = Number(bankBalance);
    const diff = Math.round((bankBal - bookBal) * 100) / 100;
    const allItemsReconciled = reconItems.every(i => i.reconciled);
    const status = Math.abs(diff) < 0.01 && allItemsReconciled ? "reconciled" : Math.abs(diff) < 0.01 && !allItemsReconciled ? "pending_items" : "discrepancy";

    // Save reconciliation record
    const { error } = await supabase.from("bank_reconciliations").insert([{ company_id: companyId,
      period: reconPeriod,
      bank_ending_balance: bankBal,
      book_balance: Math.round(bookBal * 100) / 100,
      difference: diff,
      status: status,
      reconciled_items: JSON.stringify(reconItems.filter(i => i.reconciled)),
      unreconciled_items: JSON.stringify(reconItems.filter(i => !i.reconciled)),
      reconciled_by: "",
    }]);
    if (error) { alert("Error: " + error.message); return; }

    // Mark journal lines as reconciled in DB
    const reconIds = reconItems.filter(i => i.reconciled).map(i => i.id);
    if (reconIds.length > 0) {
      const today = formatLocalDate(new Date());
      // Verify these lines belong to this company's JEs before marking reconciled
      const validJeIds = new Set((journalEntries || []).map(j => j.id));
      const { data: checkLines } = await supabase.from("acct_journal_lines").select("id, journal_entry_id").in("id", reconIds);
      const safeIds = (checkLines || []).filter(l => validJeIds.has(l.journal_entry_id)).map(l => l.id);
      // Double-scope: filter by safe IDs AND by this company's JE IDs
      if (safeIds.length > 0) {
        const validJeIdArr = Array.from(validJeIds);
        const { error: reconErr } = await supabase.from("acct_journal_lines")
          .update({ reconciled: true, reconciled_date: today })
          .in("id", safeIds)
          .in("journal_entry_id", validJeIdArr);
        if (reconErr) { alert("Reconciliation update failed: " + reconErr.message); return; }
      }
    }

    logAudit("create", "bank_reconciliation", "Bank reconciliation for " + reconPeriod + " — diff: $" + diff, "", "", "", companyId);
    setShowReconcile(false);
    setBankBalance("");
    setReconItems([]);
    fetchRecons();
    } finally { guardRelease("saveReconciliation"); }
  }

  if (loading) return <Spinner />;

  const reconciledCount = reconItems.filter(i => i.reconciled).length;
  const reconciledTotal = reconItems.filter(i => i.reconciled).reduce((s, i) => s + i.amount, 0);
  const unreconciledTotal = reconItems.filter(i => !i.reconciled).reduce((s, i) => s + i.amount, 0);

  return (
    <div>
      {!showReconcile && !viewRecon && (
        <div>
          <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-5">
            <h3 className="font-manrope font-semibold text-slate-800 mb-3">Start Bank Reconciliation</h3>
            <div className="grid grid-cols-3 gap-3">
              <div><label className="text-xs text-slate-400 mb-1 block">Month</label><input placeholder="Enter name" type="month" value={reconPeriod} onChange={e => setReconPeriod(e.target.value)} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
              <div><label className="text-xs text-slate-400 mb-1 block">Bank Ending Balance ($)</label><input type="number" step="0.01" value={bankBalance} onChange={e => setBankBalance(e.target.value)} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" placeholder="Enter from bank statement" /></div>
              <div className="flex items-end"><button onClick={startReconciliation} className="bg-indigo-600 text-white text-sm px-6 py-2 rounded-2xl hover:bg-indigo-700 w-full">Begin Reconciliation</button></div>
            </div>
          </div>

          <h3 className="font-semibold text-slate-700 mb-3">Previous Reconciliations</h3>
          <div className="space-y-2">
            {reconciliations.map(r => {
              const sc = { reconciled: "bg-green-100 text-green-700", in_progress: "bg-amber-100 text-amber-700", discrepancy: "bg-red-100 text-red-700" };
              return (
                <div key={r.id} className="bg-white rounded-3xl border border-indigo-50 px-4 py-3 flex justify-between items-center cursor-pointer hover:border-indigo-200" onClick={() => setViewRecon(r)}>
                  <div>
                    <div className="text-sm font-medium text-slate-800">{r.period}</div>
                    <div className="text-xs text-slate-400">{new Date(r.created_at).toLocaleDateString()}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right text-xs">
                      <div>Bank: <span className="font-bold">${safeNum(r.bank_ending_balance).toLocaleString()}</span></div>
                      <div>Book: <span className="font-bold">${safeNum(r.book_balance).toLocaleString()}</span></div>
                    </div>
                    <div className="text-right">
                      {Math.abs(r.difference) > 0.01 && <div className="text-xs font-bold text-red-600">Diff: ${safeNum(r.difference).toLocaleString()}</div>}
                      <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (sc[r.status] || "")}>{r.status.replace("_"," ")}</span>
                    </div>
                  </div>
                </div>
              );
            })}
            {reconciliations.length === 0 && <div className="text-center py-8 text-slate-400">No reconciliations yet</div>}
          </div>
        </div>
      )}

      {viewRecon && (
        <div>
          <button onClick={() => setViewRecon(null)} className="text-sm text-indigo-600 mb-3 hover:underline">← Back</button>
          <div className="bg-white rounded-3xl border border-indigo-50 p-5">
            <div className="flex justify-between items-start mb-4">
              <div><h3 className="font-semibold text-slate-800">Reconciliation — {viewRecon.period}</h3><div className="text-xs text-slate-400">{new Date(viewRecon.created_at).toLocaleDateString()}</div></div>
              <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (viewRecon.status === "reconciled" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700")}>{viewRecon.status}</span>
            </div>
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="bg-blue-50 rounded-lg p-3 text-center"><div className="text-xs text-slate-400">Bank Balance</div><div className="text-lg font-bold text-blue-700">${safeNum(viewRecon.bank_ending_balance).toLocaleString()}</div></div>
              <div className="bg-indigo-50 rounded-lg p-3 text-center"><div className="text-xs text-slate-400">Book Balance</div><div className="text-lg font-bold text-indigo-700">${safeNum(viewRecon.book_balance).toLocaleString()}</div></div>
              <div className={"rounded-lg p-3 text-center " + (Math.abs(viewRecon.difference) < 0.01 ? "bg-green-50" : "bg-red-50")}><div className="text-xs text-slate-400">Difference</div><div className={"text-lg font-bold " + (Math.abs(viewRecon.difference) < 0.01 ? "text-green-700" : "text-red-600")}>${safeNum(viewRecon.difference).toLocaleString()}</div></div>
            </div>
            {(() => { let items = []; try { items = JSON.parse(viewRecon.unreconciled_items || "[]"); } catch {} return items.length > 0 ? (
              <div><div className="font-semibold text-red-700 text-sm mb-2">Unreconciled Items ({items.length})</div>
                {items.map((it, i) => (<div key={i} className="flex justify-between text-xs py-1 border-b border-indigo-50/50"><span className="text-slate-500">{it.date} — {it.description}</span><span className="font-bold">${it.amount.toLocaleString()}</span></div>))}
              </div>) : null; })()}
          </div>
        </div>
      )}

      {showReconcile && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <div>
              <h3 className="font-semibold text-slate-800">Reconcile — {reconPeriod}</h3>
              <div className="text-xs text-slate-400">Bank balance: ${Number(bankBalance).toLocaleString()} · Check items that match your bank statement</div>
            </div>
            <button onClick={() => { setShowReconcile(false); setReconItems([]); }} className="text-sm text-slate-400 hover:text-slate-700">Cancel</button>
          </div>

          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-green-50 rounded-lg p-3 text-center"><div className="text-xs text-slate-400">Reconciled ({reconciledCount})</div><div className="text-lg font-bold text-green-700">${reconciledTotal.toLocaleString()}</div></div>
            <div className="bg-amber-50 rounded-lg p-3 text-center"><div className="text-xs text-slate-400">Unreconciled ({reconItems.length - reconciledCount})</div><div className="text-lg font-bold text-amber-700">${unreconciledTotal.toLocaleString()}</div></div>
            <div className={"rounded-lg p-3 text-center " + (Math.abs(Number(bankBalance) - reconciledTotal) < 0.01 ? "bg-green-50" : "bg-red-50")}><div className="text-xs text-slate-400">Remaining Diff</div><div className={"text-lg font-bold " + (Math.abs(Number(bankBalance) - reconciledTotal) < 0.01 ? "text-green-700" : "text-red-600")}>${(Number(bankBalance) - reconciledTotal).toLocaleString()}</div></div>
          </div>

          <div className="mb-3 flex items-center gap-2">
            <button onClick={toggleAllRecon} className="text-xs text-indigo-600 border border-indigo-200 px-3 py-1 rounded-lg hover:bg-indigo-50">{reconItems.every(i => i.reconciled) ? "Uncheck All" : "Check All"}</button>
            <span className="text-xs text-slate-400">{reconItems.length} transactions</span>
          </div>

          <div className="space-y-1 mb-4">
            {reconItems.map((item, i) => (
              <div key={i} onClick={() => toggleReconItem(i)} className={"flex items-center gap-3 px-4 py-2.5 rounded-lg cursor-pointer border " + (item.reconciled ? "bg-green-50 border-green-200" : "bg-white border-gray-100 hover:bg-indigo-50/30")}>
                <span className={"w-5 h-5 rounded border flex items-center justify-center text-xs flex-shrink-0 " + (item.reconciled ? "bg-green-500 border-green-500 text-white" : "border-indigo-200")}>{item.reconciled ? "✓" : ""}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-800 truncate">{item.description}</div>
                  <div className="text-xs text-slate-400">{item.date} · {item.reference} · {item.memo}</div>
                </div>
                <div className={"text-sm font-bold flex-shrink-0 " + (item.amount >= 0 ? "text-green-600" : "text-red-600")}>{item.amount >= 0 ? "+" : ""}${item.amount.toLocaleString()}</div>
              </div>
            ))}
          </div>

          <button onClick={saveReconciliation} className="bg-indigo-600 text-white text-sm px-8 py-2.5 rounded-2xl hover:bg-indigo-700">Save Reconciliation</button>
        </div>
      )}
    </div>
  );
}

// ============ EMAIL NOTIFICATIONS ============
function EmailNotifications({ addNotification, userProfile, userRole, companyId }) {
  const [settings, setSettings] = useState([]);
  const [logs, setLogs] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [leases, setLeases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("settings");
  const [showTest, setShowTest] = useState(null);
  const [queueStats, setQueueStats] = useState({ pending: 0, sent: 0, failed: 0 });

  async function fetchQueueStatus() {
    try {
      const { data: items } = await supabase.from("notification_queue").select("status").eq("company_id", companyId).limit(500);
      if (items) {
        setQueueStats({
          pending: items.filter(i => i.status === "pending").length,
          sent: items.filter(i => i.status === "sent").length,
          failed: items.filter(i => i.status === "failed").length,
        });
      }
    } catch (e) { console.warn("fetchQueueStatus:", e.message); }
  }

  const eventLabels = {
    rent_due: { label: "Rent Due Reminder", icon: "💰", desc: "Sent X days before rent is due" },
    rent_overdue: { label: "Rent Overdue Notice", icon: "\u26a0\ufe0f", desc: "Sent when rent is past due" },
    lease_expiring: { label: "Lease Expiration Alert", icon: "\ud83d\udcdd", desc: "Sent X days before lease expires" },
    work_order_update: { label: "Work Order Status Update", icon: "🔧", desc: "Sent when maintenance request changes status" },
    payment_received: { label: "Payment Confirmation", icon: "\u2705", desc: "Sent when payment is recorded" },
    lease_created: { label: "New Lease Created", icon: "\ud83c\udfe0", desc: "Sent when a new lease is signed" },
    insurance_expiring: { label: "Vendor Insurance Alert", icon: "\ud83d\udee1\ufe0f", desc: "Sent when vendor insurance is expiring" },
    inspection_due: { label: "Inspection Reminder", icon: "\ud83d\udd0d", desc: "Sent before scheduled inspection" },
  };

  useEffect(() => { fetchData(); }, [companyId]);

  async function fetchData() {
    setLoading(true);
    const [s, l, t, le] = await Promise.all([
      supabase.from("notification_settings").select("*").eq("company_id", companyId).order("event_type"),
      supabase.from("notification_log").select("*").eq("company_id", companyId).order("created_at", { ascending: false }).limit(100),
      supabase.from("tenants").select("*").eq("company_id", companyId),
      supabase.from("leases").select("*").eq("company_id", companyId).eq("status", "active"),
    ]);
    setSettings(s.data || []);
    setLogs(l.data || []);
    setTenants(t.data || []);
    setLeases(le.data || []);
    setLoading(false);
  }

  async function toggleSetting(setting) {
    const { error: _err6051 } = await supabase.from("notification_settings").update({ enabled: !setting.enabled }).eq("company_id", companyId).eq("id", setting.id);
    if (_err6051) console.warn("notification_settings write failed:", _err6051.message);
    fetchData();
  }

  async function updateDaysBefore(setting, days) {
    const { error: _err6056 } = await supabase.from("notification_settings").update({ days_before: Number(days) }).eq("company_id", companyId).eq("id", setting.id);
    if (_err6056) console.warn("notification_settings write failed:", _err6056.message);
    fetchData();
  }

  async function updateTemplate(setting, template) {
    const { error: _err6061 } = await supabase.from("notification_settings").update({ template }).eq("company_id", companyId).eq("id", setting.id);
    if (_err6061) console.warn("notification_settings write failed:", _err6061.message);
  }

  async function sendTestNotification(setting) {
    // Simulate sending by logging it
    const testRecipient = userProfile?.email || "test@example.com";
    const { error: _err_notification_log_6067 } = await supabase.from("notification_log").insert([{ company_id: companyId,
      event_type: setting.event_type,
      recipient_email: normalizeEmail(testRecipient),
      subject: "[TEST] " + (eventLabels[setting.event_type]?.label || setting.event_type),
      message: setting.template || "Test notification",
      status: "sent",
      related_id: "test",
    }]);
    if (_err_notification_log_6067) console.warn("notification_log write failed:", _err_notification_log_6067.message);
    addNotification("\u2709\ufe0f", "Test notification sent for " + (eventLabels[setting.event_type]?.label || setting.event_type));
    fetchData();
  }

  async function runNotificationCheck() {
    const today = new Date();
    let count = 0;

    // Check rent due
    const rentDueSetting = settings.find(s => s.event_type === "rent_due" && s.enabled);
    if (rentDueSetting) {
      const daysBefore = rentDueSetting.days_before || 3;
      for (const lease of leases) {
        const rawDueDay = lease.payment_due_day || 1;
        // Clamp due day to valid day for this month (avoids Feb 30 etc)
        const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
        const dueDay = Math.min(rawDueDay, daysInMonth);
        const nextDue = new Date(today.getFullYear(), today.getMonth(), dueDay);
        if (nextDue < today) {
          nextDue.setMonth(nextDue.getMonth() + 1);
          // Re-clamp for next month (e.g., due day 31 in Feb → 28)
          const nextMonthDays = new Date(nextDue.getFullYear(), nextDue.getMonth() + 1, 0).getDate();
          if (nextDue.getDate() > nextMonthDays) nextDue.setDate(nextMonthDays);
        }
        const daysUntilDue = Math.ceil((nextDue - today) / 86400000);
        if (daysUntilDue <= daysBefore && daysUntilDue >= 0) {
          const tenant = tenants.find(t => t.name === lease.tenant_name);
          if (tenant?.email) {
            const msg = (rentDueSetting.template || "").replace("${amount}", "$" + lease.rent_amount).replace("${due_date}", nextDue.toLocaleDateString()).replace("${property}", lease.property);
            const { error: _err6104 } = await supabase.from("notification_log").insert([{ company_id: companyId, event_type: "rent_due", recipient_email: normalizeEmail(tenant.email), subject: "Rent Due Reminder", message: msg, status: "sent", related_id: lease.id }]);
            if (_err6104) console.warn("notification_log write failed:", _err6104.message);
            count++;
          }
        }
      }
    }

    // Check lease expiring
    const leaseExpSetting = settings.find(s => s.event_type === "lease_expiring" && s.enabled);
    if (leaseExpSetting) {
      const daysBefore = leaseExpSetting.days_before || 60;
      for (const lease of leases) {
        const daysLeft = Math.ceil((parseLocalDate(lease.end_date) - today) / 86400000);
        if (daysLeft <= daysBefore && daysLeft > 0) {
          const tenant = tenants.find(t => t.name === lease.tenant_name);
          if (tenant?.email) {
            const msg = (leaseExpSetting.template || "").replace("${property}", lease.property).replace("${end_date}", lease.end_date);
            const { error: _err6121 } = await supabase.from("notification_log").insert([{ company_id: companyId, event_type: "lease_expiring", recipient_email: normalizeEmail(tenant.email), subject: "Lease Expiration Notice", message: msg, status: "sent", related_id: lease.id }]);
            if (_err6121) console.warn("notification_log write failed:", _err6121.message);
            count++;
          }
        }
      }
    }

    addNotification("\ud83d\udce8", count + " notifications sent");
    logAudit("create", "notifications", "Ran notification check: " + count + " sent", "", userProfile?.email, userRole, companyId);
    fetchData();
  }

  if (loading) return <Spinner />;

  const sentToday = logs.filter(l => l.created_at && new Date(l.created_at).toDateString() === new Date().toDateString()).length;
  const enabledCount = settings.filter(s => s.enabled).length;

  useEffect(() => { fetchQueueStatus(); }, [companyId]);

  return (
    <div>
      <div className="flex justify-between items-center mb-5">
        <h2 className="text-2xl font-manrope font-bold text-slate-800">Email Notifications</h2>
        <button onClick={runNotificationCheck} className="bg-indigo-600 text-white text-xs px-4 py-2 rounded-2xl hover:bg-indigo-700">Run Notification Check</button>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-5 md:grid-cols-4">
        <StatCard label="Active Rules" value={enabledCount + "/" + settings.length} color="text-green-600" sub="notification types" />
        <StatCard label="Sent Today" value={sentToday} color="text-blue-600" sub="notifications" />
        <StatCard label="Total Sent" value={logs.length} color="text-indigo-600" sub="all time" />
        <StatCard label="Failed" value={logs.filter(l => l.status === "failed").length} color={logs.filter(l => l.status === "failed").length > 0 ? "text-red-500" : "text-slate-400"} sub="delivery errors" />
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-5 text-sm text-amber-800">
        <span className="font-semibold">Note:</span> Notifications are currently logged to the database. To send actual emails, connect a Supabase Edge Function with SendGrid, Resend, or Postmark. The templates and triggers are ready to wire up.
      </div>

      {/* Queue Delivery Status */}
      <div className="bg-white rounded-xl border border-gray-100 p-4 mb-5">
        <div className="text-sm font-semibold text-gray-700 mb-2">📬 Notification Queue</div>
        <div className="grid grid-cols-3 gap-3">
          <div className="text-center"><div className="text-lg font-bold text-amber-600">{queueStats.pending}</div><div className="text-xs text-gray-400">Pending</div></div>
          <div className="text-center"><div className="text-lg font-bold text-green-600">{queueStats.sent}</div><div className="text-xs text-gray-400">Delivered</div></div>
          <div className="text-center"><div className="text-lg font-bold text-red-600">{queueStats.failed}</div><div className="text-xs text-gray-400">Failed</div></div>
        </div>
        {queueStats.failed > 0 && <div className="bg-red-50 rounded-lg px-3 py-2 mt-3 text-xs text-red-700">⚠️ {queueStats.failed} notification(s) failed. Check that your delivery worker is running.</div>}
        {queueStats.pending > 10 && <div className="bg-amber-50 rounded-lg px-3 py-2 mt-3 text-xs text-amber-700">📬 {queueStats.pending} queued — delivery service may be behind.</div>}
      </div>

      <div className="flex gap-1 mb-4 border-b border-indigo-50">
        {[["settings","Settings"],["log","Send Log"],["rentroll","Rent Roll"]].map(([id,label]) => (
          <button key={id} onClick={() => setActiveTab(id)} className={"px-4 py-2 text-sm font-medium border-b-2 " + (activeTab === id ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-400")}>{label}</button>
        ))}
      </div>

      {/* SETTINGS TAB */}
      {activeTab === "settings" && (
        <div className="space-y-3">
          {settings.map(s => {
            const info = eventLabels[s.event_type] || { label: s.event_type, icon: "\ud83d\udce7", desc: "" };
            return (
              <div key={s.id} className={"bg-white rounded-xl border shadow-sm p-4 " + (s.enabled ? "border-indigo-50" : "border-indigo-50/50 opacity-60")}>
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{info.icon}</span>
                    <div>
                      <div className="text-sm font-bold text-slate-800">{info.label}</div>
                      <div className="text-xs text-slate-400">{info.desc}</div>
                    </div>
                  </div>
                  <button onClick={() => toggleSetting(s)} className={"relative w-10 h-5 rounded-full transition-colors " + (s.enabled ? "bg-green-500" : "bg-slate-300")}>
                    <span className={"absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow " + (s.enabled ? "left-5" : "left-0.5")} />
                  </button>
                </div>
                <div className="flex items-center gap-3 text-xs mb-2">
                  <span className="text-slate-400">Recipients:</span>
                  <span className="font-medium text-slate-500">{s.recipients}</span>
                  {s.days_before > 0 && (
                    <div className="flex items-center gap-1">
                      <span className="text-slate-400">Days before:</span>
                      <input type="number" value={s.days_before} onChange={e => updateDaysBefore(s, e.target.value)} className="w-12 border border-indigo-100 rounded px-1 py-0.5 text-xs text-center" min="0" />
                    </div>
                  )}
                </div>
                <div className="mb-2">
                  <textarea value={s.template} onChange={e => updateTemplate(s, e.target.value)} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-xs text-slate-500" rows={2} />
                </div>
                <button onClick={() => sendTestNotification(s)} className="text-xs text-indigo-600 border border-indigo-200 px-3 py-1 rounded-lg hover:bg-indigo-50">Send Test</button>
              </div>
            );
          })}
        </div>
      )}

      {/* LOG TAB */}
      {activeTab === "log" && (
        <div className="space-y-2">
          {logs.map(l => (
            <div key={l.id} className="bg-white rounded-3xl border border-indigo-50 px-4 py-2.5 flex justify-between items-center">
              <div>
                <div className="text-sm text-slate-800">{l.subject}</div>
                <div className="text-xs text-slate-400">{l.recipient_email} · {new Date(l.created_at).toLocaleString()}</div>
              </div>
              <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (l.status === "sent" ? "bg-green-100 text-green-700" : l.status === "failed" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700")}>{l.status}</span>
            </div>
          ))}
          {logs.length === 0 && <div className="text-center py-8 text-slate-400">No notifications sent yet</div>}
        </div>
      )}

      {/* RENT ROLL TAB */}
      {activeTab === "rentroll" && (
        <div>
          <h3 className="font-semibold text-slate-700 mb-3">Rent Roll</h3>
          <div className="bg-white rounded-3xl border border-indigo-50 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-indigo-50/30 text-xs text-slate-400">
                <tr>
                  <th className="text-left px-4 py-2">Tenant</th>
                  <th className="text-left px-4 py-2">Property</th>
                  <th className="text-right px-4 py-2">Rent</th>
                  <th className="text-right px-4 py-2">Balance</th>
                  <th className="text-left px-4 py-2">Lease End</th>
                  <th className="text-left px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {tenants.filter(t => t.lease_status === "active" || !t.lease_status).map(t => (
                  <tr key={t.id} className="border-t border-indigo-50/50">
                    <td className="px-4 py-2 font-medium text-slate-800">{t.name}</td>
                    <td className="px-4 py-2 text-slate-500">{t.property}</td>
                    <td className="px-4 py-2 text-right font-bold">${safeNum(t.rent).toLocaleString()}</td>
                    <td className={"px-4 py-2 text-right font-bold " + (safeNum(t.balance) > 0 ? "text-red-600" : "text-green-600")}>${safeNum(t.balance).toLocaleString()}</td>
                    <td className="px-4 py-2 text-slate-500">{t.move_out || "—"}</td>
                    <td className="px-4 py-2"><span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (t.lease_status === "active" ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-400")}>{t.lease_status || "active"}</span></td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-indigo-50/30 font-bold text-sm">
                <tr>
                  <td className="px-4 py-2" colSpan="2">Total ({tenants.filter(t => t.lease_status === "active" || !t.lease_status).length} tenants)</td>
                  <td className="px-4 py-2 text-right">${tenants.filter(t => t.lease_status === "active" || !t.lease_status).reduce((s, t) => s + safeNum(t.rent), 0).toLocaleString()}</td>
                  <td className="px-4 py-2 text-right">${tenants.filter(t => t.lease_status === "active" || !t.lease_status).reduce((s, t) => s + safeNum(t.balance), 0).toLocaleString()}</td>
                  <td colSpan="2"></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ============ E-SIGNATURE COMPONENT ============
function ESignatureModal({ lease, onClose, onSigned, userProfile, companyId }) {
  const canvasRef = useRef(null);
  const [signing, setSigning] = useState(false);
  const [signers, setSigners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isDrawing, setIsDrawing] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [signMethod, setSignMethod] = useState("draw");
  const [consentAgreed, setConsentAgreed] = useState(false);

  useEffect(() => { fetchSigners(); }, [lease]);

  async function fetchSigners() {
    const { data } = await supabase.from("lease_signatures").select("*").eq("company_id", companyId).eq("lease_id", lease.id).order("created_at");
    setSigners(data || []);
    setLoading(false);
  }

  async function initSignatureRequest() {
    // Create signature requests for tenant and landlord
    const existing = signers.map(s => s.signer_role);
    const toCreate = [];
    if (!existing.includes("tenant")) {
      // Find tenant email for signature tracking
    const { data: sigTenant } = await supabase.from("tenants").select("email").eq("company_id", companyId).eq("name", lease.tenant_name).maybeSingle();
    toCreate.push({ lease_id: lease.id, signer_name: lease.tenant_name, signer_email: sigTenant?.email || "", signer_role: "tenant", status: "pending" });
    }
    if (!existing.includes("landlord")) {
      toCreate.push({ lease_id: lease.id, signer_name: userProfile?.name || "Property Manager", signer_email: userProfile?.email || "", signer_role: "landlord", status: "pending" });
    }
    if (toCreate.length > 0) {
      const { error: sigInitErr } = await supabase.from("lease_signatures").insert(toCreate.map(s => ({ ...s, company_id: companyId })));
    if (sigInitErr) { alert("Error creating signature requests: " + sigInitErr.message); return; }
      const { error: _err6295 } = await supabase.from("leases").update({ signature_status: "pending" }).eq("company_id", companyId).eq("id", lease.id);
      if (_err6295) { alert("Error updating leases: " + _err6295.message); return; }
    }
    fetchSigners();
  }

  function startDraw(e) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setIsDrawing(true);
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function draw(e) {
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#1e3a5f";
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function endDraw() { setIsDrawing(false); }

  function clearCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  async function submitSignature(signer) {
      if (!guardSubmit("submitSignature")) return;
      try {
    let sigData = "";
    if (signMethod === "draw") {
      const canvas = canvasRef.current;
      if (!canvas) return;
      sigData = canvas.toDataURL("image/png");
      const ctx = canvas.getContext("2d");
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const hasContent = pixels.some((v, i) => i % 4 === 3 && v > 0);
      if (!hasContent) { alert("Please draw your signature first."); return; }
    } else {
      if (!typedName.trim()) { alert("Please type your name."); return; }
      sigData = "typed:" + typedName.trim() + "|ts:" + new Date().toISOString();
    }

    setSigning(true);
    // Server-side signing: identity verified, IP captured, integrity hash generated
    try {
      const { data: signResult, error: signErr } = await supabase.rpc("sign_lease", {
        p_company_id: companyId,
        p_lease_id: lease.id,
        p_signer_id: signer.id,
        p_signature_data: sigData,
        p_signing_method: signMethod,
        p_consent_text: "I agree that my electronic signature is the legal equivalent of my manual/handwritten signature and I consent to be legally bound by this lease agreement.",
        p_user_agent: navigator.userAgent || "",
      });
      if (signErr) throw new Error(signErr.message);
      if (signResult?.all_signed) {
        addNotification("✅", "All parties have signed — lease is fully executed");
      }
      logAudit("update", "leases", "E-signature (server-verified): " + signer.signer_name + " signed lease for " + lease.tenant_name + " [hash:" + (signResult?.integrity_hash || "").slice(0, 12) + "]", lease.id, userProfile?.email, "", companyId);
    } catch (rpcErr) {
      // No client-side fallback — server-side signing is required for legal compliance
      alert("Signature failed: " + rpcErr.message + "\n\nPlease ensure the e-signature system is properly configured. Contact your administrator if this persists.");
      setSigning(false);
      return;
    }
    setSigning(false);
    fetchSigners();
    if (onSigned) onSigned();
      } finally { guardRelease("submitSignature"); }
  }

  if (loading) return <Modal title="E-Signature" onClose={onClose}><Spinner /></Modal>;

  const pendingSigners = signers.filter(s => s.status === "pending");
  const signedSigners = signers.filter(s => s.status === "signed");
  const allSigned = signers.length > 0 && signers.every(s => s.status === "signed");

  return (
    <Modal title={"E-Signature — " + lease.tenant_name} onClose={onClose}>
      <div className="space-y-4">
        {/* Lease Summary */}
        <div className="bg-indigo-50 rounded-lg p-3">
          <div className="text-sm font-semibold text-indigo-800">{lease.property}</div>
          <div className="text-xs text-indigo-600">{lease.start_date} to {lease.end_date} · ${safeNum(lease.rent_amount).toLocaleString()}/mo</div>
        </div>

        {/* Lease Terms Preview */}
        <div className="bg-indigo-50/30 rounded-lg p-3 max-h-32 overflow-y-auto">
          <div className="text-xs font-semibold text-slate-500 mb-1">Lease Terms</div>
          <div className="text-xs text-slate-400 whitespace-pre-wrap">{lease.clauses || "Standard residential lease terms apply."}</div>
          {lease.special_terms && <div className="text-xs text-slate-400 mt-1"><span className="font-semibold">Special Terms:</span> {lease.special_terms}</div>}
        </div>

        {/* Signer Status */}
        <div>
          <div className="text-sm font-semibold text-slate-700 mb-2">Signatures</div>
          {signers.length === 0 && (
            <div className="text-center py-4">
              <div className="text-sm text-slate-400 mb-3">No signature requests yet</div>
              <button onClick={initSignatureRequest} className="bg-indigo-600 text-white text-sm px-6 py-2 rounded-2xl hover:bg-indigo-700">Send for Signature</button>
            </div>
          )}
          {signers.map(s => (
            <div key={s.id} className={"flex items-center justify-between px-3 py-2 rounded-lg mb-2 " + (s.status === "signed" ? "bg-green-50 border border-green-200" : "bg-amber-50 border border-amber-200")}>
              <div>
                <div className="text-sm font-medium text-slate-800">{s.signer_name}</div>
                <div className="text-xs text-slate-400 capitalize">{s.signer_role}</div>
              </div>
              <div className="flex items-center gap-2">
                {s.status === "signed" ? (
                  <div className="text-right">
                    <span className={"text-xs font-bold px-2 py-0.5 rounded-full " + (s.verified_server_side ? "text-green-700 bg-green-100" : "text-amber-700 bg-amber-100")}>{s.verified_server_side ? "🔒 Verified" : "✓ Signed"}</span>
                    <div className="text-xs text-slate-400 mt-0.5">{new Date(s.signed_at).toLocaleDateString()}</div>
                    {s.integrity_hash && <div className="text-xs text-slate-300 font-mono mt-0.5">{s.integrity_hash.slice(0, 12)}...</div>}
                  </div>
                ) : (
                  <span className="text-xs font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">Pending</span>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Signing Pad - show for pending signers */}
        {pendingSigners.length > 0 && !allSigned && (
          <div className="border border-indigo-100 rounded-3xl p-4">
            <div className="text-sm font-semibold text-slate-700 mb-2">Sign as: {pendingSigners[0].signer_name} ({pendingSigners[0].signer_role})</div>

            <div className="flex gap-2 mb-3">
              <button onClick={() => setSignMethod("draw")} className={"text-xs px-3 py-1.5 rounded-lg font-medium " + (signMethod === "draw" ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500")}>Draw Signature</button>
              <button onClick={() => setSignMethod("type")} className={"text-xs px-3 py-1.5 rounded-lg font-medium " + (signMethod === "type" ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500")}>Type Name</button>
            </div>

            {signMethod === "draw" ? (
              <div>
                <div className="border-2 border-dashed border-indigo-200 rounded-lg bg-white relative mb-2">
                  <canvas ref={canvasRef} width={400} height={120}
                    onMouseDown={startDraw} onMouseMove={draw} onMouseUp={endDraw} onMouseLeave={endDraw}
                    onTouchStart={startDraw} onTouchMove={draw} onTouchEnd={endDraw}
                    className="w-full cursor-crosshair" style={{ touchAction: "none" }} />
                  <div className="absolute bottom-1 left-3 text-xs text-slate-300">Sign above this line</div>
                </div>
                <button onClick={clearCanvas} className="text-xs text-slate-400 hover:text-slate-700">Clear</button>
              </div>
            ) : (
              <div>
                <input value={typedName} onChange={e => setTypedName(e.target.value)} placeholder="Type your full legal name"
                  className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mb-1" />
                {typedName && <div className="text-2xl text-indigo-800 italic font-serif py-2 px-3 bg-indigo-50/30 rounded-lg">{typedName}</div>}
              </div>
            )}

            <div className="flex items-start gap-2 mt-3 mb-3 bg-amber-50 rounded-lg p-2">
              <input type="checkbox" checked={consentAgreed} onChange={(e) => setConsentAgreed(e.target.checked)} className="mt-1" />
              <label className="text-xs text-slate-500">I agree that my electronic signature is the legal equivalent of my manual/handwritten signature and I consent to be legally bound by this lease agreement.</label>
            </div>

            <button onClick={() => {
              if (!consentAgreed) { alert("You must agree to the electronic signature consent before signing."); return; }
              // Verify current user is authorized to sign as this signer
              const signer = pendingSigners[0];
              if (signer.signer_email && userProfile?.email && signer.signer_email.toLowerCase() !== userProfile.email.toLowerCase()) {
                alert("You are signed in as " + userProfile.email + " but this signature is for " + signer.signer_email + ". Please sign in with the correct account.");
                return;
              }
              submitSignature(signer);
            }} disabled={signing || !consentAgreed}
              className={"w-full py-2.5 rounded-lg text-white font-semibold text-sm " + (signing || !consentAgreed ? "bg-slate-400 cursor-not-allowed" : "bg-indigo-600 hover:bg-indigo-700")}>
              {signing ? "Signing..." : !consentAgreed ? "Agree to terms above to sign" : "Apply Signature"}
            </button>
          </div>
        )}

        {allSigned && (
          <div className="bg-green-50 border border-green-200 rounded-3xl p-4 text-center">
            <div className="text-2xl mb-1">\u2705</div>
            <div className="text-sm font-bold text-green-700">Lease Fully Signed</div>
            <div className="text-xs text-green-600">All parties have signed this lease agreement.</div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ============ PDF RECEIPT GENERATOR ============
function generatePaymentReceipt(payment, companyName = "PropManager") {
  const receiptDate = parseLocalDate(payment.date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const receiptNum = "REC-" + String(payment.id || shortId()).slice(-8).toUpperCase();

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Payment Receipt ${receiptNum}</title>
<style>
  @media print { @page { margin: 0.5in; } body { -webkit-print-color-adjust: exact; } }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1f2937; background: #fff; padding: 40px; }
  .receipt { max-width: 600px; margin: 0 auto; border: 2px solid #e5e7eb; border-radius: 12px; overflow: hidden; }
  .header { background: linear-gradient(135deg, #4338ca, #6366f1); color: white; padding: 30px; }
  .header h1 { font-size: 24px; margin-bottom: 4px; }
  .header .subtitle { font-size: 13px; opacity: 0.85; }
  .badge { display: inline-block; background: rgba(255,255,255,0.2); border-radius: 20px; padding: 4px 14px; font-size: 12px; font-weight: 600; margin-top: 10px; }
  .body { padding: 30px; }
  .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f3f4f6; }
  .row:last-child { border-bottom: none; }
  .label { color: #6b7280; font-size: 13px; }
  .value { font-weight: 600; font-size: 14px; text-align: right; }
  .amount-row { background: #f0fdf4; border-radius: 8px; padding: 16px; margin: 16px 0; display: flex; justify-content: space-between; align-items: center; }
  .amount-row .label { font-size: 15px; font-weight: 600; color: #1f2937; }
  .amount-row .value { font-size: 22px; color: #059669; font-weight: 700; }
  .footer { background: #f9fafb; padding: 20px 30px; text-align: center; border-top: 1px solid #e5e7eb; }
  .footer p { font-size: 11px; color: #9ca3af; }
  .stamp { color: #059669; font-size: 18px; font-weight: 700; border: 3px solid #059669; border-radius: 8px; padding: 6px 20px; display: inline-block; transform: rotate(-3deg); margin-bottom: 10px; }
</style></head>
<body>
<div class="receipt">
  <div class="header">
    <h1>${escapeHtml(companyName)}</h1>
    <div class="subtitle">Payment Receipt</div>
    <div class="badge">Receipt #${receiptNum}</div>
  </div>
  <div class="body">
    <div class="row"><span class="label">Date</span><span class="value">${receiptDate}</span></div>
    <div class="row"><span class="label">Tenant</span><span class="value">${escapeHtml(payment.tenant || "N/A")}</span></div>
    <div class="row"><span class="label">Property</span><span class="value">${escapeHtml(payment.property || "N/A")}</span></div>
    <div class="row"><span class="label">Payment Type</span><span class="value" style="text-transform:capitalize">${escapeHtml(payment.type || "rent")}</span></div>
    <div class="row"><span class="label">Payment Method</span><span class="value" style="text-transform:uppercase">${escapeHtml(payment.method || "N/A")}</span></div>
    <div class="row"><span class="label">Status</span><span class="value" style="text-transform:capitalize">${escapeHtml(payment.status || "paid")}</span></div>
    <div class="amount-row"><span class="label">Amount Paid</span><span class="value">$${safeNum(payment.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span></div>
  </div>
  <div class="footer">
    <div class="stamp">PAID</div>
    <p>This is an electronic receipt generated by ${escapeHtml(companyName)}.</p>
    <p>For questions, contact your property manager.</p>
  </div>
</div>
</body></html>`;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank", "noopener,noreferrer");
  if (win) {
    win.onload = () => { setTimeout(() => win.print(), 500); };
  }
}

// ============ OWNER PORTAL ============
function OwnerMaintenanceView({ companyId, properties }) {
  const [workOrders, setWorkOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    async function load() {
      const addrs = properties.map(p => p.address);
      if (addrs.length === 0) { setLoading(false); return; }
      const { data } = await supabase.from("work_orders").select("*").eq("company_id", companyId).in("property", addrs).order("created_at", { ascending: false }).limit(100);
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
        <div key={wo.id} className="bg-white border border-indigo-50 rounded-2xl p-4">
          <div className="flex justify-between items-start">
            <div>
              <div className="text-sm font-semibold text-slate-800">{wo.issue}</div>
              <div className="text-xs text-slate-400">{wo.property} · {wo.date || new Date(wo.created_at).toLocaleDateString()}</div>
            </div>
            <div className="text-right">
              <span className="text-xs">{statusIcon[wo.status] || "⚪"} {wo.status}</span>
              {wo.cost > 0 && <div className="text-xs font-bold text-red-500 mt-0.5">${safeNum(wo.cost).toLocaleString()}</div>}
            </div>
          </div>
          {wo.notes && <div className="text-xs text-slate-400 mt-1">{wo.notes}</div>}
        </div>
      ))}
      {workOrders.length === 0 && <div className="text-center py-8 text-slate-400">No maintenance activity</div>}
    </div>
  );
}

function OwnerPortal({ currentUser, companyId }) {
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
    const { data: owner } = await supabase.from("owners").select("*").eq("company_id", companyId).ilike("email", currentUser.email).maybeSingle();
    if (!owner) { setError("No owner account found for " + currentUser.email); setLoading(false); return; }
    setOwnerData(owner);

    const [p, s, d] = await Promise.all([
      supabase.from("properties").select("*").eq("company_id", companyId).eq("owner_id", owner.id),
      supabase.from("owner_statements").select("*").eq("owner_id", owner.id).order("created_at", { ascending: false }),
      supabase.from("owner_distributions").select("*").eq("owner_id", owner.id).order("date", { ascending: false }),
    ]);
    setProperties(p.data || []);
    setStatements(s.data || []);
    setDistributions(d.data || []);
    setLoading(false);
  }

  if (loading) return <div className="flex items-center justify-center h-64"><Spinner /></div>;

  if (error) return (
    <div className="max-w-lg mx-auto mt-16 text-center">
      <div className="text-5xl mb-4">\ud83c\udfe0</div>
      <h2 className="text-2xl font-manrope font-bold text-slate-800 mb-2">Owner Portal</h2>
      <p className="text-slate-400 mb-4">{error}</p>
      <p className="text-sm text-slate-400">Please contact your property manager to set up your owner portal access.</p>
    </div>
  );

  const totalIncome = statements.reduce((s, st) => s + safeNum(st.total_income), 0);
  const totalExpenses = statements.reduce((s, st) => s + safeNum(st.total_expenses), 0);
  const totalDistributed = distributions.reduce((s, d) => s + safeNum(d.amount), 0);
  const pendingStatements = statements.filter(s => s.status === "draft" || s.status === "sent");

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="bg-gradient-to-r from-indigo-600 to-purple-600 rounded-2xl p-6 mb-6 text-white">
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-bold mb-1">Welcome, {ownerData.name}</h1>
            <p className="text-indigo-200 text-sm">{properties.length} {properties.length === 1 ? "property" : "properties"} · {ownerData.company || "Individual Owner"}</p>
          </div>
          <div className="text-right">
            <div className="text-sm text-indigo-200">Management Fee</div>
            <div className="text-lg font-bold">{ownerData.management_fee_pct}%</div>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 mb-6 md:grid-cols-4">
        <div className="bg-white rounded-3xl border border-indigo-50 p-4 text-center">
          <div className="text-xs text-slate-400 mb-1">Total Income</div>
          <div className="text-lg font-bold text-green-600">${totalIncome.toLocaleString()}</div>
        </div>
        <div className="bg-white rounded-3xl border border-indigo-50 p-4 text-center">
          <div className="text-xs text-slate-400 mb-1">Total Expenses</div>
          <div className="text-lg font-bold text-red-500">${totalExpenses.toLocaleString()}</div>
        </div>
        <div className="bg-white rounded-3xl border border-indigo-50 p-4 text-center">
          <div className="text-xs text-slate-400 mb-1">Distributions</div>
          <div className="text-lg font-bold text-indigo-600">${totalDistributed.toLocaleString()}</div>
        </div>
        <div className="bg-white rounded-3xl border border-indigo-50 p-4 text-center">
          <div className="text-xs text-slate-400 mb-1">Pending</div>
          <div className="text-lg font-bold text-amber-600">{pendingStatements.length}</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-indigo-50">
        {[["overview","\ud83c\udfe0 Overview"],["statements","\ud83d\udcca Statements"],["distributions","💰 Distributions"],["properties","\ud83c\udfe2 Properties"],["maintenance","🔧 Maintenance"]].map(([id, label]) => (
          <button key={id} onClick={() => { setActiveTab(id); setViewStatement(null); }} className={"px-4 py-2.5 text-sm font-medium border-b-2 transition-colors " + (activeTab === id ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-400 hover:text-slate-700")}>{label}</button>
        ))}
      </div>

      {/* OVERVIEW TAB */}
      {activeTab === "overview" && (
        <div className="space-y-4">
          <h3 className="font-semibold text-slate-700">Your Properties</h3>
          <div className="grid gap-3 md:grid-cols-2">
            {properties.map(p => (
              <div key={p.id} className="bg-white rounded-3xl border border-indigo-50 p-4">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-semibold text-slate-800 text-sm">{p.address}</div>
                    <div className="text-xs text-slate-400">{p.type || "Residential"}</div>
                  </div>
                  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (p.status === "occupied" ? "bg-green-100 text-green-700" : p.status === "vacant" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-400")}>{p.status || "active"}</span>
                </div>
                {p.rent && <div className="text-sm font-bold text-green-600 mt-2">${safeNum(p.rent).toLocaleString()}/mo</div>}
              </div>
            ))}
            {properties.length === 0 && <div className="text-center py-8 text-slate-400">No properties assigned yet</div>}
          </div>

          {/* Recent statements */}
          {statements.length > 0 && (
            <div>
              <h3 className="font-semibold text-slate-700 mt-4 mb-2">Recent Statements</h3>
              {statements.slice(0, 3).map(s => (
                <div key={s.id} className="bg-white rounded-3xl border border-indigo-50 px-4 py-3 flex justify-between items-center mb-2 cursor-pointer hover:border-indigo-200" onClick={() => { setActiveTab("statements"); setViewStatement(s); }}>
                  <div>
                    <div className="text-sm font-medium text-slate-800">{s.period}</div>
                    <div className="text-xs text-slate-400">Net: ${safeNum(s.net_to_owner).toLocaleString()}</div>
                  </div>
                  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (s.status === "paid" ? "bg-green-100 text-green-700" : s.status === "sent" ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700")}>{s.status}</span>
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
            <div key={s.id} className="bg-white rounded-3xl border border-indigo-50 px-4 py-3 flex justify-between items-center cursor-pointer hover:border-indigo-200" onClick={() => setViewStatement(s)}>
              <div>
                <div className="text-sm font-semibold text-slate-800">{s.period}</div>
                <div className="text-xs text-slate-400">{new Date(s.created_at).toLocaleDateString()}</div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <div className="text-xs text-slate-400">Income: <span className="text-green-600 font-bold">${safeNum(s.total_income).toLocaleString()}</span></div>
                  <div className="text-xs text-slate-400">Net: <span className="text-indigo-600 font-bold">${safeNum(s.net_to_owner).toLocaleString()}</span></div>
                </div>
                <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (s.status === "paid" ? "bg-green-100 text-green-700" : s.status === "sent" ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700")}>{s.status}</span>
              </div>
            </div>
          ))}
          {statements.length === 0 && <div className="text-center py-8 text-slate-400">No statements yet</div>}
        </div>
      )}

      {/* STATEMENT DETAIL */}
      {activeTab === "statements" && viewStatement && (
        <div>
          <button onClick={() => setViewStatement(null)} className="text-sm text-indigo-600 mb-3 hover:underline">\u2190 Back to Statements</button>
          <div className="bg-white rounded-3xl border border-indigo-50 p-5">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="font-bold text-slate-800">Owner Statement — {viewStatement.period}</h3>
                <div className="text-xs text-slate-400">{viewStatement.owner_name} · Generated {new Date(viewStatement.created_at).toLocaleDateString()}</div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => { const w = window.open("", "_blank", "noopener,noreferrer"); w.document.write("<pre>" + JSON.stringify(viewStatement, null, 2) + "</pre>"); w.document.title = "Statement " + viewStatement.period; setTimeout(() => w.print(), 300); }} className="text-xs text-indigo-600 border border-indigo-200 px-2 py-1 rounded-lg hover:bg-indigo-50"><span className="material-icons-outlined text-xs align-middle">print</span></button>
                <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (viewStatement.status === "paid" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700")}>{viewStatement.status}</span>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-3 mb-4">
              <div className="bg-green-50 rounded-lg p-3 text-center"><div className="text-xs text-slate-400">Income</div><div className="text-lg font-bold text-green-600">${safeNum(viewStatement.total_income).toLocaleString()}</div></div>
              <div className="bg-red-50 rounded-lg p-3 text-center"><div className="text-xs text-slate-400">Expenses</div><div className="text-lg font-bold text-red-500">${safeNum(viewStatement.total_expenses).toLocaleString()}</div></div>
              <div className="bg-purple-50 rounded-lg p-3 text-center"><div className="text-xs text-slate-400">Mgmt Fee</div><div className="text-lg font-bold text-purple-600">${safeNum(viewStatement.management_fee).toLocaleString()}</div></div>
              <div className="bg-indigo-50 rounded-lg p-3 text-center"><div className="text-xs text-slate-400">Net to You</div><div className="text-lg font-bold text-indigo-700">${safeNum(viewStatement.net_to_owner).toLocaleString()}</div></div>
            </div>
            {/* Line items */}
            {(() => { let items = []; try { items = JSON.parse(viewStatement.line_items || "[]"); } catch {} return items.map((cat, ci) => (
              <div key={ci} className="mb-3">
                <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">{cat.category}</div>
                {(cat.items || []).map((item, ii) => (
                  <div key={ii} className="flex justify-between text-xs py-1 border-b border-indigo-50/50">
                    <span className="text-slate-500">{item.date} — {item.description}</span>
                    <span className={"font-bold " + (item.amount >= 0 ? "text-green-600" : "text-red-500")}>${Math.abs(item.amount).toLocaleString()}</span>
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
            <div key={d.id} className="bg-white rounded-3xl border border-indigo-50 px-4 py-3 flex justify-between items-center">
              <div>
                <div className="text-sm font-medium text-slate-800">${safeNum(d.amount).toLocaleString()}</div>
                <div className="text-xs text-slate-400">{d.reference} · {new Date(d.date).toLocaleDateString()}</div>
              </div>
              <div className="text-right">
                <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-green-100 text-green-700">{d.method?.toUpperCase()}</span>
              </div>
            </div>
          ))}
          {distributions.length === 0 && <div className="text-center py-8 text-slate-400">No distributions yet</div>}
        </div>
      )}

      {/* MAINTENANCE TAB */}
      {activeTab === "maintenance" && (
        <div>
          <h3 className="font-manrope font-bold text-slate-700 mb-3">Maintenance Activity</h3>
          <OwnerMaintenanceView companyId={companyId} properties={properties} />
        </div>
      )}

      {/* PROPERTIES TAB */}
      {activeTab === "properties" && (
        <div className="space-y-3">
          {properties.map(p => (
            <div key={p.id} className="bg-white rounded-3xl border border-indigo-50 p-4">
              <div className="flex justify-between items-start mb-2">
                <div>
                  <div className="font-semibold text-slate-800">{p.address}</div>
                  <div className="text-xs text-slate-400">{p.type || "Residential"} · {p.bedrooms || "?"} bd / {p.bathrooms || "?"} ba · {p.sqft || "?"} sqft</div>
                </div>
                <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (p.status === "occupied" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700")}>{p.status}</span>
              </div>
              {p.rent && <div className="text-sm">Rent: <span className="font-bold text-green-600">${safeNum(p.rent).toLocaleString()}/mo</span></div>}
            </div>
          ))}
          {properties.length === 0 && <div className="text-center py-8 text-slate-400">No properties assigned</div>}
        </div>
      )}
    </div>
  );
}

// ============ HOA PAYMENTS ============
function HOAPayments({ addNotification, userProfile, userRole, companyId }) {
  const [hoaPayments, setHoaPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingHoa, setEditingHoa] = useState(null);
  const [form, setForm] = useState({ property: "", hoa_name: "", amount: "", due_date: "", frequency: "monthly", status: "pending", notes: "" });
  const [hoaFilter, setHoaFilter] = useState("all");

  useEffect(() => { fetchHOA(); }, [companyId]);

  async function fetchHOA() {
    const { data } = await supabase.from("hoa_payments").select("*").eq("company_id", companyId).order("due_date", { ascending: false });
    setHoaPayments(data || []);
    setLoading(false);
  }

  async function saveHOA() {
      if (!guardSubmit("saveHOA")) return;
    try {
    if (!form.property || !form.hoa_name || !form.amount) { alert("Property, HOA name, and amount are required."); return; }
    if (!form.due_date) { setForm({...form, due_date: formatLocalDate(new Date())}); alert("Due date was not set — defaulting to today. Please verify and save again."); return; }
    const payload = { ...form, amount: Number(form.amount) };
    if (editingHoa) {
      const { error: hoaErr } = await supabase.from("hoa_payments").update({ property: payload.property, hoa_name: payload.hoa_name, amount: payload.amount, due_date: payload.due_date, frequency: payload.frequency, status: payload.status, notes: payload.notes }).eq("id", editingHoa.id).eq("company_id", companyId);
      if (hoaErr) { alert("Error updating HOA: " + hoaErr.message); return; }
      addNotification("🏘️", `HOA payment updated: ${form.hoa_name}`);
      logAudit("update", "hoa", `HOA updated: ${form.hoa_name} ${formatCurrency(form.amount)}`, editingHoa.id, userProfile?.email, userRole, companyId);
    } else {
      const { error: hoaErr } = await supabase.from("hoa_payments").insert([{ ...payload, company_id: companyId }]);
      if (hoaErr) { alert("Error saving HOA: " + hoaErr.message); return; }
      addNotification("🏘️", `HOA payment added: ${form.hoa_name} — ${formatCurrency(form.amount)}`);
      logAudit("create", "hoa", `HOA added: ${form.hoa_name} ${formatCurrency(form.amount)} at ${form.property}`, "", userProfile?.email, userRole, companyId);
    }
    setShowForm(false);
    setEditingHoa(null);
    setForm({ property: "", hoa_name: "", amount: "", due_date: "", frequency: "monthly", status: "pending", notes: "" });
    fetchHOA();
    } finally { guardRelease("saveHOA"); }
  }

  async function payHOA(h) {
    if (!guardSubmit("payHOA")) return;
    try {
    if (h.status === "paid") { alert("This HOA payment is already marked as paid."); return; }
    const today = formatLocalDate(new Date());
    await supabase.from("hoa_payments").update({ status: "paid", paid_date: today }).eq("company_id", companyId).eq("id", h.id);
    addNotification("✅", `HOA paid: ${h.hoa_name} ${formatCurrency(h.amount)}`);
    logAudit("update", "hoa", `HOA paid: ${h.hoa_name} ${formatCurrency(h.amount)} at ${h.property}`, h.id, userProfile?.email, userRole, companyId);
    // Auto-post to accounting
    const classId = await getPropertyClassId(h.property, companyId);
    if (safeNum(h.amount) > 0) {
      const _jeOk = await autoPostJournalEntry({
        companyId,
        date: today,
        description: `HOA payment: ${h.hoa_name} — ${h.property}`,
        reference: `HOA-${h.id}`,
        property: h.property,
        lines: [
          { account_id: "5500", account_name: "HOA Fees", debit: safeNum(h.amount), credit: 0, class_id: classId, memo: `HOA: ${h.hoa_name}` },
          { account_id: "1000", account_name: "Checking Account", debit: 0, credit: safeNum(h.amount), class_id: classId, memo: `HOA: ${h.hoa_name}` },
        ]
      });
      if (!_jeOk) { alert("Accounting entry failed. The record was saved but the journal entry could not be posted. Please check the accounting module."); }
      
    }
    fetchHOA();
    } finally { guardRelease("payHOA"); }
  }

  async function deleteHOA(id) {
      if (!guardSubmit("deleteHOA")) return;
      try {
    if (!window.confirm("Delete this HOA payment?")) return;
    await supabase.from("hoa_payments").delete().eq("id", id).eq("company_id", companyId);
    logAudit("delete", "hoa", "Deleted HOA payment", id, userProfile?.email, userRole, companyId);
    fetchHOA();
      } finally { guardRelease("deleteHOA"); }
  }

  if (loading) return <Spinner />;
  const filtered = hoaPayments.filter(h =>
    (hoaFilter === "all" || h.status === hoaFilter)
  );

  return (
    <div>
      <div className="flex flex-col md:flex-row gap-3 mb-4">
        <h2 className="text-2xl font-manrope font-bold text-slate-800 mr-auto">HOA Payments</h2>
        <select value={hoaFilter} onChange={e => setHoaFilter(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
          <option value="all">All Status</option><option value="pending">Pending</option><option value="paid">Paid</option>
        </select>
        <button onClick={() => { setEditingHoa(null); setForm({ property: "", hoa_name: "", amount: "", due_date: "", frequency: "monthly", status: "pending", notes: "" }); setShowForm(!showForm); }} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-indigo-700">+ Add HOA</button>
      </div>

      {/* Stats */}
      <div className="flex gap-3 mb-4">
        <div className="bg-white rounded-3xl border border-indigo-50 px-3 py-2 text-center flex-1"><div className="text-lg font-manrope font-bold text-slate-800">{hoaPayments.length}</div><div className="text-xs text-slate-400">Total</div></div>
        <div className="bg-white rounded-3xl border border-indigo-50 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-amber-600">{hoaPayments.filter(h => h.status === "pending").length}</div><div className="text-xs text-slate-400">Pending</div></div>
        <div className="bg-white rounded-3xl border border-indigo-50 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-emerald-600">${hoaPayments.filter(h => h.status === "paid").reduce((s, h) => s + safeNum(h.amount), 0).toLocaleString()}</div><div className="text-xs text-slate-400">Paid</div></div>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-slate-700 mb-3">{editingHoa ? "Edit HOA Payment" : "New HOA Payment"}</h3>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Property *</label><PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} companyId={companyId} /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">HOA Company</label><input placeholder="e.g. Riverside HOA" value={form.hoa_name} onChange={e => setForm({ ...form, hoa_name: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Amount ($)</label><input placeholder="250.00" type="number" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Due Date</label><input type="date" value={form.due_date} onChange={e => setForm({ ...form, due_date: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Frequency</label><select value={form.frequency} onChange={e => setForm({ ...form, frequency: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full">
              <option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option>
            </select></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Notes</label><input placeholder="Optional notes" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={saveHOA} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg">Save</button>
            <button onClick={() => { setShowForm(false); setEditingHoa(null); }} className="bg-slate-100 text-slate-500 text-sm px-4 py-2 rounded-lg">Cancel</button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-3xl shadow-card border border-indigo-50 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-indigo-50/30 text-xs text-slate-400 uppercase">
            <tr><th className="px-4 py-3 text-left">Property</th><th className="px-4 py-3 text-left">HOA Company</th><th className="px-4 py-3 text-right">Amount</th><th className="px-4 py-3 text-left">Due Date</th><th className="px-4 py-3 text-left">Frequency</th><th className="px-4 py-3 text-left">Status</th><th className="px-4 py-3 text-right">Actions</th></tr>
          </thead>
          <tbody>
            {filtered.map(h => (
              <tr key={h.id} className="border-t border-indigo-50/50 hover:bg-indigo-50/30/50">
                <td className="px-4 py-2.5 text-slate-800">{h.property}</td>
                <td className="px-4 py-2.5 font-medium text-slate-800">{h.hoa_name}</td>
                <td className="px-4 py-2.5 text-right font-semibold">${safeNum(h.amount).toLocaleString()}</td>
                <td className="px-4 py-2.5 text-slate-400">{h.due_date}</td>
                <td className="px-4 py-2.5 text-slate-500 capitalize">{h.frequency}</td>
                <td className="px-4 py-2.5"><Badge status={h.status} /></td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  {h.status === "pending" && <button onClick={() => payHOA(h)} className="text-xs text-green-600 hover:underline mr-2">Pay</button>}
                  <button onClick={() => { setEditingHoa(h); setForm({ property: h.property, hoa_name: h.hoa_name, amount: String(h.amount), due_date: h.due_date, frequency: h.frequency || "monthly", status: h.status, notes: h.notes || "" }); setShowForm(true); }} className="text-xs text-indigo-600 hover:underline mr-2">Edit</button>
                  <button onClick={() => deleteHOA(h.id)} className="text-xs text-red-500 hover:underline">Archive</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="text-center py-8 text-slate-400">No HOA payments found</div>}
      </div>
    </div>
  );
}

// ============ ARCHIVE (SOFT-DELETED ITEMS) ============
// NOTE: Stale "invited" membership records (>30 days old, never accepted) should be
// periodically cleaned up. Run: DELETE FROM company_members WHERE status = 'invited' 
// AND created_at < NOW() - INTERVAL '30 days';

function ArchivePage({ addNotification, userProfile, userRole, companyId }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");

  useEffect(() => { fetchArchived(); }, [companyId]);

  async function fetchArchived() {
    setLoading(true);
    const tables = [
      { name: "properties", label: "Property", fields: "id, address, type, status, archived_at, archived_by" },
      { name: "tenants", label: "Tenant", fields: "id, name, email, property, archived_at, archived_by" },
      { name: "work_orders", label: "Work Order", fields: "id, issue, property, status, archived_at" },
      { name: "documents", label: "Document", fields: "id, name, property, type, archived_at" },
      { name: "leases", label: "Lease", fields: "id, tenant_name, property, status, archived_at" },
      { name: "payments", label: "Payment", fields: "id, tenant, property, amount, archived_at" },
    ];
    let all = [];
    for (const t of tables) {
      const { data } = await supabase.from(t.name).select(t.fields).eq("company_id", companyId).not("archived_at", "is", null).order("archived_at", { ascending: false });
      if (data) {
        all = all.concat(data.map(d => ({ ...d, _table: t.name, _label: t.label })));
      }
    }
    all.sort((a, b) => new Date(b.archived_at) - new Date(a.archived_at));
    setItems(all);
    setLoading(false);
  }

  async function restoreItem(item) {
    if (!window.confirm(`Restore this ${item._label.toLowerCase()}?`)) return;
    const { error } = await supabase.from(item._table).update({ archived_at: null, archived_by: null }).eq("id", item.id).eq("company_id", companyId);
    if (error) {
      alert("Failed to restore: " + error.message);
      return;
    }
    // If restoring a property, also offer to restore its archived tenant
    if (item._table === "properties" && item.address) {
      const { data: archivedTenants } = await supabase.from("tenants").select("id, name").eq("company_id", companyId).eq("property", item.address).not("archived_at", "is", null);
      if (archivedTenants?.length > 0) {
        const shouldRestore = window.confirm(`Found ${archivedTenants.length} archived tenant(s) for this property: ${archivedTenants.map(t => t.name).join(", ")}\n\nWould you like to restore them too?`);
        if (shouldRestore) {
          for (const t of archivedTenants) {
            const { error: tErr } = await supabase.from("tenants").update({ archived_at: null, archived_by: null, lease_status: "active" }).eq("id", t.id).eq("company_id", companyId);
            if (tErr) console.warn("Failed to restore tenant:", t.name, tErr.message);
          }
          // Also restore associated leases
          const { error: lErr } = await supabase.from("leases").update({ archived_at: null, status: "active" }).eq("company_id", companyId).eq("property", item.address).not("archived_at", "is", null);
          if (lErr) console.warn("Failed to restore leases:", lErr.message);
          addNotification("♻️", `Restored property + ${archivedTenants.length} tenant(s)`);
        }
      }
    }
    // If restoring a tenant, update their property back to occupied
    if (item._table === "tenants" && item.property) {
      const { error: propErr } = await supabase.from("properties").update({ status: "occupied", tenant: item.name }).eq("company_id", companyId).eq("address", item.property).is("archived_at", null);
      if (propErr) console.warn("Failed to update property:", propErr.message);
    }
    addNotification("♻️", `Restored ${item._label}: ${item.address || item.name || item.issue || item.tenant_name || item.tenant || "item"}`);
    fetchArchived();
  }

  async function permanentDelete(item) {
    if (!window.confirm(`PERMANENTLY delete this ${item._label.toLowerCase()}? This cannot be undone.`)) return;
    const { error } = await supabase.from(item._table).delete().eq("id", item.id).eq("company_id", companyId);
    if (error) { alert("Failed to delete: " + error.message); return; }
    addNotification("🗑️", `Permanently deleted ${item._label}`);
    fetchArchived();
  }

  const filtered = filter === "all" ? items : items.filter(i => i._table === filter);
  const tables = [...new Set(items.map(i => i._table))];
  const daysUntilPurge = (item) => Math.max(0, 180 - Math.floor((new Date() - new Date(item.archived_at)) / 86400000));

  function getItemTitle(item) {
    return item.address || item.name || item.issue || item.tenant_name || item.tenant || "Unnamed";
  }

  function getItemSubtitle(item) {
    return item.property || item.email || item.type || item.status || "";
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-2xl font-manrope font-bold text-slate-800">Archive</h2>
          <p className="text-xs text-slate-400 mt-1">Archived items are auto-purged after 180 days</p>
        </div>
        <div className="text-sm text-slate-400">{items.length} archived item{items.length !== 1 ? "s" : ""}</div>
      </div>

      <div className="flex gap-2 mb-4 flex-wrap">
        <button onClick={() => setFilter("all")} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${filter === "all" ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500"}`}>All ({items.length})</button>
        {tables.map(t => {
          const count = items.filter(i => i._table === t).length;
          const label = t.replace("_", " ").replace(/\b\w/g, c => c.toUpperCase());
          return <button key={t} onClick={() => setFilter(t)} className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize ${filter === t ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500"}`}>{label} ({count})</button>;
        })}
      </div>

      {loading ? <div className="text-center py-8 text-slate-400">Loading...</div> : filtered.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-4xl mb-3">📦</div>
          <div className="text-slate-400">No archived items</div>
          <div className="text-xs text-slate-300 mt-1">Deleted items will appear here for 180 days</div>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(item => (
            <div key={item._table + item.id} className="bg-white rounded-3xl shadow-card border border-indigo-50 p-4 flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-lg">
                {item._table === "properties" ? "🏠" : item._table === "tenants" ? "👤" : item._table === "work_orders" ? "🔧" : item._table === "documents" ? "📄" : item._table === "leases" ? "📋" : "💰"}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-slate-800 text-sm">{getItemTitle(item)}</div>
                <div className="text-xs text-slate-400">{item._label} · {getItemSubtitle(item)}</div>
                <div className="text-xs text-slate-300 mt-0.5">Archived {new Date(item.archived_at).toLocaleDateString()} {item.archived_by ? "by " + item.archived_by : ""} · <span className={daysUntilPurge(item) < 30 ? "text-red-400 font-semibold" : "text-slate-400"}>{daysUntilPurge(item)} days until auto-purge</span></div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={() => restoreItem(item)} className="text-xs bg-emerald-50 text-emerald-700 px-3 py-1.5 rounded-lg hover:bg-emerald-100 font-medium">♻️ Restore</button>
                <button onClick={() => permanentDelete(item)} className="text-xs bg-red-50 text-red-600 px-3 py-1.5 rounded-lg hover:bg-red-100 font-medium">🗑️ Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============ ROLE DEFINITIONS ============
const ROLES = {
  admin: { label: "Admin", color: "bg-indigo-600", pages: ["dashboard","properties","tenants","payments","maintenance","utilities","hoa","accounting","owners","archive","notifications","audittrail","documents","leases","autopay","inspections","vendors","moveout","evictions"] },
  office_assistant: { label: "Office Assistant", color: "bg-blue-500", pages: ["dashboard","properties","tenants","payments","maintenance","utilities","hoa","accounting","archive","notifications","documents","leases","inspections","vendors","moveout","evictions"] },
  accountant: { label: "Accountant", color: "bg-green-600", pages: ["dashboard","accounting","payments","utilities"] },
  maintenance: { label: "Maintenance", color: "bg-orange-500", pages: ["maintenance","vendors"] },
  tenant: { label: "Tenant", color: "bg-indigo-50/300", pages: ["tenant_portal"] },
  owner: { label: "Owner", color: "bg-purple-600", pages: ["owner_portal"] },
};

const ALL_NAV = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "properties", label: "Properties", icon: "apartment" },
  { id: "tenants", label: "Tenants", icon: "people" },
  { id: "payments", label: "Payments", icon: "payments" },
  { id: "maintenance", label: "Maintenance", icon: "build" },
  { id: "utilities", label: "Utilities", icon: "bolt" },
  { id: "hoa", label: "HOA Payments", icon: "holiday_village" },
  { id: "accounting", label: "Accounting", icon: "account_balance" },
  { id: "owners", label: "Owners", icon: "person" },
  { id: "archive", label: "Archive", icon: "inventory_2" },
];

// ============ AUTOPAY / RECURRING RENT ============
function Autopay({ addNotification, userProfile, userRole, companyId }) {
  const [schedules, setSchedules] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ tenant: "", property: "", amount: "", frequency: "monthly", day_of_month: "1", start_date: "", end_date: "", method: "ACH", enabled: true });

  useEffect(() => { fetchData(); }, [companyId]);

  async function fetchData() {
    try {
      const [s, t] = await Promise.all([
        supabase.from("autopay_schedules").select("*").eq("company_id", companyId).order("created_at", { ascending: false }),
        supabase.from("tenants").select("*").eq("company_id", companyId),
      ]);
      setSchedules(s.data || []);
      setTenants(t.data || []);
    } catch {
      setSchedules([]);
      setTenants([]);
    }
    setLoading(false);
  }

  async function saveSchedule() {
      if (!guardSubmit("saveSchedule")) return;
      try {
    if (!form.tenant) { alert("Please select a tenant."); return; }
    if (!form.amount || isNaN(Number(form.amount)) || Number(form.amount) <= 0) { alert("Please enter a valid positive amount."); return; }
    if (!form.start_date) { alert("Start date is required."); return; }
    if (!form.day_of_month || Number(form.day_of_month) < 1 || Number(form.day_of_month) > 31 || isNaN(Number(form.day_of_month))) { alert("Day of month must be between 1 and 31."); return; }
    const { error } = await supabase.from("autopay_schedules").insert([{ ...form, amount: Number(form.amount), company_id: companyId }]);
    if (error) { alert("Error saving schedule: " + error.message); return; }
    addNotification("🔄", `Autopay schedule created for ${form.tenant}`);
    logAudit("create", "autopay", `Autopay created: ${form.tenant} $${form.amount}/mo at ${form.property}`, "", userProfile?.email, userRole, companyId);
    setShowForm(false);
    setForm({ tenant: "", property: "", amount: "", frequency: "monthly", day_of_month: "1", start_date: "", end_date: "", method: "ACH", enabled: true });
    fetchData();
      } finally { guardRelease("saveSchedule"); }
  }

  async function toggleActive(s) {
    // #11: Use 'enabled' consistently for autopay field name
    const newState = !s.enabled;
    const { error: togErr } = await supabase.from("autopay_schedules").update({ enabled: newState }).eq("company_id", companyId).eq("id", s.id);
    if (togErr) { alert("Error toggling autopay: " + togErr.message); return; }
    addNotification("🔄", `Autopay ${newState ? "activated" : "paused"} for ${s.tenant}`);
    logAudit("update", "autopay", `Autopay ${newState ? "enabled" : "disabled"}: ${s.tenant}`, s.id, userProfile?.email, userRole, companyId);
    fetchData();
  }

  async function deleteSchedule(id, tenant) {
      if (!guardSubmit("deleteSchedule")) return;
      try {
    if (!window.confirm(`Delete autopay schedule for ${tenant}?`)) return;
    await supabase.from("autopay_schedules").delete().eq("id", id).eq("company_id", companyId);
    logAudit("delete", "autopay", `Autopay deleted: ${tenant}`, id, userProfile?.email, userRole, companyId);
    fetchData();
      } finally { guardRelease("deleteSchedule"); }
  }

  async function runNow(s) {
    if (s._processing) return; s._processing = true;
    if (!s.amount || safeNum(s.amount) <= 0) { alert("Invalid autopay amount."); s._processing = false; return; }
    const today = formatLocalDate(new Date());
    // Duplicate guard: check for existing payment today
    const { data: todayPay } = await supabase.from("payments").select("id").eq("company_id", companyId).eq("tenant", s.tenant).eq("date", today).eq("method", s.method).limit(1);
    if (todayPay?.length > 0) { if (!window.confirm("A payment from " + s.tenant + " was already recorded today. Run again?")) { s._processing = false; return; } }
    const { error } = await supabase.from("payments").insert([{ company_id: companyId, tenant: s.tenant, property: s.property, amount: s.amount, type: "rent", method: s.method, status: "paid", date: today }]);
    if (error) { alert("Error: " + error.message); return; }
    // AUTO-POST TO ACCOUNTING: Same smart AR logic as manual payments
    const classId = await getPropertyClassId(s.property, companyId);
    const amt = safeNum(s.amount);
    const month = today.slice(0, 7);
    let hasAccrual = false;
    hasAccrual = await checkAccrualExists(companyId, month, s.tenant);
    if (hasAccrual) {
      const _jeOk = await autoPostJournalEntry({ companyId, date: today, description: "Autopay received — " + s.tenant + " — " + s.property + " (settling AR)", reference: "APAY-" + shortId(), property: s.property,
        lines: [
          { account_id: "1000", account_name: "Checking Account", debit: amt, credit: 0, class_id: classId, memo: "Autopay " + s.method + " from " + s.tenant },
          { account_id: "1100", account_name: "Accounts Receivable", debit: 0, credit: amt, class_id: classId, memo: "AR settlement — " + s.tenant },
        ]
      });
      if (!_jeOk) { alert("Accounting entry failed. The operation was recorded but the journal entry could not be posted. Please check the accounting module."); }
      
    } else {
      const _jeOk = await autoPostJournalEntry({ companyId, date: today, description: "Autopay — " + s.tenant + " — " + s.property, reference: "APAY-" + shortId(), property: s.property,
        lines: [
          { account_id: "1000", account_name: "Checking Account", debit: amt, credit: 0, class_id: classId, memo: "Autopay " + s.method + " from " + s.tenant },
          { account_id: "4000", account_name: "Rental Income", debit: 0, credit: amt, class_id: classId, memo: s.tenant + " — " + s.property },
        ]
      });
      if (!_jeOk) { alert("Accounting entry failed. The operation was recorded but the journal entry could not be posted. Please check the accounting module."); }
      
    }
    logAudit("create", "payments", "Autopay: $" + s.amount + " from " + s.tenant + " at " + s.property, "", userProfile?.email, userRole, companyId);
    addNotification("\ud83d\udcb3", "Autopay $" + s.amount + " processed for " + s.tenant);

    // Update tenant balance and create ledger entry
    const { data: tenantRow } = await supabase.from("tenants").select("id, balance, email").eq("name", s.tenant).eq("company_id", companyId).maybeSingle();
    if (tenantRow) {
      try {
        const { error: balErr } = await supabase.rpc("update_tenant_balance", { p_tenant_id: tenantRow.id, p_amount_change: -amt });
        if (balErr) alert("Balance update failed: " + balErr.message + ". Please verify the tenant balance.");
      } catch (e) { console.warn("Autopay balance RPC error:", e.message); }
      await safeLedgerInsert({ company_id: companyId,
        tenant: s.tenant, property: s.property,
        date: today, description: "Autopay payment (" + s.method + ")",
        amount: -amt, type: "payment", balance: 0,
      });
      // Queue payment receipt notification (#16)
      if (tenantRow.email) {
        queueNotification("payment_received", tenantRow.email, { tenant: s.tenant, amount: amt, date: today, property: s.property, method: s.method }, companyId);
      }
    }

    // Auto-create owner distribution for autopay rent (#3)
    await autoOwnerDistribution(companyId, s.property, amt, today, s.tenant);

    fetchData();
  }

  function nextDue(s) {
    const today = new Date();
    const rawDay = parseInt(s.day_of_month) || 1;
    // Clamp day to valid range for current month
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const day = Math.min(rawDay, daysInMonth);
    const next = new Date(today.getFullYear(), today.getMonth(), day);
    if (next <= today) {
      next.setMonth(next.getMonth() + 1);
      // Re-clamp for next month (e.g., 31 in Feb → 28)
      const nextDaysInMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      if (next.getDate() > nextDaysInMonth) next.setDate(nextDaysInMonth);
    }
    if (s.end_date && next > parseLocalDate(s.end_date)) return "Expired";
    return next.toLocaleDateString();
  }

  if (loading) return <Spinner />;

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-2xl font-manrope font-bold text-slate-800">Autopay & Recurring Rent</h2>
          <p className="text-xs text-slate-400 mt-0.5">Set recurring schedules per tenant with custom start and end dates</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-indigo-700">+ New Schedule</button>
      </div>
      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-5">
          <h3 className="font-semibold text-slate-700 mb-3">New Autopay Schedule</h3>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Tenant *</label><select value={form.tenant} onChange={e => { const t = tenants.find(t => t.name === e.target.value); setForm({ ...form, tenant: e.target.value, property: t?.property || "", amount: t?.rent || "" }); }} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full">
              <option value="">Select tenant...</option>
              {tenants.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
            </select></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Property</label><PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} companyId={companyId} /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Amount ($)</label><input placeholder="1500.00" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Payment Method</label><select value={form.method} onChange={e => setForm({ ...form, method: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full">
              {["ACH", "card", "cash", "check"].map(m => <option key={m}>{m}</option>)}
            </select></div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Day of Month</label>
              <select value={form.day_of_month} onChange={e => setForm({ ...form, day_of_month: e.target.value })} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
                {Array.from({ length: 28 }, (_, i) => i + 1).map(d => <option key={d} value={String(d)}>{d}{d === 1 ? "st" : d === 2 ? "nd" : d === 3 ? "rd" : "th"}</option>)}
              </select>
            </div>
            <div><label className="text-xs font-medium text-slate-400 mb-1 block">Frequency</label><select value={form.frequency} onChange={e => setForm({ ...form, frequency: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full">
              <option value="monthly">Monthly</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Bi-Weekly</option>
            </select></div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Start Date</label>
              <input type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">End Date (optional)</label>
              <input type="date" value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" />
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={saveSchedule} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-indigo-700">Save Schedule</button>
            <button onClick={() => setShowForm(false)} className="bg-slate-100 text-slate-500 text-sm px-4 py-2 rounded-lg">Cancel</button>
          </div>
        </div>
      )}
      <div className="space-y-3">
        {schedules.map(s => (
          <div key={s.id} className={`bg-white rounded-xl border shadow-sm p-4 ${s.enabled ? "border-indigo-50" : "border-indigo-100 opacity-60"}`}>
            <div className="flex justify-between items-start">
              <div>
                <div className="font-semibold text-slate-800">{s.tenant}</div>
                <div className="text-xs text-slate-400">{s.property}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${s.enabled ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-400"}`}>{s.enabled ? "Active" : "Paused"}</span>
                <span className="text-lg font-manrope font-bold text-slate-800">${s.amount}</span>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
              <div><span className="text-slate-400">Frequency</span><div className="font-semibold text-slate-700 capitalize">{s.frequency}</div></div>
              <div><span className="text-slate-400">Day</span><div className="font-semibold text-slate-700">{s.day_of_month}{s.day_of_month === "1" ? "st" : s.day_of_month === "2" ? "nd" : s.day_of_month === "3" ? "rd" : "th"} of month</div></div>
              <div><span className="text-slate-400">Start</span><div className="font-semibold text-slate-700">{s.start_date}</div></div>
              <div><span className="text-slate-400">End</span><div className="font-semibold text-slate-700">{s.end_date || "Ongoing"}</div></div>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <div className="text-xs text-indigo-600 font-medium">Next due: {nextDue(s)}</div>
              <div className="flex gap-2">
                <button onClick={() => runNow(s)} className="text-xs text-green-600 border border-green-200 px-3 py-1 rounded-lg hover:bg-green-50">▶ Run Now</button>
                <button onClick={() => toggleActive(s)} className={`text-xs border px-3 py-1 rounded-lg ${s.enabled ? "text-orange-500 border-orange-200 hover:bg-orange-50" : "text-green-600 border-green-200 hover:bg-green-50"}`}>{s.enabled ? "⏸ Pause" : "▶ Resume"}</button>
                <button onClick={() => deleteSchedule(s.id, s.tenant)} className="text-xs text-red-500 border border-red-200 px-3 py-1 rounded-lg hover:bg-red-50">🗑️</button>
              </div>
            </div>
          </div>
        ))}
        {schedules.length === 0 && <div className="text-center py-12 text-slate-400">No autopay schedules yet. Create one above.</div>}
      </div>
    </div>
  );
}

// ============ LATE FEES ============
function LateFees({ addNotification, userProfile, userRole, companyId }) {
  const [rules, setRules] = useState([]);
  const [flagged, setFlagged] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "Standard Late Fee", grace_days: "5", fee_amount: "50", fee_type: "flat" });

  useEffect(() => { fetchData(); }, [companyId]);

  async function fetchData() {
    try {
      const [r, p, t, lRes] = await Promise.all([
        supabase.from("late_fee_rules").select("*").eq("company_id", companyId),
        supabase.from("payments").select("*").eq("company_id", companyId).eq("status", "unpaid"),
        supabase.from("tenants").select("*").eq("company_id", companyId),
        supabase.from("leases").select("tenant_name, payment_due_day, status").eq("company_id", companyId).eq("status", "active"),
      ]);
      const leases = lRes.data || [];
      setRules(r.data || []);
      setTenants(t.data || []);
      const today = new Date();
      // Calculate overdue based on when rent was DUE (from lease due day), not payment record date
      const overdue = (p.data || []).filter(pay => {
        // Find the tenant's lease to get payment_due_day
        const tenant = (t.data || []).find(tn => tn.name === pay.tenant);
        const lease = tenant ? leases.find(l => l.tenant_name === pay.tenant && l.status === "active") : null;
        const dueDay = lease?.payment_due_day || 1;
        // Compute the due date for the month of this payment
        const payDate = parseLocalDate(pay.date);
        const dueDate = new Date(payDate.getFullYear(), payDate.getMonth(), Math.min(dueDay, new Date(payDate.getFullYear(), payDate.getMonth() + 1, 0).getDate()));
        const daysFromDue = Math.floor((today - dueDate) / 86400000);
        pay._dueDate = dueDate;
        pay._daysFromDue = daysFromDue;
        return daysFromDue > 0;
      }).map(pay => ({ ...pay, daysLate: pay._daysFromDue }));
      setFlagged(overdue);
    } catch {
      setRules([]);
      setTenants([]);
      setFlagged([]);
    }
    setLoading(false);
  }

  async function saveRule() {
      if (!guardSubmit("saveRule")) return;
      try {
    if (!form.grace_days || !form.fee_amount) { alert("Please fill all fields."); return; }
    if (isNaN(Number(form.grace_days)) || Number(form.grace_days) < 0) { alert("Grace days must be a valid number."); return; }
    if (isNaN(Number(form.fee_amount)) || Number(form.fee_amount) <= 0) { alert("Fee amount must be a positive number."); return; }
    const { error } = await supabase.from("late_fee_rules").insert([{ ...form, grace_days: Number(form.grace_days), fee_amount: Number(form.fee_amount), company_id: companyId }]);
    if (error) { alert("Error: " + error.message); return; }
    addNotification("⚠️", `Late fee rule "${form.name}" created`);
    setShowForm(false);
    fetchData();
      } finally { guardRelease("saveRule"); }
  }

  async function applyLateFee(payment, rule) {
    // Duplicate guard: check if late fee already applied for this tenant this month
    const thisMonth = formatLocalDate(new Date()).slice(0, 7);
    const { data: existingFee } = await supabase.from("ledger_entries").select("id")
      .eq("company_id", companyId).eq("tenant", payment.tenant)
      .eq("property", payment.property).eq("type", "late_fee").gte("date", thisMonth + "-01").limit(1);
    if (existingFee && existingFee.length > 0) {
      console.warn("Late fee already applied for " + payment.tenant + " this month");
      return;
    }
    const tenant = tenants.find(t => t.name === payment.tenant);
    const feeAmount = rule.fee_type === "flat" ? rule.fee_amount : Math.round((tenant?.rent || payment.amount) * rule.fee_amount / 100);
    if (tenant) {
      const newBalance = safeNum(tenant.balance) + feeAmount;
      await safeLedgerInsert({ company_id: companyId, tenant: payment.tenant, property: payment.property, date: formatLocalDate(new Date()), description: `Late fee — ${payment.daysLate} days overdue`, amount: feeAmount, type: "late_fee", balance: 0 });
      // Atomic balance update (prevents drift from concurrent writes)
      try {
        const { error: balErr } = await supabase.rpc("update_tenant_balance", { p_tenant_id: tenant.id, p_amount_change: feeAmount });
        if (balErr) alert("Balance update failed: " + balErr.message + ". Please verify the tenant balance.");
      } catch (e) { console.warn("Late fee balance RPC error:", e.message); }
    }
    addNotification("⚠️", `Late fee ${formatCurrency(feeAmount)} applied to ${payment.tenant}`);
    logAudit("create", "late_fees", `Late fee ${formatCurrency(feeAmount)} applied to ${payment.tenant} (${payment.daysLate} days overdue)`, tenant?.id || "", userProfile?.email, userRole, companyId);
    // Queue notification to tenant
    if (tenant?.email) queueNotification("late_fee_applied", tenant.email, { tenant: payment.tenant, amount: feeAmount, daysLate: payment.daysLate, property: payment.property }, companyId);
    // AUTO-POST TO ACCOUNTING: DR Accounts Receivable, CR Late Fee Income
    const classId = await getPropertyClassId(payment.property, companyId);
    if (feeAmount > 0) {
      const _jeOk = await autoPostJournalEntry({
        companyId,
        date: formatLocalDate(new Date()),
        description: "Late fee - " + payment.tenant + " - " + payment.property,
        reference: "LATE-" + shortId(),
        property: payment.property,
        lines: [
          { account_id: "1100", account_name: "Accounts Receivable", debit: feeAmount, credit: 0, class_id: classId, memo: "Late fee: " + payment.tenant },
          { account_id: "4010", account_name: "Late Fee Income", debit: 0, credit: feeAmount, class_id: classId, memo: payment.daysLate + " days overdue" },
        ]
      });
      if (!_jeOk) { alert("Accounting entry failed. The operation was recorded but the journal entry could not be posted. Please check the accounting module."); }
      
    }
    fetchData();
  }

  async function applyAllFees() {
    const rule = rules[0];
    if (!rule) { alert("Create a late fee rule first."); return; }
    if (!window.confirm(`Apply late fees to all ${flagged.filter(p => p.daysLate > rule.grace_days).length} overdue tenants?`)) return;
    for (const p of flagged.filter(p => p.daysLate > rule.grace_days)) await applyLateFee(p, rule);
  }

  if (loading) return <Spinner />;
  const afterGrace = flagged.filter(p => rules.length > 0 && p.daysLate > rules[0]?.grace_days);

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-2xl font-manrope font-bold text-slate-800">Late Fee Automation</h2>
          <p className="text-xs text-slate-400 mt-0.5">Auto-flag overdue payments and apply fees after grace period</p>
        </div>
        <div className="flex gap-2">
          {afterGrace.length > 0 && <button onClick={applyAllFees} className="bg-red-500 text-white text-sm px-4 py-2 rounded-lg hover:bg-red-600">⚡ Apply All ({afterGrace.length})</button>}
          <button onClick={() => setShowForm(!showForm)} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-indigo-700">+ New Rule</button>
        </div>
      </div>
      {rules.length > 0 && (
        <div className="mb-5 space-y-2">
          <h3 className="font-semibold text-slate-700 text-sm">Active Rules</h3>
          {rules.map(r => (
            <div key={r.id} className="bg-indigo-50 border border-indigo-100 rounded-2xl px-4 py-3 flex justify-between items-center">
              <div>
                <div className="font-semibold text-indigo-800 text-sm">{r.name}</div>
                <div className="text-xs text-indigo-500">{r.grace_days} day grace · {r.fee_type === "flat" ? `${formatCurrency(r.fee_amount)} flat` : `${r.fee_amount}% of rent`}</div>
              </div>
              <button onClick={async () => { if(!window.confirm("Delete this late fee rule?"))return; await supabase.from("late_fee_rules").delete().eq("id", r.id).eq("company_id", companyId); fetchData(); }} className="text-xs text-red-400 hover:text-red-600">Delete</button>
            </div>
          ))}
        </div>
      )}
      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-5">
          <h3 className="font-semibold text-slate-700 mb-3">New Late Fee Rule</h3>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><label className="text-xs font-medium text-slate-400 mb-1 block">Rule Name *</label><input placeholder="Standard Late Fee" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Grace Period (days)</label><input type="number" min="0" max="30" placeholder="5" value={form.grace_days} onChange={e => setForm({ ...form, grace_days: e.target.value })} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-400 mb-1 block">Fee Type</label><select value={form.fee_type} onChange={e => setForm({ ...form, fee_type: e.target.value })} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm"><option value="flat">Flat ($)</option><option value="percent">Percent (%)</option></select></div>
            <div><label className="text-xs text-slate-400 mb-1 block">{form.fee_type === "flat" ? "Fee Amount ($)" : "Percentage (%)"}</label><input type="number" min="0" step="0.01" placeholder={form.fee_type === "flat" ? "50.00" : "5.0"} value={form.fee_amount} onChange={e => setForm({ ...form, fee_amount: e.target.value })} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm" /></div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={saveRule} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-indigo-700">Save Rule</button>
            <button onClick={() => setShowForm(false)} className="bg-slate-100 text-slate-500 text-sm px-4 py-2 rounded-lg">Cancel</button>
          </div>
        </div>
      )}
      <div className="grid grid-cols-3 gap-3 mb-5">
        <div className="bg-white rounded-3xl border border-indigo-50 p-4 text-center"><div className="text-2xl font-bold text-orange-500">{flagged.length}</div><div className="text-xs text-slate-400 mt-1">Overdue</div></div>
        <div className="bg-white rounded-3xl border border-indigo-50 p-4 text-center"><div className="text-2xl font-bold text-red-500">{afterGrace.length}</div><div className="text-xs text-slate-400 mt-1">Past Grace Period</div></div>
        <div className="bg-white rounded-3xl border border-indigo-50 p-4 text-center"><div className="text-2xl font-bold text-slate-700">${flagged.reduce((s, p) => s + safeNum(p.amount), 0).toLocaleString()}</div><div className="text-xs text-slate-400 mt-1">Total Overdue</div></div>
      </div>
      <div className="space-y-3">
        {flagged.map(p => {
          const pastGrace = rules.length > 0 && p.daysLate > rules[0]?.grace_days;
          return (
            <div key={p.id} className={`bg-white rounded-xl border shadow-sm p-4 ${pastGrace ? "border-red-200" : "border-orange-100"}`}>
              <div className="flex justify-between items-start">
                <div><div className="font-semibold text-slate-800">{p.tenant}</div><div className="text-xs text-slate-400">{p.property}</div></div>
                <div className="text-right"><div className="font-bold text-red-500">${p.amount}</div><div className={`text-xs font-semibold ${pastGrace ? "text-red-500" : "text-orange-500"}`}>{p.daysLate} days late</div></div>
              </div>
              <div className="mt-3 flex gap-2">
                {pastGrace && rules.length > 0 && <button onClick={() => applyLateFee(p, rules[0])} className="text-xs text-red-600 border border-red-200 px-3 py-1 rounded-lg hover:bg-red-50">Apply ${rules[0].fee_type === "flat" ? rules[0].fee_amount : Math.round(p.amount * rules[0].fee_amount / 100)} Late Fee</button>}
                {!pastGrace && <span className="text-xs text-orange-500 bg-orange-50 px-3 py-1 rounded-lg">Within grace period</span>}
              </div>
            </div>
          );
        })}
        {flagged.length === 0 && <div className="text-center py-10 text-slate-400">🎉 No overdue payments!</div>}
      </div>
    </div>
  );
}

// ============ TENANT PORTAL ============
function TenantPortal({ currentUser, companyId }) {
  const [tenantData, setTenantData] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [payments, setPayments] = useState([]);
  const [messages, setMessages] = useState([]);
  const [workOrders, setWorkOrders] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [activeTab, setActiveTab] = useState("overview");
  const [loading, setLoading] = useState(true);
  const [paymentProcessing, setPaymentProcessing] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentSuccess, setPaymentSuccess] = useState(false);
  // Maintenance request form
  const [showMaintForm, setShowMaintForm] = useState(false);
  const [maintForm, setMaintForm] = useState({ issue: "", priority: "normal", notes: "" });
  const [maintPhotos, setMaintPhotos] = useState([]);

  useEffect(() => {
    async function fetchData() {
      const email = currentUser?.email;
      if (!email) { setLoading(false); return; }
      const { data: tenant } = await supabase.from("tenants").select("*").eq("company_id", companyId).ilike("email", email).maybeSingle();
      if (!tenant) { setLoading(false); return; }
      setTenantData(tenant);
      setPaymentAmount(String(tenant.rent || ""));
      const [l, m, p, w, d] = await Promise.all([
        supabase.from("ledger_entries").select("*").eq("company_id", companyId).eq("tenant", tenant.name).order("date", { ascending: false }),
        supabase.from("messages").select("*").eq("company_id", companyId).eq("tenant", tenant.name).order("created_at", { ascending: true }),
        supabase.from("payments").select("*").eq("company_id", companyId).eq("tenant", tenant.name).order("date", { ascending: false }),
        supabase.from("work_orders").select("*").eq("company_id", companyId).eq("tenant", tenant.name).order("created_at", { ascending: false }),
        supabase.from("documents").select("*").eq("company_id", companyId).eq("tenant", tenant.name).order("uploaded_at", { ascending: false }),
      ]);
      setLedger(l.data || []);
      setMessages(m.data || []);
      setPayments(p.data || []);
      setWorkOrders(w.data || []);
      setDocuments(d.data || []);
      // Check autopay status
      if (tenantName) {
        const { data: ap } = await supabase.from("autopay_schedules").select("enabled").eq("company_id", companyId).eq("tenant", tenantName).maybeSingle();
        if (ap?.enabled) setAutopayEnabled(true);
      }
      setLoading(false);
    }
    fetchData();
  }, [currentUser]);

  async function refreshData() {
    if (!tenantData) return;
    const [l, p, w, m] = await Promise.all([
      supabase.from("ledger_entries").select("*").eq("company_id", companyId).eq("tenant", tenantData.name).order("date", { ascending: false }),
      supabase.from("payments").select("*").eq("company_id", companyId).eq("tenant", tenantData.name).order("date", { ascending: false }),
      supabase.from("work_orders").select("*").eq("company_id", companyId).eq("tenant", tenantData.name).order("created_at", { ascending: false }),
      supabase.from("messages").select("*").eq("company_id", companyId).eq("tenant", tenantData.name).order("created_at", { ascending: true }),
    ]);
    setLedger(l.data || []);
    setPayments(p.data || []);
    setWorkOrders(w.data || []);
    setMessages(m.data || []);
    // Refresh tenant balance
    const { data: t } = await supabase.from("tenants").select("*").eq("company_id", companyId).ilike("email", currentUser?.email || "").maybeSingle();
    if (t) setTenantData(t);
  }

  // ---- STRIPE PAYMENT ----
  async function handleStripePayment() {
      if (!guardSubmit("handleStripePayment")) return;
      try {
    if (!paymentAmount || isNaN(Number(paymentAmount)) || Number(paymentAmount) <= 0) {
      alert("Please enter a valid payment amount."); return;
    }
    if (Number(paymentAmount) > safeNum(tenantData.balance) * 2) {
      if (!window.confirm("Payment amount ($" + paymentAmount + ") is significantly more than your balance ($" + safeNum(tenantData.balance).toFixed(2) + "). Continue?")) return;
    }
    setPaymentProcessing(true);
    try {
      const amt = Number(paymentAmount);
      // Try Stripe Checkout via Supabase Edge Function
      try {
        const { data, error } = await supabase.functions.invoke("create-checkout-session", {
          body: {
            amount: Math.round(amt * 100), // Stripe uses cents
            tenantId: tenantData.id,
            tenantName: tenantData.name,
            property: tenantData.property,
            companyId: companyId,
            successUrl: window.location.origin + "?payment=success",
            cancelUrl: window.location.origin + "?payment=cancelled",
          }
        });
        if (!error && data?.url) {
          window.location.href = data.url; // Redirect to Stripe Checkout
          return;
        }
      } catch (stripeErr) { console.warn("Stripe Edge Function not available, using fallback:", stripeErr.message); }
      // Fallback: record payment as pending_approval (no Stripe integration yet)
      const today = formatLocalDate(new Date());
      const { error: payErr } = await supabase.from("payments").insert([{ company_id: companyId,
        tenant: tenantData.name, property: tenantData.property, amount: amt,
        type: "rent", method: "stripe", status: "pending_approval", date: today,
      }]);
      if (payErr) throw new Error("Failed to record payment: " + payErr.message);
      setPaymentSuccess(true);
      setPaymentAmount("");
      addNotification("💳", "Payment of $" + amt.toFixed(2) + " submitted for approval");
      queueNotification("payment_received", currentUser?.email, { tenant: tenantData.name, amount: amt, date: today, status: "pending_approval" }, companyId);
      const { data: refreshed } = await supabase.from("tenants").select("*").eq("company_id", companyId).ilike("email", currentUser?.email || "").maybeSingle();
      if (refreshed) setTenantData(refreshed);
    } catch (e) {
      alert("Payment failed: " + e.message);
    }
    setPaymentProcessing(false);
      } finally { guardRelease("handleStripePayment"); }
  }

  // ---- MAINTENANCE REQUEST ----
  async function submitMaintenanceRequest() {
      if (!guardSubmit("submitMaintenanceRequest")) return;
      try {
    if (!maintForm.issue.trim()) { alert("Please describe the issue."); return; }
    // Create the work order first
    const { data: newWO, error } = await supabase.from("work_orders").insert([{ company_id: companyId,
      property: tenantData.property,
      tenant: tenantData.name,
      issue: maintForm.issue,
      priority: maintForm.priority,
      status: "open",
      notes: maintForm.notes,
      cost: 0,
    }]).select();
    // Upload photos and link to the work order
    if (newWO?.[0] && maintPhotos.length > 0) {
      for (const photo of maintPhotos) {
        const fileName = shortId() + "-" + sanitizeFileName(photo.name);
        const { error: uploadErr } = await supabase.storage.from("maintenance-photos").upload(fileName, photo);
        if (!uploadErr) {
          await supabase.from("work_order_photos").insert([{
            work_order_id: newWO[0].id, property: tenantData.property,
            url: fileName, caption: photo.name,
            company_id: companyId, storage_bucket: "maintenance-photos"
          }]);
        }
      }
    }
    if (error) { alert("Error submitting request: " + error.message); return; }
    logAudit("create", "maintenance", "Tenant submitted: " + maintForm.issue, "", currentUser?.email, "tenant", companyId);
    setMaintForm({ issue: "", priority: "normal", notes: "" });
    setMaintPhotos([]);
    setShowMaintForm(false);
    await refreshData();
      } finally { guardRelease("submitMaintenanceRequest"); }
  }

  // ---- MESSAGING ----
  async function sendMessage() {
    if (!newMessage.trim() || !tenantData) return;
    const { error: _err7538 } = await supabase.from("messages").insert([{ company_id: companyId, tenant: tenantData.name, property: tenantData.property, sender: tenantData.name, message: newMessage, read: false }]);
    if (_err7538) console.warn("messages write failed:", _err7538.message);
    setNewMessage("");
    const { data } = await supabase.from("messages").select("*").eq("company_id", companyId).eq("tenant", tenantData.name).order("created_at", { ascending: true });
    setMessages(data || []);
  }

  if (loading) return <Spinner />;
  if (!tenantData) return (
    <div className="text-center py-20">
      <div className="text-5xl mb-4">🏠</div>
      <div className="text-slate-500 font-semibold text-lg">No tenant account linked to this email.</div>
      <div className="text-slate-400 text-sm mt-2">Contact your property manager to get access.</div>
      <div className="text-xs text-slate-300 mt-4">{currentUser?.email}</div>
    </div>
  );

  const [autopayEnabled, setAutopayEnabled] = useState(false);
  const [autopayLoading, setAutopayLoading] = useState(false);

  const tabs = [
    ["overview", "\ud83c\udfe0 Overview"],
    ["pay", "\ud83d\udcb3 Pay Rent"],
    ["autopay", "🔄 Autopay"],
    ["history", "📋 History"],
    ["maintenance", "🔧 Maintenance"],
    ["documents", "\ud83d\udcc1 Documents"],
    ["messages", "\ud83d\udcac Messages"],
  ];

  return (
    <div>
      {/* Tenant Header */}
      <div className="bg-gradient-to-r from-indigo-600 to-indigo-800 rounded-3xl p-5 mb-5 text-white">
        <div className="flex justify-between items-start">
          <div>
            <div className="text-lg font-bold">{tenantData.name}</div>
            <div className="text-indigo-200 text-sm">{tenantData.property}</div>
          </div>
          <div className="text-right text-xs text-indigo-200">Lease: {tenantData.lease_status || "active"}</div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <div className="bg-white/10 backdrop-blur rounded-lg p-3 text-center">
            <div className="text-xs text-indigo-200">Balance Due</div>
            <div className={"text-xl font-bold " + (safeNum(tenantData.balance) > 0 ? "text-red-300" : "text-green-300")}>
              {safeNum(tenantData.balance) > 0 ? "$" + safeNum(tenantData.balance).toLocaleString() : "$0.00"}
            </div>
          </div>
          <div className="bg-white/10 backdrop-blur rounded-lg p-3 text-center">
            <div className="text-xs text-indigo-200">Monthly Rent</div>
            <div className="text-xl font-bold">${safeNum(tenantData.rent).toLocaleString()}</div>
          </div>
          <div className="bg-white/10 backdrop-blur rounded-lg p-3 text-center">
            <div className="text-xs text-indigo-200">Lease End</div>
            <div className="text-sm font-bold mt-1">{tenantData.move_out || "—"}</div>
          </div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-1 mb-5 overflow-x-auto pb-1 border-b border-indigo-50">
        {tabs.map(([id, label]) => (
          <button key={id} onClick={() => setActiveTab(id)} className={"px-3 py-2 text-xs font-medium border-b-2 whitespace-nowrap transition-colors " + (activeTab === id ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-400 hover:text-slate-700")}>{label}</button>
        ))}
      </div>

      {/* ---- OVERVIEW TAB ---- */}
      {activeTab === "overview" && (
        <div className="space-y-4">
          <div className="bg-white rounded-3xl border border-indigo-50 p-4">
            <h3 className="font-semibold text-slate-700 mb-3">Lease Details</h3>
            {[["Status", (tenantData.lease_status || "active")], ["Property", tenantData.property], ["Move-in", tenantData.move_in || "—"], ["Lease End", tenantData.move_out || "—"], ["Monthly Rent", "$" + safeNum(tenantData.rent).toLocaleString()], ["Email", tenantData.email || "—"], ["Phone", tenantData.phone || "—"]].map(([l, v]) => (
              <div key={l} className="flex justify-between py-2 border-b border-indigo-50/50 text-sm last:border-0"><span className="text-slate-400">{l}</span><span className="font-medium text-slate-800 capitalize">{v}</span></div>
            ))}
          </div>
          {safeNum(tenantData.balance) > 0 && (
            <div className="bg-red-50 border border-red-100 rounded-3xl p-4 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-red-800">Balance Due: ${safeNum(tenantData.balance).toLocaleString()}</div>
                <div className="text-xs text-red-600">Please make a payment to avoid late fees.</div>
              </div>
              <button onClick={() => setActiveTab("pay")} className="bg-red-600 text-white text-xs px-4 py-2 rounded-lg hover:bg-red-700">Pay Now</button>
            </div>
          )}
          <div className="bg-white rounded-3xl border border-indigo-50 p-4">
            <h3 className="font-semibold text-slate-700 mb-3">Recent Activity</h3>
            {payments.slice(0, 3).map(p => (
              <div key={p.id} className="flex justify-between py-2 border-b border-indigo-50/50 last:border-0 text-sm">
                <div><span className="text-green-600 font-medium">Payment</span> <span className="text-slate-400">— {p.date}</span></div>
                <span className="font-semibold text-slate-800">${safeNum(p.amount).toLocaleString()}</span>
              </div>
            ))}
            {workOrders.slice(0, 2).map(w => (
              <div key={w.id} className="flex justify-between py-2 border-b border-indigo-50/50 last:border-0 text-sm">
                <div><span className="text-orange-600 font-medium">Maintenance</span> <span className="text-slate-400">— {w.issue}</span></div>
                <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (w.status === "completed" ? "bg-green-100 text-green-700" : w.status === "in_progress" ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700")}>{w.status}</span>
              </div>
            ))}
            {payments.length === 0 && workOrders.length === 0 && <div className="text-center py-4 text-slate-400 text-sm">No recent activity</div>}
          </div>
        </div>
      )}

      {/* ---- PAY RENT TAB ---- */}
      {activeTab === "pay" && (
        <div className="max-w-md mx-auto">
          {paymentSuccess && (
            <div className="bg-green-50 border border-green-200 rounded-3xl p-4 mb-4 text-center">
              <div className="text-2xl mb-1">✅</div>
              <div className="text-green-800 font-semibold">Payment Successful!</div>
              <div className="text-green-600 text-sm">Your payment has been recorded and your balance updated.</div>
            </div>
          )}
          <div className="bg-white rounded-3xl border border-indigo-50 p-6">
            <h3 className="font-semibold text-slate-800 text-lg mb-1">Make a Payment</h3>
            <p className="text-sm text-slate-400 mb-5">Pay securely with Stripe</p>
            <div className="mb-4">
              <label className="text-xs text-slate-400 mb-1 block">Current Balance</label>
              <div className={"text-2xl font-bold " + (safeNum(tenantData.balance) > 0 ? "text-red-600" : "text-green-600")}>
                ${safeNum(tenantData.balance).toLocaleString()}
              </div>
            </div>
            <div className="mb-4">
              <label className="text-xs text-slate-400 mb-1 block">Payment Amount</label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-slate-400">$</span>
                <input type="number" value={paymentAmount} onChange={e => setPaymentAmount(e.target.value)} className="w-full border border-indigo-100 rounded-2xl pl-7 pr-3 py-2.5 text-lg font-mono" placeholder="0.00" />
              </div>
              <div className="flex gap-2 mt-2">
                <button onClick={() => setPaymentAmount(String(tenantData.rent || 0))} className="text-xs bg-slate-100 text-slate-500 px-3 py-1 rounded-2xl hover:bg-slate-100">Full Rent (${safeNum(tenantData.rent)})</button>
                {safeNum(tenantData.balance) > 0 && <button onClick={() => setPaymentAmount(String(tenantData.balance))} className="text-xs bg-red-50 text-red-600 px-3 py-1 rounded-lg hover:bg-red-100">Full Balance (${safeNum(tenantData.balance)})</button>}
              </div>
            </div>
            <div className="mb-4 p-3 bg-indigo-50/30 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-8 h-5 bg-gradient-to-r from-indigo-600 to-purple-600 rounded text-white text-xs flex items-center justify-center font-bold">S</div>
                <span className="text-sm text-slate-500">Powered by Stripe</span>
              </div>
              <div className="text-xs text-slate-400">Secure payment processing. Your card information is encrypted and never stored on our servers.</div>
            </div>
            <button onClick={handleStripePayment} disabled={paymentProcessing} className={"w-full py-3 rounded-xl text-white font-semibold text-sm transition-all " + (paymentProcessing ? "bg-slate-400 cursor-not-allowed" : "bg-indigo-600 hover:bg-indigo-700 active:scale-98")}>
              {paymentProcessing ? "Processing..." : "Pay $" + (paymentAmount || "0")}
            </button>
            <div className="text-xs text-slate-400 text-center mt-3">A receipt will be available after payment is confirmed.</div>
          </div>
        </div>
      )}

      {/* ---- AUTOPAY TAB ---- */}
      {activeTab === "autopay" && tenantData && (
        <div className="max-w-md mx-auto">
          <h3 className="font-manrope font-bold text-slate-800 mb-4">Recurring Payments</h3>
          <div className="bg-white rounded-3xl border border-indigo-50 shadow-card p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="text-sm font-semibold text-slate-700">Monthly Autopay</div>
                <div className="text-xs text-slate-400">Automatically pay rent on the 1st</div>
              </div>
              <button onClick={async () => {
                setAutopayLoading(true);
                try {
                  if (autopayEnabled) {
                    await supabase.from("autopay_schedules").update({ enabled: false }).eq("company_id", companyId).eq("tenant", tenantData.name);
                    setAutopayEnabled(false);
                    addNotification("🔄", "Autopay disabled");
                  } else {
                    const { data: existing } = await supabase.from("autopay_schedules").select("id").eq("company_id", companyId).eq("tenant", tenantData.name).maybeSingle();
                    if (existing) {
                      await supabase.from("autopay_schedules").update({ enabled: true, amount: safeNum(tenantData.rent), method: "stripe" }).eq("id", existing.id);
                    } else {
                      await supabase.from("autopay_schedules").insert([{ company_id: companyId, tenant: tenantData.name, property: tenantData.property, amount: safeNum(tenantData.rent), method: "stripe", day_of_month: 1, enabled: true }]);
                    }
                    setAutopayEnabled(true);
                    addNotification("🔄", "Autopay enabled — $" + safeNum(tenantData.rent) + "/month");
                  }
                } catch (e) { alert("Error: " + e.message); }
                setAutopayLoading(false);
              }} disabled={autopayLoading} className={`relative w-12 h-6 rounded-full transition-colors ${autopayEnabled ? "bg-emerald-500" : "bg-slate-300"}`}>
                <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${autopayEnabled ? "translate-x-6" : "translate-x-0.5"}`} />
              </button>
            </div>
            {autopayEnabled && (
              <div className="bg-emerald-50 rounded-2xl p-4 space-y-2">
                <div className="flex justify-between text-sm"><span className="text-slate-400">Amount</span><span className="font-bold text-emerald-700">${safeNum(tenantData.rent).toLocaleString()}/month</span></div>
                <div className="flex justify-between text-sm"><span className="text-slate-400">Payment Day</span><span className="font-medium text-slate-700">1st of each month</span></div>
                <div className="flex justify-between text-sm"><span className="text-slate-400">Method</span><span className="font-medium text-slate-700">Stripe</span></div>
              </div>
            )}
            {!autopayEnabled && (
              <div className="bg-indigo-50/30 rounded-2xl p-4 text-center">
                <span className="material-icons-outlined text-slate-300 text-3xl mb-2">autorenew</span>
                <p className="text-sm text-slate-400">Enable autopay to schedule your rent payment on the 1st of each month. Requires the autopay processing worker to be deployed.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---- PAYMENT HISTORY TAB ---- */}
      {activeTab === "history" && (
        <div>
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-semibold text-slate-700">Payment History</h3>
            <button onClick={() => exportToCSV(payments, [
              { label: "Date", key: "date" }, { label: "Type", key: "type" }, { label: "Amount", key: "amount" },
              { label: "Method", key: "method" }, { label: "Status", key: "status" },
            ], "my-payments")} className="text-xs text-indigo-600 border border-indigo-200 px-2 py-1 rounded-lg hover:bg-indigo-50"><span className="material-icons-outlined text-xs align-middle mr-1">download</span>Export</button>
          </div>
          <div className="space-y-2">
            {payments.map(p => (
              <div key={p.id} className="bg-white border border-indigo-50 rounded-2xl px-4 py-3 flex justify-between items-center">
                <div>
                  <div className="text-sm font-medium text-slate-800">{p.type === "rent" ? "Rent Payment" : p.type}</div>
                  <div className="text-xs text-slate-400">{p.date} · {p.method}</div>
                </div>
                <div className="flex items-center gap-3">
                  {p.status === "paid" && <button onClick={() => generatePaymentReceipt(p)} className="text-xs text-indigo-600 border border-indigo-200 px-2 py-0.5 rounded hover:bg-indigo-50">Receipt</button>}
                  <div className="text-right">
                    <div className="text-sm font-bold text-green-600">${safeNum(p.amount).toLocaleString()}</div>
                    <span className={"text-xs px-2 py-0.5 rounded-full " + (p.status === "paid" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700")}>{p.status}</span>
                  </div>
                </div>
              </div>
            ))}
            {payments.length === 0 && <div className="text-center py-8 text-slate-400">No payments recorded yet</div>}
          </div>
          {/* Ledger / Account Balance */}
          <h3 className="font-semibold text-slate-700 mt-6 mb-3">Account Ledger</h3>
          <div className="space-y-2">
            {ledger.map(e => (
              <div key={e.id} className="bg-white border border-indigo-50 rounded-2xl px-4 py-3">
                <div className="flex justify-between">
                  <div><div className="text-sm font-medium text-slate-800">{e.description}</div><div className="text-xs text-slate-400">{e.date}</div></div>
                  <div className="text-right">
                    <div className={"text-sm font-bold " + (e.amount > 0 ? "text-red-500" : "text-green-600")}>{e.amount > 0 ? "+$" + e.amount : "-$" + Math.abs(e.amount)}</div>
                    <div className="text-xs text-slate-400">Bal: ${e.balance}</div>
                  </div>
                </div>
              </div>
            ))}
            {ledger.length === 0 && <div className="text-center py-8 text-slate-400">No ledger entries yet</div>}
          </div>
        </div>
      )}

      {/* ---- MAINTENANCE TAB ---- */}
      {activeTab === "maintenance" && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-semibold text-slate-700">Maintenance Requests</h3>
            <button onClick={() => setShowMaintForm(!showMaintForm)} className="bg-indigo-600 text-white text-xs px-4 py-2 rounded-2xl hover:bg-indigo-700">
              {showMaintForm ? "Cancel" : "+ New Request"}
            </button>
          </div>
          {showMaintForm && (
            <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
              <h4 className="font-medium text-slate-700 mb-3">Submit a Maintenance Request</h4>
              <label className="text-xs font-medium text-slate-400 mb-1 block">What's the issue? *</label>
              <input placeholder="e.g. Leaking faucet in kitchen" value={maintForm.issue} onChange={e => setMaintForm({...maintForm, issue: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mb-3" />
              <select value={maintForm.priority} onChange={e => setMaintForm({...maintForm, priority: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mb-3">
                <option value="normal">Normal Priority</option>
                <option value="urgent">Urgent</option>
                <option value="emergency">Emergency</option>
              </select>
              <textarea placeholder="Additional details..." value={maintForm.notes} onChange={e => setMaintForm({...maintForm, notes: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mb-3" rows={3} />
              <div className="mb-3">
                <label className="text-xs text-slate-400 mb-1 block">Attach Photo (optional)</label>
                <input type="file" accept="image/*" onChange={e => setMaintPhoto(e.target.files[0])} className="text-sm" />
              </div>
              <button onClick={submitMaintenanceRequest} className="bg-indigo-600 text-white text-sm px-6 py-2 rounded-2xl hover:bg-indigo-700">Submit Request</button>
            </div>
          )}
          <div className="space-y-2">
            {workOrders.map(w => (
              <div key={w.id} className="bg-white border border-indigo-50 rounded-2xl px-4 py-3">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="text-sm font-medium text-slate-800">{w.issue}</div>
                    <div className="text-xs text-slate-400">{w.property} · {new Date(w.created_at).toLocaleDateString()}</div>
                    {w.notes && <div className="text-xs text-slate-400 mt-1">{w.notes}</div>}
                  </div>
                  <div className="text-right">
                    <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (w.status === "completed" ? "bg-green-100 text-green-700" : w.status === "in_progress" ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700")}>{w.status.replace("_", " ")}</span>
                    <div className={"text-xs mt-1 " + (w.priority === "emergency" ? "text-red-500 font-bold" : w.priority === "urgent" ? "text-orange-500" : "text-slate-400")}>{w.priority}</div>
                  </div>
                </div>
              </div>
            ))}
            {workOrders.length === 0 && <div className="text-center py-8 text-slate-400">No maintenance requests</div>}
          </div>
        </div>
      )}

      {/* ---- DOCUMENTS TAB ---- */}
      {activeTab === "documents" && (
        <div>
          <h3 className="font-semibold text-slate-700 mb-3">My Documents</h3>
          <div className="space-y-2">
            {documents.map(d => (
              <div key={d.id} className="bg-white border border-indigo-50 rounded-2xl px-4 py-3 flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-indigo-50 rounded-lg flex items-center justify-center text-indigo-600 text-lg">
                    {d.type === "lease" ? "\ud83d\udcdc" : d.type === "notice" ? "\ud83d\udce8" : "📄"}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-slate-800">{d.name || d.file_name}</div>
                    <div className="text-xs text-slate-400">{d.type || "Document"} · {new Date(d.uploaded_at).toLocaleDateString()}</div>
                  </div>
                </div>
                {d.url && <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-600 border border-indigo-200 px-3 py-1 rounded-lg hover:bg-indigo-50">View</a>}
              </div>
            ))}
            {documents.length === 0 && <div className="text-center py-8 text-slate-400">No documents uploaded yet</div>}
          </div>
        </div>
      )}

      {/* ---- MESSAGES TAB ---- */}
      {activeTab === "messages" && (
        <div className="bg-white rounded-3xl border border-indigo-50">
          <div className="p-4 space-y-3 max-h-96 overflow-y-auto">
            {messages.map(m => (
              <div key={m.id} className={"flex " + (m.sender !== tenantData.name ? "justify-start" : "justify-end")}>
                <div className={"max-w-xs rounded-2xl px-4 py-2.5 " + (m.sender !== tenantData.name ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-800")}>
                  <div className="text-sm">{m.message}</div>
                  <div className={"text-xs mt-1 " + (m.sender !== tenantData.name ? "text-indigo-200" : "text-slate-400")}>{m.sender} · {new Date(m.created_at).toLocaleDateString()}</div>
                </div>
              </div>
            ))}
            {messages.length === 0 && <div className="text-center py-6 text-slate-400 text-sm">No messages yet. Send a message to your property manager below.</div>}
          </div>
          <div className="p-3 border-t border-indigo-50 flex gap-2">
            <input value={newMessage} onChange={e => setNewMessage(e.target.value)} onKeyDown={e => e.key === "Enter" && sendMessage()} placeholder="Message your property manager..." className="flex-1 border border-indigo-100 rounded-2xl px-3 py-2 text-sm" />
            <button onClick={sendMessage} className="bg-indigo-600 text-white px-4 py-2 rounded-xl text-sm hover:bg-indigo-700">Send</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============ ROLE MANAGEMENT ============
function RoleManagement({ addNotification, companyId }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingUser, setEditingUser] = useState(null); // user being edited
  const [form, setForm] = useState({ email: "", role: "office_assistant", name: "" });
  // customPages: which modules are toggled ON when adding/editing a user
  const [customPages, setCustomPages] = useState([]);

  // All modules that can be assigned (admin and tenant are fixed, not customizable)
  const CUSTOMIZABLE_ROLES = ["office_assistant", "accountant", "maintenance"];

  useEffect(() => { fetchUsers(); }, [companyId]);

  async function fetchUsers() {
    const { data } = await supabase.from("app_users").select("*").eq("company_id", companyId).order("created_at", { ascending: false });
    setUsers(data || []);
    setLoading(false);
  }

  // When role changes in the form, pre-fill the default pages for that role
  function handleRoleChange(role) {
    setForm(f => ({ ...f, role }));
    setCustomPages(ROLES[role]?.pages ? [...ROLES[role].pages] : []);
  }

  function togglePage(pageId) {
    setCustomPages(prev =>
      prev.includes(pageId) ? prev.filter(p => p !== pageId) : [...prev, pageId]
    );
  }

  function startAdd() {
    setEditingUser(null);
    setForm({ email: "", role: "office_assistant", name: "" });
    setCustomPages([...ROLES["office_assistant"].pages]);
    setShowForm(true);
  }

  function startEdit(u) {
    setEditingUser(u);
    setForm({ email: u.email, role: u.role, name: u.name });
    // Load their custom pages if saved, otherwise use role defaults
    const savedPages = u.custom_pages ? JSON.parse(u.custom_pages) : ROLES[u.role]?.pages || [];
    setCustomPages([...savedPages]);
    setShowForm(true);
  }

  async function saveUser() {
      if (!guardSubmit("saveUser")) return;
      try {
    if (!form.email.trim()) { alert("Email is required."); return; }
    if (!form.name.trim()) { alert("Name is required."); return; }
    if (!form.email.trim() || !form.email.includes("@")) { alert("Please enter a valid email address."); return; }
    if (customPages.length === 0) { alert("Please select at least one module."); return; }

    const payload = {
      email: form.email,
      role: form.role,
      name: form.name,
      custom_pages: JSON.stringify(customPages),
      company_id: companyId,
    };

    if (editingUser) {
      const emailChanged = editingUser.email && normalizeEmail(editingUser.email) !== normalizeEmail(payload.email);
      if (emailChanged) {
        // Atomic email change: delete old membership + update user + create new membership in one transaction
        try {
          const { error: rpcErr } = await supabase.rpc("change_user_email", {
            p_company_id: companyId,
            p_user_id: String(editingUser.id),
            p_old_email: editingUser.email,
            p_new_email: payload.email,
            p_name: payload.name,
            p_role: payload.role,
            p_custom_pages: JSON.stringify(customPages),
          });
          if (rpcErr) throw new Error(rpcErr.message);
        } catch (rpcE) {
          alert("Failed to update user email: " + rpcE.message + "\n\nNo changes were made. Please ensure the database is properly configured.");
          return;
        }
      } else {
        // No email change — just update role/name/pages
        const { error } = await supabase.from("app_users").update({ email: normalizeEmail(payload.email), role: payload.role, name: payload.name, custom_pages: payload.custom_pages, company_id: payload.company_id }).eq("company_id", companyId).eq("id", editingUser.id);
        if (error) { alert("Error: " + error.message); return; }
        await supabase.from("company_members").upsert([{ company_id: companyId, user_email: (form.email || "").toLowerCase(), user_name: form.name, role: form.role, status: "active", custom_pages: JSON.stringify(customPages) }], { onConflict: "company_id,user_email" });
      }
      addNotification("👥", `${form.name}'s access updated`);
    } else {
      const { error, data: newUser } = await supabase.from("app_users").insert([{ ...payload, email: normalizeEmail(payload.email) }]).select();
      if (error) { alert("Error: " + error.message); return; }
      // Also add to company_members
      await supabase.from("company_members").upsert([{ company_id: companyId, user_email: (form.email || "").toLowerCase(), user_name: form.name, role: form.role, status: "active", custom_pages: JSON.stringify(customPages) }], { onConflict: "company_id,user_email" });
      addNotification("👥", `${form.name} added as ${ROLES[form.role]?.label}`);
      // Offer to send invite
      if (newUser?.[0] && window.confirm(`${form.name} has been added!\n\nWould you like to send them a login invite now?`)) {
        await inviteUser({ ...newUser[0], ...payload });
      }
    }

    setShowForm(false);
    setEditingUser(null);
    setForm({ email: "", role: "office_assistant", name: "" });
    setCustomPages([]);
    fetchUsers();
      } finally { guardRelease("saveUser"); }
  }

  async function removeUser(id, name, email) {
      if (!guardSubmit("removeUser")) return;
      try {
    if (!window.confirm(`Remove ${name}?`)) return;
    await supabase.from("app_users").delete().eq("id", id).eq("company_id", companyId);
    // Also deactivate their company membership
    if (email) {
      const { error: _err7920 } = await supabase.from("company_members").update({ status: "removed" }).eq("company_id", companyId).eq("user_email", email.toLowerCase());
      if (_err7920) { alert("Error updating company_members: " + _err7920.message); return; }
    }
    addNotification("👥", `${name} removed`);
    fetchUsers();
      } finally { guardRelease("removeUser"); }
  }

  async function inviteUser(user) {
      if (!guardSubmit("inviteUser")) return;
      try {
    if (!user.email) { alert("This user has no email address."); return; }
    const roleName = ROLES[user.role]?.label || user.role;
    if (!window.confirm(`Send login invite to ${user.name} (${user.email})?\n\nRole: ${roleName}\n\nThis will:\n1. Create their authentication account\n2. Send a magic link to their email\n3. They can log in and access their assigned modules`)) return;
    try {
      const { error: authErr } = await supabase.auth.signInWithOtp({
        email: user.email,
        options: { data: { name: user.name, role: user.role } }
      });
      if (authErr) {
        alert("Failed to send invitation email to " + user.email + ": " + authErr.message + "\n\nPlease verify the email address and try again. No access records were created.");
        return;
      }
      // Auth succeeded — create membership as "invited" only (no app_users until they sign up)
      const { error: memErr } = await supabase.from("company_members").upsert([{
        company_id: companyId, user_email: (user.email || "").toLowerCase(), user_name: user.name,
        role: user.role, status: "invited", invited_by: "admin",
      }], { onConflict: "company_id,user_email" });
      if (memErr) { alert("Error creating invite: " + memErr.message); return; }
      addNotification("✉️", `Invite sent to ${user.name} (${roleName})`);
      logAudit("create", "team", "Invited " + user.name + " as " + roleName + ": " + user.email, user.id || "", "", "admin", companyId);
      alert(`Invite sent to ${user.email}!\n\nThey will receive a magic link to log in.\n\nIf they don't see it, they can use 'Forgot Password' on the login page to set their password.`);
    } catch (e) {
      alert("Error sending invite: " + e.message);
    }
      } finally { guardRelease("inviteUser"); }
  }

  // Get the effective pages for a user — custom_pages takes priority over role default
  function getEffectivePages(u) {
    if (u.custom_pages) {
      try { return JSON.parse(u.custom_pages); } catch { /* fall through */ }
    }
    return ROLES[u.role]?.pages || [];
  }

  if (loading) return <Spinner />;

  const isCustomizable = CUSTOMIZABLE_ROLES.includes(form.role);

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-2xl font-manrope font-bold text-slate-800">Team & Role Management</h2>
          <p className="text-xs text-slate-400 mt-0.5">Add team members and choose exactly which modules they can access</p>
        </div>
        <button onClick={startAdd} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-indigo-700">+ Add User</button>
      </div>

      {/* Role legend */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-5">
        {Object.entries(ROLES).map(([key, r]) => (
          <div key={key} className="bg-white rounded-3xl border border-indigo-50 p-3 text-center">
            <div className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold text-white mb-1 ${r.color}`}>{r.label}</div>
            <div className="text-xs text-slate-400">{key === "admin" ? "Full access" : key === "tenant" ? "Portal only" : "Customizable"}</div>
          </div>
        ))}
      </div>

      {/* Add / Edit form */}
      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-5 mb-5">
          <h3 className="font-semibold text-slate-700 mb-4">{editingUser ? `Edit — ${editingUser.name}` : "Add Team Member"}</h3>

          {/* Basic info */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <input
              placeholder="Full name"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm"
            />
            <input
              placeholder="Email address"
              value={form.email}
              onChange={e => setForm({ ...form, email: e.target.value })}
              disabled={!!editingUser}
              className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm disabled:bg-indigo-50/30 disabled:text-slate-400"
            />
            <select
              value={form.role}
              onChange={e => handleRoleChange(e.target.value)}
              className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm col-span-2"
            >
              {Object.entries(ROLES).filter(([k]) => k !== "tenant").map(([key, r]) => (
                <option key={key} value={key}>{r.label}</option>
              ))}
            </select>
          </div>

          {/* Module picker — only shown for customizable roles */}
          {isCustomizable && (
            <div className="border border-indigo-50 rounded-3xl p-4 bg-indigo-50/30">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold text-slate-700">Choose which modules this person can access</div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setCustomPages(ALL_NAV.map(n => n.id))}
                    className="text-xs text-indigo-600 hover:underline"
                  >Select all</button>
                  <span className="text-slate-300">|</span>
                  <button
                    onClick={() => setCustomPages([])}
                    className="text-xs text-slate-400 hover:underline"
                  >Clear all</button>
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {ALL_NAV.map(nav => {
                  const isOn = customPages.includes(nav.id);
                  return (
                    <button
                      key={nav.id}
                      onClick={() => togglePage(nav.id)}
                      className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition-all text-left ${
                        isOn
                          ? "bg-indigo-600 border-indigo-600 text-white"
                          : "bg-white border-indigo-100 text-slate-500 hover:border-indigo-300"
                      }`}
                    >
                      <span className="text-base">{nav.icon}</span>
                      <span>{nav.label}</span>
                      {isOn && <span className="ml-auto text-indigo-200 text-xs">✓</span>}
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 text-xs text-slate-400">
                {customPages.length} module{customPages.length !== 1 ? "s" : ""} selected
              </div>
            </div>
          )}

          {/* Admin / Maintenance / Tenant — fixed access notice */}
          {!isCustomizable && (
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-xs text-blue-700">
              <strong>{ROLES[form.role]?.label}</strong> has fixed access and cannot be customized.
              {form.role === "admin" && " Admins always have full access to everything."}
              {form.role === "maintenance" && " Maintenance staff can only see the Maintenance page."}
            </div>
          )}

          <div className="flex gap-2 mt-4">
            <button onClick={saveUser} className="bg-indigo-600 text-white text-sm px-5 py-2 rounded-2xl hover:bg-indigo-700">
              {editingUser ? "Save Changes" : "Add User"}
            </button>
            <button onClick={() => { setShowForm(false); setEditingUser(null); }} className="bg-slate-100 text-slate-500 text-sm px-4 py-2 rounded-lg">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* User list */}
      <div className="space-y-3">
        {users.map(u => {
          const effectivePages = getEffectivePages(u);
          return (
            <div key={u.id} className="bg-white rounded-3xl shadow-card border border-indigo-50 p-4">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold ${ROLES[u.role]?.color || "bg-slate-400"}`}>
                    {u.name?.[0]}
                  </div>
                  <div>
                    <div className="font-semibold text-slate-800 text-sm">{u.name}</div>
                    <div className="text-xs text-slate-400">{u.email}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-semibold text-white px-2 py-0.5 rounded-full ${ROLES[u.role]?.color || "bg-slate-400"}`}>
                    {ROLES[u.role]?.label}
                  </span>
                  <button onClick={() => inviteUser(u)} className="text-xs text-emerald-500 border border-emerald-200 px-2 py-1 rounded-lg hover:bg-emerald-50">
                    ✉️ Invite
                  </button>
                  <button onClick={() => startEdit(u)} className="text-xs text-indigo-500 border border-indigo-200 px-2 py-1 rounded-lg hover:bg-indigo-50">
                    ✏️ Edit
                  </button>
                  <button onClick={() => removeUser(u.id, u.name, u.email)} className="text-xs text-red-400 hover:text-red-600 border border-red-100 px-2 py-1 rounded-lg hover:bg-red-50">
                    Remove
                  </button>
                </div>
              </div>
              {/* Show their current module access */}
              <div className="mt-3 flex flex-wrap gap-1">
                {effectivePages.map(p => {
                  const nav = ALL_NAV.find(n => n.id === p);
                  return (
                    <span key={p} className="text-xs bg-indigo-50 text-indigo-700 border border-indigo-100 px-2 py-0.5 rounded-full">
                      {nav ? `${nav.icon} ${nav.label}` : p}
                    </span>
                  );
                })}
              </div>
              {u.custom_pages && (
                <div className="mt-1 text-xs text-slate-400">Custom access · {effectivePages.length} modules</div>
              )}
            </div>
          );
        })}
        {users.length === 0 && (
          <div className="text-center py-10 text-slate-400">No team members added yet. Click + Add User to get started.</div>
        )}
      </div>
    </div>
  );
}

// ============ MAIN APP ============
// ============ MOVE-OUT LIFECYCLE WIZARD ============
function MoveOutWizard({ addNotification, userProfile, userRole, companyId, setPage }) {
  const [step, setStep] = useState(1);
  const [tenants, setTenants] = useState([]);
  const [leases, setLeases] = useState([]);
  const [selectedTenant, setSelectedTenant] = useState(null);
  const [selectedLease, setSelectedLease] = useState(null);
  const [moveOutDate, setMoveOutDate] = useState(formatLocalDate(new Date()));
  const [checklist, setChecklist] = useState([]);
  const [deductions, setDeductions] = useState([]);
  const [newDeductionDesc, setNewDeductionDesc] = useState("");
  const [newDeductionAmt, setNewDeductionAmt] = useState("");
  const [arAction, setArAction] = useState("collect");
  const [processing, setProcessing] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [loading, setLoading] = useState(true);

  const defaultChecklist = ["Keys returned","All personal items removed","Unit cleaned","Walls patched/repaired","Appliances clean","Carpets cleaned","Final inspection done","Forwarding address collected","Utilities transferred","Security deposit review","Photos taken"];

  useEffect(() => {
    async function load() {
      const [t, l] = await Promise.all([
        supabase.from("tenants").select("*").eq("company_id", companyId).is("archived_at", null).eq("lease_status", "active"),
        supabase.from("leases").select("*").eq("company_id", companyId).eq("status", "active"),
      ]);
      setTenants(t.data || []);
      setLeases(l.data || []);
      setChecklist(defaultChecklist.map(item => ({ label: item, checked: false, notes: "" })));
      setLoading(false);
    }
    load();
  }, [companyId]);

  function selectTenant(tenantId) {
    const t = tenants.find(x => String(x.id) === String(tenantId));
    setSelectedTenant(t || null);
    if (t) {
      const lease = leases.find(l => l.tenant_name === t.name || l.property === t.property);
      setSelectedLease(lease || null);
    }
  }

  function addDeduction() {
    if (!newDeductionDesc.trim() || !newDeductionAmt || isNaN(Number(newDeductionAmt))) return;
    setDeductions([...deductions, { desc: newDeductionDesc.trim(), amount: Number(newDeductionAmt) }]);
    setNewDeductionDesc(""); setNewDeductionAmt("");
  }

  const depositAmount = safeNum(selectedLease?.security_deposit);
  const totalDeductions = deductions.reduce((s, d) => s + d.amount, 0);
  const depositReturn = Math.max(0, depositAmount - totalDeductions);
  const depositForfeited = Math.max(0, totalDeductions - depositAmount);
  const outstandingBalance = safeNum(selectedTenant?.balance);

  async function executeMoveOut() {
    if (!selectedTenant || !selectedLease) return;
    setProcessing(true);
    try {
      const cid = companyId;
      const tName = selectedTenant.name;
      const classId = await getPropertyClassId(selectedLease.property, cid);

      // 1. Process deposit return/deductions GL
      if (depositReturn > 0) {
        await autoPostJournalEntry({ companyId: cid, date: moveOutDate, description: `Security deposit returned — ${tName}`, reference: `DEP-RTN-${shortId()}`, property: selectedLease.property,
          lines: [
            { account_id: "2100", account_name: "Security Deposits Held", debit: depositReturn, credit: 0, class_id: classId, memo: `Deposit return — ${tName}` },
            { account_id: "1000", account_name: "Checking Account", debit: 0, credit: depositReturn, class_id: classId, memo: `Deposit refund to ${tName}` },
          ]
        });
      }
      if (totalDeductions > 0 && totalDeductions <= depositAmount) {
        await autoPostJournalEntry({ companyId: cid, date: moveOutDate, description: `Deposit deductions — ${tName}`, reference: `DEP-DED-${shortId()}`, property: selectedLease.property,
          lines: [
            { account_id: "2100", account_name: "Security Deposits Held", debit: totalDeductions, credit: 0, class_id: classId, memo: `Deductions: ${deductions.map(d => d.desc).join(", ")}` },
            { account_id: "4100", account_name: "Other Income", debit: 0, credit: totalDeductions, class_id: classId, memo: `Deposit forfeiture — ${tName}` },
          ]
        });
      }

      // 2. Handle outstanding AR
      if (arAction === "waive" && outstandingBalance > 0) {
        await autoPostJournalEntry({ companyId: cid, date: moveOutDate, description: `Bad debt write-off — ${tName}`, reference: `WOFF-${shortId()}`, property: selectedLease.property,
          lines: [
            { account_id: "5300", account_name: "Bad Debt Expense", debit: outstandingBalance, credit: 0, class_id: classId, memo: `Write-off at move-out — ${tName}` },
            { account_id: "1100", account_name: "Accounts Receivable", debit: 0, credit: outstandingBalance, class_id: classId, memo: `AR write-off — ${tName}` },
          ]
        });
        try { await supabase.rpc("update_tenant_balance", { p_tenant_id: selectedTenant.id, p_amount_change: -outstandingBalance }); } catch (e) { console.warn("Balance write-off:", e.message); }
      }

      // #7: Track completed steps for error recovery
      const completedSteps = [];
      try {
      // 3. Terminate lease
      const { error: leaseErr } = await supabase.from("leases").update({ status: "terminated", end_date: moveOutDate }).eq("id", selectedLease.id).eq("company_id", cid);
      if (leaseErr) throw new Error("Lease termination failed: " + leaseErr.message);
      completedSteps.push("lease_terminated");

      // 4. Deactivate autopay
      await supabase.from("autopay_schedules").update({ enabled: false }).eq("company_id", cid).eq("tenant", tName);
      completedSteps.push("autopay_disabled");

      // 5. Update tenant status
      const { error: tenantErr } = await supabase.from("tenants").update({ lease_status: "inactive", move_out: moveOutDate }).eq("id", selectedTenant.id).eq("company_id", cid);
      if (tenantErr) throw new Error("Tenant update failed: " + tenantErr.message + ". Completed: " + completedSteps.join(", "));
      completedSteps.push("tenant_inactive");

      // 6. Update property to vacant (#22: use empty string consistently)
      const { error: propErr } = await supabase.from("properties").update({ status: "vacant", tenant: "", lease_end: null }).eq("company_id", cid).eq("address", selectedLease.property);
      if (propErr) throw new Error("Property update failed: " + propErr.message + ". Completed: " + completedSteps.join(", "));
      completedSteps.push("property_vacant");
      } catch (stepErr) {
        alert("Move-out partially completed. " + stepErr.message + "\n\nPlease manually verify and fix any inconsistent state.");
        console.error("Move-out partial failure:", stepErr, "Completed steps:", completedSteps);
      }

      // 7. Create ledger entries
      if (depositReturn > 0) {
        await safeLedgerInsert({ company_id: cid, tenant: tName, property: selectedLease.property, date: moveOutDate, description: "Security deposit returned", amount: -depositReturn, type: "deposit_return", balance: 0 });
      }

      // 8. Save inspection checklist
      await supabase.from("inspections").insert([{ company_id: cid, property: selectedLease.property, type: "Move-Out", date: moveOutDate, inspector: userProfile?.name || "Admin", items: JSON.stringify(checklist), notes: `Move-out inspection for ${tName}` }]);

      // 9. Audit + notifications
      logAudit("update", "tenants", `Move-out completed: ${tName} from ${selectedLease.property}`, selectedTenant.id, userProfile?.email, userRole, cid);
      addNotification("🚪", `Move-out completed: ${tName} from ${selectedLease.property}`);
      if (selectedTenant.email) {
        queueNotification("deposit_returned", selectedTenant.email, { tenant: tName, returned: depositReturn, deducted: totalDeductions, property: selectedLease.property, moveOutDate }, cid);
      }

      setCompleted(true);
    } catch (e) {
      alert("Move-out failed: " + e.message);
    }
    setProcessing(false);
  }

  if (loading) return <Spinner />;

  if (completed) return (
    <div className="max-w-xl mx-auto text-center py-20">
      <div className="w-16 h-16 bg-emerald-50 text-emerald-600 rounded-3xl flex items-center justify-center mx-auto mb-4">
        <span className="material-icons-outlined text-3xl">check_circle</span>
      </div>
      <h2 className="text-2xl font-manrope font-bold text-slate-800 mb-2">Move-Out Complete</h2>
      <p className="text-slate-400 mb-6">All accounting entries posted, lease terminated, and property marked vacant.</p>
      <button onClick={() => setPage("dashboard")} className="bg-indigo-600 text-white px-6 py-2.5 rounded-2xl font-semibold hover:bg-indigo-700 transition-colors">Back to Dashboard</button>
    </div>
  );

  const steps = ["Select Tenant", "Inspection", "Deposit", "AR Settlement", "Confirm"];

  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="text-2xl font-manrope font-bold text-slate-800 mb-6">Move-Out Wizard</h2>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8">
        {steps.map((s, i) => (
          <div key={s} className="flex items-center gap-2 flex-1">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${i + 1 <= step ? "bg-indigo-600 text-white" : "bg-indigo-50 text-slate-400"}`}>{i + 1}</div>
            <span className={`text-xs font-medium hidden md:block ${i + 1 <= step ? "text-indigo-600" : "text-slate-400"}`}>{s}</span>
            {i < steps.length - 1 && <div className={`flex-1 h-0.5 ${i + 1 < step ? "bg-indigo-600" : "bg-indigo-50"}`} />}
          </div>
        ))}
      </div>

      {/* Step 1: Select Tenant */}
      {step === 1 && (
        <div className="bg-white rounded-3xl shadow-card border border-indigo-50 p-6">
          <h3 className="text-lg font-manrope font-bold text-slate-800 mb-4">Select Tenant & Move-Out Date</h3>
          <div className="space-y-4">
            <div>
              <label className="text-xs font-medium text-slate-400 uppercase tracking-widest block mb-1">Tenant</label>
              <select value={selectedTenant?.id || ""} onChange={e => selectTenant(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full">
                <option value="">Select tenant...</option>
                {tenants.map(t => <option key={t.id} value={t.id}>{t.name} — {t.property}</option>)}
              </select>
            </div>
            {selectedTenant && (
              <>
                <div>
                  <label className="text-xs font-medium text-slate-400 uppercase tracking-widest block mb-1">Move-Out Date</label>
                  <input type="date" value={moveOutDate} onChange={e => setMoveOutDate(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" />
                </div>
                <div className="bg-indigo-50/30 rounded-2xl p-4 space-y-2 text-sm">
                  <div className="flex justify-between"><span className="text-slate-400">Property</span><span className="font-medium text-slate-700">{selectedTenant.property}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Monthly Rent</span><span className="font-medium text-slate-700">${safeNum(selectedTenant.rent)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Balance</span><span className={`font-bold ${outstandingBalance > 0 ? "text-red-600" : "text-emerald-600"}`}>${outstandingBalance.toFixed(2)}</span></div>
                  {selectedLease && <div className="flex justify-between"><span className="text-slate-400">Security Deposit</span><span className="font-medium text-slate-700">${depositAmount.toFixed(2)}</span></div>}
                </div>
              </>
            )}
          </div>
          <div className="flex justify-end mt-6">
            <button disabled={!selectedTenant} onClick={() => setStep(2)} className="bg-indigo-600 text-white px-6 py-2.5 rounded-2xl font-semibold hover:bg-indigo-700 disabled:opacity-40 transition-colors">Next →</button>
          </div>
        </div>
      )}

      {/* Step 2: Inspection Checklist */}
      {step === 2 && (
        <div className="bg-white rounded-3xl shadow-card border border-indigo-50 p-6">
          <h3 className="text-lg font-manrope font-bold text-slate-800 mb-4">Move-Out Inspection</h3>
          <div className="space-y-2">
            {checklist.map((item, i) => (
              <div key={i} className={`flex items-center gap-3 p-3 rounded-2xl border cursor-pointer transition-colors ${item.checked ? "bg-emerald-50 border-emerald-200" : "bg-white border-indigo-50 hover:bg-indigo-50/30"}`} onClick={() => { const c = [...checklist]; c[i] = { ...c[i], checked: !c[i].checked }; setChecklist(c); }}>
                <span className={`material-icons-outlined text-lg ${item.checked ? "text-emerald-600" : "text-slate-300"}`}>{item.checked ? "check_circle" : "radio_button_unchecked"}</span>
                <span className={`flex-1 text-sm ${item.checked ? "text-emerald-700 font-medium" : "text-slate-500"}`}>{item.label}</span>
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-6">
            <button onClick={() => setStep(1)} className="text-slate-400 px-4 py-2 rounded-2xl hover:bg-indigo-50/30 transition-colors">← Back</button>
            <button onClick={() => setStep(3)} className="bg-indigo-600 text-white px-6 py-2.5 rounded-2xl font-semibold hover:bg-indigo-700 transition-colors">Next →</button>
          </div>
        </div>
      )}

      {/* Step 3: Deposit Accounting */}
      {step === 3 && (
        <div className="bg-white rounded-3xl shadow-card border border-indigo-50 p-6">
          <h3 className="text-lg font-manrope font-bold text-slate-800 mb-4">Security Deposit Settlement</h3>
          <div className="bg-indigo-50/30 rounded-2xl p-4 mb-4">
            <div className="flex justify-between text-sm"><span className="text-slate-400">Original Deposit</span><span className="font-bold text-slate-700">${depositAmount.toFixed(2)}</span></div>
          </div>
          <h4 className="text-sm font-semibold text-slate-500 mb-2">Deductions</h4>
          {deductions.map((d, i) => (
            <div key={i} className="flex items-center justify-between py-2 border-b border-indigo-50/50">
              <span className="text-sm text-slate-700">{d.desc}</span>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-red-600">-${d.amount.toFixed(2)}</span>
                <button onClick={() => setDeductions(deductions.filter((_, j) => j !== i))} className="text-slate-300 hover:text-red-500"><span className="material-icons-outlined text-sm">close</span></button>
              </div>
            </div>
          ))}
          <div className="flex gap-2 mt-3">
            <input placeholder="Description (e.g., Wall damage)" value={newDeductionDesc} onChange={e => setNewDeductionDesc(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm flex-1" />
            <input placeholder="$" type="number" value={newDeductionAmt} onChange={e => setNewDeductionAmt(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-24" />
            <button onClick={addDeduction} className="bg-indigo-600 text-white px-3 py-2 rounded-2xl text-sm font-semibold">Add</button>
          </div>
          <div className="bg-emerald-50 rounded-2xl p-4 mt-4 space-y-1">
            <div className="flex justify-between text-sm"><span className="text-slate-400">Total Deductions</span><span className="font-semibold text-red-600">-${totalDeductions.toFixed(2)}</span></div>
            <div className="flex justify-between text-sm font-bold"><span className="text-emerald-700">Return to Tenant</span><span className="text-emerald-700">${depositReturn.toFixed(2)}</span></div>
          </div>
          <div className="flex justify-between mt-6">
            <button onClick={() => setStep(2)} className="text-slate-400 px-4 py-2 rounded-2xl hover:bg-indigo-50/30 transition-colors">← Back</button>
            <button onClick={() => setStep(4)} className="bg-indigo-600 text-white px-6 py-2.5 rounded-2xl font-semibold hover:bg-indigo-700 transition-colors">Next →</button>
          </div>
        </div>
      )}

      {/* Step 4: AR Settlement */}
      {step === 4 && (
        <div className="bg-white rounded-3xl shadow-card border border-indigo-50 p-6">
          <h3 className="text-lg font-manrope font-bold text-slate-800 mb-4">Outstanding Balance</h3>
          <div className={`rounded-2xl p-4 mb-4 ${outstandingBalance > 0 ? "bg-red-50" : "bg-emerald-50"}`}>
            <div className="text-sm text-slate-400">Current Balance</div>
            <div className={`text-2xl font-manrope font-bold ${outstandingBalance > 0 ? "text-red-600" : "text-emerald-600"}`}>${outstandingBalance.toFixed(2)}</div>
          </div>
          {outstandingBalance > 0 && (
            <div className="space-y-2">
              {[
                { value: "collect", label: "Keep for Collection", desc: "Balance remains on tenant record for future collection", icon: "account_balance" },
                { value: "waive", label: "Write Off (Bad Debt)", desc: "Post as bad debt expense and zero out balance", icon: "money_off" },
                { value: "collections", label: "Send to Collections", desc: "Mark tenant for external collections agency", icon: "gavel" },
              ].map(opt => (
                <div key={opt.value} onClick={() => setArAction(opt.value)} className={`flex items-center gap-3 p-4 rounded-2xl border cursor-pointer transition-all ${arAction === opt.value ? "border-indigo-300 bg-indigo-50" : "border-indigo-50 hover:border-indigo-200"}`}>
                  <span className={`material-icons-outlined ${arAction === opt.value ? "text-indigo-600" : "text-slate-400"}`}>{opt.icon}</span>
                  <div><div className="text-sm font-semibold text-slate-700">{opt.label}</div><div className="text-xs text-slate-400">{opt.desc}</div></div>
                </div>
              ))}
            </div>
          )}
          {outstandingBalance <= 0 && <p className="text-sm text-emerald-600 font-medium">No outstanding balance — tenant is settled.</p>}
          <div className="flex justify-between mt-6">
            <button onClick={() => setStep(3)} className="text-slate-400 px-4 py-2 rounded-2xl hover:bg-indigo-50/30 transition-colors">← Back</button>
            <button onClick={() => setStep(5)} className="bg-indigo-600 text-white px-6 py-2.5 rounded-2xl font-semibold hover:bg-indigo-700 transition-colors">Next →</button>
          </div>
        </div>
      )}

      {/* Step 5: Confirm & Execute */}
      {step === 5 && (
        <div className="bg-white rounded-3xl shadow-card border border-indigo-50 p-6">
          <h3 className="text-lg font-manrope font-bold text-slate-800 mb-4">Confirm Move-Out</h3>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between py-2 border-b border-indigo-50"><span className="text-slate-400">Tenant</span><span className="font-semibold text-slate-700">{selectedTenant?.name}</span></div>
            <div className="flex justify-between py-2 border-b border-indigo-50"><span className="text-slate-400">Property</span><span className="font-semibold text-slate-700">{selectedLease?.property}</span></div>
            <div className="flex justify-between py-2 border-b border-indigo-50"><span className="text-slate-400">Move-Out Date</span><span className="font-semibold text-slate-700">{moveOutDate}</span></div>
            <div className="flex justify-between py-2 border-b border-indigo-50"><span className="text-slate-400">Inspection Items</span><span className="font-semibold text-emerald-600">{checklist.filter(c => c.checked).length}/{checklist.length} checked</span></div>
            <div className="flex justify-between py-2 border-b border-indigo-50"><span className="text-slate-400">Deposit Return</span><span className="font-semibold text-emerald-600">${depositReturn.toFixed(2)}</span></div>
            {totalDeductions > 0 && <div className="flex justify-between py-2 border-b border-indigo-50"><span className="text-slate-400">Deductions</span><span className="font-semibold text-red-600">-${totalDeductions.toFixed(2)}</span></div>}
            <div className="flex justify-between py-2 border-b border-indigo-50"><span className="text-slate-400">AR Action</span><span className="font-semibold text-slate-700 capitalize">{outstandingBalance > 0 ? arAction.replace("_", " ") : "Settled"}</span></div>
          </div>
          <div className="bg-amber-50 rounded-2xl p-3 mt-4 text-xs text-amber-700">
            <span className="material-icons-outlined text-sm align-middle mr-1">warning</span>
            This will terminate the lease, update property to vacant, and post all accounting entries. This cannot be undone.
          </div>
          <div className="flex justify-between mt-6">
            <button onClick={() => setStep(4)} className="text-slate-400 px-4 py-2 rounded-2xl hover:bg-indigo-50/30 transition-colors">← Back</button>
            <button onClick={executeMoveOut} disabled={processing} className="bg-red-600 text-white px-6 py-2.5 rounded-2xl font-semibold hover:bg-red-700 disabled:opacity-40 transition-colors">
              {processing ? "Processing..." : "Execute Move-Out"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============ EVICTION WORKFLOW ============
const EVICTION_STAGES = [
  { id: "notice", label: "Notice to Cure/Quit", icon: "mail", color: "bg-amber-500" },
  { id: "cure_period", label: "Cure Period", icon: "schedule", color: "bg-orange-500" },
  { id: "filing", label: "Court Filing", icon: "gavel", color: "bg-red-400" },
  { id: "hearing", label: "Hearing", icon: "event", color: "bg-red-500" },
  { id: "judgment", label: "Judgment", icon: "description", color: "bg-red-600" },
  { id: "writ", label: "Writ of Restitution", icon: "assignment", color: "bg-red-700" },
  { id: "lockout", label: "Lockout", icon: "lock", color: "bg-red-800" },
  { id: "closed", label: "Closed", icon: "check_circle", color: "bg-slate-500" },
];

function EvictionWorkflow({ addNotification, userProfile, userRole, companyId }) {
  const [cases, setCases] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [selectedCase, setSelectedCase] = useState(null);
  const [filterStage, setFilterStage] = useState("all");
  const [evSearch, setEvSearch] = useState("");
  const [form, setForm] = useState({ tenant_id: "", tenant_name: "", property: "", reason: "non_payment", notice_type: "pay_or_quit", notice_days: "30", notes: "" });
  const [stageNote, setStageNote] = useState("");
  const [stageCost, setStageCost] = useState("");
  const [stageDate, setStageDate] = useState(formatLocalDate(new Date()));

  useEffect(() => { fetchCases(); fetchTenants(); }, [companyId]);

  async function fetchTenants() {
    const { data } = await supabase.from("tenants").select("id, name, property, lease_status, balance").eq("company_id", companyId).is("archived_at", null);
    setTenants(data || []);
  }

  async function fetchCases() {
    const { data } = await companyQuery("eviction_cases", companyId).order("created_at", { ascending: false });
    setCases(data || []);
    setLoading(false);
  }

  async function createCase() {
    if (!guardSubmit("createEviction")) return;
    try {
      if (!form.tenant_name || !form.property) { alert("Select a tenant."); return; }
      const noticeDate = new Date();
      noticeDate.setDate(noticeDate.getDate() + parseInt(form.notice_days));
      const caseData = {
        tenant_id: form.tenant_id,
        tenant_name: form.tenant_name,
        property: form.property,
        reason: form.reason,
        notice_type: form.notice_type,
        notice_days: parseInt(form.notice_days),
        notice_date: formatLocalDate(new Date()),
        cure_deadline: formatLocalDate(noticeDate),
        current_stage: "notice",
        status: "active",
        notes: form.notes,
        stage_history: JSON.stringify([{
          stage: "notice",
          date: formatLocalDate(new Date()),
          note: `${form.notice_type.replace(/_/g, " ")} notice issued — ${form.notice_days} day cure period`,
          cost: 0,
          by: userProfile?.email,
        }]),
        total_costs: 0,
      };
      const { error } = await companyInsert("eviction_cases", caseData, companyId);
      if (error) { alert("Error creating eviction case: " + error.message); return; }
      // Update tenant status to notice
      if (form.tenant_id) {
        await supabase.from("tenants").update({ lease_status: "notice", move_out: formatLocalDate(noticeDate) }).eq("id", form.tenant_id).eq("company_id", companyId);
      }
      // #8: Also update lease status to notice
      await supabase.from("leases").update({ status: "notice" }).eq("company_id", companyId).eq("tenant_name", form.tenant_name).eq("status", "active");
      addNotification("⚖️", `Eviction case started for ${form.tenant_name}`);
      logAudit("create", "evictions", `Eviction case: ${form.tenant_name} at ${form.property} — ${form.reason}`, "", userProfile?.email, userRole, companyId);
      setShowForm(false);
      setForm({ tenant_id: "", tenant_name: "", property: "", reason: "non_payment", notice_type: "pay_or_quit", notice_days: "30", notes: "" });
      fetchCases();
      fetchTenants();
    } finally { guardRelease("createEviction"); }
  }

  async function advanceStage(evCase, nextStage) {
    if (!guardSubmit("advanceEviction")) return;
    try {
      const history = JSON.parse(evCase.stage_history || "[]");
      history.push({
        stage: nextStage,
        date: stageDate || formatLocalDate(new Date()),
        note: stageNote,
        cost: safeNum(stageCost),
        by: userProfile?.email,
      });
      const newCosts = safeNum(evCase.total_costs) + safeNum(stageCost);
      const updates = {
        current_stage: nextStage,
        stage_history: JSON.stringify(history),
        total_costs: newCosts,
      };
      if (nextStage === "closed") updates.status = "closed";
      if (nextStage === "filing") updates.filing_date = stageDate || formatLocalDate(new Date());
      if (nextStage === "hearing") updates.hearing_date = stageDate || formatLocalDate(new Date());
      if (nextStage === "judgment") updates.judgment_date = stageDate || formatLocalDate(new Date());
      if (nextStage === "lockout") updates.lockout_date = stageDate || formatLocalDate(new Date());

      const { error } = await supabase.from("eviction_cases").update(updates).eq("id", evCase.id).eq("company_id", companyId);
      if (error) { alert("Error updating case: " + error.message); return; }

      // Post legal costs to accounting if any
      if (safeNum(stageCost) > 0) {
        const classId = await getPropertyClassId(evCase.property, companyId);
        await autoPostJournalEntry({
          companyId, date: stageDate || formatLocalDate(new Date()),
          description: `Eviction cost — ${evCase.tenant_name} — ${nextStage.replace(/_/g, " ")}`,
          reference: `EVICT-${shortId()}`, property: evCase.property,
          lines: [
            { account_id: "5300", account_name: "Legal & Eviction Costs", debit: safeNum(stageCost), credit: 0, class_id: classId, memo: `${nextStage}: ${stageNote || "Eviction expense"}` },
            { account_id: "1000", account_name: "Checking Account", debit: 0, credit: safeNum(stageCost), class_id: classId, memo: `Eviction: ${evCase.tenant_name}` },
          ]
        });
      }

      addNotification("⚖️", `Eviction: ${evCase.tenant_name} → ${nextStage.replace(/_/g, " ")}`);
      logAudit("update", "evictions", `Eviction stage: ${nextStage} for ${evCase.tenant_name}`, evCase.id, userProfile?.email, userRole, companyId);
      setStageNote(""); setStageCost(""); setStageDate(formatLocalDate(new Date()));
      fetchCases();
      // Refresh selected case
      const { data: refreshed } = await supabase.from("eviction_cases").select("*").eq("id", evCase.id).eq("company_id", companyId).maybeSingle();
      if (refreshed) setSelectedCase(refreshed);
    } finally { guardRelease("advanceEviction"); }
  }

  async function closeCase(evCase, outcome) {
    if (!window.confirm(`Close this eviction case as "${outcome}"?\n\n${outcome === "completed" ? "This will also: set tenant to inactive, mark property vacant, terminate lease, and disable autopay." : outcome === "tenant_cured" ? "Tenant status will return to active." : "No tenant/property changes will be made."}`)) return;
    const history = JSON.parse(evCase.stage_history || "[]");
    history.push({ stage: "closed", date: formatLocalDate(new Date()), note: `Case closed — ${outcome}`, cost: 0, by: userProfile?.email });
    await supabase.from("eviction_cases").update({ status: "closed", current_stage: "closed", outcome, stage_history: JSON.stringify(history) }).eq("id", evCase.id).eq("company_id", companyId);

    // #2: Cascade updates based on outcome
    if (outcome === "completed") {
      // Eviction complete — tenant out, property vacant
      if (evCase.tenant_id) {
        await supabase.from("tenants").update({ lease_status: "inactive" }).eq("id", evCase.tenant_id).eq("company_id", companyId);
      }
      await supabase.from("tenants").update({ lease_status: "inactive" }).eq("company_id", companyId).ilike("name", evCase.tenant_name).eq("property", evCase.property);
      await supabase.from("properties").update({ status: "vacant", tenant: "", lease_end: null }).eq("company_id", companyId).eq("address", evCase.property);
      await supabase.from("leases").update({ status: "terminated" }).eq("company_id", companyId).eq("tenant_name", evCase.tenant_name).eq("status", "active");
      await supabase.from("autopay_schedules").update({ enabled: false }).eq("company_id", companyId).eq("tenant", evCase.tenant_name);
    } else if (outcome === "tenant_cured") {
      // Tenant cured — restore to active
      if (evCase.tenant_id) {
        await supabase.from("tenants").update({ lease_status: "active" }).eq("id", evCase.tenant_id).eq("company_id", companyId);
      }
      await supabase.from("leases").update({ status: "active" }).eq("company_id", companyId).eq("tenant_name", evCase.tenant_name).eq("status", "notice");
    }
    // settled/dismissed: no cascade — user handles manually

    addNotification("⚖️", `Eviction closed: ${evCase.tenant_name} — ${outcome}`);
    logAudit("update", "evictions", `Eviction closed (${outcome}): ${evCase.tenant_name}${outcome === "completed" ? " — tenant inactive, property vacant, lease terminated" : ""}`, evCase.id, userProfile?.email, userRole, companyId);
    setSelectedCase(null);
    fetchCases();
    fetchTenants();
  }

  if (loading) return <Spinner />;

  const stageIdx = (stage) => EVICTION_STAGES.findIndex(s => s.id === stage);
  const filtered = cases.filter(c => {
    if (filterStage !== "all" && c.current_stage !== filterStage && (filterStage !== "active" || c.status !== "active") && (filterStage !== "closed" || c.status !== "closed")) return false;
    if (evSearch) {
      const q = evSearch.toLowerCase();
      if (!c.tenant_name?.toLowerCase().includes(q) && !c.property?.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const activeCases = cases.filter(c => c.status === "active");

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-2xl font-manrope font-bold text-slate-800">Eviction Tracker</h2>
          <p className="text-sm text-slate-400">Manage eviction cases from notice to resolution</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="bg-red-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-red-700">+ New Case</button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <StatCard label="Active Cases" value={activeCases.length} color="text-red-600" />
        <StatCard label="In Court" value={activeCases.filter(c => ["filing","hearing","judgment","writ"].includes(c.current_stage)).length} color="text-orange-600" />
        <StatCard label="Total Costs" value={formatCurrency(cases.reduce((s, c) => s + safeNum(c.total_costs), 0))} color="text-slate-700" />
        <StatCard label="Closed" value={cases.filter(c => c.status === "closed").length} color="text-slate-500" />
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-red-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-slate-700 mb-3">Start Eviction Case</h3>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-xs font-medium text-slate-400 mb-1 block">Tenant *</label>
              <select value={form.tenant_id} onChange={e => { const t = tenants.find(x => x.id === e.target.value); if (t) setForm({ ...form, tenant_id: t.id, tenant_name: t.name, property: t.property || "" }); }} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full">
                <option value="">Select tenant...</option>
                {tenants.filter(t => t.lease_status === "active" || t.lease_status === "notice").map(t => <option key={t.id} value={t.id}>{t.name} — {t.property}{safeNum(t.balance) > 0 ? ` (owes ${formatCurrency(t.balance)})` : ""}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-400 mb-1 block">Reason</label>
              <select value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full">
                <option value="non_payment">Non-Payment of Rent</option>
                <option value="lease_violation">Lease Violation</option>
                <option value="holdover">Holdover (Expired Lease)</option>
                <option value="nuisance">Nuisance / Disturbance</option>
                <option value="property_damage">Property Damage</option>
                <option value="unauthorized_occupant">Unauthorized Occupant</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-400 mb-1 block">Notice Type</label>
              <select value={form.notice_type} onChange={e => setForm({ ...form, notice_type: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full">
                <option value="pay_or_quit">Pay or Quit</option>
                <option value="cure_or_quit">Cure or Quit</option>
                <option value="unconditional_quit">Unconditional Quit</option>
                <option value="notice_to_vacate">Notice to Vacate</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-400 mb-1 block">Cure Period (days)</label>
              <select value={form.notice_days} onChange={e => setForm({ ...form, notice_days: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full">
                <option value="3">3 days</option><option value="5">5 days</option><option value="7">7 days</option><option value="10">10 days</option><option value="14">14 days</option><option value="30">30 days</option><option value="60">60 days</option>
              </select>
            </div>
            <div className="col-span-2"><label className="text-xs font-medium text-slate-400 mb-1 block">Notes</label><textarea placeholder="Additional context or details..." value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" rows={2} /></div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={createCase} className="bg-red-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-red-700">Start Case</button>
            <button onClick={() => setShowForm(false)} className="bg-slate-100 text-slate-500 text-sm px-4 py-2 rounded-2xl">Cancel</button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <input placeholder="Search tenant or property..." value={evSearch} onChange={e => setEvSearch(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm flex-1 min-w-40" />
        <select value={filterStage} onChange={e => setFilterStage(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
          <option value="all">All Cases</option>
          <option value="active">Active Only</option>
          <option value="closed">Closed Only</option>
          {EVICTION_STAGES.filter(s => s.id !== "closed").map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>

      {/* Case Detail Panel */}
      {selectedCase && (
        <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex justify-end">
          <div className="bg-white w-full max-w-xl h-full flex flex-col shadow-2xl overflow-y-auto">
            <div className="bg-gradient-to-r from-red-600 to-red-800 p-6 text-white">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold">{selectedCase.tenant_name}</h2>
                  <div className="text-sm opacity-80">{selectedCase.property}</div>
                  <div className="text-xs opacity-60 mt-1">{selectedCase.reason?.replace(/_/g, " ")} · {selectedCase.notice_type?.replace(/_/g, " ")}</div>
                </div>
                <button onClick={() => setSelectedCase(null)} className="text-white/70 hover:text-white text-2xl">✕</button>
              </div>
              <div className="grid grid-cols-3 gap-2 mt-4">
                <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs opacity-70">Stage</div><div className="text-sm font-bold capitalize">{selectedCase.current_stage?.replace(/_/g, " ")}</div></div>
                <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs opacity-70">Costs</div><div className="text-sm font-bold">{formatCurrency(selectedCase.total_costs)}</div></div>
                <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs opacity-70">Status</div><div className="text-sm font-bold capitalize">{selectedCase.status}</div></div>
              </div>
            </div>

            {/* Stage Progress */}
            <div className="px-6 py-4 border-b border-indigo-50">
              <div className="text-xs font-semibold text-slate-400 uppercase mb-3">Progress</div>
              <div className="flex items-center gap-1">
                {EVICTION_STAGES.map((s, i) => {
                  const currentIdx = stageIdx(selectedCase.current_stage);
                  const isComplete = i < currentIdx;
                  const isCurrent = i === currentIdx;
                  return (
                    <div key={s.id} className="flex-1">
                      <div className={`h-2 rounded-full ${isComplete ? "bg-red-500" : isCurrent ? "bg-red-300" : "bg-slate-100"}`} />
                      <div className={`text-center mt-1 text-[10px] ${isCurrent ? "text-red-600 font-bold" : isComplete ? "text-red-400" : "text-slate-300"}`}>{s.label.split(" ")[0]}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Key Dates */}
            <div className="px-6 py-4 border-b border-indigo-50">
              <div className="text-xs font-semibold text-slate-400 uppercase mb-2">Key Dates</div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div><span className="text-slate-400 text-xs block">Notice Sent</span><span className="font-semibold text-slate-700">{selectedCase.notice_date || "—"}</span></div>
                <div><span className="text-slate-400 text-xs block">Cure Deadline</span><span className="font-semibold text-red-600">{selectedCase.cure_deadline || "—"}</span></div>
                {selectedCase.filing_date && <div><span className="text-slate-400 text-xs block">Filed</span><span className="font-semibold text-slate-700">{selectedCase.filing_date}</span></div>}
                {selectedCase.hearing_date && <div><span className="text-slate-400 text-xs block">Hearing</span><span className="font-semibold text-slate-700">{selectedCase.hearing_date}</span></div>}
                {selectedCase.judgment_date && <div><span className="text-slate-400 text-xs block">Judgment</span><span className="font-semibold text-slate-700">{selectedCase.judgment_date}</span></div>}
                {selectedCase.lockout_date && <div><span className="text-slate-400 text-xs block">Lockout</span><span className="font-semibold text-slate-700">{selectedCase.lockout_date}</span></div>}
              </div>
            </div>

            {/* Stage History */}
            <div className="px-6 py-4 border-b border-indigo-50">
              <div className="text-xs font-semibold text-slate-400 uppercase mb-3">Timeline</div>
              <div className="space-y-3">
                {JSON.parse(selectedCase.stage_history || "[]").slice().reverse().map((h, i) => {
                  const stg = EVICTION_STAGES.find(s => s.id === h.stage);
                  return (
                    <div key={i} className="flex gap-3">
                      <div className={`w-8 h-8 rounded-full ${stg?.color || "bg-slate-400"} flex items-center justify-center shrink-0`}>
                        <span className="material-icons-outlined text-white text-sm">{stg?.icon || "info"}</span>
                      </div>
                      <div className="flex-1">
                        <div className="text-sm font-semibold text-slate-800 capitalize">{h.stage?.replace(/_/g, " ")}</div>
                        <div className="text-xs text-slate-400">{h.date} · {h.by}</div>
                        {h.note && <div className="text-xs text-slate-500 mt-0.5">{h.note}</div>}
                        {safeNum(h.cost) > 0 && <div className="text-xs text-red-500 font-semibold mt-0.5">Cost: {formatCurrency(h.cost)}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Advance Stage */}
            {selectedCase.status === "active" && (
              <div className="px-6 py-4 border-b border-indigo-50">
                <div className="text-xs font-semibold text-slate-400 uppercase mb-3">Advance to Next Stage</div>
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div><label className="text-xs text-slate-400 block mb-1">Date</label><input type="date" value={stageDate} onChange={e => setStageDate(e.target.value)} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
                    <div><label className="text-xs text-slate-400 block mb-1">Cost ($)</label><input type="number" value={stageCost} onChange={e => setStageCost(e.target.value)} placeholder="0.00" className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
                  </div>
                  <div><label className="text-xs text-slate-400 block mb-1">Notes</label><input value={stageNote} onChange={e => setStageNote(e.target.value)} placeholder="Court case #, attorney notes, details..." className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm w-full" /></div>
                  <div className="flex gap-2 flex-wrap">
                    {EVICTION_STAGES.filter(s => stageIdx(s.id) === stageIdx(selectedCase.current_stage) + 1).map(nextS => (
                      <button key={nextS.id} onClick={() => advanceStage(selectedCase, nextS.id)} className={`text-xs text-white px-4 py-2 rounded-lg font-medium ${nextS.color} hover:opacity-90`}>
                        <span className="material-icons-outlined text-sm align-middle mr-1">{nextS.icon}</span>{nextS.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="px-6 py-4">
              <div className="text-xs font-semibold text-slate-400 uppercase mb-3">Case Actions</div>
              <div className="flex gap-2 flex-wrap">
                {selectedCase.status === "active" && (
                  <>
                    <button onClick={() => closeCase(selectedCase, "tenant_cured")} className="text-xs bg-green-100 text-green-700 px-3 py-2 rounded-lg hover:bg-green-200 font-medium">Tenant Cured</button>
                    <button onClick={() => closeCase(selectedCase, "settled")} className="text-xs bg-blue-100 text-blue-700 px-3 py-2 rounded-lg hover:bg-blue-200 font-medium">Settled / Agreement</button>
                    <button onClick={() => closeCase(selectedCase, "dismissed")} className="text-xs bg-slate-100 text-slate-700 px-3 py-2 rounded-lg hover:bg-slate-200 font-medium">Dismissed</button>
                    <button onClick={() => closeCase(selectedCase, "completed")} className="text-xs bg-red-100 text-red-700 px-3 py-2 rounded-lg hover:bg-red-200 font-medium">Eviction Complete</button>
                  </>
                )}
              </div>
            </div>

            {selectedCase.notes && (
              <div className="px-6 py-4 border-t border-indigo-50">
                <div className="text-xs font-semibold text-slate-400 uppercase mb-2">Case Notes</div>
                <p className="text-sm text-slate-600">{selectedCase.notes}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Cases List */}
      <div className="space-y-3">
        {filtered.map(c => {
          const currentStage = EVICTION_STAGES.find(s => s.id === c.current_stage);
          const curIdx = stageIdx(c.current_stage);
          const daysActive = Math.ceil((new Date() - new Date(c.created_at)) / 86400000);
          return (
            <div key={c.id} onClick={() => setSelectedCase(c)} className="bg-white rounded-3xl shadow-card border border-indigo-50 p-4 cursor-pointer hover:border-red-200 hover:shadow-md transition-all">
              <div className="flex justify-between items-start">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`w-6 h-6 rounded-full ${currentStage?.color || "bg-slate-400"} flex items-center justify-center`}>
                      <span className="material-icons-outlined text-white text-xs">{currentStage?.icon || "info"}</span>
                    </span>
                    <span className="font-semibold text-slate-800">{c.tenant_name}</span>
                    {c.status === "closed" && <span className="text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full">Closed{c.outcome ? ` — ${c.outcome.replace(/_/g, " ")}` : ""}</span>}
                  </div>
                  <div className="text-xs text-slate-400">{c.property} · {c.reason?.replace(/_/g, " ")}</div>
                </div>
                <div className="text-right">
                  <div className={`text-xs font-semibold capitalize px-2.5 py-1 rounded-full ${c.status === "active" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-500"}`}>{currentStage?.label || c.current_stage}</div>
                  <div className="text-xs text-slate-400 mt-1">{daysActive}d active</div>
                </div>
              </div>
              {/* Mini progress bar */}
              <div className="flex gap-0.5 mt-3">
                {EVICTION_STAGES.map((s, i) => (
                  <div key={s.id} className={`h-1.5 flex-1 rounded-full ${i < curIdx ? "bg-red-400" : i === curIdx ? "bg-red-200" : "bg-slate-100"}`} />
                ))}
              </div>
              <div className="flex gap-4 mt-2 text-xs text-slate-400">
                <span>Notice: {c.notice_date}</span>
                <span>Cure by: {c.cure_deadline}</span>
                {safeNum(c.total_costs) > 0 && <span className="text-red-500">Costs: {formatCurrency(c.total_costs)}</span>}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && <div className="text-center py-12 text-slate-400">No eviction cases{filterStage !== "all" ? " matching filter" : ""}. Click + New Case to start one.</div>}
      </div>
    </div>
  );
}

const pageComponents = {
  dashboard: Dashboard,
  properties: Properties,
  tenants: Tenants,
  payments: Payments,
  maintenance: Maintenance,
  utilities: Utilities,
  accounting: Accounting,
  documents: Documents,
  inspections: Inspections,
  autopay: Autopay,
  hoa: HOAPayments,
  audittrail: AuditTrail,
  leases: LeaseManagement,
  vendors: VendorManagement,
  owners: OwnerManagement,
  notifications: EmailNotifications,
  roles: RoleManagement,
  moveout: MoveOutWizard,
  evictions: EvictionWorkflow,
  tenant_portal: TenantPortal,
  owner_portal: OwnerPortal,
  archive: ArchivePage,
};

// ============ AUDIT TRAIL (Admin Panel) ============
function AuditTrail({ companyId }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterModule, setFilterModule] = useState("all");
  const [filterAction, setFilterAction] = useState("all");
  const [filterUser, setFilterUser] = useState("");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  useEffect(() => { fetchLogs(); }, [companyId]);

  async function fetchLogs() {
    setLoading(true);
    const { data } = await supabase.from("audit_trail").select("*").eq("company_id", companyId).order("created_at", { ascending: false }).limit(500);
    setLogs(data || []);
    setLoading(false);
  }

  const modules = [...new Set(logs.map(l => l.module))].sort();
  const actions = [...new Set(logs.map(l => l.action))].sort();
  const users = [...new Set(logs.map(l => l.user_email))].sort();

  const filtered = logs.filter(l =>
    (filterModule === "all" || l.module === filterModule) &&
    (filterAction === "all" || l.action === filterAction) &&
    (!filterUser || l.user_email.toLowerCase().includes(filterUser.toLowerCase()))
  );

  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  const actionColors = {
    create: "bg-emerald-100 text-emerald-700",
    update: "bg-blue-100 text-blue-700",
    delete: "bg-red-100 text-red-700",
    request: "bg-amber-100 text-amber-700",
    approve: "bg-emerald-100 text-emerald-700",
    reject: "bg-red-100 text-red-700",
  };

  const moduleIcons = {
    properties: "🏠", tenants: "👤", payments: "💳", maintenance: "🔧",
    utilities: "⚡", accounting: "📊", documents: "📄", inspections: "🔍",
    autopay: "🔁",
  };

  if (loading) return <Spinner />;

  return (
    <div>
      <h2 className="text-2xl font-manrope font-bold text-slate-800 mb-1">Audit Trail</h2>
      <p className="text-sm text-slate-400 mb-4">Complete activity log across all modules</p>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <select value={filterModule} onChange={e => { setFilterModule(e.target.value); setPage(0); }} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
          <option value="all">All Modules</option>
          {modules.map(m => <option key={m} value={m}>{moduleIcons[m] || "📌"} {m}</option>)}
        </select>
        <select value={filterAction} onChange={e => { setFilterAction(e.target.value); setPage(0); }} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm">
          <option value="all">All Actions</option>
          {actions.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <input placeholder="Filter by user email..." value={filterUser} onChange={e => { setFilterUser(e.target.value); setPage(0); }} className="border border-indigo-100 rounded-2xl px-3 py-2 text-sm flex-1 min-w-48" />
        <button onClick={fetchLogs} className="bg-slate-100 text-slate-500 text-sm px-3 py-2 rounded-2xl hover:bg-slate-100">🔄 Refresh</button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <div className="bg-white rounded-3xl border border-indigo-50 p-3 text-center">
          <p className="text-lg font-manrope font-bold text-slate-800">{filtered.length}</p>
          <p className="text-xs text-slate-400">Total Actions</p>
        </div>
        <div className="bg-white rounded-3xl border border-indigo-50 p-3 text-center">
          <p className="text-lg font-manrope font-bold text-slate-800">{users.length}</p>
          <p className="text-xs text-slate-400">Users Active</p>
        </div>
        <div className="bg-white rounded-3xl border border-indigo-50 p-3 text-center">
          <p className="text-lg font-bold text-emerald-600">{filtered.filter(l => l.action === "create").length}</p>
          <p className="text-xs text-slate-400">Created</p>
        </div>
        <div className="bg-white rounded-3xl border border-indigo-50 p-3 text-center">
          <p className="text-lg font-bold text-red-500">{filtered.filter(l => l.action === "delete").length}</p>
          <p className="text-xs text-slate-400">Deleted</p>
        </div>
      </div>

      {/* Log Table */}
      <div className="bg-white rounded-3xl shadow-card border border-indigo-50 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-indigo-50/30 text-xs text-slate-400 uppercase">
            <tr>
              <th className="px-4 py-3 text-left">Time</th>
              <th className="px-4 py-3 text-left">User</th>
              <th className="px-4 py-3 text-left">Role</th>
              <th className="px-4 py-3 text-left">Module</th>
              <th className="px-4 py-3 text-left">Action</th>
              <th className="px-4 py-3 text-left">Details</th>
            </tr>
          </thead>
          <tbody>
            {paged.map(log => (
              <tr key={log.id} className="border-t border-indigo-50/50 hover:bg-indigo-50/30/50">
                <td className="px-4 py-2.5 text-xs text-slate-400 whitespace-nowrap">{new Date(log.created_at).toLocaleString()}</td>
                <td className="px-4 py-2.5 text-slate-700 font-medium text-xs">{log.user_email}</td>
                <td className="px-4 py-2.5"><span className={`text-xs px-1.5 py-0.5 rounded-full ${log.user_role === "admin" ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-500"}`}>{log.user_role}</span></td>
                <td className="px-4 py-2.5 text-xs"><span className="flex items-center gap-1">{moduleIcons[log.module] || "📌"} {log.module}</span></td>
                <td className="px-4 py-2.5"><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${actionColors[log.action] || "bg-slate-100 text-slate-700"}`}>{log.action}</span></td>
                <td className="px-4 py-2.5 text-xs text-slate-500 max-w-xs truncate">{log.details}</td>
              </tr>
            ))}
            {paged.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">No audit logs found</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-slate-400">Page {page + 1} of {totalPages} ({filtered.length} records)</span>
          <div className="flex gap-1">
            <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} className="text-xs bg-slate-100 text-slate-500 px-3 py-1.5 rounded-lg disabled:opacity-30">← Prev</button>
            <button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1} className="text-xs bg-slate-100 text-slate-500 px-3 py-1.5 rounded-lg disabled:opacity-30">Next →</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============ COMPANY SELECTOR ============
function CompanySelector({ currentUser, onSelectCompany, onLogout }) {
  const [companies, setCompanies] = useState([]);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", type: "LLC", company_role: "management", address: "", phone: "", email: "" });
  const [joinCode, setJoinCode] = useState("");
  const [joinSearch, setJoinSearch] = useState(""); // Deprecated — code-only joining
  const [searchResults, setSearchResults] = useState([]);
  const [joinMessage, setJoinMessage] = useState("");

  useEffect(() => { fetchCompanies(); }, []);

  async function fetchCompanies() {
    setLoading(true);
    const email = currentUser?.email;
    if (!email) { setLoading(false); return; }
    // Get all companies this user is an active member of
    const { data: memberships } = await supabase.from("company_members").select("company_id, role, status").ilike("user_email", email);
    const active = (memberships || []).filter(m => m.status === "active");
    const pending = (memberships || []).filter(m => m.status === "pending");
    setPendingRequests(pending);
    if (active.length > 0) {
      const companyIds = active.map(m => m.company_id);
      const { data: companyData } = await supabase.from("companies").select("*").in("id", companyIds);
      // Attach role to each company
      const withRoles = (companyData || []).map(c => {
        const membership = active.find(m => m.company_id === c.id);
        return { ...c, memberRole: membership?.role || "tenant" };
      });
      setCompanies(withRoles);
    } else {
      setCompanies([]);
    }
    setLoading(false);
  }

  async function createCompany() {
    if (!createForm.name.trim()) { alert("Company name is required."); return; }
    const companyId = "co-" + shortId() + shortId().slice(0, 4);
    // Generate unique 8-digit numeric company code
    // Generate unique company code with collision retry
    let companyCode;
    for (let attempt = 0; attempt < 5; attempt++) {
      const ccArr = new Uint32Array(1); crypto.getRandomValues(ccArr);
      companyCode = String(10000000 + (ccArr[0] % 89999999));
      const { data: existing } = await supabase.from("companies").select("id").eq("company_code", companyCode).maybeSingle();
      if (!existing) break;
      if (attempt === 4) { alert("Could not generate unique company code. Please try again."); return; }
    }
    // Atomic company creation: company + membership + app_users + chart of accounts in one transaction
    try {
      const { data: rpcResult, error: rpcErr } = await supabase.rpc("create_company_atomic", {
        p_company_id: companyId,
        p_name: createForm.name,
        p_type: createForm.type,
        p_company_code: companyCode,
        p_company_role: createForm.company_role || "management",
        p_address: createForm.address || "",
        p_phone: createForm.phone || "",
        p_email: normalizeEmail(createForm.email),
        p_creator_email: normalizeEmail(currentUser?.email),
        p_creator_name: currentUser?.email?.split("@")[0] || "",
      });
      if (rpcErr) throw new Error(rpcErr.message);
    } catch (rpcE) {
      alert("Failed to create company: " + userError(rpcE.message) + "\n\nPlease ensure the database is properly configured. Contact support if this persists.");
      return;
    }
    alert("Company created!\n\nCompany Code: " + companyCode + "\n\nShare this code with people you want to invite.");
    setShowCreate(false);
    setCreateForm({ name: "", type: "LLC", company_role: "management", address: "", phone: "", email: "" });
    fetchCompanies();
  }

  async function searchCompanies() {
    if (!joinCode.trim()) { alert("Please enter the 8-digit company code shared by your administrator."); return; }
    if (joinCode.trim().length < 8) { alert("Please enter the full 8-digit company code."); return; }
    // Only exact code match — no name search (prevents company enumeration)
    const { data } = await supabase.from("companies").select("id, name, type").eq("company_code", joinCode.trim()).limit(1);
    setSearchResults(data || []);
  }

  async function requestJoin(company) {
    // Check if already a member
    const { data: existing } = await supabase.from("company_members").select("status").eq("company_id", company.id).ilike("user_email", currentUser?.email || "").maybeSingle();
    if (existing) {
      if (existing.status === "active") { alert("You're already a member of " + company.name); return; }
      if (existing.status === "pending") { alert("Your request to join " + company.name + " is pending admin approval."); return; }
      if (existing.status === "rejected") { alert("Your previous request to join " + company.name + " was rejected. Please contact the company admin directly."); return; }
      if (existing.status === "removed") { alert("You were previously removed from " + company.name + ". Please contact the company admin to be re-added."); return; }
    }
    // Server-side join request — verifies auth identity
    try {
      const { error: rpcErr } = await supabase.rpc("request_join_company", {
        p_company_id: company.id,
      });
      if (rpcErr) throw new Error(rpcErr.message);
    } catch (e) {
      // RPC mandatory — no client fallback for membership changes
      alert("Failed to submit join request: " + e.message + ". Please ensure the membership RPCs are deployed.");
      return;
    }
    setJoinMessage("Request sent to join " + company.name + "! An admin will review your request.");
    setSearchResults([]);
    setJoinCode("");
    setJoinSearch("");
    fetchCompanies();
  }

  if (loading) return <div className="flex items-center justify-center h-screen bg-indigo-50/30"><Spinner /></div>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-white flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <div className="text-3xl font-bold text-indigo-700 mb-1">🏡 PropManager</div>
          <div className="text-sm text-slate-400">Welcome, {currentUser?.email}</div>
        </div>

        {/* Your Companies */}
        {companies.length > 0 && (
          <div className="mb-6">
            <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide mb-3">Your Companies</h2>
            <div className="space-y-2">
              {companies.map(c => (
                <button key={c.id} onClick={() => onSelectCompany(c, c.memberRole)}
                  className="w-full bg-white rounded-xl border border-indigo-100 p-4 flex items-center justify-between hover:border-indigo-300 hover:shadow-md transition-all text-left">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-lg">
                      {c.name[0]}
                    </div>
                    <div>
                      <div className="font-semibold text-slate-800">{c.name}</div>
                      <div className="text-xs text-slate-400">{c.type} · {c.memberRole}</div>
                    </div>
                  </div>
                  <span className="text-indigo-600 text-sm font-medium">Open →</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Pending Requests */}
        {pendingRequests.length > 0 && (
          <div className="mb-6 bg-amber-50 border border-amber-200 rounded-3xl p-4">
            <div className="text-sm font-semibold text-amber-800 mb-1">⏳ Pending Requests</div>
            <div className="text-xs text-amber-600">You have {pendingRequests.length} pending request(s) waiting for admin approval.</div>
          </div>
        )}

        {joinMessage && (
          <div className="mb-4 bg-green-50 border border-green-200 rounded-3xl p-4 text-sm text-green-700">{joinMessage}</div>
        )}

        {/* Actions */}
        <div className="grid grid-cols-2 gap-3 mb-6">
          <button onClick={() => { setShowCreate(true); setShowJoin(false); }}
            className="bg-indigo-600 text-white rounded-3xl p-4 text-center hover:bg-indigo-700 transition-colors">
            <div className="text-2xl mb-1">🏢</div>
            <div className="text-sm font-semibold">Create Company</div>
            <div className="text-xs text-indigo-200">Start a new LLC or org</div>
          </button>
          <button onClick={() => { setShowJoin(true); setShowCreate(false); }}
            className="bg-white border-2 border-indigo-200 text-indigo-700 rounded-3xl p-4 text-center hover:border-indigo-400 transition-colors">
            <div className="text-2xl mb-1">🔗</div>
            <div className="text-sm font-semibold">Join Company</div>
            <div className="text-xs text-slate-400">Enter code or search</div>
          </button>
        </div>

        {/* Create Company Form */}
        {showCreate && (
          <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-6 mb-4">
            <h3 className="font-bold text-slate-800 mb-4">Create New Company</h3>
            <div className="space-y-3">
              {/* Company Role Selection */}
              <div>
                <label className="text-xs font-medium text-slate-500 block mb-2">Company Type *</label>
                <div className="grid grid-cols-2 gap-3">
                  <button type="button" onClick={() => setCreateForm({...createForm, company_role: "management"})} className={`p-3 rounded-xl border-2 text-left transition-all ${createForm.company_role === "management" ? "border-indigo-500 bg-indigo-50" : "border-indigo-100 hover:border-indigo-200"}`}>
                    <div className="text-lg mb-1">🏢</div>
                    <div className="text-sm font-semibold text-slate-800">Property Management</div>
                    <div className="text-xs text-slate-400">I manage properties for owners</div>
                  </button>
                  <button type="button" onClick={() => setCreateForm({...createForm, company_role: "owner"})} className={`p-3 rounded-xl border-2 text-left transition-all ${createForm.company_role === "owner" ? "border-emerald-500 bg-emerald-50" : "border-indigo-100 hover:border-indigo-200"}`}>
                    <div className="text-lg mb-1">🏠</div>
                    <div className="text-sm font-semibold text-slate-800">Property Owner</div>
                    <div className="text-xs text-slate-400">I own and manage my properties</div>
                  </button>
                </div>
              </div>
              <div><label className="text-xs font-medium text-slate-500">Company Name *</label><input value={createForm.name} onChange={e => setCreateForm({...createForm, name: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mt-1" placeholder={createForm.company_role === "management" ? "e.g. Sigma Property Management" : "e.g. Smith Properties LLC"} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-medium text-slate-500">Entity Type</label><select value={createForm.type} onChange={e => setCreateForm({...createForm, type: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mt-1"><option>LLC</option><option>Corporation</option><option>Partnership</option><option>Sole Proprietorship</option><option>Trust</option><option>Other</option></select></div>
                <div><label className="text-xs font-medium text-slate-500">Email</label><input type="email" value={createForm.email} onChange={e => setCreateForm({...createForm, email: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mt-1" placeholder="company@email.com" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-medium text-slate-500">Address</label><input placeholder="123 Business Ave, City, State ZIP" value={createForm.address} onChange={e => setCreateForm({...createForm, address: e.target.value})} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mt-1" /></div>
                <div><label className="text-xs font-medium text-slate-500">Phone</label><input type="tel" placeholder="(555) 123-4567" value={createForm.phone} onChange={e => setCreateForm({...createForm, phone: formatPhoneInput(e.target.value)})} maxLength={14} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mt-1" /></div>
              </div>
              <div className="flex gap-2 pt-2">
                <button onClick={createCompany} className="bg-indigo-600 text-white text-sm px-5 py-2 rounded-2xl hover:bg-indigo-700">Create Company</button>
                <button onClick={() => setShowCreate(false)} className="bg-slate-100 text-slate-500 text-sm px-4 py-2 rounded-lg">Cancel</button>
              </div>
            </div>
          </div>
        )}

        {/* Join Company Form */}
        {showJoin && (
          <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-6 mb-4">
            <h3 className="font-bold text-slate-800 mb-4">Join a Company</h3>
            <div className="space-y-3">
              <div><label className="text-xs font-medium text-slate-500">Company ID (8-digit code)</label><input value={joinCode} onChange={e => setJoinCode(e.target.value.replace(/\D/g, "").slice(0, 8))} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mt-1" placeholder="e.g. 12345678" maxLength={8} /></div>
              <div className="text-xs text-slate-400 text-center">— or —</div>
              <div><label className="text-xs font-medium text-slate-500">Search by Name</label><input value={joinSearch} onChange={e => setJoinSearch(e.target.value)} className="w-full border border-indigo-100 rounded-2xl px-3 py-2 text-sm mt-1" placeholder="e.g. Sigma Housing" /></div>
              <div className="flex gap-2">
                <button onClick={searchCompanies} className="bg-indigo-600 text-white text-sm px-5 py-2 rounded-2xl hover:bg-indigo-700">Search</button>
                <button onClick={() => setShowJoin(false)} className="bg-slate-100 text-slate-500 text-sm px-4 py-2 rounded-lg">Cancel</button>
              </div>
              {searchResults.length > 0 && (
                <div className="space-y-2 mt-3">
                  {searchResults.map(c => (
                    <div key={c.id} className="flex items-center justify-between bg-indigo-50/30 rounded-lg p-3">
                      <div><div className="text-sm font-semibold text-slate-800">{c.name}</div><div className="text-xs text-slate-400">{c.type}</div></div>
                      <button onClick={() => requestJoin(c)} className="bg-indigo-600 text-white text-xs px-3 py-1.5 rounded-2xl hover:bg-indigo-700">Request to Join</button>
                    </div>
                  ))}
                </div>
              )}
              {searchResults.length === 0 && (joinCode || joinSearch) && <div className="text-xs text-slate-400 text-center">Click Search to find companies</div>}
            </div>
          </div>
        )}

        <div className="text-center">
          <button onClick={onLogout} className="text-sm text-slate-400 hover:text-red-500">Logout</button>
        </div>
      </div>
    </div>
  );
}

// ============ ADMIN: PENDING MEMBER REQUESTS ============
function PendingRequestsPanel({ companyId, addNotification }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchRequests(); }, [companyId]);

  async function fetchRequests() {
    const { data } = await supabase.from("company_members").select("*").eq("company_id", companyId).eq("status", "pending").order("created_at", { ascending: false });
    setRequests(data || []);
    setLoading(false);
  }

  async function handleRequest(member, action) {
    // Server-side membership approval — verifies caller is admin
    try {
      const { data: result, error: rpcErr } = await supabase.rpc("handle_membership_request", {
        p_company_id: companyId,
        p_member_id: String(member.id),
        p_action: action,
      });
      if (rpcErr) throw new Error(rpcErr.message);
      if (action === "approve") addNotification("\u2705", member.user_name + " approved to join");
      else addNotification("\u274c", member.user_name + "'s request rejected");
    } catch (e) {
      // RPC mandatory — no client fallback for membership changes
      alert("Failed to process request: " + e.message + ". Please ensure the membership RPCs are deployed.");
      return;
    }
    fetchRequests();
  }

  if (loading || requests.length === 0) return null;

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-3xl p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-bold text-amber-800">⏳ Pending Join Requests ({requests.length})</div>
      </div>
      <div className="space-y-2">
        {requests.map(r => (
          <div key={r.id} className="flex items-center justify-between bg-white rounded-lg p-3">
            <div>
              <div className="text-sm font-semibold text-slate-800">{r.user_name || r.user_email}</div>
              <div className="text-xs text-slate-400">{r.user_email} · Requested: {new Date(r.created_at).toLocaleDateString()}</div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => handleRequest(r, "approve")} className="bg-green-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-green-700">Approve</button>
              <button onClick={() => handleRequest(r, "reject")} className="bg-red-100 text-red-600 text-xs px-3 py-1.5 rounded-lg hover:bg-red-200">Reject</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============ PM ASSIGNMENT REQUESTS PANEL ============
function PendingPMAssignments({ companyId, addNotification }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchRequests(); }, [companyId]);

  async function fetchRequests() {
    const { data } = await supabase.from("pm_assignment_requests").select("*")
      .eq("pm_company_id", companyId).eq("status", "pending").order("created_at", { ascending: false });
    setRequests(data || []);
    setLoading(false);
  }

  async function handleRequest(req, action) {
    if (action === "accept") {
      try {
        const { data: result, error } = await supabase.rpc("accept_pm_assignment", {
          p_request_id: req.id,
          p_pm_company_id: companyId,
          p_reviewer_email: "",
        });
        if (error) throw new Error(error.message);
        addNotification("✅", "Accepted: now managing " + req.property_address);
      } catch (e) {
        alert("Error accepting assignment: " + e.message);
        return;
      }
    } else {
      const { error } = await supabase.from("pm_assignment_requests").update({
        status: "declined", reviewed_at: new Date().toISOString(),
      }).eq("id", req.id).eq("pm_company_id", companyId);
      if (error) { alert("Error declining: " + error.message); return; }
      addNotification("❌", "Declined PM request for " + req.property_address);
    }
    fetchRequests();
  }

  if (loading || requests.length === 0) return null;

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-3xl p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-bold text-blue-800">📨 PM Assignment Requests ({requests.length})</div>
      </div>
      <div className="space-y-2">
        {requests.map(r => (
          <div key={r.id} className="flex items-center justify-between bg-white rounded-lg p-3">
            <div>
              <div className="text-sm font-semibold text-slate-800">{r.property_address}</div>
              <div className="text-xs text-slate-400">Owner requested: {new Date(r.requested_at).toLocaleDateString()} · {r.requested_by}</div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => handleRequest(r, "accept")} className="bg-green-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-green-700">Accept</button>
              <button onClick={() => handleRequest(r, "decline")} className="bg-red-100 text-red-600 text-xs px-3 py-1.5 rounded-lg hover:bg-red-200">Decline</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AppInner() {
  const [screen, setScreen] = useState("landing");
  const [page, setPage] = useState("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [currentUser, setCurrentUser] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [customAllowedPages, setCustomAllowedPages] = useState(null);
  // Company context
  const [activeCompany, setActiveCompany] = useState(null);
  const [companyRole, setCompanyRole] = useState("");
  const [roleLoaded, setRoleLoaded] = useState(false);
  const [missingRPCs, setMissingRPCs] = useState([]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) { setCurrentUser(session.user); setScreen("company_select"); autoSelectCompany(session.user); }
    });
    const { data: { subscription: authSub } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        setCurrentUser(session.user);
        // Only redirect to company_select if we don't have a company yet
        setActiveCompany(prev => {
          if (!prev) { setScreen("company_select"); autoSelectCompany(session.user); }
          return prev;
        });
      } else {
        setCurrentUser(null);
        setUserRole(null);
        setActiveCompany(null);
        setScreen("landing");
      }
    });
    return () => { if (authSub) authSub.unsubscribe(); };
  }, []);

  // Auto-select company ONLY for tenant/owner roles — everyone else sees the company selector
  async function autoSelectCompany(user) {
    if (!user?.email) return;
    // Prefer UID-based lookup (faster, not email-dependent), fall back to email
    let memberships;
    if (user.id) {
      const { data: uidResult } = await supabase.from("company_members").select("company_id, role, status").eq("auth_user_id", user.id).eq("status", "active");
      if (uidResult && uidResult.length > 0) { memberships = uidResult; }
    }
    if (!memberships) {
      const { data: emailResult } = await supabase.from("company_members").select("company_id, role, status").ilike("user_email", user.email).eq("status", "active");
      memberships = emailResult;
    }
    if (!memberships || memberships.length === 0) { setScreen("company_select"); return; }
    // Only tenants auto-select their company (skip selector)
    const tenantMembership = memberships.find(m => m.role === "tenant");
    if (tenantMembership) {
      const { data: company } = await supabase.from("companies").select("*").eq("id", tenantMembership.company_id).maybeSingle();
      if (company) { handleSelectCompany(company, tenantMembership.role); return; }
    }
    // Everyone else (PM, owner, staff) always sees the company selector
    setScreen("company_select");
  }

  function handleSelectCompany(company, role) {
    setActiveCompany(company);
      checkRPCHealth(company.id).then(m => setMissingRPCs(m)).catch(() => {});
    setCompanyRole(role);
    setUserRole(role);
    setRoleLoaded(true);
    setUserProfile({ name: currentUser?.email?.split("@")[0] || "User", email: currentUser?.email, role: role });
    fetchUserRoleForCompany(currentUser, company.id); // async — role updates via setState after fetch
    setScreen("app");
    setPage("dashboard");
  }

  async function fetchUserRoleForCompany(user, companyId) {
    if (!user?.email || !companyId) return;
    try {
      const { data } = await supabase.from("company_members").select("*").eq("company_id", companyId).ilike("user_email", user.email).eq("status", "active").maybeSingle();
      // Backfill auth_user_id for UID-based lookups
      if (data && !data.auth_user_id && user.id) {
        const { error: uidErr } = await supabase.from("company_members").update({ auth_user_id: user.id }).eq("id", data.id);
        if (uidErr) console.warn("auth_user_id backfill failed:", uidErr.message);
      }
      if (data) {
        setUserRole(data.role);
        setCompanyRole(data.role);
        setUserProfile({ name: data.user_name || user.email.split("@")[0], email: user.email, role: data.role });
        if (data.custom_pages) {
          try { const parsed = JSON.parse(data.custom_pages); if (Array.isArray(parsed)) setCustomAllowedPages(parsed); } catch { setCustomAllowedPages(null); }
        } else {
          setCustomAllowedPages(null);
        }
      }
      setRoleLoaded(true);
    } catch { setRoleLoaded(true); /* still mark loaded so UI doesn't hang */ }
  }

  function addNotification(icon, message) {
    const n = { id: shortId(), icon, message, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) };
    setNotifications(prev => [n, ...prev].slice(0, 20));
    setUnreadCount(prev => prev + 1);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setScreen("landing");
    setNotifications([]);
    setUnreadCount(0);
    setCurrentUser(null);
    setUserRole(null);
    setRoleLoaded(false);
    setCustomAllowedPages(null);
    setActiveCompany(null);
  }

  function switchCompany() {
    // Clear caches that are company-specific
    for (const key in _acctIdCache) delete _acctIdCache[key];
    if (typeof window !== "undefined") { delete window._propClassesSynced; }
    setActiveCompany(null);
    setCompanyRole("");
    setUserRole(null);
    setRoleLoaded(false);
    setCustomAllowedPages(null);
    setNotifications([]);
    setUnreadCount(0);
    setScreen("company_select");
    setPage("dashboard");
  }

  const [loginMode, setLoginMode] = useState("login");

  // Guard: never render app without a valid company — redirect to selector
  useEffect(() => {
    if (screen === "app" && !activeCompany?.id) {
      setScreen("company_select");
    }
  }, [screen, activeCompany]);

  if (screen === "landing") return <LandingPage onGetStarted={(mode) => { setLoginMode(mode); setScreen("login"); }} />;
  if (screen === "login") return <LoginPage onLogin={() => {}} onBack={() => setScreen("landing")} initialMode={loginMode} />;
  if (screen === "company_select") return <CompanySelector currentUser={currentUser} onSelectCompany={handleSelectCompany} onLogout={handleLogout} />;

  if (!activeCompany?.id || !roleLoaded) {
    return (
      <div className="flex items-center justify-center h-screen bg-indigo-50/30">
        <div className="text-center">
          <Spinner />
          <p className="text-sm text-slate-400 mt-4">{!activeCompany?.id ? "Loading company..." : "Loading your access..."}</p>
        </div>
      </div>
    );
  }

  // Build nav based on confirmed role (roleLoaded is true at this point)
  const allowedPages = customAllowedPages || ROLES[userRole]?.pages || ROLES[companyRole]?.pages || ["dashboard"];
  const navItems = ALL_NAV.filter(n => allowedPages.includes(n.id));
  const adminNav = (userRole === "admin" || companyRole === "admin")
    ? [...navItems, { id: "roles", label: "Team & Roles", icon: "group" }]
    : navItems;

  // Owner-admins (created their own company) get full app access
  // Only force owner_portal for owners invited into a PM's company
  const effectiveRole = userRole || companyRole || "office_assistant";
  const effectivePage = effectiveRole === "tenant" ? "tenant_portal" : (effectiveRole === "owner" && companyRole !== "admin") ? "owner_portal" : page;
  const Page = pageComponents[effectivePage] || Dashboard;
  const safePage = allowedPages.includes(page) ? page : allowedPages[0];

  return (
    <div className="flex h-screen bg-[#fcf8ff] font-inter overflow-hidden">
      {/* Sidebar */}
      <div className={`${sidebarOpen ? "flex" : "hidden"} md:flex flex-col w-56 bg-white/80 backdrop-blur-md border-r border-indigo-50 z-20 fixed md:relative h-full`}>
        <div className="px-5 py-4 border-b border-indigo-50">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-200">
              <span className="material-icons-outlined text-white text-sm">domain</span>
            </div>
            <span className="font-manrope font-extrabold text-lg tracking-tight text-indigo-900">Estate Logic</span>
          </div>
          {activeCompany && (
            <div className="flex items-center gap-1.5 mt-2">
              <span className="w-5 h-5 rounded-lg bg-indigo-100 flex items-center justify-center text-indigo-700 text-xs font-bold">{activeCompany.name[0]}</span>
              <span className="text-xs text-slate-500 truncate max-w-32 font-medium">{activeCompany.name}</span>
            </div>
          )}
        </div>
        <nav className="flex-1 py-3 px-2 overflow-y-auto">
          {adminNav.map(n => (
            <button key={n.id} onClick={() => { setPage(n.id); setSidebarOpen(false); }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm text-left transition-all rounded-2xl mb-0.5 ${page === n.id ? "bg-indigo-50 text-indigo-700 font-semibold" : "text-slate-500 hover:bg-indigo-50/50 hover:text-slate-700"}`}>
              <span className="material-icons-outlined text-lg">{n.icon}</span>{n.label}
            </button>
          ))}
        </nav>
        <div className="px-4 py-3 border-t border-indigo-50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold ${ROLES[userRole]?.color || "bg-indigo-600"}`}>
                {userProfile?.name?.[0]?.toUpperCase() || "U"}
              </div>
              <div>
                <div className="text-xs font-semibold text-slate-700 truncate max-w-24">{userProfile?.name || "User"}</div>
                <div className={`text-xs font-medium ${ROLES[userRole]?.color?.replace("bg-", "text-") || "text-indigo-600"}`}>{ROLES[userRole]?.label}</div>
              </div>
            </div>
            <button onClick={() => { setPage("audittrail"); setSidebarOpen(false); }} className="text-slate-400 hover:text-indigo-500 transition-colors" title="Audit Trail"><span className="material-icons-outlined text-lg">history</span></button>
              <button onClick={handleLogout} className="text-slate-400 hover:text-red-500 transition-colors"><span className="material-icons-outlined text-lg">logout</span></button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white/80 backdrop-blur-md border-b border-indigo-50 px-4 py-3 flex items-center gap-3">
          <button className="md:hidden text-slate-400 hover:text-slate-600 transition-colors" onClick={() => setSidebarOpen(!sidebarOpen)}><span className="material-icons-outlined">menu</span></button>
          <div className="flex-1 text-sm text-slate-400 capitalize font-medium">{page.replace("_", " ")}</div>
          <button onClick={switchCompany} className="hidden md:flex items-center gap-1.5 text-xs bg-indigo-50 text-indigo-600 px-3 py-1.5 rounded-2xl hover:bg-indigo-100 transition-colors font-semibold border border-indigo-100">
            <span className="material-icons-outlined text-sm">swap_horiz</span> Switch Company
          </button>
          <span className={`hidden md:inline-block text-white text-xs px-2.5 py-1 rounded-full font-semibold uppercase tracking-wide ${ROLES[userRole]?.color || "bg-indigo-600"}`}>
            {ROLES[userRole]?.label}
          </span>
          <div className="relative">
            <button onClick={() => { setShowNotifications(!showNotifications); setUnreadCount(0); }} className="relative w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center text-indigo-600 hover:bg-indigo-100 transition-colors">
              <span className="material-icons-outlined">notifications</span>
              {unreadCount > 0 && (
                <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-red-500 rounded-full ring-2 ring-white"></span>
              )}
            </button>
            {showNotifications && (
              <div className="absolute right-0 top-12 w-80 bg-white rounded-3xl shadow-card border border-indigo-50 z-50">
                <div className="px-4 py-3 border-b border-indigo-50 flex justify-between items-center">
                  <span className="font-manrope font-bold text-slate-700 text-sm">Notifications</span>
                  <button onClick={() => { setNotifications([]); setShowNotifications(false); }} className="text-xs text-slate-400 hover:text-red-500">Clear all</button>
                </div>
                <div className="max-h-72 overflow-y-auto">
                  {notifications.length === 0 ? (
                    <div className="px-4 py-6 text-center text-slate-400 text-sm">No notifications yet</div>
                  ) : (
                    notifications.map(n => (
                      <div key={n.id} className="px-4 py-3 border-b border-indigo-50/50 hover:bg-indigo-50/30 flex items-start gap-2 transition-colors">
                        <span className="text-lg">{n.icon}</span>
                        <div className="flex-1">
                          <div className="text-sm text-slate-700">{n.message}</div>
                          <div className="text-xs text-slate-400 mt-0.5">{n.time}</div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 md:p-6 pb-24 md:pb-6">
          {missingRPCs.length > 0 && userRole === "admin" && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4">
              <div className="text-sm font-semibold text-amber-800">⚠️ Missing Database Functions</div>
              <div className="text-xs text-amber-600 mt-1">The following RPCs need to be deployed: {missingRPCs.join(", ")}. Some features may not work until these are installed.</div>
            </div>
          )}
          {userRole === "admin" && activeCompany && <PendingRequestsPanel companyId={activeCompany.id} addNotification={addNotification} />}
          {userRole === "admin" && activeCompany && <PendingPMAssignments companyId={activeCompany.id} addNotification={addNotification} />}
          <Page
            key={activeCompany.id}
            addNotification={addNotification}
            notifications={notifications}
            setPage={setPage}
            currentUser={currentUser}
            userRole={userRole}
            userProfile={userProfile}
            companyId={activeCompany.id}
            activeCompany={activeCompany}
          />
        </main>
      </div>

      {/* Mobile Bottom Nav */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-lg border-t border-indigo-50 px-4 pt-3 pb-6 flex justify-around items-center z-40 md:hidden">
        {[
          { id: "dashboard", icon: "dashboard", label: "Home" },
          { id: "properties", icon: "apartment", label: "Assets" },
          { id: "tenants", icon: "people", label: "Tenants" },
          { id: "payments", icon: "payments", label: "Rent" },
          { id: "maintenance", icon: "build", label: "Repair" },
        ].map(n => (
          <button key={n.id} onClick={() => setPage(n.id)} className={`flex flex-col items-center gap-1 transition-colors ${page === n.id ? "text-indigo-600" : "text-slate-400"}`}>
            {page === n.id ? <div className="bg-indigo-50 p-2 rounded-xl"><span className="material-icons-outlined">{n.icon}</span></div> : <span className="material-icons-outlined">{n.icon}</span>}
            <span className="text-[10px] font-bold uppercase tracking-tight">{n.label}</span>
          </button>
        ))}
      </nav>

      {sidebarOpen && <div className="fixed inset-0 bg-black bg-opacity-20 z-10 md:hidden" onClick={() => setSidebarOpen(false)} />}
      {showNotifications && <div className="fixed inset-0 z-30" onClick={() => setShowNotifications(false)} />}
    </div>
  );
}

export default function App() {
  return <ErrorBoundary><AppInner /></ErrorBoundary>;
}
