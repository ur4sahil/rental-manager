import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { supabase } from "./supabase";

// Safe number conversion - prevents NaN from breaking calculations
const safeNum = (val) => { const n = Number(val); return isNaN(n) ? 0 : n; };

// ============ AUDIT TRAIL HELPER ============
// Call this from any module to log an action
async function logAudit(action, module, details = "", recordId = "", userEmail = "", userRoleVal = "admin") {
  try {
    if (!userEmail) {
      const { data: { user } } = await supabase.auth.getUser();
      userEmail = user?.email || "unknown";
    }
    await supabase.from("audit_trail").insert([{ action, module, details, record_id: String(recordId), user_email: userEmail, user_role: userRoleVal }]);
  } catch (e) { console.warn("Audit log failed:", e); }
}

// ============ UNIFIED AUTO-POSTING TO ACCOUNTING ============
async function autoPostJournalEntry({ date, description, reference, lines, status = "posted" }) {
  try {
    const { data: existingJEs } = await supabase.from("acct_journal_entries").select("number").order("number", { ascending: false }).limit(1);
    const lastNum = existingJEs?.[0]?.number ? parseInt(existingJEs[0].number.replace("JE-",""), 10) : 0;
    const number = `JE-${String(lastNum + 1).padStart(4, "0")}`;
    const jeId = number;
    await supabase.from("acct_journal_entries").insert([{ id: jeId, number, date, description, reference: reference || "", status }]);
    if (lines?.length > 0) {
      await supabase.from("acct_journal_lines").insert(lines.map(l => ({
        journal_entry_id: jeId, account_id: l.account_id, account_name: l.account_name,
        debit: safeNum(l.debit), credit: safeNum(l.credit), class_id: l.class_id || null, memo: l.memo || ""
      })));
    }
    return jeId;
  } catch (e) { console.warn("Auto-post JE failed:", e); return null; }
}

async function getPropertyClassId(propertyAddress) {
  if (!propertyAddress) return null;
  const { data } = await supabase.from("acct_classes").select("id").eq("name", propertyAddress).limit(1);
  return data?.[0]?.id || null;
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
function PropertyDropdown({ value, onChange, className = "", required = false, label = "Property" }) {
  const [properties, setProperties] = useState([]);
  useEffect(() => {
    supabase.from("properties").select("id, address, type, status").order("address").then(({ data }) => setProperties(data || []));
  }, []);
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

function PropertySelect({ value, onChange, className = "" }) {
  const [properties, setProperties] = useState([]);
  useEffect(() => {
    supabase.from("properties").select("id, address, type").order("address").then(({ data }) => setProperties(data || []));
  }, []);
  return (
    <select value={value || ""} onChange={e => onChange(e.target.value)} className={`border border-gray-200 rounded-lg px-3 py-2 text-sm ${className}`}>
      <option value="">Select property...</option>
      {properties.map(p => <option key={p.id} value={p.address}>{p.address}</option>)}
    </select>
  );
}

// ============ LANDING PAGE ============
function LandingPage({ onGetStarted }) {
  const features = [
    { icon: "🏠", title: "Property Management", desc: "Track all your properties, units, and their status in one place." },
    { icon: "👤", title: "Tenant Management", desc: "Manage tenant profiles, leases, and communication effortlessly." },
    { icon: "💳", title: "Rent Collection", desc: "Collect rent via ACH, card, or autopay with automated reminders." },
    { icon: "🔧", title: "Maintenance Tracking", desc: "Handle work orders from submission to completion with ease." },
    { icon: "⚡", title: "Utility Management", desc: "Track and pay utility bills with full audit logs." },
    { icon: "📊", title: "Full Accounting", desc: "General ledger, bank reconciliation, and financial reports." },
  ];

  return (
    <div className="min-h-screen bg-white">
      <nav className="flex items-center justify-between px-8 py-4 border-b border-gray-100">
        <div className="text-xl font-bold text-indigo-700">🏡 PropManager</div>
        <div className="flex items-center gap-4">
          <a href="#features" className="text-sm text-gray-600 hover:text-indigo-600">Features</a>
          <a href="#pricing" className="text-sm text-gray-600 hover:text-indigo-600">Pricing</a>
          <button onClick={onGetStarted} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">Login</button>
        </div>
      </nav>
      <div className="bg-gradient-to-br from-indigo-50 to-white px-8 py-20 text-center">
        <div className="inline-block bg-indigo-100 text-indigo-700 text-xs font-semibold px-3 py-1 rounded-full mb-4">Built for Property Managers</div>
        <h1 className="text-4xl md:text-5xl font-bold text-gray-900 mb-4 leading-tight">Manage Your Properties<br />Like a Pro</h1>
        <p className="text-lg text-gray-500 mb-8 max-w-xl mx-auto">Everything you need to manage 100+ properties — tenants, rent, maintenance, utilities, and accounting in one place.</p>
        <div className="flex gap-3 justify-center">
          <button onClick={onGetStarted} className="bg-indigo-600 text-white px-6 py-3 rounded-xl font-semibold hover:bg-indigo-700 shadow-md">Get Started</button>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-6 max-w-2xl mx-auto px-8 py-12 text-center">
        {[["100+", "Properties Managed"], ["99.9%", "Uptime"], ["$0", "To Get Started"]].map(([v, l]) => (
          <div key={l}>
            <div className="text-3xl font-bold text-indigo-700">{v}</div>
            <div className="text-sm text-gray-400 mt-1">{l}</div>
          </div>
        ))}
      </div>
      <div id="features" className="px-8 py-16 bg-gray-50">
        <h2 className="text-2xl font-bold text-center text-gray-800 mb-10">Everything You Need</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {features.map(f => (
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

// ============ LOGIN PAGE (Real Supabase Auth) ============
function LoginPage({ onLogin, onBack }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // eslint-disable-next-line no-unused-vars
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-white flex flex-col">
      <nav className="flex items-center justify-between px-8 py-4">
        <button onClick={onBack} className="text-xl font-bold text-indigo-700">🏡 PropManager</button>
      </nav>
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 w-full max-w-sm">
          <h2 className="text-2xl font-bold text-gray-800 mb-1">Welcome back</h2>
          <p className="text-sm text-gray-400 mb-6">Sign in to your account</p>
          {error && <div className="bg-red-50 text-red-600 text-xs rounded-lg px-3 py-2 mb-4">{error}</div>}
          <div className="mb-4">
            <label className="text-xs font-medium text-gray-600 block mb-1">Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-indigo-400" />
          </div>
          <div className="mb-6">
            <label className="text-xs font-medium text-gray-600 block mb-1">Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-indigo-400" onKeyDown={e => e.key === "Enter" && handleLogin()} />
          </div>
          <button onClick={handleLogin} disabled={loading} className="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-semibold text-sm hover:bg-indigo-700 disabled:opacity-50">
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============ DASHBOARD ============
function Dashboard({ notifications, setPage }) {
  const [properties, setProperties] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [workOrders, setWorkOrders] = useState([]);
  const [payments, setPayments] = useState([]);
  const [utilities, setUtilities] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      const [p, t, w, pay, u] = await Promise.all([
        supabase.from("properties").select("*"),
        supabase.from("tenants").select("*"),
        supabase.from("work_orders").select("*"),
        supabase.from("payments").select("*"),
        supabase.from("utilities").select("*"),
      ]);
      setProperties(p.data || []);
      setTenants(t.data || []);
      setWorkOrders(w.data || []);
      setPayments(pay.data || []);
      setUtilities(u.data || []);
      setLoading(false);
    }
    fetchData();
  }, []);

  if (loading) return <Spinner />;

  const occupied = properties.filter(p => p.status === "occupied").length;
  const totalRent = payments.filter(p => p.type === "rent" && p.status === "paid").reduce((s, p) => s + safeNum(p.amount), 0);
  const delinquent = tenants.filter(t => t.balance > 0).length;
  const openWO = workOrders.filter(w => w.status !== "completed").length;

  return (
    <div>
      <h2 className="text-xl font-bold text-gray-800 mb-5">Dashboard</h2>

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

      <div className="grid grid-cols-2 gap-3 mb-6 md:grid-cols-4">
        <StatCard label="Occupancy" value={`${occupied}/${properties.length}`} sub={`${properties.length ? Math.round(occupied / properties.length * 100) : 0}% occupied`} color="text-green-600" />
        <StatCard label="Rent Collected" value={`$${totalRent.toLocaleString()}`} sub="this month" color="text-blue-600" />
        <StatCard label="Delinquent" value={delinquent} sub="tenants with balance" color="text-red-500" />
        <StatCard label="Open Work Orders" value={openWO} sub={`${workOrders.filter(w => w.priority === "emergency").length} emergency`} color="text-orange-500" />
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
function Properties({ addNotification, userRole, userProfile }) {
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
  const [reviewNote, setReviewNote] = useState("");

  const isAdmin = userRole === "admin";

  useEffect(() => { fetchProperties(); fetchChangeRequests(); }, []);

  async function fetchProperties() {
    const { data } = await supabase.from("properties").select("*");
    setProperties(data || []);
    setLoading(false);
  }

  async function fetchChangeRequests() {
    const { data } = await supabase.from("property_change_requests").select("*").order("requested_at", { ascending: false });
    setChangeRequests(data || []);
  }

  async function saveProperty() {
    if (!form.address.trim()) { alert("Property address is required."); return; }
    if (!form.rent || isNaN(Number(form.rent))) { alert("Please enter a valid rent amount."); return; }

    if (isAdmin) {
      // Admin: direct save
      const { error } = editingProperty
        ? await supabase.from("properties").update(form).eq("id", editingProperty.id)
        : await supabase.from("properties").insert([form]);
      if (error) { alert("Error saving property: " + error.message); return; }
      // Auto-create accounting class for new properties
      if (!editingProperty) {
        const classId = `PROP-${String(Math.random()).slice(2,8)}`;
        await supabase.from("acct_classes").upsert([{ id: classId, name: form.address, description: `${form.type} · $${form.rent}/mo`, color: ["#3B82F6","#10B981","#F59E0B","#EF4444","#8B5CF6","#06B6D4"][Math.floor(Math.random()*6)], is_active: true }], { onConflict: "id" });
      }
      addNotification("🏠", editingProperty ? `Property updated: ${form.address}` : `New property added: ${form.address}`);
      logAudit(editingProperty ? "update" : "create", "properties", `${editingProperty ? "Updated" : "Added"} property: ${form.address}`, editingProperty?.id || "", userProfile?.email, userRole);
    } else {
      // Non-admin: submit change request
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase.from("property_change_requests").insert([{
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
      logAudit("request", "properties", `Requested ${editingProperty ? "edit" : "add"}: ${form.address}`, editingProperty?.id || "", userProfile?.email, userRole);
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
    const { error } = await supabase.from("properties").delete().eq("id", id);
    if (error) { alert("Error deleting property: " + error.message); return; }
    addNotification("🗑️", `Property deleted: ${address}`);
    logAudit("delete", "properties", `Deleted property: ${address}`, id, userProfile?.email, userRole);
  }

  // Admin: approve change request
  async function approveRequest(req) {
    if (req.request_type === "add") {
      await supabase.from("properties").insert([{ address: req.address, type: req.type, status: req.property_status, rent: req.rent, tenant: req.tenant, lease_end: req.lease_end, notes: req.notes }]);
      // Auto-create accounting class for this property
      const classId = `PROP-${String(Math.random()).slice(2,8)}`;
      await supabase.from("acct_classes").upsert([{ id: classId, name: req.address, description: `${req.type} · $${req.rent}/mo`, color: ["#3B82F6","#10B981","#F59E0B","#EF4444","#8B5CF6","#06B6D4","#F97316","#EC4899"][Math.floor(Math.random()*8)], is_active: true }], { onConflict: "id" });
      addNotification("✅", `Property approved & added: ${req.address}`);
    } else if (req.request_type === "edit" && req.property_id) {
      await supabase.from("properties").update({ address: req.address, type: req.type, status: req.property_status, rent: req.rent, tenant: req.tenant, lease_end: req.lease_end, notes: req.notes }).eq("id", req.property_id);
      addNotification("✅", `Property edit approved: ${req.address}`);
    }
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("property_change_requests").update({ status: "approved", reviewed_by: user?.email || "admin", reviewed_at: new Date().toISOString(), review_note: reviewNote }).eq("id", req.id);
    logAudit("approve", "properties", `Approved ${req.request_type} request: ${req.address} (requested by ${req.requested_by})`, req.id, user?.email, "admin");
    setReviewNote("");
    fetchProperties();
    fetchChangeRequests();
  }

  // Admin: reject change request
  async function rejectRequest(req) {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("property_change_requests").update({ status: "rejected", reviewed_by: user?.email || "admin", reviewed_at: new Date().toISOString(), review_note: reviewNote }).eq("id", req.id);
    addNotification("❌", `Property request rejected: ${req.address}`);
    logAudit("reject", "properties", `Rejected ${req.request_type} request: ${req.address} (requested by ${req.requested_by})`, req.id, user?.email, "admin");
    setReviewNote("");
    fetchChangeRequests();
  }

  // Timeline (same as before)
  async function loadTimeline(p) {
    setTimelineProperty(p);
    const [pay, wo, docs] = await Promise.all([
      supabase.from("payments").select("*").eq("property", p.address),
      supabase.from("work_orders").select("*").eq("property", p.address),
      supabase.from("documents").select("*").eq("property", p.address),
    ]);
    const all = [
      ...(pay.data || []).map(x => ({ ...x, _type: "payment", _date: x.date })),
      ...(wo.data || []).map(x => ({ ...x, _type: "work_order", _date: x.created_at })),
      ...(docs.data || []).map(x => ({ ...x, _type: "document", _date: x.created_at })),
    ].sort((a, b) => new Date(b._date) - new Date(a._date));
    setTimelineData(all);
  }

  const pendingRequests = changeRequests.filter(r => r.status === "pending");

  if (loading) return <Spinner />;
  const filtered = properties.filter(p =>
    (filter === "all" || p.status === filter) &&
    (p.address?.toLowerCase().includes(search.toLowerCase()) || p.type?.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div>
      <h2 className="text-xl font-bold text-gray-800 mb-4">Properties</h2>

      {/* Pending requests banner (admin only) */}
      {isAdmin && pendingRequests.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 flex items-center justify-between">
          <span className="text-sm text-amber-800">📋 <strong>{pendingRequests.length}</strong> property change {pendingRequests.length === 1 ? "request" : "requests"} awaiting your review</span>
          <button onClick={() => setShowRequests(!showRequests)} className="text-xs bg-amber-200 text-amber-800 px-3 py-1.5 rounded-lg font-medium hover:bg-amber-300">{showRequests ? "Hide" : "Review"}</button>
        </div>
      )}

      {/* Non-admin: show their pending requests */}
      {!isAdmin && changeRequests.filter(r => r.status === "pending").length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 mb-4">
          <span className="text-sm text-blue-800">📋 You have <strong>{changeRequests.filter(r => r.status === "pending").length}</strong> pending {changeRequests.filter(r => r.status === "pending").length === 1 ? "request" : "requests"} awaiting admin approval</span>
        </div>
      )}

      {/* Approval Queue (admin only) */}
      {isAdmin && showRequests && pendingRequests.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 mb-4 space-y-3">
          <h3 className="font-semibold text-gray-800">Pending Approval</h3>
          {pendingRequests.map(req => (
            <div key={req.id} className="border border-amber-100 rounded-xl p-4 bg-amber-50/30">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${req.request_type === "add" ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700"}`}>{req.request_type === "add" ? "New Property" : "Edit Property"}</span>
                    <span className="text-xs text-gray-400">by {req.requested_by} · {new Date(req.requested_at).toLocaleDateString()}</span>
                  </div>
                  <p className="font-semibold text-gray-800">{req.address}</p>
                  <p className="text-xs text-gray-500 mt-1">{req.type} · ${req.rent}/mo · Status: {req.property_status}{req.notes ? ` · Notes: ${req.notes}` : ""}</p>
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  <input value={reviewNote} onChange={e => setReviewNote(e.target.value)} placeholder="Note (optional)" className="border border-gray-200 rounded-lg px-2 py-1 text-xs w-40" />
                  <div className="flex gap-1">
                    <button onClick={() => approveRequest(req)} className="bg-emerald-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-emerald-700">✓ Approve</button>
                    <button onClick={() => rejectRequest(req)} className="bg-red-500 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-red-600">✕ Reject</button>
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
        <button onClick={() => { setEditingProperty(null); setForm({ address: "", type: "Single Family", status: "vacant", rent: "", tenant: "", lease_end: "", notes: "" }); setShowForm(!showForm); }} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">
          {isAdmin ? "+ Add Property" : "+ Request New Property"}
        </button>
      </div>

      {showForm && (
        <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm mb-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">{editingProperty ? (isAdmin ? "Edit Property" : "Request Edit") : (isAdmin ? "Add Property" : "Request New Property")}</h3>
          {!isAdmin && <p className="text-xs text-blue-600 bg-blue-50 rounded-lg px-3 py-2 mb-3">Your changes will be submitted for admin approval before taking effect.</p>}
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Address" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm col-span-2" />
            <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              <option>Single Family</option><option>Multi-Family</option><option>Apartment</option><option>Townhouse</option><option>Commercial</option>
            </select>
            <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              <option value="vacant">Vacant</option><option value="occupied">Occupied</option><option value="maintenance">Maintenance</option>
            </select>
            <input placeholder="Rent amount" value={form.rent} onChange={e => setForm({ ...form, rent: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Lease end date" type="date" value={form.lease_end} onChange={e => setForm({ ...form, lease_end: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Notes" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm col-span-2" />
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={saveProperty} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">{isAdmin ? "Save" : "Submit for Approval"}</button>
            <button onClick={() => { setShowForm(false); setEditingProperty(null); }} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg">Cancel</button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map(p => (
          <div key={p.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <div className="flex items-start justify-between mb-2">
              <div>
                <h3 className="font-semibold text-gray-800 text-sm">{p.address}</h3>
                <p className="text-xs text-gray-400">{p.type}</p>
              </div>
              <Badge status={p.status} label={p.status} />
            </div>
            <div className="text-sm text-gray-600 space-y-1">
              <div className="flex justify-between"><span>Rent:</span><span className="font-semibold">${safeNum(p.rent).toLocaleString()}</span></div>
              {p.tenant && <div className="flex justify-between"><span>Tenant:</span><span>{p.tenant}</span></div>}
              {p.lease_end && <div className="flex justify-between"><span>Lease End:</span><span>{p.lease_end}</span></div>}
            </div>
            <div className="flex gap-2 mt-3 pt-3 border-t border-gray-50">
              <button onClick={() => { setEditingProperty(p); setForm({ address: p.address, type: p.type, status: p.status, rent: p.rent || "", tenant: p.tenant || "", lease_end: p.lease_end || "", notes: p.notes || "" }); setShowForm(true); }} className="text-xs text-indigo-600 hover:underline">{isAdmin ? "Edit" : "Request Edit"}</button>
              {isAdmin && <button onClick={() => deleteProperty(p.id, p.address)} className="text-xs text-red-500 hover:underline">Delete</button>}
              <button onClick={() => loadTimeline(p)} className="text-xs text-gray-400 hover:underline ml-auto">Timeline</button>
            </div>
          </div>
        ))}
      </div>
      {filtered.length === 0 && <p className="text-center text-gray-400 py-8">No properties found.</p>}

      {/* Timeline Modal */}
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
            {timelineData.length === 0 && <p className="text-sm text-gray-400 text-center py-4">No activity found for this property.</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}

// ============ TENANTS ============
function Tenants({ addNotification, userProfile, userRole }) {
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
  const [leaseModal, setLeaseModal] = useState(null); // 'renew' | 'notice'
  const [leaseInput, setLeaseInput] = useState("");
  // eslint-disable-next-line no-unused-vars
  const [error, setError] = useState("");

  useEffect(() => {
    fetchTenants();
    supabase.from("properties").select("*").then(({ data }) => setProperties(data || []));
  }, []);

  async function fetchTenants() {
    const { data } = await supabase.from("tenants").select("*");
    setTenants(data || []);
    setLoading(false);
  }

  async function saveTenant() {
    if (!form.name.trim()) { alert("Tenant name is required."); return; }
    if (!form.email.trim()) { alert("Tenant email is required."); return; }
    if (!form.property) { alert("Please select a property."); return; }
    const { error } = editingTenant
      ? await supabase.from("tenants").update(form).eq("id", editingTenant.id)
      : await supabase.from("tenants").insert([{ ...form, balance: 0 }]);
    if (error) { alert("Error saving tenant: " + error.message); return; }
    if (editingTenant) {
      addNotification("👤", `Tenant updated: ${form.name}`);
      logAudit("update", "tenants", `Updated tenant: ${form.name}`, editingTenant?.id, userProfile?.email, userRole);
    } else {
      addNotification("👤", `New tenant added: ${form.name}`);
      logAudit("create", "tenants", `Added tenant: ${form.name} at ${form.property}`, "", userProfile?.email, userRole);
    }
    setShowForm(false);
    setEditingTenant(null);
    setForm({ name: "", email: "", phone: "", property: "", lease_status: "active", move_in: "", move_out: "", rent: "" });
    fetchTenants();
  }

  async function deleteTenant(id, name) {
    if (!window.confirm(`Delete tenant "${name}"? This cannot be undone.`)) return;
    const { error } = await supabase.from("tenants").delete().eq("id", id);
    if (error) { alert("Error deleting tenant: " + error.message); return; }
    addNotification("🗑️", `Tenant deleted: ${name}`);
    logAudit("delete", "tenants", `Deleted tenant: ${name}`, id, userProfile?.email, userRole);
    fetchTenants();
  }

  function startEdit(t) {
    setEditingTenant(t);
    setForm({ name: t.name, email: t.email, phone: t.phone, property: t.property, lease_status: t.lease_status, move_in: t.move_in || "", move_out: t.move_out || "", rent: t.rent || "" });
    setShowForm(true);
  }

  async function openLedger(tenant) {
    setSelectedTenant(tenant);
    setActivePanel("ledger");
    const { data } = await supabase.from("ledger_entries").select("*").eq("tenant", tenant.name).order("date", { ascending: false });
    setLedger(data || []);
  }

  async function openMessages(tenant) {
    setSelectedTenant(tenant);
    setActivePanel("messages");
    const { data } = await supabase.from("messages").select("*").eq("tenant", tenant.name).order("created_at", { ascending: true });
    setMessages(data || []);
    await supabase.from("messages").update({ read: true }).eq("tenant", tenant.name);
  }

  async function sendMessage() {
    if (!newMessage.trim()) return;
    await supabase.from("messages").insert([{
      tenant: selectedTenant.name,
      property: selectedTenant.property,
      sender: "admin",
      message: newMessage,
      read: false,
    }]);
    setNewMessage("");
    const { data } = await supabase.from("messages").select("*").eq("tenant", selectedTenant.name).order("created_at", { ascending: true });
    setMessages(data || []);
  }

  async function addLedgerEntry() {
    if (!newCharge.description || !newCharge.amount) return;
    const amount = newCharge.type === "payment" || newCharge.type === "credit"
      ? -Math.abs(Number(newCharge.amount))
      : Math.abs(Number(newCharge.amount));
    const currentBalance = ledger.length > 0 ? ledger[0].balance : 0;
    const newBalance = currentBalance + amount;
    await supabase.from("ledger_entries").insert([{
      tenant: selectedTenant.name,
      property: selectedTenant.property,
      date: new Date().toISOString().slice(0, 10),
      description: newCharge.description,
      amount,
      type: newCharge.type,
      balance: newBalance,
    }]);
    await supabase.from("tenants").update({ balance: newBalance }).eq("id", selectedTenant.id);
    setSelectedTenant({ ...selectedTenant, balance: newBalance });
    setNewCharge({ description: "", amount: "", type: "charge" });
    openLedger(selectedTenant);
    fetchTenants();
  }

  async function renewLease(newMoveOut) {
    if (!newMoveOut) return;
    const { error } = await supabase.from("tenants").update({ move_out: newMoveOut, lease_status: "active" }).eq("id", selectedTenant.id);
    if (error) { setError("Failed to renew lease: " + error.message); return; }
    addNotification("📄", `Lease renewed for ${selectedTenant.name} until ${newMoveOut}`);
    setLeaseModal(null);
    fetchTenants();
    setSelectedTenant({ ...selectedTenant, move_out: newMoveOut, lease_status: "active" });
  }

  async function generateMoveOutNotice(days) {
    if (!days) return;
    const noticeDate = new Date();
    noticeDate.setDate(noticeDate.getDate() + parseInt(days));
    const moveOutDate = noticeDate.toISOString().slice(0, 10);
    const { error } = await supabase.from("tenants").update({ lease_status: "notice", move_out: moveOutDate }).eq("id", selectedTenant.id);
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

      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Tenants</h2>
        <button onClick={() => { setEditingTenant(null); setForm({ name: "", email: "", phone: "", property: "", lease_status: "active", move_in: "", move_out: "", rent: "" }); setShowForm(!showForm); }} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">+ Add Tenant</button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-gray-700 mb-3">{editingTenant ? "Edit Tenant" : "New Tenant"}</h3>
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Full name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Phone" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} />
            <input placeholder="Monthly Rent ($)" value={form.rent} onChange={e => setForm({ ...form, rent: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <select value={form.lease_status} onChange={e => setForm({ ...form, lease_status: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              {["active", "notice", "expired"].map(s => <option key={s}>{s}</option>)}
            </select>
            <input type="date" placeholder="Move-in" value={form.move_in} onChange={e => setForm({ ...form, move_in: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input type="date" placeholder="Move-out / Lease end" value={form.move_out} onChange={e => setForm({ ...form, move_out: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={saveTenant} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">Save</button>
            <button onClick={() => { setShowForm(false); setEditingTenant(null); }} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {tenants.map(t => (
          <div key={t.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <div className="flex justify-between items-start">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold">{t.name?.[0]}</div>
                <div>
                  <div className="font-semibold text-gray-800">{t.name}</div>
                  <div className="text-xs text-gray-400">{t.property}</div>
                </div>
              </div>
              <Badge status={t.lease_status} />
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <div><span className="text-gray-400">Email</span><div className="font-semibold text-gray-700 truncate">{t.email}</div></div>
              <div><span className="text-gray-400">Balance</span>
                <div className={`font-semibold ${t.balance > 0 ? "text-red-500" : t.balance < 0 ? "text-green-600" : "text-gray-700"}`}>
                  {t.balance > 0 ? `-$${t.balance}` : t.balance < 0 ? `Credit $${Math.abs(t.balance)}` : "Current"}
                </div>
              </div>
              <div><span className="text-gray-400">Rent</span><div className="font-semibold text-gray-700">{t.rent ? `$${t.rent}/mo` : "—"}</div></div>
            </div>
            <div className="mt-3 flex gap-2 flex-wrap">
              <button onClick={() => openLedger(t)} className="text-xs text-indigo-600 border border-indigo-200 px-3 py-1.5 rounded-lg hover:bg-indigo-50">📒 Ledger</button>
              <button onClick={() => openMessages(t)} className="text-xs text-gray-600 border border-gray-200 px-3 py-1.5 rounded-lg hover:bg-gray-50">💬 Message</button>
              <button onClick={() => { setSelectedTenant(t); setActivePanel("lease"); }} className="text-xs text-gray-600 border border-gray-200 px-3 py-1.5 rounded-lg hover:bg-gray-50">📄 Lease</button>
              <button onClick={() => startEdit(t)} className="text-xs text-blue-600 border border-blue-200 px-3 py-1.5 rounded-lg hover:bg-blue-50">✏️ Edit</button>
              <button onClick={() => deleteTenant(t.id, t.name)} className="text-xs text-red-500 border border-red-200 px-3 py-1.5 rounded-lg hover:bg-red-50">🗑️ Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============ PAYMENTS ============
function Payments({ addNotification, userProfile, userRole }) {
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ tenant: "", property: "", amount: "", type: "rent", method: "ACH", status: "paid", date: new Date().toISOString().slice(0, 10) });

  useEffect(() => { fetchPayments(); }, []);

  async function fetchPayments() {
    const { data } = await supabase.from("payments").select("*").order("date", { ascending: false });
    setPayments(data || []);
    setLoading(false);
  }

  async function addPayment() {
    if (!form.tenant.trim()) { alert("Tenant name is required."); return; }
    if (!form.amount || isNaN(Number(form.amount)) || Number(form.amount) <= 0) { alert("Please enter a valid amount."); return; }
    if (!form.date) { alert("Payment date is required."); return; }
    const { error } = await supabase.from("payments").insert([{ ...form, amount: Number(form.amount) }]);
    if (error) { alert("Error recording payment: " + error.message); return; }
    // AUTO-POST TO ACCOUNTING: DR Bank, CR Revenue (tagged to property)
    const classId = await getPropertyClassId(form.property);
    const amt = Number(form.amount);
    const revenueAcct = form.type === "late_fee" ? "4010" : "4000";
    const revenueAcctName = form.type === "late_fee" ? "Late Fee Income" : "Rental Income";
    await autoPostJournalEntry({
      date: form.date,
      description: `${form.type === "rent" ? "Rent" : form.type} payment — ${form.tenant} — ${form.property}`,
      reference: `PAY-${Date.now()}`,
      lines: [
        { account_id: "1000", account_name: "Checking Account", debit: amt, credit: 0, class_id: classId, memo: `${form.method} from ${form.tenant}` },
        { account_id: revenueAcct, account_name: revenueAcctName, debit: 0, credit: amt, class_id: classId, memo: `${form.tenant} — ${form.property}` },
      ]
    });
    addNotification("💳", `Payment recorded: $${form.amount} from ${form.tenant}`);
    logAudit("create", "payments", `Payment: $${form.amount} from ${form.tenant} at ${form.property}`, "", userProfile?.email, userRole);
    setShowForm(false);
    setForm({ tenant: "", property: "", amount: "", type: "rent", method: "ACH", status: "paid", date: new Date().toISOString().slice(0, 10) });
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
            <PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} className="flex-1" />
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
            <tr>{["Tenant", "Property", "Amount", "Date", "Type", "Method", "Status"].map(h => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============ MAINTENANCE ============
function Maintenance({ addNotification, userProfile, userRole }) {
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
    const { data } = await supabase.from("work_orders").select("*").order("created_at", { ascending: false });
    setWorkOrders(data || []);
    setLoading(false);
  }

  async function saveWorkOrder() {
    if (!form.property.trim()) { alert("Property is required."); return; }
    if (!form.issue.trim()) { alert("Issue description is required."); return; }
    const payload = editingWO ? form : { ...form, created: new Date().toISOString().slice(0, 10) };
    const { error } = editingWO
      ? await supabase.from("work_orders").update(payload).eq("id", editingWO.id)
      : await supabase.from("work_orders").insert([payload]);
    if (error) { alert("Error saving work order: " + error.message); return; }
    if (editingWO) {
      addNotification("🔧", `Work order updated: ${form.issue}`);
      logAudit("update", "maintenance", `Updated work order: ${form.issue}`, editingWO?.id, userProfile?.email, userRole);
    } else {
      addNotification("🔧", `New work order: ${form.issue} at ${form.property}`);
      logAudit("create", "maintenance", `Work order: ${form.issue} at ${form.property}`, "", userProfile?.email, userRole);
    }
    setShowForm(false);
    setEditingWO(null);
    setForm({ property: "", tenant: "", issue: "", priority: "normal", status: "open", assigned: "", cost: 0, notes: "" });
    fetchWorkOrders();
  }

  async function updateStatus(wo, newStatus) {
    const { error } = await supabase.from("work_orders").update({ status: newStatus }).eq("id", wo.id);
    if (error) { alert("Error updating status: " + error.message); return; }
    // AUTO-POST TO ACCOUNTING when completed with a cost
    if (newStatus === "completed" && safeNum(wo.cost) > 0) {
      const classId = await getPropertyClassId(wo.property);
      const amt = safeNum(wo.cost);
      await autoPostJournalEntry({
        date: new Date().toISOString().slice(0, 10),
        description: `Maintenance: ${wo.issue} — ${wo.property}`,
        reference: `WO-${wo.id}`,
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
            <PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} className="flex-1" />
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
function Utilities({ addNotification, userProfile, userRole }) {
  const [utilities, setUtilities] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [showAudit, setShowAudit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ property: "", provider: "", amount: "", due: "", responsibility: "owner", status: "pending" });

  useEffect(() => { fetchUtilities(); }, []);

  async function fetchUtilities() {
    const { data } = await supabase.from("utilities").select("*").order("due", { ascending: true });
    setUtilities(data || []);
    setLoading(false);
  }

  async function addUtility() {
    if (!form.property.trim()) { alert("Property is required."); return; }
    if (!form.provider.trim()) { alert("Provider name is required."); return; }
    if (!form.amount || isNaN(Number(form.amount)) || Number(form.amount) <= 0) { alert("Please enter a valid amount."); return; }
    if (!form.due) { alert("Due date is required."); return; }
    const { error } = await supabase.from("utilities").insert([{ ...form, amount: Number(form.amount) }]);
    if (error) { alert("Error adding utility: " + error.message); return; }
    addNotification("⚡", `Utility bill added: ${form.provider} at ${form.property}`);
    setShowForm(false);
    setForm({ property: "", provider: "", amount: "", due: "", responsibility: "owner", status: "pending" });
    fetchUtilities();
  }

  async function approvePay(u) {
    const now = new Date().toISOString();
    const { error } = await supabase.from("utilities").update({ status: "paid", paid_at: now }).eq("id", u.id);
    if (error) { alert("Error approving payment: " + error.message); return; }
    await supabase.from("utility_audit").insert([{
      utility_id: u.id,
      property: u.property,
      provider: u.provider,
      amount: u.amount,
      action: "Approved & Paid",
      paid_at: now,
    }]);
    addNotification("✅", `Utility paid: ${u.provider} $${u.amount} for ${u.property}`);
    // AUTO-POST TO ACCOUNTING: DR Utilities Expense, CR Bank
    const classId = await getPropertyClassId(u.property);
    const amt = safeNum(u.amount);
    if (amt > 0) {
      await autoPostJournalEntry({
        date: new Date().toISOString().slice(0, 10),
        description: `Utility: ${u.provider} — ${u.property}`,
        reference: `UTIL-${u.id}`,
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

      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Utility Management</h2>
        <button onClick={() => setShowForm(!showForm)} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">+ Add Bill</button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-gray-700 mb-3">New Utility Bill</h3>
          <div className="grid grid-cols-2 gap-3">
            <PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} className="flex-1" />
            <input placeholder="Provider (e.g. Gas Co)" value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Amount" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input type="date" value={form.due} onChange={e => setForm({ ...form, due: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <select value={form.responsibility} onChange={e => setForm({ ...form, responsibility: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              {["owner", "tenant", "shared"].map(r => <option key={r}>{r}</option>)}
            </select>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={addUtility} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">Save</button>
            <button onClick={() => setShowForm(false)} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg hover:bg-gray-200">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {utilities.map(u => (
          <div key={u.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <div className="flex justify-between items-start">
              <div>
                <div className="font-semibold text-gray-800">{u.provider}</div>
                <div className="text-xs text-gray-400 mt-0.5">{u.property}</div>
              </div>
              <div className="text-right">
                <div className="text-lg font-bold text-gray-800">${u.amount}</div>
                <Badge status={u.status} />
              </div>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <div><span className="text-gray-400">Due Date</span><div className="font-semibold text-gray-700">{u.due}</div></div>
              <div><span className="text-gray-400">Responsibility</span><div className="font-semibold capitalize text-gray-700">{u.responsibility}</div></div>
              <div><span className="text-gray-400">Paid At</span><div className="font-semibold text-gray-700">{u.paid_at ? new Date(u.paid_at).toLocaleDateString() : "—"}</div></div>
            </div>
            <div className="mt-3 flex gap-2">
              {u.status === "pending" && (
                <button onClick={() => approvePay(u)} className="text-xs text-green-600 border border-green-200 px-3 py-1 rounded-lg hover:bg-green-50">✓ Approve & Pay</button>
              )}
              <button onClick={() => openAuditLog(u)} className="text-xs text-gray-600 border border-gray-200 px-3 py-1 rounded-lg hover:bg-gray-50">📋 Audit Log</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


// ============ ACCOUNTING (QuickBooks-Style with Supabase) ============

// --- Accounting Utility Functions ---
const ACCOUNT_TYPES = ["Asset","Liability","Equity","Revenue","Cost of Goods Sold","Expense","Other Income","Other Expense"];
const ACCOUNT_SUBTYPES = {
  Asset: ["Bank","Accounts Receivable","Other Current Asset","Fixed Asset","Other Asset"],
  Liability: ["Accounts Payable","Credit Card","Other Current Liability","Long Term Liability"],
  Equity: ["Owners Equity","Retained Earnings","Common Stock"],
  Revenue: ["Rental Income","Other Primary Income","Service Income"],
  "Cost of Goods Sold": ["Cost of Goods Sold","Supplies & Materials"],
  Expense: ["Advertising & Marketing","Auto","Bank Charges","Depreciation","Insurance","Maintenance & Repairs","Meals & Entertainment","Office Supplies","Professional Fees","Property Tax","Rent & Lease","Utilities","Wages & Salaries","Other Expense"],
  "Other Income": ["Interest Earned","Late Fees","Other Miscellaneous Income"],
  "Other Expense": ["Depreciation","Other Miscellaneous Expense"],
};
const DEBIT_NORMAL = ["Asset","Cost of Goods Sold","Expense","Other Expense"];
const acctFmt = (amount, showSign = false) => {
  const abs = Math.abs(amount);
  const str = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(abs);
  if (showSign && amount < 0) return `(${str})`;
  if (amount < 0) return `-${str}`;
  return str;
};
const acctFmtDate = (d) => { if (!d) return ""; const [y,m,dd] = d.split("-"); return `${m}/${dd}/${y}`; };
const acctToday = () => new Date().toISOString().split("T")[0];
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
  return { assets, liabilities, equity, totalAssets: assets.reduce((s,a) => s + a.amount, 0), totalLiabilities: liabilities.reduce((s,a) => s + a.amount, 0), totalEquity: equity.reduce((s,a) => s + a.amount, 0) + netIncome, netIncome };
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
    case "This Month": return { start: `${y}-${String(m+1).padStart(2,"0")}-01`, end: new Date(y,m+1,0).toISOString().split("T")[0] };
    case "Last Month": return { start: `${y}-${String(m).padStart(2,"0")}-01`, end: new Date(y,m,0).toISOString().split("T")[0] };
    case "This Quarter": { const q = Math.floor(m/3); return { start: `${y}-${String(q*3+1).padStart(2,"0")}-01`, end: new Date(y,q*3+3,0).toISOString().split("T")[0] }; }
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
  const [form, setForm] = useState({ name:"", type:"Asset", subtype:"Bank", description:"" });

  const withBalances = calcAllBalances(accounts, journalEntries);
  const filtered = withBalances.filter(a => {
    if (!showInactive && !a.is_active) return false;
    if (filter !== "All" && a.type !== filter) return false;
    return true;
  });

  const grouped = {};
  filtered.forEach(a => { if (!grouped[a.type]) grouped[a.type] = []; grouped[a.type].push(a); });

  const openAdd = () => { setForm({ name:"", type:"Asset", subtype:"Bank", description:"" }); setModal("add"); };
  const openEdit = (a) => { setForm({ name: a.name, type: a.type, subtype: a.subtype, description: a.description || "" }); setModal(a); };

  const saveAccount = async () => {
    if (!form.name.trim()) return;
    if (modal === "add") {
      const newId = nextAccountId(accounts, form.type);
      await onAdd({ id: newId, ...form, balance: 0, is_active: true });
    } else {
      await onUpdate({ ...modal, ...form });
    }
    setModal(null);
  };

  const typeOrder = ["Asset","Liability","Equity","Revenue","Cost of Goods Sold","Expense","Other Income","Other Expense"];

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
        {["All", ...ACCOUNT_TYPES].map(t => (
          <button key={t} onClick={() => setFilter(t)} className={`text-xs px-3 py-1.5 rounded-xl border font-medium ${filter === t ? "bg-slate-800 text-white border-slate-800" : "bg-white text-gray-500 border-gray-200 hover:border-gray-400"}`}>{t}</button>
        ))}
      </div>
      {typeOrder.map(type => {
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
            <div><label className="text-xs font-medium text-gray-600">Type *</label><select value={form.type} onChange={e => { setForm({...form, type:e.target.value, subtype: ACCOUNT_SUBTYPES[e.target.value]?.[0] || "" }); }} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1">{ACCOUNT_TYPES.map(t => <option key={t}>{t}</option>)}</select></div>
            <div><label className="text-xs font-medium text-gray-600">Subtype *</label><select value={form.subtype} onChange={e => setForm({...form, subtype:e.target.value})} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1">{(ACCOUNT_SUBTYPES[form.type]||[]).map(s => <option key={s}>{s}</option>)}</select></div>
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
function AcctJournalEntries({ accounts, journalEntries, classes, onAdd, onUpdate, onPost, onVoid }) {
  const [modal, setModal] = useState(null);
  const [filterStatus, setFilterStatus] = useState("all");
  const [form, setForm] = useState({ date: acctToday(), description: "", reference: "", lines: [{ account_id:"", account_name:"", debit:"", credit:"", class_id:"", memo:"" }, { account_id:"", account_name:"", debit:"", credit:"", class_id:"", memo:"" }] });

  const filtered = [...journalEntries].sort((a,b) => b.date.localeCompare(a.date)).filter(je => filterStatus === "all" || je.status === filterStatus);
  const counts = { all: journalEntries.length, posted: journalEntries.filter(j=>j.status==="posted").length, draft: journalEntries.filter(j=>j.status==="draft").length, voided: journalEntries.filter(j=>j.status==="voided").length };

  const openAdd = () => {
    setForm({ date: acctToday(), description: "", reference: "", lines: [{ account_id:"", account_name:"", debit:"", credit:"", class_id:"", memo:"" }, { account_id:"", account_name:"", debit:"", credit:"", class_id:"", memo:"" }] });
    setModal("add");
  };

  const openEdit = (je) => {
    setForm({ date: je.date, description: je.description, reference: je.reference || "", lines: (je.lines || []).map(l => ({ ...l, debit: l.debit || "", credit: l.credit || "" })) });
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
          <button onClick={() => saveEntry("draft")} disabled={!form.description || !validation.isValid} className="bg-gray-200 text-gray-700 text-sm px-4 py-2 rounded-lg disabled:opacity-50">Save Draft</button>
          <button onClick={() => saveEntry("posted")} disabled={!form.description || !validation.isValid} className="bg-emerald-600 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50 hover:bg-emerald-700">Post Entry</button>
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
      </div>
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-400 uppercase bg-gray-50"><tr><th className="px-4 py-2 text-left">Entry #</th><th className="px-4 py-2 text-left">Date</th><th className="px-4 py-2 text-left">Description</th><th className="px-4 py-2 text-left">Ref</th><th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2 text-right">Amount</th><th className="px-4 py-2">Actions</th></tr></thead>
          <tbody>
            {filtered.map(je => {
              const total = (je.lines || []).reduce((s,l) => s + safeNum(l.debit), 0);
              return (
                <tr key={je.id} className="border-t border-gray-50 hover:bg-blue-50/30 cursor-pointer" onClick={() => openView(je)}>
                  <td className="px-4 py-2 font-mono text-xs font-semibold text-gray-700">{je.number}</td>
                  <td className="px-4 py-2 text-gray-600">{acctFmtDate(je.date)}</td>
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
            {filtered.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No journal entries found</td></tr>}
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
            <div className="grid grid-cols-2 gap-3 bg-gray-50 rounded-xl p-4">
              <div><p className="text-xs text-gray-500">Entry #</p><p className="font-mono font-semibold">{modal.je.number}</p></div>
              <div><p className="text-xs text-gray-500">Date</p><p className="font-semibold">{acctFmtDate(modal.je.date)}</p></div>
              <div><p className="text-xs text-gray-500">Description</p><p className="font-semibold">{modal.je.description}</p></div>
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
      <div className="flex gap-1 border-b border-gray-100 mb-4">
        {[{id:"pl",l:"Profit & Loss"},{id:"bs",l:"Balance Sheet"},{id:"tb",l:"Trial Balance"},{id:"gl",l:"General Ledger"}].map(t => (
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
              {bsData.assets.filter(a=>a.amount!==0).map(a => <div key={a.id} className="flex justify-between py-1 px-2 hover:bg-gray-50 rounded"><span className="text-sm text-gray-700">{a.name}</span><span className={`font-mono text-sm ${a.amount<0?"text-red-600":"text-gray-800"}`}>{acctFmt(a.amount, true)}</span></div>)}
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
  const mdy=raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);if(mdy)return `${mdy[3]}-${mdy[1].padStart(2,"0")}-${mdy[2].padStart(2,"0")}`;
  const mdy2=raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);if(mdy2){const yr=parseInt(mdy2[3])>50?"19"+mdy2[3]:"20"+mdy2[3];return `${yr}-${mdy2[1].padStart(2,"0")}-${mdy2[2].padStart(2,"0")}`;}
  try{const d=new Date(raw);if(!isNaN(d))return d.toISOString().split("T")[0];}catch(_){}
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
      await onAddJournalEntry({ date:tx.date, description:tx.description, reference:`IMPORT-${tx.id}`, lines, status:"posted" });
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
function Accounting() {
  const [acctAccounts, setAcctAccounts] = useState([]);
  const [journalEntries, setJournalEntries] = useState([]);
  const [acctClasses, setAcctClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");
  const companyName = "Sigma Housing LLC";

  useEffect(() => { fetchAll(); }, []);

  async function fetchAll() {
    setLoading(true);
    const [acctsRes, jesRes, clsRes] = await Promise.all([
      supabase.from("acct_accounts").select("*").order("id"),
      supabase.from("acct_journal_entries").select("*").order("date", { ascending: false }),
      supabase.from("acct_classes").select("*").order("name"),
    ]);
    const accounts = acctsRes.data || [];
    const jeHeaders = jesRes.data || [];
    const classes = clsRes.data || [];

    // Fetch all journal lines and attach to entries
    if (jeHeaders.length > 0) {
      const { data: allLines } = await supabase.from("acct_journal_lines").select("*");
      const linesByJE = {};
      (allLines || []).forEach(l => { if (!linesByJE[l.journal_entry_id]) linesByJE[l.journal_entry_id] = []; linesByJE[l.journal_entry_id].push(l); });
      jeHeaders.forEach(je => { je.lines = linesByJE[je.id] || []; });
    }

    // Auto-sync: create accounting classes for any properties not yet in acct_classes
    const { data: allProps } = await supabase.from("properties").select("id, address, type, rent");
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
        }));
        await supabase.from("acct_classes").upsert(newClasses, { onConflict: "id" });
        // Re-fetch classes after sync
        const { data: updatedClasses } = await supabase.from("acct_classes").select("*").order("name");
        setAcctClasses(updatedClasses || []);
        setAcctAccounts(accounts);
        setJournalEntries(jeHeaders);
        setLoading(false);
        return;
      }
    }

    setAcctAccounts(accounts);
    setJournalEntries(jeHeaders);
    setAcctClasses(classes);
    setLoading(false);
  }

  // --- Account CRUD ---
  async function addAccount(acct) {
    await supabase.from("acct_accounts").insert([acct]);
    fetchAll();
  }
  async function updateAccount(acct) {
    const { id, ...rest } = acct;
    // Remove computed fields
    delete rest.computedBalance;
    delete rest.created_at;
    await supabase.from("acct_accounts").update(rest).eq("id", id);
    fetchAll();
  }
  async function toggleAccount(id, currentActive) {
    await supabase.from("acct_accounts").update({ is_active: !currentActive }).eq("id", id);
    fetchAll();
  }

  // --- Journal Entry CRUD ---
  async function addJournalEntry(data) {
    const number = nextJENumber(journalEntries);
    const jeId = number;
    const { lines, ...header } = data;
    await supabase.from("acct_journal_entries").insert([{ id: jeId, number, date: header.date, description: header.description, reference: header.reference || "", status: header.status || "draft" }]);
    if (lines?.length > 0) {
      await supabase.from("acct_journal_lines").insert(lines.map(l => ({ journal_entry_id: jeId, account_id: l.account_id, account_name: l.account_name, debit: safeNum(l.debit), credit: safeNum(l.credit), class_id: l.class_id || null, memo: l.memo || "" })));
    }
    fetchAll();
  }
  async function updateJournalEntry(data) {
    const { id, lines, ...header } = data;
    delete header.created_at;
    delete header.number;
    await supabase.from("acct_journal_entries").update({ date: header.date, description: header.description, reference: header.reference || "", status: header.status }).eq("id", id);
    // Replace lines
    await supabase.from("acct_journal_lines").delete().eq("journal_entry_id", id);
    if (lines?.length > 0) {
      await supabase.from("acct_journal_lines").insert(lines.map(l => ({ journal_entry_id: id, account_id: l.account_id, account_name: l.account_name, debit: safeNum(l.debit), credit: safeNum(l.credit), class_id: l.class_id || null, memo: l.memo || "" })));
    }
    fetchAll();
  }
  async function postJournalEntry(id) {
    await supabase.from("acct_journal_entries").update({ status: "posted" }).eq("id", id);
    fetchAll();
  }
  async function voidJournalEntry(id) {
    await supabase.from("acct_journal_entries").update({ status: "voided" }).eq("id", id);
    fetchAll();
  }

  // --- Class CRUD ---
  async function addClass(cls) {
    await supabase.from("acct_classes").insert([cls]);
    fetchAll();
  }
  async function updateClass(cls) {
    const { id, ...rest } = cls;
    delete rest.created_at;
    delete rest.revenue; delete rest.expenses; delete rest.netIncome;
    await supabase.from("acct_classes").update(rest).eq("id", id);
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
        {[["overview","Overview"],["coa","Chart of Accounts"],["journal","Journal Entries"],["bankimport","Bank Import"],["classes","Class Tracking"],["reports","Reports"]].map(([id,label]) => (
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
              const { data: activeTenants } = await supabase.from("tenants").select("*").eq("lease_status", "active");
              if (!activeTenants || activeTenants.length === 0) { alert("No active leases found."); return; }
              const today = new Date().toISOString().slice(0, 10);
              const month = today.slice(0, 7);
              // Check if already accrued this month
              const { data: existing } = await supabase.from("acct_journal_entries").select("id").like("reference", `ACCR-${month}%`);
              if (existing && existing.length > 0) { alert("Rent already accrued for " + month + ". " + existing.length + " entries exist."); return; }
              let count = 0;
              for (const t of activeTenants) {
                const rent = safeNum(t.rent);
                if (rent <= 0) continue;
                const classId = await getPropertyClassId(t.property);
                await autoPostJournalEntry({
                  date: today,
                  description: `Rent accrual ${month} \u2014 ${t.name} \u2014 ${t.property}`,
                  reference: `ACCR-${month}-${t.id}`,
                  lines: [
                    { account_id: "1100", account_name: "Accounts Receivable", debit: rent, credit: 0, class_id: classId, memo: `${t.name} rent due` },
                    { account_id: "4000", account_name: "Rental Income", debit: 0, credit: rent, class_id: classId, memo: `${t.name} \u2014 ${t.property}` },
                  ]
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
      {activeTab === "journal" && <AcctJournalEntries accounts={acctAccounts} journalEntries={journalEntries} classes={acctClasses} onAdd={addJournalEntry} onUpdate={updateJournalEntry} onPost={postJournalEntry} onVoid={voidJournalEntry} />}
      {activeTab === "bankimport" && <AcctBankImport accounts={acctAccounts} journalEntries={journalEntries} classes={acctClasses} onAddJournalEntry={addJournalEntry} />}
      {activeTab === "classes" && <AcctClassTracking accounts={acctAccounts} journalEntries={journalEntries} classes={acctClasses} onAdd={addClass} onUpdate={updateClass} onToggle={toggleClass} />}
      {activeTab === "reports" && <AcctReports accounts={acctAccounts} journalEntries={journalEntries} classes={acctClasses} companyName={companyName} />}
    </div>
  );
}

// ============ DOCUMENTS ============
function Documents({ addNotification, userProfile, userRole }) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState("all");
  const [form, setForm] = useState({ name: "", property: "", type: "Lease", tenant_visible: false });
  const fileRef = useRef();
  const [uploading, setUploading] = useState(false);

  useEffect(() => { fetchDocs(); }, []);

  async function fetchDocs() {
    const { data } = await supabase.from("documents").select("*").order("uploaded_at", { ascending: false });
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
    const { error: insertError } = await supabase.from("documents").insert([{
      name: form.name,
      property: form.property,
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
    setForm({ name: "", property: "", type: "Lease", tenant_visible: false });
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
    const { error } = await supabase.from("documents").delete().eq("id", id);
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
          await supabase.from("documents").update({ url: data.publicUrl }).eq("id", d.id);
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
            <PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} className="flex-1" />
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
function Inspections({ addNotification, userProfile, userRole }) {
  const [inspections, setInspections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [selectedInspection, setSelectedInspection] = useState(null);
  const [form, setForm] = useState({ property: "", type: "Move-In", inspector: "", date: new Date().toISOString().slice(0, 10), status: "scheduled", notes: "" });

  const checklistTemplates = {
    "Move-In": ["Front door & locks", "Windows & screens", "Walls & ceilings", "Floors & carpets", "Kitchen appliances", "Bathrooms", "HVAC system", "Smoke detectors", "Garage/parking"],
    "Move-Out": ["Front door & locks", "Windows & screens", "Walls & ceilings", "Floors & carpets", "Kitchen appliances", "Bathrooms", "HVAC system", "Smoke detectors", "Cleaning condition"],
    "Periodic": ["Exterior condition", "Roof & gutters", "HVAC filter", "Plumbing leaks", "Electrical", "Smoke detectors", "Pest signs", "General cleanliness"],
  };

  const [checklist, setChecklist] = useState({});

  useEffect(() => { fetchInspections(); }, []);

  async function fetchInspections() {
    const { data } = await supabase.from("inspections").select("*").order("date", { ascending: false });
    setInspections(data || []);
    setLoading(false);
  }

  async function saveInspection() {
    if (!form.property.trim()) { alert("Property is required."); return; }
    if (!form.date) { alert("Inspection date is required."); return; }
    const { error } = await supabase.from("inspections").insert([{ ...form, checklist: JSON.stringify(checklist) }]);
    if (error) { alert("Error saving inspection: " + error.message); return; }
    addNotification("🔍", `Inspection scheduled: ${form.type} at ${form.property}`);
    setShowForm(false);
    setForm({ property: "", type: "Move-In", inspector: "", date: new Date().toISOString().slice(0, 10), status: "scheduled", notes: "" });
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
            <PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} className="flex-1" />
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

// ============ ROLE DEFINITIONS ============
const ROLES = {
  admin: { label: "Admin", color: "bg-indigo-600", pages: ["dashboard","properties","tenants","payments","maintenance","utilities","accounting","documents","inspections","autopay","latefees","audittrail"] },
  office_assistant: { label: "Office Assistant", color: "bg-blue-500", pages: ["dashboard","properties","tenants","payments","maintenance","documents","inspections"] },
  accountant: { label: "Accountant", color: "bg-green-600", pages: ["dashboard","accounting","payments","utilities"] },
  maintenance: { label: "Maintenance", color: "bg-orange-500", pages: ["maintenance"] },
  tenant: { label: "Tenant", color: "bg-gray-500", pages: ["tenant_portal"] },
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
  { id: "latefees", label: "Late Fees", icon: "⚠️" },
  { id: "audittrail", label: "Audit Trail", icon: "📋" },
];

// ============ AUTOPAY / RECURRING RENT ============
function Autopay({ addNotification, userProfile, userRole }) {
  const [schedules, setSchedules] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ tenant: "", property: "", amount: "", frequency: "monthly", day_of_month: "1", start_date: "", end_date: "", method: "ACH", active: true });

  useEffect(() => { fetchData(); }, []);

  async function fetchData() {
    try {
      const [s, t] = await Promise.all([
        supabase.from("autopay_schedules").select("*").order("created_at", { ascending: false }),
        supabase.from("tenants").select("*"),
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
    const { error } = await supabase.from("autopay_schedules").insert([{ ...form, amount: Number(form.amount) }]);
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
    await supabase.from("autopay_schedules").delete().eq("id", id);
    fetchData();
  }

  async function runNow(s) {
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await supabase.from("payments").insert([{ tenant: s.tenant, property: s.property, amount: s.amount, type: "rent", method: s.method, status: "paid", date: today }]);
    if (error) { alert("Error: " + error.message); return; }
    addNotification("💳", `Autopay $${s.amount} processed for ${s.tenant}`);
  }

  function nextDue(s) {
    const today = new Date();
    const next = new Date(today.getFullYear(), today.getMonth(), parseInt(s.day_of_month));
    if (next <= today) next.setMonth(next.getMonth() + 1);
    if (s.end_date && next > new Date(s.end_date)) return "Expired";
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
            <PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} className="flex-1" />
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
function LateFees({ addNotification, userProfile, userRole }) {
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
        supabase.from("late_fee_rules").select("*"),
        supabase.from("payments").select("*").eq("status", "unpaid"),
        supabase.from("tenants").select("*"),
      ]);
      setRules(r.data || []);
      setTenants(t.data || []);
      const today = new Date();
      const overdue = (p.data || []).filter(pay => pay.date && Math.floor((today - new Date(pay.date)) / 86400000) > 0)
        .map(pay => ({ ...pay, daysLate: Math.floor((today - new Date(pay.date)) / 86400000) }));
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
    const { error } = await supabase.from("late_fee_rules").insert([{ ...form, grace_days: Number(form.grace_days), fee_amount: Number(form.fee_amount) }]);
    if (error) { alert("Error: " + error.message); return; }
    addNotification("⚠️", `Late fee rule "${form.name}" created`);
    setShowForm(false);
    fetchData();
  }

  async function applyLateFee(payment, rule) {
    const feeAmount = rule.fee_type === "flat" ? rule.fee_amount : Math.round(payment.amount * rule.fee_amount / 100);
    const tenant = tenants.find(t => t.name === payment.tenant);
    if (tenant) {
      const newBalance = safeNum(tenant.balance) + feeAmount;
      await supabase.from("ledger_entries").insert([{ tenant: payment.tenant, property: payment.property, date: new Date().toISOString().slice(0, 10), description: `Late fee — ${payment.daysLate} days overdue`, amount: feeAmount, type: "late_fee", balance: newBalance }]);
      await supabase.from("tenants").update({ balance: newBalance }).eq("id", tenant.id);
    }
    addNotification("⚠️", `Late fee $${feeAmount} applied to ${payment.tenant}`);
    // AUTO-POST TO ACCOUNTING: DR Accounts Receivable, CR Late Fee Income
    const classId = await getPropertyClassId(payment.property);
    if (feeAmount > 0) {
      await autoPostJournalEntry({
        date: new Date().toISOString().slice(0, 10),
        description: "Late fee - " + payment.tenant + " - " + payment.property,
        reference: "LATE-" + Date.now(),
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
              <button onClick={async () => { await supabase.from("late_fee_rules").delete().eq("id", r.id); fetchData(); }} className="text-xs text-red-400 hover:text-red-600">Delete</button>
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
function TenantPortal({ currentUser }) {
  const [tenantData, setTenantData] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [activeTab, setActiveTab] = useState("overview");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      const email = currentUser?.email;
      if (!email) { setLoading(false); return; }
      const { data: tenant, error: tenantErr } = await supabase.from("tenants").select("*").eq("email", email).maybeSingle();
      if (tenantErr || !tenant) { setLoading(false); return; }
      setTenantData(tenant);
      const [l, m] = await Promise.all([
        supabase.from("ledger_entries").select("*").eq("tenant", tenant.name).order("date", { ascending: false }),
        supabase.from("messages").select("*").eq("tenant", tenant.name).order("created_at", { ascending: true }),
      ]);
      setLedger(l.data || []);
      setMessages(m.data || []);
      setLoading(false);
    }
    fetchData();
  }, [currentUser]);

  async function sendMessage() {
    if (!newMessage.trim() || !tenantData) return;
    await supabase.from("messages").insert([{ tenant: tenantData.name, property: tenantData.property, sender: tenantData.name, message: newMessage, read: false }]);
    setNewMessage("");
    const { data } = await supabase.from("messages").select("*").eq("tenant", tenantData.name).order("created_at", { ascending: true });
    setMessages(data || []);
  }

  if (loading) return <Spinner />;
  if (!tenantData) return (
    <div className="text-center py-20">
      <div className="text-4xl mb-4">🏠</div>
      <div className="text-gray-600 font-medium">No tenant account linked to this email.</div>
      <div className="text-gray-400 text-sm mt-2">Contact your property manager to get access.</div>
    </div>
  );

  return (
    <div>
      <div className="bg-indigo-600 rounded-xl p-5 mb-5 text-white">
        <div className="text-lg font-bold">{tenantData.name}</div>
        <div className="text-indigo-200 text-sm">{tenantData.property}</div>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <div className="bg-indigo-700 rounded-lg p-3 text-center"><div className="text-xs text-indigo-300">Balance</div><div className={`text-lg font-bold ${tenantData.balance > 0 ? "text-red-300" : "text-green-300"}`}>{tenantData.balance > 0 ? `-$${tenantData.balance}` : tenantData.balance < 0 ? `+$${Math.abs(tenantData.balance)}` : "Current"}</div></div>
          <div className="bg-indigo-700 rounded-lg p-3 text-center"><div className="text-xs text-indigo-300">Monthly Rent</div><div className="text-lg font-bold">${tenantData.rent || "—"}</div></div>
          <div className="bg-indigo-700 rounded-lg p-3 text-center"><div className="text-xs text-indigo-300">Lease End</div><div className="text-sm font-bold">{tenantData.move_out || "—"}</div></div>
        </div>
      </div>
      <div className="flex gap-2 mb-5 border-b border-gray-100">
        {[["overview", "Overview"], ["ledger", "My Ledger"], ["messages", "Messages"]].map(([id, label]) => (
          <button key={id} onClick={() => setActiveTab(id)} className={`px-4 py-2 text-sm font-medium border-b-2 ${activeTab === id ? "border-indigo-600 text-indigo-700" : "border-transparent text-gray-500"}`}>{label}</button>
        ))}
      </div>
      {activeTab === "overview" && (
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <h3 className="font-semibold text-gray-700 mb-3">Lease Details</h3>
          {[["Status", tenantData.lease_status], ["Move-in", tenantData.move_in], ["Move-out", tenantData.move_out || "—"], ["Rent", `$${tenantData.rent}/mo`]].map(([l, v]) => (
            <div key={l} className="flex justify-between py-2 border-b border-gray-50 text-sm"><span className="text-gray-400">{l}</span><span className="font-medium text-gray-800 capitalize">{v}</span></div>
          ))}
        </div>
      )}
      {activeTab === "ledger" && (
        <div className="space-y-2">
          {ledger.map(e => (
            <div key={e.id} className="bg-white border border-gray-100 rounded-xl px-4 py-3">
              <div className="flex justify-between">
                <div><div className="text-sm font-medium text-gray-800">{e.description}</div><div className="text-xs text-gray-400">{e.date}</div></div>
                <div className="text-right"><div className={`text-sm font-bold ${e.amount > 0 ? "text-red-500" : "text-green-600"}`}>{e.amount > 0 ? `+$${e.amount}` : `-$${Math.abs(e.amount)}`}</div><div className="text-xs text-gray-400">Bal: ${e.balance}</div></div>
              </div>
            </div>
          ))}
          {ledger.length === 0 && <div className="text-center py-8 text-gray-400">No ledger entries yet</div>}
        </div>
      )}
      {activeTab === "messages" && (
        <div className="bg-white rounded-xl border border-gray-100">
          <div className="p-4 space-y-3 max-h-96 overflow-y-auto">
            {messages.map(m => (
              <div key={m.id} className={`flex ${m.sender !== tenantData.name ? "justify-start" : "justify-end"}`}>
                <div className={`max-w-xs rounded-2xl px-4 py-2.5 ${m.sender !== tenantData.name ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-800"}`}>
                  <div className="text-sm">{m.message}</div>
                  <div className={`text-xs mt-1 ${m.sender !== tenantData.name ? "text-indigo-200" : "text-gray-400"}`}>{m.sender} · {new Date(m.created_at).toLocaleDateString()}</div>
                </div>
              </div>
            ))}
            {messages.length === 0 && <div className="text-center py-6 text-gray-400 text-sm">No messages yet</div>}
          </div>
          <div className="p-3 border-t border-gray-100 flex gap-2">
            <input value={newMessage} onChange={e => setNewMessage(e.target.value)} onKeyDown={e => e.key === "Enter" && sendMessage()} placeholder="Message your landlord..." className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm" />
            <button onClick={sendMessage} className="bg-indigo-600 text-white px-4 py-2 rounded-xl text-sm">Send</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============ ROLE MANAGEMENT ============
function RoleManagement({ addNotification }) {
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
    const { data } = await supabase.from("app_users").select("*").order("created_at", { ascending: false });
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
    };

    if (editingUser) {
      const { error } = await supabase.from("app_users").update(payload).eq("id", editingUser.id);
      if (error) { alert("Error: " + error.message); return; }
      addNotification("👥", `${form.name}'s access updated`);
    } else {
      const { error } = await supabase.from("app_users").insert([payload]);
      if (error) { alert("Error: " + error.message); return; }
      addNotification("👥", `${form.name} added as ${ROLES[form.role]?.label}`);
    }

    setShowForm(false);
    setEditingUser(null);
    setForm({ email: "", role: "office_assistant", name: "" });
    setCustomPages([]);
    fetchUsers();
  }

  async function removeUser(id, name) {
    if (!window.confirm(`Remove ${name}?`)) return;
    await supabase.from("app_users").delete().eq("id", id);
    addNotification("👥", `${name} removed`);
    fetchUsers();
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
                  <button onClick={() => startEdit(u)} className="text-xs text-indigo-500 border border-indigo-200 px-2 py-1 rounded-lg hover:bg-indigo-50">
                    ✏️ Edit
                  </button>
                  <button onClick={() => removeUser(u.id, u.name)} className="text-xs text-red-400 hover:text-red-600 border border-red-100 px-2 py-1 rounded-lg hover:bg-red-50">
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
  latefees: LateFees,
  audittrail: AuditTrail,
  roles: RoleManagement,
  tenant_portal: TenantPortal,
};

// ============ AUDIT TRAIL (Admin Panel) ============
function AuditTrail() {
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
    const { data } = await supabase.from("audit_trail").select("*").order("created_at", { ascending: false }).limit(500);
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
    autopay: "🔁", latefees: "⏰",
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

export default function App() {
  const [screen, setScreen] = useState("landing");
  const [page, setPage] = useState("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [currentUser, setCurrentUser] = useState(null);
  const [userRole, setUserRole] = useState("admin");
  const [userProfile, setUserProfile] = useState(null);
  const [customAllowedPages, setCustomAllowedPages] = useState(null); // null = use role default

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) { setCurrentUser(session.user); setScreen("app"); fetchUserRole(session.user); }
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        setCurrentUser(session.user);
        setScreen("app");
        fetchUserRole(session.user);
      } else {
        setCurrentUser(null);
        setUserRole("admin");
        setScreen(prev => prev === "app" ? "landing" : prev);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  async function fetchUserRole(user) {
    if (!user?.email) return;
    try {
      const { data } = await supabase.from("app_users").select("*").eq("email", user.email).maybeSingle();
      if (data) {
        setUserRole(data.role);
        setUserProfile(data);
        // If the user has custom_pages saved, override the role default
        if (data.custom_pages) {
          try {
            const parsed = JSON.parse(data.custom_pages);
            if (Array.isArray(parsed)) setCustomAllowedPages(parsed);
          } catch { /* ignore invalid json */ }
        } else {
          setCustomAllowedPages(null); // use role default
        }
      } else {
        setUserRole("admin");
        setUserProfile({ name: user.email.split("@")[0], email: user.email, role: "admin" });
        setCustomAllowedPages(null);
      }
    } catch {
      // Table may not exist yet — default to admin
      setUserRole("admin");
      setUserProfile({ name: user.email.split("@")[0], email: user.email, role: "admin" });
      setCustomAllowedPages(null);
    }
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
  }

  if (screen === "landing") return <LandingPage onGetStarted={() => setScreen("login")} />;
  if (screen === "login") return <LoginPage onLogin={() => setScreen("app")} onBack={() => setScreen("landing")} />;

  // Build nav based on role
  // Use custom pages if set for this user, otherwise fall back to role default
  const allowedPages = customAllowedPages || ROLES[userRole]?.pages || ROLES.admin.pages;
  const navItems = ALL_NAV.filter(n => allowedPages.includes(n.id));

  // Add Roles page for admin only
  const adminNav = userRole === "admin"
    ? [...navItems, { id: "roles", label: "Team & Roles", icon: "👥" }]
    : navItems;

  // If tenant, show tenant portal
  const effectivePage = userRole === "tenant" ? "tenant_portal" : page;
  const Page = pageComponents[effectivePage] || Dashboard;

  // Redirect if page not allowed
  const safePage = allowedPages.includes(page) ? page : allowedPages[0];

  return (
    <div className="flex h-screen bg-gray-50 font-sans overflow-hidden">
      {/* Sidebar */}
      <div className={`${sidebarOpen ? "flex" : "hidden"} md:flex flex-col w-56 bg-white border-r border-gray-100 shadow-sm z-20 fixed md:relative h-full`}>
        <div className="px-5 py-4 border-b border-gray-100">
          <div className="text-lg font-bold text-indigo-700">🏡 PropManager</div>
          <div className="text-xs text-gray-400">Property Management</div>
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

          {/* Role Badge */}
          <span className={`hidden md:inline-block text-white text-xs px-2 py-0.5 rounded-full font-semibold ${ROLES[userRole]?.color || "bg-indigo-600"}`}>
            {ROLES[userRole]?.label}
          </span>

          {/* Notifications Bell */}
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
          <Page
            addNotification={addNotification}
            notifications={notifications}
            setPage={setPage}
            currentUser={currentUser}
            userRole={userRole}
            userProfile={userProfile}
          />
        </main>
      </div>

      {sidebarOpen && <div className="fixed inset-0 bg-black bg-opacity-20 z-10 md:hidden" onClick={() => setSidebarOpen(false)} />}
      {showNotifications && <div className="fixed inset-0 z-30" onClick={() => setShowNotifications(false)} />}
    </div>
  );
}
