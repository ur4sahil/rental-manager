import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { Input, Select, Btn, PageHeader, TextLink, DataTable, EmptyState} from "../ui";
import { safeNum, formatLocalDate, formatCurrency, propertyLabel, fmtDate, formatPhoneInput} from "../utils/helpers";
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
  // Same shape as the property wizard's HOA step. An HOA added here and one
  // added there have to be the same record, or the page you used decides
  // which half of the information you are allowed to keep.
  const EMPTY_HOA_FORM = {
    property: "", hoa_name: "", amount: "", due_date: "", frequency: "monthly",
    status: "pending", notes: "", website: "", username: "", password: "",
    management_company: "", mgmt_website: "", mgmt_username: "", mgmt_password: "",
    pay_portal_website: "", pay_username: "", pay_password: "",
    contact_name: "", contact_email: "", contact_phone: "",
  };
  const [form, setForm] = useState({ ...EMPTY_HOA_FORM });
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
  // Deliberately a two-press flow, not an oversight. The first press
  // fills today's date INTO THE FIELD and stops, so the user sees the
  // date the app guessed and can change it before a payment record is
  // committed against it. Auto-saving with a silently defaulted due date
  // would be worse, not better.
  //
  // What was wrong was the styling: this is a prompt, not a failure, and
  // dressing it as an error toast made a normal path look broken.
  if (!form.due_date) {
    setForm({ ...form, due_date: formatLocalDate(new Date()) });
    showToast("No due date was set — today's date has been filled in. Check it, then save.", "warning");
    return;
  }
  const payload = { ...form, amount: Number(form.amount) };
  // Plaintext never reaches the payload. Three pairs now, not one.
  delete payload.username; delete payload.password;
  delete payload.mgmt_username; delete payload.mgmt_password;
  delete payload.pay_username; delete payload.pay_password;
  payload.website = form.website || "";
  if (form.username || form.password) {
    // Pair of creds shares one per-row salt (encryption_salt). Each value
    // gets its OWN IV — both preserved now (encryption_iv_username for
    // username, encryption_iv for password). Prior schema only held one
    // slot so username was unreadable after save.
    try {
      const resU = await encryptCredential(form.username || "", companyId);
      const resP = await encryptCredential(form.password || "", companyId, resU.salt);
      payload.username_encrypted = resU.encrypted;
      // Which key encrypted this. ENCRYPTION_KEY was rotated once with
      // nothing migrating the ciphertext, and every stored credential
      // silently stopped opening. A fingerprint turns the next rotation
      // into "re-enter this" instead of a credential that never works.
      payload.credential_key_fp = resU.keyFp || null;
      payload.password_encrypted = resP.encrypted;
      payload.encryption_iv_username = resU.iv || null;
      payload.encryption_iv = resP.iv || resU.iv;
      payload.encryption_salt = resU.salt || resP.salt;
    } catch (e) { showToast("Could not encrypt credentials — please try again: " + (e.message || e), "error"); return; }
  }

  // The management company's portal and the fee payment portal, each with its
  // own IV and all three sharing the row's single encryption_salt column.
  // Minting a salt per pair would write three salts into one column and two
  // of the three sets would decrypt to nothing.
  try {
    const rowSalt = payload.encryption_salt || (editingHoa && editingHoa.encryption_salt) || null;
    if (form.mgmt_username || form.mgmt_password) {
      const u = await encryptCredential(form.mgmt_username || "", companyId, rowSalt);
      const p2 = await encryptCredential(form.mgmt_password || "", companyId, u.salt);
      payload.mgmt_username_encrypted = u.encrypted || null;
      payload.mgmt_password_encrypted = p2.encrypted || null;
      payload.mgmt_encryption_iv_username = u.iv || null;
      payload.mgmt_encryption_iv = p2.iv || u.iv || null;
      payload.encryption_salt = payload.encryption_salt || u.salt || null;
      payload.credential_key_fp = payload.credential_key_fp || u.keyFp || null;
    }
    if (form.pay_username || form.pay_password) {
      const salt = payload.encryption_salt || rowSalt;
      const u = await encryptCredential(form.pay_username || "", companyId, salt);
      const p2 = await encryptCredential(form.pay_password || "", companyId, u.salt);
      payload.pay_username_encrypted = u.encrypted || null;
      payload.pay_password_encrypted = p2.encrypted || null;
      payload.pay_encryption_iv_username = u.iv || null;
      payload.pay_encryption_iv = p2.iv || u.iv || null;
      payload.encryption_salt = payload.encryption_salt || u.salt || null;
      payload.credential_key_fp = payload.credential_key_fp || u.keyFp || null;
    }
  } catch (e) { showToast("Could not encrypt the portal logins — please try again: " + (e.message || e), "error"); return; }

  payload.contact_email = (form.contact_email || "").trim().toLowerCase() || null;
  payload.contact_name = (form.contact_name || "").trim() || null;
  payload.contact_phone = (form.contact_phone || "").trim() || null;
  payload.management_company = (form.management_company || "").trim() || null;
  if (editingHoa) {
  const { error: hoaErr } = await supabase.from("hoa_payments").update({ property: payload.property, hoa_name: payload.hoa_name, amount: payload.amount, due_date: payload.due_date, frequency: payload.frequency, status: payload.status, notes: payload.notes, website: payload.website, username_encrypted: payload.username_encrypted || editingHoa.username_encrypted || null, password_encrypted: payload.password_encrypted || editingHoa.password_encrypted || null, encryption_iv: payload.encryption_iv || editingHoa.encryption_iv || null, encryption_iv_username: payload.encryption_iv_username || editingHoa.encryption_iv_username || null, encryption_salt: payload.encryption_salt || editingHoa.encryption_salt || null, credential_key_fp: payload.credential_key_fp || editingHoa.credential_key_fp || null,
    // The new fields. This UPDATE names its columns, so anything not listed
    // here is silently dropped on edit -- the field saves once on create and
    // then quietly reverts the first time someone changes the amount.
    management_company: payload.management_company ?? editingHoa.management_company ?? null,
    mgmt_website: payload.mgmt_website || editingHoa.mgmt_website || null,
    pay_portal_website: payload.pay_portal_website || editingHoa.pay_portal_website || null,
    contact_name: payload.contact_name ?? editingHoa.contact_name ?? null,
    contact_email: payload.contact_email ?? editingHoa.contact_email ?? null,
    contact_phone: payload.contact_phone ?? editingHoa.contact_phone ?? null,
    // Credentials keep what is stored when the form sends none: the boxes are
    // deliberately blank on edit because only ciphertext comes back.
    mgmt_username_encrypted: payload.mgmt_username_encrypted || editingHoa.mgmt_username_encrypted || null,
    mgmt_password_encrypted: payload.mgmt_password_encrypted || editingHoa.mgmt_password_encrypted || null,
    mgmt_encryption_iv: payload.mgmt_encryption_iv || editingHoa.mgmt_encryption_iv || null,
    mgmt_encryption_iv_username: payload.mgmt_encryption_iv_username || editingHoa.mgmt_encryption_iv_username || null,
    pay_username_encrypted: payload.pay_username_encrypted || editingHoa.pay_username_encrypted || null,
    pay_password_encrypted: payload.pay_password_encrypted || editingHoa.pay_password_encrypted || null,
    pay_encryption_iv: payload.pay_encryption_iv || editingHoa.pay_encryption_iv || null,
    pay_encryption_iv_username: payload.pay_encryption_iv_username || editingHoa.pay_encryption_iv_username || null,
  }).eq("id", editingHoa.id).eq("company_id", companyId);
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
  setForm({ ...EMPTY_HOA_FORM });
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
  // The date is part of the reference because
  // idx_je_company_reference_unique is unique on (company_id, reference).
  // Without it the SECOND payment against the same row collides, 409s,
  // autoPostJournalEntry returns null, and the payment is refused
  // forever. Keeping the date preserves the double-press protection the
  // unique index exists for, per day.
  reference: `HOA-${h.id}-${today}`,
  property: h.property,
  lines: [
  // 5450, not 5500. Code 5500 is "Bad Debt Expense" in _acctCodeToName,
  // so this line was LABELLED "HOA Fees" while account_id resolved to
  // Bad Debt Expense -- and in a company with no 5500 yet,
  // resolveAccountId would create a Bad Debt Expense account to receive
  // HOA payments. Production already has code 5500 meaning three
  // different things across companies (Bad Debt Expense, HOA Fees,
  // Property Management Fees). No HOA line has actually landed in Bad
  // Debt Expense yet -- this was latent, not yet realised.
  { account_id: "5450", account_name: "HOA Fees", debit: safeNum(h.amount), credit: 0, class_id: classId, memo: `HOA: ${h.hoa_name}` },
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
  <Btn onClick={() => { setEditingHoa(null); setForm({ ...EMPTY_HOA_FORM }); setShowForm(!showForm); }}>+ Add HOA</Btn>
  </div>

  {/* Stats */}
  <div className="flex gap-3 mb-4">
  <div className="bg-white rounded-xl border border-neutral-200 px-3 py-2 text-center flex-1"><div className="text-lg font-display font-bold text-neutral-800">{hoaPayments.length}</div><div className="text-xs text-neutral-400">Total</div></div>
  <div className="bg-white rounded-xl border border-neutral-200 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-warn-600">{hoaPayments.filter(h => h.status === "pending").length}</div><div className="text-xs text-neutral-400">Pending</div></div>
  <div className="bg-white rounded-xl border border-neutral-200 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-success-600">${hoaPayments.filter(h => h.status === "paid").reduce((s, h) => s + safeNum(h.amount), 0).toLocaleString()}</div><div className="text-xs text-neutral-400">Paid</div></div>
  </div>

  {showForm && (
  <div className="bg-white rounded-xl border border-neutral-200 shadow-card p-4 mb-4">
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
  <div className="col-span-2 border-t border-neutral-100 pt-2 mt-1"><p className="text-xs text-neutral-400 mb-2">Management company</p>
  <div className="grid grid-cols-2 gap-3 mb-2">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Company</label><Input value={form.management_company||""} onChange={e => setForm({...form, management_company: e.target.value})} placeholder="e.g. Acme Management" /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Website</label><Input type="url" value={form.mgmt_website||""} onChange={e => setForm({...form, mgmt_website: e.target.value})} placeholder="https://..." /></div>
  </div>
  <div className="grid grid-cols-2 gap-3">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Username</label><Input autoComplete="off" value={form.mgmt_username||""} onChange={e => setForm({...form, mgmt_username: e.target.value})} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Password</label><Input type="password" autoComplete="new-password" value={form.mgmt_password||""} onChange={e => setForm({...form, mgmt_password: e.target.value})} /></div>
  </div>
  </div>

  <div className="col-span-2 border-t border-neutral-100 pt-2 mt-1"><p className="text-xs text-neutral-400 mb-2">Fee payment portal <span className="text-neutral-300">— often a different site again</span></p>
  <div className="grid grid-cols-3 gap-3">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Website</label><Input type="url" value={form.pay_portal_website||""} onChange={e => setForm({...form, pay_portal_website: e.target.value})} placeholder="https://..." /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Username</label><Input autoComplete="off" value={form.pay_username||""} onChange={e => setForm({...form, pay_username: e.target.value})} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Password</label><Input type="password" autoComplete="new-password" value={form.pay_password||""} onChange={e => setForm({...form, pay_password: e.target.value})} /></div>
  </div>
  </div>

  <div className="col-span-2 border-t border-neutral-100 pt-2 mt-1"><p className="text-xs text-neutral-400 mb-2">HOA contact</p>
  <div className="grid grid-cols-3 gap-3">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Name</label><Input value={form.contact_name||""} onChange={e => setForm({...form, contact_name: e.target.value})} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Email</label><Input type="email" value={form.contact_email||""} onChange={e => setForm({...form, contact_email: e.target.value})} placeholder="name@example.com" /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Phone</label><Input type="tel" value={form.contact_phone||""} onChange={e => setForm({...form, contact_phone: formatPhoneInput(e.target.value)})} /></div>
  </div>
  </div>

  <div className="col-span-2 border-t border-neutral-100 pt-2 mt-1"><p className="text-xs text-neutral-400 mb-2">HOA's own portal login (encrypted)</p>
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

  <div className="bg-white rounded-xl border border-neutral-200 shadow-card overflow-x-auto">
  <DataTable
    columns={[
      { key: "property", label: "Property", className: "text-neutral-800",
        render: h => (<>{propertyLabel(h.property)}</>) },
      { key: "hoa_company", label: "HOA Company", className: "font-medium text-neutral-800",
        render: h => (<>{h.hoa_name}</>) },
      { key: "amount", label: "Amount", align: "right", className: "font-semibold",
        render: h => (<>${safeNum(h.amount).toLocaleString()}</>) },
      { key: "due_date", label: "Due Date", className: "text-neutral-400",
        render: h => (<>{fmtDate(h.due_date)}</>) },
      { key: "frequency", label: "Frequency", className: "text-neutral-500 capitalize",
        render: h => (<>{h.frequency}</>) },
      { key: "status", label: "Status",
        render: h => (<><Badge status={h.status} /></>) },
      { key: "portal", label: "Portal", className: "text-xs",
        render: h => (<>
          {h.website ? <a href={h.website} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline block truncate max-w-28">{h.website.replace(/^https?:\/\//, "")}</a> : <span className="text-neutral-300">—</span>}
            {h.username_encrypted && <TextLink tone="brand" size="xs" onClick={async () => { const s = new Set(showCreds); if (s.has(h.id)) { s.delete(h.id); setShowCreds(s); } else { h._decUser = await decryptCredential(h.username_encrypted, h.encryption_iv_username || h.encryption_iv, companyId, h.encryption_salt); h._decPass = await decryptCredential(h.password_encrypted, h.encryption_iv, companyId, h.encryption_salt); s.add(h.id); setShowCreds(new Set(s)); }}}>{showCreds.has(h.id) ? "Hide" : "Show"} login</TextLink>}
            {showCreds.has(h.id) && <div className="text-neutral-600 mt-0.5">{h._decUser || "—"} / {h._decPass || "—"}</div>}
        </>) },
      { key: "actions", label: "Actions", align: "right", className: "whitespace-nowrap",
        render: h => (<>
          {h.status === "pending" && <TextLink tone="positive" size="xs" onClick={() => payHOA(h)} className="mr-2">Pay</TextLink>}
            <TextLink tone="brand" size="xs" onClick={() => { setEditingHoa(h); setForm({ ...EMPTY_HOA_FORM, property: h.property, hoa_name: h.hoa_name, amount: String(h.amount), due_date: h.due_date, frequency: h.frequency || "monthly", status: h.status, notes: h.notes || "", website: h.website || "",
              management_company: h.management_company || "", mgmt_website: h.mgmt_website || "",
              pay_portal_website: h.pay_portal_website || "",
              contact_name: h.contact_name || "", contact_email: h.contact_email || "", contact_phone: h.contact_phone || "" }); setShowForm(true); }} className="mr-2">Edit</TextLink>
            <TextLink tone="danger" size="xs" onClick={() => deleteHOA(h.id)}>Delete</TextLink>
        </>) },
    ]}
    rows={filtered}
    rowKey={h => h.id}
    empty="Nothing to show"
  />
  {filtered.length === 0 && <EmptyState size="compact" title={"No HOA payments found"} />}
  </div>
  </div>
  );
}

export { HOAPayments };
