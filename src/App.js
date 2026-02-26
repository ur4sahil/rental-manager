import { useState } from "react";

// ============ MOCK DATA ============
const mockProperties = [
  { id: 1, address: "123 Oak St", type: "Single Family", status: "occupied", rent: 1800, tenant: "Maria Johnson", leaseEnd: "2025-12-31", lastInspection: "2024-09-01" },
  { id: 2, address: "456 Elm Ave #2B", type: "Condo", status: "vacant", rent: 1400, tenant: null, leaseEnd: null, lastInspection: "2024-11-15" },
  { id: 3, address: "789 Maple Dr", type: "Townhouse", status: "maintenance", rent: 2100, tenant: "James Carter", leaseEnd: "2025-08-15", lastInspection: "2024-08-20" },
  { id: 4, address: "321 Pine Rd", type: "Single Family", status: "notice given", rent: 1950, tenant: "Sara Patel", leaseEnd: "2025-03-31", lastInspection: "2024-10-10" },
  { id: 5, address: "654 Birch Blvd", type: "Condo", status: "occupied", rent: 1600, tenant: "Tom Williams", leaseEnd: "2025-10-01", lastInspection: "2024-12-01" },
];

const mockTenants = [
  { id: 1, name: "Maria Johnson", email: "maria@email.com", phone: "555-0101", property: "123 Oak St", balance: 0, leaseStatus: "active", moveIn: "2024-01-01", moveOut: null },
  { id: 2, name: "James Carter", email: "james@email.com", phone: "555-0102", property: "789 Maple Dr", balance: 150, leaseStatus: "active", moveIn: "2023-09-01", moveOut: null },
  { id: 3, name: "Sara Patel", email: "sara@email.com", phone: "555-0103", property: "321 Pine Rd", balance: 0, leaseStatus: "notice", moveIn: "2023-04-01", moveOut: "2025-03-31" },
  { id: 4, name: "Tom Williams", email: "tom@email.com", phone: "555-0104", property: "654 Birch Blvd", balance: -200, leaseStatus: "active", moveIn: "2024-11-01", moveOut: null },
];

const mockWorkOrders = [
  { id: 1, property: "789 Maple Dr", tenant: "James Carter", issue: "HVAC not working", priority: "emergency", status: "in_progress", created: "2025-02-20", assigned: "Bob's HVAC", cost: 450 },
  { id: 2, property: "123 Oak St", tenant: "Maria Johnson", issue: "Leaky faucet in kitchen", priority: "normal", status: "open", created: "2025-02-22", assigned: null, cost: 0 },
  { id: 3, property: "654 Birch Blvd", tenant: "Tom Williams", issue: "Garage door sensor", priority: "low", status: "completed", created: "2025-02-10", assigned: "Handyman Pro", cost: 120 },
];

const mockPayments = [
  { id: 1, tenant: "Maria Johnson", property: "123 Oak St", amount: 1800, date: "2025-02-01", type: "rent", method: "ACH", status: "paid" },
  { id: 2, tenant: "James Carter", property: "789 Maple Dr", amount: 2100, date: "2025-02-01", type: "rent", method: "card", status: "partial", paid: 1950 },
  { id: 3, tenant: "Sara Patel", property: "321 Pine Rd", amount: 1950, date: "2025-02-01", type: "rent", method: "ACH", status: "paid" },
  { id: 4, tenant: "Tom Williams", property: "654 Birch Blvd", amount: 1600, date: "2025-02-01", type: "rent", method: "autopay", status: "paid" },
  { id: 5, tenant: "James Carter", property: "789 Maple Dr", amount: 75, date: "2025-02-05", type: "late_fee", method: "-", status: "unpaid" },
];

const mockUtilities = [
  { id: 1, property: "123 Oak St", provider: "City Water", amount: 82, due: "2025-03-05", responsibility: "tenant", status: "pending" },
  { id: 2, property: "789 Maple Dr", provider: "Gas Co", amount: 134, due: "2025-03-01", responsibility: "owner", status: "approved" },
  { id: 3, property: "456 Elm Ave #2B", provider: "Electric Co", amount: 95, due: "2025-03-10", responsibility: "owner", status: "pending" },
];

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
      {/* Navbar */}
      <nav className="flex items-center justify-between px-8 py-4 border-b border-gray-100">
        <div className="text-xl font-bold text-indigo-700">🏡 PropManager</div>
        <div className="flex items-center gap-4">
          <a href="#features" className="text-sm text-gray-600 hover:text-indigo-600">Features</a>
          <a href="#pricing" className="text-sm text-gray-600 hover:text-indigo-600">Pricing</a>
          <button onClick={onGetStarted} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">Login</button>
        </div>
      </nav>

      {/* Hero */}
      <div className="bg-gradient-to-br from-indigo-50 to-white px-8 py-20 text-center">
        <div className="inline-block bg-indigo-100 text-indigo-700 text-xs font-semibold px-3 py-1 rounded-full mb-4">Built for Property Managers</div>
        <h1 className="text-4xl md:text-5xl font-bold text-gray-900 mb-4 leading-tight">Manage Your Properties<br />Like a Pro</h1>
        <p className="text-lg text-gray-500 mb-8 max-w-xl mx-auto">Everything you need to manage 100+ properties — tenants, rent, maintenance, utilities, and accounting in one place.</p>
        <div className="flex gap-3 justify-center">
          <button onClick={onGetStarted} className="bg-indigo-600 text-white px-6 py-3 rounded-xl font-semibold hover:bg-indigo-700 shadow-md">Get Started Free</button>
          <button className="border border-gray-200 text-gray-600 px-6 py-3 rounded-xl font-semibold hover:bg-gray-50">Watch Demo</button>
        </div>
        <div className="mt-6 text-xs text-gray-400">No credit card required · Free forever for up to 10 properties</div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-6 max-w-2xl mx-auto px-8 py-12 text-center">
        {[["100+", "Properties Managed"], ["99.9%", "Uptime"], ["$0", "To Get Started"]].map(([v, l]) => (
          <div key={l}>
            <div className="text-3xl font-bold text-indigo-700">{v}</div>
            <div className="text-sm text-gray-400 mt-1">{l}</div>
          </div>
        ))}
      </div>

      {/* Features */}
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

      {/* Pricing */}
      <div id="pricing" className="px-8 py-16 text-center">
        <h2 className="text-2xl font-bold text-gray-800 mb-2">Simple Pricing</h2>
        <p className="text-gray-400 mb-10">No hidden fees. Cancel anytime.</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto">
          {[
            { plan: "Starter", price: "$0", desc: "Up to 10 properties", features: ["Property & tenant management", "Basic rent tracking", "Maintenance requests"], cta: "Get Started", highlight: false },
            { plan: "Pro", price: "$49/mo", desc: "Up to 100 properties", features: ["Everything in Starter", "Full accounting suite", "Utility management", "Zillow integration"], cta: "Start Free Trial", highlight: true },
            { plan: "Enterprise", price: "Custom", desc: "Unlimited properties", features: ["Everything in Pro", "Custom integrations", "Dedicated support", "SLA guarantee"], cta: "Contact Us", highlight: false },
          ].map(p => (
            <div key={p.plan} className={`rounded-xl p-6 border ${p.highlight ? "border-indigo-500 shadow-lg bg-indigo-600 text-white" : "border-gray-100 shadow-sm bg-white"}`}>
              <div className={`text-sm font-semibold mb-1 ${p.highlight ? "text-indigo-200" : "text-gray-400"}`}>{p.plan}</div>
              <div className={`text-3xl font-bold mb-1 ${p.highlight ? "text-white" : "text-gray-800"}`}>{p.price}</div>
              <div className={`text-xs mb-4 ${p.highlight ? "text-indigo-200" : "text-gray-400"}`}>{p.desc}</div>
              <ul className="text-sm space-y-2 mb-6 text-left">
                {p.features.map(f => (
                  <li key={f} className={`flex items-center gap-2 ${p.highlight ? "text-indigo-100" : "text-gray-600"}`}>
                    <span>✓</span>{f}
                  </li>
                ))}
              </ul>
              <button onClick={onGetStarted} className={`w-full py-2 rounded-lg font-semibold text-sm ${p.highlight ? "bg-white text-indigo-600 hover:bg-indigo-50" : "bg-indigo-600 text-white hover:bg-indigo-700"}`}>{p.cta}</button>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-gray-100 px-8 py-6 text-center text-xs text-gray-400">
        © 2025 PropManager. All rights reserved.
      </footer>
    </div>
  );
}

// ============ LOGIN PAGE ============
function LoginPage({ onLogin, onBack }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleLogin = () => {
    if (email === "admin@propmanager.com" && password === "password123") {
      onLogin();
    } else {
      setError("Invalid email or password. Try admin@propmanager.com / password123");
    }
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
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="admin@propmanager.com"
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-indigo-400"
            />
          </div>
          <div className="mb-6">
            <label className="text-xs font-medium text-gray-600 block mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-indigo-400"
              onKeyDown={e => e.key === "Enter" && handleLogin()}
            />
          </div>
          <button onClick={handleLogin} className="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-semibold text-sm hover:bg-indigo-700">Sign In</button>

          <div className="mt-4 text-center text-xs text-gray-400">
            Demo credentials: admin@propmanager.com / password123
          </div>
        </div>
      </div>
    </div>
  );
}

// ============ DASHBOARD PAGES ============
function Dashboard() {
  const occupied = mockProperties.filter(p => p.status === "occupied").length;
  const totalRent = mockPayments.filter(p => p.type === "rent" && p.status === "paid").reduce((s, p) => s + p.amount, 0);
  const delinquent = mockTenants.filter(t => t.balance > 0).length;
  const openWO = mockWorkOrders.filter(w => w.status !== "completed").length;

  return (
    <div>
      <h2 className="text-xl font-bold text-gray-800 mb-5">Dashboard</h2>
      <div className="grid grid-cols-2 gap-3 mb-6 md:grid-cols-4">
        <StatCard label="Occupancy" value={`${occupied}/${mockProperties.length}`} sub={`${Math.round(occupied/mockProperties.length*100)}% occupied`} color="text-green-600" />
        <StatCard label="Rent Collected" value={`$${totalRent.toLocaleString()}`} sub="of $8,850 expected" color="text-blue-600" />
        <StatCard label="Delinquent" value={delinquent} sub="tenants with balance" color="text-red-500" />
        <StatCard label="Open Work Orders" value={openWO} sub={`${mockWorkOrders.filter(w=>w.priority==='emergency').length} emergency`} color="text-orange-500" />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <h3 className="font-semibold text-gray-700 mb-3">Lease Expirations</h3>
          {mockTenants.filter(t=>t.moveOut).map(t => (
            <div key={t.id} className="flex justify-between items-center py-2 border-b border-gray-50 last:border-0">
              <div>
                <div className="text-sm font-medium text-gray-800">{t.name}</div>
                <div className="text-xs text-gray-400">{t.property}</div>
              </div>
              <div className="text-sm text-orange-500 font-semibold">{t.moveOut}</div>
            </div>
          ))}
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <h3 className="font-semibold text-gray-700 mb-3">Recent Maintenance</h3>
          {mockWorkOrders.slice(0,3).map(w => (
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
          {mockUtilities.map(u => (
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
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <h3 className="font-semibold text-gray-700 mb-3">Net Operating Income</h3>
          <div className="space-y-2">
            {[["Gross Rent Collected", "$8,300", "text-green-600"], ["Maintenance Costs", "-$570", "text-red-500"], ["Utility Expenses", "-$311", "text-red-500"], ["NOI", "$7,419", "text-blue-700 font-bold text-lg"]].map(([l,v,c]) => (
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

function Properties() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const filtered = mockProperties.filter(p =>
    (filter === "all" || p.status === filter) &&
    p.address.toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Properties</h2>
        <button className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">+ Add Property</button>
      </div>
      <div className="flex gap-2 mb-4 flex-wrap">
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search address..." className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm flex-1 min-w-0" />
        {["all","occupied","vacant","maintenance","notice given"].map(s => (
          <button key={s} onClick={()=>setFilter(s)} className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize ${filter===s?"bg-indigo-600 text-white":"bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{s}</button>
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
              <div><span className="text-gray-400">Lease End</span><div className="font-semibold text-gray-700">{p.leaseEnd || "—"}</div></div>
            </div>
            <div className="mt-3 flex gap-2">
              <button className="text-xs text-indigo-600 border border-indigo-200 px-3 py-1 rounded-lg hover:bg-indigo-50">View Timeline</button>
              <button className="text-xs text-gray-600 border border-gray-200 px-3 py-1 rounded-lg hover:bg-gray-50">Inspect</button>
              {p.status === "vacant" && <button className="text-xs text-green-600 border border-green-200 px-3 py-1 rounded-lg hover:bg-green-50">List on Zillow</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Tenants() {
  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Tenants</h2>
        <button className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">+ Add Tenant</button>
      </div>
      <div className="space-y-3">
        {mockTenants.map(t => (
          <div key={t.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <div className="flex justify-between items-start">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-sm">{t.name[0]}</div>
                <div>
                  <div className="font-semibold text-gray-800">{t.name}</div>
                  <div className="text-xs text-gray-400">{t.property}</div>
                </div>
              </div>
              <Badge status={t.leaseStatus} />
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <div><span className="text-gray-400">Email</span><div className="font-semibold text-gray-700 truncate">{t.email}</div></div>
              <div><span className="text-gray-400">Balance</span><div className={`font-semibold ${t.balance > 0 ? "text-red-500" : t.balance < 0 ? "text-green-600" : "text-gray-700"}`}>{t.balance > 0 ? `-$${t.balance}` : t.balance < 0 ? `Credit $${Math.abs(t.balance)}` : "Current"}</div></div>
              <div><span className="text-gray-400">Move-In</span><div className="font-semibold text-gray-700">{t.moveIn}</div></div>
            </div>
            <div className="mt-3 flex gap-2">
              <button className="text-xs text-indigo-600 border border-indigo-200 px-3 py-1 rounded-lg hover:bg-indigo-50">View Ledger</button>
              <button className="text-xs text-gray-600 border border-gray-200 px-3 py-1 rounded-lg hover:bg-gray-50">Message</button>
              <button className="text-xs text-gray-600 border border-gray-200 px-3 py-1 rounded-lg hover:bg-gray-50">Lease</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Payments() {
  const totalExpected = mockPayments.filter(p=>p.type==="rent").reduce((s,p)=>s+p.amount,0);
  const totalCollected = mockPayments.filter(p=>p.status==="paid").reduce((s,p)=>s+p.amount,0);
  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Payments & Rent</h2>
        <button className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">+ Record Payment</button>
      </div>
      <div className="grid grid-cols-3 gap-3 mb-5">
        <StatCard label="Expected" value={`$${totalExpected.toLocaleString()}`} color="text-gray-700" />
        <StatCard label="Collected" value={`$${totalCollected.toLocaleString()}`} color="text-green-600" />
        <StatCard label="Outstanding" value={`$${(totalExpected-totalCollected).toLocaleString()}`} color="text-red-500" />
      </div>
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
            <tr>{["Tenant","Property","Amount","Date","Type","Method","Status"].map(h=><th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {mockPayments.map(p => (
              <tr key={p.id} className="border-t border-gray-50 hover:bg-gray-50">
                <td className="px-3 py-2.5 font-medium text-gray-800">{p.tenant}</td>
                <td className="px-3 py-2.5 text-gray-500">{p.property}</td>
                <td className="px-3 py-2.5 font-semibold">${p.amount}</td>
                <td className="px-3 py-2.5 text-gray-500">{p.date}</td>
                <td className="px-3 py-2.5 capitalize text-gray-600">{p.type.replace("_"," ")}</td>
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

function Maintenance() {
  const [filter, setFilter] = useState("all");
  const filtered = filter === "all" ? mockWorkOrders : mockWorkOrders.filter(w=>w.status===filter||w.priority===filter);
  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Maintenance & Work Orders</h2>
        <button className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">+ New Work Order</button>
      </div>
      <div className="flex gap-2 mb-4">
        {["all","open","in_progress","completed","emergency"].map(s=>(
          <button key={s} onClick={()=>setFilter(s)} className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize ${filter===s?"bg-indigo-600 text-white":"bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{s.replace("_"," ")}</button>
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
              <Badge status={w.status} label={w.status.replace("_"," ")} />
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <div><span className="text-gray-400">Assigned</span><div className="font-semibold text-gray-700">{w.assigned || "Unassigned"}</div></div>
              <div><span className="text-gray-400">Created</span><div className="font-semibold text-gray-700">{w.created}</div></div>
              <div><span className="text-gray-400">Cost</span><div className="font-semibold text-gray-700">{w.cost ? `$${w.cost}` : "—"}</div></div>
            </div>
            <div className="mt-3 flex gap-2">
              <button className="text-xs text-indigo-600 border border-indigo-200 px-3 py-1 rounded-lg hover:bg-indigo-50">Update Status</button>
              <button className="text-xs text-gray-600 border border-gray-200 px-3 py-1 rounded-lg hover:bg-gray-50">Assign Vendor</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Utilities() {
  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Utility Management</h2>
        <button className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">+ Add Bill</button>
      </div>
      <div className="space-y-3">
        {mockUtilities.map(u => (
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
              <div><span className="text-gray-400">Pay Via</span><div className="font-semibold text-gray-700">ACH / Card</div></div>
            </div>
            <div className="mt-3 flex gap-2">
              {u.status === "pending" && <button className="text-xs text-green-600 border border-green-200 px-3 py-1 rounded-lg hover:bg-green-50">Approve & Pay</button>}
              <button className="text-xs text-gray-600 border border-gray-200 px-3 py-1 rounded-lg hover:bg-gray-50">View Audit Log</button>
              {u.responsibility === "tenant" && <button className="text-xs text-indigo-600 border border-indigo-200 px-3 py-1 rounded-lg hover:bg-indigo-50">Post to Ledger</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Accounting() {
  const accounts = [
    { name: "Rental Income", type: "Revenue", balance: 8300 },
    { name: "Security Deposits Liability", type: "Liability", balance: -7500 },
    { name: "Maintenance Expense", type: "Expense", balance: -570 },
    { name: "Utility Expense", type: "Expense", balance: -311 },
    { name: "Operating Account", type: "Asset", balance: 42800 },
  ];
  const reports = ["Rent Roll", "Delinquency Report", "Income Statement", "Balance Sheet", "Cash Flow", "Expense Tracking"];
  return (
    <div>
      <h2 className="text-xl font-bold text-gray-800 mb-5">Accounting & Financials</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <h3 className="font-semibold text-gray-700 mb-3">Chart of Accounts</h3>
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-400 uppercase"><tr><th className="text-left pb-2">Account</th><th className="text-left pb-2">Type</th><th className="text-right pb-2">Balance</th></tr></thead>
            <tbody>
              {accounts.map(a => (
                <tr key={a.name} className="border-t border-gray-50">
                  <td className="py-2 text-gray-800 font-medium">{a.name}</td>
                  <td className="py-2 text-gray-400 text-xs">{a.type}</td>
                  <td className={`py-2 text-right font-semibold ${a.balance < 0 ? "text-red-500" : "text-green-600"}`}>${Math.abs(a.balance).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <h3 className="font-semibold text-gray-700 mb-3">Financial Reports</h3>
          <div className="space-y-2">
            {reports.map(r => (
              <button key={r} className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg border border-gray-100 hover:bg-indigo-50 hover:border-indigo-200 text-sm text-gray-700 hover:text-indigo-700">
                <span>📄 {r}</span><span className="text-gray-300">→</span>
              </button>
            ))}
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 md:col-span-2">
          <h3 className="font-semibold text-gray-700 mb-3">Bank Reconciliation</h3>
          <div className="flex gap-4 text-sm">
            {[["Bank Balance","$42,800","text-gray-800"],["Book Balance","$42,650","text-gray-800"],["Unreconciled","$150","text-orange-500"]].map(([l,v,c])=>(
              <div key={l} className="flex-1 bg-gray-50 rounded-lg p-3 text-center">
                <div className="text-xs text-gray-400 mb-1">{l}</div>
                <div className={`text-lg font-bold ${c}`}>{v}</div>
              </div>
            ))}
            <button className="self-center bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-indigo-700">Reconcile</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Documents() {
  const docs = [
    { name: "Lease Agreement - Johnson 2024", property: "123 Oak St", type: "Lease", date: "2024-01-01", tenant: true },
    { name: "Move-In Inspection Report", property: "123 Oak St", type: "Inspection", date: "2024-01-02", tenant: false },
    { name: "HVAC Work Order Invoice", property: "789 Maple Dr", type: "Maintenance", date: "2025-02-21", tenant: false },
    { name: "Notice to Vacate - Patel", property: "321 Pine Rd", type: "Lease", date: "2024-12-15", tenant: true },
  ];
  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-gray-800">Document Management</h2>
        <button className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700">+ Upload Document</button>
      </div>
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
            <tr>{["Document","Property","Type","Date","Tenant Visible","Actions"].map(h=><th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {docs.map(d => (
              <tr key={d.name} className="border-t border-gray-50 hover:bg-gray-50">
                <td className="px-3 py-2.5 font-medium text-gray-800">📄 {d.name}</td>
                <td className="px-3 py-2.5 text-gray-500">{d.property}</td>
                <td className="px-3 py-2.5"><span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full text-xs">{d.type}</span></td>
                <td className="px-3 py-2.5 text-gray-500">{d.date}</td>
                <td className="px-3 py-2.5">{d.tenant ? "✅" : "🔒"}</td>
                <td className="px-3 py-2.5 flex gap-2">
                  <button className="text-xs text-indigo-600 hover:underline">View</button>
                  <button className="text-xs text-gray-400 hover:underline">Sign</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============ MAIN APP ============
const pageComponents = { dashboard: Dashboard, properties: Properties, tenants: Tenants, payments: Payments, maintenance: Maintenance, utilities: Utilities, accounting: Accounting, documents: Documents };

export default function App() {
  const [screen, setScreen] = useState("landing"); // landing | login | app
  const [page, setPage] = useState("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  if (screen === "landing") return <LandingPage onGetStarted={() => setScreen("login")} />;
  if (screen === "login") return <LoginPage onLogin={() => setScreen("app")} onBack={() => setScreen("landing")} />;

  const Page = pageComponents[page];

  return (
    <div className="flex h-screen bg-gray-50 font-sans overflow-hidden">
      <div className={`${sidebarOpen ? "flex" : "hidden"} md:flex flex-col w-56 bg-white border-r border-gray-100 shadow-sm z-20 fixed md:relative h-full`}>
        <div className="px-5 py-4 border-b border-gray-100">
          <div className="text-lg font-bold text-indigo-700">🏡 PropManager</div>
          <div className="text-xs text-gray-400">100 Properties</div>
        </div>
        <nav className="flex-1 py-3 overflow-y-auto">
          {navItems.map(n => (
            <button key={n.id} onClick={()=>{setPage(n.id);setSidebarOpen(false);}}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors ${page===n.id?"bg-indigo-50 text-indigo-700 font-semibold border-r-2 border-indigo-600":"text-gray-600 hover:bg-gray-50"}`}>
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
            <button onClick={() => setScreen("landing")} className="text-xs text-gray-400 hover:text-red-500">Logout</button>
          </div>
        </div>
      </div>
      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3">
          <button className="md:hidden text-gray-500 text-xl" onClick={()=>setSidebarOpen(!sidebarOpen)}>☰</button>
          <div className="flex-1 text-sm text-gray-400 capitalize">{page}</div>
          <button className="relative text-gray-400 hover:text-gray-600">
            🔔<span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center">3</span>
          </button>
        </header>
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          <Page />
        </main>
      </div>
      {sidebarOpen && <div className="fixed inset-0 bg-black bg-opacity-20 z-10 md:hidden" onClick={()=>setSidebarOpen(false)} />}
    </div>
  );
}