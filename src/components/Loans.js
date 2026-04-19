import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { Input, Select, Btn, PageHeader } from "../ui";
import { safeNum, formatLocalDate, formatCurrency } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { encryptCredential, decryptCredential } from "../utils/encryption";
import { logAudit } from "../utils/audit";
import { autoPostJournalEntry, getPropertyClassId } from "../utils/accounting";
import { Spinner, Modal, PropertySelect } from "./shared";

function Loans({ addNotification, userProfile, userRole, companyId, showToast, showConfirm }) {
  const [loans, setLoans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingLoan, setEditingLoan] = useState(null);
  const [form, setForm] = useState({ lender_name: "", loan_type: "Conventional", original_amount: "", current_balance: "", interest_rate: "", monthly_payment: "", escrow_included: false, escrow_amount: "", escrow_covers: "", loan_start_date: "", maturity_date: "", account_number: "", property: "", notes: "", status: "active", website: "", username: "", password: "" });
  const [propertyFilter, setPropertyFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showCreds, setShowCreds] = useState(new Set());

  useEffect(() => { fetchLoans(); }, [companyId]);

  async function fetchLoans() {
  const { data } = await supabase.from("property_loans").select("*").eq("company_id", companyId).is("archived_at", null).order("created_at", { ascending: false });
  setLoans(data || []);
  setLoading(false);
  }

  async function saveLoan() {
  if (!guardSubmit("saveLoan")) return;
  try {
  if (!form.property || !form.lender_name || !form.original_amount) { showToast("Property, lender name, and original amount are required.", "error"); return; }
  const payload = { ...form, original_amount: Number(form.original_amount), current_balance: Number(form.current_balance || form.original_amount), interest_rate: Number(form.interest_rate || 0), monthly_payment: Number(form.monthly_payment || 0), escrow_amount: form.escrow_included ? Number(form.escrow_amount || 0) : 0, escrow_covers: form.escrow_included ? form.escrow_covers : "" };
  delete payload.username; delete payload.password;
  payload.website = form.website || "";
  if (form.username || form.password) {
    const resU = await encryptCredential(form.username || "", companyId);
    const resP = await encryptCredential(form.password || "", companyId, resU.salt);
    payload.username_encrypted = resU.encrypted;
    payload.password_encrypted = resP.encrypted;
    payload.encryption_iv = resP.iv || resU.iv;
    payload.encryption_salt = resU.salt || resP.salt;
  }
  if (editingLoan) {
  const { error: loanErr } = await supabase.from("property_loans").update({ lender_name: payload.lender_name, loan_type: payload.loan_type, original_amount: payload.original_amount, current_balance: payload.current_balance, interest_rate: payload.interest_rate, monthly_payment: payload.monthly_payment, escrow_included: payload.escrow_included, escrow_amount: payload.escrow_amount, escrow_covers: payload.escrow_covers, loan_start_date: payload.loan_start_date || null, maturity_date: payload.maturity_date || null, account_number: payload.account_number, property: payload.property, notes: payload.notes, status: payload.status, website: payload.website, username_encrypted: payload.username_encrypted || editingLoan.username_encrypted || "", password_encrypted: payload.password_encrypted || editingLoan.password_encrypted || "", encryption_iv: payload.encryption_iv || editingLoan.encryption_iv || "", encryption_salt: payload.encryption_salt || editingLoan.encryption_salt || null }).eq("id", editingLoan.id).eq("company_id", companyId);
  if (loanErr) { showToast("Error updating loan: " + loanErr.message, "error"); return; }
  addNotification("🏦", `Loan updated: ${form.lender_name}`);
  logAudit("update", "loans", `Loan updated: ${form.lender_name} ${formatCurrency(form.original_amount)}`, editingLoan.id, userProfile?.email, userRole, companyId);
  } else {
  const insPayload = { ...payload, company_id: companyId }; delete insPayload.username; delete insPayload.password;
  const { error: loanErr } = await supabase.from("property_loans").insert([insPayload]);
  if (loanErr) { showToast("Error saving loan: " + loanErr.message, "error"); return; }
  addNotification("🏦", `Loan added: ${form.lender_name} — ${formatCurrency(form.original_amount)}`);
  logAudit("create", "loans", `Loan added: ${form.lender_name} ${formatCurrency(form.original_amount)} at ${form.property}`, "", userProfile?.email, userRole, companyId);
  }
  setShowForm(false);
  setEditingLoan(null);
  setForm({ lender_name: "", loan_type: "Conventional", original_amount: "", current_balance: "", interest_rate: "", monthly_payment: "", escrow_included: false, escrow_amount: "", escrow_covers: "", loan_start_date: "", maturity_date: "", account_number: "", property: "", notes: "", status: "active", website: "", username: "", password: "" });
  fetchLoans();
  } finally { guardRelease("saveLoan"); }
  }

  async function deleteLoan(id) {
  if (!guardSubmit("deleteLoan")) return;
  try {
  if (!await showConfirm({ message: "Delete this loan?", variant: "danger", confirmText: "Delete" })) return;
  const { error: delErr } = await supabase.from("property_loans").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email }).eq("id", id).eq("company_id", companyId);
  if (delErr) { showToast("Error deleting loan: " + delErr.message, "error"); return; }
  logAudit("delete", "loans", "Archived loan", id, userProfile?.email, userRole, companyId);
  fetchLoans();
  } finally { guardRelease("deleteLoan"); }
  }

  async function recordPayment(loan) {
  if (!guardSubmit("recordLoanPayment")) return;
  try {
  if (!await showConfirm({ message: `Record a payment of ${formatCurrency(loan.monthly_payment)} for ${loan.lender_name}?`, confirmText: "Record Payment" })) return;
  const today = formatLocalDate(new Date());
  const classId = await getPropertyClassId(loan.property, companyId);
  const amt = safeNum(loan.monthly_payment);
  if (amt <= 0) { showToast("Monthly payment amount must be greater than zero.", "error"); return; }
  const _jeOk = await autoPostJournalEntry({
  companyId,
  date: today,
  description: `Loan payment: ${loan.lender_name} — ${loan.property}`,
  reference: `LOAN-${loan.id}`,
  property: loan.property,
  lines: [
  { account_id: "5600", account_name: "Mortgage/Loan Payment", debit: amt, credit: 0, class_id: classId, memo: `Loan: ${loan.lender_name}` },
  { account_id: "1000", account_name: "Checking Account", debit: 0, credit: amt, class_id: classId, memo: `Loan: ${loan.lender_name}` },
  ]
  });
  if (!_jeOk) { showToast("Accounting entry failed. Balance NOT updated.", "error"); return; }
  // Update current balance only if JE succeeded
  const newBalance = Math.max(0, safeNum(loan.current_balance) - amt);
  const { error: balErr } = await supabase.from("property_loans").update({ current_balance: newBalance }).eq("id", loan.id).eq("company_id", companyId);
  if (balErr) { showToast("Balance update failed: " + balErr.message, "error"); return; }
  addNotification("💰", `Loan payment recorded: ${loan.lender_name} ${formatCurrency(amt)}`);
  logAudit("update", "loans", `Loan payment recorded: ${loan.lender_name} ${formatCurrency(amt)} at ${loan.property}`, loan.id, userProfile?.email, userRole, companyId);
  fetchLoans();
  } finally { guardRelease("recordLoanPayment"); }
  }

  if (loading) return <Spinner />;

  const filtered = loans.filter(l =>
  (propertyFilter === "all" || l.property === propertyFilter) &&
  (statusFilter === "all" || l.status === statusFilter)
  );

  const activeLoans = loans.filter(l => l.status === "active");
  const totalMonthly = activeLoans.reduce((s, l) => s + safeNum(l.monthly_payment), 0);
  const totalBalance = activeLoans.reduce((s, l) => s + safeNum(l.current_balance), 0);
  const uniqueProperties = [...new Set(loans.map(l => l.property).filter(Boolean))];

  const emptyForm = { lender_name: "", loan_type: "Conventional", original_amount: "", current_balance: "", interest_rate: "", monthly_payment: "", escrow_included: false, escrow_amount: "", escrow_covers: "", loan_start_date: "", maturity_date: "", account_number: "", property: "", notes: "", status: "active" };

  return (
  <div>
  <div className="flex flex-col md:flex-row gap-3 mb-4">
  <PageHeader title="Loans" />
  <Select filter value={propertyFilter} onChange={e => setPropertyFilter(e.target.value)}>
  <option value="all">All Properties</option>
  {uniqueProperties.map(p => <option key={p} value={p}>{p}</option>)}
  </Select>
  <Select filter value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
  <option value="all">All Status</option><option value="active">Active</option><option value="paid_off">Paid Off</option>
  </Select>
  <Btn variant="success-fill" onClick={() => { setEditingLoan(null); setForm(emptyForm); setShowForm(true); }}>+ Add Loan</Btn>
  </div>

  {/* Stats */}
  <div className="flex gap-3 mb-4">
  <div className="rounded-xl shadow-sm border border-neutral-200 bg-white px-3 py-2 text-center flex-1"><div className="text-lg font-manrope font-bold text-neutral-800">{activeLoans.length}</div><div className="text-xs text-neutral-400">Active Loans</div></div>
  <div className="rounded-xl shadow-sm border border-neutral-200 bg-white px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-warn-600">{formatCurrency(totalMonthly)}</div><div className="text-xs text-neutral-400">Total Monthly Payments</div></div>
  <div className="rounded-xl shadow-sm border border-neutral-200 bg-white px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-success-600">{formatCurrency(totalBalance)}</div><div className="text-xs text-neutral-400">Total Outstanding Balance</div></div>
  </div>

  {showForm && (
  <Modal title={editingLoan ? "Edit Loan" : "New Loan"} onClose={() => { setShowForm(false); setEditingLoan(null); }}>
  <div className="grid grid-cols-2 gap-3">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Property *</label><PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} companyId={companyId} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Lender Name *</label><Input placeholder="e.g. Wells Fargo" value={form.lender_name} onChange={e => setForm({ ...form, lender_name: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Loan Type</label><Select value={form.loan_type} onChange={e => setForm({ ...form, loan_type: e.target.value })}>
  <option value="Conventional">Conventional</option><option value="FHA">FHA</option><option value="VA">VA</option><option value="DSCR">DSCR</option><option value="Hard Money">Hard Money</option><option value="HELOC">HELOC</option><option value="Other">Other</option>
  </Select></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Original Amount ($) *</label><Input placeholder="250000" type="number" value={form.original_amount} onChange={e => setForm({ ...form, original_amount: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Current Balance ($)</label><Input placeholder="230000" type="number" value={form.current_balance} onChange={e => setForm({ ...form, current_balance: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Interest Rate (%)</label><Input placeholder="6.5" type="number" step="0.01" value={form.interest_rate} onChange={e => setForm({ ...form, interest_rate: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Monthly Payment ($)</label><Input placeholder="1800" type="number" value={form.monthly_payment} onChange={e => setForm({ ...form, monthly_payment: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Account Number</label><Input placeholder="Loan account #" value={form.account_number} onChange={e => setForm({ ...form, account_number: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Loan Start Date</label><Input type="date" value={form.loan_start_date} onChange={e => setForm({ ...form, loan_start_date: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Maturity Date</label><Input type="date" value={form.maturity_date} onChange={e => setForm({ ...form, maturity_date: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Status</label><Select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
  <option value="active">Active</option><option value="paid_off">Paid Off</option>
  </Select></div>
  <div className="col-span-2"><label className="text-xs font-medium text-neutral-400 mb-1 block">Notes</label><Input placeholder="Optional notes" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></div>
  <div className="col-span-2">
  <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.escrow_included} onChange={e => setForm({ ...form, escrow_included: e.target.checked })} className="rounded" /><span className="text-sm text-neutral-600">Escrow Included</span></label>
  </div>
  {form.escrow_included && (
  <>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Escrow Amount ($)</label><Input placeholder="350" type="number" value={form.escrow_amount} onChange={e => setForm({ ...form, escrow_amount: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Escrow Covers</label><Input placeholder="e.g. Taxes, Insurance" value={form.escrow_covers} onChange={e => setForm({ ...form, escrow_covers: e.target.value })} /></div>
  </>
  )}
  <div className="col-span-2 border-t border-neutral-100 pt-2 mt-1"><p className="text-xs text-neutral-400 mb-2">Lender Portal Login (encrypted)</p>
  <div className="grid grid-cols-3 gap-2">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Website</label><Input type="url" value={form.website||""} onChange={e => setForm({...form, website: e.target.value})} placeholder="https://..." /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Username</label><Input value={form.username||""} onChange={e => setForm({...form, username: e.target.value})} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Password</label><Input type="password" value={form.password||""} onChange={e => setForm({...form, password: e.target.value})} /></div>
  </div></div>
  </div>
  <div className="flex gap-2 mt-4">
  <Btn variant="success-fill" onClick={saveLoan}>Save</Btn>
  <Btn variant="secondary" onClick={() => { setShowForm(false); setEditingLoan(null); }}>Cancel</Btn>
  </div>
  </Modal>
  )}

  <div className="bg-white rounded-xl shadow-sm border border-neutral-200 overflow-x-auto">
  <table className="w-full text-sm">
  <thead className="bg-neutral-50 text-xs text-neutral-400 uppercase">
  <tr><th className="px-4 py-3 text-left">Property</th><th className="px-4 py-3 text-left">Lender</th><th className="px-4 py-3 text-left">Type</th><th className="px-4 py-3 text-right">Rate</th><th className="px-4 py-3 text-right">Monthly</th><th className="px-4 py-3 text-right">Balance</th><th className="px-4 py-3 text-left">Maturity</th><th className="px-4 py-3 text-left">Portal</th><th className="px-4 py-3 text-right">Actions</th></tr>
  </thead>
  <tbody>
  {filtered.map(l => (
  <tr key={l.id} className="border-t border-neutral-100 hover:bg-positive-50/40">
  <td className="px-4 py-2.5 text-neutral-800">{l.property}</td>
  <td className="px-4 py-2.5 font-medium text-neutral-800">{l.lender_name}</td>
  <td className="px-4 py-2.5 text-neutral-500">{l.loan_type}</td>
  <td className="px-4 py-2.5 text-right text-neutral-600">{safeNum(l.interest_rate).toFixed(2)}%</td>
  <td className="px-4 py-2.5 text-right font-semibold">{formatCurrency(l.monthly_payment)}</td>
  <td className="px-4 py-2.5 text-right font-semibold">{formatCurrency(l.current_balance)}</td>
  <td className="px-4 py-2.5 text-neutral-400">{l.maturity_date || "—"}</td>
  <td className="px-4 py-2.5 text-xs">
  {l.website ? <a href={l.website} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline block truncate max-w-28">{l.website.replace(/^https?:\/\//, "")}</a> : <span className="text-neutral-300">—</span>}
  {l.username_encrypted && <button onClick={async () => { const s = new Set(showCreds); if (s.has(l.id)) { s.delete(l.id); setShowCreds(s); } else { l._decUser = await decryptCredential(l.username_encrypted, l.encryption_iv, companyId, l.encryption_salt); l._decPass = await decryptCredential(l.password_encrypted, l.encryption_iv, companyId, l.encryption_salt); s.add(l.id); setShowCreds(new Set(s)); }}} className="text-brand-500 hover:underline">{showCreds.has(l.id) ? "Hide" : "Show"} login</button>}
  {showCreds.has(l.id) && <div className="text-neutral-600 mt-0.5">{l._decUser || "—"} / {l._decPass || "—"}</div>}
  </td>
  <td className="px-4 py-2.5 text-right whitespace-nowrap">
  {l.status === "active" && <button onClick={() => recordPayment(l)} className="text-xs text-positive-600 hover:underline mr-2">Record Payment</button>}
  <button onClick={() => { setEditingLoan(l); setForm({ lender_name: l.lender_name, loan_type: l.loan_type || "Conventional", original_amount: String(l.original_amount || ""), current_balance: String(l.current_balance || ""), interest_rate: String(l.interest_rate || ""), monthly_payment: String(l.monthly_payment || ""), escrow_included: l.escrow_included || false, escrow_amount: String(l.escrow_amount || ""), escrow_covers: l.escrow_covers || "", loan_start_date: l.loan_start_date || "", maturity_date: l.maturity_date || "", account_number: l.account_number || "", property: l.property || "", notes: l.notes || "", status: l.status || "active" }); setShowForm(true); }} className="text-xs text-brand-600 hover:underline mr-2">Edit</button>
  <button onClick={() => deleteLoan(l.id)} className="text-xs text-danger-500 hover:underline">Delete</button>
  </td>
  </tr>
  ))}
  </tbody>
  </table>
  {filtered.length === 0 && <div className="text-center py-8 text-neutral-400">No loans found</div>}
  </div>
  </div>
  );
}

export { Loans };
