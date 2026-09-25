import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { Btn, Checkbox, Input, MoneyInput, PageHeader, Select, TextLink, DataTable, EmptyState} from "../ui";
import { safeNum, formatLocalDate, formatCurrency, propertyLabel, fmtDate, loanTypeOptions} from "../utils/helpers";
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
  const emptyPortfolioForm = { lender_name: "", loan_type: "Conventional", original_amount: "", current_balance: "", interest_rate: "", monthly_payment: "", account_number: "", loan_start_date: "", maturity_date: "", escrow_included: false, escrow_amount: "", status: "active", notes: "", website: "", username: "", password: "", properties: [] };
  const [portfolioLoans, setPortfolioLoans] = useState([]);
  const [portfolioProps, setPortfolioProps] = useState([]);
  const [showPortfolioForm, setShowPortfolioForm] = useState(false);
  const [editingPortfolio, setEditingPortfolio] = useState(null);
  const [portfolioForm, setPortfolioForm] = useState(emptyPortfolioForm);
  const [pfPropToAdd, setPfPropToAdd] = useState("");
  // Attach the loan form's property to a portfolio (blanket) loan.
  const [loanPortfolioId, setLoanPortfolioId] = useState("");
  const [origLoanPortfolioId, setOrigLoanPortfolioId] = useState("");

  useEffect(() => { fetchLoans(); fetchPortfolioLoans(); }, [companyId]);

  // Load the current portfolio attachment for whichever property the loan form
  // is on, so the dropdown reflects reality and save can detach/attach.
  useEffect(() => {
    if (!showForm || !form.property) { setLoanPortfolioId(""); setOrigLoanPortfolioId(""); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("portfolio_loan_properties").select("portfolio_loan_id")
        .eq("company_id", companyId).eq("property", form.property).maybeSingle();
      if (!cancelled) { const id = data?.portfolio_loan_id || ""; setLoanPortfolioId(id); setOrigLoanPortfolioId(id); }
    })();
    return () => { cancelled = true; };
  }, [showForm, form.property, companyId]);

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
  // Optional date columns are `date` in Postgres — an empty string is not a
  // valid date literal. Coerce blanks to null so INSERT behaves like UPDATE.
  payload.loan_start_date = form.loan_start_date || null;
  payload.maturity_date = form.maturity_date || null;
  payload.website = form.website || "";
  // Encrypted columns forbid '' (chk_property_loans_creds_not_blank) and default
  // to '', so we must write real ciphertext or NULL — never ''. Only save creds
  // when BOTH fields are present and both encrypt to non-empty (a Chrome autofill
  // that fills only one field would otherwise write a broken half-credential and
  // the whole save would fail the constraint).
  let creds = null;
  if (form.username && form.password) {
    try {
      const resU = await encryptCredential(form.username, companyId);
      const resP = await encryptCredential(form.password, companyId, resU.salt);
      if (resU.encrypted && resP.encrypted) {
        creds = {
          username_encrypted: resU.encrypted,
          password_encrypted: resP.encrypted,
          encryption_iv: resP.iv || resU.iv,
          encryption_iv_username: resU.iv || null,
          encryption_salt: resU.salt || resP.salt,
        };
      }
    } catch (e) { showToast("Could not encrypt credentials — please try again: " + (e.message || e), "error"); return; }
  }
  const nb = v => (v && v !== "" ? v : null); // null-if-blank: '' violates the not-blank constraint
  if (editingLoan) {
  const { error: loanErr } = await supabase.from("property_loans").update({ lender_name: payload.lender_name, loan_type: payload.loan_type, original_amount: payload.original_amount, current_balance: payload.current_balance, interest_rate: payload.interest_rate, monthly_payment: payload.monthly_payment, escrow_included: payload.escrow_included, escrow_amount: payload.escrow_amount, escrow_covers: payload.escrow_covers, loan_start_date: payload.loan_start_date || null, maturity_date: payload.maturity_date || null, account_number: payload.account_number, property: payload.property, notes: payload.notes, status: payload.status, website: payload.website, username_encrypted: creds ? creds.username_encrypted : nb(editingLoan.username_encrypted), password_encrypted: creds ? creds.password_encrypted : nb(editingLoan.password_encrypted), encryption_iv: creds ? creds.encryption_iv : nb(editingLoan.encryption_iv), encryption_iv_username: creds ? creds.encryption_iv_username : nb(editingLoan.encryption_iv_username), encryption_salt: creds ? creds.encryption_salt : nb(editingLoan.encryption_salt) }).eq("id", editingLoan.id).eq("company_id", companyId);
  if (loanErr) { showToast("Error updating loan: " + loanErr.message, "error"); return; }
  addNotification("🏦", `Loan updated: ${form.lender_name}`);
  logAudit("update", "loans", `Loan updated: ${form.lender_name} ${formatCurrency(form.original_amount)}`, editingLoan.id, userProfile?.email, userRole, companyId);
  } else {
  // No creds -> write NULLs, not the '' column default (which fails the constraint).
  const insPayload = { ...payload, company_id: companyId,
    username_encrypted: creds ? creds.username_encrypted : null,
    password_encrypted: creds ? creds.password_encrypted : null,
    encryption_iv: creds ? creds.encryption_iv : null,
    encryption_iv_username: creds ? creds.encryption_iv_username : null,
    encryption_salt: creds ? creds.encryption_salt : null };
  delete insPayload.username; delete insPayload.password;
  const { error: loanErr } = await supabase.from("property_loans").insert([insPayload]);
  if (loanErr) { showToast("Error saving loan: " + loanErr.message, "error"); return; }
  addNotification("🏦", `Loan added: ${form.lender_name} — ${formatCurrency(form.original_amount)}`);
  logAudit("create", "loans", `Loan added: ${form.lender_name} ${formatCurrency(form.original_amount)} at ${form.property}`, "", userProfile?.email, userRole, companyId);
  }
  // Attach/detach this property to the chosen portfolio (blanket) loan.
  if (loanPortfolioId !== origLoanPortfolioId && form.property) {
    if (origLoanPortfolioId) {
      await supabase.from("portfolio_loan_properties").delete().eq("company_id", companyId).eq("portfolio_loan_id", origLoanPortfolioId).eq("property", form.property);
    }
    if (loanPortfolioId) {
      await supabase.from("portfolio_loan_properties").upsert({ company_id: companyId, portfolio_loan_id: loanPortfolioId, property: form.property }, { onConflict: "portfolio_loan_id,property" });
    }
    fetchPortfolioLoans();
  }
  setShowForm(false);
  setEditingLoan(null);
  setLoanPortfolioId(""); setOrigLoanPortfolioId("");
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
  // Date-qualified: idx_je_company_reference_unique made `LOAN-<id>`
  // single-use, so a loan could only ever have ONE payment recorded.
  // Every subsequent month 409'd and the balance was never updated.
  reference: `LOAN-${loan.id}-${today}`,
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

  async function fetchPortfolioLoans() {
  const [{ data: pl }, { data: pp }] = await Promise.all([
    supabase.from("portfolio_loans").select("*").eq("company_id", companyId).is("archived_at", null).order("created_at", { ascending: false }),
    supabase.from("portfolio_loan_properties").select("*").eq("company_id", companyId),
  ]);
  setPortfolioLoans(pl || []);
  setPortfolioProps(pp || []);
  }

  async function savePortfolioLoan() {
  if (!guardSubmit("savePortfolioLoan")) return;
  try {
  if (!portfolioForm.lender_name || !portfolioForm.original_amount) { showToast("Lender name and original amount are required.", "error"); return; }
  if (!portfolioForm.properties.length) { showToast("Attach at least one property to the portfolio loan.", "error"); return; }
  const base = {
    lender_name: portfolioForm.lender_name, loan_type: portfolioForm.loan_type,
    original_amount: Number(portfolioForm.original_amount),
    current_balance: Number(portfolioForm.current_balance || portfolioForm.original_amount),
    interest_rate: Number(portfolioForm.interest_rate || 0), monthly_payment: Number(portfolioForm.monthly_payment || 0),
    account_number: portfolioForm.account_number || null,
    loan_start_date: portfolioForm.loan_start_date || null, maturity_date: portfolioForm.maturity_date || null,
    escrow_included: portfolioForm.escrow_included, escrow_amount: portfolioForm.escrow_included ? Number(portfolioForm.escrow_amount || 0) : 0,
    status: portfolioForm.status, notes: portfolioForm.notes || "", website: portfolioForm.website || "",
  };
  if (portfolioForm.username && portfolioForm.password) {
    try {
      const resU = await encryptCredential(portfolioForm.username || "", companyId);
      const resP = await encryptCredential(portfolioForm.password || "", companyId, resU.salt);
      base.username_encrypted = resU.encrypted; base.password_encrypted = resP.encrypted;
      base.encryption_iv_username = resU.iv || null; base.encryption_iv = resP.iv || resU.iv; base.encryption_salt = resU.salt || resP.salt;
    } catch (e) { showToast("Could not encrypt credentials: " + (e.message || e), "error"); return; }
  }
  let loanId = editingPortfolio?.id;
  if (editingPortfolio) {
    const { error } = await supabase.from("portfolio_loans").update({ ...base, updated_at: new Date().toISOString() }).eq("id", editingPortfolio.id).eq("company_id", companyId);
    if (error) { showToast("Error updating portfolio loan: " + error.message, "error"); return; }
  } else {
    const { data, error } = await supabase.from("portfolio_loans").insert([{ ...base, company_id: companyId }]).select("id").single();
    if (error) { showToast("Error saving portfolio loan: " + error.message, "error"); return; }
    loanId = data.id;
  }
  // Replace the property links with the current selection.
  await supabase.from("portfolio_loan_properties").delete().eq("portfolio_loan_id", loanId).eq("company_id", companyId);
  const links = portfolioForm.properties.map(p => ({ company_id: companyId, portfolio_loan_id: loanId, property: p }));
  if (links.length) { const { error: le } = await supabase.from("portfolio_loan_properties").insert(links); if (le) { showToast("Loan saved, but attaching properties failed: " + le.message, "error"); } }
  addNotification("\ud83c\udfe6", `Portfolio loan ${editingPortfolio ? "updated" : "added"}: ${portfolioForm.lender_name}`);
  logAudit(editingPortfolio ? "update" : "create", "loans", `Portfolio loan: ${portfolioForm.lender_name} across ${portfolioForm.properties.length} propert${portfolioForm.properties.length === 1 ? "y" : "ies"}`, loanId, userProfile?.email, userRole, companyId);
  setShowPortfolioForm(false); setEditingPortfolio(null); setPortfolioForm(emptyPortfolioForm);
  fetchPortfolioLoans();
  } finally { guardRelease("savePortfolioLoan"); }
  }

  async function deletePortfolioLoan(id) {
  if (!await showConfirm({ message: "Archive this portfolio loan? Its property links are removed.", confirmText: "Archive" })) return;
  const { error } = await supabase.from("portfolio_loans").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email || null }).eq("id", id).eq("company_id", companyId);
  if (error) { showToast("Error: " + error.message, "error"); return; }
  logAudit("delete", "loans", "Portfolio loan archived", id, userProfile?.email, userRole, companyId);
  fetchPortfolioLoans();
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

  const emptyForm = { lender_name: "", loan_type: "Conventional", original_amount: "", current_balance: "", interest_rate: "", monthly_payment: "", escrow_included: false, escrow_amount: "", escrow_covers: "", loan_start_date: "", maturity_date: "", account_number: "", property: "", notes: "", status: "active", website: "", username: "", password: "" };

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
  <div className="rounded-xl shadow-card border border-neutral-200 bg-white px-3 py-2 text-center flex-1"><div className="text-lg font-display font-bold text-neutral-800">{activeLoans.length}</div><div className="text-xs text-neutral-400">Active Loans</div></div>
  <div className="rounded-xl shadow-card border border-neutral-200 bg-white px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-warn-600">{formatCurrency(totalMonthly)}</div><div className="text-xs text-neutral-400">Total Monthly Payments</div></div>
  <div className="rounded-xl shadow-card border border-neutral-200 bg-white px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-success-600">{formatCurrency(totalBalance)}</div><div className="text-xs text-neutral-400">Total Outstanding Balance</div></div>
  </div>

  {showForm && (
  <Modal title={editingLoan ? "Edit Loan" : "New Loan"} onClose={() => { setShowForm(false); setEditingLoan(null); }}>
  <div className="grid grid-cols-2 gap-3">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Property *</label><PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} companyId={companyId} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Lender Name *</label><Input placeholder="e.g. Wells Fargo" value={form.lender_name} onChange={e => setForm({ ...form, lender_name: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Loan Type</label><Select value={form.loan_type} onChange={e => setForm({ ...form, loan_type: e.target.value })}>
  {loanTypeOptions(form.loan_type).map(t => <option key={t} value={t}>{t}</option>)}
  </Select></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Original Amount ($) *</label><MoneyInput placeholder="250000" value={form.original_amount} onChange={v => setForm({ ...form, original_amount: v })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Current Balance ($)</label><MoneyInput placeholder="230000" value={form.current_balance} onChange={v => setForm({ ...form, current_balance: v })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Interest Rate (%)</label><Input placeholder="6.5" type="number" step="0.01" value={form.interest_rate} onChange={e => setForm({ ...form, interest_rate: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Monthly Payment ($)</label><MoneyInput placeholder="1800" value={form.monthly_payment} onChange={v => setForm({ ...form, monthly_payment: v })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Account Number</label><Input placeholder="Loan account #" value={form.account_number} onChange={e => setForm({ ...form, account_number: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Loan Start Date</label><Input type="date" value={form.loan_start_date} onChange={e => setForm({ ...form, loan_start_date: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Maturity Date</label><Input type="date" value={form.maturity_date} onChange={e => setForm({ ...form, maturity_date: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Status</label><Select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
  <option value="active">Active</option><option value="paid_off">Paid Off</option>
  </Select></div>
  <div className="col-span-2"><label className="text-xs font-medium text-neutral-400 mb-1 block">Notes</label><Input placeholder="Optional notes" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></div>
  <div className="col-span-2">
  <label className="flex items-center gap-2 cursor-pointer"><Checkbox checked={form.escrow_included} onChange={e => setForm({ ...form, escrow_included: e.target.checked })} className="rounded" /><span className="text-sm text-neutral-600">Escrow Included</span></label>
  </div>
  {form.escrow_included && (
  <>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Escrow Amount ($)</label><MoneyInput placeholder="350" value={form.escrow_amount} onChange={v => setForm({ ...form, escrow_amount: v })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Escrow Covers</label><Input placeholder="e.g. Taxes, Insurance" value={form.escrow_covers} onChange={e => setForm({ ...form, escrow_covers: e.target.value })} /></div>
  </>
  )}
  <div className="col-span-2 border-t border-neutral-100 pt-2 mt-1">
  <label className="text-xs font-medium text-neutral-400 mb-1 block">Covered by a portfolio loan?</label>
  <Select value={loanPortfolioId} onChange={e => { if (e.target.value === "__new__") { setShowForm(false); setEditingPortfolio(null); setPortfolioForm(emptyPortfolioForm); setPfPropToAdd(""); setShowPortfolioForm(true); } else setLoanPortfolioId(e.target.value); }}>
  <option value="">No — its own loan (or none)</option>
  {portfolioLoans.map(pl => <option key={pl.id} value={pl.id}>{pl.lender_name} — {formatCurrency(pl.current_balance)}</option>)}
  <option value="__new__">+ New portfolio loan…</option>
  </Select>
  <p className="text-xs text-neutral-400 mt-1">A portfolio (blanket) loan spans several properties. Attach this property to one, or create a new one.</p>
  </div>
  <div className="col-span-2 border-t border-neutral-100 pt-2 mt-1"><p className="text-xs text-neutral-400 mb-2">Lender Portal Login (encrypted)</p>
  <div className="grid grid-cols-3 gap-2">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Website</label><Input type="url" autoComplete="off" value={form.website||""} onChange={e => setForm({...form, website: e.target.value})} placeholder="https://..." /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Username</label><Input name="loan_portal_user" autoComplete="off" value={form.username||""} onChange={e => setForm({...form, username: e.target.value})} placeholder={editingLoan ? "Saved \u2014 leave blank to keep" : ""} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Password</label><Input type="password" name="loan_portal_pass" autoComplete="new-password" value={form.password||""} onChange={e => setForm({...form, password: e.target.value})} placeholder={editingLoan ? "Saved \u2014 leave blank to keep" : ""} /></div>
  </div></div>
  </div>
  <div className="flex gap-2 mt-4">
  <Btn variant="success-fill" onClick={saveLoan}>Save</Btn>
  <Btn variant="secondary" onClick={() => { setShowForm(false); setEditingLoan(null); }}>Cancel</Btn>
  </div>
  </Modal>
  )}

  <div className="bg-white rounded-xl border border-neutral-200 shadow-card overflow-x-auto">
  <DataTable
    columns={[
      { key: "property", label: "Property", className: "text-neutral-800",
        render: l => (<>{propertyLabel(l.property)}</>) },
      { key: "lender", label: "Lender", className: "font-medium text-neutral-800",
        render: l => (<>{l.lender_name}</>) },
      { key: "type", label: "Type", className: "text-neutral-500",
        render: l => (<>{l.loan_type}</>) },
      { key: "rate", label: "Rate", align: "right", className: "text-neutral-600",
        render: l => (<>{safeNum(l.interest_rate).toFixed(2)}%</>) },
      { key: "monthly", label: "Monthly", align: "right", className: "font-semibold",
        render: l => (<>{formatCurrency(l.monthly_payment)}</>) },
      { key: "balance", label: "Balance", align: "right", className: "font-semibold",
        render: l => (<>{formatCurrency(l.current_balance)}</>) },
      { key: "maturity", label: "Maturity", className: "text-neutral-400",
        render: l => (<>{fmtDate(l.maturity_date) || "—"}</>) },
      { key: "portal", label: "Portal", className: "text-xs",
        render: l => (<>
          {l.website ? <a href={l.website} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline block truncate max-w-28">{l.website.replace(/^https?:\/\//, "")}</a> : <span className="text-neutral-300">—</span>}
            {l.username_encrypted && <TextLink tone="brand" size="xs" onClick={async () => { const s = new Set(showCreds); if (s.has(l.id)) { s.delete(l.id); setShowCreds(s); } else { l._decUser = await decryptCredential(l.username_encrypted, l.encryption_iv_username || l.encryption_iv, companyId, l.encryption_salt); l._decPass = await decryptCredential(l.password_encrypted, l.encryption_iv, companyId, l.encryption_salt); s.add(l.id); setShowCreds(new Set(s)); }}}>{showCreds.has(l.id) ? "Hide" : "Show"} login</TextLink>}
            {showCreds.has(l.id) && <div className="text-neutral-600 mt-0.5">{l._decUser || "—"} / {l._decPass || "—"}</div>}
        </>) },
      { key: "actions", label: "Actions", align: "right", className: "whitespace-nowrap",
        render: l => (<>
          {l.status === "active" && <TextLink tone="positive" size="xs" onClick={() => recordPayment(l)} className="mr-2">Record Payment</TextLink>}
            <TextLink tone="brand" size="xs" onClick={() => { setEditingLoan(l); setForm({ lender_name: l.lender_name, loan_type: l.loan_type || "Conventional", original_amount: String(l.original_amount || ""), current_balance: String(l.current_balance || ""), interest_rate: String(l.interest_rate || ""), monthly_payment: String(l.monthly_payment || ""), escrow_included: l.escrow_included || false, escrow_amount: String(l.escrow_amount || ""), escrow_covers: l.escrow_covers || "", loan_start_date: l.loan_start_date || "", maturity_date: l.maturity_date || "", account_number: l.account_number || "", property: l.property || "", notes: l.notes || "", status: l.status || "active", website: l.website || "", username: "", password: "" }); setShowForm(true); }} className="mr-2">Edit</TextLink>
            <TextLink tone="danger" size="xs" onClick={() => deleteLoan(l.id)}>Delete</TextLink>
        </>) },
    ]}
    rows={filtered}
    rowKey={l => l.id}
    empty="Nothing to show"
  />
  {filtered.length === 0 && <EmptyState size="compact" title={"No loans found"} />}
  </div>

  {/* ---- Portfolio Loans: one loan across many properties, tracked only ---- */}
  <div className="mt-8">
  <div className="flex flex-col md:flex-row md:items-center gap-2 mb-2">
  <div><h2 className="text-lg font-display font-bold text-neutral-800">Portfolio Loans</h2>
  <p className="text-xs text-neutral-400">One loan covering multiple properties — entered once, tracked at the portfolio level (no per-property split).</p></div>
  <Btn variant="success-fill" className="md:ml-auto" onClick={() => { setEditingPortfolio(null); setPortfolioForm(emptyPortfolioForm); setPfPropToAdd(""); setShowPortfolioForm(true); }}>+ Add Portfolio Loan</Btn>
  </div>
  <div className="bg-white rounded-xl border border-neutral-200 shadow-card overflow-x-auto">
  <DataTable
    columns={[
      { key: "lender", label: "Lender", className: "font-medium text-neutral-800", render: l => (<>{l.lender_name}</>) },
      { key: "type", label: "Type", className: "text-neutral-500", render: l => (<>{l.loan_type}</>) },
      { key: "props", label: "Properties", className: "text-neutral-600 text-xs",
        render: l => { const ps = portfolioProps.filter(p => p.portfolio_loan_id === l.id); return ps.length
          ? <span title={ps.map(p => p.property).join(", ")}>{ps.length} propert{ps.length === 1 ? "y" : "ies"}</span>
          : <span className="text-neutral-300">none</span>; } },
      { key: "rate", label: "Rate", align: "right", className: "text-neutral-600", render: l => (<>{safeNum(l.interest_rate).toFixed(2)}%</>) },
      { key: "monthly", label: "Monthly", align: "right", className: "font-semibold", render: l => (<>{formatCurrency(l.monthly_payment)}</>) },
      { key: "balance", label: "Balance", align: "right", className: "font-semibold", render: l => (<>{formatCurrency(l.current_balance)}</>) },
      { key: "maturity", label: "Maturity", className: "text-neutral-400", render: l => (<>{fmtDate(l.maturity_date) || "\u2014"}</>) },
      { key: "actions", label: "Actions", align: "right", className: "whitespace-nowrap", render: l => (<>
        <TextLink tone="brand" size="xs" className="mr-2" onClick={() => { setEditingPortfolio(l); setPfPropToAdd(""); setPortfolioForm({ lender_name: l.lender_name, loan_type: l.loan_type || "Conventional", original_amount: String(l.original_amount || ""), current_balance: String(l.current_balance || ""), interest_rate: String(l.interest_rate || ""), monthly_payment: String(l.monthly_payment || ""), account_number: l.account_number || "", loan_start_date: l.loan_start_date || "", maturity_date: l.maturity_date || "", escrow_included: l.escrow_included || false, escrow_amount: String(l.escrow_amount || ""), status: l.status || "active", notes: l.notes || "", website: l.website || "", username: "", password: "", properties: portfolioProps.filter(p => p.portfolio_loan_id === l.id).map(p => p.property) }); setShowPortfolioForm(true); }}>Edit</TextLink>
        <TextLink tone="danger" size="xs" onClick={() => deletePortfolioLoan(l.id)}>Delete</TextLink>
      </>) },
    ]}
    rows={portfolioLoans}
    rowKey={l => l.id}
    empty="No portfolio loans"
  />
  {portfolioLoans.length === 0 && <EmptyState size="compact" title={"No portfolio loans yet"} />}
  </div>
  </div>

  {showPortfolioForm && (
  <Modal title={editingPortfolio ? "Edit Portfolio Loan" : "New Portfolio Loan"} onClose={() => { setShowPortfolioForm(false); setEditingPortfolio(null); }}>
  <div className="grid grid-cols-2 gap-3">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Lender Name *</label><Input placeholder="e.g. Kiavi Portfolio" value={portfolioForm.lender_name} onChange={e => setPortfolioForm({ ...portfolioForm, lender_name: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Loan Type</label><Select value={portfolioForm.loan_type} onChange={e => setPortfolioForm({ ...portfolioForm, loan_type: e.target.value })}>
  {loanTypeOptions(portfolioForm.loan_type).map(t => <option key={t} value={t}>{t}</option>)}
  </Select></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Original Amount ($) *</label><MoneyInput placeholder="1000000" value={portfolioForm.original_amount} onChange={v => setPortfolioForm({ ...portfolioForm, original_amount: v })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Current Balance ($)</label><MoneyInput placeholder="950000" value={portfolioForm.current_balance} onChange={v => setPortfolioForm({ ...portfolioForm, current_balance: v })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Interest Rate (%)</label><Input placeholder="7.25" type="number" step="0.01" value={portfolioForm.interest_rate} onChange={e => setPortfolioForm({ ...portfolioForm, interest_rate: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Monthly Payment ($)</label><MoneyInput placeholder="6800" value={portfolioForm.monthly_payment} onChange={v => setPortfolioForm({ ...portfolioForm, monthly_payment: v })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Account Number</label><Input placeholder="Loan account #" value={portfolioForm.account_number} onChange={e => setPortfolioForm({ ...portfolioForm, account_number: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Status</label><Select value={portfolioForm.status} onChange={e => setPortfolioForm({ ...portfolioForm, status: e.target.value })}><option value="active">Active</option><option value="paid_off">Paid Off</option></Select></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Loan Start Date</label><Input type="date" value={portfolioForm.loan_start_date} onChange={e => setPortfolioForm({ ...portfolioForm, loan_start_date: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Maturity Date</label><Input type="date" value={portfolioForm.maturity_date} onChange={e => setPortfolioForm({ ...portfolioForm, maturity_date: e.target.value })} /></div>
  <div className="col-span-2">
  <label className="text-xs font-medium text-neutral-400 mb-1 block">Properties Covered *</label>
  <PropertySelect value={pfPropToAdd} onChange={v => { if (v && !portfolioForm.properties.includes(v)) setPortfolioForm(f => ({ ...f, properties: [...f.properties, v] })); setPfPropToAdd(""); }} companyId={companyId} />
  <div className="flex flex-wrap gap-1 mt-2">
  {portfolioForm.properties.map(p => <span key={p} className="inline-flex items-center gap-1 bg-neutral-100 rounded-lg px-2 py-1 text-xs text-neutral-700">{propertyLabel(p)}<button type="button" onClick={() => setPortfolioForm(f => ({ ...f, properties: f.properties.filter(x => x !== p) }))} className="text-neutral-400 hover:text-danger-600 leading-none">\u00d7</button></span>)}
  {portfolioForm.properties.length === 0 && <span className="text-xs text-neutral-400">No properties attached yet — add the ones this loan covers.</span>}
  </div>
  </div>
  <div className="col-span-2"><label className="text-xs font-medium text-neutral-400 mb-1 block">Notes</label><Input placeholder="Optional notes" value={portfolioForm.notes} onChange={e => setPortfolioForm({ ...portfolioForm, notes: e.target.value })} /></div>
  <div className="col-span-2"><label className="flex items-center gap-2 cursor-pointer"><Checkbox checked={portfolioForm.escrow_included} onChange={e => setPortfolioForm({ ...portfolioForm, escrow_included: e.target.checked })} className="rounded" /><span className="text-sm text-neutral-600">Escrow Included</span></label></div>
  {portfolioForm.escrow_included && <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Escrow Amount ($)</label><MoneyInput placeholder="1200" value={portfolioForm.escrow_amount} onChange={v => setPortfolioForm({ ...portfolioForm, escrow_amount: v })} /></div>}
  <div className="col-span-2 border-t border-neutral-100 pt-2 mt-1"><p className="text-xs text-neutral-400 mb-2">Lender Portal Login (encrypted)</p>
  <div className="grid grid-cols-3 gap-2">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Website</label><Input type="url" value={portfolioForm.website || ""} onChange={e => setPortfolioForm({ ...portfolioForm, website: e.target.value })} placeholder="https://..." /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Username</label><Input name="pf_portal_user" autoComplete="off" value={portfolioForm.username || ""} onChange={e => setPortfolioForm({ ...portfolioForm, username: e.target.value })} placeholder={editingPortfolio ? "Saved \u2014 leave blank to keep" : ""} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Password</label><Input type="password" name="pf_portal_pass" autoComplete="new-password" value={portfolioForm.password || ""} onChange={e => setPortfolioForm({ ...portfolioForm, password: e.target.value })} placeholder={editingPortfolio ? "Saved \u2014 leave blank to keep" : ""} /></div>
  </div></div>
  </div>
  <div className="flex gap-2 mt-4"><Btn variant="success-fill" onClick={savePortfolioLoan}>Save</Btn><Btn variant="secondary" onClick={() => { setShowPortfolioForm(false); setEditingPortfolio(null); }}>Cancel</Btn></div>
  </Modal>
  )}
  </div>
  );
}

export { Loans };
