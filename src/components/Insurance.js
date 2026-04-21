import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { Input, Select, Btn, PageHeader, TextLink} from "../ui";
import { safeNum, parseLocalDate, formatLocalDate, formatCurrency } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { encryptCredential, decryptCredential } from "../utils/encryption";
import { logAudit } from "../utils/audit";
import { Spinner, Modal, PropertySelect } from "./shared";

function InsuranceTracker({ companySettings = {}, addNotification, userProfile, userRole, companyId, showToast, showConfirm }) {
  const [policies, setPolicies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState(null);
  const [form, setForm] = useState({ property: "", provider: "", policy_number: "", premium_amount: "", premium_frequency: "Annual", coverage_amount: "", expiration_date: "", notes: "", website: "", username: "", password: "" });
  const [propertyFilter, setPropertyFilter] = useState("all");
  const [showCreds, setShowCreds] = useState(new Set());

  useEffect(() => { fetchPolicies(); }, [companyId]);

  async function fetchPolicies() {
  const { data } = await supabase.from("property_insurance").select("*").eq("company_id", companyId).is("archived_at", null).order("created_at", { ascending: false });
  setPolicies(data || []);
  setLoading(false);
  }

  async function savePolicy() {
  if (!guardSubmit("savePolicy")) return;
  try {
  if (!form.property || !form.provider || !form.premium_amount) { showToast("Property, provider, and premium amount are required.", "error"); return; }
  const payload = { ...form, premium_amount: Number(form.premium_amount), coverage_amount: Number(form.coverage_amount || 0) };
  delete payload.username; delete payload.password;
  payload.website = form.website || "";
  if (form.username || form.password) {
    try {
      const resU = await encryptCredential(form.username || "", companyId);
      const resP = await encryptCredential(form.password || "", companyId, resU.salt);
      payload.username_encrypted = resU.encrypted;
      payload.password_encrypted = resP.encrypted;
      payload.encryption_iv_username = resU.iv || null;
      payload.encryption_iv = resP.iv || resU.iv;
      payload.encryption_salt = resU.salt || resP.salt;
    } catch (e) { showToast("Could not encrypt credentials — please try again: " + (e.message || e), "error"); return; }
  }
  if (editingPolicy) {
  const { error: polErr } = await supabase.from("property_insurance").update({ property: payload.property, provider: payload.provider, policy_number: payload.policy_number, premium_amount: payload.premium_amount, premium_frequency: payload.premium_frequency, coverage_amount: payload.coverage_amount, expiration_date: payload.expiration_date || null, notes: payload.notes, website: payload.website, username_encrypted: payload.username_encrypted || editingPolicy.username_encrypted || "", password_encrypted: payload.password_encrypted || editingPolicy.password_encrypted || "", encryption_iv: payload.encryption_iv || editingPolicy.encryption_iv || "", encryption_iv_username: payload.encryption_iv_username || editingPolicy.encryption_iv_username || null, encryption_salt: payload.encryption_salt || editingPolicy.encryption_salt || null }).eq("id", editingPolicy.id).eq("company_id", companyId);
  if (polErr) { showToast("Error updating policy: " + polErr.message, "error"); return; }
  addNotification("🛡️", `Policy updated: ${form.provider}`);
  logAudit("update", "insurance", `Policy updated: ${form.provider} ${formatCurrency(form.premium_amount)}`, editingPolicy.id, userProfile?.email, userRole, companyId);
  } else {
  const insPayload = { ...payload, company_id: companyId }; delete insPayload.username; delete insPayload.password;
  const { error: polErr } = await supabase.from("property_insurance").insert([insPayload]);
  if (polErr) { showToast("Error saving policy: " + polErr.message, "error"); return; }
  addNotification("🛡️", `Policy added: ${form.provider} — ${formatCurrency(form.premium_amount)}`);
  logAudit("create", "insurance", `Policy added: ${form.provider} ${formatCurrency(form.premium_amount)} at ${form.property}`, "", userProfile?.email, userRole, companyId);
  }
  setShowForm(false);
  setEditingPolicy(null);
  setForm({ property: "", provider: "", policy_number: "", premium_amount: "", premium_frequency: "Annual", coverage_amount: "", expiration_date: "", notes: "", website: "", username: "", password: "" });
  fetchPolicies();
  } finally { guardRelease("savePolicy"); }
  }

  async function deletePolicy(id) {
  if (!guardSubmit("deletePolicy")) return;
  try {
  if (!await showConfirm({ message: "Delete this insurance policy?", variant: "danger", confirmText: "Delete" })) return;
  const { error: delErr } = await supabase.from("property_insurance").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email }).eq("id", id).eq("company_id", companyId);
  if (delErr) { showToast("Error deleting policy: " + delErr.message, "error"); return; }
  logAudit("delete", "insurance", "Archived insurance policy", id, userProfile?.email, userRole, companyId);
  fetchPolicies();
  } finally { guardRelease("deletePolicy"); }
  }

  if (loading) return <Spinner />;

  const filtered = policies.filter(p => propertyFilter === "all" || p.property === propertyFilter);

  const today = new Date();
  const in90 = new Date(today.getTime() + 90 * 86400000);
  const activePolicies = policies;
  const totalAnnualPremium = policies.reduce((s, p) => {
  const amt = safeNum(p.premium_amount);
  if (p.premium_frequency === "Monthly") return s + amt * 12;
  if (p.premium_frequency === "Quarterly") return s + amt * 4;
  return s + amt;
  }, 0);
  const expiringSoon = policies.filter(p => {
  if (!p.expiration_date) return false;
  const exp = parseLocalDate(p.expiration_date);
  return exp >= today && exp <= in90;
  }).length;
  const uniqueProperties = [...new Set(policies.map(p => p.property).filter(Boolean))];

  const emptyForm = { property: "", provider: "", policy_number: "", premium_amount: "", premium_frequency: "Annual", coverage_amount: "", expiration_date: "", notes: "" };

  function expiryClass(expDate) {
  if (!expDate) return "";
  const exp = parseLocalDate(expDate);
  if (exp < today) return "bg-danger-50";
  if (exp <= in90) return "bg-warn-50";
  return "";
  }

  return (
  <div>
  <div className="flex flex-col md:flex-row gap-3 mb-4">
  <PageHeader title="Insurance" />
  <Select filter value={propertyFilter} onChange={e => setPropertyFilter(e.target.value)}>
  <option value="all">All Properties</option>
  {uniqueProperties.map(p => <option key={p} value={p}>{p}</option>)}
  </Select>
  <Btn variant="success-fill" onClick={() => { setEditingPolicy(null); setForm(emptyForm); setShowForm(true); }}>+ Add Policy</Btn>
  </div>

  {/* Stats */}
  <div className="flex gap-3 mb-4">
  <div className="rounded-xl shadow-sm border border-neutral-200 bg-white px-3 py-2 text-center flex-1"><div className="text-lg font-manrope font-bold text-neutral-800">{activePolicies.length}</div><div className="text-xs text-neutral-400">Active Policies</div></div>
  <div className="rounded-xl shadow-sm border border-neutral-200 bg-white px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-warn-600">{formatCurrency(totalAnnualPremium)}</div><div className="text-xs text-neutral-400">Total Premium (Annual)</div></div>
  <div className="rounded-xl shadow-sm border border-neutral-200 bg-white px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-success-600">{expiringSoon}</div><div className="text-xs text-neutral-400">Expiring Soon (90 days)</div></div>
  </div>

  {showForm && (
  <Modal title={editingPolicy ? "Edit Policy" : "New Insurance Policy"} onClose={() => { setShowForm(false); setEditingPolicy(null); }}>
  <div className="grid grid-cols-2 gap-3">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Property *</label><PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} companyId={companyId} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Provider *</label><Input placeholder="e.g. State Farm" value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Policy Number</label><Input placeholder="Policy #" value={form.policy_number} onChange={e => setForm({ ...form, policy_number: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Premium Amount ($) *</label><Input placeholder="1200" type="number" value={form.premium_amount} onChange={e => setForm({ ...form, premium_amount: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Premium Frequency</label><Select value={form.premium_frequency} onChange={e => setForm({ ...form, premium_frequency: e.target.value })}>
  <option value="Monthly">Monthly</option><option value="Quarterly">Quarterly</option><option value="Annual">Annual</option>
  </Select></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Coverage Amount ($)</label><Input placeholder="300000" type="number" value={form.coverage_amount} onChange={e => setForm({ ...form, coverage_amount: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Expiration Date</label><Input type="date" value={form.expiration_date} onChange={e => setForm({ ...form, expiration_date: e.target.value })} /></div>
  <div className="col-span-2"><label className="text-xs font-medium text-neutral-400 mb-1 block">Notes</label><Input placeholder="Optional notes" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></div>
  <div className="col-span-2 border-t border-neutral-100 pt-2 mt-1"><p className="text-xs text-neutral-400 mb-2">Insurance Portal Login (encrypted)</p>
  <div className="grid grid-cols-3 gap-2">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Website</label><Input type="url" value={form.website||""} onChange={e => setForm({...form, website: e.target.value})} placeholder="https://..." /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Username</label><Input value={form.username||""} onChange={e => setForm({...form, username: e.target.value})} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Password</label><Input type="password" value={form.password||""} onChange={e => setForm({...form, password: e.target.value})} /></div>
  </div></div>
  </div>
  <div className="flex gap-2 mt-4">
  <Btn variant="success-fill" onClick={savePolicy}>Save</Btn>
  <Btn variant="secondary" onClick={() => { setShowForm(false); setEditingPolicy(null); }}>Cancel</Btn>
  </div>
  </Modal>
  )}

  <div className="bg-white rounded-xl shadow-sm border border-neutral-200 overflow-x-auto">
  <table className="w-full text-sm">
  <thead className="bg-neutral-50 text-xs text-neutral-400 uppercase">
  <tr><th className="px-4 py-3 text-left">Property</th><th className="px-4 py-3 text-left">Provider</th><th className="px-4 py-3 text-left">Policy #</th><th className="px-4 py-3 text-right">Premium</th><th className="px-4 py-3 text-left">Freq.</th><th className="px-4 py-3 text-right">Coverage</th><th className="px-4 py-3 text-left">Expiry</th><th className="px-4 py-3 text-left">Portal</th><th className="px-4 py-3 text-right">Actions</th></tr>
  </thead>
  <tbody>
  {filtered.map(p => (
  <tr key={p.id} className={`border-t border-neutral-100 hover:bg-positive-50/40 ${expiryClass(p.expiration_date)}`}>
  <td className="px-4 py-2.5 text-neutral-800">{p.property}</td>
  <td className="px-4 py-2.5 font-medium text-neutral-800">{p.provider}</td>
  <td className="px-4 py-2.5 text-neutral-500">{p.policy_number || "—"}</td>
  <td className="px-4 py-2.5 text-right font-semibold">{formatCurrency(p.premium_amount)}</td>
  <td className="px-4 py-2.5 text-neutral-500">{p.premium_frequency}</td>
  <td className="px-4 py-2.5 text-right font-semibold">{formatCurrency(p.coverage_amount)}</td>
  <td className="px-4 py-2.5 text-neutral-400">{p.expiration_date || "—"}</td>
  <td className="px-4 py-2.5 text-xs">
  {p.website ? <a href={p.website} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline block truncate max-w-28">{p.website.replace(/^https?:\/\//, "")}</a> : <span className="text-neutral-300">—</span>}
  {p.username_encrypted && <TextLink tone="brand" size="xs" onClick={async () => { const s = new Set(showCreds); if (s.has(p.id)) { s.delete(p.id); setShowCreds(s); } else { p._decUser = await decryptCredential(p.username_encrypted, p.encryption_iv_username || p.encryption_iv, companyId, p.encryption_salt); p._decPass = await decryptCredential(p.password_encrypted, p.encryption_iv, companyId, p.encryption_salt); s.add(p.id); setShowCreds(new Set(s)); }}}>{showCreds.has(p.id) ? "Hide" : "Show"} login</TextLink>}
  {showCreds.has(p.id) && <div className="text-neutral-600 mt-0.5">{p._decUser || "—"} / {p._decPass || "—"}</div>}
  </td>
  <td className="px-4 py-2.5 text-right whitespace-nowrap">
  <TextLink tone="brand" size="xs" onClick={() => { setEditingPolicy(p); setForm({ property: p.property || "", provider: p.provider || "", policy_number: p.policy_number || "", premium_amount: String(p.premium_amount || ""), premium_frequency: p.premium_frequency || "Annual", coverage_amount: String(p.coverage_amount || ""), expiration_date: p.expiration_date || "", notes: p.notes || "", website: p.website || "", username: "", password: "" }); setShowForm(true); }} className="mr-2">Edit</TextLink>
  <TextLink tone="danger" size="xs" onClick={() => deletePolicy(p.id)}>Delete</TextLink>
  </td>
  </tr>
  ))}
  </tbody>
  </table>
  {filtered.length === 0 && <div className="text-center py-8 text-neutral-400">No insurance policies found</div>}
  </div>
  </div>
  );
}

export { InsuranceTracker };
