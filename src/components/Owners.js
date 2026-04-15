import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { Input, Textarea, Select, Btn, PageHeader } from "../ui";
import { safeNum, formatLocalDate, shortId, formatCurrency, parseLocalDate, normalizeEmail, exportToCSV, escapeHtml, sanitizeForPrint, formatPersonName, parseNameParts, formatPhoneInput, buildNameFields } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { queueNotification } from "../utils/notifications";
import { autoPostJournalEntry, autoOwnerDistribution, getPropertyClassId, atomicPostJEAndLedger, safeLedgerInsert, resolveAccountId } from "../utils/accounting";
import { Spinner, Modal, StatCard, Badge } from "./shared";

function OwnerManagement({ addNotification, userProfile, userRole, companyId, showToast, showConfirm }) {
  const [owners, setOwners] = useState([]);
  const [properties, setProperties] = useState([]);
  const [statements, setStatements] = useState([]);
  const [distributions, setDistributions] = useState([]);
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("owners");
  const [showForm, setShowForm] = useState(false);
  const [editingOwner, setEditingOwner] = useState(null);
  const [showStatementGen, setShowStatementGen] = useState(null);
  const [statementPeriod, setStatementPeriod] = useState(formatLocalDate(new Date()).slice(0, 7));
  const [viewStatement, setViewStatement] = useState(null);
  const [showDistForm, setShowDistForm] = useState(null);
  const [distForm, setDistForm] = useState({ amount: "", method: "check", reference: "", notes: "" });

  const [form, setForm] = useState({
  name: "", first_name: "", mi: "", last_name: "", email: "", phone: "", company: "",
  address: "", management_fee_pct: "10", payment_method: "check", notes: "",
  });

  useEffect(() => { fetchData(); }, [companyId]);

  async function fetchData() {
  setLoading(true);
  const [o, p, s, d, pay] = await Promise.all([
  supabase.from("owners").select("*").eq("company_id", companyId).is("archived_at", null).order("name"),
  supabase.from("properties").select("*").eq("company_id", companyId).is("archived_at", null),
  supabase.from("owner_statements").select("*").eq("company_id", companyId).order("created_at", { ascending: false }),
  supabase.from("owner_distributions").select("*").eq("company_id", companyId).order("date", { ascending: false }),
  supabase.from("payments").select("*").eq("company_id", companyId).order("date", { ascending: false }).limit(500),
  ]);
  setOwners(o.data || []);
  setProperties(p.data || []);
  setStatements(s.data || []);
  setDistributions(d.data || []);
  setPayments(pay.data || []);
  setLoading(false);
  }

  async function saveOwner() {
  if (!guardSubmit("saveOwner")) return;
  try {
  if (!form.name.trim()) { showToast("Owner name is required.", "error"); return; }
  const payload = {
  name: form.name,
  first_name: form.first_name,
  middle_initial: form.mi,
  last_name: form.last_name,
  email: normalizeEmail(form.email),
  phone: form.phone,
  company: form.company,
  address: form.address,
  management_fee_pct: Number(form.management_fee_pct) || 10,
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
  logAudit(editingOwner ? "update" : "create", "owners", (editingOwner ? "Updated" : "Added") + " owner: " + form.name, editingOwner?.id || "", userProfile?.email, userRole, companyId);
  addNotification("👤", (editingOwner ? "Updated" : "Added") + " owner: " + form.name);
  resetForm();
  fetchData();
  } finally { guardRelease("saveOwner"); }
  }

  function resetForm() {
  setShowForm(false);
  setEditingOwner(null);
  setForm({ name: "", first_name: "", mi: "", last_name: "", email: "", phone: "", company: "", address: "", management_fee_pct: "10", payment_method: "check", notes: "" });
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
  management_fee_pct: String(owner.management_fee_pct || 10),
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

  const ownerProps = properties.filter(p => String(p.owner_id) === String(owner.id));
  if (ownerProps.length === 0) { showToast("No properties assigned to this owner.", "error"); return; }
  const propAddresses = ownerProps.map(p => p.address);

  // Income: payments received for owner's properties in this period
  const periodPayments = payments.filter(p =>
  propAddresses.includes(p.property) && p.date >= startDate && p.date <= endDate
  );
  const totalIncome = periodPayments.reduce((s, p) => s + safeNum(p.amount), 0);

  // Expenses: work orders completed in this period for owner's properties
  const { data: woData } = await supabase.from("work_orders").select("*").eq("company_id", companyId).in("property", propAddresses).eq("status", "completed").gte("created", startDate).lte("created", endDate);
  const totalExpenses = (woData || []).reduce((s, w) => s + safeNum(w.cost), 0);

  // Management fee
  const feePct = owner.management_fee_pct || 10;
  const mgmtFee = Math.round(totalIncome * feePct / 100 * 100) / 100;
  const netToOwner = Math.round((totalIncome - totalExpenses - mgmtFee) * 100) / 100;

  // Build line items
  const lineItems = [];
  if (periodPayments.length > 0) {
  lineItems.push({
  category: "Income",
  items: periodPayments.map(p => ({
  date: p.date,
  description: `Rent — ${p.property}${p.tenant ? " (" + p.tenant + ")" : ""}`,
  amount: safeNum(p.amount),
  })),
  });
  }
  if (woData && woData.length > 0) {
  lineItems.push({
  category: "Expenses",
  items: woData.map(w => ({
  date: w.created,
  description: `Maintenance — ${w.issue} (${w.property})`,
  amount: -safeNum(w.cost),
  })),
  });
  }
  lineItems.push({
  category: "Management Fee",
  items: [{ date: endDate, description: `${feePct}% of $${totalIncome.toLocaleString()}`, amount: -mgmtFee }],
  });

  const { error } = await supabase.from("owner_statements").insert([{
  company_id: companyId,
  owner_id: owner.id,
  owner_name: owner.name,
  period: statementPeriod,
  total_income: totalIncome,
  total_expenses: totalExpenses,
  management_fee: mgmtFee,
  net_to_owner: netToOwner,
  line_items: JSON.stringify(lineItems),
  status: "draft",
  properties: propAddresses,
  }]);
  if (error) { pmError("PM-8006", { raw: error, context: "generate owner statement" }); return; }

  addNotification("📊", `Statement generated for ${owner.name} — ${statementPeriod}`);
  logAudit("create", "owner_statements", `Statement: ${statementPeriod} for ${owner.name} — Net: $${netToOwner}`, "", userProfile?.email, userRole, companyId);
  setShowStatementGen(null);
  fetchData();
  } finally { guardRelease("genStatement"); }
  }

  async function sendStatement(statement) {
  if (!guardSubmit("sendStatement")) return;
  try {
  await supabase.from("owner_statements").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", statement.id).eq("company_id", companyId);
  const owner = owners.find(o => String(o.id) === String(statement.owner_id));
  if (owner?.email) {
  queueNotification("owner_statement", owner.email, { owner: statement.owner_name, period: statement.period, net: statement.net_to_owner }, companyId);
  }
  addNotification("📧", `Statement sent to ${statement.owner_name}`);
  fetchData();
  } finally { guardRelease("sendStatement"); }
  }

  async function payOwner(owner) {
  if (!guardSubmit("payOwner")) return;
  try {
  if (!distForm.amount || isNaN(Number(distForm.amount)) || Number(distForm.amount) <= 0) { showToast("Enter a valid amount.", "error"); return; }
  const amt = Number(distForm.amount);
  const classId = await getPropertyClassId(properties.find(p => String(p.owner_id) === String(owner.id))?.address || "", companyId);
  const distResult = await atomicPostJEAndLedger({ companyId,
  date: formatLocalDate(new Date()),
  description: `Owner distribution — ${owner.name}`,
  reference: `DIST-${shortId()}`,
  property: "",
  lines: [
  { account_id: "2200", account_name: "Owner Distributions Payable", debit: amt, credit: 0, class_id: classId, memo: `Distribution to ${owner.name}` },
  { account_id: "1000", account_name: "Checking Account", debit: 0, credit: amt, class_id: classId, memo: `Paid to ${owner.name} via ${distForm.method}` },
  ], requireJE: false });
  if (!distResult.jeId) showToast("Warning: Distribution GL entry failed — please post manually in Accounting.", "error");

  const { error: distErr } = await supabase.from("owner_distributions").insert([{
  company_id: companyId,
  owner_id: owner.id,
  owner_name: owner.name,
  amount: amt,
  method: distForm.method,
  reference: distForm.reference || "DIST-" + shortId(),
  date: formatLocalDate(new Date()),
  notes: distForm.notes,
  status: "paid",
  }]);
  if (distErr) { pmError("PM-8006", { raw: distErr, context: "save owner distribution" }); return; }

  addNotification("💰", `$${amt.toLocaleString()} distributed to ${owner.name}`);
  logAudit("create", "owner_distributions", `Distribution: $${amt} to ${owner.name} via ${distForm.method}`, "", userProfile?.email, userRole, companyId);
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
  <StatCard label="Distributed (YTD)" value={formatCurrency(distributions.reduce((s, d) => s + safeNum(d.amount), 0))} color="text-positive-600" />
  <StatCard label="Properties" value={properties.filter(p => p.owner_id).length} color="text-neutral-500" sub="with owners" />
  </div>

  <div className="flex gap-1 mb-4 border-b border-brand-50">
  {[["owners","Owners"],["statements","Statements"],["distributions","Distributions"]].map(([id,label]) => (
  <button key={id} onClick={() => setActiveTab(id)} className={"px-4 py-2 text-sm font-medium border-b-2 " + (activeTab === id ? "border-brand-600 text-brand-700" : "border-transparent text-neutral-400")}>{label}</button>
  ))}
  </div>

  {/* Owner Form */}
  {showForm && (
  <div className="bg-white rounded-xl border border-brand-100 shadow-sm p-5 mb-5">
  <div className="flex items-center justify-between mb-4"><h3 className="font-manrope font-semibold text-neutral-800">{editingOwner ? "Edit Owner" : "Add New Owner"}</h3><Btn variant="ghost" onClick={resetForm} title="Close">✕</Btn></div>
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
  <div><label className="text-xs text-neutral-400 mb-1 block">Management Fee %</label><Input type="number" value={form.management_fee_pct} onChange={e => setForm({...form, management_fee_pct: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Payment Method</label>
  <Select value={form.payment_method} onChange={e => setForm({...form, payment_method: e.target.value})}>
  <option value="check">Check</option><option value="ach">ACH</option><option value="wire">Wire</option>
  </Select>
  </div>
  <div className="col-span-2"><label className="text-xs text-neutral-400 mb-1 block">Notes</label><Textarea value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} className="w-full border border-brand-100 rounded-2xl px-3 py-2 text-sm" rows={2} /></div>
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
  const lastDist = distributions.find(d => String(d.owner_id) === String(owner.id));
  return (
  <div key={owner.id} className="bg-white rounded-3xl shadow-card border border-brand-50 p-4">
  <div className="flex justify-between items-start mb-2">
  <div>
  <div className="text-sm font-bold text-neutral-800">{owner.name}{owner.company ? " — " + owner.company : ""}</div>
  <div className="text-xs text-neutral-400">{owner.email}{owner.phone ? " · " + owner.phone : ""}</div>
  </div>
  <div className="text-right">
  <div className="text-xs text-brand-600 font-bold">{owner.management_fee_pct}% fee</div>
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
  <Btn variant="secondary" size="xs" onClick={() => { setShowDistForm(owner); setDistForm({ amount: "", method: owner.payment_method || "check", reference: "", notes: "" }); }}>Pay Owner</Btn>
  <Btn variant="danger" size="xs" onClick={() => archiveOwner(owner)}>Archive</Btn>
  </div>
  </div>
  );
  })}
  {owners.length === 0 && <div className="text-center py-12 text-neutral-400">No owners yet. Add one above.</div>}
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
  <div><label className="text-xs text-neutral-400 block mb-1">Amount ($) *</label><Input type="number" value={distForm.amount} onChange={e => setDistForm({...distForm, amount: e.target.value})} placeholder="0.00" /></div>
  <div><label className="text-xs text-neutral-400 block mb-1">Method</label>
  <Select value={distForm.method} onChange={e => setDistForm({...distForm, method: e.target.value})}>
  <option value="check">Check</option><option value="ach">ACH</option><option value="wire">Wire</option>
  </Select>
  </div>
  <div><label className="text-xs text-neutral-400 block mb-1">Reference #</label><Input value={distForm.reference} onChange={e => setDistForm({...distForm, reference: e.target.value})} placeholder="Check # or ACH ref" /></div>
  <div><label className="text-xs text-neutral-400 block mb-1">Notes</label><Input value={distForm.notes} onChange={e => setDistForm({...distForm, notes: e.target.value})} /></div>
  <Btn onClick={() => payOwner(showDistForm)} className="w-full">Process Distribution</Btn>
  </div>
  </Modal>
  )}

  {/* STATEMENTS TAB */}
  {activeTab === "statements" && !viewStatement && (
  <div className="space-y-2">
  {statements.map(s => (
  <div key={s.id} className="bg-white rounded-3xl border border-brand-50 px-4 py-3 flex justify-between items-center cursor-pointer hover:border-brand-200" onClick={() => setViewStatement(s)}>
  <div>
  <div className="text-sm font-semibold text-neutral-800">{s.owner_name} — {s.period}</div>
  <div className="text-xs text-neutral-400">{new Date(s.created_at).toLocaleDateString()}</div>
  </div>
  <div className="flex items-center gap-4">
  <div className="text-right">
  <div className="text-xs text-neutral-400">Net: <span className="text-brand-600 font-bold">${safeNum(s.net_to_owner).toLocaleString()}</span></div>
  </div>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (s.status === "paid" ? "bg-positive-100 text-positive-700" : s.status === "sent" ? "bg-info-100 text-info-700" : "bg-warn-100 text-warn-700")}>{s.status}</span>
  </div>
  </div>
  ))}
  {statements.length === 0 && <div className="text-center py-8 text-neutral-400">No statements generated yet</div>}
  </div>
  )}

  {/* Statement Detail */}
  {activeTab === "statements" && viewStatement && (
  <div>
  <Btn variant="ghost" size="sm" onClick={() => setViewStatement(null)}>← Back to Statements</Btn>
  <div className="bg-white rounded-3xl border border-brand-50 p-5">
  <div className="flex justify-between items-start mb-4">
  <div>
  <h3 className="font-bold text-neutral-800">Owner Statement — {viewStatement.period}</h3>
  <div className="text-xs text-neutral-400">{viewStatement.owner_name} · Generated {new Date(viewStatement.created_at).toLocaleDateString()}</div>
  </div>
  <div className="flex items-center gap-2">
  {viewStatement.status === "draft" && <Btn variant="secondary" size="xs" onClick={() => sendStatement(viewStatement)}>📧 Send</Btn>}
  <Btn onClick={() => { const w = window.open("", "_blank", "noopener,noreferrer"); w.document.write("<pre>" + escapeHtml(JSON.stringify(viewStatement, null, 2)) + "</pre>"); w.document.title = "Statement " + sanitizeForPrint(viewStatement.period); setTimeout(() => w.print(), 300); }} variant="secondary" size="xs"><span className="material-icons-outlined text-xs align-middle">print</span></Btn>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (viewStatement.status === "paid" ? "bg-positive-100 text-positive-700" : "bg-warn-100 text-warn-700")}>{viewStatement.status}</span>
  </div>
  </div>
  <div className="grid grid-cols-4 gap-3 mb-4">
  <div className="bg-positive-50 rounded-lg p-3 text-center"><div className="text-xs text-neutral-400">Income</div><div className="text-lg font-bold text-positive-600">${safeNum(viewStatement.total_income).toLocaleString()}</div></div>
  <div className="bg-danger-50 rounded-lg p-3 text-center"><div className="text-xs text-neutral-400">Expenses</div><div className="text-lg font-bold text-danger-500">${safeNum(viewStatement.total_expenses).toLocaleString()}</div></div>
  <div className="bg-highlight-50 rounded-lg p-3 text-center"><div className="text-xs text-neutral-400">Mgmt Fee</div><div className="text-lg font-bold text-highlight-600">${safeNum(viewStatement.management_fee).toLocaleString()}</div></div>
  <div className="bg-brand-50 rounded-lg p-3 text-center"><div className="text-xs text-neutral-400">Net to Owner</div><div className="text-lg font-bold text-brand-700">${safeNum(viewStatement.net_to_owner).toLocaleString()}</div></div>
  </div>
  {/* Line items */}
  {(() => { let items = []; try { items = JSON.parse(viewStatement.line_items || "[]"); } catch (_e) { pmError("PM-8006", { raw: _e, context: "parse statement line items", silent: true }); } return items.map((cat, ci) => (
  <div key={ci} className="mb-3">
  <div className="text-xs font-bold text-neutral-400 uppercase tracking-wider mb-1">{cat.category}</div>
  {(cat.items || []).map((item, ii) => (
  <div key={ii} className="flex justify-between text-xs py-1 border-b border-brand-50/50">
  <span className="text-neutral-500">{item.date} — {item.description}</span>
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
  <div key={d.id} className="bg-white rounded-3xl border border-brand-50 px-4 py-3 flex justify-between items-center">
  <div>
  <div className="text-sm font-medium text-neutral-800">{d.owner_name} — ${safeNum(d.amount).toLocaleString()}</div>
  <div className="text-xs text-neutral-400">{d.reference} · {d.date}{d.notes ? " · " + d.notes : ""}</div>
  </div>
  <div className="flex items-center gap-2">
  <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-positive-100 text-positive-700">{d.method?.toUpperCase()}</span>
  </div>
  </div>
  ))}
  {distributions.length === 0 && <div className="text-center py-8 text-neutral-400">No distributions yet</div>}
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
  <div key={wo.id} className="bg-white border border-brand-50 rounded-2xl p-4">
  <div className="flex justify-between items-start">
  <div>
  <div className="text-sm font-semibold text-neutral-800">{wo.issue}</div>
  <div className="text-xs text-neutral-400">{wo.property} · {wo.created || "—"}</div>
  </div>
  <div className="text-right">
  <span className="text-xs">{statusIcon[wo.status] || "⚪"} {wo.status}</span>
  {wo.cost > 0 && <div className="text-xs font-bold text-danger-500 mt-0.5">${safeNum(wo.cost).toLocaleString()}</div>}
  </div>
  </div>
  {wo.notes && <div className="text-xs text-neutral-400 mt-1">{wo.notes}</div>}
  </div>
  ))}
  {workOrders.length === 0 && <div className="text-center py-8 text-neutral-400">No maintenance activity</div>}
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
  <div className="text-lg font-bold">{ownerData.management_fee_pct}%</div>
  </div>
  </div>
  </div>

  {/* Stats */}
  <div className="grid grid-cols-2 gap-3 mb-6 md:grid-cols-4">
  <div className="bg-white rounded-3xl border border-brand-50 p-4 text-center">
  <div className="text-xs text-neutral-400 mb-1">Total Income</div>
  <div className="text-lg font-bold text-positive-600">${totalIncome.toLocaleString()}</div>
  </div>
  <div className="bg-white rounded-3xl border border-brand-50 p-4 text-center">
  <div className="text-xs text-neutral-400 mb-1">Total Expenses</div>
  <div className="text-lg font-bold text-danger-500">${totalExpenses.toLocaleString()}</div>
  </div>
  <div className="bg-white rounded-3xl border border-brand-50 p-4 text-center">
  <div className="text-xs text-neutral-400 mb-1">Distributions</div>
  <div className="text-lg font-bold text-brand-600">${totalDistributed.toLocaleString()}</div>
  </div>
  <div className="bg-white rounded-3xl border border-brand-50 p-4 text-center">
  <div className="text-xs text-neutral-400 mb-1">Pending</div>
  <div className="text-lg font-bold text-warn-600">{pendingStatements.length}</div>
  </div>
  </div>

  {/* Tabs */}
  <div className="flex gap-1 mb-5 border-b border-brand-50">
  {[["overview","\ud83c\udfe0 Overview"],["statements","\ud83d\udcca Statements"],["distributions","💰 Distributions"],["properties","\ud83c\udfe2 Properties"],["maintenance","🔧 Maintenance"]].map(([id, label]) => (
  <button key={id} onClick={() => { setActiveTab(id); setViewStatement(null); }} className={"px-4 py-2.5 text-sm font-medium border-b-2 transition-colors " + (activeTab === id ? "border-brand-600 text-brand-700" : "border-transparent text-neutral-400 hover:text-neutral-700")}>{label}</button>
  ))}
  </div>

  {/* OVERVIEW TAB */}
  {activeTab === "overview" && (
  <div className="space-y-4">
  <h3 className="font-semibold text-neutral-700">Your Properties</h3>
  <div className="grid gap-3 md:grid-cols-2">
  {properties.map(p => (
  <div key={p.id} className="bg-white rounded-3xl border border-brand-50 p-4">
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
  {properties.length === 0 && <div className="text-center py-8 text-neutral-400">No properties assigned yet</div>}
  </div>

  {/* Recent statements */}
  {statements.length > 0 && (
  <div>
  <h3 className="font-semibold text-neutral-700 mt-4 mb-2">Recent Statements</h3>
  {statements.slice(0, 3).map(s => (
  <div key={s.id} className="bg-white rounded-3xl border border-brand-50 px-4 py-3 flex justify-between items-center mb-2 cursor-pointer hover:border-brand-200" onClick={() => { setActiveTab("statements"); setViewStatement(s); }}>
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
  <div key={s.id} className="bg-white rounded-3xl border border-brand-50 px-4 py-3 flex justify-between items-center cursor-pointer hover:border-brand-200" onClick={() => setViewStatement(s)}>
  <div>
  <div className="text-sm font-semibold text-neutral-800">{s.period}</div>
  <div className="text-xs text-neutral-400">{new Date(s.created_at).toLocaleDateString()}</div>
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
  {statements.length === 0 && <div className="text-center py-8 text-neutral-400">No statements yet</div>}
  </div>
  )}

  {/* STATEMENT DETAIL */}
  {activeTab === "statements" && viewStatement && (
  <div>
  <Btn variant="ghost" size="sm" onClick={() => setViewStatement(null)}>{"\u2190"} Back to Statements</Btn>
  <div className="bg-white rounded-3xl border border-brand-50 p-5">
  <div className="flex justify-between items-start mb-4">
  <div>
  <h3 className="font-bold text-neutral-800">Owner Statement — {viewStatement.period}</h3>
  <div className="text-xs text-neutral-400">{viewStatement.owner_name} · Generated {new Date(viewStatement.created_at).toLocaleDateString()}</div>
  </div>
  <div className="flex items-center gap-2">
  <Btn onClick={() => { const w = window.open("", "_blank", "noopener,noreferrer"); w.document.write("<pre>" + escapeHtml(JSON.stringify(viewStatement, null, 2)) + "</pre>"); w.document.title = "Statement " + sanitizeForPrint(viewStatement.period); setTimeout(() => w.print(), 300); }} variant="secondary" size="xs"><span className="material-icons-outlined text-xs align-middle">print</span></Btn>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (viewStatement.status === "paid" ? "bg-positive-100 text-positive-700" : "bg-warn-100 text-warn-700")}>{viewStatement.status}</span>
  </div>
  </div>
  <div className="grid grid-cols-4 gap-3 mb-4">
  <div className="bg-positive-50 rounded-lg p-3 text-center"><div className="text-xs text-neutral-400">Income</div><div className="text-lg font-bold text-positive-600">${safeNum(viewStatement.total_income).toLocaleString()}</div></div>
  <div className="bg-danger-50 rounded-lg p-3 text-center"><div className="text-xs text-neutral-400">Expenses</div><div className="text-lg font-bold text-danger-500">${safeNum(viewStatement.total_expenses).toLocaleString()}</div></div>
  <div className="bg-highlight-50 rounded-lg p-3 text-center"><div className="text-xs text-neutral-400">Mgmt Fee</div><div className="text-lg font-bold text-highlight-600">${safeNum(viewStatement.management_fee).toLocaleString()}</div></div>
  <div className="bg-brand-50 rounded-lg p-3 text-center"><div className="text-xs text-neutral-400">Net to You</div><div className="text-lg font-bold text-brand-700">${safeNum(viewStatement.net_to_owner).toLocaleString()}</div></div>
  </div>
  {/* Line items */}
  {(() => { let items = []; try { items = JSON.parse(viewStatement.line_items || "[]"); } catch (_e) { pmError("PM-8006", { raw: _e, context: "parse statement line items", silent: true }); } return items.map((cat, ci) => (
  <div key={ci} className="mb-3">
  <div className="text-xs font-bold text-neutral-400 uppercase tracking-wider mb-1">{cat.category}</div>
  {(cat.items || []).map((item, ii) => (
  <div key={ii} className="flex justify-between text-xs py-1 border-b border-brand-50/50">
  <span className="text-neutral-500">{item.date} — {item.description}</span>
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
  <div key={d.id} className="bg-white rounded-3xl border border-brand-50 px-4 py-3 flex justify-between items-center">
  <div>
  <div className="text-sm font-medium text-neutral-800">${safeNum(d.amount).toLocaleString()}</div>
  <div className="text-xs text-neutral-400">{d.reference} · {new Date(d.date).toLocaleDateString()}</div>
  </div>
  <div className="text-right">
  <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-positive-100 text-positive-700">{d.method?.toUpperCase()}</span>
  </div>
  </div>
  ))}
  {distributions.length === 0 && <div className="text-center py-8 text-neutral-400">No distributions yet</div>}
  </div>
  )}

  {/* MAINTENANCE TAB */}
  {activeTab === "maintenance" && (
  <div>
  <h3 className="font-manrope font-bold text-neutral-700 mb-3">Maintenance Activity</h3>
  <OwnerMaintenanceView companyId={companyId} properties={properties} />
  </div>
  )}

  {/* PROPERTIES TAB */}
  {activeTab === "properties" && (
  <div className="space-y-3">
  {properties.map(p => (
  <div key={p.id} className="bg-white rounded-3xl border border-brand-50 p-4">
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
  {properties.length === 0 && <div className="text-center py-8 text-neutral-400">No properties assigned</div>}
  </div>
  )}
  </div>
  );
}

export { OwnerManagement, OwnerMaintenanceView, OwnerPortal };
