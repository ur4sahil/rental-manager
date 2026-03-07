import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { supabase } from "./supabase";

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
async function safeLedgerInsert(entry) {
  const { error } = await supabase.from("ledger_entries").insert([entry]);
  if (error) console.warn("Ledger entry failed:", error.message, entry);
  return !error;
}

// ============ COMPANY-SCOPED SUPABASE HELPERS ============
// Use these instead of raw supabase.from() to automatically filter by company_id
function companyQuery(table, companyId) {
  return supabase.from(table).select("*").eq("company_id", companyId || "sandbox-llc");
}
function companyInsert(table, rows, companyId) {
  const cid = companyId || "sandbox-llc";
  const withCompany = (Array.isArray(rows) ? rows : [rows]).map(r => ({ ...r, company_id: cid }));
  return supabase.from(table).insert(withCompany);
}
function companyUpsert(table, rows, companyId, onConflict) {
  const cid = companyId || "sandbox-llc";
  const withCompany = (Array.isArray(rows) ? rows : [rows]).map(r => ({ ...r, company_id: cid }));
  return supabase.from(table).upsert(withCompany, onConflict ? { onConflict } : undefined);
}

// Generate secure random ID (better than Date.now + Math.random)
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

// Safe write wrapper — logs errors instead of silently failing
async function safeWrite(operation, context = "") {
  try {
    const result = await operation;
    if (result?.error) console.warn("DB write error" + (context ? " in " + context : "") + ":", result.error.message);
    return result;
  } catch (e) {
    console.warn("DB write failed" + (context ? " in " + context : "") + ":", e.message);
    return { error: e };
  }
}

// Guard: require companyId — log warning if missing (fallback kept for safety but flagged)
function requireCompanyId(companyId, context = "") {
  if (!companyId) {
    console.warn("WARNING: Missing companyId" + (context ? " in " + context : "") + " — using sandbox-llc fallback");
  }
  return companyId || "sandbox-llc";
}

// ============ AUDIT TRAIL HELPER ============
// Call this from any module to log an action
async function logAudit(action, module, details = "", recordId = "", userEmail = "", userRoleVal = "unknown", companyId = "sandbox-llc") {
  try {
    if (!userEmail) {
      const { data: { user } } = await supabase.auth.getUser();
      userEmail = user?.email || "unknown";
    }
    await supabase.from("audit_trail").insert([{ company_id: companyId || "sandbox-llc", action, module, details, record_id: String(recordId), user_email: userEmail, user_role: userRoleVal }]);
  } catch (e) { console.warn("Audit log failed:", e); }
}

// ============ UNIFIED AUTO-POSTING TO ACCOUNTING ============
async function autoPostJournalEntry({ date, description, reference, property, lines, status = "posted", companyId = "sandbox-llc" }) {
  try {
    const cid = companyId || "sandbox-llc";
    // Resolve bare account IDs (1100, 4000, etc.) to actual DB IDs for this company
    if (lines?.length > 0) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].account_id && /^\d{4}$/.test(lines[i].account_id)) {
          lines[i].account_id = await resolveAccountId(lines[i].account_id, cid);
        }
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
        p_lines: JSON.stringify(lines || []),
      });
      if (!rpcErr && jeId) return jeId;
      console.warn("JE RPC fallback:", rpcErr?.message);
    } catch (e) { console.warn("JE RPC not available, using client-side:", e.message); }
    
    // Fallback: client-side (non-atomic, race-prone but functional)
    const { data: existingJEs } = await supabase.from("acct_journal_entries").select("number").eq("company_id", cid).order("number", { ascending: false }).limit(1);
    const lastNum = existingJEs?.[0]?.number ? parseInt(existingJEs[0].number.replace("JE-",""), 10) : 0;
    const number = `JE-${String(lastNum + 1).padStart(4, "0")}`;
    const jeId = generateId("je");
    const { error: headerErr } = await supabase.from("acct_journal_entries").insert([{ company_id: cid, id: jeId, number, date, description, reference: reference || "", property: property || "", status }]);
    if (headerErr) { console.warn("JE header insert failed:", headerErr.message); return null; }
    if (lines?.length > 0) {
      const { error: linesErr } = await supabase.from("acct_journal_lines").insert(lines.map(l => ({
        journal_entry_id: jeId, account_id: l.account_id, account_name: l.account_name,
        debit: safeNum(l.debit), credit: safeNum(l.credit), class_id: l.class_id || null, memo: l.memo || ""
      })));
      if (linesErr) {
        // Clean up orphaned header to prevent partial accounting records
        console.warn("JE lines insert failed, cleaning up header:", linesErr.message);
        await supabase.from("acct_journal_entries").delete().eq("id", jeId);
        return null;
      }
    }
    return jeId;
  } catch (e) { console.warn("Auto-post JE failed:", e); return null; }
}

async function getPropertyClassId(propertyAddress, companyId) {
  if (!propertyAddress) return null;
  const { data } = await supabase.from("acct_classes").select("id").eq("name", propertyAddress).eq("company_id", companyId || "sandbox-llc").limit(1);
  return data?.[0]?.id || null;
}

// Resolve bare account codes (1000, 1100, etc.) to actual DB IDs for this company
const _acctIdCache = {};
async function resolveAccountId(bareCode, companyId) {
  const cid = companyId || "sandbox-llc";
  const key = cid + ":" + bareCode;
  if (_acctIdCache[key]) return _acctIdCache[key];
  // Try prefixed format first (co-abc12-1000), then bare code
  const prefix = cid.slice(0, 8) + "-" + bareCode;
  let resolved = bareCode;
  const { data: d1 } = await supabase.from("acct_accounts").select("id").eq("company_id", cid).eq("id", prefix).limit(1);
  if (d1?.length > 0) { resolved = d1[0].id; }
  else {
    const { data: d2 } = await supabase.from("acct_accounts").select("id").eq("company_id", cid).eq("id", bareCode).limit(1);
    if (d2?.length > 0) resolved = d2[0].id;
  }
  _acctIdCache[key] = resolved;
  return resolved;
}

// ============ AUTOMATIC RENT CHARGE ENGINE ============
// Runs on app load. For every active lease, posts monthly rent charges
// (DR Accounts Receivable / CR Rental Income) for each month in the lease term
// up to the current month. Idempotent — won't double-post.
async function autoPostRentCharges(companyId) {
  try {
    const cid = companyId || "sandbox-llc";
    const today = new Date();
    const currentMonth = formatLocalDate(today).slice(0, 7); // "2026-03"

    // 1. Fetch all active leases for this company
    const { data: leases } = await supabase.from("leases").select("*").eq("company_id", cid).eq("status", "active");
    if (!leases || leases.length === 0) return;

    // 2. Fetch existing rent charge JEs to avoid duplicates
    const { data: existingJEs } = await supabase.from("acct_journal_entries").select("reference").eq("company_id", cid)
      .like("reference", "RENT-AUTO-%").neq("status", "voided");
    const postedRefs = new Set((existingJEs || []).map(j => j.reference));

    let posted = 0;

    for (const lease of leases) {
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
          await autoPostJournalEntry({
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

          // Also update tenant balance (add the charge)
          if (lease.tenant_id) {
            // Create ledger entry for this rent charge
            await safeLedgerInsert({ company_id: cid,
              tenant: lease.tenant_name, property: lease.property,
              date: chargeDate, description: "Rent charge — " + monthStr,
              amount: monthRent, type: "charge", balance: 0,
            });

            // Update tenant balance atomically (prevents drift)
            try {
              await supabase.rpc("update_tenant_balance", { p_tenant_id: lease.tenant_id, p_amount_change: monthRent });
            } catch {
              // Fallback to client-side if RPC not deployed
              const { data: tenant } = await supabase.from("tenants").select("balance").eq("id", lease.tenant_id).maybeSingle();
              await supabase.from("tenants").update({ balance: safeNum(tenant?.balance) + monthRent }).eq("company_id", companyId || "sandbox-llc").eq("id", lease.tenant_id); // balance update (unchecked ok — RPC primary)
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
  } catch (e) {
    console.warn("Auto rent charge posting failed:", e);
  }
}

// ============ STYLES ============
const statusColors = {
  occupied: "bg-green-100 text-green-700",
  vacant: "bg-yellow-100 text-yellow-700",
  maintenance: "bg-red-100 text-red-700",
  "notice given": "bg-orange-100 text-orange-700",
  active: "bg-green-100 text-green-700",
  notice: "bg-orange-100 text-orange-700",
  open: "bg-blue-100 text-blue-700",
  in_progress: "bg-purple-100 text-purple-700",
  completed: "bg-gray-100 text-gray-600",
  paid: "bg-green-100 text-green-700",
  partial: "bg-yellow-100 text-yellow-700",
  unpaid: "bg-red-100 text-red-700",
  pending: "bg-yellow-100 text-yellow-700",
  approved: "bg-green-100 text-green-700",
};

const priorityColors = {
  emergency: "bg-red-500 text-white",
  normal: "bg-blue-100 text-blue-700",
  low: "bg-gray-100 text-gray-600",
};

// ============ SHARED COMPONENTS ============
function Badge({ status, label }) {
  const color = statusColors[status] || "bg-gray-100 text-gray-600";
  return <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${color}`}>{label || status}</span>;
}

function StatCard({ label, value, sub, color = "text-gray-800" }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <div className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-1">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
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
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 sticky top-0 bg-white">
          <h3 className="font-bold text-gray-800 text-lg">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
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
    supabase.from("properties").select("id, address, type, status").eq("company_id", companyId || "sandbox-llc").order("address").then(({ data }) => setProperties(data || []));
  }, [companyId]);
  return (
    <div>
      {label && <label className="text-xs font-medium text-gray-600 block mb-1">{label} {required && "*"}</label>}
      <select value={value || ""} onChange={e => onChange(e.target.value)} className={`border border-gray-200 rounded-lg px-3 py-2 text-sm w-full ${className}`} required={required}>
        <option value="">Select property...</option>
        {properties.map(p => <option key={p.id} value={p.address}>{p.address} ({p.type})</option>)}
      </select>
    </div>
  );
}

function PropertySelect({ value, onChange, className = "", companyId }) {
  const [properties, setProperties] = useState([]);
  useEffect(() => {
    supabase.from("properties").select("id, address, type").eq("company_id", companyId || "sandbox-llc").order("address").then(({ data }) => setProperties(data || []));
  }, [companyId]);
  return (
    <select value={value || ""} onChange={e => onChange(e.target.value)} className={`border border-gray-200 rounded-lg px-3 py-2 text-sm ${className}`}>
      <option value="">Select property...</option>
      {properties.map(p => <option key={p.id} value={p.address}>{p.address}</option>)}
    </select>
  );
}

// ============ LANDING PAGE ============
function LandingPage({ onGetStarted }) {
  return (
    <div className="min-h-screen bg-white">
      <nav className="flex items-center justify-between px-8 py-4 border-b border-gray-100">
        <div className="text-xl font-bold text-indigo-700">🏡 PropManager</div>
        <button onClick={() => onGetStarted("login")} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">Sign In</button>
      </nav>
      <div className="bg-gradient-to-br from-indigo-50 to-white px-8 py-16 text-center">
        <h1 className="text-4xl md:text-5xl font-bold text-gray-900 mb-4 leading-tight">Property Management<br />Made Simple</h1>
        <p className="text-lg text-gray-500 mb-12 max-w-xl mx-auto">Manage properties, tenants, rent, maintenance, and accounting — all in one place.</p>

        <h2 className="text-lg font-semibold text-gray-700 mb-6">I am a...</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto">
          {/* Property Manager */}
          <button onClick={() => onGetStarted("signup_pm")} className="bg-white rounded-2xl border-2 border-indigo-200 p-8 text-center hover:border-indigo-500 hover:shadow-lg transition-all group">
            <div className="w-16 h-16 rounded-2xl bg-indigo-100 flex items-center justify-center text-3xl mx-auto mb-4 group-hover:bg-indigo-200">🏢</div>
            <div className="text-lg font-bold text-gray-800 mb-2">Property Manager</div>
            <p className="text-sm text-gray-500">I manage properties on behalf of owners. Full access to all management tools.</p>
            <div className="mt-4 text-indigo-600 text-sm font-semibold">Get Started →</div>
          </button>

          {/* Property Owner */}
          <button onClick={() => onGetStarted("signup_owner")} className="bg-white rounded-2xl border-2 border-emerald-200 p-8 text-center hover:border-emerald-500 hover:shadow-lg transition-all group">
            <div className="w-16 h-16 rounded-2xl bg-emerald-100 flex items-center justify-center text-3xl mx-auto mb-4 group-hover:bg-emerald-200">🏠</div>
            <div className="text-lg font-bold text-gray-800 mb-2">Property Owner</div>
            <p className="text-sm text-gray-500">I own properties and want to manage them directly or assign a property manager.</p>
            <div className="mt-4 text-emerald-600 text-sm font-semibold">Get Started →</div>
          </button>

          {/* Tenant */}
          <button onClick={() => onGetStarted("signup_tenant")} className="bg-white rounded-2xl border-2 border-amber-200 p-8 text-center hover:border-amber-500 hover:shadow-lg transition-all group">
            <div className="w-16 h-16 rounded-2xl bg-amber-100 flex items-center justify-center text-3xl mx-auto mb-4 group-hover:bg-amber-200">🔑</div>
            <div className="text-lg font-bold text-gray-800 mb-2">Tenant</div>
            <p className="text-sm text-gray-500">I have an invite code from my landlord or property manager to access my portal.</p>
            <div className="mt-4 text-amber-600 text-sm font-semibold">Enter Invite Code →</div>
          </button>
        </div>

        <div className="mt-10">
          <button onClick={() => onGetStarted("login")} className="text-sm text-gray-500 hover:text-indigo-600">Already have an account? <span className="font-semibold">Sign In</span></button>
        </div>
      </div>

      <div className="px-8 py-16 bg-gray-50">
        <h2 className="text-2xl font-bold text-center text-gray-800 mb-10">Everything You Need</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {[
            { icon: "🏠", title: "Property Management", desc: "Track all your properties, units, and their status in one place." },
            { icon: "👤", title: "Tenant Management", desc: "Manage tenant profiles, leases, and communication effortlessly." },
            { icon: "💳", title: "Rent Collection", desc: "Collect rent via ACH, card, or autopay with automated reminders." },
            { icon: "🔧", title: "Maintenance Tracking", desc: "Handle work orders from submission to completion with ease." },
            { icon: "⚡", title: "Utility Management", desc: "Track and pay utility bills with full audit logs." },
            { icon: "📊", title: "Full Accounting", desc: "General ledger, bank reconciliation, and financial reports." },
          ].map(f => (
            <div key={f.title} className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <div className="text-3xl mb-3">{f.icon}</div>
              <div className="font-semibold text-gray-800 mb-1">{f.title}</div>
              <div className="text-sm text-gray-500">{f.desc}</div>
            </div>
          ))}
        </div>
      </div>
      <footer className="border-t border-gray-100 px-8 py-6 text-center text-xs text-gray-400">
        © 2025 PropManager. All rights reserved.
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
    if (password.length < 6) { setError("Password must be at least 6 characters."); return; }
    if (!name.trim()) { setError("Name is required."); return; }
    setLoading(true);
    setError("");

    // For tenant signup, validate invite code first via RPC (SECURITY DEFINER bypasses RLS)
    if (userType === "tenant") {
      if (!inviteCode.trim()) { setError("Invite code is required."); setLoading(false); return; }
      const { data: rpcResult, error: rpcErr } = await supabase.rpc("validate_invite_code", { p_code: inviteCode.trim().toUpperCase() });
      if (rpcErr || !rpcResult?.valid) { setError("Invalid or expired invite code."); setLoading(false); return; }
    }

    const { data: signupData, error: signupErr } = await supabase.auth.signUp({
      email, password,
      options: { data: { name: name.trim(), user_type: userType } }
    });
    if (signupErr) { setError(signupErr.message); setLoading(false); return; }

    // Save user_type to app_users
    await supabase.from("app_users").upsert([{
      email: email.toLowerCase(), name: name.trim(), role: userType === "tenant" ? "tenant" : userType === "owner" ? "owner" : "pm",
      user_type: userType,
    }], { onConflict: "email" });

    // For tenant, redeem invite code atomically via RPC (SECURITY DEFINER, prevents race condition)
    if (userType === "tenant") {
      const { data: rpcResult, error: rpcErr } = await supabase.rpc("redeem_invite_code", {
        p_code: inviteCode.trim().toUpperCase(),
        p_email: email,
        p_name: name.trim(),
      });
      if (rpcErr || !rpcResult?.success) {
        // Redemption failed — likely race condition (code used between validate and redeem)
        // Account was already created but has no company access
        setError("Your account was created, but the invite code could not be redeemed (it may have already been used). Please contact your landlord or property manager for a new invite code. You can log in and enter a new code later.");
        setLoading(false);
        return;
      }
    }

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
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 w-full max-w-sm text-center">
            <div className="text-4xl mb-3">✅</div>
            <h2 className="text-xl font-bold text-gray-800 mb-2">Account Created!</h2>
            <p className="text-sm text-gray-500 mb-4">Check your email for a confirmation link. Once confirmed, you can sign in.</p>
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
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 w-full max-w-sm">
          {isSignup && (
            <div className="text-center mb-4">
              <span className="text-3xl">{typeInfo.icon}</span>
              <h2 className="text-xl font-bold text-gray-800 mt-2">{typeInfo.title}</h2>
              <p className="text-sm text-gray-400">{typeInfo.subtitle}</p>
            </div>
          )}
          {!isSignup && (
            <>
              <h2 className="text-2xl font-bold text-gray-800 mb-1">Welcome back</h2>
              <p className="text-sm text-gray-400 mb-6">Sign in to your account</p>
            </>
          )}
          {error && <div className="bg-red-50 text-red-600 text-xs rounded-lg px-3 py-2 mb-4">{error}</div>}

          {isSignup && (
            <div className="mb-4">
              <label className="text-xs font-medium text-gray-600 block mb-1">Full Name</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="John Smith" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-indigo-400" />
            </div>
          )}
          <div className="mb-4">
            <label className="text-xs font-medium text-gray-600 block mb-1">Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-indigo-400" />
          </div>
          <div className="mb-4">
            <label className="text-xs font-medium text-gray-600 block mb-1">Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-indigo-400" onKeyDown={e => e.key === "Enter" && (isSignup ? handleSignup(mode.replace("signup_", "")) : handleLogin())} />
          </div>

          {mode === "signup_tenant" && (
            <div className="mb-4">
              <label className="text-xs font-medium text-gray-600 block mb-1">Invite Code *</label>
              <input value={inviteCode} onChange={e => setInviteCode(e.target.value.toUpperCase())} placeholder="e.g. TNT-38472916" className="w-full border border-amber-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-amber-500 bg-amber-50 font-mono tracking-wider" />
              <p className="text-xs text-gray-400 mt-1">Check your invite email from your landlord or property manager</p>
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

  const [rentPostLoading, setRentPostLoading] = useState(false);
  const [lastRentPost, setLastRentPost] = useState(null);

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
      const { data: managedProps } = await supabase.from("properties").select("*").eq("pm_company_id", companyId || "sandbox-llc");
      const allProps = [...(p.data || [])];
      (managedProps || []).forEach(mp => { if (!allProps.find(x => x.id === mp.id)) allProps.push(mp); });
      setProperties(allProps);
      setTenants(t.data || []);
      setWorkOrders(w.data || []);
      setPayments(pay.data || []);
      setUtilities(u.data || []);
      // Pull financials from accounting (source of truth)
      try {
        const { data: jeHeaders } = await supabase.from("acct_journal_entries").select("id").eq("company_id", companyId || "sandbox-llc").eq("status", "posted");
        const jeIds = (jeHeaders || []).map(j => j.id);
        const { data: jeLines } = jeIds.length > 0 ? await supabase.from("acct_journal_lines").select("account_id, debit, credit").in("journal_entry_id", jeIds) : { data: [] };
        const { data: accounts } = await supabase.from("acct_accounts").select("id, type").eq("company_id", companyId || "sandbox-llc");
        if (jeLines && accounts) {
          const acctMap = {};
          accounts.forEach(a => { acctMap[a.id] = a.type; });
          let rev = 0, exp = 0;
          jeLines.forEach(l => {
            const type = acctMap[l.account_id];
            if (type === "Revenue") rev += safeNum(l.credit) - safeNum(l.debit);
            if (type === "Expense") exp += safeNum(l.debit) - safeNum(l.credit);
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
  const totalRent = payments.filter(p => p.type === "rent" && p.status === "paid").reduce((s, p) => s + safeNum(p.amount), 0);
  const delinquent = tenants.filter(t => t.balance > 0).length;
  const openWO = workOrders.filter(w => w.status !== "completed").length;

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Dashboard</h2>
        <button onClick={async () => {
          setRentPostLoading(true);
          try {
            // Try server-side batch function first (atomic, no N+1)
            const { data: rpcResult, error: rpcErr } = await supabase.rpc("batch_post_rent_charges", { p_company_id: companyId || "sandbox-llc" });
            if (rpcErr) {
              // Fallback to client-side if RPC not yet deployed
              console.warn("Batch RPC not available, using client-side:", rpcErr.message);
              await autoPostRentCharges(companyId);
            } else {
              const count = rpcResult?.charges_posted || 0;
              if (count > 0) addNotification("⚡", `Posted ${count} rent charge(s) for this month`);
            }
          } catch (e) {
            console.warn("Rent posting error:", e);
            await autoPostRentCharges(companyId);
          }
          setLastRentPost(new Date().toLocaleTimeString());
          setRentPostLoading(false);
          // Refresh data
          const { data: refreshPay } = await companyQuery("payments", companyId);
          setPayments(refreshPay || []);
          const { data: refreshT } = await companyQuery("tenants", companyId);
          setTenants(refreshT || []);
        }} disabled={rentPostLoading} className="flex items-center gap-2 bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-50">
          {rentPostLoading ? "Processing..." : "⚡ Run Monthly Charges"}
          {lastRentPost && <span className="text-xs text-indigo-200">Last: {lastRentPost}</span>}
        </button>
      </div>

      {/* Notifications Banner */}
      {notifications.length > 0 && (
        <div className="mb-5 space-y-2">
          {notifications.slice(0, 3).map(n => (
            <div key={n.id} className="bg-indigo-50 border border-indigo-100 rounded-xl px-4 py-3 flex items-center justify-between">
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
        <StatCard label="Occupancy" value={`${occupied}/${properties.length}`} sub={`${properties.length ? Math.round(occupied / properties.length * 100) : 0}% occupied`} color="text-green-600" />
        <StatCard label="Revenue (Acctg)" value={`$${acctRevenue.toLocaleString()}`} sub="from journal entries" color="text-blue-600" />
        <StatCard label="Expenses (Acctg)" value={`$${acctExpenses.toLocaleString()}`} sub="from journal entries" color="text-red-500" />
        <StatCard label="Net Income" value={`$${(acctRevenue - acctExpenses).toLocaleString()}`} sub="revenue - expenses" color={acctRevenue - acctExpenses >= 0 ? "text-emerald-600" : "text-red-600"} />
      </div>
      <div className="grid grid-cols-2 gap-3 mb-6 md:grid-cols-4">
        <StatCard label="Rent Collected" value={`$${totalRent.toLocaleString()}`} sub="payments table" color="text-indigo-600" />
        <StatCard label="Delinquent" value={delinquent} sub="tenants with balance" color="text-orange-500" />
        <StatCard label="Open Work Orders" value={openWO} sub={`${workOrders.filter(w => w.priority === "emergency").length} emergency`} color="text-orange-500" />
        <StatCard label="Pending Utilities" value={utilities.filter(u => u.status === "pending").length} sub="awaiting payment" color="text-yellow-600" />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <h3 className="font-semibold text-gray-700 mb-3">Lease Expirations</h3>
          {tenants.filter(t => t.move_out).map(t => (
            <div key={t.id} className="flex justify-between items-center py-2 border-b border-gray-50 last:border-0">
              <div>
                <div className="text-sm font-medium text-gray-800">{t.name}</div>
                <div className="text-xs text-gray-400">{t.property}</div>
              </div>
              <div className="text-sm text-orange-500 font-semibold">{t.move_out}</div>
            </div>
          ))}
          {tenants.filter(t => t.move_out).length === 0 && <div className="text-sm text-gray-400 text-center py-4">No upcoming expirations</div>}
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <h3 className="font-semibold text-gray-700 mb-3">Recent Maintenance</h3>
          {workOrders.slice(0, 3).map(w => (
            <div key={w.id} className="flex justify-between items-center py-2 border-b border-gray-50 last:border-0">
              <div>
                <div className="text-sm font-medium text-gray-800">{w.issue}</div>
                <div className="text-xs text-gray-400">{w.property}</div>
              </div>
              <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${priorityColors[w.priority]}`}>{w.priority}</span>
            </div>
          ))}
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <h3 className="font-semibold text-gray-700 mb-3">Utilities Due</h3>
          {utilities.filter(u => u.status === "pending").map(u => (
            <div key={u.id} className="flex justify-between items-center py-2 border-b border-gray-50 last:border-0">
              <div>
                <div className="text-sm font-medium text-gray-800">{u.provider}</div>
                <div className="text-xs text-gray-400">{u.property} · {u.responsibility}</div>
              </div>
              <div className="text-right">
                <div className="text-sm font-semibold text-gray-800">${u.amount}</div>
                <Badge status={u.status} />
              </div>
            </div>
          ))}
          {utilities.filter(u => u.status === "pending").length === 0 && <div className="text-sm text-gray-400 text-center py-4">No pending utilities</div>}
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <h3 className="font-semibold text-gray-700 mb-3">Net Operating Income</h3>
          <div className="space-y-2">
            {[
              ["Gross Rent Collected", `$${totalRent.toLocaleString()}`, "text-green-600"],
              ["Maintenance Costs", `-$${workOrders.reduce((s, w) => s + safeNum(w.cost), 0).toLocaleString()}`, "text-red-500"],
              ["Utility Expenses", `-$${utilities.reduce((s, u) => s + safeNum(u.amount), 0).toLocaleString()}`, "text-red-500"],
              ["NOI", `$${(totalRent - workOrders.reduce((s, w) => s + safeNum(w.cost), 0) - utilities.reduce((s, u) => s + safeNum(u.amount), 0)).toLocaleString()}`, "text-blue-700 font-bold"],
            ].map(([l, v, c]) => (
              <div key={l} className="flex justify-between">
                <span className="text-sm text-gray-600">{l}</span>
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
  const [form, setForm] = useState({ address: "", type: "Single Family", status: "vacant", rent: "", tenant: "", lease_end: "", notes: "" });
  // Approval workflow
  const [changeRequests, setChangeRequests] = useState([]);
  const [showRequests, setShowRequests] = useState(false);
  const [reviewNotes, setReviewNotes] = useState({});

  const isAdmin = userRole === "admin";

  useEffect(() => { fetchProperties(); fetchChangeRequests(); }, []);

  async function fetchProperties() {
    // Fetch properties owned by this company
    const { data: ownedProps } = await supabase.from("properties").select("*").eq("company_id", companyId || "sandbox-llc");
    // Also fetch properties where this company is assigned as PM (cross-company)
    const { data: managedProps } = await supabase.from("properties").select("*").eq("pm_company_id", companyId || "sandbox-llc");
    // Merge and deduplicate
    const allProps = [...(ownedProps || [])];
    (managedProps || []).forEach(mp => {
      if (!allProps.find(p => p.id === mp.id)) allProps.push(mp);
    });
    setProperties(allProps);
    setLoading(false);
  }

  async function fetchChangeRequests() {
    const { data } = await supabase.from("property_change_requests").select("*").eq("company_id", companyId || "sandbox-llc").order("requested_at", { ascending: false });
    setChangeRequests(data || []);
  }

  async function saveProperty() {
    if (!form.address.trim()) { alert("Property address is required."); return; }
    if (!form.rent || isNaN(Number(form.rent))) { alert("Please enter a valid rent amount."); return; }

    if (isAdmin) {
      // Admin: direct save
      const { error } = editingProperty
        ? await supabase.from("properties").update({ address: form.address, type: form.type, status: form.status, rent: form.rent, tenant: form.tenant, lease_end: form.lease_end, notes: form.notes }).eq("id", editingProperty.id).eq("company_id", companyId || "sandbox-llc")
        : await supabase.from("properties").insert([{ ...form, company_id: companyId || "sandbox-llc" }]);
      if (error) { alert("Error saving property: " + error.message); return; }
      // Auto-create accounting class for new properties
      if (!editingProperty) {
        const classId = generateId("PROP");
        await supabase.from("acct_classes").upsert([{ id: classId, name: form.address, description: `${form.type} · $${form.rent}/mo`, color: ["#3B82F6","#10B981","#F59E0B","#EF4444","#8B5CF6","#06B6D4"][Math.floor(Math.random()*6)], is_active: true, company_id: companyId || "sandbox-llc" }], { onConflict: "id" });
      }
      addNotification("🏠", editingProperty ? `Property updated: ${form.address}` : `New property added: ${form.address}`);
      logAudit(editingProperty ? "update" : "create", "properties", `${editingProperty ? "Updated" : "Added"} property: ${form.address}`, editingProperty?.id || "", userProfile?.email, userRole, companyId);
    } else {
      // Non-admin: submit change request
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase.from("property_change_requests").insert([{ company_id: companyId || "sandbox-llc",
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
    setForm({ address: "", type: "Single Family", status: "vacant", rent: "", tenant: "", lease_end: "", notes: "" });
    fetchProperties();
  }

  async function deleteProperty(id, address) {
    if (!isAdmin) { alert("Only admins can delete properties."); return; }
    if (!window.confirm(`Delete property "${address}"? This cannot be undone.`)) return;
    const { error } = await supabase.from("properties").delete().eq("id", id).eq("company_id", companyId || "sandbox-llc");
    if (error) { alert("Error deleting property: " + error.message); return; }
    addNotification("🗑️", `Property deleted: ${address}`);
    logAudit("delete", "properties", `Deleted property: ${address}`, id, userProfile?.email, userRole, companyId);
  }

  // Admin: approve change request
  async function approveRequest(req) {
    if (req.request_type === "add") {
      await supabase.from("properties").insert([{ company_id: companyId || "sandbox-llc", address: req.address, type: req.type, status: req.property_status, rent: req.rent, tenant: req.tenant, lease_end: req.lease_end, notes: req.notes }]);
      // Auto-create accounting class for this property
      const classId = generateId("PROP");
      await supabase.from("acct_classes").upsert([{ id: classId, name: req.address, description: `${req.type} · $${req.rent}/mo`, color: ["#3B82F6","#10B981","#F59E0B","#EF4444","#8B5CF6","#06B6D4","#F97316","#EC4899"][Math.floor(Math.random()*8)], is_active: true, company_id: companyId || "sandbox-llc" }], { onConflict: "id" });
      addNotification("✅", `Property approved & added: ${req.address}`);
    } else if (req.request_type === "edit" && req.property_id) {
      await supabase.from("properties").update({ address: req.address, type: req.type, status: req.property_status, rent: req.rent, tenant: req.tenant, lease_end: req.lease_end, notes: req.notes }).eq("id", req.property_id).eq("company_id", companyId || "sandbox-llc");
      addNotification("✅", `Property edit approved: ${req.address}`);
    }
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("property_change_requests").update({ status: "approved", reviewed_by: user?.email || "admin", reviewed_at: new Date().toISOString(), review_note: reviewNotes[req.id] || "" }).eq("id", req.id);
    logAudit("approve", "properties", `Approved ${req.request_type} request: ${req.address} (requested by ${req.requested_by})`, req.id, user?.email, "admin", companyId);
    setReviewNote("");
    fetchProperties();
    fetchChangeRequests();
  }

  // Admin: reject change request
  async function rejectRequest(req) {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("property_change_requests").update({ status: "rejected", reviewed_by: user?.email || "admin", reviewed_at: new Date().toISOString(), review_note: reviewNotes[req.id] || "" }).eq("id", req.id);
    addNotification("❌", `Property request rejected: ${req.address}`);
    logAudit("reject", "properties", `Rejected ${req.request_type} request: ${req.address} (requested by ${req.requested_by})`, req.id, user?.email, "admin", companyId);
    setReviewNote("");
    fetchChangeRequests();
  }

  // Timeline (same as before)
  async function loadTimeline(p) {
    setTimelineProperty(p);
    const [pay, wo, docs] = await Promise.all([
      supabase.from("payments").select("*").eq("company_id", companyId || "sandbox-llc").eq("property", p.address),
      supabase.from("work_orders").select("*").eq("company_id", companyId || "sandbox-llc").eq("property", p.address),
      supabase.from("documents").select("*").eq("company_id", companyId || "sandbox-llc").eq("property", p.address),
    ]);
    const all = [
      ...(pay.data || []).map(x => ({ ...x, _type: "payment", _date: x.date })),
      ...(wo.data || []).map(x => ({ ...x, _type: "work_order", _date: x.created_at })),
      ...(docs.data || []).map(x => ({ ...x, _type: "document", _date: x.created_at })),
    ].sort((a, b) => new Date(b._date) - new Date(a._date));
    setTimelineData(all);
  }

  async function assignPM(property) {
    if (!pmCode.trim()) { alert("Please enter the PM company's 8-digit code."); return; }
    const { data: pmCompany } = await supabase.from("companies").select("*").eq("company_code", pmCode.trim()).maybeSingle();
    if (!pmCompany) { alert("No company found with code: " + pmCode); return; }
    if (pmCompany.company_role !== "management") { alert(pmCompany.name + " is not a management company. Only management companies can be assigned as PM."); return; }
    if (!window.confirm("Assign " + pmCompany.name + " as property manager for " + property.address + "?\n\nThey will get operational control of this property. You can remove them later.")) return;
    await supabase.from("properties").update({ pm_company_id: pmCompany.id, pm_company_name: pmCompany.name }).eq("id", property.id).eq("company_id", companyId || "sandbox-llc");
    // Also add this property to the PM's company scope by inserting a shadow record or just let them query cross-company
    addNotification("🏢", pmCompany.name + " assigned as PM for " + property.address);
    logAudit("update", "properties", "Assigned PM: " + pmCompany.name + " to " + property.address, property.id, userProfile?.email, userRole, companyId);
    setShowPmAssign(null);
    setPmCode("");
    fetchProperties();
  }

  async function removePM(property) {
    if (!window.confirm("Remove " + (property.pm_company_name || "PM") + " as property manager for " + property.address + "?\n\nYou will regain full operational control.")) return;
    await supabase.from("properties").update({ pm_company_id: null, pm_company_name: null }).eq("id", property.id).eq("company_id", companyId || "sandbox-llc");
    addNotification("🏠", "PM removed from " + property.address + ". You now have full control.");
    logAudit("update", "properties", "Removed PM from " + property.address, property.id, userProfile?.email, userRole, companyId);
    fetchProperties();
  }

  // Check if current company is an owner company viewing a PM-managed property
  function isReadOnly(property) {
    // Property is read-only if it belongs to another company (PM viewing managed property)
    return property.company_id !== (companyId || "sandbox-llc");
  }

  const [viewMode, setViewMode] = useState("card");
  const [filterType, setFilterType] = useState("all");
  const [visibleCols, setVisibleCols] = useState(["address","type","status","rent","tenant","lease_end"]);
  const [showColPicker, setShowColPicker] = useState(false);
  const [showPmAssign, setShowPmAssign] = useState(null);
  const [pmCode, setPmCode] = useState("");
  const allCols = [
    { id: "address", label: "Address" }, { id: "type", label: "Type" }, { id: "status", label: "Status" },
    { id: "rent", label: "Rent" }, { id: "tenant", label: "Tenant" }, { id: "lease_end", label: "Lease End" },
    { id: "notes", label: "Notes" }, { id: "owner_name", label: "Owner" },
  ];
  const propertyTypes = [...new Set(properties.map(p => p.type).filter(Boolean))];
  const pendingRequests = changeRequests.filter(r => r.status === "pending");

  if (loading) return <Spinner />;
  const filtered = properties.filter(p =>
    (filter === "all" || p.status === filter) &&
    (filterType === "all" || p.type === filterType) &&
    (p.address?.toLowerCase().includes(search.toLowerCase()) || p.type?.toLowerCase().includes(search.toLowerCase()) || p.tenant?.toLowerCase()?.includes(search.toLowerCase()))
  );

  return (
    <div>
      <h2 className="text-xl font-bold text-gray-800 mb-4">Properties</h2>

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
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 mb-4 space-y-3">
          <h3 className="font-semibold text-gray-800">Pending Approval</h3>
          {pendingRequests.map(req => (
            <div key={req.id} className="border border-amber-100 rounded-xl p-4 bg-amber-50/30">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${req.request_type === "add" ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700"}`}>{req.request_type === "add" ? "New" : "Edit"}</span>
                    <span className="text-xs text-gray-400">by {req.requested_by}</span>
                  </div>
                  <p className="font-semibold text-gray-800">{req.address}</p>
                  <p className="text-xs text-gray-500 mt-1">{req.type} · ${req.rent}/mo</p>
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  <input value={reviewNotes[req.id] || ""} onChange={e => setReviewNotes(prev => ({...prev, [req.id]: e.target.value}))} placeholder="Note" className="border border-gray-200 rounded-lg px-2 py-1 text-xs w-32" />
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
        <input placeholder="Search properties..." value={search} onChange={e => setSearch(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm flex-1" />
        <select value={filter} onChange={e => setFilter(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
          <option value="all">All Status</option><option value="occupied">Occupied</option><option value="vacant">Vacant</option><option value="maintenance">Maintenance</option>
        </select>
        <select value={filterType} onChange={e => setFilterType(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
          <option value="all">All Types</option>
          {propertyTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <div className="flex bg-gray-100 rounded-lg p-0.5">
          {[["card","▦"],["table","☰"],["compact","≡"]].map(([m,icon]) => (
            <button key={m} onClick={() => setViewMode(m)} className={`px-3 py-1.5 text-sm rounded-md ${viewMode === m ? "bg-white shadow-sm text-indigo-700 font-semibold" : "text-gray-500"}`} title={m}>{icon}</button>
          ))}
        </div>
        {viewMode === "table" && (
          <div className="relative">
            <button onClick={() => setShowColPicker(!showColPicker)} className="border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-500 hover:bg-gray-50">⚙️ Columns</button>
            {showColPicker && (
              <div className="absolute right-0 top-10 bg-white border border-gray-200 rounded-xl shadow-lg p-3 z-50 w-48">
                {allCols.map(c => (
                  <label key={c.id} className="flex items-center gap-2 py-1 text-xs text-gray-700 cursor-pointer">
                    <input type="checkbox" checked={visibleCols.includes(c.id)} onChange={() => setVisibleCols(prev => prev.includes(c.id) ? prev.filter(x => x !== c.id) : [...prev, c.id])} className="rounded" />
                    {c.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        <button onClick={() => { setEditingProperty(null); setForm({ address: "", type: "Single Family", status: "vacant", rent: "", tenant: "", lease_end: "", notes: "" }); setShowForm(!showForm); }} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700 whitespace-nowrap">
          {isAdmin ? "+ Add" : "+ Request"}
        </button>
      </div>

      {showForm && (
        <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm mb-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">{editingProperty ? "Edit Property" : "Add Property"}</h3>
          {!isAdmin && <p className="text-xs text-blue-600 bg-blue-50 rounded-lg px-3 py-2 mb-3">Submitted for admin approval.</p>}
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Address" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm col-span-2" />
            <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm"><option>Single Family</option><option>Multi-Family</option><option>Apartment</option><option>Townhouse</option><option>Commercial</option></select>
            <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm"><option value="vacant">Vacant</option><option value="occupied">Occupied</option><option value="maintenance">Maintenance</option></select>
            <input placeholder="Rent" value={form.rent} onChange={e => setForm({ ...form, rent: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Tenant" value={form.tenant} onChange={e => setForm({ ...form, tenant: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input type="date" value={form.lease_end} onChange={e => setForm({ ...form, lease_end: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <textarea placeholder="Notes" value={form.notes || ""} onChange={e => setForm({ ...form, notes: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm col-span-2" rows={2} />
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={saveProperty} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg">{isAdmin ? "Save" : "Submit"}</button>
            <button onClick={() => { setShowForm(false); setEditingProperty(null); }} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex gap-3 mb-4">
        <div className="bg-white rounded-xl border border-gray-100 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-gray-800">{properties.length}</div><div className="text-xs text-gray-400">Total</div></div>
        <div className="bg-white rounded-xl border border-gray-100 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-emerald-600">{properties.filter(p => p.status === "occupied").length}</div><div className="text-xs text-gray-400">Occupied</div></div>
        <div className="bg-white rounded-xl border border-gray-100 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-amber-600">{properties.filter(p => p.status === "vacant").length}</div><div className="text-xs text-gray-400">Vacant</div></div>
        <div className="bg-white rounded-xl border border-gray-100 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-indigo-600">${properties.reduce((s, p) => s + safeNum(p.rent), 0).toLocaleString()}</div><div className="text-xs text-gray-400">Total Rent</div></div>
      </div>

      {viewMode === "card" && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(p => (
            <div key={p.id} className={`bg-white rounded-xl border shadow-sm p-4 ${isReadOnly(p) ? "border-purple-200 bg-purple-50/30" : "border-gray-100"}`}>
              <div className="flex items-start justify-between mb-2">
                <div>
                  <h3 className="font-semibold text-gray-800 text-sm">{p.address}</h3>
                  <p className="text-xs text-gray-400">{p.type}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge status={p.status} label={p.status} />
                  {p.pm_company_name && <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">PM: {p.pm_company_name}</span>}
                </div>
              </div>
              <div className="text-sm text-gray-600 space-y-1">
                <div className="flex justify-between"><span>Rent:</span><span className="font-semibold">${safeNum(p.rent).toLocaleString()}</span></div>
                {p.tenant && <div className="flex justify-between"><span>Tenant:</span><span>{p.tenant}</span></div>}
                {p.lease_end && <div className="flex justify-between"><span>Lease End:</span><span>{p.lease_end}</span></div>}
              </div>
              {isReadOnly(p) && <div className="mt-2 text-xs text-purple-600 bg-purple-50 rounded-lg px-2 py-1">🔒 Managed property — view only</div>}
              <div className="flex gap-2 mt-3 pt-3 border-t border-gray-50 flex-wrap">
                {!isReadOnly(p) && <button onClick={() => { setEditingProperty(p); setForm({ address: p.address, type: p.type, status: p.status, rent: p.rent || "", tenant: p.tenant || "", lease_end: p.lease_end || "", notes: p.notes || "" }); setShowForm(true); }} className="text-xs text-indigo-600 hover:underline">Edit</button>}
                {!isReadOnly(p) && isAdmin && <button onClick={() => deleteProperty(p.id, p.address)} className="text-xs text-red-500 hover:underline">Delete</button>}
                {!p.pm_company_id && !isReadOnly(p) && isAdmin && <button onClick={() => { setShowPmAssign(p); setPmCode(""); }} className="text-xs text-purple-600 hover:underline">Assign PM</button>}
                {p.pm_company_id && !isReadOnly(p) && isAdmin && <button onClick={() => removePM(p)} className="text-xs text-orange-600 hover:underline">Remove PM</button>}
                <button onClick={() => loadTimeline(p)} className="text-xs text-gray-400 hover:underline ml-auto">Timeline</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {viewMode === "table" && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-400 uppercase">
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
                <tr key={p.id} className="border-t border-gray-50 hover:bg-gray-50/50">
                  {visibleCols.includes("address") && <td className="px-4 py-2.5 font-medium text-gray-800">{p.address}</td>}
                  {visibleCols.includes("type") && <td className="px-4 py-2.5 text-gray-600">{p.type}</td>}
                  {visibleCols.includes("status") && <td className="px-4 py-2.5"><Badge status={p.status} label={p.status} /></td>}
                  {visibleCols.includes("rent") && <td className="px-4 py-2.5 text-right font-semibold">${safeNum(p.rent).toLocaleString()}</td>}
                  {visibleCols.includes("tenant") && <td className="px-4 py-2.5 text-gray-600">{p.tenant || "—"}</td>}
                  {visibleCols.includes("lease_end") && <td className="px-4 py-2.5 text-gray-500">{p.lease_end || "—"}</td>}
                  {visibleCols.includes("owner_name") && <td className="px-4 py-2.5 text-gray-600">{p.owner_name || "—"}</td>}
                  {visibleCols.includes("notes") && <td className="px-4 py-2.5 text-xs text-gray-400 max-w-32 truncate">{p.notes || "—"}</td>}
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    {p.pm_company_name && <span className="text-xs bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded mr-2">PM</span>}
                    {isReadOnly(p) && <span className="text-xs text-purple-500 mr-2">🔒 view only</span>}
                    {!isReadOnly(p) && <button onClick={() => { setEditingProperty(p); setForm({ address: p.address, type: p.type, status: p.status, rent: p.rent || "", tenant: p.tenant || "", lease_end: p.lease_end || "", notes: p.notes || "" }); setShowForm(true); }} className="text-xs text-indigo-600 hover:underline mr-2">Edit</button>}
                    {!isReadOnly(p) && isAdmin && <button onClick={() => deleteProperty(p.id, p.address)} className="text-xs text-red-500 hover:underline mr-2">Del</button>}
                    {!p.pm_company_id && !isReadOnly(p) && isAdmin && <button onClick={() => { setShowPmAssign(p); setPmCode(""); }} className="text-xs text-purple-600 hover:underline mr-2">PM</button>}
                    {p.pm_company_id && !isReadOnly(p) && isAdmin && <button onClick={() => removePM(p)} className="text-xs text-orange-600 hover:underline mr-2">-PM</button>}
                    <button onClick={() => loadTimeline(p)} className="text-xs text-gray-400 hover:underline">TL</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && <div className="text-center py-8 text-gray-400 text-sm">No properties found</div>}
        </div>
      )}

      {viewMode === "compact" && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm divide-y divide-gray-50">
          {filtered.map(p => (
            <div key={p.id} className={`flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50/50 ${isReadOnly(p) ? "bg-purple-50/30" : ""}`}>
              <div className={`w-2 h-2 rounded-full ${p.status === "occupied" ? "bg-emerald-500" : p.status === "vacant" ? "bg-amber-500" : "bg-red-500"}`} />
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-gray-800">{p.address}</span>
                <span className="text-xs text-gray-400 ml-2">{p.type}</span>
                {p.pm_company_name && <span className="text-xs bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded ml-2">PM: {p.pm_company_name}</span>}
              </div>
              <span className="text-sm font-semibold text-gray-700">${safeNum(p.rent).toLocaleString()}</span>
              <span className="text-xs text-gray-500 w-28 truncate">{p.tenant || "—"}</span>
              <Badge status={p.status} label={p.status} />
              {!isReadOnly(p) && <button onClick={() => { setEditingProperty(p); setForm({ address: p.address, type: p.type, status: p.status, rent: p.rent || "", tenant: p.tenant || "", lease_end: p.lease_end || "", notes: p.notes || "" }); setShowForm(true); }} className="text-xs text-indigo-600 hover:underline">Edit</button>}
              {isReadOnly(p) && <span className="text-xs text-purple-400">🔒</span>}
            </div>
          ))}
          {filtered.length === 0 && <div className="text-center py-8 text-gray-400 text-sm">No properties found</div>}
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
              <label className="text-xs font-medium text-gray-600 block mb-1">PM Company's 8-Digit Code</label>
              <input value={pmCode} onChange={e => setPmCode(e.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="e.g. 12345678" maxLength={8} className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono tracking-wider" />
              <p className="text-xs text-gray-400 mt-1">Ask the property manager for their company code</p>
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
                  <p className="text-sm font-medium text-gray-800">{item._type === "payment" ? `$${item.amount} - ${item.type}` : item._type === "work_order" ? item.issue : item.name}</p>
                  <p className="text-xs text-gray-400">{new Date(item._date).toLocaleDateString()}</p>
                </div>
              </div>
            ))}
            {timelineData.length === 0 && <p className="text-sm text-gray-400 text-center py-4">No activity found.</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}


// ============ TENANTS ============
function Tenants({ addNotification, userProfile, userRole, companyId }) {
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
  const [form, setForm] = useState({ name: "", email: "", phone: "", property: "", lease_status: "active", move_in: "", move_out: "", rent: "" });
  const [tenantView, setTenantView] = useState("card");
  const [tenantSearch, setTenantSearch] = useState("");
  const [tenantFilter, setTenantFilter] = useState("all");
  const [leaseModal, setLeaseModal] = useState(null); // 'renew' | 'notice'
  const [leaseInput, setLeaseInput] = useState("");
  // eslint-disable-next-line no-unused-vars
  const [error, setError] = useState("");

  useEffect(() => {
    fetchTenants();
    supabase.from("properties").select("*").eq("company_id", companyId || "sandbox-llc").then(({ data }) => setProperties(data || []));
  }, []);

  async function fetchTenants() {
    const { data } = await supabase.from("tenants").select("*").eq("company_id", companyId || "sandbox-llc");
    setTenants(data || []);
    setLoading(false);
  }

  async function saveTenant() {
    if (!form.name.trim()) { alert("Tenant name is required."); return; }
    if (!form.email.trim()) { alert("Tenant email is required."); return; }
    if (!form.property) { alert("Please select a property."); return; }
    const { error } = editingTenant
      ? await supabase.from("tenants").update({ name: form.name, email: form.email, phone: form.phone, property: form.property, lease_status: form.lease_status, move_in: form.move_in, move_out: form.move_out, rent: form.rent }).eq("id", editingTenant.id).eq("company_id", companyId || "sandbox-llc")
      : await supabase.from("tenants").insert([{ company_id: companyId || "sandbox-llc", ...form, balance: 0 }]);
    if (error) { alert("Error saving tenant: " + error.message); return; }
    if (editingTenant) {
      addNotification("👤", `Tenant updated: ${form.name}`);
      logAudit("update", "tenants", `Updated tenant: ${form.name}`, editingTenant?.id, userProfile?.email, userRole, companyId);
    } else {
      addNotification("👤", `New tenant added: ${form.name}`);
      logAudit("create", "tenants", `Added tenant: ${form.name} at ${form.property}`, "", userProfile?.email, userRole, companyId);
    }
    setShowForm(false);
    setEditingTenant(null);
    setForm({ name: "", email: "", phone: "", property: "", lease_status: "active", move_in: "", move_out: "", rent: "" });
    fetchTenants();
  }

  async function deleteTenant(id, name) {
    if (!window.confirm(`Delete tenant "${name}"? This cannot be undone.`)) return;
    const { error } = await supabase.from("tenants").delete().eq("id", id).eq("company_id", companyId || "sandbox-llc");
    if (error) { alert("Error deleting tenant: " + error.message); return; }
    addNotification("🗑️", `Tenant deleted: ${name}`);
    logAudit("delete", "tenants", `Deleted tenant: ${name}`, id, userProfile?.email, userRole, companyId);
    fetchTenants();
  }

  async function inviteTenant(tenant) {
    if (!tenant.email) { alert("This tenant has no email address. Please add one first."); return; }
    if (!window.confirm("Send portal invite to " + tenant.email + "?\n\nThis will:\n1. Generate a unique invite code for this tenant\n2. Send a magic link to their email\n3. They can sign up using the invite code to access their portal")) return;
    try {
      // Generate unique invite code
      const codeArr = new Uint32Array(1); crypto.getRandomValues(codeArr); const code = "TNT-" + String(10000000 + (codeArr[0] % 89999999));
      await supabase.from("tenant_invite_codes").insert([{
        code: code,
        company_id: companyId || "sandbox-llc",
        property: tenant.property || "",
        tenant_id: tenant.id,
        tenant_name: tenant.name,
        tenant_email: tenant.email,
        created_by: userProfile?.email || "admin",
        used: false,
      }]);

      // Also send magic link as before
      const { error: authErr } = await supabase.auth.signInWithOtp({
        email: tenant.email,
        options: { data: { name: tenant.name, role: "tenant" } }
      });
      if (authErr) {
        console.warn("Auth invite failed:", authErr.message);
      }
      // Create app_users entry with tenant role
      // Insert only if no existing row — don't overwrite other company's data
      await supabase.from("app_users").upsert([{
        email: (tenant.email || "").toLowerCase(),
        name: tenant.name,
        role: "tenant",
        user_type: "tenant",
        company_id: companyId || "sandbox-llc",
      }], { onConflict: "email", ignoreDuplicates: true });
      // Create company_members entry so tenant is auto-routed to this company
      await supabase.from("company_members").upsert([{
        company_id: companyId || "sandbox-llc",
        user_email: (tenant.email || "").toLowerCase(),
        user_name: tenant.name,
        role: "tenant",
        status: "active",
        invited_by: userProfile?.email || "admin",
      }], { onConflict: "company_id,user_email" });
      addNotification("✉️", "Invite code generated for " + tenant.email + ": " + code);
      logAudit("create", "tenants", "Invited tenant to portal: " + tenant.email + " code: " + code, tenant.id, userProfile?.email, userRole, companyId);
      alert("Tenant invite created!\n\nInvite Code: " + code + "\n\nShare this code with " + tenant.name + ". They can sign up at your app URL by selecting 'I'm a Tenant' and entering this code.\n\nA magic link email was also sent to " + tenant.email);
    } catch (e) {
      alert("Error inviting tenant: " + e.message);
    }
  }


  function startEdit(t) {
    setEditingTenant(t);
    setForm({ name: t.name, email: t.email, phone: t.phone, property: t.property, lease_status: t.lease_status, move_in: t.move_in || "", move_out: t.move_out || "", rent: t.rent || "" });
    setShowForm(true);
  }

  async function openLedger(tenant) {
    setSelectedTenant(tenant);
    setActivePanel("ledger");
    const { data } = await supabase.from("ledger_entries").select("*").eq("company_id", companyId || "sandbox-llc").eq("tenant", tenant.name).eq("property", tenant.property || "").order("date", { ascending: false });
    setLedger(data || []);
  }

  async function openMessages(tenant) {
    setSelectedTenant(tenant);
    setActivePanel("messages");
    const { data } = await supabase.from("messages").select("*").eq("company_id", companyId || "sandbox-llc").eq("tenant", tenant.name).order("created_at", { ascending: true });
    setMessages(data || []);
    await supabase.from("messages").update({ read: true }).eq("tenant", tenant.name);
  }

  async function sendMessage() {
    if (!newMessage.trim()) return;
    await supabase.from("messages").insert([{ company_id: companyId || "sandbox-llc",
      tenant: selectedTenant.name,
      property: selectedTenant.property,
      sender: "admin",
      message: newMessage,
      read: false,
    }]);
    setNewMessage("");
    const { data } = await supabase.from("messages").select("*").eq("company_id", companyId || "sandbox-llc").eq("tenant", selectedTenant.name).order("created_at", { ascending: true });
    setMessages(data || []);
  }

  async function addLedgerEntry() {
    if (!newCharge.description || !newCharge.amount) return;
    const amount = newCharge.type === "payment" || newCharge.type === "credit"
      ? -Math.abs(Number(newCharge.amount))
      : Math.abs(Number(newCharge.amount));
    const currentBalance = ledger.length > 0 ? ledger[0].balance : 0;
    const newBalance = currentBalance + amount;
    const ledgerOk = await safeLedgerInsert({ company_id: companyId || "sandbox-llc",
      tenant: selectedTenant.name,
      property: selectedTenant.property,
      date: formatLocalDate(new Date()),
      description: newCharge.description,
      amount,
      type: newCharge.type,
      balance: newBalance,
    });
    if (!ledgerOk) { alert("Failed to create ledger entry. Please try again."); return; }
    // Atomic balance update (prevents drift from concurrent writes)
    try {
      await supabase.rpc("update_tenant_balance", { p_tenant_id: selectedTenant.id, p_amount_change: amount });
    } catch {
      await supabase.from("tenants").update({ balance: newBalance }).eq("company_id", companyId || "sandbox-llc").eq("id", selectedTenant.id); // balance update (unchecked ok — RPC primary)
    }
    // Post accounting JE for manual charges/credits
    if (Math.abs(amount) > 0) {
      const classId = await getPropertyClassId(selectedTenant.property, companyId);
      if (newCharge.type === "charge") {
        await autoPostJournalEntry({ companyId, date: formatLocalDate(new Date()), description: "Manual charge — " + selectedTenant.name + " — " + newCharge.description, reference: "MANUAL-" + Date.now(), property: selectedTenant.property || "",
          lines: [
            { account_id: "1100", account_name: "Accounts Receivable", debit: Math.abs(amount), credit: 0, class_id: classId, memo: selectedTenant.name + ": " + newCharge.description },
            { account_id: "4100", account_name: "Other Income", debit: 0, credit: Math.abs(amount), class_id: classId, memo: newCharge.description },
          ]
        });
      } else if (newCharge.type === "payment" || newCharge.type === "credit") {
        await autoPostJournalEntry({ companyId, date: formatLocalDate(new Date()), description: "Manual " + newCharge.type + " — " + selectedTenant.name + " — " + newCharge.description, reference: "MANUAL-" + Date.now(), property: selectedTenant.property || "",
          lines: [
            { account_id: "1000", account_name: "Checking Account", debit: Math.abs(amount), credit: 0, class_id: classId, memo: selectedTenant.name + ": " + newCharge.description },
            { account_id: "1100", account_name: "Accounts Receivable", debit: 0, credit: Math.abs(amount), class_id: classId, memo: newCharge.description },
          ]
        });
      }
    }
    setSelectedTenant({ ...selectedTenant, balance: newBalance });
    setNewCharge({ description: "", amount: "", type: "charge" });
    openLedger(selectedTenant);
    fetchTenants();
  }

  async function renewLease(newMoveOut) {
    if (!newMoveOut) return;
    const { error } = await supabase.from("tenants").update({ move_out: newMoveOut, lease_status: "active" }).eq("company_id", companyId || "sandbox-llc").eq("id", selectedTenant.id);
    if (error) { setError("Failed to renew lease: " + error.message); return; }
    // Also update active lease end_date if one exists
    const { data: activeLease } = await supabase.from("leases").select("id").eq("company_id", companyId || "sandbox-llc").eq("tenant_name", selectedTenant.name).eq("status", "active").limit(1);
    if (activeLease?.[0]) {
      await supabase.from("leases").update({ end_date: newMoveOut }).eq("company_id", companyId || "sandbox-llc").eq("id", activeLease[0].id);
    }
    addNotification("📄", `Lease extended for ${selectedTenant.name} until ${newMoveOut}`);
    setLeaseModal(null);
    fetchTenants();
    setSelectedTenant({ ...selectedTenant, move_out: newMoveOut, lease_status: "active" });
  }

  async function generateMoveOutNotice(days) {
    if (!days) return;
    const noticeDate = new Date();
    noticeDate.setDate(noticeDate.getDate() + parseInt(days));
    const moveOutDate = formatLocalDate(noticeDate);
    const { error } = await supabase.from("tenants").update({ lease_status: "notice", move_out: moveOutDate }).eq("company_id", companyId || "sandbox-llc").eq("id", selectedTenant.id);
    if (error) { setError("Failed to generate notice: " + error.message); return; }
    addNotification("📋", `${days}-day move-out notice generated for ${selectedTenant.name}`);
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
    const win = window.open("", "_blank");
    win.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Lease Agreement — ${tenant.name}</title>
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
        <div class="field"><strong>Tenant:</strong> ${tenant.name}</div>
        <div class="field"><strong>Email:</strong> ${tenant.email}</div>
        <div class="field"><strong>Property:</strong> ${tenant.property}</div>
        <h2>Lease Terms</h2>
        <div class="field"><strong>Monthly Rent:</strong> $${tenant.rent}/month</div>
        <div class="field"><strong>Move-In Date:</strong> ${tenant.move_in || "—"}</div>
        <div class="field"><strong>Move-Out Date:</strong> ${tenant.move_out || "—"}</div>
        <h2>Terms & Conditions</h2>
        <div class="clause">1. <strong>Rent Payment.</strong> Tenant agrees to pay $${tenant.rent} per month on the 1st of each month. A late fee will be applied after the grace period.</div>
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
    `);
    win.document.close();
  }

  if (loading) return <Spinner />;

  return (
    <div>
      {activePanel && selectedTenant && (
        <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex justify-end">
          <div className="bg-white w-full max-w-lg h-full flex flex-col shadow-2xl">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between bg-indigo-600 text-white">
              <div>
                <div className="font-bold">{selectedTenant.name}</div>
                <div className="text-xs text-indigo-200">{selectedTenant.property}</div>
              </div>
              <button onClick={closePanel} className="text-indigo-200 hover:text-white text-xl">✕</button>
            </div>
            <div className="flex border-b border-gray-100">
              {[["ledger", "📒 Ledger"], ["messages", "💬 Messages"], ["lease", "📄 Lease"]].map(([id, label]) => (
                <button key={id} onClick={() => {
                  setActivePanel(id);
                  if (id === "ledger") openLedger(selectedTenant);
                  if (id === "messages") openMessages(selectedTenant);
                }} className={`flex-1 py-2.5 text-xs font-medium ${activePanel === id ? "border-b-2 border-indigo-600 text-indigo-700" : "text-gray-500 hover:text-gray-700"}`}>{label}</button>
              ))}
            </div>

            {/* LEDGER */}
            {activePanel === "ledger" && (
              <div className="flex-1 overflow-y-auto p-4">
                <div className={`rounded-xl p-4 mb-4 text-center ${selectedTenant.balance > 0 ? "bg-red-50" : selectedTenant.balance < 0 ? "bg-green-50" : "bg-gray-50"}`}>
                  <div className="text-xs text-gray-400 mb-1">Current Balance</div>
                  <div className={`text-3xl font-bold ${selectedTenant.balance > 0 ? "text-red-500" : selectedTenant.balance < 0 ? "text-green-600" : "text-gray-700"}`}>
                    {selectedTenant.balance > 0 ? `-$${selectedTenant.balance}` : selectedTenant.balance < 0 ? `Credit $${Math.abs(selectedTenant.balance)}` : "$0 Current"}
                  </div>
                </div>
                <div className="bg-gray-50 rounded-xl p-3 mb-4">
                  <div className="text-xs font-semibold text-gray-600 mb-2">Add Transaction</div>
                  <div className="grid grid-cols-3 gap-2">
                    <select value={newCharge.type} onChange={e => setNewCharge({ ...newCharge, type: e.target.value })} className="border border-gray-200 rounded-lg px-2 py-2 text-xs">
                      <option value="charge">Charge</option>
                      <option value="payment">Payment</option>
                      <option value="credit">Credit</option>
                      <option value="late_fee">Late Fee</option>
                    </select>
                    <input placeholder="Description" value={newCharge.description} onChange={e => setNewCharge({ ...newCharge, description: e.target.value })} className="border border-gray-200 rounded-lg px-2 py-2 text-xs" />
                    <input placeholder="Amount" value={newCharge.amount} onChange={e => setNewCharge({ ...newCharge, amount: e.target.value })} className="border border-gray-200 rounded-lg px-2 py-2 text-xs" />
                  </div>
                  <button onClick={addLedgerEntry} className="mt-2 w-full bg-indigo-600 text-white text-xs py-2 rounded-lg hover:bg-indigo-700">Add Transaction</button>
                </div>
                <div className="space-y-2">
                  {ledger.map(e => (
                    <div key={e.id} className="bg-white border border-gray-100 rounded-lg px-3 py-2.5">
                      <div className="flex justify-between items-start">
                        <div>
                          <div className="text-sm font-medium text-gray-800">{e.description}</div>
                          <div className="text-xs text-gray-400">{e.date}</div>
                        </div>
                        <div className="text-right">
                          <div className={`text-sm font-bold ${e.amount > 0 ? "text-red-500" : "text-green-600"}`}>
                            {e.amount > 0 ? `+$${e.amount}` : `-$${Math.abs(e.amount)}`}
                          </div>
                          <div className="text-xs text-gray-400">Bal: ${e.balance}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                  {ledger.length === 0 && <div className="text-center py-6 text-gray-400 text-sm">No ledger entries yet</div>}
                </div>
              </div>
            )}

            {/* MESSAGES */}
            {activePanel === "messages" && (
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {messages.map(m => (
                    <div key={m.id} className={`flex ${m.sender === "admin" ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-xs rounded-2xl px-4 py-2.5 ${m.sender === "admin" ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-800"}`}>
                        <div className="text-sm">{m.message}</div>
                        <div className={`text-xs mt-1 ${m.sender === "admin" ? "text-indigo-200" : "text-gray-400"}`}>
                          {m.sender === "admin" ? "You" : selectedTenant.name} · {new Date(m.created_at).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                  ))}
                  {messages.length === 0 && <div className="text-center py-6 text-gray-400 text-sm">No messages yet</div>}
                </div>
                <div className="p-4 border-t border-gray-100 flex gap-2">
                  <input value={newMessage} onChange={e => setNewMessage(e.target.value)} onKeyDown={e => e.key === "Enter" && sendMessage()} placeholder="Type a message..." className="flex-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-400" />
                  <button onClick={sendMessage} className="bg-indigo-600 text-white px-4 py-2.5 rounded-xl hover:bg-indigo-700 text-sm font-medium">Send</button>
                </div>
              </div>
            )}

            {/* LEASE */}
            {activePanel === "lease" && (
              <div className="flex-1 overflow-y-auto p-4">
                <div className="bg-white border border-gray-100 rounded-xl p-4 mb-4">
                  <h4 className="font-semibold text-gray-700 mb-3">Lease Details</h4>
                  <div className="space-y-2 text-sm">
                    {[
                      ["Tenant", selectedTenant.name],
                      ["Property", selectedTenant.property],
                      ["Monthly Rent", selectedTenant.rent ? `$${selectedTenant.rent}/mo` : "—"],
                      ["Move-In Date", selectedTenant.move_in || "—"],
                      ["Move-Out Date", selectedTenant.move_out || "—"],
                      ["Lease Status", selectedTenant.lease_status],
                    ].map(([l, v]) => (
                      <div key={l} className="flex justify-between py-1.5 border-b border-gray-50">
                        <span className="text-gray-400">{l}</span>
                        <span className="font-medium text-gray-800 capitalize">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
                {leaseModal === "renew" && (
                  <div className="bg-indigo-50 rounded-xl p-4 mb-3 border border-indigo-100">
                    <div className="text-sm font-semibold text-indigo-700 mb-2">Enter New Lease End Date</div>
                    <input type="date" value={leaseInput} onChange={e => setLeaseInput(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-2" />
                    <div className="flex gap-2">
                      <button onClick={() => renewLease(leaseInput)} className="bg-indigo-600 text-white text-xs px-4 py-2 rounded-lg hover:bg-indigo-700">Confirm Renewal</button>
                      <button onClick={() => setLeaseModal(null)} className="bg-gray-200 text-gray-600 text-xs px-4 py-2 rounded-lg">Cancel</button>
                    </div>
                  </div>
                )}
                {leaseModal === "notice" && (
                  <div className="bg-orange-50 rounded-xl p-4 mb-3 border border-orange-100">
                    <div className="text-sm font-semibold text-orange-700 mb-2">Select Notice Period</div>
                    <div className="flex gap-2 mb-2">
                      <button onClick={() => setLeaseInput("30")} className={`flex-1 py-2 rounded-lg text-sm font-medium ${leaseInput === "30" ? "bg-orange-500 text-white" : "bg-white border border-orange-200 text-orange-700"}`}>30 Days</button>
                      <button onClick={() => setLeaseInput("60")} className={`flex-1 py-2 rounded-lg text-sm font-medium ${leaseInput === "60" ? "bg-orange-500 text-white" : "bg-white border border-orange-200 text-orange-700"}`}>60 Days</button>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => generateMoveOutNotice(leaseInput)} className="bg-orange-500 text-white text-xs px-4 py-2 rounded-lg hover:bg-orange-600">Generate Notice</button>
                      <button onClick={() => setLeaseModal(null)} className="bg-gray-200 text-gray-600 text-xs px-4 py-2 rounded-lg">Cancel</button>
                    </div>
                  </div>
                )}
                <div className="space-y-2">
                  <button onClick={() => openLeaseForSigning(selectedTenant)} className="w-full flex items-center justify-between bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-xl px-4 py-3 text-left">
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
                    <button key={item.label} onClick={() => { setLeaseModal(item.modal); setLeaseInput(""); }} className="w-full flex items-center justify-between bg-gray-50 hover:bg-indigo-50 border border-gray-100 hover:border-indigo-200 rounded-xl px-4 py-3 text-left">
                      <div>
                        <div className="text-sm font-medium text-gray-800">{item.label}</div>
                        <div className="text-xs text-gray-400">{item.desc}</div>
                      </div>
                      <span className="text-gray-300">→</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-gray-800">Tenants</h2>
        <div className="flex gap-2 items-center">
          <input placeholder="Search..." value={tenantSearch || ""} onChange={e => setTenantSearch(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-40" />
          <select value={tenantFilter || "all"} onChange={e => setTenantFilter(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
            <option value="all">All Status</option><option value="active">Active</option><option value="notice">Notice</option><option value="expired">Expired</option>
          </select>
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            {[["card","\u25a6"],["table","\u2630"],["compact","\u2261"]].map(([m,icon]) => (
              <button key={m} onClick={() => setTenantView(m)} className={`px-3 py-1.5 text-sm rounded-md ${tenantView === m ? "bg-white shadow-sm text-indigo-700 font-semibold" : "text-gray-500"}`}>{icon}</button>
            ))}
          </div>
          <button onClick={() => { setEditingTenant(null); setForm({ name: "", email: "", phone: "", property: "", lease_status: "active", move_in: "", move_out: "", rent: "" }); setShowForm(!showForm); }} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700 whitespace-nowrap">+ Add</button>
        </div>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-gray-700 mb-3">{editingTenant ? "Edit Tenant" : "New Tenant"}</h3>
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Full name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Phone" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} companyId={companyId} />
            <input placeholder="Monthly Rent ($)" value={form.rent} onChange={e => setForm({ ...form, rent: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <select value={form.lease_status} onChange={e => setForm({ ...form, lease_status: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              {["active", "notice", "expired"].map(s => <option key={s}>{s}</option>)}
            </select>
            <input type="date" placeholder="Move-in" value={form.move_in} onChange={e => setForm({ ...form, move_in: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input type="date" placeholder="Move-out" value={form.move_out} onChange={e => setForm({ ...form, move_out: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={saveTenant} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg">Save</button>
            <button onClick={() => { setShowForm(false); setEditingTenant(null); }} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg">Cancel</button>
          </div>
        </div>
      )}

      {(() => {
        const ft = tenants.filter(t =>
          (tenantFilter === "all" || !tenantFilter || t.lease_status === tenantFilter) &&
          (!tenantSearch || t.name?.toLowerCase().includes(tenantSearch.toLowerCase()) || t.email?.toLowerCase().includes(tenantSearch.toLowerCase()) || t.property?.toLowerCase().includes(tenantSearch.toLowerCase()))
        );
        const TenantActions = ({t}) => (
          <div className="flex gap-1.5 flex-wrap">
            <button onClick={() => openLedger(t)} className="text-xs text-indigo-600 border border-indigo-200 px-2 py-1 rounded-lg hover:bg-indigo-50">Ledger</button>
            <button onClick={() => openMessages(t)} className="text-xs text-gray-600 border border-gray-200 px-2 py-1 rounded-lg hover:bg-gray-50">Msg</button>
            <button onClick={() => { setSelectedTenant(t); setActivePanel("lease"); }} className="text-xs text-gray-600 border border-gray-200 px-2 py-1 rounded-lg hover:bg-gray-50">Lease</button>
            <button onClick={() => startEdit(t)} className="text-xs text-blue-600 hover:underline">Edit</button>
            <button onClick={() => deleteTenant(t.id, t.name)} className="text-xs text-red-500 hover:underline">Del</button>
            <button onClick={() => inviteTenant(t)} className="text-xs text-purple-600 hover:underline">Invite</button>
          </div>
        );
        return <>
          {tenantView === "card" && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {ft.map(t => (
                <div key={t.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold">{t.name?.[0]}</div>
                      <div><div className="font-semibold text-gray-800">{t.name}</div><div className="text-xs text-gray-400">{t.property}</div></div>
                    </div>
                    <Badge status={t.lease_status} />
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs mt-2">
                    <div><span className="text-gray-400">Email</span><div className="font-semibold text-gray-700 truncate">{t.email}</div></div>
                    <div><span className="text-gray-400">Balance</span><div className={`font-semibold ${t.balance > 0 ? "text-red-500" : "text-gray-700"}`}>{t.balance > 0 ? `-$${t.balance}` : "Current"}</div></div>
                    <div><span className="text-gray-400">Rent</span><div className="font-semibold text-gray-700">{t.rent ? `$${t.rent}/mo` : "\u2014"}</div></div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-gray-50"><TenantActions t={t} /></div>
                </div>
              ))}
            </div>
          )}
          {tenantView === "table" && (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-400 uppercase">
                  <tr><th className="px-4 py-3 text-left">Name</th><th className="px-4 py-3 text-left">Property</th><th className="px-4 py-3 text-left">Email</th><th className="px-4 py-3 text-left">Status</th><th className="px-4 py-3 text-right">Rent</th><th className="px-4 py-3 text-right">Balance</th><th className="px-4 py-3 text-right">Actions</th></tr>
                </thead>
                <tbody>
                  {ft.map(t => (
                    <tr key={t.id} className="border-t border-gray-50 hover:bg-gray-50/50">
                      <td className="px-4 py-2.5 font-medium text-gray-800">{t.name}</td>
                      <td className="px-4 py-2.5 text-gray-600">{t.property}</td>
                      <td className="px-4 py-2.5 text-gray-500 text-xs">{t.email}</td>
                      <td className="px-4 py-2.5"><Badge status={t.lease_status} /></td>
                      <td className="px-4 py-2.5 text-right font-semibold">{t.rent ? `$${t.rent}` : "\u2014"}</td>
                      <td className={`px-4 py-2.5 text-right font-semibold ${t.balance > 0 ? "text-red-500" : "text-gray-700"}`}>{t.balance > 0 ? `-$${t.balance}` : "Current"}</td>
                      <td className="px-4 py-2.5 text-right"><TenantActions t={t} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {tenantView === "compact" && (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm divide-y divide-gray-50">
              {ft.map(t => (
                <div key={t.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50/50">
                  <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-xs">{t.name?.[0]}</div>
                  <div className="flex-1 min-w-0"><span className="text-sm font-medium text-gray-800">{t.name}</span><span className="text-xs text-gray-400 ml-2">{t.property}</span></div>
                  <span className="text-sm font-semibold text-gray-700">{t.rent ? `$${t.rent}/mo` : "\u2014"}</span>
                  <span className={`text-xs font-semibold ${t.balance > 0 ? "text-red-500" : "text-gray-500"}`}>{t.balance > 0 ? `-$${t.balance}` : "Current"}</span>
                  <Badge status={t.lease_status} />
                  <button onClick={() => openLedger(t)} className="text-xs text-indigo-600 hover:underline">Ledger</button>
                  <button onClick={() => startEdit(t)} className="text-xs text-blue-600 hover:underline">Edit</button>
                </div>
              ))}
            </div>
          )}
          {ft.length === 0 && <div className="text-center py-8 text-gray-400">No tenants found</div>}
        </>;
      })()}
    </div>
  );
}

// ============ PAYMENTS ============
function Payments({ addNotification, userProfile, userRole, companyId }) {
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ tenant: "", property: "", amount: "", type: "rent", method: "ACH", status: "paid", date: formatLocalDate(new Date()) });

  useEffect(() => { fetchPayments(); }, []);

  async function fetchPayments() {
    const { data } = await supabase.from("payments").select("*").eq("company_id", companyId || "sandbox-llc").order("date", { ascending: false });
    setPayments(data || []);
    setLoading(false);
  }

  async function addPayment() {
    if (!form.tenant.trim()) { alert("Tenant name is required."); return; }
    if (!form.amount || isNaN(Number(form.amount)) || Number(form.amount) <= 0) { alert("Please enter a valid amount."); return; }
    if (!form.date) { alert("Payment date is required."); return; }
    // Duplicate detection: check for same tenant + amount + date in last 5 minutes
    const { data: recentDup } = await supabase.from("payments").select("id").eq("company_id", companyId || "sandbox-llc").eq("tenant", form.tenant).eq("amount", Number(form.amount)).eq("date", form.date).limit(1);
    if (recentDup && recentDup.length > 0) {
      if (!window.confirm("A payment for $" + form.amount + " from " + form.tenant + " on " + form.date + " already exists. Record another?")) return;
    }
    const { error } = await supabase.from("payments").insert([{ company_id: companyId || "sandbox-llc", ...form, amount: Number(form.amount) }]);
    if (error) { alert("Error recording payment: " + error.message); return; }
    // Only auto-post to accounting if payment is actually paid (not unpaid/partial)
    if (form.status !== "paid") {
      addNotification("💳", `Payment recorded (${form.status}): $${form.amount} from ${form.tenant}`);
      logAudit("create", "payments", `Payment (${form.status}): $${form.amount} from ${form.tenant} at ${form.property}`, "", userProfile?.email, userRole, companyId);
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
      const { data: accrualJEs } = await supabase.from("acct_journal_entries").select("id, reference").eq("company_id", companyId || "sandbox-llc").like("reference", `ACCR-${month}%`).neq("status", "voided");
      if (accrualJEs && accrualJEs.length > 0) {
        for (const je of accrualJEs) {
          const { data: jLines } = await supabase.from("acct_journal_lines").select("memo").eq("journal_entry_id", je.id);
          if (jLines && jLines.some(l => l.memo && l.memo.includes(form.tenant))) { hasAccrual = true; break; }
        }
      }
    } else {
      const { data: lateJEs } = await supabase.from("acct_journal_entries").select("id").eq("company_id", companyId || "sandbox-llc").ilike("description", `%Late fee%${form.tenant}%`);
      if (lateJEs && lateJEs.length > 0) hasAccrual = true;
    }
    if (hasAccrual) {
      // Settle AR: DR Bank, CR Accounts Receivable (revenue already recognized at accrual)
      await autoPostJournalEntry({
        companyId,
        date: form.date,
        description: `Payment received — ${form.tenant} — ${form.property} (settling AR)`,
        reference: `PAY-${Date.now()}`,
        property: form.property,
        lines: [
          { account_id: "1000", account_name: "Checking Account", debit: amt, credit: 0, class_id: classId, memo: `${form.method} from ${form.tenant}` },
          { account_id: "1100", account_name: "Accounts Receivable", debit: 0, credit: amt, class_id: classId, memo: `AR settlement — ${form.tenant}` },
        ]
      });
    } else {
      // No accrual: direct revenue (cash basis) DR Bank, CR Revenue
      const revenueAcct = isLateFee ? "4010" : "4000";
      const revenueAcctName = isLateFee ? "Late Fee Income" : "Rental Income";
      await autoPostJournalEntry({
        companyId,
        date: form.date,
        description: `${form.type === "rent" ? "Rent" : form.type} payment — ${form.tenant} — ${form.property}`,
        reference: `PAY-${Date.now()}`,
        property: form.property,
        lines: [
          { account_id: "1000", account_name: "Checking Account", debit: amt, credit: 0, class_id: classId, memo: `${form.method} from ${form.tenant}` },
          { account_id: revenueAcct, account_name: revenueAcctName, debit: 0, credit: amt, class_id: classId, memo: `${form.tenant} — ${form.property}` },
        ]
      });
    }
    addNotification("💳", `Payment recorded: $${form.amount} from ${form.tenant}`);
    logAudit("create", "payments", `Payment: $${form.amount} from ${form.tenant} at ${form.property}`, "", userProfile?.email, userRole, companyId);

    // Update tenant balance and create ledger entry
    const { data: tenantRow } = await supabase.from("tenants").select("id, balance").eq("name", form.tenant).eq("company_id", companyId || "sandbox-llc").maybeSingle();
    if (tenantRow) {
      const payAmt = Number(form.amount);
      // Decrease balance (payment reduces what tenant owes)
      try {
        await supabase.rpc("update_tenant_balance", { p_tenant_id: tenantRow.id, p_amount_change: -payAmt });
      } catch {
        await supabase.from("tenants").update({ balance: safeNum(tenantRow.balance) - payAmt }).eq("company_id", companyId || "sandbox-llc").eq("id", tenantRow.id); // balance update (unchecked ok — RPC primary)
      }
      // Create ledger entry
      await safeLedgerInsert({ company_id: companyId || "sandbox-llc",
        tenant: form.tenant, property: form.property,
        date: form.date, description: `${form.type} payment (${form.method})`,
        amount: -payAmt, type: "payment", balance: safeNum(tenantRow.balance) - payAmt,
      });
    }

    setShowForm(false);
    setForm({ tenant: "", property: "", amount: "", type: "rent", method: "ACH", status: "paid", date: formatLocalDate(new Date()) });
    fetchPayments();
  }

  if (loading) return <Spinner />;

  const totalExpected = payments.filter(p => p.type === "rent").reduce((s, p) => s + safeNum(p.amount), 0);
  const totalCollected = payments.filter(p => p.status === "paid").reduce((s, p) => s + safeNum(p.amount), 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Payments & Rent</h2>
        <button onClick={() => setShowForm(!showForm)} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">+ Record Payment</button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-gray-700 mb-3">New Payment</h3>
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Tenant name" value={form.tenant} onChange={e => setForm({ ...form, tenant: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} className="flex-1" companyId={companyId} />
            <input placeholder="Amount" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <select value={form.method} onChange={e => setForm({ ...form, method: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              {["ACH", "card", "autopay", "cash", "check"].map(m => <option key={m}>{m}</option>)}
            </select>
            <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              {["rent", "late_fee", "deposit", "other"].map(t => <option key={t}>{t}</option>)}
            </select>
            <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              {["paid", "unpaid", "partial"].map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={addPayment} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">Save</button>
            <button onClick={() => setShowForm(false)} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg hover:bg-gray-200">Cancel</button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-3 mb-5">
        <StatCard label="Expected" value={`$${totalExpected.toLocaleString()}`} color="text-gray-700" />
        <StatCard label="Collected" value={`$${totalCollected.toLocaleString()}`} color="text-green-600" />
        <StatCard label="Outstanding" value={`$${(totalExpected - totalCollected).toLocaleString()}`} color="text-red-500" />
      </div>
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
            <tr>{["Tenant", "Property", "Amount", "Date", "Type", "Method", "Status", ""].map(h => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {payments.map(p => (
              <tr key={p.id} className="border-t border-gray-50 hover:bg-gray-50">
                <td className="px-3 py-2.5 font-medium text-gray-800">{p.tenant}</td>
                <td className="px-3 py-2.5 text-gray-500">{p.property}</td>
                <td className="px-3 py-2.5 font-semibold">${p.amount}</td>
                <td className="px-3 py-2.5 text-gray-500">{p.date}</td>
                <td className="px-3 py-2.5 capitalize text-gray-600">{p.type?.replace("_", " ")}</td>
                <td className="px-3 py-2.5 text-gray-500">{p.method}</td>
                <td className="px-3 py-2.5"><Badge status={p.status} /></td>
                <td className="px-3 py-2.5">{p.status === "paid" && <button onClick={() => generatePaymentReceipt(p)} className="text-xs text-green-600 border border-green-200 px-2 py-0.5 rounded hover:bg-green-50">Receipt</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============ MAINTENANCE ============
function Maintenance({ addNotification, userProfile, userRole, companyId }) {
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

  useEffect(() => { fetchWorkOrders(); }, []);

  async function fetchWorkOrders() {
    const { data } = await supabase.from("work_orders").select("*").eq("company_id", companyId || "sandbox-llc").order("created_at", { ascending: false });
    setWorkOrders(data || []);
    setLoading(false);
  }

  async function saveWorkOrder() {
    if (!form.property.trim()) { alert("Property is required."); return; }
    if (!form.issue.trim()) { alert("Issue description is required."); return; }
    const payload = editingWO ? form : { ...form, created: formatLocalDate(new Date()) };
    const { error } = editingWO
      ? await supabase.from("work_orders").update({ property: payload.property, tenant: payload.tenant, issue: payload.issue, priority: payload.priority, status: payload.status, assigned: payload.assigned, cost: payload.cost, notes: payload.notes }).eq("id", editingWO.id).eq("company_id", companyId || "sandbox-llc")
      : await supabase.from("work_orders").insert([{ ...payload, company_id: companyId || "sandbox-llc" }]);
    if (error) { alert("Error saving work order: " + error.message); return; }
    if (editingWO) {
      addNotification("🔧", `Work order updated: ${form.issue}`);
      logAudit("update", "maintenance", `Updated work order: ${form.issue}`, editingWO?.id, userProfile?.email, userRole, companyId);
    } else {
      addNotification("🔧", `New work order: ${form.issue} at ${form.property}`);
      logAudit("create", "maintenance", `Work order: ${form.issue} at ${form.property}`, "", userProfile?.email, userRole, companyId);
    }
    setShowForm(false);
    setEditingWO(null);
    setForm({ property: "", tenant: "", issue: "", priority: "normal", status: "open", assigned: "", cost: 0, notes: "" });
    fetchWorkOrders();
  }

  async function updateStatus(wo, newStatus) {
    const { error } = await supabase.from("work_orders").update({ status: newStatus }).eq("company_id", companyId || "sandbox-llc").eq("id", wo.id);
    if (error) { alert("Error updating status: " + error.message); return; }
    // AUTO-POST TO ACCOUNTING when completed with a cost (with duplicate guard)
    if (newStatus === "completed" && safeNum(wo.cost) > 0) {
      const { data: existingWoJE } = await supabase.from("acct_journal_entries").select("id").eq("company_id", companyId || "sandbox-llc").eq("reference", "WO-" + wo.id).limit(1);
      if (existingWoJE && existingWoJE.length > 0) { addNotification("⚠️", "Accounting entry already exists for this work order"); fetchWorkOrders(); return; }
      const classId = await getPropertyClassId(wo.property, companyId);
      const amt = safeNum(wo.cost);
      await autoPostJournalEntry({
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
    }
    addNotification("🔧", `Work order "${wo.issue}" marked as ${newStatus.replace("_", " ")}`);
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
    setWoPhotos(data || []);
  }

  async function uploadPhoto() {
    const file = photoRef.current?.files?.[0];
    if (!file || !viewingPhotos) return;
    setUploadingPhoto(true);
    const fileName = `wo_${viewingPhotos.id}_${Date.now()}_${file.name}`;
    const { error: uploadError } = await supabase.storage.from("maintenance-photos").upload(fileName, file);
    if (uploadError) { alert("Upload failed: " + uploadError.message); setUploadingPhoto(false); return; }
    const { data: { publicUrl } } = supabase.storage.from("maintenance-photos").getPublicUrl(fileName);
    await supabase.from("work_order_photos").insert([{ work_order_id: viewingPhotos.id, property: viewingPhotos.property, url: publicUrl, caption: file.name }]);
    addNotification("📸", `Photo uploaded for: ${viewingPhotos.issue}`);
    setUploadingPhoto(false);
    if (photoRef.current) photoRef.current.value = "";
    openPhotos(viewingPhotos);
  }

  async function deletePhoto(id) {
    await supabase.from("work_order_photos").delete().eq("id", id);
    openPhotos(viewingPhotos);
  }

  if (loading) return <Spinner />;

  const filtered = filter === "all" ? workOrders : workOrders.filter(w => w.status === filter || w.priority === filter);

  return (
    <div>
      {viewingPhotos && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 sticky top-0 bg-white">
              <div><h3 className="font-bold text-gray-800">📸 Photos — {viewingPhotos.issue}</h3><p className="text-xs text-gray-400">{viewingPhotos.property}</p></div>
              <button onClick={() => setViewingPhotos(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="p-6">
              <div className="bg-gray-50 rounded-xl p-4 mb-4">
                <div className="text-xs font-semibold text-gray-600 mb-2">Upload New Photo</div>
                <div className="flex gap-2">
                  <input type="file" accept="image/*" ref={photoRef} className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  <button onClick={uploadPhoto} disabled={uploadingPhoto} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-50">{uploadingPhoto ? "Uploading..." : "Upload"}</button>
                </div>
              </div>
              {woPhotos.length === 0 ? (
                <div className="text-center py-8 text-gray-400">No photos yet.</div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {woPhotos.map(p => (
                    <div key={p.id} className="relative group rounded-xl overflow-hidden border border-gray-100">
                      <img src={p.url} alt={p.caption} className="w-full h-40 object-cover" />
                      <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-40 transition-all flex items-center justify-center">
                        <button onClick={() => deletePhoto(p.id)} className="opacity-0 group-hover:opacity-100 bg-red-500 text-white text-xs px-3 py-1.5 rounded-lg">Delete</button>
                      </div>
                      <div className="p-2 text-xs text-gray-500 truncate">{p.caption}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Maintenance & Work Orders</h2>
        <button onClick={() => { setEditingWO(null); setForm({ property: "", tenant: "", issue: "", priority: "normal", status: "open", assigned: "", cost: 0, notes: "" }); setShowForm(!showForm); }} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">+ New Work Order</button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-gray-700 mb-3">{editingWO ? "Edit Work Order" : "New Work Order"}</h3>
          <div className="grid grid-cols-2 gap-3">
            <PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} className="flex-1" companyId={companyId} />
            <input placeholder="Tenant" value={form.tenant} onChange={e => setForm({ ...form, tenant: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Issue description" value={form.issue} onChange={e => setForm({ ...form, issue: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm col-span-2" />
            <select value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              {["normal", "emergency", "low"].map(p => <option key={p}>{p}</option>)}
            </select>
            <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              {["open", "in_progress", "completed"].map(s => <option key={s}>{s}</option>)}
            </select>
            <input placeholder="Assign to vendor/staff" value={form.assigned} onChange={e => setForm({ ...form, assigned: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Cost ($)" type="number" value={form.cost} onChange={e => setForm({ ...form, cost: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <textarea placeholder="Notes / completion details" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm col-span-2" rows={2} />
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={saveWorkOrder} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">Save</button>
            <button onClick={() => { setShowForm(false); setEditingWO(null); }} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg hover:bg-gray-200">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex gap-2 mb-4 flex-wrap">
        {["all", "open", "in_progress", "completed", "emergency"].map(s => (
          <button key={s} onClick={() => setFilter(s)} className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize ${filter === s ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{s.replace("_", " ")}</button>
        ))}
      </div>
      <div className="space-y-3">
        {filtered.map(w => (
          <div key={w.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <div className="flex justify-between items-start">
              <div>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${priorityColors[w.priority]}`}>{w.priority}</span>
                  <span className="font-semibold text-gray-800">{w.issue}</span>
                </div>
                <div className="text-xs text-gray-400 mt-1">{w.property} · {w.tenant}</div>
              </div>
              <Badge status={w.status} label={w.status?.replace("_", " ")} />
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <div><span className="text-gray-400">Assigned</span><div className="font-semibold text-gray-700">{w.assigned || "Unassigned"}</div></div>
              <div><span className="text-gray-400">Created</span><div className="font-semibold text-gray-700">{w.created}</div></div>
              <div><span className="text-gray-400">Cost</span><div className="font-semibold text-gray-700">{w.cost ? `$${w.cost}` : "—"}</div></div>
            </div>
            {w.notes && <div className="mt-2 text-xs text-gray-400 italic">{w.notes}</div>}
            <div className="mt-3 flex gap-2 flex-wrap">
              {w.status === "open" && <button onClick={() => updateStatus(w, "in_progress")} className="text-xs text-purple-600 border border-purple-200 px-3 py-1 rounded-lg hover:bg-purple-50">▶ In Progress</button>}
              {w.status === "in_progress" && <button onClick={() => updateStatus(w, "completed")} className="text-xs text-green-600 border border-green-200 px-3 py-1 rounded-lg hover:bg-green-50">✓ Complete</button>}
              {w.status === "completed" && <button onClick={() => updateStatus(w, "open")} className="text-xs text-gray-500 border border-gray-200 px-3 py-1 rounded-lg hover:bg-gray-50">↩ Reopen</button>}
              <button onClick={() => openPhotos(w)} className="text-xs text-purple-600 border border-purple-200 px-3 py-1 rounded-lg hover:bg-purple-50">📸 Photos</button>
              <button onClick={() => startEdit(w)} className="text-xs text-blue-600 border border-blue-200 px-3 py-1 rounded-lg hover:bg-blue-50">✏️ Edit</button>
            </div>
          </div>
        ))}
      </div>
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

  useEffect(() => { fetchUtilities(); }, []);

  async function fetchUtilities() {
    const { data } = await supabase.from("utilities").select("*").eq("company_id", companyId || "sandbox-llc").order("due", { ascending: true });
    setUtilities(data || []);
    setLoading(false);
  }

  async function addUtility() {
    if (!form.property.trim()) { alert("Property is required."); return; }
    if (!form.provider.trim()) { alert("Provider name is required."); return; }
    if (!form.amount || isNaN(Number(form.amount)) || Number(form.amount) <= 0) { alert("Please enter a valid amount."); return; }
    if (!form.due) { alert("Due date is required."); return; }
    const { error } = await supabase.from("utilities").insert([{ company_id: companyId || "sandbox-llc", ...form, amount: Number(form.amount) }]);
    if (error) { alert("Error adding utility: " + error.message); return; }
    addNotification("⚡", `Utility bill added: ${form.provider} at ${form.property}`);
    setShowForm(false);
    setForm({ property: "", provider: "", amount: "", due: "", responsibility: "owner", status: "pending" });
    fetchUtilities();
  }

  async function approvePay(u) {
    const now = new Date().toISOString();
    const { error } = await supabase.from("utilities").update({ status: "paid", paid_at: now }).eq("company_id", companyId || "sandbox-llc").eq("id", u.id);
    if (error) { alert("Error approving payment: " + error.message); return; }
    await supabase.from("utility_audit").insert([{ company_id: companyId || "sandbox-llc",
      utility_id: u.id,
      property: u.property,
      provider: u.provider,
      amount: u.amount,
      action: "Approved & Paid",
      paid_at: now,
    }]);
    addNotification("✅", `Utility paid: ${u.provider} $${u.amount} for ${u.property}`);
    // AUTO-POST TO ACCOUNTING: DR Utilities Expense, CR Bank
    const classId = await getPropertyClassId(u.property, companyId);
    const amt = safeNum(u.amount);
    if (amt > 0) {
      await autoPostJournalEntry({
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
    }
    fetchUtilities();
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
            <div className="text-center text-gray-400 py-6">No audit entries yet</div>
          ) : (
            <div className="space-y-3">
              {auditLog.map((a, i) => (
                <div key={i} className="bg-gray-50 rounded-lg px-4 py-3">
                  <div className="flex justify-between">
                    <span className="text-sm font-semibold text-green-600">{a.action}</span>
                    <span className="text-xs text-gray-400">{new Date(a.paid_at).toLocaleString()}</span>
                  </div>
                  <div className="text-sm text-gray-600 mt-1">${a.amount} — {a.property}</div>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}

      {/* Toolbar */}
      <div className="flex flex-col md:flex-row gap-3 mb-4">
        <h2 className="text-xl font-bold text-gray-800 mr-auto">Utility Management</h2>
        <input placeholder="Search..." value={utilSearch} onChange={e => setUtilSearch(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-40" />
        <select value={utilFilterStatus} onChange={e => setUtilFilterStatus(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
          <option value="all">All Status</option><option value="pending">Pending</option><option value="paid">Paid</option>
        </select>
        <select value={utilFilterProp} onChange={e => setUtilFilterProp(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
          <option value="all">All Properties</option>
          {[...new Set(utilities.map(u => u.property).filter(Boolean))].map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <div className="flex bg-gray-100 rounded-lg p-0.5">
          {[["card","▦"],["table","☰"]].map(([m,icon]) => (
            <button key={m} onClick={() => setUtilView(m)} className={`px-3 py-1.5 text-sm rounded-md ${utilView === m ? "bg-white shadow-sm text-indigo-700 font-semibold" : "text-gray-500"}`}>{icon}</button>
          ))}
        </div>
        <button onClick={() => setShowForm(!showForm)} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700 whitespace-nowrap">+ Add Bill</button>
      </div>

      {/* Stats */}
      <div className="flex gap-3 mb-4">
        <div className="bg-white rounded-xl border border-gray-100 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-gray-800">{utilities.length}</div><div className="text-xs text-gray-400">Total</div></div>
        <div className="bg-white rounded-xl border border-gray-100 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-amber-600">{utilities.filter(u => u.status === "pending").length}</div><div className="text-xs text-gray-400">Pending</div></div>
        <div className="bg-white rounded-xl border border-gray-100 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-emerald-600">${utilities.filter(u => u.status === "paid").reduce((s,u) => s + safeNum(u.amount), 0).toLocaleString()}</div><div className="text-xs text-gray-400">Paid</div></div>
        <div className="bg-white rounded-xl border border-gray-100 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-red-500">${utilities.filter(u => u.status === "pending").reduce((s,u) => s + safeNum(u.amount), 0).toLocaleString()}</div><div className="text-xs text-gray-400">Outstanding</div></div>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-gray-700 mb-3">New Utility Bill</h3>
          <div className="grid grid-cols-2 gap-3">
            <PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} className="flex-1" companyId={companyId} />
            <input placeholder="Provider (e.g. Gas Co)" value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Amount" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input type="date" value={form.due} onChange={e => setForm({ ...form, due: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <select value={form.responsibility} onChange={e => setForm({ ...form, responsibility: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              {["owner", "tenant", "shared"].map(r => <option key={r}>{r}</option>)}
            </select>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={addUtility} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg">Save</button>
            <button onClick={() => setShowForm(false)} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg">Cancel</button>
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
                <div key={u.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
                  <div className="flex justify-between items-start">
                    <div><div className="font-semibold text-gray-800">{u.provider}</div><div className="text-xs text-gray-400 mt-0.5">{u.property}</div></div>
                    <div className="text-right"><div className="text-lg font-bold text-gray-800">${u.amount}</div><Badge status={u.status} /></div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <div><span className="text-gray-400">Due</span><div className="font-semibold text-gray-700">{u.due}</div></div>
                    <div><span className="text-gray-400">Responsibility</span><div className="font-semibold capitalize text-gray-700">{u.responsibility}</div></div>
                    <div><span className="text-gray-400">Paid</span><div className="font-semibold text-gray-700">{u.paid_at ? new Date(u.paid_at).toLocaleDateString() : "—"}</div></div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    {u.status === "pending" && <button onClick={() => approvePay(u)} className="text-xs text-green-600 border border-green-200 px-3 py-1 rounded-lg hover:bg-green-50">✓ Pay</button>}
                    <button onClick={() => openAuditLog(u)} className="text-xs text-gray-600 border border-gray-200 px-3 py-1 rounded-lg hover:bg-gray-50">Audit</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {utilView === "table" && (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-400 uppercase">
                  <tr><th className="px-4 py-3 text-left">Provider</th><th className="px-4 py-3 text-left">Property</th><th className="px-4 py-3 text-right">Amount</th><th className="px-4 py-3 text-left">Due</th><th className="px-4 py-3 text-left">Status</th><th className="px-4 py-3 text-left">Resp.</th><th className="px-4 py-3 text-right">Actions</th></tr>
                </thead>
                <tbody>
                  {fu.map(u => (
                    <tr key={u.id} className="border-t border-gray-50 hover:bg-gray-50/50">
                      <td className="px-4 py-2.5 font-medium text-gray-800">{u.provider}</td>
                      <td className="px-4 py-2.5 text-gray-600">{u.property}</td>
                      <td className="px-4 py-2.5 text-right font-semibold">${u.amount}</td>
                      <td className="px-4 py-2.5 text-gray-500">{u.due}</td>
                      <td className="px-4 py-2.5"><Badge status={u.status} /></td>
                      <td className="px-4 py-2.5 text-gray-600 capitalize">{u.responsibility}</td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        {u.status === "pending" && <button onClick={() => approvePay(u)} className="text-xs text-green-600 hover:underline mr-2">Pay</button>}
                        <button onClick={() => openAuditLog(u)} className="text-xs text-gray-400 hover:underline">Audit</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {fu.length === 0 && <div className="text-center py-8 text-gray-400">No utility bills found</div>}
        </>;
      })()}
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

const calcAccountBalance = (accountId, journalEntries, account) => {
  let balance = 0;
  const nb = getNormalBalance(account.type);
  journalEntries.filter(je => je.status === "posted").forEach(je => {
    (je.lines || []).filter(l => l.account_id === accountId).forEach(l => {
      balance += nb === "debit" ? (safeNum(l.debit) - safeNum(l.credit)) : (safeNum(l.credit) - safeNum(l.debit));
    });
  });
  return balance;
};

const calcAllBalances = (accounts, journalEntries) => accounts.map(a => ({ ...a, computedBalance: calcAccountBalance(a.id, journalEntries, a) }));

const getPLData = (accounts, journalEntries, startDate, endDate, classId = null) => {
  const revTypes = ["Revenue","Other Income"];
  const expTypes = ["Expense","Cost of Goods Sold","Other Expense"];
  const filtered = journalEntries.filter(je => je.status === "posted" && je.date >= startDate && je.date <= endDate);
  const calc = (aid, atype) => {
    const nb = getNormalBalance(atype);
    let bal = 0;
    filtered.forEach(je => { (je.lines || []).filter(l => l.account_id === aid && (!classId || l.class_id === classId)).forEach(l => { bal += nb === "debit" ? safeNum(l.debit) - safeNum(l.credit) : safeNum(l.credit) - safeNum(l.debit); }); });
    return bal;
  };
  const revenue = accounts.filter(a => revTypes.includes(a.type) && a.is_active).map(a => ({ ...a, amount: calc(a.id, a.type) })).filter(a => a.amount !== 0);
  const expenses = accounts.filter(a => expTypes.includes(a.type) && a.is_active).map(a => ({ ...a, amount: calc(a.id, a.type) })).filter(a => a.amount !== 0);
  const totalRevenue = revenue.reduce((s, a) => s + a.amount, 0);
  const totalExpenses = expenses.reduce((s, a) => s + a.amount, 0);
  return { revenue, expenses, totalRevenue, totalExpenses, netIncome: totalRevenue - totalExpenses };
};

const getBalanceSheetData = (accounts, journalEntries, asOfDate) => {
  const filtered = journalEntries.filter(je => je.status === "posted" && je.date <= asOfDate);
  const calc = (aid, atype) => { const nb = getNormalBalance(atype); let b = 0; filtered.forEach(je => { (je.lines || []).filter(l => l.account_id === aid).forEach(l => { b += nb === "debit" ? safeNum(l.debit) - safeNum(l.credit) : safeNum(l.credit) - safeNum(l.debit); }); }); return b; };
  const assets = accounts.filter(a => a.type === "Asset" && a.is_active).map(a => ({ ...a, amount: calc(a.id, a.type) }));
  const liabilities = accounts.filter(a => a.type === "Liability" && a.is_active).map(a => ({ ...a, amount: calc(a.id, a.type) }));
  const equity = accounts.filter(a => a.type === "Equity" && a.is_active).map(a => ({ ...a, amount: calc(a.id, a.type) }));
  let netIncome = 0;
  filtered.forEach(je => { (je.lines || []).forEach(l => { const acct = accounts.find(a => a.id === l.account_id); if (!acct) return; const nb = getNormalBalance(acct.type); if (["Revenue","Other Income"].includes(acct.type)) netIncome += nb === "credit" ? safeNum(l.credit) - safeNum(l.debit) : safeNum(l.debit) - safeNum(l.credit); if (["Expense","Cost of Goods Sold","Other Expense"].includes(acct.type)) netIncome -= nb === "debit" ? safeNum(l.debit) - safeNum(l.credit) : safeNum(l.credit) - safeNum(l.debit); }); });

  // Build AR sub-ledger: group all 1100 (AR) lines by tenant name from memo
  const arSubLedger = {};
  filtered.forEach(je => {
    (je.lines || []).filter(l => l.account_id === "1100").forEach(l => {
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
  const filtered = journalEntries.filter(je => je.status === "posted" && je.date <= endDate);
  return accounts.filter(a => a.is_active).map(a => {
    let td = 0, tc = 0;
    filtered.forEach(je => { (je.lines || []).filter(l => l.account_id === a.id).forEach(l => { td += safeNum(l.debit); tc += safeNum(l.credit); }); });
    const net = td - tc;
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
  const filtered = journalEntries.filter(je => je.status === "posted" && je.date >= startDate && je.date <= endDate);
  return classes.map(cls => {
    let revenue = 0, expenses = 0;
    filtered.forEach(je => { (je.lines || []).filter(l => l.class_id === cls.id).forEach(l => { const acct = accounts.find(a => a.id === l.account_id); if (!acct) return; if (["Revenue","Other Income"].includes(acct.type)) revenue += safeNum(l.credit) - safeNum(l.debit); if (["Expense","Cost of Goods Sold","Other Expense"].includes(acct.type)) expenses += safeNum(l.debit) - safeNum(l.credit); }); });
    return { ...cls, revenue, expenses, netIncome: revenue - expenses };
  });
};

const validateJE = (lines) => {
  const td = lines.reduce((s,l) => s + (parseFloat(l.debit) || 0), 0);
  const tc = lines.reduce((s,l) => s + (parseFloat(l.credit) || 0), 0);
  return { isValid: Math.abs(td - tc) < 0.005, totalDebit: td, totalCredit: tc, difference: Math.abs(td - tc) };
};

const nextJENumber = (journalEntries) => {
  const nums = journalEntries.map(je => parseInt(je.number.replace("JE-",""),10)).filter(n => !isNaN(n));
  return `JE-${String((nums.length > 0 ? Math.max(...nums) : 0) + 1).padStart(4,"0")}`;
};

const nextAccountId = (accounts, type) => {
  const ranges = { Asset:{s:1000,e:1999}, Liability:{s:2000,e:2999}, Equity:{s:3000,e:3999}, Revenue:{s:4000,e:4999}, "Cost of Goods Sold":{s:5000,e:5099}, Expense:{s:5000,e:6999}, "Other Income":{s:7000,e:7999}, "Other Expense":{s:8000,e:8999} };
  const r = ranges[type] || {s:9000,e:9999};
  const existing = accounts.filter(a => parseInt(a.id) >= r.s && parseInt(a.id) <= r.e).map(a => parseInt(a.id));
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
      <div className={`bg-white rounded-2xl shadow-2xl w-full ${sizes[size]} flex flex-col`} style={{ maxHeight:"90vh" }}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100">✕</button>
        </div>
        <div className="overflow-y-auto flex-1 px-6 py-4">{children}</div>
      </div>
    </div>
  );
}

function AcctTypeBadge({ type }) {
  const map = { Asset:"bg-blue-50 text-blue-700", Liability:"bg-red-50 text-red-700", Equity:"bg-violet-50 text-violet-700", Revenue:"bg-emerald-50 text-emerald-700", Expense:"bg-orange-50 text-orange-700", "Cost of Goods Sold":"bg-orange-50 text-orange-700", "Other Income":"bg-emerald-50 text-emerald-700", "Other Expense":"bg-orange-50 text-orange-700" };
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[type] || "bg-gray-100 text-gray-700"}`}>{type}</span>;
}

function AcctStatusBadge({ status }) {
  const map = { posted: "bg-emerald-50 text-emerald-700", draft: "bg-amber-50 text-amber-700", voided: "bg-red-50 text-red-700" };
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[status] || "bg-gray-100 text-gray-700"}`}>{status}</span>;
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
          <h3 className="text-lg font-semibold text-gray-900">Chart of Accounts</h3>
          <p className="text-sm text-gray-500">Manage your account structure</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowInactive(!showInactive)} className={`text-xs px-3 py-1.5 rounded-lg border ${showInactive ? "bg-gray-100 border-gray-300" : "border-gray-200 text-gray-400"}`}>{showInactive ? "Hide Inactive" : "Show Inactive"}</button>
          <button onClick={openAdd} className="bg-slate-800 text-white text-xs px-4 py-2 rounded-lg hover:bg-slate-700">+ New Account</button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mb-4">
        {["All", ...typeOrder.filter((t, i, a) => a.indexOf(t) === i)].map(t => (
          <button key={t} onClick={() => setFilter(t)} className={`text-xs px-3 py-1.5 rounded-xl border font-medium ${filter === t ? "bg-slate-800 text-white border-slate-800" : "bg-white text-gray-500 border-gray-200 hover:border-gray-400"}`}>{t}</button>
        ))}
      </div>
      {typeOrder.filter((t, i, a) => a.indexOf(t) === i).map(type => {
        const accts = grouped[type];
        if (!accts?.length) return null;
        return (
          <div key={type} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden mb-3">
            <div className="px-4 py-2 bg-gray-50 flex items-center justify-between">
              <div className="flex items-center gap-2"><AcctTypeBadge type={type} /><span className="text-xs text-gray-500">{accts.length} accounts</span></div>
              <span className="font-mono text-xs font-semibold text-gray-600">{acctFmt(accts.filter(a=>a.is_active).reduce((s,a)=>s+a.computedBalance,0))}</span>
            </div>
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-400 uppercase bg-gray-50/50"><tr><th className="px-4 py-2 text-left">Number</th><th className="px-4 py-2 text-left">Name</th><th className="px-4 py-2 text-left">Subtype</th><th className="px-4 py-2 text-right">Balance</th><th className="px-4 py-2 w-20">Actions</th></tr></thead>
              <tbody>
                {accts.map(a => (
                  <tr key={a.id} className="border-t border-gray-50 hover:bg-blue-50/30 cursor-pointer" onClick={() => openEdit(a)}>
                    <td className="px-4 py-2 font-mono text-xs text-gray-400">{a.id}</td>
                    <td className={`px-4 py-2 font-medium ${!a.is_active ? "text-gray-400 line-through" : "text-gray-800"}`}>{a.name}</td>
                    <td className="px-4 py-2 text-xs text-gray-500">{a.subtype}</td>
                    <td className={`px-4 py-2 text-right font-mono text-sm ${a.computedBalance < 0 ? "text-red-600" : "text-gray-800"}`}>{acctFmt(a.computedBalance, true)}</td>
                    <td className="px-4 py-2 text-center">
                      <button onClick={e => { e.stopPropagation(); onToggle(a.id, a.is_active); }} className="text-gray-400 hover:text-gray-700 text-xs">{a.is_active ? "🟢" : "⚪"}</button>
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
          <div><label className="text-xs font-medium text-gray-600">Account Name *</label><input value={form.name} onChange={e => setForm({...form, name:e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1" placeholder="e.g. Operating Checking" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-600">Type *</label>
              <select value={form.type} onChange={e => { const v = e.target.value; setForm({...form, type: v, subtype: v === "__custom__" ? "" : (getAccountSubtypes(accounts, v)[0] || ""), customType: v === "__custom__" ? form.customType : "" }); }} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1">
                {dynamicTypes.map(t => <option key={t} value={t}>{t}</option>)}
                <option value="__custom__">+ Add Custom Type...</option>
              </select>
              {form.type === "__custom__" && <input value={form.customType} onChange={e => setForm({...form, customType: e.target.value})} className="w-full border border-indigo-300 rounded-lg px-3 py-2 text-sm mt-1 bg-indigo-50" placeholder="Enter new account type" autoFocus />}
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600">Subtype</label>
              <select value={form.subtype} onChange={e => setForm({...form, subtype: e.target.value, customSubtype: e.target.value === "__custom__" ? form.customSubtype : ""})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1">
                {(form.type === "__custom__" ? [] : dynamicSubtypes).map(s => <option key={s} value={s}>{s}</option>)}
                <option value="__custom__">+ Add Custom Subtype...</option>
                <option value="">None</option>
              </select>
              {form.subtype === "__custom__" && <input value={form.customSubtype} onChange={e => setForm({...form, customSubtype: e.target.value})} className="w-full border border-indigo-300 rounded-lg px-3 py-2 text-sm mt-1 bg-indigo-50" placeholder="Enter new subtype" />}
            </div>
          </div>
          <div><label className="text-xs font-medium text-gray-600">Description</label><textarea value={form.description} onChange={e => setForm({...form, description:e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1" rows={2} /></div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setModal(null)} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg">Cancel</button>
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
        <div><label className="text-xs font-medium text-gray-600">Date *</label><input type="date" value={form.date} onChange={e => setForm({...form, date:e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1" /></div>
        <div><label className="text-xs font-medium text-gray-600">Reference</label><input value={form.reference} onChange={e => setForm({...form, reference:e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1" placeholder="Invoice #, Check #..." /></div>
        <div><label className="text-xs font-medium text-gray-600">Property *</label><select value={form.property} onChange={e => setForm({...form, property:e.target.value})} className={`w-full border rounded-lg px-3 py-2 text-sm mt-1 ${!form.property ? "border-red-300 bg-red-50" : "border-gray-200"}`}><option value="">-- Select Property --</option>{properties.map(p => <option key={p} value={p}>{p}</option>)}</select></div>
        <div className="col-span-3"><label className="text-xs font-medium text-gray-600">Description *</label><input value={form.description} onChange={e => setForm({...form, description:e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1" placeholder="What is this entry for?" /></div>
      </div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-gray-600 uppercase">Journal Entry Lines</p>
        <button onClick={addLine} className="text-xs text-slate-600 hover:text-slate-800">+ Add Line</button>
      </div>
      <div className="rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="bg-gray-50 border-b border-gray-200"><th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 w-48">Account</th><th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 w-32">Class</th><th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">Memo</th><th className="px-3 py-2 text-right text-xs font-semibold text-gray-500 w-28">Debit</th><th className="px-3 py-2 text-right text-xs font-semibold text-gray-500 w-28">Credit</th><th className="px-3 py-2 w-8" /></tr></thead>
          <tbody>
            {form.lines.map((line, i) => (
              <tr key={i} className="border-b border-gray-50">
                <td className="px-2 py-1.5"><select value={line.account_id} onChange={e => setLine(i,"account_id",e.target.value)} className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs bg-white"><option value="">-- Select --</option>{ACCOUNT_TYPES.map(type => <optgroup key={type} label={type}>{accounts.filter(a=>a.type===type&&a.is_active).map(a => <option key={a.id} value={a.id}>{a.id} - {a.name}</option>)}</optgroup>)}</select></td>
                <td className="px-2 py-1.5"><select value={line.class_id || ""} onChange={e => setLine(i,"class_id",e.target.value||null)} className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs bg-white"><option value="">No Class</option>{classes.filter(c=>c.is_active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></td>
                <td className="px-2 py-1.5"><input value={line.memo||""} onChange={e => setLine(i,"memo",e.target.value)} placeholder="Optional..." className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs bg-white" /></td>
                <td className="px-2 py-1.5"><input type="number" step="0.01" min="0" value={line.debit} onChange={e => { setLine(i,"debit",e.target.value); if(e.target.value) setLine(i,"credit",""); }} placeholder="0.00" className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-right bg-white font-mono" /></td>
                <td className="px-2 py-1.5"><input type="number" step="0.01" min="0" value={line.credit} onChange={e => { setLine(i,"credit",e.target.value); if(e.target.value) setLine(i,"debit",""); }} placeholder="0.00" className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-right bg-white font-mono" /></td>
                <td className="px-2 py-1.5"><button onClick={() => removeLine(i)} disabled={form.lines.length<=2} className="text-gray-300 hover:text-red-500 disabled:opacity-20">✕</button></td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr className="bg-gray-50 border-t border-gray-200"><td colSpan={3} className="px-3 py-2 text-xs font-semibold text-gray-600 text-right">Totals</td><td className={`px-3 py-2 text-xs font-mono font-bold text-right ${validation.isValid?"text-emerald-700":"text-red-600"}`}>{acctFmt(totalDebit)}</td><td className={`px-3 py-2 text-xs font-mono font-bold text-right ${validation.isValid?"text-emerald-700":"text-red-600"}`}>{acctFmt(totalCredit)}</td><td /></tr></tfoot>
        </table>
      </div>
      {!validation.isValid && totalDebit > 0 && totalCredit > 0 && <div className="text-xs text-red-600 bg-red-50 rounded-xl px-3 py-2">⚠ Out of balance by {acctFmt(validation.difference)}</div>}
      {validation.isValid && totalDebit > 0 && <div className="text-xs text-emerald-600 bg-emerald-50 rounded-xl px-3 py-2">✓ Balanced — {acctFmt(totalDebit)}</div>}
      <div className="flex justify-between pt-2">
        <button onClick={() => setModal(null)} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg">Cancel</button>
        <div className="flex gap-2">
          <button onClick={() => saveEntry("draft")} disabled={!form.description || !form.property || !validation.isValid} className="bg-gray-200 text-gray-700 text-sm px-4 py-2 rounded-lg disabled:opacity-50">Save Draft</button>
          <button onClick={() => saveEntry("posted")} disabled={!form.description || !form.property || !validation.isValid} className="bg-emerald-600 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50 hover:bg-emerald-700">Post Entry</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-4">
        <div><h3 className="text-lg font-semibold text-gray-900">Journal Entries</h3><p className="text-sm text-gray-500">Record and manage financial transactions</p></div>
        <button onClick={openAdd} className="bg-slate-800 text-white text-xs px-4 py-2 rounded-lg hover:bg-slate-700">+ New Entry</button>
      </div>
      <div className="flex gap-2 mb-4">
        {[{k:"all",l:`All (${counts.all})`},{k:"posted",l:`Posted (${counts.posted})`},{k:"draft",l:`Drafts (${counts.draft})`},{k:"voided",l:`Voided (${counts.voided})`}].map(f => (
          <button key={f.k} onClick={() => setFilterStatus(f.k)} className={`text-xs px-3 py-1.5 rounded-xl border font-medium ${filterStatus === f.k ? "bg-slate-800 text-white border-slate-800" : "bg-white text-gray-500 border-gray-200"}`}>{f.l}</button>
        ))}
        <select value={searchProperty} onChange={e => setSearchProperty(e.target.value)} className="text-xs px-3 py-1.5 rounded-xl border border-gray-200 bg-white text-gray-600 ml-auto">
          <option value="">All Properties</option>
          {jeProperties.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-400 uppercase bg-gray-50"><tr><th className="px-4 py-2 text-left">Entry #</th><th className="px-4 py-2 text-left">Date</th><th className="px-4 py-2 text-left">Property</th><th className="px-4 py-2 text-left">Description</th><th className="px-4 py-2 text-left">Ref</th><th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2 text-right">Amount</th><th className="px-4 py-2">Actions</th></tr></thead>
          <tbody>
            {filtered.map(je => {
              const total = (je.lines || []).reduce((s,l) => s + safeNum(l.debit), 0);
              return (
                <tr key={je.id} className="border-t border-gray-50 hover:bg-blue-50/30 cursor-pointer" onClick={() => openView(je)}>
                  <td className="px-4 py-2 font-mono text-xs font-semibold text-gray-700">{je.number}</td>
                  <td className="px-4 py-2 text-gray-600">{acctFmtDate(je.date)}</td>
                  <td className="px-4 py-2 text-xs text-gray-600">{je.property || "—"}</td>
                  <td className="px-4 py-2 font-medium text-gray-800">{je.description}</td>
                  <td className="px-4 py-2 text-xs text-gray-400">{je.reference || "—"}</td>
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
            {filtered.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">No journal entries found</td></tr>}
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
            <div className="grid grid-cols-3 gap-3 bg-gray-50 rounded-xl p-4">
              <div><p className="text-xs text-gray-500">Entry #</p><p className="font-mono font-semibold">{modal.je.number}</p></div>
              <div><p className="text-xs text-gray-500">Date</p><p className="font-semibold">{acctFmtDate(modal.je.date)}</p></div>
              <div><p className="text-xs text-gray-500">Property</p><p className="font-semibold">{modal.je.property || "—"}</p></div>
              <div className="col-span-2"><p className="text-xs text-gray-500">Description</p><p className="font-semibold">{modal.je.description}</p></div>
              <div><p className="text-xs text-gray-500">Status</p><AcctStatusBadge status={modal.je.status} /></div>
            </div>
            <table className="w-full text-sm rounded-xl border border-gray-200 overflow-hidden">
              <thead><tr className="bg-gray-50"><th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">Account</th><th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">Class</th><th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">Memo</th><th className="px-4 py-2 text-right text-xs font-semibold text-gray-500">Debit</th><th className="px-4 py-2 text-right text-xs font-semibold text-gray-500">Credit</th></tr></thead>
              <tbody>
                {(modal.je.lines || []).map((l,i) => {
                  const cls = classes.find(c => c.id === l.class_id);
                  return (
                    <tr key={i} className="border-t border-gray-50">
                      <td className="px-4 py-2"><span className="font-mono text-xs text-gray-400 mr-1">{l.account_id}</span> {l.account_name}</td>
                      <td className="px-4 py-2 text-xs">{cls ? <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{background:cls.color}} />{cls.name}</span> : "—"}</td>
                      <td className="px-4 py-2 text-xs text-gray-400">{l.memo || "—"}</td>
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
              {modal.je.status !== "voided" && <button onClick={() => openEdit(modal.je)} className="bg-gray-200 text-gray-700 text-xs px-3 py-1.5 rounded-lg">Edit</button>}
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
      await onAdd({ id: `CLS-${String(Math.random()).slice(2,8)}`, ...form, is_active: true });
    } else {
      await onUpdate({ ...modal.cls, ...form });
    }
    setModal(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-4">
        <div><h3 className="text-lg font-semibold text-gray-900">Class Tracking</h3><p className="text-sm text-gray-500">Track by unit, property, or department</p></div>
        <button onClick={openAdd} className="bg-slate-800 text-white text-xs px-4 py-2 rounded-lg hover:bg-slate-700">+ New Class</button>
      </div>
      <div className="flex flex-wrap gap-2 mb-4">
        {PERIODS.map(p => <button key={p} onClick={() => setPeriod(p)} className={`text-xs px-3 py-1.5 rounded-xl border font-medium ${period === p ? "bg-slate-800 text-white border-slate-800" : "bg-white text-gray-500 border-gray-200"}`}>{p}</button>)}
      </div>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-4"><p className="text-xs text-emerald-600 font-medium">Revenue</p><p className="text-xl font-bold text-emerald-800 font-mono mt-1">{acctFmt(totalRev)}</p></div>
        <div className="bg-red-50 border border-red-100 rounded-xl p-4"><p className="text-xs text-red-600 font-medium">Expenses</p><p className="text-xl font-bold text-red-800 font-mono mt-1">{acctFmt(totalExp)}</p></div>
        <div className={`border rounded-xl p-4 ${totalNet >= 0 ? "bg-blue-50 border-blue-100" : "bg-orange-50 border-orange-100"}`}><p className={`text-xs font-medium ${totalNet >= 0 ? "text-blue-600" : "text-orange-600"}`}>Net Income</p><p className={`text-xl font-bold font-mono mt-1 ${totalNet >= 0 ? "text-blue-800" : "text-orange-800"}`}>{acctFmt(totalNet, true)}</p></div>
      </div>
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-400 uppercase bg-gray-50"><tr><th className="px-4 py-2 text-left">Class</th><th className="px-4 py-2 text-left">Description</th><th className="px-4 py-2 text-right">Revenue</th><th className="px-4 py-2 text-right">Expenses</th><th className="px-4 py-2 text-right">Net Income</th><th className="px-4 py-2 w-16" /></tr></thead>
          <tbody>
            {classReport.map(c => (
              <tr key={c.id} className="border-t border-gray-50 hover:bg-blue-50/30">
                <td className="px-4 py-2"><div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full" style={{background:c.color}} /><span className={`font-medium ${!c.is_active?"text-gray-400 line-through":"text-gray-800"}`}>{c.name}</span></div></td>
                <td className="px-4 py-2 text-xs text-gray-500">{c.description}</td>
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
          <div><label className="text-xs font-medium text-gray-600">Name *</label><input value={form.name} onChange={e => setForm({...form,name:e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1" /></div>
          <div><label className="text-xs font-medium text-gray-600">Description</label><textarea value={form.description} onChange={e => setForm({...form,description:e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1" rows={2} /></div>
          <div><label className="text-xs font-medium text-gray-600 block mb-2">Color</label><div className="flex gap-2 flex-wrap">{COLORS.map(c => <button key={c} type="button" onClick={() => setForm({...form,color:c})} className={`w-7 h-7 rounded-full border-2 ${form.color===c?"border-gray-800 scale-110":"border-transparent"}`} style={{background:c}} />)}</div></div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setModal(null)} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg">Cancel</button>
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
      {PERIODS.map(p => <button key={p} onClick={() => setPeriod(p)} className={`text-xs px-3 py-1.5 rounded-xl border font-medium ${period === p ? "bg-slate-800 text-white border-slate-800" : "bg-white text-gray-500 border-gray-200"}`}>{p}</button>)}
      {period === "Custom" && <><input type="date" value={customDates.start} onChange={e => setCustomDates(d=>({...d,start:e.target.value}))} className="border border-gray-200 rounded-xl px-3 py-1.5 text-xs" /><span className="text-gray-400 text-xs">to</span><input type="date" value={customDates.end} onChange={e => setCustomDates(d=>({...d,end:e.target.value}))} className="border border-gray-200 rounded-xl px-3 py-1.5 text-xs" /></>}
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
        <div><h3 className="text-lg font-semibold text-gray-900">Financial Reports</h3><p className="text-sm text-gray-500">P&L, Balance Sheet, Trial Balance, General Ledger</p></div>
        <button onClick={() => window.print()} className="bg-gray-100 text-gray-600 text-xs px-3 py-1.5 rounded-lg hover:bg-gray-200">🖨️ Print</button>
      </div>
      <div className="flex gap-1 border-b border-gray-100 mb-4 flex-wrap">
        {[{id:"pl",l:"Profit & Loss"},{id:"bs",l:"Balance Sheet"},{id:"ar",l:"AR Aging"},{id:"tb",l:"Trial Balance"},{id:"gl",l:"General Ledger"}].map(t => (
          <button key={t.id} onClick={() => setActiveReport(t.id)} className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px ${activeReport===t.id ? "border-slate-800 text-slate-800" : "border-transparent text-gray-400 hover:text-gray-600"}`}>{t.l}</button>
        ))}
      </div>

      {/* P&L */}
      {activeReport === "pl" && (
        <div>
          <PeriodPicker />
          <div className="flex gap-2 mb-4"><select value={classFilter} onChange={e => setClassFilter(e.target.value)} className="border border-gray-200 rounded-xl px-3 py-1.5 text-sm bg-white"><option value="">All Classes</option>{classes.filter(c=>c.is_active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-4"><p className="text-xs text-emerald-600">Total Revenue</p><p className="text-xl font-bold text-emerald-800 font-mono mt-1">{acctFmt(plData.totalRevenue)}</p></div>
            <div className="bg-red-50 border border-red-100 rounded-xl p-4"><p className="text-xs text-red-600">Total Expenses</p><p className="text-xl font-bold text-red-800 font-mono mt-1">{acctFmt(plData.totalExpenses)}</p></div>
            <div className={`border rounded-xl p-4 ${plData.netIncome>=0?"bg-blue-50 border-blue-100":"bg-orange-50 border-orange-100"}`}><p className={`text-xs ${plData.netIncome>=0?"text-blue-600":"text-orange-600"}`}>Net Income</p><p className={`text-xl font-bold font-mono mt-1 ${plData.netIncome>=0?"text-blue-800":"text-orange-800"}`}>{acctFmt(plData.netIncome, true)}</p></div>
          </div>
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
            <div className="text-center mb-4"><p className="text-xs text-gray-400 uppercase tracking-widest">Profit & Loss Statement</p><h4 className="text-base font-bold text-gray-900">{companyName}</h4><p className="text-sm text-gray-500">{acctFmtDate(start)} — {acctFmtDate(end)}</p></div>
            <div className="border-t pt-3"><p className="text-sm font-bold text-gray-800 uppercase mb-2">Income</p>{plData.revenue.map(a => <div key={a.id} className="flex justify-between py-1 px-2 hover:bg-gray-50 rounded"><span className="text-sm text-gray-700">{a.name}</span><span className="font-mono text-sm">{acctFmt(a.amount)}</span></div>)}<div className="flex justify-between py-2 border-t-2 border-gray-300 mt-2 font-bold"><span>Total Income</span><span className="font-mono text-emerald-700">{acctFmt(plData.totalRevenue)}</span></div></div>
            <div className="border-t pt-3 mt-3"><p className="text-sm font-bold text-gray-800 uppercase mb-2">Expenses</p>{plData.expenses.map(a => <div key={a.id} className="flex justify-between py-1 px-2 hover:bg-gray-50 rounded"><span className="text-sm text-gray-700">{a.name}</span><span className="font-mono text-sm">{acctFmt(a.amount)}</span></div>)}<div className="flex justify-between py-2 border-t-2 border-gray-300 mt-2 font-bold"><span>Total Expenses</span><span className="font-mono text-red-600">{acctFmt(plData.totalExpenses)}</span></div></div>
            <div className={`flex justify-between py-3 mt-3 border-t-4 border-gray-800 px-2 rounded-b-xl font-black ${plData.netIncome>=0?"bg-emerald-50":"bg-red-50"}`}><span>Net Income</span><span className={`font-mono ${plData.netIncome>=0?"text-emerald-700":"text-red-700"}`}>{acctFmt(plData.netIncome, true)}</span></div>
          </div>
        </div>
      )}

      {/* Balance Sheet */}
      {activeReport === "bs" && (
        <div>
          <div className="flex items-center gap-3 mb-4"><span className="text-sm text-gray-600">As of:</span><input type="date" value={asOfDate} onChange={e => setAsOfDate(e.target.value)} className="border border-gray-200 rounded-xl px-3 py-1.5 text-sm" />{bsBalanced ? <span className="text-xs text-emerald-600 bg-emerald-50 px-3 py-1.5 rounded-xl">✓ Balanced</span> : <span className="text-xs text-red-600 bg-red-50 px-3 py-1.5 rounded-xl">⚠ Out of Balance</span>}</div>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
              <p className="text-base font-black text-gray-900 mb-3">ASSETS</p>
              {bsData.assets.filter(a=>a.amount!==0).map(a => (
                <div key={a.id}>
                  <div className="flex justify-between py-1 px-2 hover:bg-gray-50 rounded cursor-pointer" onClick={() => a.id === "1100" && setShowARSub(!showARSub)}>
                    <span className="text-sm text-gray-700">{a.name}{a.id === "1100" && bsData.arByTenant?.length > 0 && <span className="text-xs text-indigo-500 ml-1">{showARSub ? "▾" : "▸"} {bsData.arByTenant.length} tenants</span>}</span>
                    <span className={`font-mono text-sm ${a.amount<0?"text-red-600":"text-gray-800"}`}>{acctFmt(a.amount, true)}</span>
                  </div>
                  {a.id === "1100" && showARSub && bsData.arByTenant?.length > 0 && (
                    <div className="ml-4 mb-2 border-l-2 border-indigo-200 pl-3">
                      <div className="text-xs font-bold text-indigo-600 uppercase tracking-wide py-1">Tenant Sub-Ledger</div>
                      {bsData.arByTenant.map((t, i) => (
                        <div key={i} className="flex justify-between py-0.5 px-1">
                          <span className="text-xs text-gray-600">{t.tenant}</span>
                          <span className={`font-mono text-xs ${t.balance < 0 ? "text-green-600" : "text-gray-700"}`}>{acctFmt(t.balance, true)}</span>
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
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
              <p className="text-base font-black text-gray-900 mb-3">LIABILITIES & EQUITY</p>
              <p className="text-xs font-bold text-gray-500 uppercase mt-2 mb-1">Liabilities</p>
              {bsData.liabilities.filter(a=>a.amount!==0).map(a => <div key={a.id} className="flex justify-between py-1 px-2 hover:bg-gray-50 rounded"><span className="text-sm text-gray-700">{a.name}</span><span className="font-mono text-sm">{acctFmt(a.amount, true)}</span></div>)}
              <p className="text-xs font-bold text-gray-500 uppercase mt-3 mb-1">Equity</p>
              {bsData.equity.filter(a=>a.amount!==0).map(a => <div key={a.id} className="flex justify-between py-1 px-2 hover:bg-gray-50 rounded"><span className="text-sm text-gray-700">{a.name}</span><span className="font-mono text-sm">{acctFmt(a.amount, true)}</span></div>)}
              {bsData.netIncome !== 0 && <div className="flex justify-between py-1 px-2 hover:bg-gray-50 rounded"><span className="text-sm text-gray-700 italic">Net Income (Current)</span><span className="font-mono text-sm">{acctFmt(bsData.netIncome, true)}</span></div>}
              <div className="flex justify-between py-3 border-t-4 border-gray-800 bg-violet-50 px-2 rounded-xl mt-3 font-black"><span>TOTAL L + E</span><span className="font-mono text-violet-700">{acctFmt(bsData.totalLiabilities + bsData.totalEquity)}</span></div>
            </div>
          </div>
        </div>
      )}

      {/* AR Aging Report */}
      {activeReport === "ar" && (
        <div>
          <div className="flex items-center gap-3 mb-4"><span className="text-sm text-gray-600">As of:</span><input type="date" value={asOfDate} onChange={e => setAsOfDate(e.target.value)} className="border border-gray-200 rounded-xl px-3 py-1.5 text-sm" /></div>

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
          <div className="bg-indigo-50 rounded-xl p-4 mb-5 flex justify-between items-center">
            <div><span className="text-sm font-bold text-indigo-800">Total Accounts Receivable</span><span className="text-xs text-indigo-500 ml-2">(Account 1100)</span></div>
            <span className="text-xl font-black font-mono text-indigo-800">{acctFmt((bsData.arAging?.current || 0) + (bsData.arAging?.days30 || 0) + (bsData.arAging?.days60 || 0) + (bsData.arAging?.days90 || 0) + (bsData.arAging?.over90 || 0))}</span>
          </div>

          {/* Per-Tenant Aging Table */}
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="px-5 py-3 bg-gray-50 border-b border-gray-100">
              <h4 className="text-sm font-bold text-gray-800">AR Aging by Tenant</h4>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs text-gray-500 uppercase">
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
                  <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-4 py-2 font-medium text-gray-800">{tenant}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{aging.current > 0 ? acctFmt(aging.current) : "—"}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-yellow-700">{aging.days30 > 0 ? acctFmt(aging.days30) : "—"}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-orange-700">{aging.days60 > 0 ? acctFmt(aging.days60) : "—"}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-red-600">{aging.days90 > 0 ? acctFmt(aging.days90) : "—"}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-red-800">{aging.over90 > 0 ? acctFmt(aging.over90) : "—"}</td>
                    <td className="px-4 py-2 text-right font-mono text-sm font-bold">{acctFmt(aging.total)}</td>
                  </tr>
                ))}
                {Object.keys(bsData.arAgingByTenant || {}).length === 0 && (
                  <tr><td colSpan="7" className="px-4 py-6 text-center text-gray-400">No outstanding receivables</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Tenant Sub-Ledger (Net Balances) */}
          {bsData.arByTenant?.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden mt-4">
              <div className="px-5 py-3 bg-gray-50 border-b border-gray-100">
                <h4 className="text-sm font-bold text-gray-800">Tenant Sub-Ledger (Net AR Balance)</h4>
                <p className="text-xs text-gray-500">Charges minus payments per tenant — rolls up to master AR on Balance Sheet</p>
              </div>
              <div className="p-4 space-y-1">
                {bsData.arByTenant.map((t, i) => (
                  <div key={i} className="flex justify-between py-1.5 px-3 rounded hover:bg-gray-50">
                    <span className="text-sm text-gray-700">{t.tenant}</span>
                    <span className={`font-mono text-sm font-medium ${t.balance > 0 ? "text-red-600" : "text-green-600"}`}>{t.balance > 0 ? acctFmt(t.balance) + " owed" : acctFmt(Math.abs(t.balance)) + " credit"}</span>
                  </div>
                ))}
                <div className="flex justify-between py-2 px-3 border-t-2 border-gray-200 mt-2 font-bold">
                  <span className="text-sm text-gray-900">Total AR (must match Balance Sheet 1100)</span>
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
          <div className="flex items-center gap-3 mb-4"><span className="text-sm text-gray-600">As of:</span><input type="date" value={asOfDate} onChange={e => setAsOfDate(e.target.value)} className="border border-gray-200 rounded-xl px-3 py-1.5 text-sm" />{tbBalanced ? <span className="text-xs text-emerald-600 bg-emerald-50 px-3 py-1.5 rounded-xl">✓ Balanced</span> : <span className="text-xs text-red-600 bg-red-50 px-3 py-1.5 rounded-xl">⚠ Out of Balance by {acctFmt(Math.abs(tbTotalDebit - tbTotalCredit))}</span>}</div>
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50"><tr><th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">#</th><th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Account</th><th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Type</th><th className="px-4 py-3 text-right text-xs font-semibold text-gray-500">Debit</th><th className="px-4 py-3 text-right text-xs font-semibold text-gray-500">Credit</th></tr></thead>
              <tbody>{tbData.map(a => <tr key={a.id} className="border-t border-gray-50"><td className="px-4 py-2 font-mono text-xs text-gray-400">{a.id}</td><td className="px-4 py-2 text-gray-700 font-medium">{a.name}</td><td className="px-4 py-2 text-xs text-gray-500">{a.type}</td><td className="px-4 py-2 text-right font-mono">{a.debitBalance > 0 ? acctFmt(a.debitBalance) : ""}</td><td className="px-4 py-2 text-right font-mono">{a.creditBalance > 0 ? acctFmt(a.creditBalance) : ""}</td></tr>)}</tbody>
              <tfoot><tr className="border-t-2 border-gray-800 bg-gray-50"><td colSpan={3} className="px-4 py-3 text-right font-bold">TOTALS</td><td className={`px-4 py-3 text-right font-mono font-black ${tbBalanced?"text-emerald-700":"text-red-600"}`}>{acctFmt(tbTotalDebit)}</td><td className={`px-4 py-3 text-right font-mono font-black ${tbBalanced?"text-emerald-700":"text-red-600"}`}>{acctFmt(tbTotalCredit)}</td></tr></tfoot>
            </table>
          </div>
        </div>
      )}

      {/* General Ledger */}
      {activeReport === "gl" && (
        <div>
          <div className="flex items-center gap-3 mb-4">
            <span className="text-sm text-gray-600">Account:</span>
            <select value={selectedAccountId} onChange={e => setSelectedAccountId(e.target.value)} className="border border-gray-200 rounded-xl px-3 py-2 text-sm bg-white min-w-56">
              {ACCOUNT_TYPES.map(type => <optgroup key={type} label={type}>{accounts.filter(a=>a.type===type&&a.is_active).map(a => <option key={a.id} value={a.id}>{a.id} - {a.name}</option>)}</optgroup>)}
            </select>
          </div>
          {glAccount && (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
              <div className="flex justify-between mb-4"><div><h4 className="font-semibold text-gray-800">{glAccount.name}</h4><p className="text-xs text-gray-400">#{glAccount.id} · {glAccount.type} — {glAccount.subtype}</p></div>{glLines.length > 0 && <div className="text-right"><p className="text-xs text-gray-400">Ending Balance</p><p className="font-mono font-bold">{acctFmt(glLines[glLines.length-1].balance, true)}</p></div>}</div>
              <table className="w-full text-sm rounded-xl border border-gray-100 overflow-hidden">
                <thead className="bg-gray-50"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">Date</th><th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">Entry</th><th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">Description</th><th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">Memo</th><th className="px-4 py-2 text-right text-xs font-semibold text-gray-500">Debit</th><th className="px-4 py-2 text-right text-xs font-semibold text-gray-500">Credit</th><th className="px-4 py-2 text-right text-xs font-semibold text-gray-500">Balance</th></tr></thead>
                <tbody>
                  {glLines.length === 0 ? <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No transactions</td></tr> : glLines.map((l,i) => <tr key={i} className="border-t border-gray-50"><td className="px-4 py-2 text-xs text-gray-500">{acctFmtDate(l.date)}</td><td className="px-4 py-2 font-mono text-xs text-gray-400">{l.jeId}</td><td className="px-4 py-2 text-gray-700">{l.description}</td><td className="px-4 py-2 text-xs text-gray-400">{l.memo || "—"}</td><td className="px-4 py-2 text-right font-mono">{l.debit > 0 ? acctFmt(l.debit) : ""}</td><td className="px-4 py-2 text-right font-mono">{l.credit > 0 ? acctFmt(l.credit) : ""}</td><td className={`px-4 py-2 text-right font-mono font-semibold ${l.balance<0?"text-red-600":"text-gray-800"}`}>{acctFmt(l.balance, true)}</td></tr>)}
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
  const addRule = () => { if(!newRule.matchValue||!newRule.accountId)return;const acct=accounts.find(a=>a.id===newRule.accountId);setRules(r=>[...r,{...newRule,id:`R${Date.now()}`,accountName:acct?.name||""}]);setNewRule({matchType:"contains",matchValue:"",accountId:"",accountName:"",classId:""}); };
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
           { account_id:tx.accountId||"1000", account_name:tx.accountName||"Uncategorized", debit:0, credit:abs, class_id:tx.classId||null, memo:tx.memo||"" }]
        : [{ account_id:tx.accountId||"1000", account_name:tx.accountName||"Uncategorized", debit:abs, credit:0, class_id:tx.classId||null, memo:tx.memo||"" },
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
        <div><h3 className="text-lg font-semibold text-gray-900">Bank Statement Import</h3><p className="text-sm text-gray-500">Import CSV from your bank and post to journal entries</p></div>
        {step > 1 && !done && <button onClick={reset} className="text-xs text-gray-500 hover:text-gray-700 bg-gray-100 px-3 py-1.5 rounded-lg">🔄 Start Over</button>}
      </div>

      {/* Step Bar */}
      <div className="flex items-center gap-0 mb-6">
        {[{n:1,l:"Upload"},{n:2,l:"Map Columns"},{n:3,l:"Review"},{n:4,l:"Post"}].map((s,i)=>(
          <div key={s.n} className="flex items-center flex-1">
            <div className="flex flex-col items-center gap-1">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border-2 ${step>s.n?"bg-emerald-500 border-emerald-500 text-white":step===s.n?"bg-slate-800 border-slate-800 text-white":"bg-white border-gray-200 text-gray-400"}`}>{step>s.n?"✓":s.n}</div>
              <span className={`text-xs font-medium ${step===s.n?"text-slate-800":"text-gray-400"}`}>{s.l}</span>
            </div>
            {i<3&&<div className={`flex-1 h-0.5 mb-4 mx-2 ${step>s.n?"bg-emerald-400":"bg-gray-200"}`}/>}
          </div>
        ))}
      </div>

      {/* Step 1: Upload */}
      {step === 1 && (
        <div className="space-y-4 max-w-xl mx-auto">
          <div onClick={()=>fileRef.current?.click()} className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center gap-3 cursor-pointer ${file?"border-emerald-300 bg-emerald-50/50":"border-gray-200 hover:border-gray-400"}`}>
            <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={e=>{ const f=e.target.files[0]; if(f){setError("");setFile(f);} }} />
            {file ? <><p className="text-2xl">📄</p><p className="font-semibold text-emerald-800">{file.name}</p><p className="text-xs text-emerald-600">{(file.size/1024).toFixed(1)} KB · Click to change</p></> : <><p className="text-2xl">📤</p><p className="font-semibold text-gray-700">Drop CSV here or click to browse</p></>}
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-600 block mb-2">Import into Account *</label>
            {bankAccounts.map(a=>(
              <button key={a.id} onClick={()=>setBankAccountId(a.id)} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 text-left mb-2 ${bankAccountId===a.id?"border-slate-800 bg-slate-50":"border-gray-200 hover:border-gray-400"}`}>
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${bankAccountId===a.id?"bg-slate-800 text-white":"bg-gray-100 text-gray-400"}`}>🏦</div>
                <div className="flex-1"><p className="text-sm font-semibold text-gray-800">{a.name}</p><p className="text-xs text-gray-400">#{a.id} · {a.subtype}</p></div>
                {bankAccountId===a.id&&<span className="text-slate-800">✓</span>}
              </button>
            ))}
            {bankAccounts.length===0&&<p className="text-sm text-amber-600 bg-amber-50 rounded-xl px-4 py-3">No bank accounts found. Add one in Chart of Accounts first.</p>}
          </div>
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-xs text-blue-700"><strong>Supported:</strong> Chase, Bank of America, Wells Fargo, Citibank, Capital One, US Bank, and generic CSV</div>
          {error&&<p className="text-sm text-red-600 bg-red-50 rounded-xl px-4 py-3">⚠ {error}</p>}
          <div className="flex justify-end"><button onClick={handleUpload} disabled={!file||!bankAccountId} className="bg-slate-800 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50 hover:bg-slate-700">Continue →</button></div>
        </div>
      )}

      {/* Step 2: Map Columns */}
      {step === 2 && wizardData.parsed && (
        <div className="space-y-4 max-w-2xl mx-auto">
          <div className="flex items-center gap-2 mb-2">
            <h4 className="font-semibold text-gray-900">Map CSV Columns</h4>
            {wizardData.detected?.id!=="generic"&&<span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">⚡ Auto-detected: {wizardData.detected.name}</span>}
          </div>
          <div className="bg-gray-50 rounded-xl p-3"><p className="text-xs text-gray-500 mb-2">Headers found:</p><div className="flex flex-wrap gap-1.5">{wizardData.parsed.headers.map(h=><span key={h} className="text-xs bg-gray-200 text-gray-700 px-2 py-0.5 rounded-lg font-mono">{h}</span>)}</div></div>
          <div className="grid grid-cols-2 gap-3">
            {[{f:"date",l:"Date *"},{f:"description",l:"Description *"},{f:"amount",l:"Amount"},{f:"debit",l:"Debit"},{f:"credit",l:"Credit"},{f:"memo",l:"Memo"}].map(({f,l})=>(
              <div key={f}><label className="text-xs font-medium text-gray-600">{l}</label><select value={mapping[f]} onChange={e=>setMapping(m=>({...m,[f]:e.target.value}))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1"><option value="">— Not mapped —</option>{wizardData.parsed.headers.map(h=><option key={h} value={h}>{h}</option>)}</select></div>
            ))}
          </div>
          {!mappingValid&&<p className="text-xs text-amber-600 bg-amber-50 rounded-xl px-3 py-2">⚠ Date, Description, and at least one amount column required</p>}
          {/* Preview */}
          {mappingValid && (
            <div className="bg-white rounded-xl border border-gray-100 p-3 overflow-x-auto">
              <p className="text-xs font-semibold text-gray-500 mb-2">Preview (first 5 rows)</p>
              <table className="w-full text-xs"><thead><tr className="bg-gray-50"><th className="px-3 py-1 text-left">Date</th><th className="px-3 py-1 text-left">Description</th><th className="px-3 py-1 text-right">Amount</th></tr></thead>
              <tbody>{wizardData.parsed.rows.slice(0,5).map((row,i)=><tr key={i} className="border-t border-gray-50"><td className="px-3 py-1">{mapping.date?row[mapping.date]:""}</td><td className="px-3 py-1">{mapping.description?row[mapping.description]:""}</td><td className="px-3 py-1 text-right font-mono">{mapping.amount?row[mapping.amount]:mapping.debit?row[mapping.debit]:mapping.credit?row[mapping.credit]:""}</td></tr>)}</tbody></table>
            </div>
          )}
          <div className="flex justify-between"><button onClick={()=>setStep(1)} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg">← Back</button><button onClick={handleMapping} disabled={!mappingValid} className="bg-slate-800 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50">Continue →</button></div>
        </div>
      )}

      {/* Step 3: Review */}
      {step === 3 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between"><p className="text-sm text-gray-500">Importing into <strong>{bankAcct?.name}</strong> · {counts.total} transactions</p>
            <div className="flex gap-2"><button onClick={reapplyRules} className="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-lg">⚡ Re-apply Rules</button><button onClick={()=>setShowRules(!showRules)} className="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-lg">🏷️ Rules</button></div>
          </div>
          <div className="grid grid-cols-5 gap-2">
            {[{k:"all",l:"All",c:counts.total},{k:"pending",l:"Pending",c:counts.pending},{k:"approved",l:"Approved",c:counts.approved},{k:"skipped",l:"Skipped",c:counts.skipped},{k:"duplicate",l:"Duplicate",c:counts.duplicate}].map(s=>(
              <button key={s.k} onClick={()=>setFilterStatus(s.k)} className={`rounded-xl p-2 text-center border-2 ${filterStatus===s.k?"border-slate-800 bg-slate-50":"border-transparent bg-white"}`}><p className="text-lg font-bold">{s.c}</p><p className="text-xs text-gray-500">{s.l}</p></button>
            ))}
          </div>
          <div className="flex gap-2"><button onClick={approveAll} className="text-xs bg-emerald-100 text-emerald-700 px-3 py-1.5 rounded-lg">✓ Approve All</button><button onClick={skipAll} className="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-lg">⏭ Skip All</button>
            {counts.noAccount>0&&<span className="text-xs text-amber-600 bg-amber-50 px-3 py-1.5 rounded-lg ml-auto">⚠ {counts.noAccount} approved rows missing account</span>}
          </div>

          {/* Rules Panel */}
          {showRules && (
            <div className="bg-violet-50 border border-violet-100 rounded-xl p-4 space-y-3">
              <p className="text-xs font-semibold text-violet-700 uppercase">Auto-Categorization Rules</p>
              {rules.map(r=>(
                <div key={r.id} className="flex items-center gap-2 text-xs bg-white rounded-lg p-2 border border-violet-100">
                  <span className="text-gray-500">If</span><span className="bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded">{r.matchType}</span><span className="font-mono bg-gray-100 px-1.5 py-0.5 rounded">"{r.matchValue}"</span><span className="text-gray-500">→</span><span className="bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">{r.accountName||r.accountId}</span>
                  <button onClick={()=>removeRule(r.id)} className="ml-auto text-gray-300 hover:text-red-500">✕</button>
                </div>
              ))}
              <div className="grid grid-cols-4 gap-2">
                <select value={newRule.matchType} onChange={e=>setNewRule(r=>({...r,matchType:e.target.value}))} className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs"><option value="contains">Contains</option><option value="startsWith">Starts With</option><option value="equals">Equals</option><option value="regex">Regex</option></select>
                <input value={newRule.matchValue} onChange={e=>setNewRule(r=>({...r,matchValue:e.target.value}))} placeholder="Match text..." className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs" />
                <select value={newRule.accountId} onChange={e=>setNewRule(r=>({...r,accountId:e.target.value}))} className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs"><option value="">Account...</option>{accounts.filter(a=>a.is_active&&!["Bank"].includes(a.subtype)).map(a=><option key={a.id} value={a.id}>{a.id}-{a.name}</option>)}</select>
                <button onClick={addRule} className="bg-violet-600 text-white text-xs px-3 py-1.5 rounded-lg">+ Add</button>
              </div>
            </div>
          )}

          {/* Transaction Rows */}
          <div className="space-y-2">
            {filtered.map((tx,di)=>{
              const ri=transactions.findIndex(t=>t.id===tx.id);
              const colors={pending:"border-amber-200 bg-amber-50/30",approved:"border-emerald-200 bg-emerald-50/30",skipped:"border-gray-100 bg-gray-50/50 opacity-60",duplicate:"border-red-200 bg-red-50/30"};
              return (
                <div key={tx.id} className={`rounded-xl border-2 p-3 ${colors[tx.status]}`}>
                  <div className="flex items-start gap-3">
                    <span className="mt-1">{tx.amount>=0?"🟢":"🔴"}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div><p className="text-sm font-semibold text-gray-800">{tx.description}</p><p className="text-xs text-gray-400">{tx.date}{tx.matchedRule&&<span className="ml-1.5 text-violet-500">⚡ rule matched</span>}{tx.status==="duplicate"&&<span className="ml-1.5 text-red-500">⚠ Duplicate</span>}</p></div>
                        <span className={`font-mono font-bold text-sm ${tx.amount>=0?"text-emerald-700":"text-red-700"}`}>{tx.amount>=0?"+":""}{acctFmt(tx.amount)}</span>
                      </div>
                      {tx.status!=="skipped"&&tx.status!=="duplicate"&&(
                        <div className="flex gap-2 mt-2">
                          <select value={tx.accountId||""} onChange={e=>{const a=accounts.find(a=>a.id===e.target.value);setTx(ri,{accountId:e.target.value,accountName:a?.name||""});}} className={`border rounded-lg px-2 py-1 text-xs ${tx.status==="approved"&&!tx.accountId?"border-amber-300":"border-gray-200"}`}>
                            <option value="">— Assign account —</option>{ACCOUNT_TYPES.map(type=><optgroup key={type} label={type}>{accounts.filter(a=>a.type===type&&a.is_active&&a.id!==wizardData.bankAccountId).map(a=><option key={a.id} value={a.id}>{a.id}–{a.name}</option>)}</optgroup>)}
                          </select>
                          <select value={tx.classId||""} onChange={e=>setTx(ri,{classId:e.target.value})} className="border border-gray-200 rounded-lg px-2 py-1 text-xs"><option value="">No class</option>{classes.filter(c=>c.is_active).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-1">
                      {tx.status!=="duplicate"&&<><button onClick={()=>setTx(ri,{status:"approved"})} className={`p-1.5 rounded-lg ${tx.status==="approved"?"bg-emerald-500 text-white":"text-gray-300 hover:text-emerald-600"}`}>✓</button><button onClick={()=>setTx(ri,{status:"skipped"})} className={`p-1.5 rounded-lg ${tx.status==="skipped"?"bg-gray-400 text-white":"text-gray-300 hover:text-gray-500"}`}>⏭</button></>}
                      {tx.status==="duplicate"&&<button onClick={()=>setTx(ri,{status:"pending",matchedJEId:null})} className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600" title="Import anyway">🔄</button>}
                    </div>
                  </div>
                </div>
              );
            })}
            {filtered.length===0&&<p className="text-center py-8 text-gray-400 text-sm">No transactions in this filter</p>}
          </div>
          <div className="flex justify-between"><button onClick={()=>setStep(2)} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg">← Back</button><button onClick={()=>setStep(4)} disabled={counts.approved===0||counts.noAccount>0} className="bg-slate-800 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50">Post {counts.approved} Transactions →</button></div>
        </div>
      )}

      {/* Step 4: Confirm & Post */}
      {step === 4 && !done && (
        <div className="space-y-4 max-w-xl mx-auto">
          <h4 className="font-semibold text-gray-900">Confirm & Post</h4>
          <div className="bg-white rounded-xl border border-gray-100 p-4 space-y-2">
            <div className="flex justify-between text-sm"><span className="text-gray-500">Bank Account</span><span className="font-bold">{bankAcct?.name}</span></div>
            <div className="flex justify-between text-sm"><span className="text-gray-500">Deposits</span><span className="font-mono text-emerald-700">+{acctFmt(transactions.filter(t=>t.status==="approved"&&t.amount>=0).reduce((s,t)=>s+t.amount,0))} ({transactions.filter(t=>t.status==="approved"&&t.amount>=0).length})</span></div>
            <div className="flex justify-between text-sm"><span className="text-gray-500">Payments</span><span className="font-mono text-red-700">{acctFmt(transactions.filter(t=>t.status==="approved"&&t.amount<0).reduce((s,t)=>s+t.amount,0))} ({transactions.filter(t=>t.status==="approved"&&t.amount<0).length})</span></div>
            <div className="flex justify-between text-sm border-t pt-2"><span className="font-bold">Entries to create</span><span className="font-bold">{transactions.filter(t=>t.status==="approved").length}</span></div>
          </div>
          <div className="flex justify-between"><button onClick={()=>setStep(3)} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg">← Back</button><button onClick={handlePost} disabled={posting} className="bg-emerald-600 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50">{posting?"Posting...":"✓ Post All Entries"}</button></div>
        </div>
      )}

      {/* Step 5: Done */}
      {done && (
        <div className="flex flex-col items-center py-12 gap-4">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center text-3xl">✓</div>
          <h4 className="text-xl font-bold text-gray-900">Import Complete!</h4>
          <p className="text-sm text-gray-500">{postedCount} journal entries posted to <strong>{bankAcct?.name}</strong></p>
          <button onClick={reset} className="bg-slate-800 text-white text-sm px-4 py-2 rounded-lg mt-2">Import Another File</button>
        </div>
      )}

      {/* Import History */}
      {importHistory.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 mt-4">
          <h4 className="font-semibold text-gray-700 mb-3">Import History</h4>
          {importHistory.map((h,i)=>(
            <div key={i} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
              <div><p className="text-sm font-medium text-gray-700">{h.fileName}</p><p className="text-xs text-gray-400">{h.date} · {h.bankAccount}</p></div>
              <div className="text-right"><p className={`font-mono text-sm font-semibold ${h.net>=0?"text-emerald-700":"text-red-700"}`}>{acctFmt(h.net,true)}</p><p className="text-xs text-gray-400">{h.count} entries</p></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Main Accounting Component (Supabase-backed) ---
function Accounting({ companyId, activeCompany }) {
  const [acctAccounts, setAcctAccounts] = useState([]);
  const [journalEntries, setJournalEntries] = useState([]);
  const [acctClasses, setAcctClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");
  const companyName = activeCompany?.name || "My Company";

  useEffect(() => { fetchAll(); }, []);

  async function fetchAll() {
    setLoading(true);
    const [acctsRes, jesRes, clsRes] = await Promise.all([
      supabase.from("acct_accounts").select("*").eq("company_id", companyId || "sandbox-llc").order("id"),
      supabase.from("acct_journal_entries").select("*").eq("company_id", companyId || "sandbox-llc").order("date", { ascending: false }),
      supabase.from("acct_classes").select("*").eq("company_id", companyId || "sandbox-llc").order("name"),
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
    if (!window._propClassesSynced) {
    const { data: allProps } = await supabase.from("properties").select("id, address, type, rent").eq("company_id", companyId || "sandbox-llc");
    if (allProps && allProps.length > 0) {
      const existingNames = new Set(classes.map(c => c.name));
      const colors = ["#3B82F6","#10B981","#F59E0B","#EF4444","#8B5CF6","#06B6D4","#F97316","#EC4899"];
      const missing = allProps.filter(p => !existingNames.has(p.address));
      if (missing.length > 0) {
        const newClasses = missing.map(p => ({
          id: `PROP-${p.id}`,
          name: p.address,
          description: `${p.type || "Property"} · $${p.rent || 0}/mo`,
          color: colors[Math.floor(Math.random() * colors.length)],
          is_active: true,
          company_id: companyId || "sandbox-llc",
        }));
        await supabase.from("acct_classes").upsert(newClasses, { onConflict: "id" });
        // Re-fetch classes after sync
        const { data: updatedClasses } = await supabase.from("acct_classes").select("*").eq("company_id", companyId || "sandbox-llc").order("name");
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
    setLoading(false);
  }

  // --- Account CRUD ---
  async function addAccount(acct) {
    await supabase.from("acct_accounts").insert([{ ...acct, company_id: companyId || "sandbox-llc" }]);
    fetchAll();
  }
  async function updateAccount(acct) {
    const { id } = acct;
    await supabase.from("acct_accounts").update({
      name: acct.name, type: acct.type, subtype: acct.subtype, 
      is_active: acct.is_active, description: acct.description || "",
      parent_id: acct.parent_id || null
    }).eq("id", id);
    fetchAll();
  }
  async function toggleAccount(id, currentActive) {
    await supabase.from("acct_accounts").update({ is_active: !currentActive }).eq("company_id", companyId || "sandbox-llc").eq("id", id);
    fetchAll();
  }

  // --- Journal Entry CRUD ---
  async function addJournalEntry(data) {
    const { lines, ...header } = data;
    // Try atomic RPC first
    try {
      const { data: jeId, error: rpcErr } = await supabase.rpc("create_journal_entry", {
        p_company_id: companyId || "sandbox-llc",
        p_date: header.date,
        p_description: header.description,
        p_reference: header.reference || "",
        p_property: header.property || "",
        p_status: header.status || "draft",
        p_lines: JSON.stringify(lines || []),
      });
      if (!rpcErr && jeId) { fetchAll(); return; }
      console.warn("addJE RPC fallback:", rpcErr?.message);
    } catch (e) { console.warn("addJE RPC not available:", e.message); }
    // Fallback: client-side with cleanup
    const number = nextJENumber(journalEntries);
    const jeId = generateId("je");
    const { error: headerErr } = await supabase.from("acct_journal_entries").insert([{ company_id: companyId || "sandbox-llc", id: jeId, number, date: header.date, description: header.description, reference: header.reference || "", property: header.property || "", status: header.status || "draft" }]);
    if (headerErr) { alert("Error creating journal entry: " + headerErr.message); return; }
    if (lines?.length > 0) {
      const { error: linesErr } = await supabase.from("acct_journal_lines").insert(lines.map(l => ({ journal_entry_id: jeId, account_id: l.account_id, account_name: l.account_name, debit: safeNum(l.debit), credit: safeNum(l.credit), class_id: l.class_id || null, memo: l.memo || "" })));
      if (linesErr) {
        console.warn("JE lines failed, cleaning up:", linesErr.message);
        await supabase.from("acct_journal_entries").delete().eq("id", jeId);
        alert("Error creating journal entry lines: " + linesErr.message);
        return;
      }
    }
    fetchAll();
  }
  async function updateJournalEntry(data) {
    const { id, lines, ...header } = data;
    delete header.created_at;
    delete header.number;
    // Save old lines before deleting so we can restore on failure
    const { data: oldLines } = await supabase.from("acct_journal_lines").select("*").eq("journal_entry_id", id);
    await supabase.from("acct_journal_entries").update({ date: header.date, description: header.description, reference: header.reference || "", property: header.property || "", status: header.status }).eq("company_id", companyId || "sandbox-llc").eq("id", id);
    // Replace lines
    await supabase.from("acct_journal_lines").delete().eq("journal_entry_id", id);
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
    await supabase.from("acct_journal_entries").update({ status: "posted" }).eq("company_id", companyId || "sandbox-llc").eq("id", id);
    fetchAll();
  }
  async function voidJournalEntry(id) {
    // Find the JE to check if it affected a tenant balance
    const je = journalEntries.find(j => j.id === id);
    await supabase.from("acct_journal_entries").update({ status: "voided" }).eq("company_id", companyId || "sandbox-llc").eq("id", id);
    // Reverse tenant balance based on JE type
    if (je) {
      const { data: jeLines } = await supabase.from("acct_journal_lines").select("*").eq("journal_entry_id", id);
      const arAccountIds = new Set(accounts.filter(a => a.name === "Accounts Receivable").map(a => a.id));
      const tenantName = (je.description || "").split(" — ")[1] || "";
      
      if (tenantName.trim()) {
        const { data: tenantRow } = await supabase.from("tenants").select("id, balance").ilike("name", tenantName.trim()).eq("company_id", companyId || "sandbox-llc").maybeSingle();
        
        if (tenantRow && jeLines) {
          // Calculate AR impact: net of debits and credits on AR accounts
          const arImpact = jeLines.filter(l => arAccountIds.has(l.account_id))
            .reduce((s, l) => s + safeNum(l.debit) - safeNum(l.credit), 0);
          
          if (Math.abs(arImpact) > 0.01) {
            // Reverse: if charge increased AR (positive), decrease balance; if payment decreased AR (negative), increase balance
            try {
              await supabase.rpc("update_tenant_balance", { p_tenant_id: tenantRow.id, p_amount_change: -arImpact });
            } catch {
              await supabase.from("tenants").update({ balance: safeNum(tenantRow.balance) - arImpact }).eq("company_id", companyId || "sandbox-llc").eq("id", tenantRow.id); // balance update (unchecked ok — RPC primary)
            }
            await safeLedgerInsert({ company_id: companyId || "sandbox-llc",
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
    await supabase.from("acct_classes").insert([{ ...cls, company_id: companyId || "sandbox-llc" }]);
    fetchAll();
  }
  async function updateClass(cls) {
    const { id } = cls;
    await supabase.from("acct_classes").update({
      name: cls.name, type: cls.type, is_active: cls.is_active,
      description: cls.description || "", color: cls.color || "#3B82F6"
    }).eq("id", id);
    fetchAll();
  }
  async function toggleClass(id, currentActive) {
    await supabase.from("acct_classes").update({ is_active: !currentActive }).eq("id", id);
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
      <h2 className="text-xl font-bold text-gray-800 mb-5">Accounting & Financials</h2>
      <div className="flex gap-2 mb-5 border-b border-gray-100 overflow-x-auto">
        {[["overview","Overview"],["coa","Chart of Accounts"],["journal","Journal Entries"],["bankimport","Bank Import"],["reconcile","Reconcile"],["classes","Class Tracking"],["reports","Reports"]].map(([id,label]) => (
          <button key={id} onClick={() => setActiveTab(id)} className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${activeTab === id ? "border-indigo-600 text-indigo-700" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
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
            <StatCard label="Net Income" value={acctFmt(plData.netIncome)} color={plData.netIncome >= 0 ? "text-blue-700" : "text-red-600"} sub="Year to date" />
            <StatCard label="Total Assets" value={acctFmt(bsData.totalAssets)} color="text-purple-700" sub="Balance sheet" />
          </div>
          {/* Monthly Rent Accrual */}
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-blue-800">Monthly Rent Accrual</p>
              <p className="text-xs text-blue-600">Generate AR entries for all active leases this month (DR Accounts Receivable, CR Rental Income)</p>
            </div>
            <button onClick={async () => {
              const { data: activeTenants } = await supabase.from("tenants").select("*").eq("company_id", companyId || "sandbox-llc").eq("lease_status", "active");
              if (!activeTenants || activeTenants.length === 0) { alert("No active leases found."); return; }
              const today = formatLocalDate(new Date());
              const month = today.slice(0, 7);
              // Check if already accrued this month
              const { data: existing } = await supabase.from("acct_journal_entries").select("id").eq("company_id", companyId || "sandbox-llc").like("reference", `ACCR-${month}%`).neq("status", "voided");
              if (existing && existing.length > 0) { alert("Rent already accrued for " + month + ". " + existing.length + " entries exist."); return; }
              let count = 0;
              for (const t of activeTenants) {
                const rent = safeNum(t.rent);
                if (rent <= 0) continue;
                const classId = await getPropertyClassId(t.property, companyId);
                await autoPostJournalEntry({
                  companyId,
                  date: today,
                  description: `Rent accrual ${month} — ${t.name} — ${t.property}`,
                  reference: `ACCR-${month}-${t.id}`,
                  property: t.property,
                  lines: [
                    { account_id: "1100", account_name: "Accounts Receivable", debit: rent, credit: 0, class_id: classId, memo: `${t.name} rent due` },
                    { account_id: "4000", account_name: "Rental Income", debit: 0, credit: rent, class_id: classId, memo: `${t.name} — ${t.property}` },
                  ]
                });
                // Update tenant balance (they now owe this amount)
                try {
                  await supabase.rpc("update_tenant_balance", { p_tenant_id: t.id, p_amount_change: rent });
                } catch {
                  await supabase.from("tenants").update({ balance: safeNum(t.balance) + rent }).eq("company_id", companyId || "sandbox-llc").eq("id", t.id); // balance update (unchecked ok — RPC primary)
                }
                // Create ledger entry
                await safeLedgerInsert({ company_id: companyId || "sandbox-llc",
                  tenant: t.name, property: t.property, date: today,
                  description: `Rent accrual — ${month}`, amount: rent, type: "charge", balance: 0,
                });
                count++;
              }
              alert("Accrued rent for " + count + " active leases for " + month);
              fetchAll();
            }} className="bg-blue-600 text-white text-xs px-4 py-2 rounded-lg hover:bg-blue-700 shrink-0">Generate Accruals</button>
          </div>
          {pendingCount > 0 && <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 mb-4 text-sm text-amber-700">⏳ {pendingCount} draft journal {pendingCount === 1 ? "entry" : "entries"} awaiting review</div>}
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 mb-4">
            <h3 className="font-semibold text-gray-700 mb-3">Recent Journal Entries</h3>
            {journalEntries.slice(0, 5).map(je => {
              const total = (je.lines || []).reduce((s,l) => s + safeNum(l.debit), 0);
              return (
                <div key={je.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full ${je.status==="posted"?"bg-emerald-400":je.status==="draft"?"bg-amber-400":"bg-gray-300"}`} />
                    <div><p className="text-sm font-medium text-gray-700">{je.description}</p><p className="text-xs text-gray-400">{je.number} · {je.date}</p></div>
                  </div>
                  <span className="font-mono text-sm font-semibold text-gray-700">{acctFmt(total)}</span>
                </div>
              );
            })}
            {journalEntries.length === 0 && <p className="text-sm text-gray-400 text-center py-4">No journal entries yet. Start by creating one in the Journal Entries tab.</p>}
          </div>
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <h3 className="font-semibold text-gray-700 mb-3">Account Summary</h3>
            <div className="grid grid-cols-2 gap-3">
              {["Asset","Liability","Equity","Revenue","Expense"].map(type => {
                const total = calcAllBalances(acctAccounts, journalEntries).filter(a => a.type === type && a.is_active).reduce((s,a) => s + a.computedBalance, 0);
                return (
                  <div key={type} className="flex justify-between items-center py-2 px-3 bg-gray-50 rounded-lg">
                    <span className="text-sm text-gray-600">{type}</span>
                    <span className={`font-mono text-sm font-semibold ${total < 0 ? "text-red-600" : "text-gray-800"}`}>{acctFmt(total, true)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

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

  useEffect(() => { fetchDocs(); }, []);

  async function fetchDocs() {
    const { data } = await supabase.from("documents").select("*").eq("company_id", companyId || "sandbox-llc").order("uploaded_at", { ascending: false });
    setDocs(data || []);
    setLoading(false);
  }

  async function uploadDocument() {
    const file = fileRef.current?.files?.[0];
    if (!file || !form.name) return;
    setUploading(true);
    const fileName = `${Date.now()}_${file.name}`;
    const { error: uploadError } = await supabase.storage.from("documents").upload(fileName, file, {
      cacheControl: "3600",
      upsert: false,
    });
    if (uploadError) {
      alert("Upload failed: " + uploadError.message);
      setUploading(false);
      return;
    }
    const { data: urlData } = supabase.storage.from("documents").getPublicUrl(fileName);
    const publicUrl = urlData?.publicUrl || "";
    if (!publicUrl) {
      alert("Upload succeeded but could not generate public URL. Check that your 'documents' bucket is set to Public in Supabase Storage settings.");
      setUploading(false);
      return;
    }
    const { error: insertError } = await supabase.from("documents").insert([{ company_id: companyId || "sandbox-llc",
      name: form.name,
      property: form.property,
      tenant: form.tenant || "",
      type: form.type,
      tenant_visible: form.tenant_visible,
      url: publicUrl,
      file_name: fileName,
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
  }

  async function deleteDoc(id, name, file_name) {
    if (!window.confirm(`Delete "${name}"?`)) return;
    // Also delete from storage if file_name is known
    if (file_name) {
      await supabase.storage.from("documents").remove([file_name]);
    }
    const { error } = await supabase.from("documents").delete().eq("id", id).eq("company_id", companyId || "sandbox-llc");
    if (error) { alert("Error deleting document: " + error.message); return; }
    addNotification("🗑️", `Document deleted: ${name}`);
    fetchDocs();
  }

  // Repair existing documents that have empty/broken url
  async function repairUrls() {
    let repaired = 0;
    for (const d of docs) {
      if (d.file_name && !d.url) {
        const { data } = supabase.storage.from("documents").getPublicUrl(d.file_name);
        if (data?.publicUrl) {
          await supabase.from("documents").update({ url: data.publicUrl }).eq("company_id", companyId || "sandbox-llc").eq("id", d.id);
          repaired++;
        }
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
        <h2 className="text-xl font-bold text-gray-800">Document Management</h2>
        <div className="flex gap-2">
          <button onClick={repairUrls} className="bg-amber-500 text-white text-sm px-4 py-2 rounded-lg hover:bg-amber-600" title="Fix broken View links for existing documents">🔧 Repair URLs</button>
          <button onClick={() => setShowForm(!showForm)} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">+ Upload Document</button>
        </div>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-gray-700 mb-3">Upload Document</h3>
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Document name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} className="flex-1" companyId={companyId} />
            <input placeholder="Tenant name (optional)" value={form.tenant} onChange={e => setForm({ ...form, tenant: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              {["Lease", "Inspection", "Maintenance", "Financial", "Notice", "Other"].map(t => <option key={t}>{t}</option>)}
            </select>
            <label className="flex items-center gap-2 text-sm text-gray-600 border border-gray-200 rounded-lg px-3 py-2 cursor-pointer">
              <input type="checkbox" checked={form.tenant_visible} onChange={e => setForm({ ...form, tenant_visible: e.target.checked })} />
              Visible to Tenant
            </label>
            <input type="file" ref={fileRef} className="border border-gray-200 rounded-lg px-3 py-2 text-sm col-span-2" />
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={uploadDocument} disabled={uploading} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-50">
              {uploading ? "Uploading..." : "Upload"}
            </button>
            <button onClick={() => setShowForm(false)} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg hover:bg-gray-200">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex gap-2 mb-4 flex-wrap">
        {["all", "Lease", "Inspection", "Maintenance", "Financial", "Notice", "Other"].map(t => (
          <button key={t} onClick={() => setFilter(t)} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${filter === t ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{t}</button>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
            <tr>{["Document", "Property", "Type", "Date", "Tenant Visible", "Actions"].map(h => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {filtered.map(d => (
              <tr key={d.id} className="border-t border-gray-50 hover:bg-gray-50">
                <td className="px-3 py-2.5 font-medium text-gray-800">📄 {d.name}</td>
                <td className="px-3 py-2.5 text-gray-500">{d.property}</td>
                <td className="px-3 py-2.5"><span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full text-xs">{d.type}</span></td>
                <td className="px-3 py-2.5 text-gray-500">{d.uploaded_at?.slice(0, 10)}</td>
                <td className="px-3 py-2.5">{d.tenant_visible ? "✅" : "🔒"}</td>
                <td className="px-3 py-2.5">
                  <div className="flex gap-2">
                    {d.url ? (
                      <>
                        <a href={d.url} target="_blank" rel="noreferrer" className="text-xs text-indigo-600 hover:underline">View</a>
                        <a href={d.url} download className="text-xs text-green-600 hover:underline">Download</a>
                      </>
                    ) : d.file_name ? (
                      <>
                        <button onClick={() => {
                          const { data } = supabase.storage.from("documents").getPublicUrl(d.file_name);
                          if (data?.publicUrl) window.open(data.publicUrl, "_blank");
                          else alert("Could not generate URL for this file.");
                        }} className="text-xs text-indigo-600 hover:underline">View</button>
                      </>
                    ) : (
                      <span className="text-xs text-gray-400">No file</span>
                    )}
                    <button onClick={() => deleteDoc(d.id, d.name, d.file_name)} className="text-xs text-red-400 hover:underline">Delete</button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-400">No documents yet. Upload one above.</td></tr>
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

  useEffect(() => { fetchInspections(); }, []);

  async function fetchInspections() {
    const { data } = await supabase.from("inspections").select("*").eq("company_id", companyId || "sandbox-llc").order("date", { ascending: false });
    setInspections(data || []);
    setLoading(false);
  }

  async function saveInspection() {
    if (!form.property.trim()) { alert("Property is required."); return; }
    if (!form.date) { alert("Inspection date is required."); return; }
    const { error } = await supabase.from("inspections").insert([{ company_id: companyId || "sandbox-llc", ...form, checklist: JSON.stringify(checklist) }]);
    if (error) { alert("Error saving inspection: " + error.message); return; }
    addNotification("🔍", `Inspection scheduled: ${form.type} at ${form.property}`);
    setShowForm(false);
    setForm({ property: "", type: "Move-In", inspector: "", date: formatLocalDate(new Date()), status: "scheduled", notes: "" });
    setChecklist({});
    fetchInspections();
  }

  async function updateStatus(id, status) {
    await supabase.from("inspections").update({ status }).eq("id", id);
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
            <div className="flex justify-between text-sm"><span className="text-gray-400">Type</span><span className="font-medium">{selectedInspection.type}</span></div>
            <div className="flex justify-between text-sm"><span className="text-gray-400">Date</span><span className="font-medium">{selectedInspection.date}</span></div>
            <div className="flex justify-between text-sm"><span className="text-gray-400">Inspector</span><span className="font-medium">{selectedInspection.inspector || "—"}</span></div>
            <div className="flex justify-between text-sm"><span className="text-gray-400">Status</span><Badge status={selectedInspection.status} /></div>
          </div>
          {selectedInspection.notes && <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-600 mb-4">{selectedInspection.notes}</div>}
          {selectedInspection.checklist && (() => {
            try {
              const cl = JSON.parse(selectedInspection.checklist);
              return (
                <div>
                  <h4 className="font-semibold text-gray-700 mb-2 text-sm">Checklist</h4>
                  <div className="space-y-1">
                    {Object.entries(cl).map(([item, val]) => (
                      <div key={item} className="flex items-center justify-between text-sm py-1 border-b border-gray-50">
                        <span className="text-gray-700">{item}</span>
                        <span className={val.pass === true ? "text-green-600 font-semibold" : val.pass === false ? "text-red-500 font-semibold" : "text-gray-400"}>
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
        <h2 className="text-xl font-bold text-gray-800">Inspections</h2>
        <button onClick={() => { setShowForm(!showForm); initChecklist("Move-In"); }} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">+ New Inspection</button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-gray-700 mb-3">New Inspection</h3>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} className="flex-1" companyId={companyId} />
            <select value={form.type} onChange={e => { setForm({ ...form, type: e.target.value }); initChecklist(e.target.value); }} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              {["Move-In", "Move-Out", "Periodic"].map(t => <option key={t}>{t}</option>)}
            </select>
            <input placeholder="Inspector name" value={form.inspector} onChange={e => setForm({ ...form, inspector: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <textarea placeholder="Notes" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm col-span-2" rows={2} />
          </div>

          {/* Checklist */}
          <h4 className="font-semibold text-gray-700 mb-2 text-sm">Checklist Items</h4>
          <div className="space-y-2 mb-4">
            {Object.entries(checklist).map(([item, val]) => (
              <div key={item} className="flex items-center gap-3 bg-gray-50 rounded-lg px-3 py-2">
                <span className="text-sm text-gray-700 flex-1">{item}</span>
                <button onClick={() => setChecklist({ ...checklist, [item]: { ...val, pass: true } })} className={`text-xs px-2 py-1 rounded ${val.pass === true ? "bg-green-500 text-white" : "bg-gray-200 text-gray-600"}`}>Pass</button>
                <button onClick={() => setChecklist({ ...checklist, [item]: { ...val, pass: false } })} className={`text-xs px-2 py-1 rounded ${val.pass === false ? "bg-red-500 text-white" : "bg-gray-200 text-gray-600"}`}>Fail</button>
                <input placeholder="Note" value={val.notes} onChange={e => setChecklist({ ...checklist, [item]: { ...val, notes: e.target.value } })} className="border border-gray-200 rounded px-2 py-1 text-xs w-32" />
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <button onClick={saveInspection} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">Save Inspection</button>
            <button onClick={() => setShowForm(false)} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg hover:bg-gray-200">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {inspections.map(insp => (
          <div key={insp.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <div className="flex justify-between items-start">
              <div>
                <div className="font-semibold text-gray-800">{insp.property}</div>
                <div className="text-xs text-gray-400 mt-0.5">{insp.type} Inspection · {insp.inspector}</div>
              </div>
              <Badge status={insp.status} label={insp.status} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div><span className="text-gray-400">Date</span><div className="font-semibold text-gray-700">{insp.date}</div></div>
              <div><span className="text-gray-400">Type</span><div className="font-semibold text-gray-700">{insp.type}</div></div>
            </div>
            <div className="mt-3 flex gap-2 flex-wrap">
              <button onClick={() => setSelectedInspection(insp)} className="text-xs text-indigo-600 border border-indigo-200 px-3 py-1 rounded-lg hover:bg-indigo-50">📋 View Report</button>
              {insp.status === "scheduled" && <button onClick={() => updateStatus(insp.id, "completed")} className="text-xs text-green-600 border border-green-200 px-3 py-1 rounded-lg hover:bg-green-50">✓ Mark Complete</button>}
            </div>
          </div>
        ))}
        {inspections.length === 0 && <div className="text-center py-12 text-gray-400">No inspections yet. Create one above.</div>}
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

  useEffect(() => { fetchData(); }, []);

  async function fetchData() {
    setLoading(true);
    const [l, t, p, tmpl] = await Promise.all([
      supabase.from("leases").select("*").eq("company_id", companyId || "sandbox-llc").order("created_at", { ascending: false }),
      supabase.from("tenants").select("*").eq("company_id", companyId || "sandbox-llc"),
      supabase.from("properties").select("*").eq("company_id", companyId || "sandbox-llc"),
      supabase.from("lease_templates").select("*").eq("company_id", companyId || "sandbox-llc").order("name"),
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
    if (!form.tenant_name) { alert("Please select a tenant."); return; }
    if (!form.property) { alert("Please select a property."); return; }
    if (!form.start_date || !form.end_date) { alert("Lease start and end dates are required."); return; }
    if (!form.rent_amount || isNaN(Number(form.rent_amount)) || Number(form.rent_amount) <= 0) { alert("Please enter a valid positive rent amount."); return; }
    if (form.start_date >= form.end_date) { alert("Lease end date must be after start date."); return; }
    const tenant = tenants.find(t => t.name === form.tenant_name);
    const payload = {
      tenant_id: tenant?.id || null, tenant_name: form.tenant_name, property: form.property,
      start_date: form.start_date, end_date: form.end_date, rent_amount: Number(form.rent_amount),
      security_deposit: Number(form.security_deposit || 0), rent_escalation_pct: Number(form.rent_escalation_pct || 0),
      escalation_frequency: form.escalation_frequency, payment_due_day: Math.max(1, Math.min(31, Number(form.payment_due_day || 1))),
      lease_type: form.lease_type, auto_renew: form.auto_renew, renewal_notice_days: Number(form.renewal_notice_days || 60),
      clauses: form.clauses, special_terms: form.special_terms, status: "active",
      late_fee_amount: Number(form.late_fee_amount || 50), late_fee_type: form.late_fee_type || "flat", late_fee_grace_days: Number(form.late_fee_grace_days || 5),
      move_in_checklist: JSON.stringify(defaultChecklist.map(item => ({ item, checked: false }))),
      move_out_checklist: JSON.stringify(defaultMoveOutChecklist.map(item => ({ item, checked: false }))),
      created_by: userProfile?.email || "",
    };
    let error;
    if (editingLease) {
      ({ error } = await supabase.from("leases").update({ tenant_name: payload.tenant_name, property: payload.property, start_date: payload.start_date, end_date: payload.end_date, rent_amount: payload.rent_amount, security_deposit: payload.security_deposit, rent_escalation_pct: payload.rent_escalation_pct, escalation_frequency: payload.escalation_frequency, payment_due_day: payload.payment_due_day, lease_type: payload.lease_type, auto_renew: payload.auto_renew, renewal_notice_days: payload.renewal_notice_days, clauses: payload.clauses, special_terms: payload.special_terms, late_fee_amount: payload.late_fee_amount, late_fee_type: payload.late_fee_type, late_fee_grace_days: payload.late_fee_grace_days }).eq("id", editingLease.id).eq("company_id", companyId || "sandbox-llc"));
    } else {
      ({ error } = await supabase.from("leases").insert([{ ...payload, company_id: companyId || "sandbox-llc" }]));
      if (!error && tenant) {
        await supabase.from("tenants").update({ lease_status: "active", move_in: form.start_date, move_out: form.end_date, rent: Number(form.rent_amount) }).eq("company_id", companyId || "sandbox-llc").eq("id", tenant.id);
      }
      if (!error && Number(form.security_deposit) > 0) {
        const classId = await getPropertyClassId(form.property, companyId);
        const dep = Number(form.security_deposit);
        await autoPostJournalEntry({ companyId, date: form.start_date, description: "Security deposit received — " + form.tenant_name + " — " + form.property, reference: "DEP-" + Date.now(), property: form.property,
          lines: [
            { account_id: "1000", account_name: "Checking Account", debit: dep, credit: 0, class_id: classId, memo: "Security deposit from " + form.tenant_name },
            { account_id: "2100", account_name: "Security Deposits Held", debit: 0, credit: dep, class_id: classId, memo: form.tenant_name + " — " + form.property },
          ]
        });
        // Create ledger entry for deposit collection
        if (tenant?.id) {
          await safeLedgerInsert({ company_id: companyId || "sandbox-llc",
            tenant: form.tenant_name, property: form.property, date: form.start_date,
            description: "Security deposit collected", amount: dep, type: "deposit", balance: 0,
          });
        }
      }
    }
    if (error) { alert("Error saving lease: " + error.message); return; }
    // Auto-post rent charges for this lease immediately
    if (!editingLease) await autoPostRentCharges(companyId);
    logAudit(editingLease ? "update" : "create", "leases", (editingLease ? "Updated" : "Created") + " lease: " + form.tenant_name + " at " + form.property, editingLease?.id || "", userProfile?.email, userRole, companyId);
    resetForm(); fetchData();
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
    const { error: updateErr } = await supabase.from("leases").update({ status: "renewed" }).eq("company_id", companyId || "sandbox-llc").eq("id", lease.id);
    if (updateErr) { alert("Error updating old lease: " + updateErr.message); return; }
    const { error: insertErr } = await supabase.from("leases").insert([{ company_id: companyId || "sandbox-llc", tenant_id: lease.tenant_id, tenant_name: lease.tenant_name, property: lease.property, start_date: newStart, end_date: formatLocalDate(newEnd), rent_amount: Math.round(escalated * 100) / 100, security_deposit: lease.security_deposit, rent_escalation_pct: lease.rent_escalation_pct, escalation_frequency: lease.escalation_frequency, payment_due_day: lease.payment_due_day, lease_type: "renewal", auto_renew: lease.auto_renew, renewal_notice_days: lease.renewal_notice_days, clauses: lease.clauses, special_terms: lease.special_terms, status: "active", renewed_from: lease.id, created_by: userProfile?.email || "", move_in_checklist: "[]", move_out_checklist: lease.move_out_checklist }]);
    if (insertErr) {
      await supabase.from("leases").update({ status: "active" }).eq("company_id", companyId || "sandbox-llc").eq("id", lease.id); // rollback
      alert("Error creating renewed lease: " + insertErr.message); return;
    }
    if (lease.tenant_id) await supabase.from("tenants").update({ rent: Math.round(escalated * 100) / 100, move_out: formatLocalDate(newEnd) }).eq("company_id", companyId || "sandbox-llc").eq("id", lease.tenant_id);
    logAudit("create", "leases", "Renewed lease: " + lease.tenant_name + " new rent $" + Math.round(escalated * 100) / 100, lease.id, userProfile?.email, userRole, companyId);
    await autoPostRentCharges(companyId);
    fetchData();
  }

  async function terminateLease(lease) {
    if (!window.confirm("Terminate lease for " + lease.tenant_name + "? This cannot be undone.")) return;
    await supabase.from("leases").update({ status: "terminated" }).eq("company_id", companyId || "sandbox-llc").eq("id", lease.id);
    if (lease.tenant_id) {
      await supabase.from("tenants").update({ lease_status: "inactive" }).eq("company_id", companyId || "sandbox-llc").eq("id", lease.tenant_id);
      // Create termination ledger entry
      await safeLedgerInsert({ company_id: companyId || "sandbox-llc",
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
    await supabase.from("leases").update(update).eq("id", lease.id).eq("company_id", companyId || "sandbox-llc");
    fetchData();
  }

  async function processDepositReturn(lease) {
    const returned = Number(depositForm.amount_returned || 0);
    const deposit = safeNum(lease.security_deposit);
    const deducted = deposit - returned;
    const status = returned >= deposit ? "returned" : returned > 0 ? "partial_return" : "forfeited";
    await supabase.from("leases").update({ deposit_status: status, deposit_returned: returned, deposit_return_date: depositForm.return_date, deposit_deductions: depositForm.deductions }).eq("company_id", companyId || "sandbox-llc").eq("id", lease.id);
    const classId = await getPropertyClassId(lease.property, companyId);
    if (returned > 0) {
      await autoPostJournalEntry({ companyId, date: depositForm.return_date, description: "Security deposit return — " + lease.tenant_name, reference: "DEPRET-" + Date.now(), property: lease.property,
        lines: [
          { account_id: "2100", account_name: "Security Deposits Held", debit: returned, credit: 0, class_id: classId, memo: "Return to " + lease.tenant_name },
          { account_id: "1000", account_name: "Checking Account", debit: 0, credit: returned, class_id: classId, memo: "Deposit refund" },
        ]
      });
    }
    if (deducted > 0) {
      await autoPostJournalEntry({ companyId, date: depositForm.return_date, description: "Deposit deduction — " + lease.tenant_name + " — " + depositForm.deductions, reference: "DEPDED-" + Date.now(), property: lease.property,
        lines: [
          { account_id: "2100", account_name: "Security Deposits Held", debit: deducted, credit: 0, class_id: classId, memo: "Deduction: " + depositForm.deductions },
          { account_id: "4100", account_name: "Other Income", debit: 0, credit: deducted, class_id: classId, memo: "Deposit forfeiture: " + lease.tenant_name },
        ]
      });
    }
    // Create ledger entry and update balance for deposit return
    if (returned > 0 && lease.tenant_id) {
      await safeLedgerInsert({ company_id: companyId || "sandbox-llc",
        tenant: lease.tenant_name, property: lease.property, date: depositForm.return_date,
        description: "Security deposit returned", amount: -returned, type: "deposit_return", balance: 0,
      });
      try { await supabase.rpc("update_tenant_balance", { p_tenant_id: lease.tenant_id, p_amount_change: -returned }); } catch {}
    }
    if (deducted > 0 && lease.tenant_id) {
      await safeLedgerInsert({ company_id: companyId || "sandbox-llc",
        tenant: lease.tenant_name, property: lease.property, date: depositForm.return_date,
        description: "Deposit deduction: " + depositForm.deductions, amount: deducted, type: "deposit_deduction", balance: 0,
      });
    }
    logAudit("update", "leases", "Deposit return: $" + returned + " to " + lease.tenant_name, lease.id, userProfile?.email, userRole, companyId);
    setShowDepositModal(null); setDepositForm({ amount_returned: "", deductions: "", return_date: formatLocalDate(new Date()) });
    fetchData();
  }

  async function saveTemplate() {
    if (!templateForm.name) { alert("Template name is required."); return; }
    const { error } = await supabase.from("lease_templates").insert([{ company_id: companyId || "sandbox-llc", ...templateForm, default_deposit_months: Number(templateForm.default_deposit_months || 1), default_lease_months: Number(templateForm.default_lease_months || 12), default_escalation_pct: Number(templateForm.default_escalation_pct || 3), payment_due_day: Math.max(1, Math.min(31, Number(templateForm.payment_due_day || 1))) }]);
    if (error) { alert("Error: " + error.message); return; }
    setShowTemplateForm(false); setTemplateForm({ name: "", description: "", clauses: "", special_terms: "", default_deposit_months: "1", default_lease_months: "12", default_escalation_pct: "3", payment_due_day: "1" });
    fetchData();
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
        <h2 className="text-xl font-bold text-gray-800">Lease Management</h2>
        <div className="flex gap-2">
          <button onClick={() => setShowTemplateForm(true)} className="text-xs border border-gray-200 text-gray-600 px-3 py-2 rounded-lg hover:bg-gray-50">Manage Templates</button>
          <button onClick={() => setShowForm(true)} className="bg-indigo-600 text-white text-xs px-4 py-2 rounded-lg hover:bg-indigo-700">+ New Lease</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-5 md:grid-cols-4">
        <StatCard label="Active Leases" value={active.length} color="text-green-600" sub="current" />
        <StatCard label="Expiring (90d)" value={expiringSoon.length} color={expiringSoon.length > 0 ? "text-amber-600" : "text-gray-400"} sub="need attention" />
        <StatCard label="Total Deposits" value={"$" + totalDeposits.toLocaleString()} color="text-purple-600" sub="held" />
        <StatCard label="Avg Rent" value={"$" + (active.length > 0 ? Math.round(active.reduce((s, l) => s + safeNum(l.rent_amount), 0) / active.length) : 0)} color="text-blue-600" sub="per lease" />
      </div>

      {expiringSoon.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
          <div className="font-semibold text-amber-800 text-sm mb-2">Leases Expiring Soon</div>
          {expiringSoon.map(l => { const d = Math.ceil((parseLocalDate(l.end_date) - new Date()) / 86400000); return (
            <div key={l.id} className="flex justify-between items-center py-1 text-sm">
              <span className="text-amber-700">{l.tenant_name} — {l.property}</span>
              <div className="flex items-center gap-2"><span className="text-amber-600 font-bold">{d} days</span><button onClick={() => renewLease(l)} className="text-xs bg-amber-600 text-white px-2 py-1 rounded hover:bg-amber-700">Renew</button></div>
            </div>
          ); })}
        </div>
      )}

      <div className="flex gap-1 mb-4 border-b border-gray-100 overflow-x-auto">
        {[["active","Active"],["expiring","Expiring"],["expired","Expired"],["renewed","Renewed"],["terminated","Terminated"],["all","All"]].map(([id,label]) => (
          <button key={id} onClick={() => setActiveTab(id)} className={"px-3 py-2 text-xs font-medium border-b-2 whitespace-nowrap " + (activeTab === id ? "border-indigo-600 text-indigo-700" : "border-transparent text-gray-500")}>{label}{id === "expiring" && expiringSoon.length > 0 ? " (" + expiringSoon.length + ")" : ""}</button>
        ))}
      </div>

      {showTemplateForm && (
        <Modal title="Lease Template" onClose={() => setShowTemplateForm(false)}>
          <div className="space-y-3">
            <input placeholder="Template name *" value={templateForm.name} onChange={e => setTemplateForm({...templateForm, name: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Description" value={templateForm.description} onChange={e => setTemplateForm({...templateForm, description: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <div className="grid grid-cols-2 gap-3">
              <div><label className="text-xs text-gray-500">Lease Length (months)</label><input type="number" value={templateForm.default_lease_months} onChange={e => setTemplateForm({...templateForm, default_lease_months: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="text-xs text-gray-500">Annual Escalation %</label><input type="number" step="0.1" value={templateForm.default_escalation_pct} onChange={e => setTemplateForm({...templateForm, default_escalation_pct: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            </div>
            <textarea placeholder="Standard clauses..." value={templateForm.clauses} onChange={e => setTemplateForm({...templateForm, clauses: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={4} />
            <textarea placeholder="Special terms..." value={templateForm.special_terms} onChange={e => setTemplateForm({...templateForm, special_terms: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={3} />
            <button onClick={saveTemplate} className="bg-indigo-600 text-white text-sm px-6 py-2 rounded-lg hover:bg-indigo-700">Save Template</button>
          </div>
        </Modal>
      )}

      {showESign && <ESignatureModal lease={showESign} onClose={() => setShowESign(null)} onSigned={() => fetchData()} userProfile={userProfile} companyId={companyId} />}

      {showDepositModal && (
        <Modal title={"Return Deposit — " + showDepositModal.tenant_name} onClose={() => setShowDepositModal(null)}>
          <div className="space-y-3">
            <div className="bg-purple-50 rounded-lg p-3 text-sm"><div className="flex justify-between"><span className="text-gray-500">Original Deposit:</span><span className="font-bold">${safeNum(showDepositModal.security_deposit).toLocaleString()}</span></div></div>
            <div><label className="text-xs text-gray-500">Amount to Return ($)</label><input type="number" value={depositForm.amount_returned} onChange={e => setDepositForm({...depositForm, amount_returned: e.target.value})} placeholder={String(showDepositModal.security_deposit)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500">Deduction Reasons</label><textarea value={depositForm.deductions} onChange={e => setDepositForm({...depositForm, deductions: e.target.value})} placeholder="Cleaning, damages, unpaid rent..." className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={3} /></div>
            <div><label className="text-xs text-gray-500">Return Date</label><input type="date" value={depositForm.return_date} onChange={e => setDepositForm({...depositForm, return_date: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
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
              <div key={i} onClick={() => toggleChecklistItem(showChecklist.lease, showChecklist.type, i)} className={"flex items-center gap-3 p-2 rounded-lg cursor-pointer border " + (item.checked ? "bg-green-50 border-green-200" : "bg-white border-gray-100 hover:bg-gray-50")}>
                <span className={"w-5 h-5 rounded border flex items-center justify-center text-xs " + (item.checked ? "bg-green-500 border-green-500 text-white" : "border-gray-300")}>{item.checked ? "✓" : ""}</span>
                <span className={"text-sm " + (item.checked ? "line-through text-gray-400" : "text-gray-700")}>{item.item}</span>
              </div>
            )); })()}
          </div>
        </Modal>
      )}

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-5 mb-5">
          <h3 className="font-semibold text-gray-800 mb-4">{editingLease ? "Edit Lease" : "Create New Lease"}</h3>
          {!editingLease && templates.length > 0 && (
            <div className="mb-4"><label className="text-xs text-gray-500 mb-1 block">Apply Template</label>
              <select value={form.template_id} onChange={e => { setForm({...form, template_id: e.target.value}); applyTemplate(e.target.value); }} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
                <option value="">Select template...</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name} — {t.description}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div><label className="text-xs text-gray-500 mb-1 block">Tenant *</label>
              <select value={form.tenant_name} onChange={e => { setForm({...form, tenant_name: e.target.value}); prefillFromTenant(e.target.value); }} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
                <option value="">Select tenant...</option>
                {tenants.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
              </select>
            </div>
            <div><label className="text-xs text-gray-500 mb-1 block">Property *</label><PropertySelect value={form.property} onChange={v => setForm({...form, property: v})} companyId={companyId} /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Lease Start *</label><input type="date" value={form.start_date} onChange={e => setForm({...form, start_date: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Lease End *</label><input type="date" value={form.end_date} onChange={e => setForm({...form, end_date: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Monthly Rent ($) *</label><input type="number" value={form.rent_amount} onChange={e => setForm({...form, rent_amount: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Security Deposit ($)</label><input type="number" value={form.security_deposit} onChange={e => setForm({...form, security_deposit: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Annual Escalation %</label><input type="number" step="0.1" value={form.rent_escalation_pct} onChange={e => setForm({...form, rent_escalation_pct: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Payment Due Day</label><input type="number" min="1" max="31" value={form.payment_due_day} onChange={e => setForm({...form, payment_due_day: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Lease Type</label>
              <select value={form.lease_type} onChange={e => setForm({...form, lease_type: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"><option value="fixed">Fixed Term</option><option value="month_to_month">Month-to-Month</option><option value="renewal">Renewal</option></select></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Renewal Notice (days)</label><input type="number" value={form.renewal_notice_days} onChange={e => setForm({...form, renewal_notice_days: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
          </div>
          {/* Late Fee Settings */}
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
            <div className="text-sm font-semibold text-amber-800 mb-2">⚠️ Late Fee Settings</div>
            <div className="grid grid-cols-3 gap-3">
              <div><label className="text-xs text-gray-500 mb-1 block">Grace Period (days)</label><input type="number" min="0" max="30" value={form.late_fee_grace_days} onChange={e => setForm({...form, late_fee_grace_days: e.target.value})} className="w-full border border-amber-200 rounded-lg px-3 py-2 text-sm bg-white" /></div>
              <div><label className="text-xs text-gray-500 mb-1 block">Fee Type</label><select value={form.late_fee_type} onChange={e => setForm({...form, late_fee_type: e.target.value})} className="w-full border border-amber-200 rounded-lg px-3 py-2 text-sm bg-white"><option value="flat">Flat ($)</option><option value="percent">Percent (%)</option></select></div>
              <div><label className="text-xs text-gray-500 mb-1 block">{form.late_fee_type === "flat" ? "Fee Amount ($)" : "Fee Percentage (%)"}</label><input type="number" step="0.01" value={form.late_fee_amount} onChange={e => setForm({...form, late_fee_amount: e.target.value})} className="w-full border border-amber-200 rounded-lg px-3 py-2 text-sm bg-white" /></div>
            </div>
            <p className="text-xs text-amber-600 mt-2">Late fees auto-apply to tenant ledger after grace period. Admin can waive from ledger.</p>
          </div>
          <div className="flex items-center gap-2 mb-4"><input type="checkbox" checked={form.auto_renew} onChange={e => setForm({...form, auto_renew: e.target.checked})} className="rounded" /><label className="text-sm text-gray-600">Auto-renew at end of term</label></div>
          <div className="mb-3"><label className="text-xs text-gray-500 mb-1 block">Lease Clauses</label><textarea value={form.clauses} onChange={e => setForm({...form, clauses: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={3} placeholder="Standard clauses..." /></div>
          <div className="mb-4"><label className="text-xs text-gray-500 mb-1 block">Special Terms</label><textarea value={form.special_terms} onChange={e => setForm({...form, special_terms: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={2} placeholder="Pet deposit, parking, storage..." /></div>
          <div className="flex gap-2">
            <button onClick={saveLease} className="bg-indigo-600 text-white text-sm px-6 py-2 rounded-lg hover:bg-indigo-700">{editingLease ? "Update Lease" : "Create Lease"}</button>
            <button onClick={resetForm} className="text-sm text-gray-500 px-4 py-2 hover:text-gray-700">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {filteredLeases.map(l => {
          const daysLeft = Math.ceil((parseLocalDate(l.end_date) - new Date()) / 86400000);
          const isExpired = daysLeft <= 0 && l.status === "active";
          const sc = { active: "bg-green-100 text-green-700", expired: "bg-red-100 text-red-700", renewed: "bg-blue-100 text-blue-700", terminated: "bg-gray-100 text-gray-600", draft: "bg-amber-100 text-amber-700" };
          const dc = { held: "bg-purple-100 text-purple-700", partial_return: "bg-amber-100 text-amber-700", returned: "bg-green-100 text-green-700", forfeited: "bg-red-100 text-red-700" };
          return (
            <div key={l.id} className={"bg-white rounded-xl border shadow-sm p-4 " + (isExpired ? "border-red-200" : "border-gray-100")}>
              <div className="flex justify-between items-start mb-3">
                <div><div className="text-sm font-bold text-gray-800">{l.tenant_name}</div><div className="text-xs text-gray-400">{l.property}</div></div>
                <div className="flex items-center gap-2">
                  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (sc[isExpired ? "expired" : l.status] || "bg-gray-100")}>{isExpired ? "EXPIRED" : l.status}</span>
                  {l.lease_type === "renewal" && <span className="px-2 py-0.5 rounded-full text-xs bg-blue-50 text-blue-600">Renewal</span>}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-3 md:grid-cols-4">
                <div><span className="text-gray-400">Term:</span> <span className="font-medium">{l.start_date} to {l.end_date}</span></div>
                <div><span className="text-gray-400">Rent:</span> <span className="font-bold text-gray-800">${safeNum(l.rent_amount).toLocaleString()}/mo</span></div>
                <div><span className="text-gray-400">Deposit:</span> <span className="font-medium">${safeNum(l.security_deposit).toLocaleString()}</span>{l.security_deposit > 0 && <span className={"ml-1 px-1 py-0.5 rounded text-xs " + (dc[l.deposit_status] || "")}>{l.deposit_status}</span>}</div>
                <div><span className="text-gray-400">Escalation:</span> <span className="font-medium">{l.rent_escalation_pct || 0}%/yr</span></div>
                {l.status === "active" && <div><span className="text-gray-400">Days Left:</span> <span className={"font-bold " + (daysLeft <= 30 ? "text-red-600" : daysLeft <= 90 ? "text-amber-600" : "text-green-600")}>{daysLeft}</span></div>}
                <div><span className="text-gray-400">Due Day:</span> <span className="font-medium">{l.payment_due_day || 1}th</span></div>
                <div><span className="text-gray-400">Type:</span> <span className="font-medium capitalize">{(l.lease_type || "fixed").replace("_"," ")}</span></div>
                <div><span className="text-gray-400">Auto-Renew:</span> <span className="font-medium">{l.auto_renew ? "Yes" : "No"}</span></div>
              </div>
              <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-50">
                <button onClick={() => startEdit(l)} className="text-xs text-indigo-600 border border-indigo-200 px-3 py-1 rounded-lg hover:bg-indigo-50">Edit</button>
                <button onClick={() => setShowESign(l)} className={"text-xs border px-3 py-1 rounded-lg " + (l.signature_status === "fully_signed" ? "text-green-600 border-green-200 bg-green-50" : "text-purple-600 border-purple-200 hover:bg-purple-50")}>{l.signature_status === "fully_signed" ? "✓ Signed" : "\u270d\ufe0f E-Sign"}</button>
                {l.status === "active" && <button onClick={() => renewLease(l)} className="text-xs text-green-600 border border-green-200 px-3 py-1 rounded-lg hover:bg-green-50">Renew</button>}
                {l.status === "active" && <button onClick={() => { setShowRentIncrease(l); setRentIncreaseForm({ new_amount: String(l.rent_amount), effective_date: formatLocalDate(new Date()), reason: "" }); }} className="text-xs text-blue-600 border border-blue-200 px-3 py-1 rounded-lg hover:bg-blue-50">📈 Rent Increase</button>}
                {l.status === "active" && <button onClick={() => terminateLease(l)} className="text-xs text-red-600 border border-red-200 px-3 py-1 rounded-lg hover:bg-red-50">Terminate</button>}
                <button onClick={() => setShowChecklist({ lease: l, type: "in" })} className={"text-xs border px-3 py-1 rounded-lg " + (l.move_in_completed ? "text-green-600 border-green-200 bg-green-50" : "text-gray-500 border-gray-200 hover:bg-gray-50")}>Move-In {l.move_in_completed ? "✓" : ""}</button>
                <button onClick={() => setShowChecklist({ lease: l, type: "out" })} className={"text-xs border px-3 py-1 rounded-lg " + (l.move_out_completed ? "text-green-600 border-green-200 bg-green-50" : "text-gray-500 border-gray-200 hover:bg-gray-50")}>Move-Out {l.move_out_completed ? "✓" : ""}</button>
                {safeNum(l.security_deposit) > 0 && l.deposit_status === "held" && (l.status === "terminated" || l.status === "expired" || isExpired) && (
                  <button onClick={() => { setShowDepositModal(l); setDepositForm({ amount_returned: String(l.security_deposit), deductions: "", return_date: formatLocalDate(new Date()) }); }} className="text-xs text-purple-600 border border-purple-200 px-3 py-1 rounded-lg hover:bg-purple-50">Return Deposit</button>
                )}
              </div>
            </div>
          );
        })}
        {filteredLeases.length === 0 && <div className="text-center py-10 text-gray-400">No leases found</div>}
      </div>

      {/* Rent Increase Modal */}
      {showRentIncrease && (
        <Modal title={`Rent Increase — ${showRentIncrease.tenant_name}`} onClose={() => setShowRentIncrease(null)}>
          <div className="space-y-3">
            <div className="bg-gray-50 rounded-xl p-3 text-sm">
              <div className="flex justify-between"><span className="text-gray-500">Current Rent:</span><span className="font-bold">${showRentIncrease.rent_amount}/mo</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Property:</span><span>{showRentIncrease.property}</span></div>
            </div>
            <div><label className="text-xs text-gray-500 mb-1 block">New Monthly Rent ($) *</label><input type="number" value={rentIncreaseForm.new_amount} onChange={e => setRentIncreaseForm({...rentIncreaseForm, new_amount: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Effective Date *</label><input type="date" value={rentIncreaseForm.effective_date} onChange={e => setRentIncreaseForm({...rentIncreaseForm, effective_date: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Reason</label><input value={rentIncreaseForm.reason} onChange={e => setRentIncreaseForm({...rentIncreaseForm, reason: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="Market adjustment, annual increase..." /></div>
            {rentIncreaseForm.new_amount && Number(rentIncreaseForm.new_amount) !== showRentIncrease.rent_amount && (
              <div className={`text-sm font-semibold rounded-lg p-2 text-center ${Number(rentIncreaseForm.new_amount) > showRentIncrease.rent_amount ? "bg-red-50 text-red-600" : "bg-green-50 text-green-600"}`}>
                {Number(rentIncreaseForm.new_amount) > showRentIncrease.rent_amount ? "+" : ""}{Math.round((Number(rentIncreaseForm.new_amount) - showRentIncrease.rent_amount) / showRentIncrease.rent_amount * 100)}% ({Number(rentIncreaseForm.new_amount) > showRentIncrease.rent_amount ? "+" : ""}${Number(rentIncreaseForm.new_amount) - showRentIncrease.rent_amount}/mo)
              </div>
            )}
            <button onClick={async () => {
              if (!rentIncreaseForm.new_amount || !rentIncreaseForm.effective_date) { alert("Amount and date required."); return; }
              const newAmt = Number(rentIncreaseForm.new_amount);
              await supabase.from("leases").update({ rent_amount: newAmt, rent_increase_history: JSON.stringify([...(JSON.parse(showRentIncrease.rent_increase_history || "[]")), { from: showRentIncrease.rent_amount, to: newAmt, date: rentIncreaseForm.effective_date, reason: rentIncreaseForm.reason }]) }).eq("company_id", companyId || "sandbox-llc").eq("id", showRentIncrease.id);
              if (showRentIncrease.tenant_id) await supabase.from("tenants").update({ rent: newAmt }).eq("company_id", companyId || "sandbox-llc").eq("id", showRentIncrease.tenant_id);
              addNotification("📈", `Rent increased to $${newAmt}/mo for ${showRentIncrease.tenant_name}`);
              logAudit("update", "leases", `Rent increase: $${showRentIncrease.rent_amount} → $${newAmt} for ${showRentIncrease.tenant_name}`, showRentIncrease.id, userProfile?.email, userRole, companyId);
              setShowRentIncrease(null);
              fetchData();
            }} className="w-full bg-indigo-600 text-white text-sm py-2.5 rounded-lg hover:bg-indigo-700">Apply Rent Increase</button>
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

  useEffect(() => { fetchData(); }, []);

  async function fetchData() {
    setLoading(true);
    const [v, inv, wo] = await Promise.all([
      supabase.from("vendors").select("*").eq("company_id", companyId || "sandbox-llc").order("name"),
      supabase.from("vendor_invoices").select("*").eq("company_id", companyId || "sandbox-llc").order("created_at", { ascending: false }),
      supabase.from("work_orders").select("*").eq("company_id", companyId || "sandbox-llc").order("created_at", { ascending: false }).limit(100),
    ]);
    setVendors(v.data || []);
    setInvoices(inv.data || []);
    setWorkOrders(wo.data || []);
    setLoading(false);
  }

  async function saveVendor() {
    if (!form.name) { alert("Vendor name is required."); return; }
    const payload = {
      ...form,
      hourly_rate: Number(form.hourly_rate || 0),
      flat_rate: Number(form.flat_rate || 0),
      insurance_expiry: form.insurance_expiry || null,
    };
    let error;
    if (editingVendor) {
      ({ error } = await supabase.from("vendors").update({ name: payload.name, company: payload.company, email: payload.email, phone: payload.phone, address: payload.address, specialty: payload.specialty, license_number: payload.license_number, insurance_expiry: payload.insurance_expiry, hourly_rate: payload.hourly_rate, flat_rate: payload.flat_rate, notes: payload.notes, status: payload.status }).eq("id", editingVendor.id).eq("company_id", companyId || "sandbox-llc"));
    } else {
      ({ error } = await supabase.from("vendors").insert([{ ...payload, company_id: companyId || "sandbox-llc" }]));
    }
    if (error) { alert("Error: " + error.message); return; }
    logAudit(editingVendor ? "update" : "create", "vendors", (editingVendor ? "Updated" : "Added") + " vendor: " + form.name, editingVendor?.id || "", userProfile?.email, userRole, companyId);
    resetVendorForm();
    fetchData();
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
    if (!window.confirm("Delete vendor " + name + "?")) return;
    await supabase.from("vendors").delete().eq("id", id).eq("company_id", companyId || "sandbox-llc");
    logAudit("delete", "vendors", "Deleted vendor: " + name, id, userProfile?.email, userRole, companyId);
    fetchData();
  }

  async function saveInvoice() {
    if (!invoiceForm.vendor_id) { alert("Please select a vendor."); return; }
    if (!invoiceForm.amount || isNaN(Number(invoiceForm.amount))) { alert("Please enter a valid amount."); return; }
    const { error } = await supabase.from("vendor_invoices").insert([{ company_id: companyId || "sandbox-llc",
      ...invoiceForm,
      amount: Number(invoiceForm.amount),
      due_date: invoiceForm.due_date || null,
    }]);
    if (error) { alert("Error: " + error.message); return; }
    logAudit("create", "vendor_invoices", "Invoice: $" + invoiceForm.amount + " from " + invoiceForm.vendor_name, "", userProfile?.email, userRole, companyId);
    setShowInvoiceForm(false);
    setInvoiceForm({ vendor_id: "", vendor_name: "", work_order_id: "", property: "", description: "", amount: "", invoice_number: "", invoice_date: formatLocalDate(new Date()), due_date: "", payment_method: "", notes: "" });
    fetchData();
  }

  async function payInvoice(inv) {
    if (!window.confirm("Mark invoice #" + (inv.invoice_number || inv.id.slice(0,8)) + " as paid ($" + inv.amount + ")?")) return;
    const today = formatLocalDate(new Date());
    await supabase.from("vendor_invoices").update({ status: "paid", paid_date: today }).eq("id", inv.id);
    // Update vendor total_paid
    const vendor = vendors.find(v => String(v.id) === String(inv.vendor_id));
    if (vendor) {
      // Atomic increment (fetch fresh, then update — still not perfect but reads fresh data)
      const { data: freshVendor } = await supabase.from("vendors").select("total_paid, total_jobs").eq("id", vendor.id).maybeSingle();
      if (freshVendor) {
        await supabase.from("vendors").update({
          total_paid: safeNum(freshVendor.total_paid) + safeNum(inv.amount),
          total_jobs: (freshVendor.total_jobs || 0) + 1,
        }).eq("id", vendor.id);
      }
    }
    // Post to accounting
    const classId = await getPropertyClassId(inv.property, companyId);
    await autoPostJournalEntry({
      companyId,
      date: today,
      description: "Vendor payment — " + inv.vendor_name + " — " + (inv.description || inv.invoice_number),
      reference: "VINV-" + Date.now(),
      property: inv.property || "",
      lines: [
        { account_id: "5300", account_name: "Repairs & Maintenance", debit: safeNum(inv.amount), credit: 0, class_id: classId, memo: inv.vendor_name + ": " + inv.description },
        { account_id: "1000", account_name: "Checking Account", debit: 0, credit: safeNum(inv.amount), class_id: classId, memo: "Payment to " + inv.vendor_name },
      ]
    });
    logAudit("update", "vendor_invoices", "Paid invoice: $" + inv.amount + " to " + inv.vendor_name, inv.id, userProfile?.email, userRole, companyId);
    fetchData();
  }

  async function rateVendor(vendor, rating) {
    await supabase.from("vendors").update({ rating }).eq("company_id", companyId || "sandbox-llc").eq("id", vendor.id);
    fetchData();
  }

  if (loading) return <Spinner />;

  const activeVendors = vendors.filter(v => v.status === "active" || v.status === "preferred");
  const pendingInvoices = invoices.filter(i => i.status === "pending" || i.status === "approved");
  const totalOwed = pendingInvoices.reduce((s, i) => s + safeNum(i.amount), 0);
  const totalPaidAll = invoices.filter(i => i.status === "paid").reduce((s, i) => s + safeNum(i.amount), 0);
  const insuranceExpiring = vendors.filter(v => {
    if (!v.insurance_expiry) return false;
    const days = Math.ceil((new Date(v.insurance_expiry) - new Date()) / 86400000);
    return days <= 30 && days > 0;
  });

  const filteredVendors = vendors.filter(v =>
    (filterSpecialty === "all" || v.specialty === filterSpecialty) &&
    (!searchTerm || v.name.toLowerCase().includes(searchTerm.toLowerCase()) || (v.company || "").toLowerCase().includes(searchTerm.toLowerCase()) || (v.specialty || "").toLowerCase().includes(searchTerm.toLowerCase()))
  );

  return (
    <div>
      <div className="flex justify-between items-center mb-5">
        <h2 className="text-xl font-bold text-gray-800">Vendor Management</h2>
        <div className="flex gap-2">
          <button onClick={() => setShowInvoiceForm(true)} className="text-xs border border-gray-200 text-gray-600 px-3 py-2 rounded-lg hover:bg-gray-50">+ Invoice</button>
          <button onClick={() => setShowForm(true)} className="bg-indigo-600 text-white text-xs px-4 py-2 rounded-lg hover:bg-indigo-700">+ New Vendor</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-5 md:grid-cols-4">
        <StatCard label="Active Vendors" value={activeVendors.length} color="text-green-600" sub="available" />
        <StatCard label="Pending Invoices" value={pendingInvoices.length} color={pendingInvoices.length > 0 ? "text-amber-600" : "text-gray-400"} sub={"$" + totalOwed.toLocaleString() + " owed"} />
        <StatCard label="Total Paid (YTD)" value={"$" + totalPaidAll.toLocaleString()} color="text-blue-600" sub="all vendors" />
        <StatCard label="Insurance Alerts" value={insuranceExpiring.length} color={insuranceExpiring.length > 0 ? "text-red-500" : "text-gray-400"} sub="expiring < 30d" />
      </div>

      {insuranceExpiring.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 mb-4">
          <div className="font-semibold text-red-800 text-sm mb-1">Insurance Expiring Soon</div>
          {insuranceExpiring.map(v => (
            <div key={v.id} className="text-xs text-red-700">{v.name} ({v.specialty}) — expires {v.insurance_expiry}</div>
          ))}
        </div>
      )}

      <div className="flex gap-1 mb-4 border-b border-gray-100">
        {[["vendors","Vendors"],["invoices","Invoices"]].map(([id,label]) => (
          <button key={id} onClick={() => setActiveTab(id)} className={"px-4 py-2 text-sm font-medium border-b-2 " + (activeTab === id ? "border-indigo-600 text-indigo-700" : "border-transparent text-gray-500")}>{label}</button>
        ))}
      </div>

      {/* New Vendor Form */}
      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-5 mb-5">
          <h3 className="font-semibold text-gray-800 mb-4">{editingVendor ? "Edit Vendor" : "Add New Vendor"}</h3>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div><label className="text-xs text-gray-500 mb-1 block">Name *</label><input value={form.name} onChange={e => setForm({...form, name: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="John Smith" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Company</label><input value={form.company} onChange={e => setForm({...form, company: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="ABC Plumbing LLC" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Email</label><input type="email" value={form.email} onChange={e => setForm({...form, email: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Phone</label><input value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div className="col-span-2"><label className="text-xs text-gray-500 mb-1 block">Address</label><input value={form.address} onChange={e => setForm({...form, address: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Specialty</label>
              <select value={form.specialty} onChange={e => setForm({...form, specialty: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
                {specialties.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div><label className="text-xs text-gray-500 mb-1 block">Status</label>
              <select value={form.status} onChange={e => setForm({...form, status: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
                <option value="active">Active</option><option value="preferred">Preferred</option><option value="inactive">Inactive</option><option value="blocked">Blocked</option>
              </select>
            </div>
            <div><label className="text-xs text-gray-500 mb-1 block">License #</label><input value={form.license_number} onChange={e => setForm({...form, license_number: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Insurance Expiry</label><input type="date" value={form.insurance_expiry} onChange={e => setForm({...form, insurance_expiry: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Hourly Rate ($)</label><input type="number" value={form.hourly_rate} onChange={e => setForm({...form, hourly_rate: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Flat Rate ($)</label><input type="number" value={form.flat_rate} onChange={e => setForm({...form, flat_rate: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
          </div>
          <div className="mb-4"><label className="text-xs text-gray-500 mb-1 block">Notes</label><textarea value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={2} /></div>
          <div className="flex gap-2">
            <button onClick={saveVendor} className="bg-indigo-600 text-white text-sm px-6 py-2 rounded-lg hover:bg-indigo-700">{editingVendor ? "Update" : "Add Vendor"}</button>
            <button onClick={resetVendorForm} className="text-sm text-gray-500 px-4 py-2">Cancel</button>
          </div>
        </div>
      )}

      {/* Invoice Form */}
      {showInvoiceForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-5 mb-5">
          <h3 className="font-semibold text-gray-800 mb-4">New Vendor Invoice</h3>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div><label className="text-xs text-gray-500 mb-1 block">Vendor *</label>
              <select value={invoiceForm.vendor_id} onChange={e => { const v = vendors.find(v => String(v.id) === String(e.target.value)); setInvoiceForm({...invoiceForm, vendor_id: e.target.value, vendor_name: v?.name || ""}); }} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
                <option value="">Select vendor...</option>
                {vendors.filter(v => v.status !== "blocked").map(v => <option key={v.id} value={v.id}>{v.name} ({v.specialty})</option>)}
              </select>
            </div>
            <div><label className="text-xs text-gray-500 mb-1 block">Property</label><PropertySelect value={invoiceForm.property} onChange={v => setInvoiceForm({...invoiceForm, property: v})} companyId={companyId} /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Amount ($) *</label><input type="number" value={invoiceForm.amount} onChange={e => setInvoiceForm({...invoiceForm, amount: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Invoice #</label><input value={invoiceForm.invoice_number} onChange={e => setInvoiceForm({...invoiceForm, invoice_number: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Invoice Date</label><input type="date" value={invoiceForm.invoice_date} onChange={e => setInvoiceForm({...invoiceForm, invoice_date: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Due Date</label><input type="date" value={invoiceForm.due_date} onChange={e => setInvoiceForm({...invoiceForm, due_date: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div className="col-span-2"><label className="text-xs text-gray-500 mb-1 block">Description</label><input value={invoiceForm.description} onChange={e => setInvoiceForm({...invoiceForm, description: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="Plumbing repair at 123 Main St" /></div>
          </div>
          <div className="flex gap-2">
            <button onClick={saveInvoice} className="bg-indigo-600 text-white text-sm px-6 py-2 rounded-lg hover:bg-indigo-700">Save Invoice</button>
            <button onClick={() => setShowInvoiceForm(false)} className="text-sm text-gray-500 px-4 py-2">Cancel</button>
          </div>
        </div>
      )}

      {/* VENDORS TAB */}
      {activeTab === "vendors" && (
        <div>
          <div className="flex gap-2 mb-4">
            <input placeholder="Search vendors..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <select value={filterSpecialty} onChange={e => setFilterSpecialty(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              <option value="all">All Specialties</option>
              {specialties.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="space-y-3">
            {filteredVendors.map(v => {
              const insExpired = v.insurance_expiry && new Date(v.insurance_expiry) < new Date();
              const insExpiring = v.insurance_expiry && !insExpired && Math.ceil((new Date(v.insurance_expiry) - new Date()) / 86400000) <= 30;
              const sc = { active: "bg-green-100 text-green-700", preferred: "bg-indigo-100 text-indigo-700", inactive: "bg-gray-100 text-gray-500", blocked: "bg-red-100 text-red-700" };
              return (
                <div key={v.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <div className="text-sm font-bold text-gray-800">{v.name}{v.company ? " — " + v.company : ""}</div>
                      <div className="text-xs text-gray-400">{v.specialty}{v.license_number ? " · Lic: " + v.license_number : ""}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (sc[v.status] || "bg-gray-100")}>{v.status}</span>
                      {v.rating > 0 && <span className="text-xs text-amber-500">{"\u2605".repeat(v.rating)}{"\u2606".repeat(5 - v.rating)}</span>}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-2 md:grid-cols-4">
                    {v.phone && <div><span className="text-gray-400">Phone:</span> <span className="font-medium">{v.phone}</span></div>}
                    {v.email && <div><span className="text-gray-400">Email:</span> <span className="font-medium">{v.email}</span></div>}
                    {v.hourly_rate > 0 && <div><span className="text-gray-400">Rate:</span> <span className="font-medium">${v.hourly_rate}/hr</span></div>}
                    {v.flat_rate > 0 && <div><span className="text-gray-400">Flat:</span> <span className="font-medium">${v.flat_rate}</span></div>}
                    <div><span className="text-gray-400">Jobs:</span> <span className="font-medium">{v.total_jobs || 0}</span></div>
                    <div><span className="text-gray-400">Total Paid:</span> <span className="font-medium">${safeNum(v.total_paid).toLocaleString()}</span></div>
                    {v.insurance_expiry && <div><span className="text-gray-400">Insurance:</span> <span className={"font-medium " + (insExpired ? "text-red-600" : insExpiring ? "text-amber-600" : "text-green-600")}>{v.insurance_expiry}{insExpired ? " (EXPIRED)" : ""}</span></div>}
                  </div>
                  {v.notes && <div className="text-xs text-gray-500 mb-2">{v.notes}</div>}
                  <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-50">
                    <button onClick={() => startEditVendor(v)} className="text-xs text-indigo-600 border border-indigo-200 px-3 py-1 rounded-lg hover:bg-indigo-50">Edit</button>
                    <button onClick={() => deleteVendor(v.id, v.name)} className="text-xs text-red-500 border border-red-200 px-3 py-1 rounded-lg hover:bg-red-50">Delete</button>
                    <div className="flex items-center gap-0.5 ml-2">
                      {[1,2,3,4,5].map(star => (
                        <button key={star} onClick={() => rateVendor(v, star)} className={"text-sm " + (star <= (v.rating || 0) ? "text-amber-400" : "text-gray-300")}>{star <= (v.rating || 0) ? "\u2605" : "\u2606"}</button>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
            {filteredVendors.length === 0 && <div className="text-center py-10 text-gray-400">No vendors found</div>}
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
              <div key={inv.id} className={"bg-white rounded-xl border shadow-sm p-4 " + (isOverdue ? "border-red-200" : "border-gray-100")}>
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <div className="text-sm font-bold text-gray-800">{inv.vendor_name}</div>
                    <div className="text-xs text-gray-400">{inv.description || "Invoice"}{inv.invoice_number ? " #" + inv.invoice_number : ""}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-gray-800">${safeNum(inv.amount).toLocaleString()}</div>
                    <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (sc[inv.status] || "bg-gray-100")}>{isOverdue ? "OVERDUE" : inv.status}</span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-4 text-xs md:grid-cols-4">
                  {inv.property && <div><span className="text-gray-400">Property:</span> <span className="font-medium">{inv.property}</span></div>}
                  <div><span className="text-gray-400">Date:</span> <span className="font-medium">{inv.invoice_date}</span></div>
                  {inv.due_date && <div><span className="text-gray-400">Due:</span> <span className={"font-medium " + (isOverdue ? "text-red-600" : "")}>{inv.due_date}</span></div>}
                  {inv.paid_date && <div><span className="text-gray-400">Paid:</span> <span className="font-medium text-green-600">{inv.paid_date}</span></div>}
                </div>
                {(inv.status === "pending" || inv.status === "approved") && (
                  <div className="flex gap-2 pt-2 mt-2 border-t border-gray-50">
                    <button onClick={() => payInvoice(inv)} className="text-xs text-green-600 border border-green-200 px-3 py-1 rounded-lg hover:bg-green-50">Mark Paid</button>
                  </div>
                )}
              </div>
            );
          })}
          {invoices.length === 0 && <div className="text-center py-10 text-gray-400">No invoices yet</div>}
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

  useEffect(() => { fetchData(); }, []);

  async function fetchData() {
    setLoading(true);
    const [o, p, s, d, pay, vi, u] = await Promise.all([
      supabase.from("owners").select("*").eq("company_id", companyId || "sandbox-llc").order("name"),
      supabase.from("properties").select("*").eq("company_id", companyId || "sandbox-llc"),
      supabase.from("owner_statements").select("*").eq("company_id", companyId || "sandbox-llc").order("created_at", { ascending: false }),
      supabase.from("owner_distributions").select("*").eq("company_id", companyId || "sandbox-llc").order("date", { ascending: false }),
      supabase.from("payments").select("*").eq("company_id", companyId || "sandbox-llc").eq("status", "paid"),
      supabase.from("vendor_invoices").select("*").eq("company_id", companyId || "sandbox-llc").eq("status", "paid"),
      supabase.from("utilities").select("*").eq("company_id", companyId || "sandbox-llc").eq("status", "paid"),
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
    if (!form.name) { alert("Owner name is required."); return; }
    const payload = { ...form, management_fee_pct: Number(form.management_fee_pct || 10) };
    let error;
    if (editingOwner) {
      ({ error } = await supabase.from("owners").update({ name: payload.name, email: payload.email, phone: payload.phone, address: payload.address, company: payload.company, tax_id: payload.tax_id, payment_method: payload.payment_method, bank_name: payload.bank_name, bank_routing: payload.bank_routing, bank_account: payload.bank_account, management_fee_pct: payload.management_fee_pct, notes: payload.notes, status: payload.status }).eq("id", editingOwner.id).eq("company_id", companyId || "sandbox-llc"));
    } else {
      ({ error } = await supabase.from("owners").insert([{ ...payload, company_id: companyId || "sandbox-llc" }]));
    }
    if (error) { alert("Error: " + error.message); return; }
    logAudit(editingOwner ? "update" : "create", "owners", (editingOwner ? "Updated" : "Added") + " owner: " + form.name, editingOwner?.id || "", userProfile?.email, userRole, companyId);
    resetForm(); fetchData();
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
    if (!owner.email) { alert("This owner has no email address. Please add one first."); return; }
    if (!window.confirm("Send portal invite to " + owner.name + " (" + owner.email + ")?\n\nThis will:\n1. Create their authentication account\n2. Send a magic link to their email\n3. They can log in and access the Owner Portal")) return;
    try {
      const { error: authErr } = await supabase.auth.signInWithOtp({
        email: owner.email,
        options: { data: { name: owner.name, role: "owner" } }
      });
      if (authErr) console.warn("Auth invite failed:", authErr.message);
      // Insert only if no existing row — don't overwrite other company's data
      await supabase.from("app_users").upsert([{
        email: (owner.email || "").toLowerCase(),
        name: owner.name,
        role: "owner",
        company_id: companyId || "sandbox-llc",
      }], { onConflict: "email", ignoreDuplicates: true });
      // Create company_members entry so owner is auto-routed to this company
      await supabase.from("company_members").upsert([{
        company_id: companyId || "sandbox-llc",
        user_email: (owner.email || "").toLowerCase(),
        user_name: owner.name,
        role: "owner",
        status: "active",
        invited_by: userProfile?.email || "admin",
      }], { onConflict: "company_id,user_email" });
      addNotification("✉️", "Portal invite sent to " + owner.name);
      logAudit("create", "owners", "Invited owner to portal: " + owner.email, owner.id, userProfile?.email, userRole, companyId);
      alert("Owner portal invite sent to " + owner.email + "!\n\nThey can log in and see their properties, statements, and distributions.");
    } catch (e) {
      alert("Error inviting owner: " + e.message);
    }
  }

  async function assignPropertyToOwner(propertyId, ownerId) {
    const owner = owners.find(o => String(o.id) === String(ownerId));
    await supabase.from("properties").update({ owner_id: ownerId || null, owner_name: owner?.name || "" }).eq("company_id", companyId || "sandbox-llc").eq("id", propertyId);
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
    const { data: freshPayments } = await supabase.from("payments").select("*").eq("company_id", companyId || "sandbox-llc").eq("status", "paid").gte("date", startDate).lte("date", endDate);
    const monthPayments = (freshPayments || []).filter(p => ownerProps.includes(p.property));
    const totalIncome = monthPayments.reduce((s, p) => s + safeNum(p.amount), 0);

    // Gather expenses (fresh from DB)
    const { data: freshVendor } = await supabase.from("vendor_invoices").select("*").eq("company_id", companyId || "sandbox-llc").eq("status", "paid");
    const monthVendor = (freshVendor || []).filter(v => ownerProps.includes(v.property) && v.paid_date && v.paid_date >= startDate && v.paid_date <= endDate);
    const { data: freshUtils } = await supabase.from("utilities").select("*").eq("company_id", companyId || "sandbox-llc").eq("status", "paid");
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

    const { error } = await supabase.from("owner_statements").insert([{ company_id: companyId || "sandbox-llc",
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
    await supabase.from("owner_statements").update({ status: "sent", sent_date: formatLocalDate(new Date()) }).eq("id", stmt.id);
    fetchData();
  }

  async function distributeToOwner(stmt) {
    if (stmt.net_to_owner <= 0) { alert("Net amount is $0 or negative. Nothing to distribute."); return; }
    if (!window.confirm("Distribute $" + stmt.net_to_owner.toLocaleString() + " to " + stmt.owner_name + "?")) return;
    const today = formatLocalDate(new Date());
    const owner = owners.find(o => String(o.id) === String(stmt.owner_id));
    // Record distribution
    await supabase.from("owner_distributions").insert([{ company_id: companyId || "sandbox-llc",
      owner_id: stmt.owner_id, statement_id: stmt.id,
      amount: stmt.net_to_owner, method: owner?.payment_method || "check",
      reference: "DIST-" + stmt.period, date: today,
    }]);
    await supabase.from("owner_statements").update({ status: "paid", paid_date: today }).eq("id", stmt.id);
    // Post to accounting
    await autoPostJournalEntry({
      companyId,
      date: today,
      description: "Owner distribution — " + stmt.owner_name + " — " + stmt.period,
      reference: "ODIST-" + Date.now(),
      property: stmt.property || "",
      lines: [
        { account_id: "2200", account_name: "Owner Distributions Payable", debit: safeNum(stmt.net_to_owner), credit: 0, memo: stmt.owner_name + " " + stmt.period },
        { account_id: "1000", account_name: "Checking Account", debit: 0, credit: safeNum(stmt.net_to_owner), memo: "Distribution to " + stmt.owner_name },
      ]
    });
    // Post management fee as revenue
    if (stmt.management_fee > 0) {
      await autoPostJournalEntry({
        companyId,
        date: today,
        description: "Management fee — " + stmt.owner_name + " — " + stmt.period,
        reference: "MGMT-" + Date.now(),
        property: stmt.property || "",
        lines: [
          { account_id: "2200", account_name: "Owner Distributions Payable", debit: safeNum(stmt.management_fee), credit: 0, memo: "Mgmt fee " + stmt.period },
          { account_id: "4200", account_name: "Management Fee Income", debit: 0, credit: safeNum(stmt.management_fee), memo: stmt.owner_name },
        ]
      });
    }
    logAudit("create", "owner_distributions", "Distributed $" + stmt.net_to_owner + " to " + stmt.owner_name, stmt.id, userProfile?.email, userRole, companyId);
    fetchData();
  }

  if (loading) return <Spinner />;

  const activeOwners = owners.filter(o => o.status === "active");
  const totalDistributed = distributions.reduce((s, d) => s + safeNum(d.amount), 0);
  const pendingStatements = statements.filter(s => s.status === "draft" || s.status === "sent");
  const pendingAmount = pendingStatements.reduce((s, st) => s + safeNum(st.net_to_owner), 0);

  return (
    <div>
      <div className="flex justify-between items-center mb-5">
        <h2 className="text-xl font-bold text-gray-800">Owner Management</h2>
        <div className="flex gap-2">
          <button onClick={() => setShowGenerate(true)} className="text-xs border border-gray-200 text-gray-600 px-3 py-2 rounded-lg hover:bg-gray-50">Generate Statement</button>
          <button onClick={() => setShowForm(true)} className="bg-indigo-600 text-white text-xs px-4 py-2 rounded-lg hover:bg-indigo-700">+ New Owner</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-5 md:grid-cols-4">
        <StatCard label="Active Owners" value={activeOwners.length} color="text-green-600" sub={properties.filter(p => p.owner_id).length + " properties assigned"} />
        <StatCard label="Pending Statements" value={pendingStatements.length} color={pendingStatements.length > 0 ? "text-amber-600" : "text-gray-400"} sub={"$" + pendingAmount.toLocaleString() + " owed"} />
        <StatCard label="Total Distributed" value={"$" + totalDistributed.toLocaleString()} color="text-blue-600" sub="all time" />
        <StatCard label="Unassigned Props" value={properties.filter(p => !p.owner_id).length} color={properties.filter(p => !p.owner_id).length > 0 ? "text-orange-500" : "text-gray-400"} sub="no owner" />
      </div>

      <div className="flex gap-1 mb-4 border-b border-gray-100">
        {[["owners","Owners"],["properties","Properties"],["statements","Statements"],["distributions","Distributions"]].map(([id,label]) => (
          <button key={id} onClick={() => setActiveTab(id)} className={"px-3 py-2 text-sm font-medium border-b-2 " + (activeTab === id ? "border-indigo-600 text-indigo-700" : "border-transparent text-gray-500")}>{label}</button>
        ))}
      </div>

      {/* Generate Statement Modal */}
      {showGenerate && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-5 mb-5">
          <h3 className="font-semibold text-gray-800 mb-4">Generate Owner Statement</h3>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div><label className="text-xs text-gray-500 mb-1 block">Owner *</label>
              <select value={genOwner} onChange={e => setGenOwner(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
                <option value="">Select owner...</option>
                {activeOwners.map(o => <option key={o.id} value={o.id}>{o.name} ({properties.filter(p => String(p.owner_id) === String(o.id)).length} properties)</option>)}
              </select>
            </div>
            <div><label className="text-xs text-gray-500 mb-1 block">Month</label><input type="month" value={genMonth} onChange={e => setGenMonth(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
          </div>
          {genOwner && (
            <div className="bg-gray-50 rounded-lg p-3 mb-4 text-xs text-gray-600">
              <div className="font-semibold mb-1">Properties included:</div>
              {properties.filter(p => String(p.owner_id) === String(genOwner)).map(p => <div key={p.id}>{p.address}</div>)}
              {properties.filter(p => String(p.owner_id) === String(genOwner)).length === 0 && <div className="text-amber-600">No properties assigned to this owner</div>}
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={generateStatement} className="bg-indigo-600 text-white text-sm px-6 py-2 rounded-lg hover:bg-indigo-700">Generate</button>
            <button onClick={() => setShowGenerate(false)} className="text-sm text-gray-500 px-4 py-2">Cancel</button>
          </div>
        </div>
      )}

      {/* Owner Form */}
      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-5 mb-5">
          <h3 className="font-semibold text-gray-800 mb-4">{editingOwner ? "Edit Owner" : "Add New Owner"}</h3>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div><label className="text-xs text-gray-500 mb-1 block">Name *</label><input value={form.name} onChange={e => setForm({...form, name: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Company</label><input value={form.company} onChange={e => setForm({...form, company: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Email</label><input type="email" value={form.email} onChange={e => setForm({...form, email: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Phone</label><input value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div className="col-span-2"><label className="text-xs text-gray-500 mb-1 block">Address</label><input value={form.address} onChange={e => setForm({...form, address: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Tax ID / EIN</label><input value={form.tax_id} onChange={e => setForm({...form, tax_id: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Management Fee %</label><input type="number" step="0.5" value={form.management_fee_pct} onChange={e => setForm({...form, management_fee_pct: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Payment Method</label>
              <select value={form.payment_method} onChange={e => setForm({...form, payment_method: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
                <option value="check">Check</option><option value="ach">ACH</option><option value="wire">Wire</option>
              </select>
            </div>
            <div><label className="text-xs text-gray-500 mb-1 block">Status</label>
              <select value={form.status} onChange={e => setForm({...form, status: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
                <option value="active">Active</option><option value="inactive">Inactive</option>
              </select>
            </div>
          </div>
          <div className="mb-4"><label className="text-xs text-gray-500 mb-1 block">Notes</label><textarea value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={2} /></div>
          <div className="flex gap-2">
            <button onClick={saveOwner} className="bg-indigo-600 text-white text-sm px-6 py-2 rounded-lg hover:bg-indigo-700">{editingOwner ? "Update" : "Add Owner"}</button>
            <button onClick={resetForm} className="text-sm text-gray-500 px-4 py-2">Cancel</button>
          </div>
        </div>
      )}

      {/* Statement Detail View */}
      {viewStatement && (
        <Modal title={"Statement — " + viewStatement.owner_name + " — " + viewStatement.period} onClose={() => setViewStatement(null)}>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-green-50 rounded-lg p-3 text-center"><div className="text-xs text-gray-500">Income</div><div className="text-lg font-bold text-green-700">${safeNum(viewStatement.total_income).toLocaleString()}</div></div>
              <div className="bg-red-50 rounded-lg p-3 text-center"><div className="text-xs text-gray-500">Expenses</div><div className="text-lg font-bold text-red-600">${safeNum(viewStatement.total_expenses).toLocaleString()}</div></div>
              <div className="bg-purple-50 rounded-lg p-3 text-center"><div className="text-xs text-gray-500">Mgmt Fee</div><div className="text-lg font-bold text-purple-700">${safeNum(viewStatement.management_fee).toLocaleString()}</div></div>
              <div className="bg-indigo-50 rounded-lg p-3 text-center"><div className="text-xs text-gray-500">Net to Owner</div><div className={"text-lg font-bold " + (viewStatement.net_to_owner >= 0 ? "text-indigo-700" : "text-red-600")}>${safeNum(viewStatement.net_to_owner).toLocaleString()}</div></div>
            </div>
            {(() => {
              let items = []; try { items = JSON.parse(viewStatement.line_items || "[]"); } catch {}
              return items.map((cat, ci) => (
                <div key={ci}>
                  <div className="font-semibold text-gray-700 text-sm mt-2 mb-1">{cat.category}</div>
                  {(cat.items || []).map((item, ii) => (
                    <div key={ii} className="flex justify-between text-xs py-1 border-b border-gray-50">
                      <div className="text-gray-600">{item.description}<span className="text-gray-400 ml-2">{item.date}</span></div>
                      <div className={"font-bold " + (item.amount >= 0 ? "text-green-600" : "text-red-600")}>{item.amount >= 0 ? "+" : ""}${Math.abs(item.amount).toLocaleString()}</div>
                    </div>
                  ))}
                  {(cat.items || []).length === 0 && <div className="text-xs text-gray-400 py-1">None</div>}
                </div>
              ));
            })()}
            <div className="flex gap-2 pt-3 border-t border-gray-100">
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
              <div key={o.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <div className="text-sm font-bold text-gray-800">{o.name}{o.company ? " — " + o.company : ""}</div>
                    <div className="text-xs text-gray-400">{o.email}{o.phone ? " · " + o.phone : ""}</div>
                  </div>
                  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (o.status === "active" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500")}>{o.status}</span>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-2 md:grid-cols-4">
                  <div><span className="text-gray-400">Properties:</span> <span className="font-bold">{ownerProps.length}</span></div>
                  <div><span className="text-gray-400">Mgmt Fee:</span> <span className="font-medium">{o.management_fee_pct}%</span></div>
                  <div><span className="text-gray-400">Total Distributed:</span> <span className="font-medium">${ownerDist.toLocaleString()}</span></div>
                  <div><span className="text-gray-400">Payment:</span> <span className="font-medium capitalize">{o.payment_method}</span></div>
                </div>
                {ownerProps.length > 0 && (
                  <div className="text-xs text-gray-500 mb-2">{ownerProps.map(p => p.address).join(" · ")}</div>
                )}
                <div className="flex gap-2 pt-2 border-t border-gray-50">
                  <button onClick={() => inviteOwner(o)} className="text-xs text-purple-600 border border-purple-200 px-3 py-1 rounded-lg hover:bg-purple-50">✉️ Invite</button>
                  <button onClick={() => startEdit(o)} className="text-xs text-indigo-600 border border-indigo-200 px-3 py-1 rounded-lg hover:bg-indigo-50">Edit</button>
                  <button onClick={() => { setGenOwner(o.id); setShowGenerate(true); }} className="text-xs text-green-600 border border-green-200 px-3 py-1 rounded-lg hover:bg-green-50">Generate Statement</button>
                </div>
              </div>
            );
          })}
          {owners.length === 0 && <div className="text-center py-10 text-gray-400">No owners added yet</div>}
        </div>
      )}

      {/* PROPERTIES TAB - assign owners */}
      {activeTab === "properties" && (
        <div className="space-y-2">
          <div className="text-sm text-gray-500 mb-3">Assign owners to properties. This determines which income and expenses appear on each owner's statement.</div>
          {properties.map(p => (
            <div key={p.id} className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex justify-between items-center">
              <div>
                <div className="text-sm font-medium text-gray-800">{p.address}</div>
                <div className="text-xs text-gray-400">{p.type} · {p.status}</div>
              </div>
              <select value={p.owner_id || ""} onChange={e => assignPropertyToOwner(p.id, e.target.value)} className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm min-w-40">
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
              <div key={s.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 cursor-pointer hover:border-indigo-200" onClick={() => setViewStatement(s)}>
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <div className="text-sm font-bold text-gray-800">{s.owner_name}</div>
                    <div className="text-xs text-gray-400">Period: {s.period}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-gray-800">${safeNum(s.net_to_owner).toLocaleString()}</div>
                    <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (sc[s.status] || "bg-gray-100")}>{s.status}</span>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div><span className="text-gray-400">Income:</span> <span className="text-green-600 font-medium">${safeNum(s.total_income).toLocaleString()}</span></div>
                  <div><span className="text-gray-400">Expenses:</span> <span className="text-red-600 font-medium">${safeNum(s.total_expenses).toLocaleString()}</span></div>
                  <div><span className="text-gray-400">Mgmt Fee:</span> <span className="text-purple-600 font-medium">${safeNum(s.management_fee).toLocaleString()}</span></div>
                </div>
              </div>
            );
          })}
          {statements.length === 0 && <div className="text-center py-10 text-gray-400">No statements generated yet. Click "Generate Statement" to create one.</div>}
        </div>
      )}

      {/* DISTRIBUTIONS TAB */}
      {activeTab === "distributions" && (
        <div className="space-y-2">
          {distributions.map(d => (
            <div key={d.id} className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex justify-between items-center">
              <div>
                <div className="text-sm font-medium text-gray-800">{owners.find(o => String(o.id) === String(d.owner_id))?.name || "Unknown"}</div>
                <div className="text-xs text-gray-400">{d.date} · {d.method} · {d.reference}</div>
              </div>
              <div className="text-sm font-bold text-green-600">${safeNum(d.amount).toLocaleString()}</div>
            </div>
          ))}
          {distributions.length === 0 && <div className="text-center py-10 text-gray-400">No distributions yet</div>}
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

  useEffect(() => { fetchRecons(); }, []);

  async function fetchRecons() {
    const { data } = await supabase.from("bank_reconciliations").select("*").eq("company_id", companyId || "sandbox-llc").order("created_at", { ascending: false });
    setReconciliations(data || []);
    setLoading(false);
  }

  async function startReconciliation() {
    if (!bankBalance || isNaN(Number(bankBalance))) { alert("Please enter the bank ending balance."); return; }
    const startDate = reconPeriod + "-01";
    const endObj = parseLocalDate(startDate); endObj.setMonth(endObj.getMonth() + 1); endObj.setDate(0);
    const endDate = formatLocalDate(endObj);

    // Pull all journal lines hitting the Checking Account (1000) in this period
    const { data: entries } = await supabase.from("acct_journal_entries").select("id, date, description, reference, status").eq("company_id", companyId || "sandbox-llc").gte("date", startDate).lte("date", endDate).eq("status", "posted");
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
    const reconciledTotal = reconItems.filter(i => i.reconciled).reduce((s, i) => s + i.amount, 0);
    const unreconciledTotal = reconItems.filter(i => !i.reconciled).reduce((s, i) => s + i.amount, 0);

    // Calculate book balance from all checking account entries (scoped to this company)
    const cJeIds = journalEntries.filter(j => j.status === "posted").map(j => j.id);
    const { data: allLines } = cJeIds.length > 0
      ? await supabase.from("acct_journal_lines").select("debit, credit").eq("account_name", "Checking Account").in("journal_entry_id", cJeIds)
      : { data: [] };
    const bookBal = (allLines || []).reduce((s, l) => s + safeNum(l.debit) - safeNum(l.credit), 0);
    const bankBal = Number(bankBalance);
    const diff = Math.round((bankBal - bookBal) * 100) / 100;
    const status = Math.abs(diff) < 0.01 && reconItems.every(i => i.reconciled) ? "reconciled" : Math.abs(diff) < 0.01 ? "reconciled" : "discrepancy";

    // Save reconciliation record
    const { error } = await supabase.from("bank_reconciliations").insert([{ company_id: companyId || "sandbox-llc",
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
      await supabase.from("acct_journal_lines").update({ reconciled: true, reconciled_date: today }).in("id", reconIds);
    }

    logAudit("create", "bank_reconciliation", "Bank reconciliation for " + reconPeriod + " — diff: $" + diff, "", "", "", companyId);
    setShowReconcile(false);
    setBankBalance("");
    setReconItems([]);
    fetchRecons();
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
            <h3 className="font-semibold text-gray-800 mb-3">Start Bank Reconciliation</h3>
            <div className="grid grid-cols-3 gap-3">
              <div><label className="text-xs text-gray-500 mb-1 block">Month</label><input type="month" value={reconPeriod} onChange={e => setReconPeriod(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="text-xs text-gray-500 mb-1 block">Bank Ending Balance ($)</label><input type="number" step="0.01" value={bankBalance} onChange={e => setBankBalance(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="Enter from bank statement" /></div>
              <div className="flex items-end"><button onClick={startReconciliation} className="bg-indigo-600 text-white text-sm px-6 py-2 rounded-lg hover:bg-indigo-700 w-full">Begin Reconciliation</button></div>
            </div>
          </div>

          <h3 className="font-semibold text-gray-700 mb-3">Previous Reconciliations</h3>
          <div className="space-y-2">
            {reconciliations.map(r => {
              const sc = { reconciled: "bg-green-100 text-green-700", in_progress: "bg-amber-100 text-amber-700", discrepancy: "bg-red-100 text-red-700" };
              return (
                <div key={r.id} className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex justify-between items-center cursor-pointer hover:border-indigo-200" onClick={() => setViewRecon(r)}>
                  <div>
                    <div className="text-sm font-medium text-gray-800">{r.period}</div>
                    <div className="text-xs text-gray-400">{new Date(r.created_at).toLocaleDateString()}</div>
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
            {reconciliations.length === 0 && <div className="text-center py-8 text-gray-400">No reconciliations yet</div>}
          </div>
        </div>
      )}

      {viewRecon && (
        <div>
          <button onClick={() => setViewRecon(null)} className="text-sm text-indigo-600 mb-3 hover:underline">← Back</button>
          <div className="bg-white rounded-xl border border-gray-100 p-5">
            <div className="flex justify-between items-start mb-4">
              <div><h3 className="font-semibold text-gray-800">Reconciliation — {viewRecon.period}</h3><div className="text-xs text-gray-400">{new Date(viewRecon.created_at).toLocaleDateString()}</div></div>
              <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (viewRecon.status === "reconciled" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700")}>{viewRecon.status}</span>
            </div>
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="bg-blue-50 rounded-lg p-3 text-center"><div className="text-xs text-gray-500">Bank Balance</div><div className="text-lg font-bold text-blue-700">${safeNum(viewRecon.bank_ending_balance).toLocaleString()}</div></div>
              <div className="bg-indigo-50 rounded-lg p-3 text-center"><div className="text-xs text-gray-500">Book Balance</div><div className="text-lg font-bold text-indigo-700">${safeNum(viewRecon.book_balance).toLocaleString()}</div></div>
              <div className={"rounded-lg p-3 text-center " + (Math.abs(viewRecon.difference) < 0.01 ? "bg-green-50" : "bg-red-50")}><div className="text-xs text-gray-500">Difference</div><div className={"text-lg font-bold " + (Math.abs(viewRecon.difference) < 0.01 ? "text-green-700" : "text-red-600")}>${safeNum(viewRecon.difference).toLocaleString()}</div></div>
            </div>
            {(() => { let items = []; try { items = JSON.parse(viewRecon.unreconciled_items || "[]"); } catch {} return items.length > 0 ? (
              <div><div className="font-semibold text-red-700 text-sm mb-2">Unreconciled Items ({items.length})</div>
                {items.map((it, i) => (<div key={i} className="flex justify-between text-xs py-1 border-b border-gray-50"><span className="text-gray-600">{it.date} — {it.description}</span><span className="font-bold">${it.amount.toLocaleString()}</span></div>))}
              </div>) : null; })()}
          </div>
        </div>
      )}

      {showReconcile && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <div>
              <h3 className="font-semibold text-gray-800">Reconcile — {reconPeriod}</h3>
              <div className="text-xs text-gray-400">Bank balance: ${Number(bankBalance).toLocaleString()} · Check items that match your bank statement</div>
            </div>
            <button onClick={() => { setShowReconcile(false); setReconItems([]); }} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
          </div>

          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-green-50 rounded-lg p-3 text-center"><div className="text-xs text-gray-500">Reconciled ({reconciledCount})</div><div className="text-lg font-bold text-green-700">${reconciledTotal.toLocaleString()}</div></div>
            <div className="bg-amber-50 rounded-lg p-3 text-center"><div className="text-xs text-gray-500">Unreconciled ({reconItems.length - reconciledCount})</div><div className="text-lg font-bold text-amber-700">${unreconciledTotal.toLocaleString()}</div></div>
            <div className={"rounded-lg p-3 text-center " + (Math.abs(Number(bankBalance) - reconciledTotal) < 0.01 ? "bg-green-50" : "bg-red-50")}><div className="text-xs text-gray-500">Remaining Diff</div><div className={"text-lg font-bold " + (Math.abs(Number(bankBalance) - reconciledTotal) < 0.01 ? "text-green-700" : "text-red-600")}>${(Number(bankBalance) - reconciledTotal).toLocaleString()}</div></div>
          </div>

          <div className="mb-3 flex items-center gap-2">
            <button onClick={toggleAllRecon} className="text-xs text-indigo-600 border border-indigo-200 px-3 py-1 rounded-lg hover:bg-indigo-50">{reconItems.every(i => i.reconciled) ? "Uncheck All" : "Check All"}</button>
            <span className="text-xs text-gray-400">{reconItems.length} transactions</span>
          </div>

          <div className="space-y-1 mb-4">
            {reconItems.map((item, i) => (
              <div key={i} onClick={() => toggleReconItem(i)} className={"flex items-center gap-3 px-4 py-2.5 rounded-lg cursor-pointer border " + (item.reconciled ? "bg-green-50 border-green-200" : "bg-white border-gray-100 hover:bg-gray-50")}>
                <span className={"w-5 h-5 rounded border flex items-center justify-center text-xs flex-shrink-0 " + (item.reconciled ? "bg-green-500 border-green-500 text-white" : "border-gray-300")}>{item.reconciled ? "✓" : ""}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-800 truncate">{item.description}</div>
                  <div className="text-xs text-gray-400">{item.date} · {item.reference} · {item.memo}</div>
                </div>
                <div className={"text-sm font-bold flex-shrink-0 " + (item.amount >= 0 ? "text-green-600" : "text-red-600")}>{item.amount >= 0 ? "+" : ""}${item.amount.toLocaleString()}</div>
              </div>
            ))}
          </div>

          <button onClick={saveReconciliation} className="bg-indigo-600 text-white text-sm px-8 py-2.5 rounded-lg hover:bg-indigo-700">Save Reconciliation</button>
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

  useEffect(() => { fetchData(); }, []);

  async function fetchData() {
    setLoading(true);
    const [s, l, t, le] = await Promise.all([
      supabase.from("notification_settings").select("*").eq("company_id", companyId || "sandbox-llc").order("event_type"),
      supabase.from("notification_log").select("*").eq("company_id", companyId || "sandbox-llc").order("created_at", { ascending: false }).limit(100),
      supabase.from("tenants").select("*").eq("company_id", companyId || "sandbox-llc"),
      supabase.from("leases").select("*").eq("company_id", companyId || "sandbox-llc").eq("status", "active"),
    ]);
    setSettings(s.data || []);
    setLogs(l.data || []);
    setTenants(t.data || []);
    setLeases(le.data || []);
    setLoading(false);
  }

  async function toggleSetting(setting) {
    await supabase.from("notification_settings").update({ enabled: !setting.enabled }).eq("id", setting.id);
    fetchData();
  }

  async function updateDaysBefore(setting, days) {
    await supabase.from("notification_settings").update({ days_before: Number(days) }).eq("id", setting.id);
    fetchData();
  }

  async function updateTemplate(setting, template) {
    await supabase.from("notification_settings").update({ template }).eq("id", setting.id);
  }

  async function sendTestNotification(setting) {
    // Simulate sending by logging it
    const testRecipient = userProfile?.email || "test@example.com";
    await supabase.from("notification_log").insert([{ company_id: companyId || "sandbox-llc",
      event_type: setting.event_type,
      recipient_email: testRecipient,
      subject: "[TEST] " + (eventLabels[setting.event_type]?.label || setting.event_type),
      message: setting.template || "Test notification",
      status: "sent",
      related_id: "test",
    }]);
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
            await supabase.from("notification_log").insert([{ company_id: companyId || "sandbox-llc", event_type: "rent_due", recipient_email: tenant.email, subject: "Rent Due Reminder", message: msg, status: "sent", related_id: lease.id }]);
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
            await supabase.from("notification_log").insert([{ company_id: companyId || "sandbox-llc", event_type: "lease_expiring", recipient_email: tenant.email, subject: "Lease Expiration Notice", message: msg, status: "sent", related_id: lease.id }]);
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

  return (
    <div>
      <div className="flex justify-between items-center mb-5">
        <h2 className="text-xl font-bold text-gray-800">Email Notifications</h2>
        <button onClick={runNotificationCheck} className="bg-indigo-600 text-white text-xs px-4 py-2 rounded-lg hover:bg-indigo-700">Run Notification Check</button>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-5 md:grid-cols-4">
        <StatCard label="Active Rules" value={enabledCount + "/" + settings.length} color="text-green-600" sub="notification types" />
        <StatCard label="Sent Today" value={sentToday} color="text-blue-600" sub="notifications" />
        <StatCard label="Total Sent" value={logs.length} color="text-indigo-600" sub="all time" />
        <StatCard label="Failed" value={logs.filter(l => l.status === "failed").length} color={logs.filter(l => l.status === "failed").length > 0 ? "text-red-500" : "text-gray-400"} sub="delivery errors" />
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-5 text-sm text-amber-800">
        <span className="font-semibold">Note:</span> Notifications are currently logged to the database. To send actual emails, connect a Supabase Edge Function with SendGrid, Resend, or Postmark. The templates and triggers are ready to wire up.
      </div>

      <div className="flex gap-1 mb-4 border-b border-gray-100">
        {[["settings","Settings"],["log","Send Log"],["rentroll","Rent Roll"]].map(([id,label]) => (
          <button key={id} onClick={() => setActiveTab(id)} className={"px-4 py-2 text-sm font-medium border-b-2 " + (activeTab === id ? "border-indigo-600 text-indigo-700" : "border-transparent text-gray-500")}>{label}</button>
        ))}
      </div>

      {/* SETTINGS TAB */}
      {activeTab === "settings" && (
        <div className="space-y-3">
          {settings.map(s => {
            const info = eventLabels[s.event_type] || { label: s.event_type, icon: "\ud83d\udce7", desc: "" };
            return (
              <div key={s.id} className={"bg-white rounded-xl border shadow-sm p-4 " + (s.enabled ? "border-gray-100" : "border-gray-50 opacity-60")}>
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{info.icon}</span>
                    <div>
                      <div className="text-sm font-bold text-gray-800">{info.label}</div>
                      <div className="text-xs text-gray-400">{info.desc}</div>
                    </div>
                  </div>
                  <button onClick={() => toggleSetting(s)} className={"relative w-10 h-5 rounded-full transition-colors " + (s.enabled ? "bg-green-500" : "bg-gray-300")}>
                    <span className={"absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow " + (s.enabled ? "left-5" : "left-0.5")} />
                  </button>
                </div>
                <div className="flex items-center gap-3 text-xs mb-2">
                  <span className="text-gray-400">Recipients:</span>
                  <span className="font-medium text-gray-600">{s.recipients}</span>
                  {s.days_before > 0 && (
                    <div className="flex items-center gap-1">
                      <span className="text-gray-400">Days before:</span>
                      <input type="number" value={s.days_before} onChange={e => updateDaysBefore(s, e.target.value)} className="w-12 border border-gray-200 rounded px-1 py-0.5 text-xs text-center" min="0" />
                    </div>
                  )}
                </div>
                <div className="mb-2">
                  <textarea value={s.template} onChange={e => updateTemplate(s, e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-600" rows={2} />
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
            <div key={l.id} className="bg-white rounded-xl border border-gray-100 px-4 py-2.5 flex justify-between items-center">
              <div>
                <div className="text-sm text-gray-800">{l.subject}</div>
                <div className="text-xs text-gray-400">{l.recipient_email} · {new Date(l.created_at).toLocaleString()}</div>
              </div>
              <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (l.status === "sent" ? "bg-green-100 text-green-700" : l.status === "failed" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700")}>{l.status}</span>
            </div>
          ))}
          {logs.length === 0 && <div className="text-center py-8 text-gray-400">No notifications sent yet</div>}
        </div>
      )}

      {/* RENT ROLL TAB */}
      {activeTab === "rentroll" && (
        <div>
          <h3 className="font-semibold text-gray-700 mb-3">Rent Roll</h3>
          <div className="bg-white rounded-xl border border-gray-100 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
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
                  <tr key={t.id} className="border-t border-gray-50">
                    <td className="px-4 py-2 font-medium text-gray-800">{t.name}</td>
                    <td className="px-4 py-2 text-gray-600">{t.property}</td>
                    <td className="px-4 py-2 text-right font-bold">${safeNum(t.rent).toLocaleString()}</td>
                    <td className={"px-4 py-2 text-right font-bold " + (safeNum(t.balance) > 0 ? "text-red-600" : "text-green-600")}>${safeNum(t.balance).toLocaleString()}</td>
                    <td className="px-4 py-2 text-gray-600">{t.move_out || "—"}</td>
                    <td className="px-4 py-2"><span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (t.lease_status === "active" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500")}>{t.lease_status || "active"}</span></td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50 font-bold text-sm">
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

  useEffect(() => { fetchSigners(); }, [lease]);

  async function fetchSigners() {
    const { data } = await supabase.from("lease_signatures").select("*").eq("lease_id", lease.id).order("created_at");
    setSigners(data || []);
    setLoading(false);
  }

  async function initSignatureRequest() {
    // Create signature requests for tenant and landlord
    const existing = signers.map(s => s.signer_role);
    const toCreate = [];
    if (!existing.includes("tenant")) {
      toCreate.push({ lease_id: lease.id, signer_name: lease.tenant_name, signer_email: "", signer_role: "tenant", status: "pending" });
    }
    if (!existing.includes("landlord")) {
      toCreate.push({ lease_id: lease.id, signer_name: userProfile?.name || "Property Manager", signer_email: userProfile?.email || "", signer_role: "landlord", status: "pending" });
    }
    if (toCreate.length > 0) {
      await supabase.from("lease_signatures").insert(toCreate.map(s => ({ ...s, company_id: companyId || "sandbox-llc" })));
      await supabase.from("leases").update({ signature_status: "pending" }).eq("company_id", companyId || "sandbox-llc").eq("id", lease.id);
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
    let sigData = "";
    if (signMethod === "draw") {
      const canvas = canvasRef.current;
      if (!canvas) return;
      sigData = canvas.toDataURL("image/png");
      // Check if canvas is blank
      const ctx = canvas.getContext("2d");
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const hasContent = pixels.some((v, i) => i % 4 === 3 && v > 0);
      if (!hasContent) { alert("Please draw your signature first."); return; }
    } else {
      if (!typedName.trim()) { alert("Please type your name."); return; }
      sigData = "typed:" + typedName.trim();
    }

    setSigning(true);
    await supabase.from("lease_signatures").update({
      status: "signed",
      signed_at: new Date().toISOString(),
      signature_data: sigData,
      ip_address: "client",
    }).eq("id", signer.id);

    // Check if all signers have signed
    const { data: allSigs } = await supabase.from("lease_signatures").select("status").eq("lease_id", lease.id);
    const allSigned = allSigs && allSigs.every(s => s.status === "signed");
    await supabase.from("leases").update({
      signature_status: allSigned ? "fully_signed" : "partially_signed"
    }).eq("id", lease.id);

    logAudit("update", "leases", "E-signature: " + signer.signer_name + " signed lease for " + lease.tenant_name, lease.id, userProfile?.email, "", companyId);
    setSigning(false);
    fetchSigners();
    if (onSigned) onSigned();
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
        <div className="bg-gray-50 rounded-lg p-3 max-h-32 overflow-y-auto">
          <div className="text-xs font-semibold text-gray-600 mb-1">Lease Terms</div>
          <div className="text-xs text-gray-500 whitespace-pre-wrap">{lease.clauses || "Standard residential lease terms apply."}</div>
          {lease.special_terms && <div className="text-xs text-gray-500 mt-1"><span className="font-semibold">Special Terms:</span> {lease.special_terms}</div>}
        </div>

        {/* Signer Status */}
        <div>
          <div className="text-sm font-semibold text-gray-700 mb-2">Signatures</div>
          {signers.length === 0 && (
            <div className="text-center py-4">
              <div className="text-sm text-gray-500 mb-3">No signature requests yet</div>
              <button onClick={initSignatureRequest} className="bg-indigo-600 text-white text-sm px-6 py-2 rounded-lg hover:bg-indigo-700">Send for Signature</button>
            </div>
          )}
          {signers.map(s => (
            <div key={s.id} className={"flex items-center justify-between px-3 py-2 rounded-lg mb-2 " + (s.status === "signed" ? "bg-green-50 border border-green-200" : "bg-amber-50 border border-amber-200")}>
              <div>
                <div className="text-sm font-medium text-gray-800">{s.signer_name}</div>
                <div className="text-xs text-gray-400 capitalize">{s.signer_role}</div>
              </div>
              <div className="flex items-center gap-2">
                {s.status === "signed" ? (
                  <div className="text-right">
                    <span className="text-xs font-bold text-green-700 bg-green-100 px-2 py-0.5 rounded-full">✓ Signed</span>
                    <div className="text-xs text-gray-400 mt-0.5">{new Date(s.signed_at).toLocaleDateString()}</div>
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
          <div className="border border-gray-200 rounded-xl p-4">
            <div className="text-sm font-semibold text-gray-700 mb-2">Sign as: {pendingSigners[0].signer_name} ({pendingSigners[0].signer_role})</div>

            <div className="flex gap-2 mb-3">
              <button onClick={() => setSignMethod("draw")} className={"text-xs px-3 py-1.5 rounded-lg font-medium " + (signMethod === "draw" ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600")}>Draw Signature</button>
              <button onClick={() => setSignMethod("type")} className={"text-xs px-3 py-1.5 rounded-lg font-medium " + (signMethod === "type" ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600")}>Type Name</button>
            </div>

            {signMethod === "draw" ? (
              <div>
                <div className="border-2 border-dashed border-gray-300 rounded-lg bg-white relative mb-2">
                  <canvas ref={canvasRef} width={400} height={120}
                    onMouseDown={startDraw} onMouseMove={draw} onMouseUp={endDraw} onMouseLeave={endDraw}
                    onTouchStart={startDraw} onTouchMove={draw} onTouchEnd={endDraw}
                    className="w-full cursor-crosshair" style={{ touchAction: "none" }} />
                  <div className="absolute bottom-1 left-3 text-xs text-gray-300">Sign above this line</div>
                </div>
                <button onClick={clearCanvas} className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
              </div>
            ) : (
              <div>
                <input value={typedName} onChange={e => setTypedName(e.target.value)} placeholder="Type your full legal name"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-1" />
                {typedName && <div className="text-2xl text-indigo-800 italic font-serif py-2 px-3 bg-gray-50 rounded-lg">{typedName}</div>}
              </div>
            )}

            <div className="flex items-start gap-2 mt-3 mb-3 bg-amber-50 rounded-lg p-2">
              <input type="checkbox" id="esign-agree" className="mt-1" />
              <label htmlFor="esign-agree" className="text-xs text-gray-600">I agree that my electronic signature is the legal equivalent of my manual/handwritten signature and I consent to be legally bound by this lease agreement.</label>
            </div>

            <button onClick={() => submitSignature(pendingSigners[0])} disabled={signing}
              className={"w-full py-2.5 rounded-lg text-white font-semibold text-sm " + (signing ? "bg-gray-400" : "bg-indigo-600 hover:bg-indigo-700")}>
              {signing ? "Signing..." : "Apply Signature"}
            </button>
          </div>
        )}

        {allSigned && (
          <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
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
  const receiptDate = new Date(payment.date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const receiptNum = "REC-" + String(payment.id || Date.now()).slice(-8).toUpperCase();

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
    <h1>${companyName}</h1>
    <div class="subtitle">Payment Receipt</div>
    <div class="badge">Receipt #${receiptNum}</div>
  </div>
  <div class="body">
    <div class="row"><span class="label">Date</span><span class="value">${receiptDate}</span></div>
    <div class="row"><span class="label">Tenant</span><span class="value">${payment.tenant || "N/A"}</span></div>
    <div class="row"><span class="label">Property</span><span class="value">${payment.property || "N/A"}</span></div>
    <div class="row"><span class="label">Payment Type</span><span class="value" style="text-transform:capitalize">${payment.type || "rent"}</span></div>
    <div class="row"><span class="label">Payment Method</span><span class="value" style="text-transform:uppercase">${payment.method || "N/A"}</span></div>
    <div class="row"><span class="label">Status</span><span class="value" style="text-transform:capitalize">${payment.status || "paid"}</span></div>
    <div class="amount-row"><span class="label">Amount Paid</span><span class="value">$${safeNum(payment.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span></div>
  </div>
  <div class="footer">
    <div class="stamp">PAID</div>
    <p>This is an electronic receipt generated by ${companyName}.</p>
    <p>For questions, contact your property manager.</p>
  </div>
</div>
</body></html>`;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank");
  if (win) {
    win.onload = () => { setTimeout(() => win.print(), 500); };
  }
}

// ============ OWNER PORTAL ============
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
    const { data: owner } = await supabase.from("owners").select("*").eq("company_id", companyId || "sandbox-llc").ilike("email", currentUser.email).maybeSingle();
    if (!owner) { setError("No owner account found for " + currentUser.email); setLoading(false); return; }
    setOwnerData(owner);

    const [p, s, d] = await Promise.all([
      supabase.from("properties").select("*").eq("company_id", companyId || "sandbox-llc").eq("owner_id", owner.id),
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
      <h2 className="text-xl font-bold text-gray-800 mb-2">Owner Portal</h2>
      <p className="text-gray-500 mb-4">{error}</p>
      <p className="text-sm text-gray-400">Please contact your property manager to set up your owner portal access.</p>
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
        <div className="bg-white rounded-xl border border-gray-100 p-4 text-center">
          <div className="text-xs text-gray-500 mb-1">Total Income</div>
          <div className="text-lg font-bold text-green-600">${totalIncome.toLocaleString()}</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4 text-center">
          <div className="text-xs text-gray-500 mb-1">Total Expenses</div>
          <div className="text-lg font-bold text-red-500">${totalExpenses.toLocaleString()}</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4 text-center">
          <div className="text-xs text-gray-500 mb-1">Distributions</div>
          <div className="text-lg font-bold text-indigo-600">${totalDistributed.toLocaleString()}</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4 text-center">
          <div className="text-xs text-gray-500 mb-1">Pending</div>
          <div className="text-lg font-bold text-amber-600">{pendingStatements.length}</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-gray-100">
        {[["overview","\ud83c\udfe0 Overview"],["statements","\ud83d\udcca Statements"],["distributions","💰 Distributions"],["properties","\ud83c\udfe2 Properties"]].map(([id, label]) => (
          <button key={id} onClick={() => { setActiveTab(id); setViewStatement(null); }} className={"px-4 py-2.5 text-sm font-medium border-b-2 transition-colors " + (activeTab === id ? "border-indigo-600 text-indigo-700" : "border-transparent text-gray-500 hover:text-gray-700")}>{label}</button>
        ))}
      </div>

      {/* OVERVIEW TAB */}
      {activeTab === "overview" && (
        <div className="space-y-4">
          <h3 className="font-semibold text-gray-700">Your Properties</h3>
          <div className="grid gap-3 md:grid-cols-2">
            {properties.map(p => (
              <div key={p.id} className="bg-white rounded-xl border border-gray-100 p-4">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-semibold text-gray-800 text-sm">{p.address}</div>
                    <div className="text-xs text-gray-400">{p.type || "Residential"}</div>
                  </div>
                  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (p.status === "occupied" ? "bg-green-100 text-green-700" : p.status === "vacant" ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500")}>{p.status || "active"}</span>
                </div>
                {p.rent && <div className="text-sm font-bold text-green-600 mt-2">${safeNum(p.rent).toLocaleString()}/mo</div>}
              </div>
            ))}
            {properties.length === 0 && <div className="text-center py-8 text-gray-400">No properties assigned yet</div>}
          </div>

          {/* Recent statements */}
          {statements.length > 0 && (
            <div>
              <h3 className="font-semibold text-gray-700 mt-4 mb-2">Recent Statements</h3>
              {statements.slice(0, 3).map(s => (
                <div key={s.id} className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex justify-between items-center mb-2 cursor-pointer hover:border-indigo-200" onClick={() => { setActiveTab("statements"); setViewStatement(s); }}>
                  <div>
                    <div className="text-sm font-medium text-gray-800">{s.period}</div>
                    <div className="text-xs text-gray-400">Net: ${safeNum(s.net_to_owner).toLocaleString()}</div>
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
            <div key={s.id} className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex justify-between items-center cursor-pointer hover:border-indigo-200" onClick={() => setViewStatement(s)}>
              <div>
                <div className="text-sm font-semibold text-gray-800">{s.period}</div>
                <div className="text-xs text-gray-400">{new Date(s.created_at).toLocaleDateString()}</div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <div className="text-xs text-gray-400">Income: <span className="text-green-600 font-bold">${safeNum(s.total_income).toLocaleString()}</span></div>
                  <div className="text-xs text-gray-400">Net: <span className="text-indigo-600 font-bold">${safeNum(s.net_to_owner).toLocaleString()}</span></div>
                </div>
                <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (s.status === "paid" ? "bg-green-100 text-green-700" : s.status === "sent" ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700")}>{s.status}</span>
              </div>
            </div>
          ))}
          {statements.length === 0 && <div className="text-center py-8 text-gray-400">No statements yet</div>}
        </div>
      )}

      {/* STATEMENT DETAIL */}
      {activeTab === "statements" && viewStatement && (
        <div>
          <button onClick={() => setViewStatement(null)} className="text-sm text-indigo-600 mb-3 hover:underline">\u2190 Back to Statements</button>
          <div className="bg-white rounded-xl border border-gray-100 p-5">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="font-bold text-gray-800">Owner Statement — {viewStatement.period}</h3>
                <div className="text-xs text-gray-400">{viewStatement.owner_name} · Generated {new Date(viewStatement.created_at).toLocaleDateString()}</div>
              </div>
              <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (viewStatement.status === "paid" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700")}>{viewStatement.status}</span>
            </div>
            <div className="grid grid-cols-4 gap-3 mb-4">
              <div className="bg-green-50 rounded-lg p-3 text-center"><div className="text-xs text-gray-500">Income</div><div className="text-lg font-bold text-green-600">${safeNum(viewStatement.total_income).toLocaleString()}</div></div>
              <div className="bg-red-50 rounded-lg p-3 text-center"><div className="text-xs text-gray-500">Expenses</div><div className="text-lg font-bold text-red-500">${safeNum(viewStatement.total_expenses).toLocaleString()}</div></div>
              <div className="bg-purple-50 rounded-lg p-3 text-center"><div className="text-xs text-gray-500">Mgmt Fee</div><div className="text-lg font-bold text-purple-600">${safeNum(viewStatement.management_fee).toLocaleString()}</div></div>
              <div className="bg-indigo-50 rounded-lg p-3 text-center"><div className="text-xs text-gray-500">Net to You</div><div className="text-lg font-bold text-indigo-700">${safeNum(viewStatement.net_to_owner).toLocaleString()}</div></div>
            </div>
            {/* Line items */}
            {(() => { let items = []; try { items = JSON.parse(viewStatement.line_items || "[]"); } catch {} return items.map((cat, ci) => (
              <div key={ci} className="mb-3">
                <div className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">{cat.category}</div>
                {(cat.items || []).map((item, ii) => (
                  <div key={ii} className="flex justify-between text-xs py-1 border-b border-gray-50">
                    <span className="text-gray-600">{item.date} — {item.description}</span>
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
            <div key={d.id} className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex justify-between items-center">
              <div>
                <div className="text-sm font-medium text-gray-800">${safeNum(d.amount).toLocaleString()}</div>
                <div className="text-xs text-gray-400">{d.reference} · {new Date(d.date).toLocaleDateString()}</div>
              </div>
              <div className="text-right">
                <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-green-100 text-green-700">{d.method?.toUpperCase()}</span>
              </div>
            </div>
          ))}
          {distributions.length === 0 && <div className="text-center py-8 text-gray-400">No distributions yet</div>}
        </div>
      )}

      {/* PROPERTIES TAB */}
      {activeTab === "properties" && (
        <div className="space-y-3">
          {properties.map(p => (
            <div key={p.id} className="bg-white rounded-xl border border-gray-100 p-4">
              <div className="flex justify-between items-start mb-2">
                <div>
                  <div className="font-semibold text-gray-800">{p.address}</div>
                  <div className="text-xs text-gray-400">{p.type || "Residential"} · {p.bedrooms || "?"} bd / {p.bathrooms || "?"} ba · {p.sqft || "?"} sqft</div>
                </div>
                <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (p.status === "occupied" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700")}>{p.status}</span>
              </div>
              {p.rent && <div className="text-sm">Rent: <span className="font-bold text-green-600">${safeNum(p.rent).toLocaleString()}/mo</span></div>}
            </div>
          ))}
          {properties.length === 0 && <div className="text-center py-8 text-gray-400">No properties assigned</div>}
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

  useEffect(() => { fetchHOA(); }, []);

  async function fetchHOA() {
    const { data } = await supabase.from("hoa_payments").select("*").eq("company_id", companyId || "sandbox-llc").order("due_date", { ascending: false });
    setHoaPayments(data || []);
    setLoading(false);
  }

  async function saveHOA() {
    if (!form.property || !form.hoa_name || !form.amount || !form.due_date) { alert("All fields required."); return; }
    const payload = { ...form, amount: Number(form.amount) };
    if (editingHoa) {
      await supabase.from("hoa_payments").update({ property: payload.property, hoa_name: payload.hoa_name, amount: payload.amount, due_date: payload.due_date, frequency: payload.frequency, status: payload.status, notes: payload.notes }).eq("id", editingHoa.id).eq("company_id", companyId || "sandbox-llc");
      addNotification("🏘️", `HOA payment updated: ${form.hoa_name}`);
    } else {
      await supabase.from("hoa_payments").insert([{ company_id: companyId || "sandbox-llc", ...payload }]);
      addNotification("🏘️", `HOA payment added: ${form.hoa_name} — $${form.amount}`);
    }
    setShowForm(false);
    setEditingHoa(null);
    setForm({ property: "", hoa_name: "", amount: "", due_date: "", frequency: "monthly", status: "pending", notes: "" });
    fetchHOA();
  }

  async function payHOA(h) {
    if (h.status === "paid") { alert("This HOA payment is already marked as paid."); return; }
    const today = formatLocalDate(new Date());
    await supabase.from("hoa_payments").update({ status: "paid", paid_date: today }).eq("id", h.id);
    addNotification("✅", `HOA paid: ${h.hoa_name} $${h.amount}`);
    // Auto-post to accounting
    const classId = await getPropertyClassId(h.property, companyId);
    if (safeNum(h.amount) > 0) {
      await autoPostJournalEntry({
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
    }
    fetchHOA();
  }

  async function deleteHOA(id) {
    if (!window.confirm("Delete this HOA payment?")) return;
    await supabase.from("hoa_payments").delete().eq("id", id).eq("company_id", companyId || "sandbox-llc");
    fetchHOA();
  }

  if (loading) return <Spinner />;
  const filtered = hoaPayments.filter(h =>
    (hoaFilter === "all" || h.status === hoaFilter)
  );

  return (
    <div>
      <div className="flex flex-col md:flex-row gap-3 mb-4">
        <h2 className="text-xl font-bold text-gray-800 mr-auto">HOA Payments</h2>
        <select value={hoaFilter} onChange={e => setHoaFilter(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
          <option value="all">All Status</option><option value="pending">Pending</option><option value="paid">Paid</option>
        </select>
        <button onClick={() => { setEditingHoa(null); setForm({ property: "", hoa_name: "", amount: "", due_date: "", frequency: "monthly", status: "pending", notes: "" }); setShowForm(!showForm); }} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">+ Add HOA</button>
      </div>

      {/* Stats */}
      <div className="flex gap-3 mb-4">
        <div className="bg-white rounded-xl border border-gray-100 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-gray-800">{hoaPayments.length}</div><div className="text-xs text-gray-400">Total</div></div>
        <div className="bg-white rounded-xl border border-gray-100 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-amber-600">{hoaPayments.filter(h => h.status === "pending").length}</div><div className="text-xs text-gray-400">Pending</div></div>
        <div className="bg-white rounded-xl border border-gray-100 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-emerald-600">${hoaPayments.filter(h => h.status === "paid").reduce((s, h) => s + safeNum(h.amount), 0).toLocaleString()}</div><div className="text-xs text-gray-400">Paid</div></div>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-gray-700 mb-3">{editingHoa ? "Edit HOA Payment" : "New HOA Payment"}</h3>
          <div className="grid grid-cols-2 gap-3">
            <PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} companyId={companyId} />
            <input placeholder="HOA Company Name" value={form.hoa_name} onChange={e => setForm({ ...form, hoa_name: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Amount ($)" type="number" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input type="date" value={form.due_date} onChange={e => setForm({ ...form, due_date: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <select value={form.frequency} onChange={e => setForm({ ...form, frequency: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              <option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option>
            </select>
            <input placeholder="Notes" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={saveHOA} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg">Save</button>
            <button onClick={() => { setShowForm(false); setEditingHoa(null); }} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg">Cancel</button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-400 uppercase">
            <tr><th className="px-4 py-3 text-left">Property</th><th className="px-4 py-3 text-left">HOA Company</th><th className="px-4 py-3 text-right">Amount</th><th className="px-4 py-3 text-left">Due Date</th><th className="px-4 py-3 text-left">Frequency</th><th className="px-4 py-3 text-left">Status</th><th className="px-4 py-3 text-right">Actions</th></tr>
          </thead>
          <tbody>
            {filtered.map(h => (
              <tr key={h.id} className="border-t border-gray-50 hover:bg-gray-50/50">
                <td className="px-4 py-2.5 text-gray-800">{h.property}</td>
                <td className="px-4 py-2.5 font-medium text-gray-800">{h.hoa_name}</td>
                <td className="px-4 py-2.5 text-right font-semibold">${safeNum(h.amount).toLocaleString()}</td>
                <td className="px-4 py-2.5 text-gray-500">{h.due_date}</td>
                <td className="px-4 py-2.5 text-gray-600 capitalize">{h.frequency}</td>
                <td className="px-4 py-2.5"><Badge status={h.status} /></td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  {h.status === "pending" && <button onClick={() => payHOA(h)} className="text-xs text-green-600 hover:underline mr-2">Pay</button>}
                  <button onClick={() => { setEditingHoa(h); setForm({ property: h.property, hoa_name: h.hoa_name, amount: String(h.amount), due_date: h.due_date, frequency: h.frequency || "monthly", status: h.status, notes: h.notes || "" }); setShowForm(true); }} className="text-xs text-indigo-600 hover:underline mr-2">Edit</button>
                  <button onClick={() => deleteHOA(h.id)} className="text-xs text-red-500 hover:underline">Del</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="text-center py-8 text-gray-400">No HOA payments found</div>}
      </div>
    </div>
  );
}


// ============ ROLE DEFINITIONS ============
const ROLES = {
  admin: { label: "Admin", color: "bg-indigo-600", pages: ["dashboard","properties","tenants","payments","maintenance","utilities","accounting","documents","inspections","autopay","hoa","audittrail","leases","vendors","owners","notifications"] },
  office_assistant: { label: "Office Assistant", color: "bg-blue-500", pages: ["dashboard","properties","tenants","payments","maintenance","documents","inspections","leases","vendors","owners","notifications"] },
  accountant: { label: "Accountant", color: "bg-green-600", pages: ["dashboard","accounting","payments","utilities"] },
  maintenance: { label: "Maintenance", color: "bg-orange-500", pages: ["maintenance","vendors"] },
  tenant: { label: "Tenant", color: "bg-gray-500", pages: ["tenant_portal"] },
  owner: { label: "Owner", color: "bg-purple-600", pages: ["owner_portal"] },
};

const ALL_NAV = [
  { id: "dashboard", label: "Dashboard", icon: "⊞" },
  { id: "properties", label: "Properties", icon: "🏠" },
  { id: "tenants", label: "Tenants", icon: "👤" },
  { id: "payments", label: "Payments", icon: "💳" },
  { id: "maintenance", label: "Maintenance", icon: "🔧" },
  { id: "utilities", label: "Utilities", icon: "⚡" },
  { id: "accounting", label: "Accounting", icon: "📊" },
  { id: "documents", label: "Documents", icon: "📁" },
  { id: "inspections", label: "Inspections", icon: "🔍" },
  { id: "autopay", label: "Autopay", icon: "🔄" },
  { id: "hoa", label: "HOA Payments", icon: "🏘️" },
  { id: "audittrail", label: "Audit Trail", icon: "📋" },
  { id: "leases", label: "Leases", icon: "📝" },
  { id: "vendors", label: "Vendors", icon: "🛠️" },
  { id: "owners", label: "Owners", icon: "👤" },
  { id: "notifications", label: "Notifications", icon: "📨" },
];

// ============ AUTOPAY / RECURRING RENT ============
function Autopay({ addNotification, userProfile, userRole, companyId }) {
  const [schedules, setSchedules] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ tenant: "", property: "", amount: "", frequency: "monthly", day_of_month: "1", start_date: "", end_date: "", method: "ACH", active: true });

  useEffect(() => { fetchData(); }, []);

  async function fetchData() {
    try {
      const [s, t] = await Promise.all([
        supabase.from("autopay_schedules").select("*").eq("company_id", companyId || "sandbox-llc").order("created_at", { ascending: false }),
        supabase.from("tenants").select("*").eq("company_id", companyId || "sandbox-llc"),
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
    if (!form.tenant) { alert("Please select a tenant."); return; }
    if (!form.amount || isNaN(Number(form.amount))) { alert("Please enter a valid amount."); return; }
    if (!form.start_date) { alert("Start date is required."); return; }
    const { error } = await supabase.from("autopay_schedules").insert([{ company_id: companyId || "sandbox-llc", ...form, amount: Number(form.amount) }]);
    if (error) { alert("Error saving schedule: " + error.message); return; }
    addNotification("🔄", `Autopay schedule created for ${form.tenant}`);
    setShowForm(false);
    setForm({ tenant: "", property: "", amount: "", frequency: "monthly", day_of_month: "1", start_date: "", end_date: "", method: "ACH", active: true });
    fetchData();
  }

  async function toggleActive(s) {
    await supabase.from("autopay_schedules").update({ active: s.active !== true }).eq("id", s.id);
    addNotification("🔄", `Autopay ${!s.active ? "activated" : "paused"} for ${s.tenant}`);
    fetchData();
  }

  async function deleteSchedule(id, tenant) {
    if (!window.confirm(`Delete autopay schedule for ${tenant}?`)) return;
    await supabase.from("autopay_schedules").delete().eq("id", id).eq("company_id", companyId || "sandbox-llc");
    fetchData();
  }

  async function runNow(s) {
    if (s._processing) return; s._processing = true;
    const today = formatLocalDate(new Date());
    // Duplicate guard: check for existing payment today
    const { data: todayPay } = await supabase.from("payments").select("id").eq("company_id", companyId || "sandbox-llc").eq("tenant", s.tenant).eq("date", today).eq("method", s.method).limit(1);
    if (todayPay?.length > 0) { if (!window.confirm("A payment from " + s.tenant + " was already recorded today. Run again?")) { s._processing = false; return; } }
    const { error } = await supabase.from("payments").insert([{ company_id: companyId || "sandbox-llc", tenant: s.tenant, property: s.property, amount: s.amount, type: "rent", method: s.method, status: "paid", date: today }]);
    if (error) { alert("Error: " + error.message); return; }
    // AUTO-POST TO ACCOUNTING: Same smart AR logic as manual payments
    const classId = await getPropertyClassId(s.property, companyId);
    const amt = safeNum(s.amount);
    const month = today.slice(0, 7);
    let hasAccrual = false;
    const { data: accrualJEs } = await supabase.from("acct_journal_entries").select("id").eq("company_id", companyId || "sandbox-llc").like("reference", `ACCR-${month}%`).neq("status", "voided");
    if (accrualJEs && accrualJEs.length > 0) {
      for (const je of accrualJEs) {
        const { data: jLines } = await supabase.from("acct_journal_lines").select("memo").eq("journal_entry_id", je.id);
        if (jLines && jLines.some(l => l.memo && l.memo.includes(s.tenant))) { hasAccrual = true; break; }
      }
    }
    if (hasAccrual) {
      await autoPostJournalEntry({ companyId, date: today, description: "Autopay received — " + s.tenant + " — " + s.property + " (settling AR)", reference: "APAY-" + Date.now(), property: s.property,
        lines: [
          { account_id: "1000", account_name: "Checking Account", debit: amt, credit: 0, class_id: classId, memo: "Autopay " + s.method + " from " + s.tenant },
          { account_id: "1100", account_name: "Accounts Receivable", debit: 0, credit: amt, class_id: classId, memo: "AR settlement — " + s.tenant },
        ]
      });
    } else {
      await autoPostJournalEntry({ companyId, date: today, description: "Autopay — " + s.tenant + " — " + s.property, reference: "APAY-" + Date.now(), property: s.property,
        lines: [
          { account_id: "1000", account_name: "Checking Account", debit: amt, credit: 0, class_id: classId, memo: "Autopay " + s.method + " from " + s.tenant },
          { account_id: "4000", account_name: "Rental Income", debit: 0, credit: amt, class_id: classId, memo: s.tenant + " — " + s.property },
        ]
      });
    }
    logAudit("create", "payments", "Autopay: $" + s.amount + " from " + s.tenant + " at " + s.property, "", userProfile?.email, userRole, companyId);
    addNotification("\ud83d\udcb3", "Autopay $" + s.amount + " processed for " + s.tenant);

    // Update tenant balance and create ledger entry
    const { data: tenantRow } = await supabase.from("tenants").select("id, balance").eq("name", s.tenant).eq("company_id", companyId || "sandbox-llc").maybeSingle();
    if (tenantRow) {
      try {
        await supabase.rpc("update_tenant_balance", { p_tenant_id: tenantRow.id, p_amount_change: -amt });
      } catch {
        await supabase.from("tenants").update({ balance: safeNum(tenantRow.balance) - amt }).eq("company_id", companyId || "sandbox-llc").eq("id", tenantRow.id); // balance update (unchecked ok — RPC primary)
      }
      await safeLedgerInsert({ company_id: companyId || "sandbox-llc",
        tenant: s.tenant, property: s.property,
        date: today, description: "Autopay payment (" + s.method + ")",
        amount: -amt, type: "payment", balance: safeNum(tenantRow.balance) - amt,
      });
    }

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
          <h2 className="text-xl font-bold text-gray-800">Autopay & Recurring Rent</h2>
          <p className="text-xs text-gray-400 mt-0.5">Set recurring schedules per tenant with custom start and end dates</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">+ New Schedule</button>
      </div>
      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-5">
          <h3 className="font-semibold text-gray-700 mb-3">New Autopay Schedule</h3>
          <div className="grid grid-cols-2 gap-3">
            <select value={form.tenant} onChange={e => { const t = tenants.find(t => t.name === e.target.value); setForm({ ...form, tenant: e.target.value, property: t?.property || "", amount: t?.rent || "" }); }} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              <option value="">Select tenant...</option>
              {tenants.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
            </select>
            <PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} className="flex-1" companyId={companyId} />
            <input placeholder="Amount ($)" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <select value={form.method} onChange={e => setForm({ ...form, method: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              {["ACH", "card", "cash", "check"].map(m => <option key={m}>{m}</option>)}
            </select>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Day of Month</label>
              <select value={form.day_of_month} onChange={e => setForm({ ...form, day_of_month: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
                {Array.from({ length: 28 }, (_, i) => i + 1).map(d => <option key={d} value={String(d)}>{d}{d === 1 ? "st" : d === 2 ? "nd" : d === 3 ? "rd" : "th"}</option>)}
              </select>
            </div>
            <select value={form.frequency} onChange={e => setForm({ ...form, frequency: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              <option value="monthly">Monthly</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Bi-Weekly</option>
            </select>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Start Date</label>
              <input type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">End Date (optional)</label>
              <input type="date" value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={saveSchedule} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">Save Schedule</button>
            <button onClick={() => setShowForm(false)} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg">Cancel</button>
          </div>
        </div>
      )}
      <div className="space-y-3">
        {schedules.map(s => (
          <div key={s.id} className={`bg-white rounded-xl border shadow-sm p-4 ${s.active ? "border-gray-100" : "border-gray-200 opacity-60"}`}>
            <div className="flex justify-between items-start">
              <div>
                <div className="font-semibold text-gray-800">{s.tenant}</div>
                <div className="text-xs text-gray-400">{s.property}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${s.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>{s.active ? "Active" : "Paused"}</span>
                <span className="text-lg font-bold text-gray-800">${s.amount}</span>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
              <div><span className="text-gray-400">Frequency</span><div className="font-semibold text-gray-700 capitalize">{s.frequency}</div></div>
              <div><span className="text-gray-400">Day</span><div className="font-semibold text-gray-700">{s.day_of_month}{s.day_of_month === "1" ? "st" : s.day_of_month === "2" ? "nd" : s.day_of_month === "3" ? "rd" : "th"} of month</div></div>
              <div><span className="text-gray-400">Start</span><div className="font-semibold text-gray-700">{s.start_date}</div></div>
              <div><span className="text-gray-400">End</span><div className="font-semibold text-gray-700">{s.end_date || "Ongoing"}</div></div>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <div className="text-xs text-indigo-600 font-medium">Next due: {nextDue(s)}</div>
              <div className="flex gap-2">
                <button onClick={() => runNow(s)} className="text-xs text-green-600 border border-green-200 px-3 py-1 rounded-lg hover:bg-green-50">▶ Run Now</button>
                <button onClick={() => toggleActive(s)} className={`text-xs border px-3 py-1 rounded-lg ${s.active ? "text-orange-500 border-orange-200 hover:bg-orange-50" : "text-green-600 border-green-200 hover:bg-green-50"}`}>{s.active ? "⏸ Pause" : "▶ Resume"}</button>
                <button onClick={() => deleteSchedule(s.id, s.tenant)} className="text-xs text-red-500 border border-red-200 px-3 py-1 rounded-lg hover:bg-red-50">🗑️</button>
              </div>
            </div>
          </div>
        ))}
        {schedules.length === 0 && <div className="text-center py-12 text-gray-400">No autopay schedules yet. Create one above.</div>}
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

  useEffect(() => { fetchData(); }, []);

  async function fetchData() {
    try {
      const [r, p, t] = await Promise.all([
        supabase.from("late_fee_rules").select("*").eq("company_id", companyId || "sandbox-llc"),
        supabase.from("payments").select("*").eq("company_id", companyId || "sandbox-llc").eq("status", "unpaid"),
        supabase.from("tenants").select("*").eq("company_id", companyId || "sandbox-llc"),
      ]);
      setRules(r.data || []);
      setTenants(t.data || []);
      const today = new Date();
      const overdue = (p.data || []).filter(pay => pay.date && Math.floor((today - parseLocalDate(pay.date)) / 86400000) > 0)
        .map(pay => ({ ...pay, daysLate: Math.floor((today - parseLocalDate(pay.date)) / 86400000) }));
      setFlagged(overdue);
    } catch {
      setRules([]);
      setTenants([]);
      setFlagged([]);
    }
    setLoading(false);
  }

  async function saveRule() {
    if (!form.grace_days || !form.fee_amount) { alert("Please fill all fields."); return; }
    if (isNaN(Number(form.grace_days)) || Number(form.grace_days) < 0) { alert("Grace days must be a valid number."); return; }
    if (isNaN(Number(form.fee_amount)) || Number(form.fee_amount) <= 0) { alert("Fee amount must be a positive number."); return; }
    const { error } = await supabase.from("late_fee_rules").insert([{ company_id: companyId || "sandbox-llc", ...form, grace_days: Number(form.grace_days), fee_amount: Number(form.fee_amount) }]);
    if (error) { alert("Error: " + error.message); return; }
    addNotification("⚠️", `Late fee rule "${form.name}" created`);
    setShowForm(false);
    fetchData();
  }

  async function applyLateFee(payment, rule) {
    // Duplicate guard: check if late fee already applied for this tenant this month
    const thisMonth = formatLocalDate(new Date()).slice(0, 7);
    const { data: existingFee } = await supabase.from("ledger_entries").select("id")
      .eq("company_id", companyId || "sandbox-llc").eq("tenant", payment.tenant)
      .eq("property", payment.property).eq("type", "late_fee").gte("date", thisMonth + "-01").limit(1);
    if (existingFee && existingFee.length > 0) {
      console.warn("Late fee already applied for " + payment.tenant + " this month");
      return;
    }
    const tenant = tenants.find(t => t.name === payment.tenant);
    const feeAmount = rule.fee_type === "flat" ? rule.fee_amount : Math.round((tenant?.rent || payment.amount) * rule.fee_amount / 100);
    if (tenant) {
      const newBalance = safeNum(tenant.balance) + feeAmount;
      await safeLedgerInsert({ company_id: companyId || "sandbox-llc", tenant: payment.tenant, property: payment.property, date: formatLocalDate(new Date()), description: `Late fee — ${payment.daysLate} days overdue`, amount: feeAmount, type: "late_fee", balance: newBalance });
      // Atomic balance update (prevents drift from concurrent writes)
      try {
        await supabase.rpc("update_tenant_balance", { p_tenant_id: tenant.id, p_amount_change: feeAmount });
      } catch {
        await supabase.from("tenants").update({ balance: newBalance }).eq("company_id", companyId || "sandbox-llc").eq("id", tenant.id); // balance update (unchecked ok — RPC primary)
      }
    }
    addNotification("⚠️", `Late fee $${feeAmount} applied to ${payment.tenant}`);
    // AUTO-POST TO ACCOUNTING: DR Accounts Receivable, CR Late Fee Income
    const classId = await getPropertyClassId(payment.property, companyId);
    if (feeAmount > 0) {
      await autoPostJournalEntry({
        companyId,
        date: formatLocalDate(new Date()),
        description: "Late fee - " + payment.tenant + " - " + payment.property,
        reference: "LATE-" + Date.now(),
        property: payment.property,
        lines: [
          { account_id: "1100", account_name: "Accounts Receivable", debit: feeAmount, credit: 0, class_id: classId, memo: "Late fee: " + payment.tenant },
          { account_id: "4010", account_name: "Late Fee Income", debit: 0, credit: feeAmount, class_id: classId, memo: payment.daysLate + " days overdue" },
        ]
      });
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
          <h2 className="text-xl font-bold text-gray-800">Late Fee Automation</h2>
          <p className="text-xs text-gray-400 mt-0.5">Auto-flag overdue payments and apply fees after grace period</p>
        </div>
        <div className="flex gap-2">
          {afterGrace.length > 0 && <button onClick={applyAllFees} className="bg-red-500 text-white text-sm px-4 py-2 rounded-lg hover:bg-red-600">⚡ Apply All ({afterGrace.length})</button>}
          <button onClick={() => setShowForm(!showForm)} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">+ New Rule</button>
        </div>
      </div>
      {rules.length > 0 && (
        <div className="mb-5 space-y-2">
          <h3 className="font-semibold text-gray-700 text-sm">Active Rules</h3>
          {rules.map(r => (
            <div key={r.id} className="bg-indigo-50 border border-indigo-100 rounded-xl px-4 py-3 flex justify-between items-center">
              <div>
                <div className="font-semibold text-indigo-800 text-sm">{r.name}</div>
                <div className="text-xs text-indigo-500">{r.grace_days} day grace · {r.fee_type === "flat" ? `$${r.fee_amount} flat` : `${r.fee_amount}% of rent`}</div>
              </div>
              <button onClick={async () => { if(!window.confirm("Delete this late fee rule?"))return; await supabase.from("late_fee_rules").delete().eq("id", r.id).eq("company_id", companyId || "sandbox-llc"); fetchData(); }} className="text-xs text-red-400 hover:text-red-600">Delete</button>
            </div>
          ))}
        </div>
      )}
      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-5">
          <h3 className="font-semibold text-gray-700 mb-3">New Late Fee Rule</h3>
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Rule name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm col-span-2" />
            <div><label className="text-xs text-gray-500 mb-1 block">Grace Period (days)</label><input type="number" value={form.grace_days} onChange={e => setForm({ ...form, grace_days: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-gray-500 mb-1 block">Fee Type</label><select value={form.fee_type} onChange={e => setForm({ ...form, fee_type: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"><option value="flat">Flat ($)</option><option value="percent">Percent (%)</option></select></div>
            <div><label className="text-xs text-gray-500 mb-1 block">{form.fee_type === "flat" ? "Fee Amount ($)" : "Percentage (%)"}</label><input type="number" value={form.fee_amount} onChange={e => setForm({ ...form, fee_amount: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={saveRule} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">Save Rule</button>
            <button onClick={() => setShowForm(false)} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg">Cancel</button>
          </div>
        </div>
      )}
      <div className="grid grid-cols-3 gap-3 mb-5">
        <div className="bg-white rounded-xl border border-gray-100 p-4 text-center"><div className="text-2xl font-bold text-orange-500">{flagged.length}</div><div className="text-xs text-gray-400 mt-1">Overdue</div></div>
        <div className="bg-white rounded-xl border border-gray-100 p-4 text-center"><div className="text-2xl font-bold text-red-500">{afterGrace.length}</div><div className="text-xs text-gray-400 mt-1">Past Grace Period</div></div>
        <div className="bg-white rounded-xl border border-gray-100 p-4 text-center"><div className="text-2xl font-bold text-gray-700">${flagged.reduce((s, p) => s + safeNum(p.amount), 0).toLocaleString()}</div><div className="text-xs text-gray-400 mt-1">Total Overdue</div></div>
      </div>
      <div className="space-y-3">
        {flagged.map(p => {
          const pastGrace = rules.length > 0 && p.daysLate > rules[0]?.grace_days;
          return (
            <div key={p.id} className={`bg-white rounded-xl border shadow-sm p-4 ${pastGrace ? "border-red-200" : "border-orange-100"}`}>
              <div className="flex justify-between items-start">
                <div><div className="font-semibold text-gray-800">{p.tenant}</div><div className="text-xs text-gray-400">{p.property}</div></div>
                <div className="text-right"><div className="font-bold text-red-500">${p.amount}</div><div className={`text-xs font-semibold ${pastGrace ? "text-red-500" : "text-orange-500"}`}>{p.daysLate} days late</div></div>
              </div>
              <div className="mt-3 flex gap-2">
                {pastGrace && rules.length > 0 && <button onClick={() => applyLateFee(p, rules[0])} className="text-xs text-red-600 border border-red-200 px-3 py-1 rounded-lg hover:bg-red-50">Apply ${rules[0].fee_type === "flat" ? rules[0].fee_amount : Math.round(p.amount * rules[0].fee_amount / 100)} Late Fee</button>}
                {!pastGrace && <span className="text-xs text-orange-500 bg-orange-50 px-3 py-1 rounded-lg">Within grace period</span>}
              </div>
            </div>
          );
        })}
        {flagged.length === 0 && <div className="text-center py-10 text-gray-400">🎉 No overdue payments!</div>}
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
  const [maintPhoto, setMaintPhoto] = useState(null);

  useEffect(() => {
    async function fetchData() {
      const email = currentUser?.email;
      if (!email) { setLoading(false); return; }
      const { data: tenant } = await supabase.from("tenants").select("*").eq("company_id", companyId || "sandbox-llc").ilike("email", email).maybeSingle();
      if (!tenant) { setLoading(false); return; }
      setTenantData(tenant);
      setPaymentAmount(String(tenant.rent || ""));
      const [l, m, p, w, d] = await Promise.all([
        supabase.from("ledger_entries").select("*").eq("company_id", companyId || "sandbox-llc").eq("tenant", tenant.name).order("date", { ascending: false }),
        supabase.from("messages").select("*").eq("company_id", companyId || "sandbox-llc").eq("tenant", tenant.name).order("created_at", { ascending: true }),
        supabase.from("payments").select("*").eq("company_id", companyId || "sandbox-llc").eq("tenant", tenant.name).order("date", { ascending: false }),
        supabase.from("work_orders").select("*").eq("company_id", companyId || "sandbox-llc").eq("tenant", tenant.name).order("created_at", { ascending: false }),
        supabase.from("documents").select("*").eq("company_id", companyId || "sandbox-llc").eq("tenant", tenant.name).order("uploaded_at", { ascending: false }),
      ]);
      setLedger(l.data || []);
      setMessages(m.data || []);
      setPayments(p.data || []);
      setWorkOrders(w.data || []);
      setDocuments(d.data || []);
      setLoading(false);
    }
    fetchData();
  }, [currentUser]);

  async function refreshData() {
    if (!tenantData) return;
    const [l, p, w, m] = await Promise.all([
      supabase.from("ledger_entries").select("*").eq("company_id", companyId || "sandbox-llc").eq("tenant", tenantData.name).order("date", { ascending: false }),
      supabase.from("payments").select("*").eq("company_id", companyId || "sandbox-llc").eq("tenant", tenantData.name).order("date", { ascending: false }),
      supabase.from("work_orders").select("*").eq("company_id", companyId || "sandbox-llc").eq("tenant", tenantData.name).order("created_at", { ascending: false }),
      supabase.from("messages").select("*").eq("company_id", companyId || "sandbox-llc").eq("tenant", tenantData.name).order("created_at", { ascending: true }),
    ]);
    setLedger(l.data || []);
    setPayments(p.data || []);
    setWorkOrders(w.data || []);
    setMessages(m.data || []);
    // Refresh tenant balance
    const { data: t } = await supabase.from("tenants").select("*").eq("company_id", companyId || "sandbox-llc").ilike("email", currentUser?.email || "").maybeSingle();
    if (t) setTenantData(t);
  }

  // ---- STRIPE PAYMENT ----
  async function handleStripePayment() {
    if (!paymentAmount || isNaN(Number(paymentAmount)) || Number(paymentAmount) <= 0) {
      alert("Please enter a valid payment amount."); return;
    }
    if (Number(paymentAmount) > safeNum(tenantData.balance) * 2) {
      if (!window.confirm("Payment amount ($" + paymentAmount + ") is significantly more than your balance ($" + safeNum(tenantData.balance).toFixed(2) + "). Continue?")) return;
    }
    setPaymentProcessing(true);
    try {
      // Call Stripe Checkout via serverless function or edge function
      // For now, we create a payment intent simulation and record the payment
      // In production, replace this with actual Stripe API call to your backend
      const amt = Number(paymentAmount);
      const today = formatLocalDate(new Date());
      // Use dedicated tenant payment RPC (atomic, role-validated)
      try {
        const { data: payResult, error: payErr } = await supabase.rpc("tenant_make_payment", {
          p_company_id: companyId || "sandbox-llc",
          p_tenant_id: tenantData.id,
          p_amount: amt,
          p_method: "stripe",
        });
        if (payErr) throw new Error(payErr.message);
      } catch (rpcE) {
        // Fallback: direct insert (for when RPC not deployed)
        const { error: payErr } = await supabase.from("payments").insert([{ company_id: companyId || "sandbox-llc",
          tenant: tenantData.name, property: tenantData.property, amount: amt,
          type: "rent", method: "stripe", status: "paid", date: today,
        }]);
        if (payErr) throw new Error("Failed to record payment: " + payErr.message);
        await supabase.from("tenants").update({ balance: safeNum(tenantData.balance) - amt }).eq("company_id", companyId || "sandbox-llc").eq("id", tenantData.id); // balance update (unchecked ok — RPC primary)
        await safeLedgerInsert({ company_id: companyId || "sandbox-llc",
          tenant: tenantData.name, property: tenantData.property, date: today,
          description: "Rent payment (online)", amount: -amt, type: "payment", balance: 0,
        });
      }
      const newBalance = safeNum(tenantData.balance) - amt;
      // Auto-post to accounting
      const classId = await getPropertyClassId(tenantData.property, companyId);
      const month = today.slice(0, 7);
      let hasAccrual = false;
      const { data: accrualJEs } = await supabase.from("acct_journal_entries").select("id").eq("company_id", companyId || "sandbox-llc").like("reference", "ACCR-" + month + "%").neq("status", "voided");
      if (accrualJEs && accrualJEs.length > 0) {
        for (const je of accrualJEs) {
          const { data: jLines } = await supabase.from("acct_journal_lines").select("memo").eq("journal_entry_id", je.id);
          if (jLines && jLines.some(l => l.memo && l.memo.includes(tenantData.name))) { hasAccrual = true; break; }
        }
      }
      if (hasAccrual) {
        await autoPostJournalEntry({ companyId, date: today, description: "Online payment — " + tenantData.name + " — " + tenantData.property + " (settling AR)", reference: "SPAY-" + Date.now(), property: tenantData.property,
          lines: [
            { account_id: "1000", account_name: "Checking Account", debit: amt, credit: 0, class_id: classId, memo: "Stripe from " + tenantData.name },
            { account_id: "1100", account_name: "Accounts Receivable", debit: 0, credit: amt, class_id: classId, memo: "AR settlement — " + tenantData.name },
          ]
        });
      } else {
        await autoPostJournalEntry({ companyId, date: today, description: "Online rent payment — " + tenantData.name + " — " + tenantData.property, reference: "SPAY-" + Date.now(), property: tenantData.property,
          lines: [
            { account_id: "1000", account_name: "Checking Account", debit: amt, credit: 0, class_id: classId, memo: "Stripe from " + tenantData.name },
            { account_id: "4000", account_name: "Rental Income", debit: 0, credit: amt, class_id: classId, memo: tenantData.name + " — " + tenantData.property },
          ]
        });
      }
      logAudit("create", "payments", "Online payment: $" + amt + " from " + tenantData.name, "", currentUser?.email, "tenant", companyId);
      setPaymentSuccess(true);
      setTimeout(() => setPaymentSuccess(false), 5000);
      await refreshData();
    } catch (e) {
      alert("Payment failed: " + e.message);
    }
    setPaymentProcessing(false);
  }

  // ---- MAINTENANCE REQUEST ----
  async function submitMaintenanceRequest() {
    if (!maintForm.issue.trim()) { alert("Please describe the issue."); return; }
    let photoUrl = null;
    if (maintPhoto) {
      const fileName = Date.now() + "-" + maintPhoto.name;
      const { error: uploadErr } = await supabase.storage.from("documents").upload("maintenance/" + fileName, maintPhoto);
      if (!uploadErr) {
        const { data: urlData } = supabase.storage.from("documents").getPublicUrl("maintenance/" + fileName);
        photoUrl = urlData?.publicUrl;
      }
    }
    const { error } = await supabase.from("work_orders").insert([{ company_id: companyId || "sandbox-llc",
      property: tenantData.property,
      tenant: tenantData.name,
      issue: maintForm.issue,
      priority: maintForm.priority,
      status: "open",
      notes: maintForm.notes + (photoUrl ? "\n[Photo: " + photoUrl + "]" : ""),
      cost: 0,
    }]);
    if (error) { alert("Error submitting request: " + error.message); return; }
    logAudit("create", "maintenance", "Tenant submitted: " + maintForm.issue, "", currentUser?.email, "tenant", companyId);
    setMaintForm({ issue: "", priority: "normal", notes: "" });
    setMaintPhoto(null);
    setShowMaintForm(false);
    await refreshData();
  }

  // ---- MESSAGING ----
  async function sendMessage() {
    if (!newMessage.trim() || !tenantData) return;
    await supabase.from("messages").insert([{ company_id: companyId || "sandbox-llc", tenant: tenantData.name, property: tenantData.property, sender: tenantData.name, message: newMessage, read: false }]);
    setNewMessage("");
    const { data } = await supabase.from("messages").select("*").eq("company_id", companyId || "sandbox-llc").eq("tenant", tenantData.name).order("created_at", { ascending: true });
    setMessages(data || []);
  }

  if (loading) return <Spinner />;
  if (!tenantData) return (
    <div className="text-center py-20">
      <div className="text-5xl mb-4">🏠</div>
      <div className="text-gray-600 font-semibold text-lg">No tenant account linked to this email.</div>
      <div className="text-gray-400 text-sm mt-2">Contact your property manager to get access.</div>
      <div className="text-xs text-gray-300 mt-4">{currentUser?.email}</div>
    </div>
  );

  const tabs = [
    ["overview", "\ud83c\udfe0 Overview"],
    ["pay", "\ud83d\udcb3 Pay Rent"],
    ["history", "📋 History"],
    ["maintenance", "🔧 Maintenance"],
    ["documents", "\ud83d\udcc1 Documents"],
    ["messages", "\ud83d\udcac Messages"],
  ];

  return (
    <div>
      {/* Tenant Header */}
      <div className="bg-gradient-to-r from-indigo-600 to-indigo-800 rounded-xl p-5 mb-5 text-white">
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
      <div className="flex gap-1 mb-5 overflow-x-auto pb-1 border-b border-gray-100">
        {tabs.map(([id, label]) => (
          <button key={id} onClick={() => setActiveTab(id)} className={"px-3 py-2 text-xs font-medium border-b-2 whitespace-nowrap transition-colors " + (activeTab === id ? "border-indigo-600 text-indigo-700" : "border-transparent text-gray-500 hover:text-gray-700")}>{label}</button>
        ))}
      </div>

      {/* ---- OVERVIEW TAB ---- */}
      {activeTab === "overview" && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <h3 className="font-semibold text-gray-700 mb-3">Lease Details</h3>
            {[["Status", (tenantData.lease_status || "active")], ["Property", tenantData.property], ["Move-in", tenantData.move_in || "—"], ["Lease End", tenantData.move_out || "—"], ["Monthly Rent", "$" + safeNum(tenantData.rent).toLocaleString()], ["Email", tenantData.email || "—"], ["Phone", tenantData.phone || "—"]].map(([l, v]) => (
              <div key={l} className="flex justify-between py-2 border-b border-gray-50 text-sm last:border-0"><span className="text-gray-400">{l}</span><span className="font-medium text-gray-800 capitalize">{v}</span></div>
            ))}
          </div>
          {safeNum(tenantData.balance) > 0 && (
            <div className="bg-red-50 border border-red-100 rounded-xl p-4 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-red-800">Balance Due: ${safeNum(tenantData.balance).toLocaleString()}</div>
                <div className="text-xs text-red-600">Please make a payment to avoid late fees.</div>
              </div>
              <button onClick={() => setActiveTab("pay")} className="bg-red-600 text-white text-xs px-4 py-2 rounded-lg hover:bg-red-700">Pay Now</button>
            </div>
          )}
          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <h3 className="font-semibold text-gray-700 mb-3">Recent Activity</h3>
            {payments.slice(0, 3).map(p => (
              <div key={p.id} className="flex justify-between py-2 border-b border-gray-50 last:border-0 text-sm">
                <div><span className="text-green-600 font-medium">Payment</span> <span className="text-gray-400">— {p.date}</span></div>
                <span className="font-semibold text-gray-800">${safeNum(p.amount).toLocaleString()}</span>
              </div>
            ))}
            {workOrders.slice(0, 2).map(w => (
              <div key={w.id} className="flex justify-between py-2 border-b border-gray-50 last:border-0 text-sm">
                <div><span className="text-orange-600 font-medium">Maintenance</span> <span className="text-gray-400">— {w.issue}</span></div>
                <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (w.status === "completed" ? "bg-green-100 text-green-700" : w.status === "in_progress" ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700")}>{w.status}</span>
              </div>
            ))}
            {payments.length === 0 && workOrders.length === 0 && <div className="text-center py-4 text-gray-400 text-sm">No recent activity</div>}
          </div>
        </div>
      )}

      {/* ---- PAY RENT TAB ---- */}
      {activeTab === "pay" && (
        <div className="max-w-md mx-auto">
          {paymentSuccess && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 mb-4 text-center">
              <div className="text-2xl mb-1">✅</div>
              <div className="text-green-800 font-semibold">Payment Successful!</div>
              <div className="text-green-600 text-sm">Your payment has been recorded and your balance updated.</div>
            </div>
          )}
          <div className="bg-white rounded-xl border border-gray-100 p-6">
            <h3 className="font-semibold text-gray-800 text-lg mb-1">Make a Payment</h3>
            <p className="text-sm text-gray-400 mb-5">Pay securely with Stripe</p>
            <div className="mb-4">
              <label className="text-xs text-gray-500 mb-1 block">Current Balance</label>
              <div className={"text-2xl font-bold " + (safeNum(tenantData.balance) > 0 ? "text-red-600" : "text-green-600")}>
                ${safeNum(tenantData.balance).toLocaleString()}
              </div>
            </div>
            <div className="mb-4">
              <label className="text-xs text-gray-500 mb-1 block">Payment Amount</label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-gray-400">$</span>
                <input type="number" value={paymentAmount} onChange={e => setPaymentAmount(e.target.value)} className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2.5 text-lg font-mono" placeholder="0.00" />
              </div>
              <div className="flex gap-2 mt-2">
                <button onClick={() => setPaymentAmount(String(tenantData.rent || 0))} className="text-xs bg-gray-100 text-gray-600 px-3 py-1 rounded-lg hover:bg-gray-200">Full Rent (${safeNum(tenantData.rent)})</button>
                {safeNum(tenantData.balance) > 0 && <button onClick={() => setPaymentAmount(String(tenantData.balance))} className="text-xs bg-red-50 text-red-600 px-3 py-1 rounded-lg hover:bg-red-100">Full Balance (${safeNum(tenantData.balance)})</button>}
              </div>
            </div>
            <div className="mb-4 p-3 bg-gray-50 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-8 h-5 bg-gradient-to-r from-indigo-600 to-purple-600 rounded text-white text-xs flex items-center justify-center font-bold">S</div>
                <span className="text-sm text-gray-600">Powered by Stripe</span>
              </div>
              <div className="text-xs text-gray-400">Secure payment processing. Your card information is encrypted and never stored on our servers.</div>
            </div>
            <button onClick={handleStripePayment} disabled={paymentProcessing} className={"w-full py-3 rounded-xl text-white font-semibold text-sm transition-all " + (paymentProcessing ? "bg-gray-400 cursor-not-allowed" : "bg-indigo-600 hover:bg-indigo-700 active:scale-98")}>
              {paymentProcessing ? "Processing..." : "Pay $" + (paymentAmount || "0")}
            </button>
            <div className="text-xs text-gray-400 text-center mt-3">A receipt will be generated automatically.</div>
          </div>
        </div>
      )}

      {/* ---- PAYMENT HISTORY TAB ---- */}
      {activeTab === "history" && (
        <div>
          <h3 className="font-semibold text-gray-700 mb-3">Payment History</h3>
          <div className="space-y-2">
            {payments.map(p => (
              <div key={p.id} className="bg-white border border-gray-100 rounded-xl px-4 py-3 flex justify-between items-center">
                <div>
                  <div className="text-sm font-medium text-gray-800">{p.type === "rent" ? "Rent Payment" : p.type}</div>
                  <div className="text-xs text-gray-400">{p.date} · {p.method}</div>
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
            {payments.length === 0 && <div className="text-center py-8 text-gray-400">No payments recorded yet</div>}
          </div>
          {/* Ledger / Account Balance */}
          <h3 className="font-semibold text-gray-700 mt-6 mb-3">Account Ledger</h3>
          <div className="space-y-2">
            {ledger.map(e => (
              <div key={e.id} className="bg-white border border-gray-100 rounded-xl px-4 py-3">
                <div className="flex justify-between">
                  <div><div className="text-sm font-medium text-gray-800">{e.description}</div><div className="text-xs text-gray-400">{e.date}</div></div>
                  <div className="text-right">
                    <div className={"text-sm font-bold " + (e.amount > 0 ? "text-red-500" : "text-green-600")}>{e.amount > 0 ? "+$" + e.amount : "-$" + Math.abs(e.amount)}</div>
                    <div className="text-xs text-gray-400">Bal: ${e.balance}</div>
                  </div>
                </div>
              </div>
            ))}
            {ledger.length === 0 && <div className="text-center py-8 text-gray-400">No ledger entries yet</div>}
          </div>
        </div>
      )}

      {/* ---- MAINTENANCE TAB ---- */}
      {activeTab === "maintenance" && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-semibold text-gray-700">Maintenance Requests</h3>
            <button onClick={() => setShowMaintForm(!showMaintForm)} className="bg-indigo-600 text-white text-xs px-4 py-2 rounded-lg hover:bg-indigo-700">
              {showMaintForm ? "Cancel" : "+ New Request"}
            </button>
          </div>
          {showMaintForm && (
            <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
              <h4 className="font-medium text-gray-700 mb-3">Submit a Maintenance Request</h4>
              <input placeholder="Describe the issue *" value={maintForm.issue} onChange={e => setMaintForm({...maintForm, issue: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-3" />
              <select value={maintForm.priority} onChange={e => setMaintForm({...maintForm, priority: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-3">
                <option value="normal">Normal Priority</option>
                <option value="urgent">Urgent</option>
                <option value="emergency">Emergency</option>
              </select>
              <textarea placeholder="Additional details..." value={maintForm.notes} onChange={e => setMaintForm({...maintForm, notes: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-3" rows={3} />
              <div className="mb-3">
                <label className="text-xs text-gray-500 mb-1 block">Attach Photo (optional)</label>
                <input type="file" accept="image/*" onChange={e => setMaintPhoto(e.target.files[0])} className="text-sm" />
              </div>
              <button onClick={submitMaintenanceRequest} className="bg-indigo-600 text-white text-sm px-6 py-2 rounded-lg hover:bg-indigo-700">Submit Request</button>
            </div>
          )}
          <div className="space-y-2">
            {workOrders.map(w => (
              <div key={w.id} className="bg-white border border-gray-100 rounded-xl px-4 py-3">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="text-sm font-medium text-gray-800">{w.issue}</div>
                    <div className="text-xs text-gray-400">{w.property} · {new Date(w.created_at).toLocaleDateString()}</div>
                    {w.notes && <div className="text-xs text-gray-500 mt-1">{w.notes}</div>}
                  </div>
                  <div className="text-right">
                    <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (w.status === "completed" ? "bg-green-100 text-green-700" : w.status === "in_progress" ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700")}>{w.status.replace("_", " ")}</span>
                    <div className={"text-xs mt-1 " + (w.priority === "emergency" ? "text-red-500 font-bold" : w.priority === "urgent" ? "text-orange-500" : "text-gray-400")}>{w.priority}</div>
                  </div>
                </div>
              </div>
            ))}
            {workOrders.length === 0 && <div className="text-center py-8 text-gray-400">No maintenance requests</div>}
          </div>
        </div>
      )}

      {/* ---- DOCUMENTS TAB ---- */}
      {activeTab === "documents" && (
        <div>
          <h3 className="font-semibold text-gray-700 mb-3">My Documents</h3>
          <div className="space-y-2">
            {documents.map(d => (
              <div key={d.id} className="bg-white border border-gray-100 rounded-xl px-4 py-3 flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-indigo-50 rounded-lg flex items-center justify-center text-indigo-600 text-lg">
                    {d.type === "lease" ? "\ud83d\udcdc" : d.type === "notice" ? "\ud83d\udce8" : "📄"}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-gray-800">{d.name || d.file_name}</div>
                    <div className="text-xs text-gray-400">{d.type || "Document"} · {new Date(d.uploaded_at).toLocaleDateString()}</div>
                  </div>
                </div>
                {d.url && <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-600 border border-indigo-200 px-3 py-1 rounded-lg hover:bg-indigo-50">View</a>}
              </div>
            ))}
            {documents.length === 0 && <div className="text-center py-8 text-gray-400">No documents uploaded yet</div>}
          </div>
        </div>
      )}

      {/* ---- MESSAGES TAB ---- */}
      {activeTab === "messages" && (
        <div className="bg-white rounded-xl border border-gray-100">
          <div className="p-4 space-y-3 max-h-96 overflow-y-auto">
            {messages.map(m => (
              <div key={m.id} className={"flex " + (m.sender !== tenantData.name ? "justify-start" : "justify-end")}>
                <div className={"max-w-xs rounded-2xl px-4 py-2.5 " + (m.sender !== tenantData.name ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-800")}>
                  <div className="text-sm">{m.message}</div>
                  <div className={"text-xs mt-1 " + (m.sender !== tenantData.name ? "text-indigo-200" : "text-gray-400")}>{m.sender} · {new Date(m.created_at).toLocaleDateString()}</div>
                </div>
              </div>
            ))}
            {messages.length === 0 && <div className="text-center py-6 text-gray-400 text-sm">No messages yet. Send a message to your property manager below.</div>}
          </div>
          <div className="p-3 border-t border-gray-100 flex gap-2">
            <input value={newMessage} onChange={e => setNewMessage(e.target.value)} onKeyDown={e => e.key === "Enter" && sendMessage()} placeholder="Message your property manager..." className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm" />
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

  useEffect(() => { fetchUsers(); }, []);

  async function fetchUsers() {
    const { data } = await supabase.from("app_users").select("*").eq("company_id", companyId || "sandbox-llc").order("created_at", { ascending: false });
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
    if (!form.email.trim()) { alert("Email is required."); return; }
    if (!form.name.trim()) { alert("Name is required."); return; }
    if (customPages.length === 0) { alert("Please select at least one module."); return; }

    const payload = {
      email: form.email,
      role: form.role,
      name: form.name,
      custom_pages: JSON.stringify(customPages),
      company_id: companyId || "sandbox-llc",
    };

    if (editingUser) {
      const { error } = await supabase.from("app_users").update({ email: payload.email, role: payload.role, name: payload.name, custom_pages: payload.custom_pages, company_id: payload.company_id }).eq("id", editingUser.id);
      if (error) { alert("Error: " + error.message); return; }
      // Also update company_members
      await supabase.from("company_members").upsert([{ company_id: companyId || "sandbox-llc", user_email: (form.email || "").toLowerCase(), user_name: form.name, role: form.role, status: "active", custom_pages: JSON.stringify(customPages) }], { onConflict: "company_id,user_email" });
      addNotification("👥", `${form.name}'s access updated`);
    } else {
      const { error, data: newUser } = await supabase.from("app_users").insert([payload]).select();
      if (error) { alert("Error: " + error.message); return; }
      // Also add to company_members
      await supabase.from("company_members").upsert([{ company_id: companyId || "sandbox-llc", user_email: (form.email || "").toLowerCase(), user_name: form.name, role: form.role, status: "active", custom_pages: JSON.stringify(customPages) }], { onConflict: "company_id,user_email" });
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
  }

  async function removeUser(id, name, email) {
    if (!window.confirm(`Remove ${name}?`)) return;
    await supabase.from("app_users").delete().eq("id", id).eq("company_id", companyId || "sandbox-llc");
    // Also deactivate their company membership
    if (email) {
      await supabase.from("company_members").update({ status: "removed" }).eq("company_id", companyId || "sandbox-llc").eq("user_email", email.toLowerCase());
    }
    addNotification("👥", `${name} removed`);
    fetchUsers();
  }

  async function inviteUser(user) {
    if (!user.email) { alert("This user has no email address."); return; }
    const roleName = ROLES[user.role]?.label || user.role;
    if (!window.confirm(`Send login invite to ${user.name} (${user.email})?\n\nRole: ${roleName}\n\nThis will:\n1. Create their authentication account\n2. Send a magic link to their email\n3. They can log in and access their assigned modules`)) return;
    try {
      const { error: authErr } = await supabase.auth.signInWithOtp({
        email: user.email,
        options: { data: { name: user.name, role: user.role } }
      });
      if (authErr) {
        console.warn("Auth invite failed:", authErr.message);
      }
      // Ensure app_users entry exists with correct role
      // Insert only if no existing row — don't overwrite other company's data
      await supabase.from("app_users").upsert([{
        email: (user.email || "").toLowerCase(),
        name: user.name,
        role: user.role,
        company_id: companyId || "sandbox-llc",
        custom_pages: user.custom_pages || JSON.stringify(ROLES[user.role]?.pages || []),
      }], { onConflict: "email", ignoreDuplicates: true });
      // Ensure company_members entry
      await supabase.from("company_members").upsert([{
        company_id: companyId || "sandbox-llc", user_email: (user.email || "").toLowerCase(), user_name: user.name,
        role: user.role, status: "active", invited_by: "admin",
      }], { onConflict: "company_id,user_email" });
      addNotification("✉️", `Invite sent to ${user.name} (${roleName})`);
      logAudit("create", "team", "Invited " + user.name + " as " + roleName + ": " + user.email, user.id || "", "", "admin", companyId);
      alert(`Invite sent to ${user.email}!\n\nThey will receive a magic link to log in.\n\nIf they don't see it, they can use 'Forgot Password' on the login page to set their password.`);
    } catch (e) {
      alert("Error sending invite: " + e.message);
    }
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
          <h2 className="text-xl font-bold text-gray-800">Team & Role Management</h2>
          <p className="text-xs text-gray-400 mt-0.5">Add team members and choose exactly which modules they can access</p>
        </div>
        <button onClick={startAdd} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">+ Add User</button>
      </div>

      {/* Role legend */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-5">
        {Object.entries(ROLES).map(([key, r]) => (
          <div key={key} className="bg-white rounded-xl border border-gray-100 p-3 text-center">
            <div className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold text-white mb-1 ${r.color}`}>{r.label}</div>
            <div className="text-xs text-gray-400">{key === "admin" ? "Full access" : key === "tenant" ? "Portal only" : "Customizable"}</div>
          </div>
        ))}
      </div>

      {/* Add / Edit form */}
      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-5 mb-5">
          <h3 className="font-semibold text-gray-700 mb-4">{editingUser ? `Edit — ${editingUser.name}` : "Add Team Member"}</h3>

          {/* Basic info */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <input
              placeholder="Full name"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />
            <input
              placeholder="Email address"
              value={form.email}
              onChange={e => setForm({ ...form, email: e.target.value })}
              disabled={!!editingUser}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400"
            />
            <select
              value={form.role}
              onChange={e => handleRoleChange(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm col-span-2"
            >
              {Object.entries(ROLES).filter(([k]) => k !== "tenant").map(([key, r]) => (
                <option key={key} value={key}>{r.label}</option>
              ))}
            </select>
          </div>

          {/* Module picker — only shown for customizable roles */}
          {isCustomizable && (
            <div className="border border-gray-100 rounded-xl p-4 bg-gray-50">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold text-gray-700">Choose which modules this person can access</div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setCustomPages(ALL_NAV.map(n => n.id))}
                    className="text-xs text-indigo-600 hover:underline"
                  >Select all</button>
                  <span className="text-gray-300">|</span>
                  <button
                    onClick={() => setCustomPages([])}
                    className="text-xs text-gray-400 hover:underline"
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
                          : "bg-white border-gray-200 text-gray-600 hover:border-indigo-300"
                      }`}
                    >
                      <span className="text-base">{nav.icon}</span>
                      <span>{nav.label}</span>
                      {isOn && <span className="ml-auto text-indigo-200 text-xs">✓</span>}
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 text-xs text-gray-400">
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
            <button onClick={saveUser} className="bg-indigo-600 text-white text-sm px-5 py-2 rounded-lg hover:bg-indigo-700">
              {editingUser ? "Save Changes" : "Add User"}
            </button>
            <button onClick={() => { setShowForm(false); setEditingUser(null); }} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg">
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
            <div key={u.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold ${ROLES[u.role]?.color || "bg-gray-400"}`}>
                    {u.name?.[0]}
                  </div>
                  <div>
                    <div className="font-semibold text-gray-800 text-sm">{u.name}</div>
                    <div className="text-xs text-gray-400">{u.email}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-semibold text-white px-2 py-0.5 rounded-full ${ROLES[u.role]?.color || "bg-gray-400"}`}>
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
                <div className="mt-1 text-xs text-gray-400">Custom access · {effectivePages.length} modules</div>
              )}
            </div>
          );
        })}
        {users.length === 0 && (
          <div className="text-center py-10 text-gray-400">No team members added yet. Click + Add User to get started.</div>
        )}
      </div>
    </div>
  );
}

// ============ MAIN APP ============
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
  tenant_portal: TenantPortal,
  owner_portal: OwnerPortal,
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

  useEffect(() => { fetchLogs(); }, []);

  async function fetchLogs() {
    setLoading(true);
    const { data } = await supabase.from("audit_trail").select("*").eq("company_id", companyId || "sandbox-llc").order("created_at", { ascending: false }).limit(500);
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
      <h2 className="text-xl font-bold text-gray-800 mb-1">Audit Trail</h2>
      <p className="text-sm text-gray-500 mb-4">Complete activity log across all modules</p>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <select value={filterModule} onChange={e => { setFilterModule(e.target.value); setPage(0); }} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
          <option value="all">All Modules</option>
          {modules.map(m => <option key={m} value={m}>{moduleIcons[m] || "📌"} {m}</option>)}
        </select>
        <select value={filterAction} onChange={e => { setFilterAction(e.target.value); setPage(0); }} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
          <option value="all">All Actions</option>
          {actions.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <input placeholder="Filter by user email..." value={filterUser} onChange={e => { setFilterUser(e.target.value); setPage(0); }} className="border border-gray-200 rounded-lg px-3 py-2 text-sm flex-1 min-w-48" />
        <button onClick={fetchLogs} className="bg-gray-100 text-gray-600 text-sm px-3 py-2 rounded-lg hover:bg-gray-200">🔄 Refresh</button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <div className="bg-white rounded-xl border border-gray-100 p-3 text-center">
          <p className="text-lg font-bold text-gray-800">{filtered.length}</p>
          <p className="text-xs text-gray-500">Total Actions</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-3 text-center">
          <p className="text-lg font-bold text-gray-800">{users.length}</p>
          <p className="text-xs text-gray-500">Users Active</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-3 text-center">
          <p className="text-lg font-bold text-emerald-600">{filtered.filter(l => l.action === "create").length}</p>
          <p className="text-xs text-gray-500">Created</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-3 text-center">
          <p className="text-lg font-bold text-red-500">{filtered.filter(l => l.action === "delete").length}</p>
          <p className="text-xs text-gray-500">Deleted</p>
        </div>
      </div>

      {/* Log Table */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-400 uppercase">
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
              <tr key={log.id} className="border-t border-gray-50 hover:bg-gray-50/50">
                <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">{new Date(log.created_at).toLocaleString()}</td>
                <td className="px-4 py-2.5 text-gray-700 font-medium text-xs">{log.user_email}</td>
                <td className="px-4 py-2.5"><span className={`text-xs px-1.5 py-0.5 rounded-full ${log.user_role === "admin" ? "bg-indigo-100 text-indigo-700" : "bg-gray-100 text-gray-600"}`}>{log.user_role}</span></td>
                <td className="px-4 py-2.5 text-xs"><span className="flex items-center gap-1">{moduleIcons[log.module] || "📌"} {log.module}</span></td>
                <td className="px-4 py-2.5"><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${actionColors[log.action] || "bg-gray-100 text-gray-700"}`}>{log.action}</span></td>
                <td className="px-4 py-2.5 text-xs text-gray-600 max-w-xs truncate">{log.details}</td>
              </tr>
            ))}
            {paged.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No audit logs found</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-gray-400">Page {page + 1} of {totalPages} ({filtered.length} records)</span>
          <div className="flex gap-1">
            <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} className="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-lg disabled:opacity-30">← Prev</button>
            <button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1} className="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-lg disabled:opacity-30">Next →</button>
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
  const [joinSearch, setJoinSearch] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [joinMessage, setJoinMessage] = useState("");

  useEffect(() => { fetchCompanies(); }, []);

  async function fetchCompanies() {
    setLoading(true);
    const email = currentUser?.email;
    if (!email) { setLoading(false); return; }
    // Get all companies this user is an active member of
    const { data: memberships } = await supabase.from("company_members").select("company_id, role, status").eq("user_email", email);
    const active = (memberships || []).filter(m => m.status === "active");
    const pending = (memberships || []).filter(m => m.status === "pending");
    setPendingRequests(pending);
    if (active.length > 0) {
      const companyIds = active.map(m => m.company_id);
      const { data: companyData } = await supabase.from("companies").select("*").in("id", companyIds);
      // Attach role to each company
      const withRoles = (companyData || []).map(c => {
        const membership = active.find(m => m.company_id === c.id);
        return { ...c, memberRole: membership?.role || "admin" };
      });
      setCompanies(withRoles);
    } else {
      setCompanies([]);
    }
    setLoading(false);
  }

  async function createCompany() {
    if (!createForm.name.trim()) { alert("Company name is required."); return; }
    const companyId = "co-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    // Generate unique 8-digit numeric company code
    const ccArr = new Uint32Array(1); crypto.getRandomValues(ccArr); const companyCode = String(10000000 + (ccArr[0] % 89999999));
    const { data, error } = await supabase.from("companies").insert([{
      id: companyId, name: createForm.name, type: createForm.type, company_code: companyCode,
      company_role: createForm.company_role || "management",
      address: createForm.address, phone: createForm.phone, email: createForm.email,
      created_by: currentUser?.email || "",
    }]).select();
    if (error) { alert("Error creating company: " + error.message); return; }
    // Add creator as admin
    await supabase.from("company_members").insert([{
      company_id: companyId, user_email: currentUser?.email, user_name: currentUser?.email?.split("@")[0] || "",
      role: "admin", status: "active", invited_by: "self",
    }]);
    // Also add to app_users
    await supabase.from("app_users").upsert([{
      email: currentUser?.email, name: currentUser?.email?.split("@")[0] || "",
      role: "admin", company_id: companyId,
    }], { onConflict: "email" });
    // Seed default chart of accounts for this company
    const defaultAccounts = [
      { id: "1000", name: "Checking Account", type: "Asset", subtype: "Bank", is_active: true, company_id: companyId },
      { id: "1100", name: "Accounts Receivable", type: "Asset", subtype: "Accounts Receivable", is_active: true, company_id: companyId },
      { id: "2100", name: "Security Deposits Held", type: "Liability", subtype: "Other Current Liability", is_active: true, company_id: companyId },
      { id: "2200", name: "Owner Distributions Payable", type: "Liability", subtype: "Other Current Liability", is_active: true, company_id: companyId },
      { id: "3000", name: "Owner Equity", type: "Equity", subtype: "Owner's Equity", is_active: true, company_id: companyId },
      { id: "4000", name: "Rental Income", type: "Revenue", subtype: "Rental Income", is_active: true, company_id: companyId },
      { id: "4010", name: "Late Fee Income", type: "Revenue", subtype: "Other Primary Income", is_active: true, company_id: companyId },
      { id: "4100", name: "Other Income", type: "Revenue", subtype: "Other Primary Income", is_active: true, company_id: companyId },
      { id: "4200", name: "Management Fee Income", type: "Revenue", subtype: "Service Income", is_active: true, company_id: companyId },
      { id: "5300", name: "Repairs & Maintenance", type: "Expense", subtype: "Maintenance & Repairs", is_active: true, company_id: companyId },
      { id: "5400", name: "Utilities", type: "Expense", subtype: "Utilities", is_active: true, company_id: companyId },
      { id: "5500", name: "HOA Fees", type: "Expense", subtype: "HOA & Association Fees", is_active: true, company_id: companyId },
    ];
    await supabase.from("acct_accounts").upsert(defaultAccounts.map(a => ({ ...a, id: companyId.slice(0, 8) + "-" + a.id })), { onConflict: "id" });
    alert("Company created!\n\nCompany Code: " + companyCode + "\n\nShare this code with people you want to invite.");
    setShowCreate(false);
    setCreateForm({ name: "", type: "LLC", company_role: "management", address: "", phone: "", email: "" });
    fetchCompanies();
  }

  async function searchCompanies() {
    if (!joinSearch.trim() && !joinCode.trim()) return;
    let query = supabase.from("companies").select("id, name, type, company_code");
    if (joinCode.trim()) {
      query = query.ilike("company_code", joinCode.trim());
    } else {
      query = query.ilike("name", "%" + joinSearch.trim() + "%");
    }
    const { data } = await query.limit(10);
    setSearchResults(data || []);
  }

  async function requestJoin(company) {
    // Check if already a member
    const { data: existing } = await supabase.from("company_members").select("status").eq("company_id", company.id).eq("user_email", currentUser?.email).maybeSingle();
    if (existing) {
      if (existing.status === "active") { alert("You're already a member of " + company.name); return; }
      if (existing.status === "pending") { alert("Your request to join " + company.name + " is pending admin approval."); return; }
      if (existing.status === "rejected") { alert("Your previous request to join " + company.name + " was rejected. Please contact the company admin directly."); return; }
      if (existing.status === "removed") { alert("You were previously removed from " + company.name + ". Please contact the company admin to be re-added."); return; }
    }
    await supabase.from("company_members").upsert([{
      company_id: company.id, user_email: currentUser?.email, user_name: currentUser?.email?.split("@")[0] || "",
      role: "office_assistant", status: "pending", invited_by: "self-request",
    }], { onConflict: "company_id,user_email" });
    setJoinMessage("Request sent to join " + company.name + "! An admin will review your request.");
    setSearchResults([]);
    setJoinCode("");
    setJoinSearch("");
    fetchCompanies();
  }

  if (loading) return <div className="flex items-center justify-center h-screen bg-gray-50"><Spinner /></div>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-white flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <div className="text-3xl font-bold text-indigo-700 mb-1">🏡 PropManager</div>
          <div className="text-sm text-gray-500">Welcome, {currentUser?.email}</div>
        </div>

        {/* Your Companies */}
        {companies.length > 0 && (
          <div className="mb-6">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Your Companies</h2>
            <div className="space-y-2">
              {companies.map(c => (
                <button key={c.id} onClick={() => onSelectCompany(c, c.memberRole)}
                  className="w-full bg-white rounded-xl border border-gray-200 p-4 flex items-center justify-between hover:border-indigo-300 hover:shadow-md transition-all text-left">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-lg">
                      {c.name[0]}
                    </div>
                    <div>
                      <div className="font-semibold text-gray-800">{c.name}</div>
                      <div className="text-xs text-gray-400">{c.type} · Code: {c.company_code} · {c.memberRole}</div>
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
          <div className="mb-6 bg-amber-50 border border-amber-200 rounded-xl p-4">
            <div className="text-sm font-semibold text-amber-800 mb-1">⏳ Pending Requests</div>
            <div className="text-xs text-amber-600">You have {pendingRequests.length} pending request(s) waiting for admin approval.</div>
          </div>
        )}

        {joinMessage && (
          <div className="mb-4 bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-700">{joinMessage}</div>
        )}

        {/* Actions */}
        <div className="grid grid-cols-2 gap-3 mb-6">
          <button onClick={() => { setShowCreate(true); setShowJoin(false); }}
            className="bg-indigo-600 text-white rounded-xl p-4 text-center hover:bg-indigo-700 transition-colors">
            <div className="text-2xl mb-1">🏢</div>
            <div className="text-sm font-semibold">Create Company</div>
            <div className="text-xs text-indigo-200">Start a new LLC or org</div>
          </button>
          <button onClick={() => { setShowJoin(true); setShowCreate(false); }}
            className="bg-white border-2 border-indigo-200 text-indigo-700 rounded-xl p-4 text-center hover:border-indigo-400 transition-colors">
            <div className="text-2xl mb-1">🔗</div>
            <div className="text-sm font-semibold">Join Company</div>
            <div className="text-xs text-gray-400">Enter code or search</div>
          </button>
        </div>

        {/* Create Company Form */}
        {showCreate && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 mb-4">
            <h3 className="font-bold text-gray-800 mb-4">Create New Company</h3>
            <div className="space-y-3">
              {/* Company Role Selection */}
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-2">Company Type *</label>
                <div className="grid grid-cols-2 gap-3">
                  <button type="button" onClick={() => setCreateForm({...createForm, company_role: "management"})} className={`p-3 rounded-xl border-2 text-left transition-all ${createForm.company_role === "management" ? "border-indigo-500 bg-indigo-50" : "border-gray-200 hover:border-gray-300"}`}>
                    <div className="text-lg mb-1">🏢</div>
                    <div className="text-sm font-semibold text-gray-800">Property Management</div>
                    <div className="text-xs text-gray-500">I manage properties for owners</div>
                  </button>
                  <button type="button" onClick={() => setCreateForm({...createForm, company_role: "owner"})} className={`p-3 rounded-xl border-2 text-left transition-all ${createForm.company_role === "owner" ? "border-emerald-500 bg-emerald-50" : "border-gray-200 hover:border-gray-300"}`}>
                    <div className="text-lg mb-1">🏠</div>
                    <div className="text-sm font-semibold text-gray-800">Property Owner</div>
                    <div className="text-xs text-gray-500">I own and manage my properties</div>
                  </button>
                </div>
              </div>
              <div><label className="text-xs font-medium text-gray-600">Company Name *</label><input value={createForm.name} onChange={e => setCreateForm({...createForm, name: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1" placeholder={createForm.company_role === "management" ? "e.g. Sigma Property Management" : "e.g. Smith Properties LLC"} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-medium text-gray-600">Entity Type</label><select value={createForm.type} onChange={e => setCreateForm({...createForm, type: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1"><option>LLC</option><option>Corporation</option><option>Partnership</option><option>Sole Proprietorship</option><option>Trust</option><option>Other</option></select></div>
                <div><label className="text-xs font-medium text-gray-600">Email</label><input value={createForm.email} onChange={e => setCreateForm({...createForm, email: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1" placeholder="company@email.com" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-medium text-gray-600">Address</label><input value={createForm.address} onChange={e => setCreateForm({...createForm, address: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1" /></div>
                <div><label className="text-xs font-medium text-gray-600">Phone</label><input value={createForm.phone} onChange={e => setCreateForm({...createForm, phone: e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1" /></div>
              </div>
              <div className="flex gap-2 pt-2">
                <button onClick={createCompany} className="bg-indigo-600 text-white text-sm px-5 py-2 rounded-lg hover:bg-indigo-700">Create Company</button>
                <button onClick={() => setShowCreate(false)} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg">Cancel</button>
              </div>
            </div>
          </div>
        )}

        {/* Join Company Form */}
        {showJoin && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 mb-4">
            <h3 className="font-bold text-gray-800 mb-4">Join a Company</h3>
            <div className="space-y-3">
              <div><label className="text-xs font-medium text-gray-600">Company ID (8-digit code)</label><input value={joinCode} onChange={e => setJoinCode(e.target.value.replace(/\D/g, "").slice(0, 8))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1" placeholder="e.g. 12345678" maxLength={8} /></div>
              <div className="text-xs text-gray-400 text-center">— or —</div>
              <div><label className="text-xs font-medium text-gray-600">Search by Name</label><input value={joinSearch} onChange={e => setJoinSearch(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1" placeholder="e.g. Sigma Housing" /></div>
              <div className="flex gap-2">
                <button onClick={searchCompanies} className="bg-indigo-600 text-white text-sm px-5 py-2 rounded-lg hover:bg-indigo-700">Search</button>
                <button onClick={() => setShowJoin(false)} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg">Cancel</button>
              </div>
              {searchResults.length > 0 && (
                <div className="space-y-2 mt-3">
                  {searchResults.map(c => (
                    <div key={c.id} className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                      <div><div className="text-sm font-semibold text-gray-800">{c.name}</div><div className="text-xs text-gray-400">{c.type} · {c.company_code}</div></div>
                      <button onClick={() => requestJoin(c)} className="bg-indigo-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-indigo-700">Request to Join</button>
                    </div>
                  ))}
                </div>
              )}
              {searchResults.length === 0 && (joinCode || joinSearch) && <div className="text-xs text-gray-400 text-center">Click Search to find companies</div>}
            </div>
          </div>
        )}

        <div className="text-center">
          <button onClick={onLogout} className="text-sm text-gray-400 hover:text-red-500">Logout</button>
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
    const newStatus = action === "approve" ? "active" : "rejected";
    await supabase.from("company_members").update({ status: newStatus }).eq("id", member.id);
    if (action === "approve") {
      // Also add to app_users
      // Insert only if no existing row — don't overwrite other company's data
      await supabase.from("app_users").upsert([{
        email: (member.user_email || "").toLowerCase(), name: member.user_name, role: member.role, company_id: companyId,
      }], { onConflict: "email", ignoreDuplicates: true });
      addNotification("✅", member.user_name + " approved to join");
    } else {
      addNotification("❌", member.user_name + "'s request rejected");
    }
    fetchRequests();
  }

  if (loading || requests.length === 0) return null;

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-bold text-amber-800">⏳ Pending Join Requests ({requests.length})</div>
      </div>
      <div className="space-y-2">
        {requests.map(r => (
          <div key={r.id} className="flex items-center justify-between bg-white rounded-lg p-3">
            <div>
              <div className="text-sm font-semibold text-gray-800">{r.user_name || r.user_email}</div>
              <div className="text-xs text-gray-400">{r.user_email} · Requested: {new Date(r.created_at).toLocaleDateString()}</div>
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

export default function App() {
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
  const [companyRole, setCompanyRole] = useState("admin");

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) { setCurrentUser(session.user); setScreen("company_select"); autoSelectCompany(session.user); }
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        setCurrentUser(session.user);
        // Only redirect to company_select if we don't have a company yet
        setActiveCompany(prev => {
          if (!prev) { setScreen("company_select"); autoSelectCompany(session.user); }
          return prev;
        });
      } else {
        setCurrentUser(null);
        setUserRole("admin");
        setActiveCompany(null);
        setScreen("landing");
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  // Auto-select company ONLY for tenant/owner roles — everyone else sees the company selector
  async function autoSelectCompany(user) {
    if (!user?.email) return;
    const { data: memberships } = await supabase.from("company_members").select("company_id, role, status").ilike("user_email", user.email).eq("status", "active");
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
    setCompanyRole(role);
    setUserRole(role);
    setUserProfile({ name: currentUser?.email?.split("@")[0] || "User", email: currentUser?.email, role: role });
    fetchUserRoleForCompany(currentUser, company.id);
    setScreen("app");
    setPage("dashboard");
  }

  async function fetchUserRoleForCompany(user, companyId) {
    if (!user?.email || !companyId) return;
    try {
      const { data } = await supabase.from("company_members").select("*").eq("company_id", companyId).ilike("user_email", user.email).eq("status", "active").maybeSingle();
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
    } catch { /* ignore */ }
  }

  function addNotification(icon, message) {
    const n = { id: Date.now(), icon, message, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) };
    setNotifications(prev => [n, ...prev].slice(0, 20));
    setUnreadCount(prev => prev + 1);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setScreen("landing");
    setNotifications([]);
    setUnreadCount(0);
    setCurrentUser(null);
    setUserRole("admin");
    setCustomAllowedPages(null);
    setActiveCompany(null);
  }

  function switchCompany() {
    setActiveCompany(null);
    setCompanyRole("admin");
    setUserRole("admin");
    setCustomAllowedPages(null);
    setNotifications([]);
    setUnreadCount(0);
    setScreen("company_select");
    setPage("dashboard");
  }

  const [loginMode, setLoginMode] = useState("login");

  if (screen === "landing") return <LandingPage onGetStarted={(mode) => { setLoginMode(mode); setScreen("login"); }} />;
  if (screen === "login") return <LoginPage onLogin={() => {}} onBack={() => setScreen("landing")} initialMode={loginMode} />;
  if (screen === "company_select") return <CompanySelector currentUser={currentUser} onSelectCompany={handleSelectCompany} onLogout={handleLogout} />;

  // Guard: never render app without a valid company — redirect to selector
  useEffect(() => {
    if (screen === "app" && !activeCompany?.id) {
      setScreen("company_select");
    }
  }, [screen, activeCompany]);

  if (!activeCompany?.id) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="text-center">
          <Spinner />
          <p className="text-sm text-gray-400 mt-4">Loading company...</p>
        </div>
      </div>
    );
  }

  // Build nav based on role
  const allowedPages = customAllowedPages || ROLES[userRole]?.pages || [];
  const navItems = ALL_NAV.filter(n => allowedPages.includes(n.id));
  const adminNav = userRole === "admin"
    ? [...navItems, { id: "roles", label: "Team & Roles", icon: "👥" }]
    : navItems;

  // Owner-admins (created their own company) get full app access
  // Only force owner_portal for owners invited into a PM's company
  const effectivePage = !userRole ? "dashboard" : userRole === "tenant" ? "tenant_portal" : (userRole === "owner" && companyRole !== "admin") ? "owner_portal" : page;
  const Page = pageComponents[effectivePage] || Dashboard;
  const safePage = allowedPages.includes(page) ? page : allowedPages[0];

  return (
    <div className="flex h-screen bg-gray-50 font-sans overflow-hidden">
      {/* Sidebar */}
      <div className={`${sidebarOpen ? "flex" : "hidden"} md:flex flex-col w-56 bg-white border-r border-gray-100 shadow-sm z-20 fixed md:relative h-full`}>
        <div className="px-5 py-4 border-b border-gray-100">
          <div className="text-lg font-bold text-indigo-700">🏡 PropManager</div>
          {activeCompany && (
            <div className="flex items-center gap-1.5 mt-1">
              <span className="w-4 h-4 rounded bg-indigo-100 flex items-center justify-center text-indigo-700 text-xs font-bold">{activeCompany.name[0]}</span>
              <span className="text-xs text-gray-500 truncate max-w-32">{activeCompany.name}</span>
            </div>
          )}
        </div>
        <nav className="flex-1 py-3 overflow-y-auto">
          {adminNav.map(n => (
            <button key={n.id} onClick={() => { setPage(n.id); setSidebarOpen(false); }}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors ${(effectivePage === n.id || safePage === n.id) && page === n.id ? "bg-indigo-50 text-indigo-700 font-semibold border-r-2 border-indigo-600" : "text-gray-600 hover:bg-gray-50"}`}>
              <span>{n.icon}</span>{n.label}
            </button>
          ))}
        </nav>
        <div className="px-4 py-3 border-t border-gray-100">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold ${ROLES[userRole]?.color || "bg-indigo-600"}`}>
                {userProfile?.name?.[0]?.toUpperCase() || "U"}
              </div>
              <div>
                <div className="text-xs font-semibold text-gray-700 truncate max-w-24">{userProfile?.name || "User"}</div>
                <div className={`text-xs font-medium ${ROLES[userRole]?.color?.replace("bg-", "text-") || "text-indigo-600"}`}>{ROLES[userRole]?.label}</div>
              </div>
            </div>
            <button onClick={handleLogout} className="text-xs text-gray-400 hover:text-red-500">Logout</button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3">
          <button className="md:hidden text-gray-500 text-xl" onClick={() => setSidebarOpen(!sidebarOpen)}>☰</button>
          <div className="flex-1 text-sm text-gray-400 capitalize">{page.replace("_", " ")}</div>
          <button onClick={switchCompany} className="hidden md:flex items-center gap-1.5 text-xs bg-indigo-50 text-indigo-600 px-3 py-1.5 rounded-lg hover:bg-indigo-100 transition-colors font-medium border border-indigo-100">
            <span>⇄</span> Switch Company
          </button>
          <span className={`hidden md:inline-block text-white text-xs px-2 py-0.5 rounded-full font-semibold ${ROLES[userRole]?.color || "bg-indigo-600"}`}>
            {ROLES[userRole]?.label}
          </span>
          <div className="relative">
            <button onClick={() => { setShowNotifications(!showNotifications); setUnreadCount(0); }} className="relative text-gray-400 hover:text-gray-600 p-1">
              🔔
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center">{unreadCount > 9 ? "9+" : unreadCount}</span>
              )}
            </button>
            {showNotifications && (
              <div className="absolute right-0 top-8 w-80 bg-white rounded-xl shadow-xl border border-gray-100 z-50">
                <div className="px-4 py-3 border-b border-gray-100 flex justify-between items-center">
                  <span className="font-semibold text-gray-700 text-sm">Notifications</span>
                  <button onClick={() => { setNotifications([]); setShowNotifications(false); }} className="text-xs text-gray-400 hover:text-red-500">Clear all</button>
                </div>
                <div className="max-h-72 overflow-y-auto">
                  {notifications.length === 0 ? (
                    <div className="px-4 py-6 text-center text-gray-400 text-sm">No notifications yet</div>
                  ) : (
                    notifications.map(n => (
                      <div key={n.id} className="px-4 py-3 border-b border-gray-50 hover:bg-gray-50 flex items-start gap-2">
                        <span className="text-lg">{n.icon}</span>
                        <div className="flex-1">
                          <div className="text-sm text-gray-700">{n.message}</div>
                          <div className="text-xs text-gray-400 mt-0.5">{n.time}</div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          {userRole === "admin" && activeCompany && <PendingRequestsPanel companyId={activeCompany.id} addNotification={addNotification} />}
          <Page
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

      {sidebarOpen && <div className="fixed inset-0 bg-black bg-opacity-20 z-10 md:hidden" onClick={() => setSidebarOpen(false)} />}
      {showNotifications && <div className="fixed inset-0 z-30" onClick={() => setShowNotifications(false)} />}
    </div>
  );
}
