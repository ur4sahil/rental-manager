import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabase";

// Safe number conversion - prevents NaN from breaking calculations
const safeNum = (val) => { const n = Number(val); return isNaN(n) ? 0 : n; };


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

const navItems = [
  { id: "dashboard", label: "Dashboard", icon: "⊞" },
  { id: "properties", label: "Properties", icon: "🏠" },
  { id: "tenants", label: "Tenants", icon: "👤" },
  { id: "payments", label: "Payments", icon: "💳" },
  { id: "maintenance", label: "Maintenance", icon: "🔧" },
  { id: "utilities", label: "Utilities", icon: "⚡" },
  { id: "accounting", label: "Accounting", icon: "📊" },
  { id: "documents", label: "Documents", icon: "📁" },
  { id: "inspections", label: "Inspections", icon: "🔍" },
];

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

// ============ PROPERTIES ============
function Properties({ addNotification }) {
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [showForm, setShowForm] = useState(false);
  const [editingProperty, setEditingProperty] = useState(null);
  const [timelineProperty, setTimelineProperty] = useState(null);
  const [timelineData, setTimelineData] = useState([]);
  const [form, setForm] = useState({ address: "", type: "Single Family", status: "vacant", rent: "", tenant: "", lease_end: "", notes: "" });

  useEffect(() => { fetchProperties(); }, []);

  async function fetchProperties() {
    const { data } = await supabase.from("properties").select("*");
    setProperties(data || []);
    setLoading(false);
  }

  async function saveProperty() {
    if (!form.address.trim()) { alert("Property address is required."); return; }
    if (!form.rent || isNaN(Number(form.rent))) { alert("Please enter a valid rent amount."); return; }
    const { error } = editingProperty
      ? await supabase.from("properties").update(form).eq("id", editingProperty.id)
      : await supabase.from("properties").insert([form]);
    if (error) { alert("Error saving property: " + error.message); return; }
    if (editingProperty) {
      addNotification("🏠", `Property updated: ${form.address}`);
    } else {
      addNotification("🏠", `New property added: ${form.address}`);
    }
    setShowForm(false);
    setEditingProperty(null);
    setForm({ address: "", type: "Single Family", status: "vacant", rent: "", tenant: "", lease_end: "", notes: "" });
    fetchProperties();
  }

  async function deleteProperty(id, address) {
    if (!window.confirm(`Delete property "${address}"? This cannot be undone.`)) return;
    const { error } = await supabase.from("properties").delete().eq("id", id);
    if (error) { alert("Error deleting property: " + error.message); return; }
    addNotification("🗑️", `Property deleted: ${address}`);
    fetchProperties();
  }

  function startEdit(p) {
    setEditingProperty(p);
    setForm({ address: p.address, type: p.type, status: p.status, rent: p.rent, tenant: p.tenant || "", lease_end: p.lease_end || "", notes: p.notes || "" });
    setShowForm(true);
  }

  async function openTimeline(p) {
    setTimelineProperty(p);
    const [payments, workOrders, docs] = await Promise.all([
      supabase.from("payments").select("*").eq("property", p.address),
      supabase.from("work_orders").select("*").eq("property", p.address),
      supabase.from("documents").select("*").eq("property", p.address),
    ]);
    const events = [
      ...(payments.data || []).map(x => ({ date: x.date, type: "💳 Payment", desc: `${x.tenant} — $${x.amount} (${x.status})` })),
      ...(workOrders.data || []).map(x => ({ date: x.created, type: "🔧 Maintenance", desc: `${x.issue} — ${x.status}` })),
      ...(docs.data || []).map(x => ({ date: x.uploaded_at?.slice(0, 10), type: "📄 Document", desc: x.name })),
    ].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    setTimelineData(events);
  }

  const filtered = properties.filter(p =>
    (filter === "all" || p.status === filter) &&
    p.address.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) return <Spinner />;

  return (
    <div>
      {/* Timeline Modal */}
      {timelineProperty && (
        <Modal title={`Timeline — ${timelineProperty.address}`} onClose={() => setTimelineProperty(null)}>
          {timelineData.length === 0 ? (
            <div className="text-center text-gray-400 py-8">No timeline events yet</div>
          ) : (
            <div className="space-y-3">
              {timelineData.map((e, i) => (
                <div key={i} className="flex gap-3 items-start">
                  <div className="w-2 h-2 rounded-full bg-indigo-400 mt-2 flex-shrink-0"></div>
                  <div className="flex-1 border-b border-gray-50 pb-3">
                    <div className="flex justify-between">
                      <span className="text-xs font-semibold text-indigo-600">{e.type}</span>
                      <span className="text-xs text-gray-400">{e.date}</span>
                    </div>
                    <div className="text-sm text-gray-700 mt-0.5">{e.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}

      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Properties</h2>
        <button onClick={() => { setEditingProperty(null); setForm({ address: "", type: "Single Family", status: "vacant", rent: "", tenant: "", lease_end: "", notes: "" }); setShowForm(!showForm); }} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">+ Add Property</button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-gray-700 mb-3">{editingProperty ? "Edit Property" : "New Property"}</h3>
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Address" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm col-span-2" />
            <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              {["Single Family", "Condo", "Townhouse"].map(t => <option key={t}>{t}</option>)}
            </select>
            <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              {["vacant", "occupied", "maintenance", "notice given"].map(s => <option key={s}>{s}</option>)}
            </select>
            <input placeholder="Rent amount" value={form.rent} onChange={e => setForm({ ...form, rent: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Tenant name" value={form.tenant} onChange={e => setForm({ ...form, tenant: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input type="date" placeholder="Lease end" value={form.lease_end} onChange={e => setForm({ ...form, lease_end: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <textarea placeholder="Notes" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm col-span-2" rows={2} />
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={saveProperty} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">Save</button>
            <button onClick={() => { setShowForm(false); setEditingProperty(null); }} className="bg-gray-100 text-gray-600 text-sm px-4 py-2 rounded-lg hover:bg-gray-200">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex gap-2 mb-4 flex-wrap">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search address..." className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm flex-1 min-w-0" />
        {["all", "occupied", "vacant", "maintenance", "notice given"].map(s => (
          <button key={s} onClick={() => setFilter(s)} className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize ${filter === s ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{s}</button>
        ))}
      </div>
      <div className="space-y-3">
        {filtered.map(p => (
          <div key={p.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <div className="flex justify-between items-start">
              <div>
                <div className="font-semibold text-gray-800">{p.address}</div>
                <div className="text-xs text-gray-400 mt-0.5">{p.type}</div>
              </div>
              <Badge status={p.status} />
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <div><span className="text-gray-400">Rent</span><div className="font-semibold text-gray-700">${p.rent}/mo</div></div>
              <div><span className="text-gray-400">Tenant</span><div className="font-semibold text-gray-700">{p.tenant || "—"}</div></div>
              <div><span className="text-gray-400">Lease End</span><div className="font-semibold text-gray-700">{p.lease_end || "—"}</div></div>
            </div>
            {p.notes && <div className="mt-2 text-xs text-gray-400 italic">{p.notes}</div>}
            <div className="mt-3 flex gap-2 flex-wrap">
              <button onClick={() => openTimeline(p)} className="text-xs text-indigo-600 border border-indigo-200 px-3 py-1 rounded-lg hover:bg-indigo-50">📅 Timeline</button>
              <button onClick={() => startEdit(p)} className="text-xs text-blue-600 border border-blue-200 px-3 py-1 rounded-lg hover:bg-blue-50">✏️ Edit</button>
              <button onClick={() => deleteProperty(p.id, p.address)} className="text-xs text-red-500 border border-red-200 px-3 py-1 rounded-lg hover:bg-red-50">🗑️ Delete</button>
              {p.status === "vacant" && <button className="text-xs text-green-600 border border-green-200 px-3 py-1 rounded-lg hover:bg-green-50">List on Zillow</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============ TENANTS ============
function Tenants({ addNotification }) {
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
    } else {
      addNotification("👤", `New tenant added: ${form.name}`);
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
            <select value={form.property} onChange={e => setForm({ ...form, property: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
              <option value="">Select property...</option>
              {properties.map(p => <option key={p.id} value={p.address}>{p.address}</option>)}
            </select>
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
function Payments({ addNotification }) {
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
    addNotification("💳", `Payment recorded: $${form.amount} from ${form.tenant}`);
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
            <input placeholder="Property" value={form.property} onChange={e => setForm({ ...form, property: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
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
function Maintenance({ addNotification }) {
  const [workOrders, setWorkOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [showForm, setShowForm] = useState(false);
  const [editingWO, setEditingWO] = useState(null);
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
    } else {
      addNotification("🔧", `New work order: ${form.issue} at ${form.property}`);
    }
    setShowForm(false);
    setEditingWO(null);
    setForm({ property: "", tenant: "", issue: "", priority: "normal", status: "open", assigned: "", cost: 0, notes: "" });
    fetchWorkOrders();
  }

  async function updateStatus(wo, newStatus) {
    const { error } = await supabase.from("work_orders").update({ status: newStatus }).eq("id", wo.id);
    if (error) { alert("Error updating status: " + error.message); return; }
    addNotification("🔧", `Work order "${wo.issue}" marked as ${newStatus.replace("_", " ")}`);
    fetchWorkOrders();
  }

  function startEdit(w) {
    setEditingWO(w);
    setForm({ property: w.property, tenant: w.tenant, issue: w.issue, priority: w.priority, status: w.status, assigned: w.assigned || "", cost: w.cost || 0, notes: w.notes || "" });
    setShowForm(true);
  }

  if (loading) return <Spinner />;

  const filtered = filter === "all" ? workOrders : workOrders.filter(w => w.status === filter || w.priority === filter);

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Maintenance & Work Orders</h2>
        <button onClick={() => { setEditingWO(null); setForm({ property: "", tenant: "", issue: "", priority: "normal", status: "open", assigned: "", cost: 0, notes: "" }); setShowForm(!showForm); }} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">+ New Work Order</button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-gray-700 mb-3">{editingWO ? "Edit Work Order" : "New Work Order"}</h3>
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Property" value={form.property} onChange={e => setForm({ ...form, property: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
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
              <button onClick={() => startEdit(w)} className="text-xs text-blue-600 border border-blue-200 px-3 py-1 rounded-lg hover:bg-blue-50">✏️ Edit</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============ UTILITIES ============
function Utilities({ addNotification }) {
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
            <input placeholder="Property" value={form.property} onChange={e => setForm({ ...form, property: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
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

// ============ ACCOUNTING ============
function Accounting() {
  const [entries, setEntries] = useState([]);
  const [payments, setPayments] = useState([]);
  const [workOrders, setWorkOrders] = useState([]);
  const [utilities, setUtilities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeReport, setActiveReport] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [showJournal, setShowJournal] = useState(false);
  const [editEntry, setEditEntry] = useState(null);
  const [form, setForm] = useState({ date: "", account: "", description: "", debit: 0, credit: 0 });
  const [filterAccount, setFilterAccount] = useState("all");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterType, setFilterType] = useState("all");
  const [searchDesc, setSearchDesc] = useState("");

  useEffect(() => {
    async function fetchData() {
      const [e, p, w, u] = await Promise.all([
        supabase.from("journal_entries").select("*").order("date", { ascending: false }),
        supabase.from("payments").select("*"),
        supabase.from("work_orders").select("*"),
        supabase.from("utilities").select("*"),
      ]);
      setEntries(e.data || []);
      setPayments(p.data || []);
      setWorkOrders(w.data || []);
      setUtilities(u.data || []);
      setLoading(false);
    }
    fetchData();
  }, []);

  async function saveEntry() {
    if (!form.date) { alert("Date is required."); return; }
    if (!form.account.trim()) { alert("Account is required."); return; }
    if (!form.description.trim()) { alert("Description is required."); return; }
    const { error } = editEntry
      ? await supabase.from("journal_entries").update(form).eq("id", editEntry.id)
      : await supabase.from("journal_entries").insert([form]);
    if (error) { alert("Error saving entry: " + error.message); return; }
    const { data } = await supabase.from("journal_entries").select("*").order("date", { ascending: false });
    setEntries(data || []);
    setShowJournal(false);
    setEditEntry(null);
    setForm({ date: "", account: "", description: "", debit: 0, credit: 0 });
  }

  async function deleteEntry(id) {
    if (!window.confirm("Delete this entry?")) return;
    const { error } = await supabase.from("journal_entries").delete().eq("id", id);
    if (error) { alert("Error deleting entry: " + error.message); return; }
    setEntries(entries.filter(e => e.id !== id));
  }

  function startEdit(entry) {
    setEditEntry(entry);
    setForm({ date: entry.date, account: entry.account, description: entry.description, debit: entry.debit, credit: entry.credit });
    setShowJournal(true);
  }

  if (loading) return <Spinner />;

  const totalIncome = payments.filter(p => p.status === "paid").reduce((s, p) => s + safeNum(p.amount), 0);
  const totalMaintenance = workOrders.reduce((s, w) => s + safeNum(w.cost), 0);
  const totalUtilities = utilities.reduce((s, u) => s + safeNum(u.amount), 0);
  const noi = totalIncome - totalMaintenance - totalUtilities;
  const unpaidRent = payments.filter(p => p.status === "unpaid" || p.status === "partial").reduce((s, p) => s + safeNum(p.amount), 0);

  const uniqueAccounts = ["all", ...new Set(entries.map(e => e.account))];
  const filteredEntries = entries.filter(e => {
    if (filterAccount !== "all" && e.account !== filterAccount) return false;
    if (filterType === "debit" && e.debit <= 0) return false;
    if (filterType === "credit" && e.credit <= 0) return false;
    if (filterDateFrom && e.date < filterDateFrom) return false;
    if (filterDateTo && e.date > filterDateTo) return false;
    if (searchDesc && !e.description?.toLowerCase().includes(searchDesc.toLowerCase())) return false;
    return true;
  });

  const filteredDebits = filteredEntries.reduce((s, e) => s + safeNum(e.debit), 0);
  const filteredCredits = filteredEntries.reduce((s, e) => s + safeNum(e.credit), 0);

  const monthlyData = payments.reduce((acc, p) => {
    const month = p.date?.slice(0, 7);
    if (!month) return acc;
    if (!acc[month]) acc[month] = { income: 0, expenses: 0 };
    if (p.status === "paid") acc[month].income += Number(p.amount);
    return acc;
  }, {});
  workOrders.forEach(w => {
    const month = w.created?.slice(0, 7);
    if (month && monthlyData[month]) monthlyData[month].expenses += Number(w.cost || 0);
  });

  const reports = [
    { name: "Rent Roll", icon: "📋" },
    { name: "Delinquency Report", icon: "⚠️" },
    { name: "Income Statement", icon: "📈" },
    { name: "Balance Sheet", icon: "⚖️" },
    { name: "Cash Flow", icon: "💵" },
    { name: "Expense Tracking", icon: "🧾" },
  ];

  const renderReport = () => {
    if (!activeReport) return null;
    let content;

    if (activeReport === "Rent Roll") {
      const rentPayments = payments.filter(p => p.type === "rent");
      const totalExpected = rentPayments.reduce((s, p) => s + safeNum(p.amount), 0);
      const totalPaid = rentPayments.filter(p => p.status === "paid").reduce((s, p) => s + safeNum(p.amount), 0);
      content = (
        <div>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-green-50 rounded-lg p-3 text-center"><div className="text-xs text-gray-400">Expected</div><div className="text-lg font-bold text-green-600">${totalExpected.toLocaleString()}</div></div>
            <div className="bg-blue-50 rounded-lg p-3 text-center"><div className="text-xs text-gray-400">Collected</div><div className="text-lg font-bold text-blue-600">${totalPaid.toLocaleString()}</div></div>
            <div className="bg-red-50 rounded-lg p-3 text-center"><div className="text-xs text-gray-400">Outstanding</div><div className="text-lg font-bold text-red-500">${(totalExpected - totalPaid).toLocaleString()}</div></div>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
              <tr>{["Tenant", "Property", "Rent", "Date", "Method", "Status"].map(h => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
            </thead>
            <tbody>
              {rentPayments.map(p => (
                <tr key={p.id} className="border-t border-gray-50 hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium">{p.tenant}</td>
                  <td className="px-3 py-2 text-gray-500">{p.property}</td>
                  <td className="px-3 py-2 font-semibold">${p.amount}</td>
                  <td className="px-3 py-2 text-gray-500">{p.date}</td>
                  <td className="px-3 py-2 text-gray-500">{p.method}</td>
                  <td className="px-3 py-2"><Badge status={p.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    } else if (activeReport === "Delinquency Report") {
      const delinquent = payments.filter(p => p.status === "unpaid" || p.status === "partial");
      const total = delinquent.reduce((s, p) => s + safeNum(p.amount), 0);
      content = (
        <div>
          <div className="bg-red-50 border border-red-100 rounded-lg p-3 mb-4 flex justify-between items-center">
            <span className="text-sm font-medium text-red-700">Total Delinquent Amount</span>
            <span className="text-xl font-bold text-red-600">${total.toLocaleString()}</span>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
              <tr>{["Tenant", "Property", "Amount Owed", "Type", "Due Date", "Status"].map(h => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
            </thead>
            <tbody>
              {delinquent.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">🎉 No delinquent payments!</td></tr>
              ) : delinquent.map(p => (
                <tr key={p.id} className="border-t border-gray-50">
                  <td className="px-3 py-2 font-medium">{p.tenant}</td>
                  <td className="px-3 py-2 text-gray-500">{p.property}</td>
                  <td className="px-3 py-2 font-semibold text-red-500">${p.amount}</td>
                  <td className="px-3 py-2 capitalize">{p.type?.replace("_", " ")}</td>
                  <td className="px-3 py-2 text-gray-500">{p.date}</td>
                  <td className="px-3 py-2"><Badge status={p.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    } else if (activeReport === "Income Statement") {
      content = (
        <div className="space-y-4 text-sm">
          <div className="bg-green-50 rounded-lg p-4">
            <div className="font-bold text-gray-700 mb-2">REVENUE</div>
            {payments.filter(p => p.status === "paid").map(p => (
              <div key={p.id} className="flex justify-between py-1 text-gray-600">
                <span className="pl-3">{p.type?.replace("_", " ")} — {p.tenant}</span>
                <span className="text-green-600">${safeNum(p.amount).toLocaleString()}</span>
              </div>
            ))}
            <div className="flex justify-between pt-2 border-t border-green-200 font-bold"><span>Total Revenue</span><span className="text-green-600">${totalIncome.toLocaleString()}</span></div>
          </div>
          <div className="bg-red-50 rounded-lg p-4">
            <div className="font-bold text-gray-700 mb-2">EXPENSES</div>
            {workOrders.filter(w => w.cost > 0).map(w => (
              <div key={w.id} className="flex justify-between py-1 text-gray-600">
                <span className="pl-3">Maintenance — {w.issue}</span>
                <span className="text-red-500">-${w.cost}</span>
              </div>
            ))}
            {utilities.map(u => (
              <div key={u.id} className="flex justify-between py-1 text-gray-600">
                <span className="pl-3">Utility — {u.provider}</span>
                <span className="text-red-500">-${u.amount}</span>
              </div>
            ))}
            <div className="flex justify-between pt-2 border-t border-red-200 font-bold"><span>Total Expenses</span><span className="text-red-500">-${(totalMaintenance + totalUtilities).toLocaleString()}</span></div>
          </div>
          <div className="bg-blue-50 rounded-lg p-4 flex justify-between font-bold text-lg">
            <span className="text-gray-800">Net Operating Income</span>
            <span className={noi >= 0 ? "text-blue-700" : "text-red-600"}>${noi.toLocaleString()}</span>
          </div>
        </div>
      );
    } else if (activeReport === "Balance Sheet") {
      const totalAssets = 42800 + totalIncome;
      const totalLiabilities = 7500;
      content = (
        <div className="space-y-4 text-sm">
          <div className="bg-green-50 rounded-lg p-4">
            <div className="font-bold text-gray-700 mb-2">ASSETS</div>
            {[["Operating Account", "$42,800"], ["Rent Receivable", `$${totalIncome.toLocaleString()}`], ["Security Deposits Held", "$7,500"]].map(([l, v]) => (
              <div key={l} className="flex justify-between py-1 text-gray-600"><span className="pl-3">{l}</span><span className="text-green-600">{v}</span></div>
            ))}
            <div className="flex justify-between pt-2 border-t border-green-200 font-bold"><span>Total Assets</span><span className="text-green-600">${totalAssets.toLocaleString()}</span></div>
          </div>
          <div className="bg-red-50 rounded-lg p-4">
            <div className="font-bold text-gray-700 mb-2">LIABILITIES</div>
            <div className="flex justify-between py-1 text-gray-600"><span className="pl-3">Security Deposits Payable</span><span className="text-red-500">$7,500</span></div>
            <div className="flex justify-between pt-2 border-t border-red-200 font-bold"><span>Total Liabilities</span><span className="text-red-500">${totalLiabilities.toLocaleString()}</span></div>
          </div>
          <div className="bg-blue-50 rounded-lg p-4 flex justify-between font-bold text-lg">
            <span className="text-gray-800">Net Assets (Equity)</span>
            <span className="text-blue-700">${(totalAssets - totalLiabilities).toLocaleString()}</span>
          </div>
        </div>
      );
    } else if (activeReport === "Cash Flow") {
      content = (
        <div className="space-y-4 text-sm">
          <div className="bg-green-50 rounded-lg p-4">
            <div className="font-bold text-gray-700 mb-2">OPERATING INFLOWS</div>
            {payments.filter(p => p.status === "paid").map(p => (
              <div key={p.id} className="flex justify-between py-1 text-gray-600">
                <span className="pl-3">{p.tenant} — {p.method}</span>
                <span className="text-green-600">+${safeNum(p.amount).toLocaleString()}</span>
              </div>
            ))}
            <div className="flex justify-between pt-2 border-t border-green-200 font-bold"><span>Total Inflows</span><span className="text-green-600">+${totalIncome.toLocaleString()}</span></div>
          </div>
          <div className="bg-red-50 rounded-lg p-4">
            <div className="font-bold text-gray-700 mb-2">OPERATING OUTFLOWS</div>
            {workOrders.filter(w => w.cost > 0).map(w => (
              <div key={w.id} className="flex justify-between py-1 text-gray-600">
                <span className="pl-3">{w.issue}</span>
                <span className="text-red-500">-${w.cost}</span>
              </div>
            ))}
            {utilities.map(u => (
              <div key={u.id} className="flex justify-between py-1 text-gray-600">
                <span className="pl-3">{u.provider}</span>
                <span className="text-red-500">-${u.amount}</span>
              </div>
            ))}
            <div className="flex justify-between pt-2 border-t border-red-200 font-bold"><span>Total Outflows</span><span className="text-red-500">-${(totalMaintenance + totalUtilities).toLocaleString()}</span></div>
          </div>
          <div className="bg-blue-50 rounded-lg p-4 flex justify-between font-bold text-lg">
            <span className="text-gray-800">Net Cash Flow</span>
            <span className={noi >= 0 ? "text-blue-700" : "text-red-600"}>${noi.toLocaleString()}</span>
          </div>
        </div>
      );
    } else if (activeReport === "Expense Tracking") {
      const allExpenses = [
        ...workOrders.filter(w => w.cost > 0).map(w => ({ desc: w.issue, property: w.property, amount: Number(w.cost), type: "Maintenance", date: w.created, vendor: w.assigned })),
        ...utilities.map(u => ({ desc: u.provider, property: u.property, amount: Number(u.amount), type: "Utility", date: u.due, vendor: u.provider })),
      ].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      const totalExp = allExpenses.reduce((s, e) => s + e.amount, 0);
      const byType = allExpenses.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + e.amount; return acc; }, {});
      content = (
        <div>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-red-50 rounded-lg p-3 text-center"><div className="text-xs text-gray-400">Total</div><div className="text-lg font-bold text-red-500">${totalExp.toLocaleString()}</div></div>
            {Object.entries(byType).map(([type, amt]) => (
              <div key={type} className="bg-gray-50 rounded-lg p-3 text-center"><div className="text-xs text-gray-400">{type}</div><div className="text-lg font-bold text-gray-700">${amt.toLocaleString()}</div></div>
            ))}
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
              <tr>{["Date", "Description", "Property", "Vendor", "Type", "Amount"].map(h => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
            </thead>
            <tbody>
              {allExpenses.map((e, i) => (
                <tr key={i} className="border-t border-gray-50 hover:bg-gray-50">
                  <td className="px-3 py-2 text-gray-500">{e.date}</td>
                  <td className="px-3 py-2 font-medium">{e.desc}</td>
                  <td className="px-3 py-2 text-gray-500">{e.property}</td>
                  <td className="px-3 py-2 text-gray-500">{e.vendor || "—"}</td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-xs ${e.type === "Maintenance" ? "bg-orange-50 text-orange-600" : "bg-blue-50 text-blue-600"}`}>{e.type}</span></td>
                  <td className="px-3 py-2 font-semibold text-red-500">${e.amount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    return (
      <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 sticky top-0 bg-white">
            <h3 className="font-bold text-gray-800 text-lg">{activeReport}</h3>
            <div className="flex gap-2">
              <button onClick={() => window.print()} className="text-xs bg-indigo-50 text-indigo-600 px-3 py-1.5 rounded-lg hover:bg-indigo-100">🖨️ Print</button>
              <button onClick={() => setActiveReport(null)} className="text-gray-400 hover:text-gray-600 text-xl ml-2">✕</button>
            </div>
          </div>
          <div className="p-6">{content}</div>
        </div>
      </div>
    );
  };

  return (
    <div>
      {renderReport()}
      <h2 className="text-xl font-bold text-gray-800 mb-5">Accounting & Financials</h2>
      <div className="flex gap-2 mb-5 border-b border-gray-100">
        {[["overview", "Overview"], ["ledger", "General Ledger"], ["reports", "Reports"], ["reconcile", "Reconciliation"]].map(([id, label]) => (
          <button key={id} onClick={() => setActiveTab(id)} className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === id ? "border-indigo-600 text-indigo-700" : "border-transparent text-gray-500 hover:text-gray-700"}`}>{label}</button>
        ))}
      </div>

      {activeTab === "overview" && (
        <div>
          <div className="grid grid-cols-2 gap-3 mb-5 md:grid-cols-4">
            <StatCard label="Total Income" value={`$${totalIncome.toLocaleString()}`} color="text-green-600" sub="rent collected" />
            <StatCard label="Total Expenses" value={`$${(totalMaintenance + totalUtilities).toLocaleString()}`} color="text-red-500" sub="maintenance + utilities" />
            <StatCard label="NOI" value={`$${noi.toLocaleString()}`} color="text-blue-700" sub="net operating income" />
            <StatCard label="Unpaid Rent" value={`$${unpaidRent.toLocaleString()}`} color="text-orange-500" sub="outstanding balance" />
          </div>
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 mb-4">
            <h3 className="font-semibold text-gray-700 mb-3">Monthly Summary</h3>
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-400 uppercase">
                <tr>{["Month", "Income", "Expenses", "Net"].map(h => <th key={h} className="text-left pb-2 px-2">{h}</th>)}</tr>
              </thead>
              <tbody>
                {Object.entries(monthlyData).sort((a, b) => b[0] > a[0] ? 1 : -1).map(([month, data]) => (
                  <tr key={month} className="border-t border-gray-50 hover:bg-gray-50">
                    <td className="py-2 px-2 font-medium text-gray-800">{month}</td>
                    <td className="py-2 px-2 text-green-600 font-semibold">${data.income.toLocaleString()}</td>
                    <td className="py-2 px-2 text-red-500 font-semibold">${data.expenses.toLocaleString()}</td>
                    <td className={`py-2 px-2 font-bold ${data.income - data.expenses >= 0 ? "text-blue-700" : "text-red-600"}`}>${(data.income - data.expenses).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <h3 className="font-semibold text-gray-700 mb-3">Chart of Accounts</h3>
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-400 uppercase">
                <tr>{["Account", "Type", "Balance"].map(h => <th key={h} className={`pb-2 ${h === "Balance" ? "text-right" : "text-left"}`}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {[
                  { name: "Rental Income", type: "Revenue", balance: totalIncome },
                  { name: "Security Deposits Liability", type: "Liability", balance: -7500 },
                  { name: "Maintenance Expense", type: "Expense", balance: -totalMaintenance },
                  { name: "Utility Expense", type: "Expense", balance: -totalUtilities },
                  { name: "Operating Account", type: "Asset", balance: 42800 },
                ].map(a => (
                  <tr key={a.name} className="border-t border-gray-50 hover:bg-gray-50">
                    <td className="py-2 text-gray-800 font-medium">{a.name}</td>
                    <td className="py-2"><span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{a.type}</span></td>
                    <td className={`py-2 text-right font-semibold ${a.balance < 0 ? "text-red-500" : "text-green-600"}`}>${Math.abs(a.balance).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === "ledger" && (
        <div>
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-gray-700">Filters</h3>
              <button onClick={() => { setFilterAccount("all"); setFilterType("all"); setFilterDateFrom(""); setFilterDateTo(""); setSearchDesc(""); }} className="text-xs text-gray-400 hover:text-red-500">Clear All</button>
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <select value={filterAccount} onChange={e => setFilterAccount(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
                {uniqueAccounts.map(a => <option key={a}>{a}</option>)}
              </select>
              <select value={filterType} onChange={e => setFilterType(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
                <option value="all">All Types</option>
                <option value="debit">Debits Only</option>
                <option value="credit">Credits Only</option>
              </select>
              <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
              <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            </div>
            <input value={searchDesc} onChange={e => setSearchDesc(e.target.value)} placeholder="Search description..." className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full mt-2" />
          </div>
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm text-gray-500">{filteredEntries.length} entries · Debits: <span className="text-red-500 font-semibold">${filteredDebits.toLocaleString()}</span> · Credits: <span className="text-green-600 font-semibold">${filteredCredits.toLocaleString()}</span></div>
              <button onClick={() => { setEditEntry(null); setForm({ date: "", account: "", description: "", debit: 0, credit: 0 }); setShowJournal(!showJournal); }} className="bg-indigo-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-indigo-700">+ Journal Entry</button>
            </div>
            {showJournal && (
              <div className="bg-indigo-50 rounded-lg p-3 mb-3 border border-indigo-100">
                <h4 className="text-sm font-semibold text-indigo-700 mb-2">{editEntry ? "Edit Entry" : "New Journal Entry"}</h4>
                <div className="grid grid-cols-2 gap-2">
                  <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  <input placeholder="Account" value={form.account} onChange={e => setForm({ ...form, account: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  <input placeholder="Description" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm col-span-2" />
                  <input placeholder="Debit ($)" value={form.debit} onChange={e => setForm({ ...form, debit: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  <input placeholder="Credit ($)" value={form.credit} onChange={e => setForm({ ...form, credit: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                </div>
                <div className="flex gap-2 mt-2">
                  <button onClick={saveEntry} className="bg-indigo-600 text-white text-xs px-3 py-1.5 rounded-lg">{editEntry ? "Update" : "Save"}</button>
                  <button onClick={() => { setShowJournal(false); setEditEntry(null); }} className="bg-gray-200 text-gray-600 text-xs px-3 py-1.5 rounded-lg">Cancel</button>
                </div>
              </div>
            )}
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-400 uppercase bg-gray-50">
                <tr>{["Date", "Account", "Description", "Debit", "Credit", ""].map(h => <th key={h} className="text-left py-2 px-2">{h}</th>)}</tr>
              </thead>
              <tbody>
                {filteredEntries.map(e => (
                  <tr key={e.id} className="border-t border-gray-50 hover:bg-gray-50">
                    <td className="py-2 px-2 text-gray-500">{e.date}</td>
                    <td className="py-2 px-2 font-medium text-gray-800">{e.account}</td>
                    <td className="py-2 px-2 text-gray-500">{e.description}</td>
                    <td className="py-2 px-2 text-red-500 font-semibold">{e.debit > 0 ? `$${e.debit}` : "—"}</td>
                    <td className="py-2 px-2 text-green-600 font-semibold">{e.credit > 0 ? `$${e.credit}` : "—"}</td>
                    <td className="py-2 px-2 flex gap-2">
                      <button onClick={() => startEdit(e)} className="text-xs text-indigo-600 hover:underline">Edit</button>
                      <button onClick={() => deleteEntry(e.id)} className="text-xs text-red-400 hover:underline">Delete</button>
                    </td>
                  </tr>
                ))}
                {filteredEntries.length === 0 && (
                  <tr><td colSpan={6} className="py-6 text-center text-gray-400">No entries match your filters</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === "reports" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {reports.map(r => (
            <button key={r.name} onClick={() => setActiveReport(r.name)} className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 text-left hover:border-indigo-300 hover:shadow-md transition-all group">
              <div className="text-3xl mb-2">{r.icon}</div>
              <div className="font-semibold text-gray-800 group-hover:text-indigo-700">{r.name}</div>
              <div className="text-xs text-gray-400 mt-1">Click to view full report →</div>
            </button>
          ))}
        </div>
      )}

      {activeTab === "reconcile" && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
          <h3 className="font-semibold text-gray-700 mb-4">Bank Reconciliation</h3>
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-gray-50 rounded-lg p-4 text-center">
              <div className="text-xs text-gray-400 mb-1">Bank Statement Balance</div>
              <div className="text-2xl font-bold text-gray-800">$42,800</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-4 text-center">
              <div className="text-xs text-gray-400 mb-1">Book Balance</div>
              <div className="text-2xl font-bold text-gray-800">${totalIncome.toLocaleString()}</div>
            </div>
            <div className={`rounded-lg p-4 text-center ${42800 - totalIncome === 0 ? "bg-green-50" : "bg-orange-50"}`}>
              <div className="text-xs text-gray-400 mb-1">Difference</div>
              <div className={`text-2xl font-bold ${42800 - totalIncome === 0 ? "text-green-600" : "text-orange-500"}`}>${Math.abs(42800 - totalIncome).toLocaleString()}</div>
            </div>
          </div>
          <div className="space-y-2">
            <h4 className="font-medium text-gray-700 text-sm">Unreconciled Items</h4>
            {payments.filter(p => p.status === "unpaid" || p.status === "partial").map(p => (
              <div key={p.id} className="flex items-center justify-between bg-orange-50 rounded-lg px-4 py-2.5">
                <div>
                  <div className="text-sm font-medium text-gray-800">{p.tenant}</div>
                  <div className="text-xs text-gray-400">{p.property} · {p.date}</div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-orange-600">${p.amount}</span>
                  <button className="text-xs bg-white border border-gray-200 text-gray-600 px-3 py-1 rounded-lg hover:bg-green-50 hover:text-green-600 hover:border-green-200">Mark Reconciled</button>
                </div>
              </div>
            ))}
            {payments.filter(p => p.status === "unpaid" || p.status === "partial").length === 0 && (
              <div className="text-center py-4 text-gray-400 text-sm">🎉 All items reconciled!</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============ DOCUMENTS ============
function Documents({ addNotification }) {
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
    const { error: uploadError } = await supabase.storage.from("documents").upload(fileName, file);
    if (uploadError) {
      alert("Upload failed: " + uploadError.message);
      setUploading(false);
      return;
    }
    const { data: { publicUrl } } = supabase.storage.from("documents").getPublicUrl(fileName);
    await supabase.from("documents").insert([{
      name: form.name,
      property: form.property,
      type: form.type,
      tenant_visible: form.tenant_visible,
      file_url: publicUrl,
      uploaded_at: new Date().toISOString(),
    }]);
    addNotification("📄", `Document uploaded: ${form.name}`);
    setShowForm(false);
    setForm({ name: "", property: "", type: "Lease", tenant_visible: false });
    setUploading(false);
    fetchDocs();
  }

  async function deleteDoc(id, name) {
    if (!window.confirm(`Delete "${name}"?`)) return;
    const { error } = await supabase.from("documents").delete().eq("id", id);
    if (error) { alert("Error deleting document: " + error.message); return; }
    addNotification("🗑️", `Document deleted: ${name}`);
    fetchDocs();
  }

  if (loading) return <Spinner />;

  const filtered = filter === "all" ? docs : docs.filter(d => d.type === filter);

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Document Management</h2>
        <button onClick={() => setShowForm(!showForm)} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">+ Upload Document</button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-indigo-100 shadow-sm p-4 mb-4">
          <h3 className="font-semibold text-gray-700 mb-3">Upload Document</h3>
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Document name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Property address" value={form.property} onChange={e => setForm({ ...form, property: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
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
                    {d.file_url && <a href={d.file_url} target="_blank" rel="noreferrer" className="text-xs text-indigo-600 hover:underline">View</a>}
                    <button onClick={() => deleteDoc(d.id, d.name)} className="text-xs text-red-400 hover:underline">Delete</button>
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
function Inspections({ addNotification }) {
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
            <input placeholder="Property address" value={form.property} onChange={e => setForm({ ...form, property: e.target.value })} className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
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
};

export default function App() {
  const [screen, setScreen] = useState("landing");
  const [page, setPage] = useState("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  // Check for existing Supabase session on load
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setScreen("app");
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        setScreen("app");
      } else {
        setScreen(prev => prev === "app" ? "landing" : prev);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

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
  }

  if (screen === "landing") return <LandingPage onGetStarted={() => setScreen("login")} />;
  if (screen === "login") return <LoginPage onLogin={() => setScreen("app")} onBack={() => setScreen("landing")} />;

  const Page = pageComponents[page];

  return (
    <div className="flex h-screen bg-gray-50 font-sans overflow-hidden">
      {/* Sidebar */}
      <div className={`${sidebarOpen ? "flex" : "hidden"} md:flex flex-col w-56 bg-white border-r border-gray-100 shadow-sm z-20 fixed md:relative h-full`}>
        <div className="px-5 py-4 border-b border-gray-100">
          <div className="text-lg font-bold text-indigo-700">🏡 PropManager</div>
          <div className="text-xs text-gray-400">Property Management</div>
        </div>
        <nav className="flex-1 py-3 overflow-y-auto">
          {navItems.map(n => (
            <button key={n.id} onClick={() => { setPage(n.id); setSidebarOpen(false); }}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors ${page === n.id ? "bg-indigo-50 text-indigo-700 font-semibold border-r-2 border-indigo-600" : "text-gray-600 hover:bg-gray-50"}`}>
              <span>{n.icon}</span>{n.label}
            </button>
          ))}
        </nav>
        <div className="px-4 py-3 border-t border-gray-100">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xs font-bold">A</div>
              <div><div className="text-xs font-semibold text-gray-700">Admin</div><div className="text-xs text-gray-400">Landlord</div></div>
            </div>
            <button onClick={handleLogout} className="text-xs text-gray-400 hover:text-red-500">Logout</button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3">
          <button className="md:hidden text-gray-500 text-xl" onClick={() => setSidebarOpen(!sidebarOpen)}>☰</button>
          <div className="flex-1 text-sm text-gray-400 capitalize">{page}</div>

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
          />
        </main>
      </div>

      {sidebarOpen && <div className="fixed inset-0 bg-black bg-opacity-20 z-10 md:hidden" onClick={() => setSidebarOpen(false)} />}
      {showNotifications && <div className="fixed inset-0 z-40" onClick={() => setShowNotifications(false)} />}
    </div>
  );
}
