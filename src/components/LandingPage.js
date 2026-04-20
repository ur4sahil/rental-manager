import React from "react";

export function LandingPage({ onGetStarted }) {
  return (
  <div className="min-h-screen bg-surface-muted">
  <nav className="flex items-center justify-between px-8 py-4 bg-white/80 backdrop-blur-md border-b border-brand-50">
  <div className="flex items-center gap-2">
  <div className="w-8 h-8 bg-brand-600 rounded-lg flex items-center justify-center shadow-lg shadow-brand-200">
  <span className="material-icons-outlined text-white text-sm">domain</span>
  </div>
  <span className="font-manrope font-extrabold text-xl tracking-tight text-brand-900">PropManager</span>
  </div>
  <button onClick={() => onGetStarted("login")} className="bg-brand-600 text-white text-sm px-5 py-2.5 rounded-2xl hover:bg-brand-700 font-semibold transition-colors">Sign In</button>
  </nav>
  <div className="bg-gradient-to-br from-brand-50/50 to-[#fcf8ff] px-8 py-16 text-center">
  <p className="text-brand-600 font-semibold text-sm uppercase tracking-widest mb-3">Property Management Platform</p>
  <h1 className="text-4xl md:text-5xl font-manrope font-extrabold text-neutral-900 mb-4 leading-tight">Property Management<br />Made Simple</h1>
  <p className="text-lg text-neutral-400 mb-12 max-w-xl mx-auto">Manage properties, tenants, rent, maintenance, and accounting — all in one place.</p>

  <h2 className="text-lg font-manrope font-manrope font-bold text-neutral-700 mb-6">I am a...</h2>
  <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto">
  <button onClick={() => onGetStarted("signup_pm")} className="bg-white rounded-3xl border border-brand-100 p-8 text-center hover:border-brand-300 hover:shadow-card transition-all group">
  <div className="w-16 h-16 rounded-2xl bg-brand-50 flex items-center justify-center mx-auto mb-4 group-hover:scale-110 transition-transform">
  <span className="material-icons-outlined text-brand-600 text-3xl">business</span>
  </div>
  <div className="text-lg font-manrope font-bold text-neutral-800 mb-2">Property Manager</div>
  <p className="text-sm text-neutral-400">I manage properties on behalf of owners. Full access to all management tools.</p>
  <div className="mt-4 text-brand-600 text-sm font-bold">Get Started →</div>
  </button>

  <button onClick={() => onGetStarted("signup_owner")} className="bg-white rounded-3xl border border-success-100 p-8 text-center hover:border-success-300 hover:shadow-card transition-all group">
  <div className="w-16 h-16 rounded-2xl bg-success-50 flex items-center justify-center mx-auto mb-4 group-hover:scale-110 transition-transform">
  <span className="material-icons-outlined text-success-600 text-3xl">home</span>
  </div>
  <div className="text-lg font-manrope font-bold text-neutral-800 mb-2">Property Owner</div>
  <p className="text-sm text-neutral-400">I own properties and want to manage them directly or assign a property manager.</p>
  <div className="mt-4 text-success-600 text-sm font-bold">Get Started →</div>
  </button>

  <button onClick={() => onGetStarted("signup_tenant")} className="bg-white rounded-3xl border border-warn-100 p-8 text-center hover:border-warn-300 hover:shadow-card transition-all group">
  <div className="w-16 h-16 rounded-2xl bg-warn-50 flex items-center justify-center mx-auto mb-4 group-hover:scale-110 transition-transform">
  <span className="material-icons-outlined text-warn-600 text-3xl">vpn_key</span>
  </div>
  <div className="text-lg font-manrope font-bold text-neutral-800 mb-2">Tenant</div>
  <p className="text-sm text-neutral-400">I have an invite code from my landlord or property manager to access my portal.</p>
  <div className="mt-4 text-warn-600 text-sm font-bold">Enter Invite Code →</div>
  </button>
  </div>

  <div className="mt-10">
  <button onClick={() => onGetStarted("login")} className="text-sm text-neutral-400 hover:text-brand-600 transition-colors">Already have an account? <span className="font-bold">Sign In</span></button>
  </div>
  </div>

  <div className="px-8 py-16 bg-white/50">
  <h2 className="text-2xl font-manrope font-bold text-center text-neutral-800 mb-10">Everything You Need</h2>
  <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
  {[
  { icon: "apartment", title: "Property Management", desc: "Track all your properties, units, and their status in one place." },
  { icon: "people", title: "Tenant Management", desc: "Manage tenant profiles, leases, and communication effortlessly." },
  { icon: "payments", title: "Rent Collection", desc: "Collect rent via ACH, card, or autopay with automated reminders." },
  { icon: "build", title: "Maintenance Tracking", desc: "Handle work orders from submission to completion with ease." },
  { icon: "bolt", title: "Utility Management", desc: "Track and pay utility bills with full audit logs." },
  { icon: "account_balance", title: "Full Accounting", desc: "General ledger, bank reconciliation, and financial reports." },
  ].map(f => (
  <div key={f.title} className="bg-white rounded-3xl p-6 shadow-card border border-brand-50 hover:border-brand-200 transition-all">
  <div className="w-12 h-12 bg-brand-50 text-brand-600 rounded-2xl flex items-center justify-center mb-3">
  <span className="material-icons-outlined text-xl">{f.icon}</span>
  </div>
  <div className="font-manrope font-bold text-neutral-800 mb-1">{f.title}</div>
  <div className="text-sm text-neutral-400">{f.desc}</div>
  </div>
  ))}
  </div>
  </div>
  <footer className="border-t border-brand-50 px-8 py-6 text-center text-xs text-neutral-400">
  © 2026 PropManager by Sigma Housing LLC. All rights reserved.
  </footer>
  </div>
  );
}
