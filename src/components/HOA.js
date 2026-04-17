import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { Input, Select, Btn, PageHeader } from "../ui";
import { safeNum, formatLocalDate, formatCurrency } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { encryptCredential, decryptCredential } from "../utils/encryption";
import { logAudit } from "../utils/audit";
import { autoPostJournalEntry, getPropertyClassId } from "../utils/accounting";
import { Badge, Spinner, PropertySelect } from "./shared";

function HOAPayments({ addNotification, userProfile, userRole, companyId, showToast, showConfirm }) {
  const [hoaPayments, setHoaPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingHoa, setEditingHoa] = useState(null);
  const [form, setForm] = useState({ property: "", hoa_name: "", amount: "", due_date: "", frequency: "monthly", status: "pending", notes: "", website: "", username: "", password: "" });
  const [hoaFilter, setHoaFilter] = useState("all");
  const [showCreds, setShowCreds] = useState(new Set());

  useEffect(() => { fetchHOA(); }, [companyId]);

  async function fetchHOA() {
  const { data } = await supabase.from("hoa_payments").select("*").eq("company_id", companyId).is("archived_at", null).order("due_date", { ascending: false });
  setHoaPayments(data || []);
  setLoading(false);
  }

  async function saveHOA() {
  if (!guardSubmit("saveHOA")) return;
  try {
  if (!form.property || !form.hoa_name || !form.amount) { showToast("Property, HOA name, and amount are required.", "error"); return; }
  if (!form.due_date) { setForm({...form, due_date: formatLocalDate(new Date())}); showToast("Due date was not set — defaulting to today. Please verify and save again.", "error"); return; }
  const payload = { ...form, amount: Number(form.amount) };
  delete payload.username; delete payload.password;
  payload.website = form.website || "";
  if (form.username || form.password) {
    const { encrypted: encU, iv: ivU } = await encryptCredential(form.username || "", companyId);
    const { encrypted: encP, iv: ivP } = await encryptCredential(form.password || "", companyId);
    payload.username_encrypted = encU; payload.password_encrypted = encP; payload.encryption_iv = ivP || ivU;
  }
  if (editingHoa) {
  const { error: hoaErr } = await supabase.from("hoa_payments").update({ property: payload.property, hoa_name: payload.hoa_name, amount: payload.amount, due_date: payload.due_date, frequency: payload.frequency, status: payload.status, notes: payload.notes, website: payload.website, username_encrypted: payload.username_encrypted || editingHoa.username_encrypted || "", password_encrypted: payload.password_encrypted || editingHoa.password_encrypted || "", encryption_iv: payload.encryption_iv || editingHoa.encryption_iv || "" }).eq("id", editingHoa.id).eq("company_id", companyId);
  if (hoaErr) { showToast("Error updating HOA: " + hoaErr.message, "error"); return; }
  addNotification("🏘️", `HOA payment updated: ${form.hoa_name}`);
  logAudit("update", "hoa", `HOA updated: ${form.hoa_name} ${formatCurrency(form.amount)}`, editingHoa.id, userProfile?.email, userRole, companyId);
  } else {
  const { error: hoaErr } = await supabase.from("hoa_payments").insert([{ ...payload, company_id: companyId }]);
  if (hoaErr) { showToast("Error saving HOA: " + hoaErr.message, "error"); return; }
  addNotification("🏘️", `HOA payment added: ${form.hoa_name} — ${formatCurrency(form.amount)}`);
  logAudit("create", "hoa", `HOA added: ${form.hoa_name} ${formatCurrency(form.amount)} at ${form.property}`, "", userProfile?.email, userRole, companyId);
  }
  setShowForm(false);
  setEditingHoa(null);
  setForm({ property: "", hoa_name: "", amount: "", due_date: "", frequency: "monthly", status: "pending", notes: "", website: "", username: "", password: "" });
  fetchHOA();
  } finally { guardRelease("saveHOA"); }
  }

  async function payHOA(h) {
  if (!guardSubmit("payHOA")) return;
  try {
  if (h.status === "paid") { showToast("This HOA payment is already marked as paid.", "error"); return; }
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
  if (!_jeOk) { showToast("Accounting entry failed. The record was saved but the journal entry could not be posted. Please check the accounting module.", "error"); }
  
  }
  fetchHOA();
  } finally { guardRelease("payHOA"); }
  }

  async function deleteHOA(id) {
  if (!guardSubmit("deleteHOA")) return;
  try {
  if (!await showConfirm({ message: "Delete this HOA payment?", variant: "danger", confirmText: "Delete" })) return;
  await supabase.from("hoa_payments").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email }).eq("id", id).eq("company_id", companyId);
  logAudit("delete", "hoa", "Archived HOA payment", id, userProfile?.email, userRole, companyId);
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
  <PageHeader title="HOA Payments" />
  <Select filter value={hoaFilter} onChange={e => setHoaFilter(e.target.value)} >
  <option value="all">All Status</option><option value="pending">Pending</option><option value="paid">Paid</option>
  </Select>
  <Btn onClick={() => { setEditingHoa(null); setForm({ property: "", hoa_name: "", amount: "", due_date: "", frequency: "monthly", status: "pending", notes: "", website: "", username: "", password: "" }); setShowForm(!showForm); }}>+ Add HOA</Btn>
  </div>

  {/* Stats */}
  <div className="flex gap-3 mb-4">
  <div className="bg-white rounded-3xl border border-brand-50 px-3 py-2 text-center flex-1"><div className="text-lg font-manrope font-bold text-neutral-800">{hoaPayments.length}</div><div className="text-xs text-neutral-400">Total</div></div>
  <div className="bg-white rounded-3xl border border-brand-50 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-warn-600">{hoaPayments.filter(h => h.status === "pending").length}</div><div className="text-xs text-neutral-400">Pending</div></div>
  <div className="bg-white rounded-3xl border border-brand-50 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-success-600">${hoaPayments.filter(h => h.status === "paid").reduce((s, h) => s + safeNum(h.amount), 0).toLocaleString()}</div><div className="text-xs text-neutral-400">Paid</div></div>
  </div>

  {showForm && (
  <div className="bg-white rounded-xl border border-brand-100 shadow-sm p-4 mb-4">
  <h3 className="font-semibold text-neutral-700 mb-3">{editingHoa ? "Edit HOA Payment" : "New HOA Payment"}</h3>
  <div className="grid grid-cols-2 gap-3">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Property *</label><PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} companyId={companyId} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">HOA Company</label><Input placeholder="e.g. Riverside HOA" value={form.hoa_name} onChange={e => setForm({ ...form, hoa_name: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Amount ($)</label><Input placeholder="250.00" type="number" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Due Date</label><Input type="date" value={form.due_date} onChange={e => setForm({ ...form, due_date: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Frequency</label><Select value={form.frequency} onChange={e => setForm({ ...form, frequency: e.target.value })}>
  <option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option>
  </Select></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Notes</label><Input placeholder="Optional notes" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></div>
  <div className="col-span-2 border-t border-neutral-100 pt-2 mt-1"><p className="text-xs text-neutral-400 mb-2">Portal Login (encrypted)</p>
  <div className="grid grid-cols-3 gap-2">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Website</label><Input type="url" value={form.website||""} onChange={e => setForm({...form, website: e.target.value})} placeholder="https://..." /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Username</label><Input value={form.username||""} onChange={e => setForm({...form, username: e.target.value})} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Password</label><Input type="password" value={form.password||""} onChange={e => setForm({...form, password: e.target.value})} /></div>
  </div></div>
  </div>
  <div className="flex gap-2 mt-3">
  <Btn onClick={saveHOA}>Save</Btn>
  <Btn variant="secondary" onClick={() => { setShowForm(false); setEditingHoa(null); }}>Cancel</Btn>
  </div>
  </div>
  )}

  <div className="bg-white rounded-3xl shadow-card border border-brand-50 overflow-x-auto">
  <table className="w-full text-sm">
  <thead className="bg-brand-50/30 text-xs text-neutral-400 uppercase">
  <tr><th className="px-4 py-3 text-left">Property</th><th className="px-4 py-3 text-left">HOA Company</th><th className="px-4 py-3 text-right">Amount</th><th className="px-4 py-3 text-left">Due Date</th><th className="px-4 py-3 text-left">Frequency</th><th className="px-4 py-3 text-left">Status</th><th className="px-4 py-3 text-left">Portal</th><th className="px-4 py-3 text-right">Actions</th></tr>
  </thead>
  <tbody>
  {filtered.map(h => (
  <tr key={h.id} className="border-t border-brand-50/50 hover:bg-brand-50/30/50">
  <td className="px-4 py-2.5 text-neutral-800">{h.property}</td>
  <td className="px-4 py-2.5 font-medium text-neutral-800">{h.hoa_name}</td>
  <td className="px-4 py-2.5 text-right font-semibold">${safeNum(h.amount).toLocaleString()}</td>
  <td className="px-4 py-2.5 text-neutral-400">{h.due_date}</td>
  <td className="px-4 py-2.5 text-neutral-500 capitalize">{h.frequency}</td>
  <td className="px-4 py-2.5"><Badge status={h.status} /></td>
  <td className="px-4 py-2.5 text-xs">
  {h.website ? <a href={h.website} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline block truncate max-w-28">{h.website.replace(/^https?:\/\//, "")}</a> : <span className="text-neutral-300">—</span>}
  {h.username_encrypted && <button onClick={async () => { const s = new Set(showCreds); if (s.has(h.id)) { s.delete(h.id); setShowCreds(s); } else { h._decUser = await decryptCredential(h.username_encrypted, h.encryption_iv, companyId); h._decPass = await decryptCredential(h.password_encrypted, h.encryption_iv, companyId); s.add(h.id); setShowCreds(new Set(s)); }}} className="text-brand-500 hover:underline">{showCreds.has(h.id) ? "Hide" : "Show"} login</button>}
  {showCreds.has(h.id) && <div className="text-neutral-600 mt-0.5">{h._decUser || "—"} / {h._decPass || "—"}</div>}
  </td>
  <td className="px-4 py-2.5 text-right whitespace-nowrap">
  {h.status === "pending" && <button onClick={() => payHOA(h)} className="text-xs text-positive-600 hover:underline mr-2">Pay</button>}
  <button onClick={() => { setEditingHoa(h); setForm({ property: h.property, hoa_name: h.hoa_name, amount: String(h.amount), due_date: h.due_date, frequency: h.frequency || "monthly", status: h.status, notes: h.notes || "" }); setShowForm(true); }} className="text-xs text-brand-600 hover:underline mr-2">Edit</button>
  <button onClick={() => deleteHOA(h.id)} className="text-xs text-danger-500 hover:underline">Delete</button>
  </td>
  </tr>
  ))}
  </tbody>
  </table>
  {filtered.length === 0 && <div className="text-center py-8 text-neutral-400">No HOA payments found</div>}
  </div>
  </div>
  );
}

export { HOAPayments };
