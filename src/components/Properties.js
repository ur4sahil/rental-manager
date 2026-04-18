import React, { useState, useEffect, useRef } from "react";
import { supabase } from "../supabase";
import { Input, Textarea, Select, Btn, PageHeader, IconBtn } from "../ui";
import { safeNum, parseLocalDate, formatLocalDate, shortId, pickColor, formatPersonName, parseNameParts, formatCurrency, formatPhoneInput, sanitizeFileName, exportToCSV, normalizeEmail, getSignedUrl, ALLOWED_DOC_TYPES, ALLOWED_DOC_EXTENSIONS, US_STATES, COUNTIES_BY_STATE, escapeFilterValue, recomputeTenantDocStatus } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease, _submitGuards } from "../utils/guards";
import { encryptCredential } from "../utils/encryption";
import { logAudit } from "../utils/audit";
import { queueNotification } from "../utils/notifications";
import { safeLedgerInsert, autoPostJournalEntry, getPropertyClassId, resolveAccountId, getOrCreateTenantAR, autoPostRentCharges, _classIdCache, _acctIdCache, _tenantArCache, lookupZip } from "../utils/accounting";
import { Badge, Spinner, Modal, RecurringEntryModal, DocUploadModal, formatAllTenants } from "./shared";

const LICENSE_TYPE_OPTIONS = [
  { value: "rental_license", label: "Rental License" },
  { value: "rental_registration", label: "Rental Registration" },
  { value: "lead_paint", label: "Lead Paint Certificate" },
  { value: "lead_risk_assessment", label: "Lead Risk Assessment" },
  { value: "fire_inspection", label: "Fire Inspection Certificate" },
  { value: "bbl", label: "Business License (DC BBL)" },
  { value: "other", label: "Other" },
];
const LICENSE_TYPE_LABELS = LICENSE_TYPE_OPTIONS.reduce((m, o) => { m[o.value] = o.label; return m; }, {});

function LicenseFormModal({ license, propertyId, propertyAddress, companyId, userProfile, userRole, showToast, showConfirm, onClose, onSaved }) {
  const isEdit = !!license;
  const [form, setForm] = useState({
    license_type: license?.license_type || "rental_license",
    license_type_custom: license?.license_type_custom || "",
    license_number: license?.license_number || "",
    jurisdiction: license?.jurisdiction || "",
    issue_date: license?.issue_date || "",
    expiry_date: license?.expiry_date || "",
    fee_amount: license?.fee_amount ?? "",
    status: license?.status || "active",
    notes: license?.notes || "",
  });
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!form.expiry_date) { showToast("Expiry date is required", "error"); return; }
    if (form.license_type === "other" && !form.license_type_custom.trim()) { showToast("Please describe the license type", "error"); return; }
    if (!guardSubmit("licSave", license?.id || "new")) return;
    setSaving(true);
    try {
      const payload = {
        company_id: companyId,
        property_id: propertyId,
        license_type: form.license_type,
        license_type_custom: form.license_type === "other" ? form.license_type_custom.trim() : null,
        license_number: form.license_number.trim() || null,
        jurisdiction: form.jurisdiction.trim() || null,
        issue_date: form.issue_date || null,
        expiry_date: form.expiry_date,
        fee_amount: form.fee_amount === "" ? null : safeNum(form.fee_amount),
        status: form.status,
        notes: form.notes.trim() || null,
      };
      if (isEdit) {
        const { error } = await supabase.from("property_licenses").update(payload).eq("id", license.id).eq("company_id", companyId);
        if (error) { pmError("PM-2002", { raw: error, context: "license update" }); return; }
        showToast("License updated", "success");
        logAudit("update", "property_licenses", `Updated license: ${LICENSE_TYPE_LABELS[form.license_type] || form.license_type_custom}`, license.id, userProfile?.email, userRole, companyId);
      } else {
        payload.created_by = userProfile?.email || null;
        const { error } = await supabase.from("property_licenses").insert([payload]);
        if (error) { pmError("PM-2002", { raw: error, context: "license insert" }); return; }
        showToast("License added", "success");
        logAudit("create", "property_licenses", `Added license at ${propertyAddress}: ${LICENSE_TYPE_LABELS[form.license_type] || form.license_type_custom}`, "", userProfile?.email, userRole, companyId);
      }
      onSaved();
      onClose();
    } finally {
      setSaving(false);
      guardRelease("licSave", license?.id || "new");
    }
  }

  return (
    <Modal title={isEdit ? "Edit License" : "Add License"} onClose={onClose}>
      <div className="space-y-3">
        <div className="text-xs text-neutral-400">Property: <span className="font-semibold text-neutral-600">{propertyAddress}</span></div>
        <div>
          <label className="text-xs font-medium text-neutral-400 block mb-1">License Type *</label>
          <Select value={form.license_type} onChange={e => setForm({ ...form, license_type: e.target.value })}>
            {LICENSE_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </div>
        {form.license_type === "other" && (
          <div>
            <label className="text-xs font-medium text-neutral-400 block mb-1">Describe *</label>
            <Input value={form.license_type_custom} onChange={e => setForm({ ...form, license_type_custom: e.target.value })} placeholder="e.g. Short-term Rental Permit" />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-neutral-400 block mb-1">License Number</label>
            <Input value={form.license_number} onChange={e => setForm({ ...form, license_number: e.target.value })} placeholder="e.g. RLC-2026-4812" />
          </div>
          <div>
            <label className="text-xs font-medium text-neutral-400 block mb-1">Jurisdiction</label>
            <Input value={form.jurisdiction} onChange={e => setForm({ ...form, jurisdiction: e.target.value })} placeholder="e.g. Fairfax County, VA" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-neutral-400 block mb-1">Issue Date</label>
            <Input type="date" value={form.issue_date} onChange={e => setForm({ ...form, issue_date: e.target.value })} />
          </div>
          <div>
            <label className="text-xs font-medium text-neutral-400 block mb-1">Expiry Date *</label>
            <Input type="date" value={form.expiry_date} onChange={e => setForm({ ...form, expiry_date: e.target.value })} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-neutral-400 block mb-1">Fee Paid</label>
            <Input type="number" step="0.01" value={form.fee_amount} onChange={e => setForm({ ...form, fee_amount: e.target.value })} placeholder="e.g. 150.00" />
          </div>
          <div>
            <label className="text-xs font-medium text-neutral-400 block mb-1">Status</label>
            <Select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
              <option value="active">Active</option>
              <option value="pending_renewal">Pending Renewal</option>
              <option value="expired">Expired</option>
              <option value="revoked">Revoked</option>
            </Select>
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-neutral-400 block mb-1">Notes</label>
          <Textarea rows={2} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Renewal reminders, lead paint exemption, etc." />
        </div>
        <Btn className="w-full" onClick={handleSave} disabled={saving}>{saving ? "Saving..." : (isEdit ? "Save Changes" : "Add License")}</Btn>
      </div>
    </Modal>
  );
}

function PropertySetupWizard({ wizardData, companyId, showToast, userProfile, userRole, onComplete, onDismiss }) {
  // wizardData: { propertyId, address, isOccupied, tenant, rent, leaseStart, leaseEnd, securityDeposit }
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [wizardId, setWizardId] = useState("");
  const [completedSteps, setCompletedSteps] = useState(new Set());

  // Property details (Step 1)
  const [propForm, setPropForm] = useState(() => {
    if (wizardData.propertyId && wizardData.address) {
      const parts = (wizardData.address || "").split(", ");
      return {
        address_line_1: parts[0] || "", address_line_2: "", city: parts.length >= 3 ? parts[parts.length - 2] : "",
        state: parts.length >= 2 ? (parts[parts.length - 1] || "").split(" ")[0] || "" : "",
        zip: parts.length >= 2 ? (parts[parts.length - 1] || "").split(" ")[1] || "" : "",
        county: "",
        type: "Single Family", status: wizardData.isOccupied ? "occupied" : "vacant", notes: ""
      };
    }
    return { address_line_1: "", address_line_2: "", city: "", state: "", zip: "", county: "", type: "Single Family", status: "vacant", notes: "" };
  });
  // Tenant & lease details (Step 2, only if occupied)
  const [tenantForm, setTenantForm] = useState(() => {
    if (wizardData.propertyId && wizardData.tenant) {
      return {
        tenant: wizardData.tenant || "", tenant_first: wizardData.tenant_first || parseNameParts(wizardData.tenant || "").first_name, tenant_mi: wizardData.tenant_mi || parseNameParts(wizardData.tenant || "").middle_initial, tenant_last: wizardData.tenant_last || parseNameParts(wizardData.tenant || "").last_name, tenant_email: "", tenant_phone: "",
        rent: wizardData.rent || "", security_deposit: wizardData.securityDeposit || "",
        lease_start: wizardData.leaseStart || "", lease_end: wizardData.leaseEnd || ""
      };
    }
    return { tenant: "", tenant_first: "", tenant_mi: "", tenant_last: "", tenant_email: "", tenant_phone: "", tenant_2: "", tenant_2_email: "", tenant_2_phone: "", tenant_3: "", tenant_3_email: "", tenant_3_phone: "", tenant_4: "", tenant_4_email: "", tenant_4_phone: "", tenant_5: "", tenant_5_email: "", tenant_5_phone: "", tenantCount: 1, rent: "", security_deposit: "", lease_start: "", lease_end: "", is_voucher: false, voucher_number: "", reexam_date: "", case_manager_name: "", case_manager_email: "", case_manager_phone: "", voucher_portion: "", tenant_portion: "" };
  });
  const [savedPropertyId, setSavedPropertyId] = useState(wizardData.propertyId || null);
  const [savedAddress, setSavedAddress] = useState(wizardData.address || "");

  // Step-specific form states
  const [utilities, setUtilities] = useState([
    { provider: "", type: "Electric", account_number: "", due_date: 1, responsibility: propForm.status === "occupied" ? "tenant_pays" : "owner_pays", website: "", username: "", password: "" }
  ]);
  const EMPTY_HOA = { hoa_name: "", amount: "", due_date: 1, frequency: "Monthly", notes: "", website: "", username: "", password: "" };
  const [hoas, setHoas] = useState([]);
  const addHoa = () => { if (hoas.length < 5) setHoas([...hoas, { ...EMPTY_HOA }]); };
  const updateHoa = (idx, field, val) => setHoas(prev => prev.map((h, i) => i === idx ? { ...h, [field]: val } : h));
  const removeHoa = (idx) => setHoas(prev => prev.filter((_, i) => i !== idx));
  const [loan, setLoan] = useState({ enabled: false, lender_name: "", loan_type: "Conventional", original_amount: "", current_balance: "", interest_rate: "", monthly_payment: "", escrow_included: false, escrow_amount: "", escrow_covers: { taxes: false, insurance: false, pmi: false }, loan_start_date: "", maturity_date: "", account_number: "", notes: "", setup_recurring: false, website: "", username: "", password: "" });
  const [insurance, setInsurance] = useState({ enabled: false, provider: "", policy_number: "", premium_amount: "", premium_frequency: "annual", coverage_amount: "", expiration_date: "", notes: "", website: "", username: "", password: "" });
  const [recurring, setRecurring] = useState({ frequency: "monthly", day_of_month: 1, amount: wizardData.rent || 0 });
  const [uploadedDocs, setUploadedDocs] = useState([]);
  const [docUploadType, setDocUploadType] = useState("Lease");
  const [docDescription, setDocDescription] = useState("");

  // File upload refs
  const fileInputRef = useRef();

  // Build steps array dynamically based on status
  const steps = (() => {
    const s = ["property_details"];
    if (propForm.status === "occupied") s.push("tenant_lease");
    s.push("utilities", "hoa");
    if (userRole === "admin" || userRole === "owner") s.push("loan");
    s.push("documents", "insurance");
    if (propForm.status === "occupied") s.push("recurring_rent");
    s.push("review");
    return s;
  })();
  const totalSteps = steps.length;
  const currentStepId = steps[step - 1];

  // Step labels for display
  const stepLabels = {
    property_details: "Property Details",
    tenant_lease: "Tenant & Lease",
    utilities: "Utilities",
    hoa: "HOA",
    loan: "Loan",
    documents: "Documents",
    insurance: "Insurance",
    recurring_rent: "Recurring Rent",
    review: "Review"
  };

  // Wizard persistence — upsert on mount
  useEffect(() => {
    async function initWizard() {
      try {
        const addr = savedAddress || wizardData.address || "NEW";
        // Check for existing wizard (in_progress first, then completed for edit mode)
        const { data: existing } = await supabase.from("property_setup_wizard").select("*")
          .eq("company_id", companyId).eq("property_address", addr).eq("status", "in_progress").maybeSingle();
        if (existing) {
          setWizardId(existing.id);
          const savedStep = existing.current_step || 1;
          const savedCompleted = new Set(existing.completed_steps || []);
          setStep(savedStep);
          setCompletedSteps(savedCompleted);
          if (existing.wizard_data) {
            try {
            const wd = typeof existing.wizard_data === "string" ? JSON.parse(existing.wizard_data) : existing.wizard_data;
            if (wd.propForm) setPropForm(wd.propForm);
            if (wd.tenantForm) setTenantForm(wd.tenantForm);
            if (wd.savedPropertyId) setSavedPropertyId(wd.savedPropertyId);
            if (wd.savedAddress) setSavedAddress(wd.savedAddress);
            if (wd.utilities) setUtilities(wd.utilities);
            if (wd.hoas) setHoas(wd.hoas); else if (wd.hoa?.enabled) setHoas([wd.hoa]);
            if (wd.loan) setLoan(wd.loan);
            if (wd.insurance) setInsurance(wd.insurance);
            if (wd.recurring) setRecurring(wd.recurring);
            } catch (e) { pmError("PM-2007", { raw: e, context: "wizard data restore", silent: true }); }
          }
          return;
        }
        // Edit mode: check for completed wizard and reopen it
        if (wizardData.isEdit) {
          const { data: completed } = await supabase.from("property_setup_wizard").select("*")
            .eq("company_id", companyId).eq("property_address", addr).eq("status", "completed").order("updated_at", { ascending: false }).limit(1).maybeSingle();
          if (completed) {
            // Reopen as in_progress
            await supabase.from("property_setup_wizard").update({ status: "in_progress" }).eq("id", completed.id).eq("company_id", companyId);
            setWizardId(completed.id);
            setStep(completed.current_step || 1); // Preserve last step instead of restarting
            setCompletedSteps(new Set(completed.completed_steps || []));
            if (completed.wizard_data) {
              try {
              const wd = typeof completed.wizard_data === "string" ? JSON.parse(completed.wizard_data) : completed.wizard_data;
              if (wd.propForm) setPropForm(wd.propForm);
              if (wd.tenantForm) setTenantForm(wd.tenantForm);
              if (wd.savedPropertyId) setSavedPropertyId(wd.savedPropertyId);
              if (wd.savedAddress) setSavedAddress(wd.savedAddress);
              if (wd.utilities) setUtilities(wd.utilities);
              if (wd.hoas) setHoas(wd.hoas); else if (wd.hoa?.enabled) setHoas([wd.hoa]);
              if (wd.loan) setLoan(wd.loan);
              if (wd.insurance) setInsurance(wd.insurance);
              if (wd.recurring) setRecurring(wd.recurring);
              } catch (e) { pmError("PM-2007", { raw: e, context: "wizard data restore (edit mode)", silent: true }); }
            }
            return;
          }
          // No completed wizard found — create one with existing property data pre-filled
        }
        // For existing properties, load data from DB to pre-fill
        if (wizardData.propertyId) {
          const { data: existProp } = await supabase.from("properties").select("*").eq("id", wizardData.propertyId).eq("company_id", companyId).maybeSingle();
          if (existProp) {
            const filledProp = { ...propForm, address_line_1: existProp.address_line_1 || existProp.address || "", address_line_2: existProp.address_line_2 || "", city: existProp.city || "", state: existProp.state || "", zip: existProp.zip || "", county: existProp.county || "", type: existProp.type || "Single Family", status: existProp.status || "vacant", notes: existProp.notes || "" };
            setPropForm(filledProp);
            setSavedPropertyId(wizardData.propertyId);
            setSavedAddress(existProp.address);
            // Load related data
            const [utilRes, hoaRes, loanRes, insRes] = await Promise.all([
              supabase.from("utilities").select("*").eq("company_id", companyId).eq("property", existProp.address).is("archived_at", null),
              supabase.from("hoa_payments").select("*").eq("company_id", companyId).eq("property", existProp.address).is("archived_at", null),
              supabase.from("property_loans").select("*").eq("company_id", companyId).eq("property", existProp.address).is("archived_at", null),
              supabase.from("property_insurance").select("*").eq("company_id", companyId).eq("property", existProp.address).is("archived_at", null),
            ]);
            if (utilRes.data?.length) setUtilities(utilRes.data.map(u => ({ provider: u.provider, type: u.type, account_number: u.account_number || "", due_date: u.due_date || "", responsibility: u.responsibility || "owner_pays", website: u.website || "", username: u.username || "", password: u.password || "" })));
            if (hoaRes.data?.length) setHoas(hoaRes.data.map(h => ({ enabled: true, hoa_name: h.hoa_name || h.name || "", amount: h.amount || "", due_date: h.due_date || "", frequency: h.frequency || "Monthly", notes: h.notes || "", website: h.website || "", username: h.username || "", password: h.password || "" })));
            if (loanRes.data?.[0]) { const l = loanRes.data[0]; setLoan({ enabled: true, lender_name: l.lender_name || "", loan_type: l.loan_type || "Conventional", original_amount: l.original_amount || "", current_balance: l.current_balance || "", interest_rate: l.interest_rate || "", monthly_payment: l.monthly_payment || "", escrow_included: l.escrow_included || false, escrow_amount: l.escrow_amount || "", loan_start_date: l.loan_start_date || "", maturity_date: l.maturity_date || "", account_number: l.account_number || "", notes: l.notes || "", setup_recurring: false }); }
            if (insRes.data?.[0]) { const i = insRes.data[0]; setInsurance({ enabled: true, provider: i.provider || "", policy_number: i.policy_number || "", premium_amount: i.premium_amount || "", premium_frequency: i.premium_frequency || "Annual", coverage_amount: i.coverage_amount || "", expiration_date: i.expiration_date || "", notes: i.notes || "" }); }
          }
        }
        // Create new wizard entry
        const { data: created, error } = await supabase.from("property_setup_wizard").insert([{
          company_id: companyId,
          property_id: String(savedPropertyId || wizardData.propertyId || ""),
          property_address: addr,
          status: "in_progress",
          current_step: 1,
          completed_steps: [],
          wizard_data: { propForm, tenantForm },
        }]).select("id").maybeSingle();
        if (error) pmError("PM-2007", { raw: error, context: "wizard persistence init", silent: true });
        if (created?.id) setWizardId(created.id);
      } catch (e) {
        pmError("PM-2007", { raw: e, context: "wizard persistence init", silent: true });
      }
    }
    initWizard();
    // eslint-disable-next-line
  }, []);

  // Persist step progress + form data
  async function persistProgress(nextStep, newCompletedSteps) {
    if (!wizardId) return;
    try {
      await supabase.from("property_setup_wizard").update({
        current_step: nextStep,
        completed_steps: Array.from(newCompletedSteps),
        wizard_data: { propForm, tenantForm, savedPropertyId, savedAddress, utilities, hoas, loan, insurance, recurring },
        updated_at: new Date().toISOString()
      }).eq("id", wizardId).eq("company_id", companyId);
    } catch (e) {
      pmError("PM-2007", { raw: e, context: "wizard progress save", silent: true });
    }
  }

  // Persist wizard completion
  async function persistStatus(status) {
    try {
      await supabase.from("property_setup_wizard").update({
        status: status,
        updated_at: new Date().toISOString()
      }).eq("id", wizardId).eq("company_id", companyId);
    } catch (e) {
      pmError("PM-2007", { raw: e, context: "wizard status save", silent: true });
    }
  }

  // ---- Save logic for each step ----

  async function saveUtilities() {
    const validRows = utilities.filter(u => u.provider.trim());
    if (validRows.length === 0) return true; // nothing to save
    const rows = validRows.map(async u => {
      // Build a proper date from the day-of-month (use current month)
      const now = new Date();
      const day = Math.min(28, Math.max(1, Number(u.due_date) || 1));
      const dueDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const row = {
      company_id: companyId,
      property: savedAddress,
      provider: u.provider.trim(),
      amount: 0,
      due: dueDate,
      responsibility: u.responsibility === "owner_pays" ? "owner" : "tenant",
      status: "pending",
      website: u.website || "",
      };
      if (u.username || u.password) {
        const { encrypted: encUser, iv: ivUser } = await encryptCredential(u.username || "", companyId);
        const { encrypted: encPass, iv: ivPass } = await encryptCredential(u.password || "", companyId);
        row.username_encrypted = encUser;
        row.password_encrypted = encPass;
        row.encryption_iv = ivPass || ivUser;
      }
      return row;
    });
    const resolvedRows = await Promise.all(rows);
    const { error } = await supabase.from("utilities").insert(resolvedRows);
    if (error) throw new Error("Failed to save utilities: " + error.message);
    return true;
  }

  async function saveHoa() {
    const validHoas = hoas.filter(h => h.hoa_name.trim());
    if (validHoas.length === 0) return true;
    const rows = validHoas.map(async h => {
      if (!h.amount || Number(h.amount) <= 0) throw new Error("HOA amount is required for " + h.hoa_name);
      const now = new Date();
      const day = Math.min(28, Math.max(1, Number(h.due_date) || 1));
      const dueDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const row = {
        company_id: companyId, property: savedAddress, hoa_name: h.hoa_name.trim(),
        amount: Number(h.amount), due_date: dueDate, frequency: h.frequency || "Monthly",
        notes: (h.notes || "").trim(), status: "pending", website: h.website || "",
      };
      if (h.username || h.password) {
        const { encrypted: encU, iv: ivU } = await encryptCredential(h.username || "", companyId);
        const { encrypted: encP, iv: ivP } = await encryptCredential(h.password || "", companyId);
        row.username_encrypted = encU; row.password_encrypted = encP; row.encryption_iv = ivP || ivU;
      }
      return row;
    });
    const resolvedRows = await Promise.all(rows);
    const { error } = await supabase.from("hoa_payments").insert(resolvedRows);
    if (error) throw new Error("Failed to save HOA: " + error.message);
    return true;
  }

  async function saveLoan() {
    if (!loan.enabled) return true;
    if (!loan.lender_name.trim()) throw new Error("Lender name is required");
    if (!loan.monthly_payment || Number(loan.monthly_payment) <= 0) throw new Error("Monthly payment is required");
    const loanRow = {
      company_id: companyId,
      property: savedAddress,
      property_id: String(savedPropertyId || ""),
      lender_name: loan.lender_name.trim(),
      loan_type: loan.loan_type,
      original_amount: Number(loan.original_amount) || 0,
      current_balance: Number(loan.current_balance) || 0,
      interest_rate: Number(loan.interest_rate) || 0,
      monthly_payment: Number(loan.monthly_payment),
      escrow_included: loan.escrow_included,
      escrow_amount: loan.escrow_included ? (Number(loan.escrow_amount) || 0) : 0,
      escrow_covers: loan.escrow_included ? loan.escrow_covers : {},
      loan_start_date: loan.loan_start_date || null,
      maturity_date: loan.maturity_date || null,
      account_number: loan.account_number.trim(),
      notes: loan.notes.trim(),
      status: "active",
      website: loan.website || "",
    };
    if (loan.username || loan.password) {
      const { encrypted: encU, iv: ivU } = await encryptCredential(loan.username || "", companyId);
      const { encrypted: encP, iv: ivP } = await encryptCredential(loan.password || "", companyId);
      loanRow.username_encrypted = encU;
      loanRow.password_encrypted = encP;
      loanRow.encryption_iv = ivP || ivU;
    }
    const { error } = await supabase.from("property_loans").insert([loanRow]);
    if (error) throw new Error("Failed to save loan: " + error.message);
    // If setup_recurring, create a recurring journal entry for the mortgage payment
    if (loan.setup_recurring) {
      const today = new Date();
      const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      const nextPostDate = formatLocalDate(nextMonth);
      const mortgageAcctId = await resolveAccountId("5600", companyId);
      const checkingAcctId = await resolveAccountId("1000", companyId);
      const { error: recErr } = await supabase.from("recurring_journal_entries").insert([{
        company_id: companyId,
        description: "Mortgage payment — " + loan.lender_name + " — " + savedAddress.split(",")[0],
        frequency: "monthly",
        day_of_month: 1,
        amount: Number(loan.monthly_payment),
        property: savedAddress,
        debit_account_id: mortgageAcctId,
        debit_account_name: "Mortgage/Loan Payment",
        credit_account_id: checkingAcctId,
        credit_account_name: "Checking Account",
        status: "active",
        next_post_date: nextPostDate,
        created_by: userProfile?.email || ""
      }]);
      if (recErr) throw new Error("Recurring mortgage entry failed: " + recErr.message);
    }
    return true;
  }

  async function saveInsurance() {
    if (!insurance.enabled) return true;
    if (!insurance.provider.trim()) throw new Error("Insurance provider is required");
    if (!insurance.premium_amount || Number(insurance.premium_amount) <= 0) throw new Error("Premium amount is required");
    const insRow = {
      company_id: companyId,
      property: savedAddress,
      property_id: String(savedPropertyId || ""),
      provider: insurance.provider.trim(),
      policy_number: insurance.policy_number.trim(),
      premium_amount: Number(insurance.premium_amount),
      premium_frequency: insurance.premium_frequency,
      coverage_amount: Number(insurance.coverage_amount) || 0,
      expiration_date: insurance.expiration_date || null,
      notes: insurance.notes.trim(),
      website: insurance.website || "",
    };
    if (insurance.username || insurance.password) {
      const { encrypted: encU, iv: ivU } = await encryptCredential(insurance.username || "", companyId);
      const { encrypted: encP, iv: ivP } = await encryptCredential(insurance.password || "", companyId);
      insRow.username_encrypted = encU;
      insRow.password_encrypted = encP;
      insRow.encryption_iv = ivP || ivU;
    }
    const { error } = await supabase.from("property_insurance").insert([insRow]);
    if (error) throw new Error("Failed to save insurance: " + error.message);
    return true;
  }

  async function saveRecurringRent() {
    if (!recurring.amount || Number(recurring.amount) <= 0) throw new Error("Rent amount is required");
    const allTenants = [tenantForm.tenant, tenantForm.tenant_2, tenantForm.tenant_3, tenantForm.tenant_4, tenantForm.tenant_5].filter(t => t?.trim()).join(" / ");
    const tenantArId = await getOrCreateTenantAR(companyId, tenantForm.tenant, null);
    const revenueId = await resolveAccountId("4000", companyId);
    const today = new Date();
    const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const nextPostDate = formatLocalDate(nextMonth);
    // Check for existing recurring entry to prevent duplicates
    const { data: existRecur } = await supabase.from("recurring_journal_entries").select("id").eq("company_id", companyId).eq("property", savedAddress).eq("status", "active").maybeSingle();
    if (existRecur) {
      // Update existing instead of creating duplicate
      await supabase.from("recurring_journal_entries").update({ amount: Number(recurring.amount), frequency: recurring.frequency, day_of_month: recurring.day_of_month, tenant_name: allTenants, description: "Monthly rent — " + allTenants + " — " + savedAddress.split(",")[0], debit_account_name: "AR - " + allTenants }).eq("id", existRecur.id).eq("company_id", companyId);
    } else {
      const { error } = await supabase.from("recurring_journal_entries").insert([{
        company_id: companyId,
        description: "Monthly rent — " + allTenants + " — " + savedAddress.split(",")[0],
        frequency: recurring.frequency,
        day_of_month: recurring.day_of_month,
        amount: Number(recurring.amount),
        tenant_name: allTenants,
        property: savedAddress,
        debit_account_id: tenantArId,
        debit_account_name: "AR - " + allTenants,
        credit_account_id: revenueId,
        credit_account_name: "Rental Income",
        status: "active",
        next_post_date: nextPostDate,
        created_by: userProfile?.email || ""
      }]);
      if (error) throw new Error("Failed to save recurring rent: " + error.message);
    }
    return true;
  }

  async function savePropertyDetails() {
    if (!companyId) throw new Error("No company selected");
    if (!propForm.address_line_1.trim()) throw new Error("Address Line 1 is required");
    if (!propForm.city.trim()) throw new Error("City is required");
    if (!propForm.state) throw new Error("State is required");
    if (!propForm.zip.trim() || !/^\d{5}$/.test(propForm.zip.trim())) throw new Error("ZIP must be 5 digits");
    if (!propForm.county) throw new Error("County is required");
    const compositeAddress = [propForm.address_line_1, propForm.address_line_2, propForm.city, propForm.state + " " + propForm.zip].filter(Boolean).join(", ");
    // Always check duplicate (even on edit if address changed)
    const { data: dup } = await supabase.from("properties").select("id").eq("company_id", companyId).eq("address", compositeAddress).is("archived_at", null).maybeSingle();
    if (dup && String(dup.id) !== String(savedPropertyId)) throw new Error("A property with this address already exists");
    // Direct save for all roles with Properties access
    if (savedPropertyId) {
      const { error: upErr } = await supabase.from("properties").update({ address: compositeAddress, address_line_1: propForm.address_line_1, address_line_2: propForm.address_line_2, city: propForm.city, state: propForm.state, zip: propForm.zip, county: propForm.county, type: propForm.type, status: propForm.status, notes: propForm.notes }).eq("id", savedPropertyId).eq("company_id", companyId);
      if (upErr) throw new Error("Failed to update property: " + upErr.message);
    } else {
      const { data: newProp, error: propErr } = await supabase.from("properties").insert([{ address: compositeAddress, address_line_1: propForm.address_line_1, address_line_2: propForm.address_line_2, city: propForm.city, state: propForm.state, zip: propForm.zip, county: propForm.county, type: propForm.type, status: propForm.status, notes: propForm.notes, company_id: companyId }]).select("id").maybeSingle();
      if (propErr) throw new Error("Failed to save property: " + propErr.message);
      setSavedPropertyId(newProp?.id || null);
      // Create accounting class
      const { data: newClass, error: clsErr } = await supabase.from("acct_classes").upsert([{ id: crypto.randomUUID(), name: compositeAddress, description: propForm.type + " · " + formatCurrency(0) + "/mo", color: pickColor(compositeAddress), is_active: true, company_id: companyId }], { onConflict: "company_id,name" }).select("id").maybeSingle();
      if (clsErr) {
      // Upsert failed — try plain insert
      const { data: insClass, error: insClsErr } = await supabase.from("acct_classes").insert([{ id: crypto.randomUUID(), name: compositeAddress, description: propForm.type + " · " + formatCurrency(0) + "/mo", color: pickColor(compositeAddress), is_active: true, company_id: companyId }]).select("id").maybeSingle();
      if (insClsErr) pmError("PM-4010", { raw: insClsErr, context: "accounting class creation in wizard", silent: true });
      else if (insClass?.id && newProp?.id) await supabase.from("properties").update({ class_id: insClass.id }).eq("id", newProp.id).eq("company_id", companyId);
      } else if (newClass?.id && newProp?.id) {
      await supabase.from("properties").update({ class_id: newClass.id }).eq("id", newProp.id).eq("company_id", companyId);
      }
    }
    setSavedAddress(compositeAddress);
    if (wizardId) {
      await supabase.from("property_setup_wizard").update({ property_address: compositeAddress, property_id: String(savedPropertyId || "") }).eq("id", wizardId).eq("company_id", companyId);
    }
    showToast("Property saved", "success");
    return true;
  }

  async function saveTenantLease() {
    if (!companyId) throw new Error("No company selected");
    if (!tenantForm.tenant.trim()) throw new Error("Tenant name is required");
    if (!tenantForm.tenant_email.trim() || !tenantForm.tenant_email.includes("@")) throw new Error("Valid email required");
    if (!tenantForm.tenant_phone.trim()) throw new Error("Phone required");
    if (!tenantForm.rent || Number(tenantForm.rent) <= 0) throw new Error("Rent required");
    if (!tenantForm.lease_start || !tenantForm.lease_end) throw new Error("Lease dates required");
    if (tenantForm.lease_end <= tenantForm.lease_start) throw new Error("Lease end date must be after start date");
    if (!savedPropertyId) throw new Error("Property must be saved first (complete Step 1)");
    const addr = savedAddress;
    // Update property with tenant info
    const { error: propUpErr } = await supabase.from("properties").update({ status: "occupied", tenant: tenantForm.tenant.trim(), tenant_2: tenantForm.tenant_2?.trim() || "", tenant_2_email: tenantForm.tenant_2_email?.trim() || "", tenant_2_phone: tenantForm.tenant_2_phone?.trim() || "", tenant_3: tenantForm.tenant_3?.trim() || "", tenant_3_email: tenantForm.tenant_3_email?.trim() || "", tenant_3_phone: tenantForm.tenant_3_phone?.trim() || "", tenant_4: tenantForm.tenant_4?.trim() || "", tenant_4_email: tenantForm.tenant_4_email?.trim() || "", tenant_4_phone: tenantForm.tenant_4_phone?.trim() || "", tenant_5: tenantForm.tenant_5?.trim() || "", tenant_5_email: tenantForm.tenant_5_email?.trim() || "", tenant_5_phone: tenantForm.tenant_5_phone?.trim() || "", rent: Number(tenantForm.rent), security_deposit: Number(tenantForm.security_deposit) || 0, lease_start: tenantForm.lease_start, lease_end: tenantForm.lease_end }).eq("id", savedPropertyId).eq("company_id", companyId);
    if (propUpErr) throw new Error("Failed to update property: " + propUpErr.message);
    // Create/find tenant — check by name+property first, then by property only to prevent duplicates
    let existingTenant = null;
    const { data: byName } = await supabase.from("tenants").select("id").eq("company_id", companyId).ilike("name", tenantForm.tenant.trim()).eq("property", addr).is("archived_at", null).maybeSingle();
    if (byName) { existingTenant = byName; }
    else {
      // Also check if ANY active tenant exists at this property (prevents duplicate from re-running wizard)
      const { data: byProp } = await supabase.from("tenants").select("id, name").eq("company_id", companyId).eq("property", addr).is("archived_at", null).eq("lease_status", "active").maybeSingle();
      if (byProp) { existingTenant = byProp; }
    }
    let tenantId = existingTenant?.id;
    if (!existingTenant) {
      const { data: newT, error: tErr } = await supabase.from("tenants").insert([{ company_id: companyId, name: tenantForm.tenant.trim(), first_name: tenantForm.tenant_first.trim(), middle_initial: tenantForm.tenant_mi.trim(), last_name: tenantForm.tenant_last.trim(), email: tenantForm.tenant_email.toLowerCase(), phone: tenantForm.tenant_phone, property: addr, rent: Number(tenantForm.rent), late_fee_amount: safeNum(tenantForm.late_fee_amount) || null, late_fee_type: tenantForm.late_fee_type || "flat", lease_status: "active", lease_start: tenantForm.lease_start, lease_end_date: tenantForm.lease_end, move_in: tenantForm.lease_start, balance: 0, is_voucher: tenantForm.is_voucher || false, voucher_number: tenantForm.voucher_number || null, reexam_date: tenantForm.reexam_date || null, case_manager_name: tenantForm.case_manager_name || null, case_manager_email: tenantForm.case_manager_email || null, case_manager_phone: tenantForm.case_manager_phone || null, voucher_portion: safeNum(tenantForm.voucher_portion) || null, tenant_portion: safeNum(tenantForm.tenant_portion) || null }]).select("id").maybeSingle();
      if (tErr) throw new Error("Failed to create tenant: " + tErr.message);
      tenantId = newT?.id;
    } else {
      // Update existing tenant with latest info from wizard
      await supabase.from("tenants").update({ name: tenantForm.tenant.trim(), first_name: tenantForm.tenant_first.trim(), middle_initial: tenantForm.tenant_mi.trim(), last_name: tenantForm.tenant_last.trim(), email: tenantForm.tenant_email.toLowerCase(), phone: tenantForm.tenant_phone, rent: Number(tenantForm.rent), late_fee_amount: safeNum(tenantForm.late_fee_amount) || null, late_fee_type: tenantForm.late_fee_type || "flat", is_voucher: tenantForm.is_voucher || false, voucher_number: tenantForm.voucher_number || null, reexam_date: tenantForm.reexam_date || null, case_manager_name: tenantForm.case_manager_name || null, case_manager_email: tenantForm.case_manager_email || null, case_manager_phone: tenantForm.case_manager_phone || null, voucher_portion: safeNum(tenantForm.voucher_portion) || null, tenant_portion: safeNum(tenantForm.tenant_portion) || null }).eq("id", existingTenant.id).eq("company_id", companyId);
    }
    // Create lease
    if (tenantForm.lease_start && tenantForm.lease_end) {
      const { data: existLease } = await supabase.from("leases").select("id").eq("company_id", companyId).eq("property", addr).eq("status", "active").maybeSingle();
      if (!existLease) {
        const { error: leaseErr } = await supabase.from("leases").insert([{ company_id: companyId, tenant_name: [tenantForm.tenant, tenantForm.tenant_2, tenantForm.tenant_3, tenantForm.tenant_4].filter(n => n?.trim()).join(" / "), tenant_id: tenantId, property: addr, start_date: tenantForm.lease_start, end_date: tenantForm.lease_end, rent_amount: Number(tenantForm.rent), security_deposit: Number(tenantForm.security_deposit) || 0, status: "active", payment_due_day: 1 }]);
        if (leaseErr) throw new Error("Failed to create lease: " + leaseErr.message);
      }
    }
    // Pre-fill recurring rent amount
    setRecurring(prev => ({ ...prev, amount: Number(tenantForm.rent) || prev.amount }));
    showToast("Tenant & lease saved", "success");
    return true;
  }

  async function saveCurrentStep() {
    switch (currentStepId) {
      case "property_details": return await savePropertyDetails();
      case "tenant_lease": return await saveTenantLease();
      case "utilities": return await saveUtilities();
      case "hoa": return await saveHoa();
      case "loan": return await saveLoan();
      case "insurance": return await saveInsurance();
      case "recurring_rent": return await saveRecurringRent();
      case "documents": return true; // docs are uploaded inline
      case "review": return true;
      default: return true;
    }
  }

  // ---- Handler functions ----

  async function handleNext() {
    if (saving) return;
    setSaving(true);
    try {
      await saveCurrentStep();
      const newCompleted = new Set(completedSteps);
      newCompleted.add(currentStepId);
      setCompletedSteps(newCompleted);
      const nextStep = step + 1;
      setStep(nextStep);
      await persistProgress(nextStep, newCompleted);
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setSaving(false);
    }
  }

  function handleBack() {
    if (step > 1) setStep(step - 1);
  }

  async function handleSkip() {
    const nextStep = step + 1;
    setStep(nextStep);
    await persistProgress(nextStep, completedSteps);
  }

  async function handleComplete() {
    setSaving(true);
    try {
      // Finalize accounting entries now that all setup is done
      if (propForm.status === "occupied" && tenantForm.tenant.trim() && savedAddress) {
      const addr = savedAddress;
      const tName = tenantForm.tenant.trim();
      // Find tenant ID — try exact match first, then contains match
      let tenantId = null;
      const { data: tRow } = await supabase.from("tenants").select("id").eq("company_id", companyId).ilike("name", tName).eq("property", addr).is("archived_at", null).maybeSingle();
      if (tRow) { tenantId = tRow.id; }
      else {
        // Fallback: find any active tenant at this property
        const { data: tFallback } = await supabase.from("tenants").select("id").eq("company_id", companyId).eq("property", addr).is("archived_at", null).eq("lease_status", "active").maybeSingle();
        if (tFallback) tenantId = tFallback.id;
      }
      // Check if accounting entries already exist (prevents double-posting on re-edit)
      const { data: existingJEs } = await supabase.from("acct_journal_entries").select("id, description").eq("company_id", companyId).eq("property", addr).neq("status", "voided").limit(10);
      const tNameLower = tName.toLowerCase();
      const hasRentJE = (existingJEs || []).some(je => je.description?.toLowerCase().includes(tNameLower) && (je.description?.toLowerCase().includes("rent")));
      const hasDepJE = (existingJEs || []).some(je => je.description?.toLowerCase().includes(tNameLower) && je.description?.toLowerCase().includes("deposit"));
      if (tenantId) {
      // Create AR sub-account
      await getOrCreateTenantAR(companyId, tName, tenantId);
      // Post security deposit JE (skip if already posted)
      const dep = Number(tenantForm.security_deposit) || 0;
      if (dep > 0 && !hasDepJE) {
      const classId = await getPropertyClassId(addr, companyId);
      const tenantArId = await getOrCreateTenantAR(companyId, tName, tenantId);
      const depOk = await autoPostJournalEntry({ companyId, date: tenantForm.lease_start, description: "Security deposit received — " + tName + " — " + addr, reference: "DEP-" + shortId(), property: addr,
      lines: [
      { account_id: tenantArId, account_name: "AR - " + tName, debit: dep, credit: 0, class_id: classId, memo: "Security deposit from " + tName },
      { account_id: "2100", account_name: "Security Deposits Held", debit: 0, credit: dep, class_id: classId, memo: tName + " — " + addr },
      ]
      });
      if (depOk) await safeLedgerInsert({ company_id: companyId, tenant: tName, tenant_id: tenantId, property: addr, date: tenantForm.lease_start, description: "Security deposit collected", amount: dep, type: "deposit", balance: 0 });
      }
      // Post first month rent (prorated if mid-month) — skip if already posted
      const monthlyRent = Number(tenantForm.rent) || Number(recurring?.amount) || 0;
      if (monthlyRent > 0 && tenantForm.lease_start && !hasRentJE) {
      try {
        const leaseStart = parseLocalDate(tenantForm.lease_start);
        const startDay = leaseStart.getDate();
        const daysInMonth = new Date(leaseStart.getFullYear(), leaseStart.getMonth() + 1, 0).getDate();
        if (!isNaN(startDay) && !isNaN(daysInMonth)) {
          const tenantArId2 = await getOrCreateTenantAR(companyId, tName, tenantId);
          const revenueId2 = await resolveAccountId("4000", companyId);
          const classId2 = await getPropertyClassId(addr, companyId);
          if (startDay > 1) {
            const remainingDays = daysInMonth - startDay + 1;
            const proratedAmount = Math.round(monthlyRent * remainingDays / daysInMonth * 100) / 100;
            const proOk = await autoPostJournalEntry({ companyId, date: tenantForm.lease_start,
              description: `Prorated rent (${remainingDays}/${daysInMonth} days) — ${tName} — ${addr.split(",")[0]}`,
              reference: "PRORENT-" + shortId(), property: addr,
              lines: [
                { account_id: tenantArId2, account_name: "AR - " + tName, debit: proratedAmount, credit: 0, class_id: classId2, memo: "Prorated first month rent" },
                { account_id: revenueId2, account_name: "Rental Income", debit: 0, credit: proratedAmount, class_id: classId2, memo: `${remainingDays}/${daysInMonth} days @ $${monthlyRent}/mo` },
              ]
            });
            if (proOk) {
              await safeLedgerInsert({ company_id: companyId, tenant: tName, tenant_id: tenantId, property: addr, date: tenantForm.lease_start, description: `Prorated rent (${remainingDays}/${daysInMonth} days)`, amount: proratedAmount, type: "charge", balance: 0 });
              try { await supabase.rpc("update_tenant_balance", { p_tenant_id: tenantId, p_amount_change: proratedAmount }); } catch (_e) { pmError("PM-6002", { raw: _e, context: "prorated rent balance update", silent: true }); }
              await supabase.from("recurring_journal_entries").update({ last_posted_date: tenantForm.lease_start }).eq("company_id", companyId).eq("property", addr).eq("status", "active").is("archived_at", null);
            }
          } else {
            const fullOk = await autoPostJournalEntry({ companyId, date: tenantForm.lease_start,
              description: `First month rent — ${tName} — ${addr.split(",")[0]}`,
              reference: "RENT1-" + shortId(), property: addr,
              lines: [
                { account_id: tenantArId2, account_name: "AR - " + tName, debit: monthlyRent, credit: 0, class_id: classId2, memo: "First month rent" },
                { account_id: revenueId2, account_name: "Rental Income", debit: 0, credit: monthlyRent, class_id: classId2, memo: "Full month rent" },
              ]
            });
            if (fullOk) {
              await safeLedgerInsert({ company_id: companyId, tenant: tName, tenant_id: tenantId, property: addr, date: tenantForm.lease_start, description: "First month rent", amount: monthlyRent, type: "charge", balance: 0 });
              try { await supabase.rpc("update_tenant_balance", { p_tenant_id: tenantId, p_amount_change: monthlyRent }); } catch (_e) { pmError("PM-6002", { raw: _e, context: "first month rent balance update", silent: true }); }
              await supabase.from("recurring_journal_entries").update({ last_posted_date: tenantForm.lease_start }).eq("company_id", companyId).eq("property", addr).eq("status", "active").is("archived_at", null);
            }
          }
        }
      } catch (e) { pmError("PM-4002", { raw: e, context: "first month rent posting", silent: true }); }
      }
      // Auto-post rent charges
      autoPostRentCharges(companyId).catch(e => pmError('PM-4002', { raw: e, context: 'auto-post rent charges', silent: true }));
      }
      }
      await persistStatus("completed");
      showToast("Property setup complete!", "success");
      onComplete();
    } catch (e) {
      pmError("PM-2002", { raw: e, context: "completing property setup wizard" });
    } finally {
      setSaving(false);
    }
  }

  async function handleDismiss() {
    await persistStatus("dismissed");
    onDismiss();
  }

  // ---- File upload handler ----
  async function handleFileUpload(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setSaving(true);
    let uploaded = 0;
    for (const file of files) {
      if (!ALLOWED_DOC_TYPES.includes(file.type) && !ALLOWED_DOC_EXTENSIONS.test(file.name)) {
        showToast("Skipped " + file.name + " — file type not allowed", "error");
        continue;
      }
      if (file.size > 25 * 1024 * 1024) {
        showToast("Skipped " + file.name + " — must be under 25MB", "error");
        continue;
      }
      try {
        const fileName = companyId + "/" + shortId() + "_" + sanitizeFileName(file.name);
        const { error: uploadErr } = await supabase.storage.from("documents").upload(fileName, file, { cacheControl: "3600", upsert: false });
        if (uploadErr) { pmError("PM-7002", { raw: uploadErr, context: "wizard document upload for " + file.name }); continue; }
        const docName = docUploadType === "Other" ? docDescription : docUploadType + " — " + file.name.replace(/\.[^/.]+$/, "");
        const { error: insertErr } = await supabase.from("documents").insert([{
          company_id: companyId,
          name: docName,
          file_name: fileName,
          url: fileName,
          property: savedAddress,
          tenant: propForm.status === "occupied" ? (tenantForm.tenant || "") : "",
          type: docUploadType,
          tenant_visible: false,
          uploaded_at: new Date().toISOString()
        }]);
        if (insertErr) { pmError("PM-7003", { raw: insertErr, context: "wizard document record insert" }); continue; }
        setUploadedDocs(prev => [...prev, { name: docName, type: docUploadType }]);
        uploaded++;
      } catch (err) {
        pmError("PM-7002", { raw: err, context: "wizard file upload for " + file.name });
      }
    }
    if (uploaded > 0) {
      showToast(uploaded + " document" + (uploaded > 1 ? "s" : "") + " uploaded", "success");
      setDocUploadType("Lease");
      setDocDescription("");
      if (tenantForm.tenant) await recomputeTenantDocStatus(companyId, tenantForm.tenant);
    }
    setSaving(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // ---- Utility row helpers ----
  function addUtilityRow() {
    setUtilities(prev => [...prev, { provider: "", type: "Electric", account_number: "", due_date: 1, responsibility: propForm.status === "occupied" ? "tenant_pays" : "owner_pays", website: "", username: "", password: "" }]);
  }
  function removeUtilityRow(idx) {
    setUtilities(prev => prev.filter((_, i) => i !== idx));
  }
  function updateUtility(idx, field, value) {
    setUtilities(prev => prev.map((u, i) => i === idx ? { ...u, [field]: value } : u));
  }

  // ---- Step rendering ----
  function renderStep() {
    switch (currentStepId) {
      case "property_details":
        return (
          <div>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 bg-positive-100 rounded-xl flex items-center justify-center">
                <span className="material-icons-outlined text-positive-600 text-2xl">home</span>
              </div>
              <div>
                <h3 className="text-lg font-manrope font-bold text-neutral-800">Property Details</h3>
                <p className="text-sm text-neutral-400">Enter the property address and basic info</p>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-neutral-200 p-4 space-y-4">
              <div>
                <label className="text-xs font-medium text-neutral-500 block mb-1">Address Line 1 *</label>
                <input type="text" value={propForm.address_line_1} onChange={e => setPropForm({ ...propForm, address_line_1: e.target.value })} placeholder="123 Main Street" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium text-neutral-500 block mb-1">Address Line 2</label>
                <input type="text" value={propForm.address_line_2} onChange={e => setPropForm({ ...propForm, address_line_2: e.target.value })} placeholder="Apt, Suite, Unit (optional)" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-medium text-neutral-500 block mb-1">City *</label>
                  <input type="text" value={propForm.city} onChange={e => setPropForm({ ...propForm, city: e.target.value })} placeholder="City" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-neutral-500 block mb-1">State *</label>
                  <select value={propForm.state} onChange={e => setPropForm({ ...propForm, state: e.target.value, county: "" })} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm">
                    <option value="">Select</option>
                    {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-neutral-500 block mb-1">ZIP *</label>
                  <input type="text" value={propForm.zip} onChange={e => setPropForm({ ...propForm, zip: e.target.value.replace(/\D/g, "").slice(0, 5) })} placeholder="00000" maxLength={5} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-neutral-500 block mb-1">County *</label>
                <select
                  value={propForm.county || ""}
                  onChange={e => setPropForm({ ...propForm, county: e.target.value })}
                  disabled={!propForm.state || !COUNTIES_BY_STATE[propForm.state]}
                  className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm disabled:bg-neutral-50 disabled:text-neutral-400"
                >
                  <option value="">
                    {!propForm.state ? "Select state first" : !COUNTIES_BY_STATE[propForm.state] ? "No counties configured for " + propForm.state : "Select county"}
                  </option>
                  {(COUNTIES_BY_STATE[propForm.state] || []).map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                {propForm.state && !COUNTIES_BY_STATE[propForm.state] && (
                  <p className="text-[10px] text-warn-600 mt-1">This state isn't in the operating area; ask an admin to extend COUNTIES_BY_STATE.</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-neutral-500 block mb-1">Property Type</label>
                  <select value={propForm.type} onChange={e => setPropForm({ ...propForm, type: e.target.value })} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm">
                    {["Single Family", "Multi-Family", "Apartment", "Townhouse", "Condo", "Commercial"].map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-neutral-500 block mb-1">Status</label>
                  <select value={propForm.status} onChange={e => setPropForm({ ...propForm, status: e.target.value })} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm">
                    <option value="vacant">Vacant</option>
                    <option value="occupied">Occupied</option>
                    <option value="maintenance">Maintenance</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-neutral-500 block mb-1">Notes</label>
                <textarea value={propForm.notes} onChange={e => setPropForm({ ...propForm, notes: e.target.value })} rows={2} placeholder="Optional notes about this property..." className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
              </div>
            </div>
          </div>
        );

      case "tenant_lease":
        return (
          <div>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 bg-cyan-100 rounded-xl flex items-center justify-center">
                <span className="material-icons-outlined text-cyan-600 text-2xl">person</span>
              </div>
              <div>
                <h3 className="text-lg font-manrope font-bold text-neutral-800">Tenant & Lease</h3>
                <p className="text-sm text-neutral-400">Enter tenant information and lease terms</p>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-neutral-200 p-4 space-y-4">
              <div className="grid grid-cols-6 gap-3">
                <div className="col-span-2">
                  <label className="text-xs font-medium text-neutral-500 block mb-1">First Name *</label>
                  <input type="text" value={tenantForm.tenant_first} onChange={e => { const v = e.target.value; setTenantForm(f => ({ ...f, tenant_first: v, tenant: formatPersonName(v, f.tenant_mi, f.tenant_last) })); }} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" placeholder="First" />
                </div>
                <div className="col-span-1">
                  <label className="text-xs font-medium text-neutral-500 block mb-1">MI</label>
                  <input type="text" maxLength={1} value={tenantForm.tenant_mi} onChange={e => { const v = e.target.value.toUpperCase(); setTenantForm(f => ({ ...f, tenant_mi: v, tenant: formatPersonName(f.tenant_first, v, f.tenant_last) })); }} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm text-center" placeholder="M" />
                </div>
                <div className="col-span-3">
                  <label className="text-xs font-medium text-neutral-500 block mb-1">Last Name *</label>
                  <input type="text" value={tenantForm.tenant_last} onChange={e => { const v = e.target.value; setTenantForm(f => ({ ...f, tenant_last: v, tenant: formatPersonName(f.tenant_first, f.tenant_mi, v) })); }} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" placeholder="Last" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-neutral-500 block mb-1">Email *</label>
                  <input type="email" value={tenantForm.tenant_email} onChange={e => setTenantForm({ ...tenantForm, tenant_email: e.target.value })} placeholder="tenant@email.com" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-neutral-500 block mb-1">Phone *</label>
                  <input type="tel" value={tenantForm.tenant_phone} onChange={e => setTenantForm({ ...tenantForm, tenant_phone: formatPhoneInput(e.target.value) })} placeholder="(555) 123-4567" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                </div>
              </div>
              {/* Additional tenants */}
              {[2, 3, 4, 5].filter(n => n <= tenantForm.tenantCount).map(n => (
                <div key={n} className="border-t border-neutral-200 pt-4 mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-semibold text-neutral-600">Tenant {n}</span>
                    <button type="button" onClick={() => {
                      const updates = { tenantCount: tenantForm.tenantCount - 1 };
                      updates["tenant_" + n] = ""; updates["tenant_" + n + "_email"] = ""; updates["tenant_" + n + "_phone"] = "";
                      setTenantForm(f => ({ ...f, ...updates }));
                    }} className="text-xs text-danger-400 hover:text-danger-600">Remove</button>
                  </div>
                  <div className="grid grid-cols-6 gap-3">
                    <div className="col-span-2">
                      <label className="text-xs font-medium text-neutral-500 block mb-1">First Name *</label>
                      <input type="text" value={tenantForm["tenant_" + n + "_first"] || ""} onChange={e => { const v = e.target.value; setTenantForm(f => ({ ...f, ["tenant_" + n + "_first"]: v, ["tenant_" + n]: formatPersonName(v, f["tenant_" + n + "_mi"] || "", f["tenant_" + n + "_last"] || "") })); }} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" placeholder="First" />
                    </div>
                    <div className="col-span-1">
                      <label className="text-xs font-medium text-neutral-500 block mb-1">MI</label>
                      <input type="text" maxLength={1} value={tenantForm["tenant_" + n + "_mi"] || ""} onChange={e => { const v = e.target.value.toUpperCase(); setTenantForm(f => ({ ...f, ["tenant_" + n + "_mi"]: v, ["tenant_" + n]: formatPersonName(f["tenant_" + n + "_first"] || "", v, f["tenant_" + n + "_last"] || "") })); }} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm text-center" placeholder="M" />
                    </div>
                    <div className="col-span-3">
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Last Name *</label>
                      <input type="text" value={tenantForm["tenant_" + n + "_last"] || ""} onChange={e => { const v = e.target.value; setTenantForm(f => ({ ...f, ["tenant_" + n + "_last"]: v, ["tenant_" + n]: formatPersonName(f["tenant_" + n + "_first"] || "", f["tenant_" + n + "_mi"] || "", v) })); }} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" placeholder="Last" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Email</label>
                      <input type="email" value={tenantForm["tenant_" + n + "_email"] || ""} onChange={e => setTenantForm(f => ({ ...f, ["tenant_" + n + "_email"]: e.target.value }))} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" placeholder="Email" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Phone</label>
                      <input type="tel" value={tenantForm["tenant_" + n + "_phone"] || ""} onChange={e => setTenantForm(f => ({ ...f, ["tenant_" + n + "_phone"]: formatPhoneInput(e.target.value) }))} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" placeholder="(555) 123-4567" />
                    </div>
                  </div>
                </div>
              ))}
              {tenantForm.tenantCount < 5 && (
                <button type="button" onClick={() => setTenantForm(f => ({ ...f, tenantCount: f.tenantCount + 1 }))} className="text-sm text-brand-600 hover:underline flex items-center gap-1 mt-2">
                  <span className="material-icons-outlined text-sm">person_add</span>
                  + Add Tenant {tenantForm.tenantCount + 1}
                </button>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-neutral-500 block mb-1">Monthly Rent ($) *</label>
                  <input type="number" value={tenantForm.rent} onChange={e => setTenantForm({ ...tenantForm, rent: e.target.value })} placeholder="0.00" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-neutral-500 block mb-1">Security Deposit ($)</label>
                  <input type="number" value={tenantForm.security_deposit} onChange={e => setTenantForm({ ...tenantForm, security_deposit: e.target.value })} placeholder="0.00" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-neutral-500 block mb-1">Lease Start *</label>
                  <input type="date" value={tenantForm.lease_start} onChange={e => setTenantForm({ ...tenantForm, lease_start: e.target.value })} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-neutral-500 block mb-1">Lease End *</label>
                  <input type="date" value={tenantForm.lease_end} onChange={e => setTenantForm({ ...tenantForm, lease_end: e.target.value })} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                </div>
              </div>
              {/* Voucher Tenant Toggle */}
              <div className="border-t border-neutral-200 pt-4 mt-2">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" checked={tenantForm.is_voucher || false} onChange={e => setTenantForm({ ...tenantForm, is_voucher: e.target.checked })} className="w-4 h-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500" />
                  <div>
                    <span className="text-sm font-medium text-neutral-700">Housing Voucher Tenant</span>
                    <span className="text-xs text-neutral-400 block">Section 8, HCV, VASH, or other housing assistance program</span>
                  </div>
                </label>
              </div>
              {tenantForm.is_voucher && (
                <div className="bg-brand-50/50 rounded-xl p-4 space-y-3 border border-brand-100">
                  <div className="text-xs font-semibold text-brand-700 uppercase">Voucher Details</div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Voucher Number</label>
                      <input type="text" value={tenantForm.voucher_number || ""} onChange={e => setTenantForm({ ...tenantForm, voucher_number: e.target.value })} placeholder="e.g. HCV-12345" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Re-examination Date</label>
                      <input type="date" value={tenantForm.reexam_date || ""} onChange={e => setTenantForm({ ...tenantForm, reexam_date: e.target.value })} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Voucher Portion ($)</label>
                      <input type="number" value={tenantForm.voucher_portion || ""} onChange={e => setTenantForm({ ...tenantForm, voucher_portion: e.target.value })} placeholder="HAP amount" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Tenant Portion ($)</label>
                      <input type="number" value={tenantForm.tenant_portion || ""} onChange={e => setTenantForm({ ...tenantForm, tenant_portion: e.target.value })} placeholder="Tenant share" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                  </div>
                  <div className="text-xs font-semibold text-brand-700 uppercase mt-2">Case Manager</div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Name</label>
                      <input type="text" value={tenantForm.case_manager_name || ""} onChange={e => setTenantForm({ ...tenantForm, case_manager_name: e.target.value })} placeholder="Name" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Email</label>
                      <input type="email" value={tenantForm.case_manager_email || ""} onChange={e => setTenantForm({ ...tenantForm, case_manager_email: e.target.value })} placeholder="Email" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Phone</label>
                      <input type="tel" value={tenantForm.case_manager_phone || ""} onChange={e => setTenantForm({ ...tenantForm, case_manager_phone: formatPhoneInput(e.target.value) })} placeholder="Phone" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        );

      case "utilities":
        return (
          <div>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 bg-info-100 rounded-xl flex items-center justify-center">
                <span className="material-icons-outlined text-info-600 text-2xl">bolt</span>
              </div>
              <div>
                <h3 className="text-lg font-manrope font-bold text-neutral-800">Utilities</h3>
                <p className="text-sm text-neutral-400">Set up utility accounts for this property</p>
              </div>
            </div>
            <div className="space-y-4">
              {utilities.map((u, idx) => (
                <div key={idx} className="bg-white rounded-xl border border-neutral-200 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-neutral-600">Utility #{idx + 1}</span>
                    {utilities.length > 1 && (
                      <button onClick={() => removeUtilityRow(idx)} className="text-danger-400 hover:text-danger-600 text-xs">Remove</button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Provider *</label>
                      <input type="text" value={u.provider} onChange={e => updateUtility(idx, "provider", e.target.value)} placeholder="e.g. BGE, Pepco" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Type</label>
                      <select value={u.type} onChange={e => updateUtility(idx, "type", e.target.value)} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm">
                        {["Electric", "Gas", "Water-Sewer", "Trash", "Internet", "Other"].map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Account #</label>
                      <input type="text" value={u.account_number} onChange={e => updateUtility(idx, "account_number", e.target.value)} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Due Date (day)</label>
                      <input type="number" min="1" max="28" value={u.due_date} onChange={e => updateUtility(idx, "due_date", Math.min(28, Math.max(1, Number(e.target.value))))} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Responsibility</label>
                      <select value={u.responsibility} onChange={e => updateUtility(idx, "responsibility", e.target.value)} disabled={propForm.status !== "occupied"} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm disabled:opacity-50">
                        <option value="owner_pays">Owner Pays</option>
                        <option value="tenant_pays">Tenant Pays</option>
                      </select>
                    </div>
                    <div className="col-span-2 border-t border-neutral-100 pt-2 mt-1">
                      <p className="text-xs text-neutral-400 mb-2">Portal Login (encrypted)</p>
                      <div className="grid grid-cols-3 gap-2">
                        <div><label className="text-xs font-medium text-neutral-500 block mb-1">Website</label><input type="url" value={u.website||""} onChange={e => updateUtility(idx, "website", e.target.value)} placeholder="https://..." className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" /></div>
                        <div><label className="text-xs font-medium text-neutral-500 block mb-1">Username</label><input type="text" value={u.username||""} onChange={e => updateUtility(idx, "username", e.target.value)} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" /></div>
                        <div><label className="text-xs font-medium text-neutral-500 block mb-1">Password</label><input type="password" value={u.password||""} onChange={e => updateUtility(idx, "password", e.target.value)} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" /></div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              <button onClick={addUtilityRow} className="w-full border-2 border-dashed border-neutral-200 rounded-xl py-3 text-sm text-neutral-400 hover:text-neutral-600 hover:border-neutral-300 transition-colors">
                <span className="material-icons-outlined text-sm align-middle mr-1">add</span>Add Another Utility
              </button>
            </div>
          </div>
        );

      case "hoa":
        return (
          <div>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 bg-highlight-100 rounded-xl flex items-center justify-center">
                <span className="material-icons-outlined text-highlight-600 text-2xl">account_balance</span>
              </div>
              <div>
                <h3 className="text-lg font-manrope font-bold text-neutral-800">HOA</h3>
                <p className="text-sm text-neutral-400">Homeowners Association dues (up to 5)</p>
              </div>
            </div>
            {hoas.map((h, idx) => (
            <div key={idx} className="bg-white rounded-xl border border-neutral-200 p-4 mb-3">
              <div className="flex justify-between items-center mb-3">
                <span className="text-sm font-semibold text-neutral-700">HOA #{idx + 1}</span>
                <button onClick={() => removeHoa(idx)} className="text-xs text-danger-500 hover:underline">Remove</button>
              </div>
              <div className="space-y-3">
                <div><label className="text-xs font-medium text-neutral-500 block mb-1">HOA Name *</label>
                <input type="text" value={h.hoa_name} onChange={e => updateHoa(idx, "hoa_name", e.target.value)} placeholder="e.g. Riverside HOA" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="text-xs font-medium text-neutral-500 block mb-1">Amount ($) *</label>
                  <input type="number" value={h.amount} onChange={e => updateHoa(idx, "amount", e.target.value)} placeholder="0.00" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" /></div>
                  <div><label className="text-xs font-medium text-neutral-500 block mb-1">Due Date (day)</label>
                  <input type="number" min="1" max="28" value={h.due_date} onChange={e => updateHoa(idx, "due_date", Math.min(28, Math.max(1, Number(e.target.value))))} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" /></div>
                </div>
                <div><label className="text-xs font-medium text-neutral-500 block mb-1">Frequency</label>
                <select value={h.frequency} onChange={e => updateHoa(idx, "frequency", e.target.value)} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm">
                  {["Monthly", "Quarterly", "Annual"].map(f => <option key={f} value={f}>{f}</option>)}
                </select></div>
                <div><label className="text-xs font-medium text-neutral-500 block mb-1">Notes</label>
                <textarea value={h.notes||""} onChange={e => updateHoa(idx, "notes", e.target.value)} rows={2} placeholder="Optional..." className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" /></div>
                <div className="border-t border-neutral-100 pt-2 mt-1">
                  <p className="text-xs text-neutral-400 mb-2">Portal Login (encrypted)</p>
                  <div className="grid grid-cols-3 gap-2">
                    <div><label className="text-xs font-medium text-neutral-500 block mb-1">Website</label><input type="url" value={h.website||""} onChange={e => updateHoa(idx, "website", e.target.value)} placeholder="https://..." className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" /></div>
                    <div><label className="text-xs font-medium text-neutral-500 block mb-1">Username</label><input type="text" value={h.username||""} onChange={e => updateHoa(idx, "username", e.target.value)} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" /></div>
                    <div><label className="text-xs font-medium text-neutral-500 block mb-1">Password</label><input type="password" value={h.password||""} onChange={e => updateHoa(idx, "password", e.target.value)} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" /></div>
                  </div>
                </div>
              </div>
            </div>
            ))}
            {hoas.length < 5 && (
            <div onClick={addHoa} className="border-2 border-dashed border-neutral-200 rounded-xl p-4 text-center cursor-pointer hover:border-neutral-400 hover:bg-neutral-50 transition-colors">
              <span className="text-sm text-neutral-400">+ Add {hoas.length === 0 ? "an" : "Another"} HOA</span>
            </div>
            )}
          </div>
        );

      case "loan":
        return (
          <div>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 bg-warn-100 rounded-xl flex items-center justify-center">
                <span className="material-icons-outlined text-warn-600 text-2xl">real_estate_agent</span>
              </div>
              <div>
                <h3 className="text-lg font-manrope font-bold text-neutral-800">Loan / Mortgage</h3>
                <p className="text-sm text-neutral-400">Property financing details</p>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-neutral-200 p-4 space-y-4">
              <label className="flex items-center gap-3 cursor-pointer">
                <div className={`w-10 h-6 rounded-full transition-colors ${loan.enabled ? "bg-positive-500" : "bg-neutral-200"} relative`} onClick={() => setLoan({ ...loan, enabled: !loan.enabled })}>
                  <div className={`w-5 h-5 bg-white rounded-full absolute top-0.5 transition-transform shadow ${loan.enabled ? "tranneutral-x-4.5 left-0.5" : "left-0.5"}`} />
                </div>
                <span className="text-sm font-medium text-neutral-700">Does this property have a loan?</span>
              </label>
              {loan.enabled && (
                <div className="space-y-3 pt-2">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Lender Name *</label>
                      <input type="text" value={loan.lender_name} onChange={e => setLoan({ ...loan, lender_name: e.target.value })} placeholder="e.g. Wells Fargo" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Loan Type</label>
                      <select value={loan.loan_type} onChange={e => setLoan({ ...loan, loan_type: e.target.value })} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm">
                        {["Conventional", "FHA", "VA", "USDA", "ARM", "Interest-Only", "HELOC", "Commercial", "Other"].map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Original Amount ($)</label>
                      <input type="number" value={loan.original_amount} onChange={e => setLoan({ ...loan, original_amount: e.target.value })} placeholder="0.00" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Current Balance ($)</label>
                      <input type="number" value={loan.current_balance} onChange={e => setLoan({ ...loan, current_balance: e.target.value })} placeholder="0.00" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Interest Rate (%)</label>
                      <input type="number" step="0.01" value={loan.interest_rate} onChange={e => setLoan({ ...loan, interest_rate: e.target.value })} placeholder="0.00" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Monthly Payment ($) *</label>
                      <input type="number" value={loan.monthly_payment} onChange={e => setLoan({ ...loan, monthly_payment: e.target.value })} placeholder="0.00" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                  </div>
                  <div className="bg-neutral-50 rounded-xl p-3 space-y-3">
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={loan.escrow_included} onChange={e => setLoan({ ...loan, escrow_included: e.target.checked })} className="accent-positive-600" />
                      <span className="font-medium text-neutral-700">Escrow included in payment</span>
                    </label>
                    {loan.escrow_included && (
                      <div className="space-y-2 pl-6">
                        <div>
                          <label className="text-xs font-medium text-neutral-500 block mb-1">Escrow Amount ($)</label>
                          <input type="number" value={loan.escrow_amount} onChange={e => setLoan({ ...loan, escrow_amount: e.target.value })} placeholder="0.00" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                        </div>
                        <div className="flex flex-wrap gap-3">
                          <label className="flex items-center gap-1.5 text-xs text-neutral-600">
                            <input type="checkbox" checked={loan.escrow_covers.taxes} onChange={e => setLoan({ ...loan, escrow_covers: { ...loan.escrow_covers, taxes: e.target.checked } })} className="accent-positive-600" />Taxes
                          </label>
                          <label className="flex items-center gap-1.5 text-xs text-neutral-600">
                            <input type="checkbox" checked={loan.escrow_covers.insurance} onChange={e => setLoan({ ...loan, escrow_covers: { ...loan.escrow_covers, insurance: e.target.checked } })} className="accent-positive-600" />Insurance
                          </label>
                          <label className="flex items-center gap-1.5 text-xs text-neutral-600">
                            <input type="checkbox" checked={loan.escrow_covers.pmi} onChange={e => setLoan({ ...loan, escrow_covers: { ...loan.escrow_covers, pmi: e.target.checked } })} className="accent-positive-600" />PMI
                          </label>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Loan Start Date</label>
                      <input type="date" value={loan.loan_start_date} onChange={e => setLoan({ ...loan, loan_start_date: e.target.value })} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Maturity Date</label>
                      <input type="date" value={loan.maturity_date} onChange={e => setLoan({ ...loan, maturity_date: e.target.value })} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-neutral-500 block mb-1">Account Number</label>
                    <input type="text" value={loan.account_number} onChange={e => setLoan({ ...loan, account_number: e.target.value })} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-neutral-500 block mb-1">Notes</label>
                    <textarea value={loan.notes} onChange={e => setLoan({ ...loan, notes: e.target.value })} rows={2} placeholder="Optional notes..." className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                  </div>
                  <label className="flex items-center gap-2 text-sm pt-1">
                    <input type="checkbox" checked={loan.setup_recurring} onChange={e => setLoan({ ...loan, setup_recurring: e.target.checked })} className="accent-positive-600" />
                    <span className="font-medium text-neutral-700">Set up recurring mortgage payment</span>
                  </label>
                  <div className="border-t border-neutral-100 pt-2 mt-2">
                    <p className="text-xs text-neutral-400 mb-2">Lender Portal Login (encrypted)</p>
                    <div className="grid grid-cols-3 gap-2">
                      <div><label className="text-xs font-medium text-neutral-500 block mb-1">Website</label><input type="url" value={loan.website||""} onChange={e => setLoan({...loan, website: e.target.value})} placeholder="https://..." className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" /></div>
                      <div><label className="text-xs font-medium text-neutral-500 block mb-1">Username</label><input type="text" value={loan.username||""} onChange={e => setLoan({...loan, username: e.target.value})} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" /></div>
                      <div><label className="text-xs font-medium text-neutral-500 block mb-1">Password</label><input type="password" value={loan.password||""} onChange={e => setLoan({...loan, password: e.target.value})} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" /></div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        );

      case "documents":
        return (
          <div>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 bg-success-100 rounded-xl flex items-center justify-center">
                <span className="material-icons-outlined text-success-600 text-2xl">description</span>
              </div>
              <div>
                <h3 className="text-lg font-manrope font-bold text-neutral-800">Documents</h3>
                <p className="text-sm text-neutral-400">Upload property-related documents</p>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-neutral-200 p-4 space-y-4">
              {propForm.status === "occupied" && (
                <div className="bg-warn-50 border border-warn-200 rounded-xl p-4 mb-4">
                  <div className="text-sm font-semibold text-warn-800 mb-2">Required Documents</div>
                  {[
                    { type: "Lease", label: "Lease Agreement" },
                    { type: "ID", label: "Government-Issued ID" },
                    { type: "Insurance", label: "Renters Insurance" },
                    { type: "Utility Transfer", label: "Proof of Utility Transfer" },
                    { type: "RFTA", label: "Rental Application (RFTA)" },
                    ...(tenantForm.is_voucher ? [{ type: "HAP", label: "HAP Contract" }] : []),
                  ].map(doc => {
                    const uploaded = uploadedDocs.some(d => d.type === doc.type || (d.name || "").toLowerCase().includes(doc.type.toLowerCase()));
                    return (
                      <div key={doc.type} className="flex items-center gap-2 py-1 text-sm">
                        <span className={uploaded ? "text-positive-500" : "text-warn-400"}>{uploaded ? "✅" : "☐"}</span>
                        <span className={uploaded ? "text-neutral-700" : "text-warn-700"}>{doc.label}</span>
                        <span className="text-danger-500 text-xs">*</span>
                        {uploaded && <span className="text-xs text-positive-600 bg-positive-50 px-2 py-0.5 rounded-full">Uploaded</span>}
                      </div>
                    );
                  })}
                </div>
              )}
              {propForm.status !== "occupied" && (
                <p className="text-sm text-neutral-500">Upload property documents (deed, insurance, inspection reports, etc.)</p>
              )}
              <div className="mb-4">
                <label className="text-xs font-medium text-neutral-500 block mb-2">Document Type *</label>
                <div className="flex flex-wrap gap-2">
                  {[
                    { id: "Lease", label: "Lease Agreement", icon: "description", required: true },
                    { id: "ID", label: "Government ID", icon: "badge", required: true },
                    { id: "Insurance", label: "Renters Insurance", icon: "verified_user", required: true },
                    { id: "Utility Transfer", label: "Utility Transfer Proof", icon: "swap_horiz", required: true },
                    { id: "RFTA", label: "Rental Application", icon: "assignment", required: true },
                    ...(tenantForm.is_voucher ? [{ id: "HAP", label: "HAP Contract", icon: "handshake", required: true }] : []),
                    { id: "Other", label: "Other", icon: "insert_drive_file", required: false },
                  ].map(dt => (
                    <button key={dt.id} type="button" onClick={() => setDocUploadType(dt.id)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
                        docUploadType === dt.id ? "bg-positive-50 border-positive-300 text-positive-700" : "bg-white border-neutral-200 text-neutral-600 hover:border-positive-200"
                      }`}>
                      <span className="material-icons-outlined text-sm">{dt.icon}</span>
                      {dt.label}
                      {dt.required && <span className="text-danger-500 text-xs">*</span>}
                    </button>
                  ))}
                </div>
              </div>
              {docUploadType === "Other" && (
                <div className="mb-4">
                  <label className="text-xs font-medium text-neutral-500 block mb-1">Description *</label>
                  <input type="text" value={docDescription} onChange={e => setDocDescription(e.target.value)} placeholder="Describe this document..." className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                </div>
              )}
              <div className="border-2 border-dashed border-neutral-200 rounded-xl p-6 text-center hover:border-positive-300 transition-colors cursor-pointer" onClick={() => fileInputRef.current?.click()}>
                <span className="material-icons-outlined text-3xl text-neutral-300 mb-2">cloud_upload</span>
                <p className="text-sm text-neutral-500">Click to upload files</p>
                <p className="text-xs text-neutral-400 mt-1">PDF, images, Word, Excel, text — up to 25MB each</p>
                <input ref={fileInputRef} type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx,.txt,.csv" onChange={handleFileUpload} className="hidden" />
              </div>
              {uploadedDocs.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-neutral-500">Uploaded ({uploadedDocs.length}):</p>
                  {uploadedDocs.map((doc, idx) => (
                    <div key={idx} className="flex items-center gap-2 bg-positive-50 rounded-lg px-3 py-2 text-sm">
                      <span className="material-icons-outlined text-positive-500 text-base">check_circle</span>
                      <span className="text-positive-800 font-medium truncate">{doc.name}</span>
                      <span className="text-xs text-positive-600 bg-positive-100 px-2 py-0.5 rounded-full ml-auto">{doc.type}</span>
                      <button onClick={async () => {
                        await supabase.from("documents").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email || "user" }).eq("company_id", companyId).eq("property", savedAddress).ilike("name", doc.name);
                        setUploadedDocs(prev => prev.filter((_, i) => i !== idx));
                        showToast("Document removed.", "success");
                      }} className="text-danger-400 hover:text-danger-600 ml-1" title="Remove">
                        <span className="material-icons-outlined text-sm">close</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );

      case "recurring_rent":
        return (
          <div>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 bg-brand-100 rounded-xl flex items-center justify-center">
                <span className="material-icons-outlined text-brand-600 text-2xl">autorenew</span>
              </div>
              <div>
                <h3 className="text-lg font-manrope font-bold text-neutral-800">Recurring Rent</h3>
                <p className="text-sm text-neutral-400">Set up automatic rent charges</p>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-neutral-200 p-4 space-y-4">
              <div className="bg-brand-50 rounded-xl p-3 space-y-1">
                <div className="flex justify-between text-sm"><span className="text-neutral-500">Tenant{[tenantForm.tenant_2, tenantForm.tenant_3, tenantForm.tenant_4, tenantForm.tenant_5].some(t => t?.trim()) ? "s" : ""}</span><span className="font-medium text-neutral-800">{[tenantForm.tenant, tenantForm.tenant_2, tenantForm.tenant_3, tenantForm.tenant_4, tenantForm.tenant_5].filter(t => t?.trim()).join(" / ")}</span></div>
                <div className="flex justify-between text-sm"><span className="text-neutral-500">Property</span><span className="font-medium text-neutral-800">{savedAddress.split(",")[0]}</span></div>
                {tenantForm.lease_start && tenantForm.lease_end && (
                  <div className="flex justify-between text-sm"><span className="text-neutral-500">Lease</span><span className="font-medium text-neutral-800">{tenantForm.lease_start} - {tenantForm.lease_end}</span></div>
                )}
              </div>
              <div>
                <label className="text-xs font-medium text-neutral-500 block mb-1">Monthly Rent Amount ($) *</label>
                <input type="number" value={recurring.amount} onChange={e => setRecurring({ ...recurring, amount: e.target.value })} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-neutral-500 block mb-1">Frequency</label>
                  <select value={recurring.frequency} onChange={e => setRecurring({ ...recurring, frequency: e.target.value })} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm">
                    <option value="monthly">Monthly</option>
                    <option value="quarterly">Quarterly</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-neutral-500 block mb-1">Day of Month</label>
                  <input type="number" min="1" max="28" value={recurring.day_of_month} onChange={e => setRecurring({ ...recurring, day_of_month: Math.min(28, Math.max(1, Number(e.target.value))) })} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                </div>
              </div>
              <div className="bg-neutral-50 rounded-xl p-3 text-xs text-neutral-500">
                <div className="flex justify-between"><span>Debit</span><span className="font-medium">AR - {[tenantForm.tenant, tenantForm.tenant_2, tenantForm.tenant_3, tenantForm.tenant_4, tenantForm.tenant_5].filter(t => t?.trim()).join(" / ")}</span></div>
                <div className="flex justify-between mt-1"><span>Credit</span><span className="font-medium">4000 Rental Income</span></div>
              </div>
            </div>
          </div>
        );

      case "insurance":
        return (
          <div>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 bg-rose-100 rounded-xl flex items-center justify-center">
                <span className="material-icons-outlined text-rose-600 text-2xl">shield</span>
              </div>
              <div>
                <h3 className="text-lg font-manrope font-bold text-neutral-800">Insurance</h3>
                <p className="text-sm text-neutral-400">Property insurance coverage</p>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-neutral-200 p-4 space-y-4">
              <label className="flex items-center gap-3 cursor-pointer">
                <div className={`w-10 h-6 rounded-full transition-colors ${insurance.enabled ? "bg-positive-500" : "bg-neutral-200"} relative`} onClick={() => setInsurance({ ...insurance, enabled: !insurance.enabled })}>
                  <div className={`w-5 h-5 bg-white rounded-full absolute top-0.5 transition-transform shadow ${insurance.enabled ? "tranneutral-x-4.5 left-0.5" : "left-0.5"}`} />
                </div>
                <span className="text-sm font-medium text-neutral-700">Does this property have insurance?</span>
              </label>
              {insurance.enabled && (
                <div className="space-y-3 pt-2">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Provider *</label>
                      <input type="text" value={insurance.provider} onChange={e => setInsurance({ ...insurance, provider: e.target.value })} placeholder="e.g. State Farm" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Policy Number</label>
                      <input type="text" value={insurance.policy_number} onChange={e => setInsurance({ ...insurance, policy_number: e.target.value })} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Premium Amount ($) *</label>
                      <input type="number" value={insurance.premium_amount} onChange={e => setInsurance({ ...insurance, premium_amount: e.target.value })} placeholder="0.00" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Premium Frequency</label>
                      <select value={insurance.premium_frequency} onChange={e => setInsurance({ ...insurance, premium_frequency: e.target.value })} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm">
                        <option value="monthly">Monthly</option>
                        <option value="quarterly">Quarterly</option>
                        <option value="annual">Annual</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Coverage Amount ($)</label>
                      <input type="number" value={insurance.coverage_amount} onChange={e => setInsurance({ ...insurance, coverage_amount: e.target.value })} placeholder="0.00" className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-neutral-500 block mb-1">Expiration Date</label>
                      <input type="date" value={insurance.expiration_date} onChange={e => setInsurance({ ...insurance, expiration_date: e.target.value })} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-neutral-500 block mb-1">Notes</label>
                    <textarea value={insurance.notes} onChange={e => setInsurance({ ...insurance, notes: e.target.value })} rows={2} placeholder="Optional notes..." className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" />
                  </div>
                  <div className="border-t border-neutral-100 pt-2 mt-1">
                    <p className="text-xs text-neutral-400 mb-2">Insurance Portal Login (encrypted)</p>
                    <div className="grid grid-cols-3 gap-2">
                      <div><label className="text-xs font-medium text-neutral-500 block mb-1">Website</label><input type="url" value={insurance.website||""} onChange={e => setInsurance({...insurance, website: e.target.value})} placeholder="https://..." className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" /></div>
                      <div><label className="text-xs font-medium text-neutral-500 block mb-1">Username</label><input type="text" value={insurance.username||""} onChange={e => setInsurance({...insurance, username: e.target.value})} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" /></div>
                      <div><label className="text-xs font-medium text-neutral-500 block mb-1">Password</label><input type="password" value={insurance.password||""} onChange={e => setInsurance({...insurance, password: e.target.value})} className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm" /></div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        );

      case "review":
        return (
          <div>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 bg-positive-100 rounded-xl flex items-center justify-center">
                <span className="material-icons-outlined text-positive-600 text-2xl">checklist</span>
              </div>
              <div>
                <h3 className="text-lg font-manrope font-bold text-neutral-800">Review</h3>
                <p className="text-sm text-neutral-400">Summary of your property setup</p>
              </div>
            </div>
            <div className="space-y-3">
              {/* Property Details summary */}
              <div className="bg-white rounded-xl border border-neutral-200 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-neutral-700">Property Details</span>
                  <div className="flex items-center gap-2">
                    {completedSteps.has("property_details") ? <span className="text-xs bg-positive-100 text-positive-700 px-2 py-0.5 rounded-full font-medium">Saved</span> : <span className="text-xs bg-neutral-100 text-neutral-400 px-2 py-0.5 rounded-full">Skipped</span>}
                    <button onClick={() => setStep(steps.indexOf("property_details") + 1)} className="text-xs bg-neutral-100 text-neutral-600 px-2.5 py-0.5 rounded-full font-medium hover:bg-neutral-200 transition-colors">Edit</button>
                  </div>
                </div>
                {completedSteps.has("property_details") ? (
                  <div className="text-xs text-neutral-500 space-y-0.5">
                    <div>{savedAddress}</div>
                    <div>{propForm.type} — {propForm.status}</div>
                    {propForm.notes && <div className="text-neutral-400 italic">{propForm.notes}</div>}
                  </div>
                ) : null}
              </div>

              {/* Tenant & Lease summary */}
              {propForm.status === "occupied" && (
                <div className="bg-white rounded-xl border border-neutral-200 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-semibold text-neutral-700">Tenant & Lease</span>
                    <div className="flex items-center gap-2">
                      {completedSteps.has("tenant_lease") ? <span className="text-xs bg-positive-100 text-positive-700 px-2 py-0.5 rounded-full font-medium">Saved</span> : <span className="text-xs bg-neutral-100 text-neutral-400 px-2 py-0.5 rounded-full">Skipped</span>}
                      <button onClick={() => setStep(steps.indexOf("tenant_lease") + 1)} className="text-xs bg-neutral-100 text-neutral-600 px-2.5 py-0.5 rounded-full font-medium hover:bg-neutral-200 transition-colors">Edit</button>
                    </div>
                  </div>
                  {completedSteps.has("tenant_lease") ? (
                    <div className="text-xs text-neutral-500 space-y-0.5">
                      <div>{tenantForm.tenant} — {tenantForm.tenant_email}</div>
                      <div>Rent: ${Number(tenantForm.rent || 0).toLocaleString()}/mo — Deposit: ${Number(tenantForm.security_deposit || 0).toLocaleString()}</div>
                      <div>Lease: {tenantForm.lease_start} to {tenantForm.lease_end}</div>
                    </div>
                  ) : null}
                </div>
              )}

              {/* Utilities summary */}
              <div className="bg-white rounded-xl border border-neutral-200 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-neutral-700">Utilities</span>
                  <div className="flex items-center gap-2">
                    {completedSteps.has("utilities") ? <span className="text-xs bg-positive-100 text-positive-700 px-2 py-0.5 rounded-full font-medium">Saved</span> : <span className="text-xs bg-neutral-100 text-neutral-400 px-2 py-0.5 rounded-full">Skipped</span>}
                    <button onClick={() => setStep(steps.indexOf("utilities") + 1)} className="text-xs bg-neutral-100 text-neutral-600 px-2.5 py-0.5 rounded-full font-medium hover:bg-neutral-200 transition-colors">Edit</button>
                  </div>
                </div>
                {completedSteps.has("utilities") && utilities.filter(u => u.provider.trim()).length > 0 ? (
                  <div className="text-xs text-neutral-500 space-y-0.5">
                    {utilities.filter(u => u.provider.trim()).map((u, i) => (
                      <div key={i}>{u.type} — {u.provider} — ${Number(u.amount || 0).toLocaleString()}/mo ({u.responsibility === "owner_pays" ? "Owner" : "Tenant"})</div>
                    ))}
                  </div>
                ) : completedSteps.has("utilities") ? <p className="text-xs text-neutral-400">No utilities added</p> : null}
              </div>

              {/* HOA summary */}
              <div className="bg-white rounded-xl border border-neutral-200 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-neutral-700">HOA</span>
                  <div className="flex items-center gap-2">
                    {completedSteps.has("hoa") ? <span className="text-xs bg-positive-100 text-positive-700 px-2 py-0.5 rounded-full font-medium">Saved</span> : <span className="text-xs bg-neutral-100 text-neutral-400 px-2 py-0.5 rounded-full">Skipped</span>}
                    <button onClick={() => setStep(steps.indexOf("hoa") + 1)} className="text-xs bg-neutral-100 text-neutral-600 px-2.5 py-0.5 rounded-full font-medium hover:bg-neutral-200 transition-colors">Edit</button>
                  </div>
                </div>
                {completedSteps.has("hoa") && hoas.length > 0 && hoas[0].enabled ? (
                  <div className="text-xs text-neutral-500">{hoas[0].hoa_name} — ${Number(hoas[0].amount || 0).toLocaleString()} {hoas[0].frequency}{hoas.length > 1 ? ` (+${hoas.length - 1} more)` : ""}</div>
                ) : completedSteps.has("hoa") ? <p className="text-xs text-neutral-400">No HOA</p> : null}
              </div>

              {/* Loan summary */}
              {steps.includes("loan") && (
                <div className="bg-white rounded-xl border border-neutral-200 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-semibold text-neutral-700">Loan / Mortgage</span>
                    <div className="flex items-center gap-2">
                      {completedSteps.has("loan") ? <span className="text-xs bg-positive-100 text-positive-700 px-2 py-0.5 rounded-full font-medium">Saved</span> : <span className="text-xs bg-neutral-100 text-neutral-400 px-2 py-0.5 rounded-full">Skipped</span>}
                      <button onClick={() => setStep(steps.indexOf("loan") + 1)} className="text-xs bg-neutral-100 text-neutral-600 px-2.5 py-0.5 rounded-full font-medium hover:bg-neutral-200 transition-colors">Edit</button>
                    </div>
                  </div>
                  {completedSteps.has("loan") && loan.enabled ? (
                    <div className="text-xs text-neutral-500">
                      <div>{loan.lender_name} — {loan.loan_type}</div>
                      <div>Payment: ${Number(loan.monthly_payment || 0).toLocaleString()}/mo {loan.escrow_included ? "(incl. escrow)" : ""}</div>
                      {loan.setup_recurring && <div className="text-positive-600 font-medium mt-0.5">Recurring payment set up</div>}
                    </div>
                  ) : completedSteps.has("loan") ? <p className="text-xs text-neutral-400">No loan</p> : null}
                </div>
              )}

              {/* Documents summary */}
              <div className="bg-white rounded-xl border border-neutral-200 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-neutral-700">Documents</span>
                  <div className="flex items-center gap-2">
                    {uploadedDocs.length > 0 ? <span className="text-xs bg-positive-100 text-positive-700 px-2 py-0.5 rounded-full font-medium">{uploadedDocs.length} uploaded</span> : <span className="text-xs bg-neutral-100 text-neutral-400 px-2 py-0.5 rounded-full">Skipped</span>}
                    <button onClick={() => setStep(steps.indexOf("documents") + 1)} className="text-xs bg-neutral-100 text-neutral-600 px-2.5 py-0.5 rounded-full font-medium hover:bg-neutral-200 transition-colors">Edit</button>
                  </div>
                </div>
                {uploadedDocs.length > 0 && (
                  <div className="text-xs text-neutral-500 space-y-0.5">
                    {uploadedDocs.map((d, i) => <div key={i}>{d.name}</div>)}
                  </div>
                )}
              </div>

              {/* Insurance summary */}
              <div className="bg-white rounded-xl border border-neutral-200 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-neutral-700">Insurance</span>
                  <div className="flex items-center gap-2">
                    {completedSteps.has("insurance") ? <span className="text-xs bg-positive-100 text-positive-700 px-2 py-0.5 rounded-full font-medium">Saved</span> : <span className="text-xs bg-neutral-100 text-neutral-400 px-2 py-0.5 rounded-full">Skipped</span>}
                    <button onClick={() => setStep(steps.indexOf("insurance") + 1)} className="text-xs bg-neutral-100 text-neutral-600 px-2.5 py-0.5 rounded-full font-medium hover:bg-neutral-200 transition-colors">Edit</button>
                  </div>
                </div>
                {completedSteps.has("insurance") && insurance.enabled ? (
                  <div className="text-xs text-neutral-500">
                    <div>{insurance.provider} — Policy #{insurance.policy_number || "N/A"}</div>
                    <div>Premium: ${Number(insurance.premium_amount || 0).toLocaleString()} {insurance.premium_frequency}</div>
                    {insurance.expiration_date && <div>Expires: {insurance.expiration_date}</div>}
                  </div>
                ) : completedSteps.has("insurance") ? <p className="text-xs text-neutral-400">No insurance</p> : null}
              </div>

              {/* Recurring rent summary */}
              {propForm.status === "occupied" && (
                <div className="bg-white rounded-xl border border-neutral-200 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-semibold text-neutral-700">Recurring Rent</span>
                    <div className="flex items-center gap-2">
                      {completedSteps.has("recurring_rent") ? <span className="text-xs bg-positive-100 text-positive-700 px-2 py-0.5 rounded-full font-medium">Saved</span> : <span className="text-xs bg-neutral-100 text-neutral-400 px-2 py-0.5 rounded-full">Skipped</span>}
                      <button onClick={() => setStep(steps.indexOf("recurring_rent") + 1)} className="text-xs bg-neutral-100 text-neutral-600 px-2.5 py-0.5 rounded-full font-medium hover:bg-neutral-200 transition-colors">Edit</button>
                    </div>
                  </div>
                  {completedSteps.has("recurring_rent") ? (
                    <div className="text-xs text-neutral-500">
                      <div>{tenantForm.tenant} — ${Number(recurring.amount || 0).toLocaleString()}/{recurring.frequency}</div>
                      <div>Charges on day {recurring.day_of_month} of each month</div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        );

      default:
        return null;
    }
  }

  return (
    <div className="fixed inset-0 z-[70] bg-[#fcf8ff] flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-neutral-200 px-6 py-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-manrope font-bold text-neutral-800">Property Setup</h2>
          <p className="text-sm text-neutral-400">{savedAddress || "New Property"}</p>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-neutral-500">Step {step} of {totalSteps}</span>
          <IconBtn icon="close" onClick={handleDismiss} />
        </div>
      </div>
      {/* Progress bar */}
      <div className="h-1 bg-neutral-200"><div className="h-full bg-positive-600 transition-all" style={{ width: (step / totalSteps * 100) + "%" }} /></div>
      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6">
        <div className="max-w-2xl mx-auto">
          {renderStep()}
        </div>
      </div>
      {/* Footer */}
      <div className="bg-white border-t border-neutral-200 px-6 py-4 flex items-center justify-between">
        <button onClick={handleBack} disabled={step === 1} className="text-sm text-neutral-500 hover:text-neutral-700 disabled:opacity-30">&#8592; Back</button>
        <div className="flex gap-3">
          {currentStepId !== "review" && currentStepId !== "property_details" && (
            <button onClick={handleSkip} className="text-sm text-neutral-400 hover:text-neutral-600">Skip</button>
          )}
          {step < totalSteps ? (
            <Btn variant="success-fill" onClick={handleNext} disabled={saving}>{saving ? "Saving..." : "Next →"}</Btn>
          ) : (
            <Btn variant="success-fill" onClick={handleComplete} disabled={saving}>{saving ? "Completing..." : "Complete Setup ✓"}</Btn>
          )}
        </div>
      </div>
    </div>
  );
}

// ============ PROPERTIES (Admin-Controlled with Approval Workflow) ============
function Properties({ addNotification, userRole, userProfile, companyId, setPage, showToast, showConfirm }) {
  function exportProperties() {
  const exportData = properties.filter(p => !p.archived_at);
  exportToCSV(exportData, [
  { label: "Address", key: "address" },
  { label: "Type", key: "type" },
  { label: "Status", key: "status" },
  { label: "Bedrooms", key: "bedrooms" },
  { label: "Bathrooms", key: "bathrooms" },
  { label: "Rent", key: "rent" },
  { label: "Tenant", key: "tenant" },
  { label: "Owner", key: "owner_name" },
  ], "properties_" + new Date().toLocaleDateString(), showToast);
  }
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [showForm, setShowForm] = useState(false);
  const [editingProperty, setEditingProperty] = useState(null);
  const [savingProperty, setSavingProperty] = useState(false);
  const [timelineProperty, setTimelineProperty] = useState(null);
  const [timelineData, setTimelineData] = useState([]);
  const [form, setForm] = useState({ address_line_1: "", address_line_2: "", city: "", state: "", zip: "", type: "Single Family", status: "vacant", rent: "", security_deposit: "", tenant: "", tenant_email: "", tenant_phone: "", lease_start: "", lease_end: "", notes: "" });
  // Approval workflow
  const [changeRequests, setChangeRequests] = useState([]);
  const [showRequests, setShowRequests] = useState(false);
  const [reviewNotes, setReviewNotes] = useState({});

  const isAdmin = userRole === "admin";
  const [pendingRecurringEntry, setPendingRecurringEntry] = useState(null); // { tenantName, tenantId, property, rent, leaseStart, leaseEnd }

  useEffect(() => { fetchProperties(); fetchChangeRequests(); fetchArchivedProperties(); }, [companyId]);

  async function fetchArchivedProperties() {
  const { data } = await supabase.from("properties").select("*").eq("company_id", companyId).not("archived_at", "is", null).order("archived_at", { ascending: false }).limit(200);
  setArchivedProperties(data || []);
  }

  async function restoreProperty(prop) {
  if (!await showConfirm({ message: "Restore property \"" + prop.address + "\"?" })) return;
  const { error } = await supabase.from("properties").update({ archived_at: null, archived_by: null }).eq("id", prop.id).eq("company_id", companyId);
  if (error) { pmError("PM-2010", { raw: error, context: "restore property" }); return; }
  if (prop.class_id) await supabase.from("acct_classes").update({ is_active: true }).eq("company_id", companyId).eq("id", prop.class_id);
  else await supabase.from("acct_classes").update({ is_active: true }).eq("company_id", companyId).eq("name", prop.address);
  // #9: Prompt to restore archived tenants/leases
  const { data: archivedTenants } = await supabase.from("tenants").select("id, name").eq("company_id", companyId).eq("property", prop.address).not("archived_at", "is", null);
  if (archivedTenants?.length > 0) {
  const shouldRestore = await showConfirm({ message: `This property has ${archivedTenants.length} archived tenant(s): ${archivedTenants.map(t => t.name).join(", ")}\n\nWould you like to restore them and their leases?` });
  if (shouldRestore) {
  const tenantIds = archivedTenants.map(t => t.id);
  await supabase.from("tenants").update({ archived_at: null, archived_by: null, lease_status: "active" }).eq("company_id", companyId).in("id", tenantIds);
  await supabase.from("leases").update({ status: "active" }).eq("company_id", companyId).eq("property", prop.address).eq("status", "terminated");
  }
  }
  addNotification("♻️", "Restored: " + prop.address);
  fetchProperties(); fetchArchivedProperties();
  }

  async function permanentDeleteProperty(prop) {
  if (!await showConfirm({ message: "PERMANENTLY delete \"" + prop.address + "\"?\n\nThis cannot be undone. All related data will be lost.", variant: "danger", confirmText: "Delete" })) return;
  const { error } = await supabase.from("properties").delete().eq("id", prop.id).eq("company_id", companyId);
  if (error) { pmError("PM-2003", { raw: error, context: "permanent delete property " + prop.address }); return; }
  addNotification("🗑️", "Permanently deleted: " + prop.address);
  fetchArchivedProperties();
  }

  async function fetchProperties() {
  // Fetch properties owned by this company
  const { data: ownedProps } = await supabase.from("properties").select("*").eq("company_id", companyId).is("archived_at", null);
  // Also fetch properties where this company is assigned as PM (cross-company)
  const { data: managedProps } = await supabase.from("properties").select("*").eq("pm_company_id", companyId);
  // Merge, deduplicate, and tag ownership type
  const allProps = (ownedProps || []).map(p => ({ ...p, _ownership: "owned" }));
  (managedProps || []).forEach(mp => {
  if (!allProps.find(p => p.id === mp.id)) allProps.push({ ...mp, _ownership: "managed" });
  });
  // Enrich with tenant email/phone for edit forms
  if (allProps.length > 0) {
  const { data: tenantData } = await supabase.from("tenants").select("name, email, phone, property").eq("company_id", companyId).is("archived_at", null);
  if (tenantData) {
  for (const p of allProps) {
  const t = tenantData.find(t => t.property === p.address && t.name === p.tenant);
  if (t) { p._tenantEmail = t.email || ""; p._tenantPhone = t.phone || ""; }
  }
  }
  }
  setProperties(allProps);
  setLoading(false);
  }

  async function openPropertyDetail(p) {
  setSelectedProperty(p);
  setPropertyDetailTab("overview");
  setHistoricalTenantDetail(null);
  const [docsRes, wosRes, archivedTenantsRes, terminatedLeasesRes, utilRes, hoaRes, loanRes, insRes, licRes] = await Promise.all([
  supabase.from("documents").select("*").eq("company_id", companyId).eq("property", p.address).is("archived_at", null).order("uploaded_at", { ascending: false }).limit(100),
  supabase.from("work_orders").select("*").eq("company_id", companyId).eq("property", p.address).is("archived_at", null).order("created", { ascending: false }).limit(100),
  supabase.from("tenants").select("*").eq("company_id", companyId).eq("property", p.address).not("archived_at", "is", null).order("archived_at", { ascending: false }),
  supabase.from("leases").select("*").eq("company_id", companyId).eq("property", p.address).in("status", ["terminated", "expired"]).order("end_date", { ascending: false }),
  supabase.from("utilities").select("*").eq("company_id", companyId).eq("property", p.address).is("archived_at", null),
  supabase.from("hoa_payments").select("*").eq("company_id", companyId).eq("property", p.address).is("archived_at", null),
  supabase.from("property_loans").select("*").eq("company_id", companyId).eq("property", p.address).is("archived_at", null),
  supabase.from("property_insurance").select("*").eq("company_id", companyId).eq("property", p.address).is("archived_at", null),
  supabase.from("property_licenses").select("*").eq("company_id", companyId).eq("property_id", p.id).is("archived_at", null).order("expiry_date", { ascending: true }),
  ]);
  setPropertyDocs(docsRes.data || []);
  setPropertyWorkOrders(wosRes.data || []);
  setPropertyUtilities(utilRes.data || []);
  setPropertyHoas(hoaRes.data || []);
  setPropertyLoans(loanRes.data || []);
  setPropertyInsurance(insRes.data || []);
  setPropertyLicenses(licRes.data || []);
  // Combine archived tenants + terminated lease tenants, deduplicate by name
  const archivedTenants = archivedTenantsRes.data || [];
  const terminatedLeases = terminatedLeasesRes.data || [];
  const tenantMap = {};
  archivedTenants.forEach(t => { tenantMap[t.name.toLowerCase()] = { ...t, _leases: [] }; });
  terminatedLeases.forEach(l => {
  const key = (l.tenant_name || "").toLowerCase();
  if (!tenantMap[key]) {
  tenantMap[key] = { name: l.tenant_name, property: p.address, company_id: companyId, lease_status: "inactive", _leases: [] };
  }
  tenantMap[key]._leases.push(l);
  });
  // Attach leases to archived tenants
  archivedTenants.forEach(t => {
  const key = t.name.toLowerCase();
  if (tenantMap[key] && tenantMap[key]._leases.length === 0) {
  tenantMap[key]._leases = terminatedLeases.filter(l => (l.tenant_name || "").toLowerCase() === key);
  }
  });
  setHistoricalTenants(Object.values(tenantMap));
  }

  async function fetchChangeRequests() {
  const { data } = await supabase.from("property_change_requests").select("*").eq("company_id", companyId).order("requested_at", { ascending: false }).limit(100);
  setChangeRequests(data || []);
  }

  async function saveProperty() {
  if (!editingProperty) { showToast("Use the Property Setup Wizard to add new properties.", "info"); return; }
  // Validate BEFORE acquiring guard lock (so failed validation doesn't lock the button)
  if (!form.address_line_1.trim()) { showToast("Address Line 1 is required.", "error"); return; }
  if (!form.city.trim()) { showToast("City is required.", "error"); return; }
  if (!form.state) { showToast("State is required.", "error"); return; }
  if (!form.zip.trim() || !/^\d{5}$/.test(form.zip.trim())) { showToast("ZIP code must be exactly 5 digits.", "error"); return; }
  if (editingProperty && isReadOnly(editingProperty)) {
  showToast("This is a managed property. You can only view it, not edit.", "error");
  return;
  }
  if (!guardSubmit("saveProperty")) { showToast("Save already in progress — please wait.", "warning"); return; }
  try {
  // Check for duplicate address (new properties only — requires DB query, so after guard)
  if (!editingProperty) {
  const compositeCheck = [form.address_line_1, form.address_line_2, form.city, form.state, form.zip].filter(Boolean).join(", ");
  const { data: dup } = await supabase.from("properties").select("id").eq("company_id", companyId).eq("address", compositeCheck).is("archived_at", null).maybeSingle();
  if (dup) { showToast("A property with this address already exists.", "error"); guardRelease("saveProperty"); return; }
  }
  // #7: Block occupied→vacant/maintenance without Move-Out Wizard (admin can override)
  if (editingProperty && editingProperty.status === "occupied" && form.status !== "occupied") {
  if (isAdmin) {
  if (!await showConfirm({ message: "This property has an active tenant. Changing status to \"" + form.status + "\" without using the Move-Out Wizard may leave leases, tenant records, and accounting in an inconsistent state.\n\nUse the Move-Out Wizard instead for a clean transition.\n\nOverride and change status anyway?", variant: "danger", confirmText: "Override" })) { guardRelease("saveProperty"); return; }
  } else {
  showToast("Cannot change an occupied property to \"" + form.status + "\". Please use the Move-Out Wizard to properly process the tenant move-out.", "error");
  guardRelease("saveProperty");
  return;
  }
  }
  if (form.status === "occupied") {
  if (!form.tenant.trim()) { showToast("Tenant name is required for occupied properties.", "error"); guardRelease("saveProperty"); return; }
  if (!form.tenant_email.trim() || !form.tenant_email.includes("@")) { showToast("A valid tenant email is required for occupied properties.", "error"); guardRelease("saveProperty"); return; }
  if (!form.tenant_phone.trim()) { showToast("Tenant phone number is required for occupied properties.", "error"); guardRelease("saveProperty"); return; }
  if (!form.rent || isNaN(Number(form.rent)) || Number(form.rent) <= 0) { showToast("Monthly rent is required for occupied properties.", "error"); guardRelease("saveProperty"); return; }
  if (!form.security_deposit || isNaN(Number(form.security_deposit))) { showToast("Security deposit amount is required for occupied properties.", "error"); guardRelease("saveProperty"); return; }
  if (!form.lease_start) { showToast("Lease start date is required for occupied properties.", "error"); guardRelease("saveProperty"); return; }
  if (!form.lease_end) { showToast("Lease end date is required for occupied properties.", "error"); guardRelease("saveProperty"); return; }
  if (form.lease_start >= form.lease_end) { showToast("Lease end date must be after lease start date.", "error"); guardRelease("saveProperty"); return; }
  }
  // Build composite address for backward compatibility
  const compositeAddress = [form.address_line_1, form.address_line_2, form.city, form.state + " " + form.zip].filter(Boolean).join(", ");
  // Track tenant info for post-save doc prompt (declared outside if/else so accessible in post-save UI code)
  const _isNewOccupied = form.status === "occupied" && form.tenant.trim();
  const _savedTenantName = form.tenant.trim();
  const _savedAddress = compositeAddress;

  {
  // Guard: block edits to managed (cross-company) properties
  if (editingProperty && editingProperty.company_id !== companyId) {
  showToast("This property belongs to another company and cannot be edited here.", "error");
  guardRelease("saveProperty"); return;
  }
  // Admin: direct save
  const { error } = editingProperty
  ? await supabase.from("properties").update({ address: compositeAddress, address_line_1: form.address_line_1, address_line_2: form.address_line_2, city: form.city, state: form.state, zip: form.zip, type: form.type, status: form.status, rent: form.status === "occupied" ? form.rent : null, security_deposit: form.status === "occupied" ? form.security_deposit : null, tenant: form.status === "occupied" ? form.tenant : "", lease_start: form.status === "occupied" ? form.lease_start : null, lease_end: form.status === "occupied" ? form.lease_end : null, notes: form.notes }).eq("id", editingProperty.id).eq("company_id", companyId)
  : await supabase.from("properties").insert([{ address: compositeAddress, address_line_1: form.address_line_1, address_line_2: form.address_line_2, city: form.city, state: form.state, zip: form.zip, type: form.type, status: form.status, rent: form.status === "occupied" ? form.rent : null, security_deposit: form.status === "occupied" ? form.security_deposit : null, tenant: form.status === "occupied" ? form.tenant : "", lease_start: form.status === "occupied" ? form.lease_start : null, lease_end: form.status === "occupied" ? form.lease_end : null, notes: form.notes, company_id: companyId }]);
  if (error) {
  // Better error message for duplicate address
  if (error.message?.includes("idx_properties_unique_address") || error.message?.includes("duplicate")) {
  pmError("PM-2001", { raw: error, context: "save property " + compositeAddress });
  } else {
  pmError("PM-2002", { raw: error, context: "save property " + compositeAddress });
  }
  return;
  }
  if (_isNewOccupied) setSavingProperty(true);
  // Auto-create tenant on tenant page when property becomes occupied
  if (form.status === "occupied" && form.tenant.trim()) {
  // Check by name first, then by property (prevents duplicates when address varies slightly)
  let existingTenant = null;
  const { data: byName } = await supabase.from("tenants").select("id").eq("company_id", companyId).ilike("name", form.tenant.trim()).eq("property", compositeAddress).is("archived_at", null).maybeSingle();
  if (byName) { existingTenant = byName; }
  else {
    const { data: byProp } = await supabase.from("tenants").select("id").eq("company_id", companyId).eq("property", compositeAddress).is("archived_at", null).eq("lease_status", "active").maybeSingle();
    if (byProp) existingTenant = byProp;
  }
  let tenantId = existingTenant?.id;
  if (!existingTenant) {
  const { data: newT } = await supabase.from("tenants").insert([{ company_id: companyId, name: form.tenant.trim(), email: (form.tenant_email || "").toLowerCase(), phone: form.tenant_phone || "", property: compositeAddress, rent: Number(form.rent) || 0, late_fee_amount: safeNum(form.late_fee_amount) || null, late_fee_type: form.late_fee_type || "flat", lease_status: "active", lease_start: form.lease_start || null, lease_end_date: form.lease_end || null, move_in: form.lease_start || null, move_out: form.lease_end || null, balance: 0 }]).select("id").maybeSingle();
  tenantId = newT?.id;
  // Notify: new tenant move-in
  queueNotification("move_in", (form.tenant_email || "").toLowerCase(), { tenant: form.tenant.trim(), property: compositeAddress, moveInDate: form.lease_start || formatLocalDate(new Date()) }, companyId);
  } else {
  await supabase.from("tenants").update({ email: (form.tenant_email || "").toLowerCase(), phone: form.tenant_phone || "", rent: Number(form.rent) || 0, lease_status: "active", lease_start: form.lease_start || null, lease_end_date: form.lease_end || null, move_in: form.lease_start || null, move_out: form.lease_end || null }).eq("id", existingTenant.id).eq("company_id", companyId);
  }
  // Create tenant AR sub-account (e.g., 1100-001 AR - Alice Johnson)
  await getOrCreateTenantAR(companyId, form.tenant.trim(), tenantId);
  // Auto-create lease record if dates are provided and no active lease exists
  if (form.lease_start && form.lease_end && form.rent) {
  const { data: existingLease } = await supabase.from("leases").select("id").eq("company_id", companyId).eq("property", compositeAddress).eq("status", "active").maybeSingle();
  if (!existingLease) {
  await supabase.from("leases").insert([{ company_id: companyId, tenant_name: form.tenant.trim(), tenant_id: tenantId || null, property: compositeAddress, start_date: form.lease_start, end_date: form.lease_end, rent_amount: Number(form.rent), security_deposit: Number(form.security_deposit) || 0, status: "active", payment_due_day: 1, rent_escalation_pct: 3, escalation_frequency: "annual" }]);
  }
  // Post security deposit JE if deposit amount provided
  const dep = Number(form.security_deposit) || 0;
  if (dep > 0) {
  const classId = await getPropertyClassId(compositeAddress, companyId);
  const tenantArId = await getOrCreateTenantAR(companyId, form.tenant.trim(), tenantId);
  const _depOk = await autoPostJournalEntry({ companyId, date: form.lease_start, description: "Security deposit received — " + form.tenant.trim() + " — " + compositeAddress, reference: "DEP-" + shortId(), property: compositeAddress,
  lines: [
  { account_id: tenantArId, account_name: "AR - " + form.tenant.trim(), debit: dep, credit: 0, class_id: classId, memo: "Security deposit from " + form.tenant.trim() },
  { account_id: "2100", account_name: "Security Deposits Held", debit: 0, credit: dep, class_id: classId, memo: form.tenant.trim() + " — " + compositeAddress },
  ]
  });
  if (_depOk && tenantId) {
  await safeLedgerInsert({ company_id: companyId, tenant: form.tenant.trim(), tenant_id: tenantId, property: compositeAddress, date: form.lease_start, description: "Security deposit collected", amount: dep, type: "deposit", balance: 0 });
  }
  if (!_depOk) showToast("Security deposit accounting entry failed. Please check the accounting module.", "error");
  }
  // Post rent charges for this lease (awaited so errors surface)
  try {
  const result = await autoPostRentCharges(companyId);
  if (result?.posted > 0) showToast("Posted " + result.posted + " rent charge(s) to accounting", "success");
  } catch (e) { pmError("PM-4008", { raw: e, context: "auto rent post after property save", silent: true }); }
  // Recurring rent is now handled by PropertySetupWizard (Step 5)
  }
  }
  // #12: Sync security deposit to active lease when editing property
  if (editingProperty && form.status === "occupied" && form.security_deposit) {
  await supabase.from("leases").update({ security_deposit: Number(form.security_deposit) || 0 }).eq("company_id", companyId).eq("property", compositeAddress).eq("status", "active");
  }
  // Cascade address change to all related tables
  if (editingProperty && editingProperty.address !== compositeAddress) {
  // Atomic cascade rename — server-side RPC required (no client fallback)
  const { error: renameErr } = await supabase.rpc("rename_property_v2", {
  p_company_id: companyId, p_property_id: editingProperty.id,
  p_new_address: compositeAddress
  });
  if (renameErr) {
  // #13: Client-side fallback — cascade rename to tables the RPC may not cover
  pmError("PM-2006", { raw: renameErr, context: "property rename RPC, running client-side fallback", silent: true });
  const oldAddr = editingProperty.address;
  const renameResults = await Promise.allSettled([
  supabase.from("tenants").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
  supabase.from("payments").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
  supabase.from("leases").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
  supabase.from("work_orders").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
  supabase.from("documents").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
  supabase.from("autopay_schedules").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
  supabase.from("utilities").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
  supabase.from("eviction_cases").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
  supabase.from("ledger_entries").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
  supabase.from("messages").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
  supabase.from("property_loans").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
  supabase.from("property_insurance").update({ property: compositeAddress }).eq("company_id", companyId).eq("property", oldAddr),
  supabase.from("property_setup_wizard").update({ property_address: compositeAddress }).eq("company_id", companyId).eq("property_address", oldAddr),
  ]);
  const renameFails = renameResults.filter(r => r.status === "rejected" || r.value?.error);
  if (renameFails.length > 0) {
    const failMsgs = renameFails.map(r => r.status === "rejected" ? (r.reason?.message || r.reason) : r.value?.error?.message).filter(Boolean).join("; ");
    pmError("PM-2006", { raw: { message: failMsgs }, context: "property rename failures", meta: { failures: renameFails.length } });
    showToast("Warning: " + renameFails.length + " table(s) failed to update during rename. Some records may still reference the old address.", "error");
  }
  }
  }
  // Auto-create accounting class for new properties
  if (!editingProperty) {
  const classId = crypto.randomUUID();
  const { data: newClass } = await supabase.from("acct_classes").upsert([{ id: classId, name: compositeAddress, description: `${form.type} · ${formatCurrency(form.rent)}/mo`, color: pickColor(compositeAddress || ""), is_active: true, company_id: companyId }], { onConflict: "company_id,name" }).select("id").maybeSingle();
  // #17: Store class_id on property for reliable lookups
  if (newClass?.id) await supabase.from("properties").update({ class_id: newClass.id }).eq("company_id", companyId).eq("address", compositeAddress);
  } else {
  // Update accounting class description when property is edited
  await supabase.from("acct_classes").update({ description: `${form.type} · ${formatCurrency(form.rent)}/mo` }).eq("company_id", companyId).eq("name", compositeAddress);
  }
  addNotification("🏠", editingProperty ? `Property updated: ${form.address}` : `New property added: ${form.address}`);
  logAudit(editingProperty ? "update" : "create", "properties", `${editingProperty ? "Updated" : "Added"} property: ${form.address}`, editingProperty?.id || "", userProfile?.email, userRole, companyId);
  }
  setShowForm(false);
  setEditingProperty(null);
  setForm({ address_line_1: "", address_line_2: "", city: "", state: "", zip: "", type: "Single Family", status: "vacant", rent: "", security_deposit: "", tenant: "", tenant_email: "", tenant_phone: "", lease_start: "", lease_end: "", notes: "" });
  fetchProperties();
  // Show doc upload prompt for occupied properties (form is now closed)
  setSavingProperty(false);
  showToast("Property updated successfully", "success");
  } catch (e) {
  pmError("PM-2002", { raw: e, context: "saveProperty" });
  setSavingProperty(false);
  showToast("Property was saved but a post-save operation failed: " + (e.message || e) + ". Please check the property list.", "error");
  // Still close form and refresh since the DB save succeeded (error is in post-save operations)
  setShowForm(false);
  setEditingProperty(null);
  fetchProperties();
  } finally { guardRelease("saveProperty"); }
  }

  async function deactivateProperty(property) {
  if (!await showConfirm({ message: `Deactivate "${property.address}"?\n\nThis will:\n• Mark the property as inactive\n• Hide related tenants and work orders from active views\n• Preserve all accounting history\n• You can reactivate it anytime\n\nUse Delete instead if you want to fully remove it.`, variant: "danger", confirmText: "Deactivate" })) return;
  const { error } = await supabase.from("properties").update({ 
  status: "inactive",
  }).eq("id", property.id).eq("company_id", companyId);
  if (error) { pmError("PM-2003", { raw: error, context: "deactivate property " + property.address }); return; }
  // Deactivate accounting class
  if (property.class_id) await supabase.from("acct_classes").update({ is_active: false }).eq("company_id", companyId).eq("id", property.class_id);
  else await supabase.from("acct_classes").update({ is_active: false }).eq("company_id", companyId).eq("name", property.address);
  // Mark tenants as inactive
  await supabase.from("tenants").update({ lease_status: "inactive" }).eq("company_id", companyId).eq("property", property.address).is("archived_at", null);
  addNotification("⏸️", `Deactivated property: ${property.address}`);
  logAudit("deactivate", "properties", `Deactivated property: ${property.address}`, property.id, userProfile?.email, userRole, companyId);
  fetchProperties();
  }

  async function reactivateProperty(property) {
  const { error } = await supabase.from("properties").update({ 
  status: property.tenant ? "occupied" : "vacant",
  }).eq("id", property.id).eq("company_id", companyId);
  if (error) { pmError("PM-2004", { raw: error, context: "reactivate property " + property.address }); return; }
  if (property.class_id) await supabase.from("acct_classes").update({ is_active: true }).eq("company_id", companyId).eq("id", property.class_id);
  else await supabase.from("acct_classes").update({ is_active: true }).eq("company_id", companyId).eq("name", property.address);
  await supabase.from("tenants").update({ lease_status: "active" }).eq("company_id", companyId).eq("property", property.address).is("archived_at", null);
  addNotification("▶️", `Reactivated property: ${property.address}`);
  fetchProperties();
  }

  async function requestDeleteProperty(property) {
  if (!guardSubmit("requestDeleteProperty")) return;
  try {
  if (!await showConfirm({ message: `Request to delete "${property.address}"?\n\nAn admin will review and approve this request.` })) return;
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("property_change_requests").insert([{
    company_id: companyId, request_type: "delete", property_id: property.id,
    requested_by: user?.email || "unknown", address: property.address,
    type: property.type, property_status: property.status, notes: "Delete requested",
  }]);
  if (error) throw new Error("Failed to submit request: " + error.message);
  showToast("Delete request submitted for admin approval.", "success");
  logAudit("create", "property_requests", "Requested delete: " + property.address, property.id, user?.email, userRole, companyId);
  } catch (e) { showToast(e.message, "error"); }
  finally { guardRelease("requestDeleteProperty"); }
  }

  async function deleteProperty(id, address) {
  if (!guardSubmit("deleteProperty")) return;
  try {
  if (!isAdmin) { showToast("Only admins can delete properties.", "error"); return; }
  // Server-side role verification — don't rely solely on client-side isAdmin
  const { data: roleCheck } = await supabase.from("company_members").select("role").eq("company_id", companyId).ilike("user_email", userProfile?.email || "").eq("status", "active").maybeSingle();
  if (roleCheck && roleCheck.role !== "admin") { showToast("Server verification failed: admin role required.", "error"); return; }
  const targetProp = properties.find(p => String(p.id) === String(id));
  if (targetProp && targetProp.company_id !== companyId) {
  showToast("This property belongs to another company and cannot be archived here.", "error");
  return;
  }
  // Step 1: Ask for deletion reason
  if (!await showConfirm({ message: `Delete property "${address}"?\n\nThis is for mistaken entries. ALL data will be removed from active views:\n• Tenants (balances cleared), leases terminated\n• Work orders, utilities, documents, inspections\n• Journal entries voided, ledger entries archived\n• Accounting class hidden from tracking\n\nAll data can be restored within 180 days.\nUse "Deactivate" instead if this property is real but going offline.`, variant: "danger", confirmText: "Delete" })) return;
  // Prompt for reason (required for audit trail)
  let deleteReason = "";
  await new Promise(resolve => {
  const reasonEl = document.createElement("div");
  reasonEl.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.3);z-index:100;display:flex;align-items:center;justify-content:center;padding:1rem"><div style="background:white;border-radius:1rem;padding:1.5rem;max-width:400px;width:100%"><h3 style="font-weight:bold;margin-bottom:0.5rem">Reason for Deletion</h3><p style="font-size:0.8rem;color:#666;margin-bottom:0.75rem">This will be recorded in the audit trail.</p><textarea id="__deleteReason" rows="3" style="width:100%;border:1px solid #ddd;border-radius:0.5rem;padding:0.5rem;font-size:0.85rem" placeholder="e.g., Property entered by mistake, duplicate entry, test data..."></textarea><div style="display:flex;gap:0.5rem;margin-top:0.75rem"><button id="__deleteConfirm" style="flex:1;background:#4F46E5;color:white;padding:0.5rem;border-radius:0.5rem;font-size:0.85rem;border:none;cursor:pointer">Confirm Delete</button><button id="__deleteCancel" style="flex:1;background:#f1f1f1;padding:0.5rem;border-radius:0.5rem;font-size:0.85rem;border:none;cursor:pointer">Cancel</button></div></div></div>';
  document.body.appendChild(reasonEl);
  document.getElementById("__deleteConfirm").onclick = () => { deleteReason = document.getElementById("__deleteReason").value || "No reason provided"; reasonEl.remove(); resolve(); };
  document.getElementById("__deleteCancel").onclick = () => { reasonEl.remove(); resolve(); };
  });
  if (!deleteReason) return; // User cancelled
  // Step 2: Gather related data
  const { data: propertyTenants } = await supabase.from("tenants").select("id, name").eq("company_id", companyId).eq("property", address).is("archived_at", null);
  const tenantNames = (propertyTenants || []).map(t => t.name);
  const tenantIds = (propertyTenants || []).map(t => t.id);
  const archiveBy = userProfile?.email || "admin";
  const archiveTs = new Date().toISOString();
  const arch = { archived_at: archiveTs, archived_by: archiveBy };

  // ── SOFT DELETE: Archive everything. Restorable within 180 days. ──
  // Everything removed from active views but data preserved in DB.

  // 1. Void all journal entries for this property (preserved but inactive)
  const { data: propJEs } = await supabase.from("acct_journal_entries").select("id").eq("company_id", companyId).eq("property", address);
  const jeIds = (propJEs || []).map(je => je.id);
  if (jeIds.length > 0) {
  await supabase.from("acct_journal_entries").update({ status: "voided" }).eq("company_id", companyId).eq("property", address);
  }

  // 2. Archive ledger entries for tenants at this property
  for (const name of tenantNames) {
  await supabase.from("ledger_entries").update(arch).eq("company_id", companyId).eq("tenant", name).eq("property", address).is("archived_at", null);
  }

  // 3. Deactivate tenant AR sub-accounts
  for (const tid of tenantIds) {
  await supabase.from("acct_accounts").update({ is_active: false }).eq("company_id", companyId).eq("tenant_id", tid);
  }

  // 4. Deactivate accounting class (hidden from class tracking)
  const { data: delProp } = await supabase.from("properties").select("class_id").eq("id", id).eq("company_id", companyId).maybeSingle();
  if (delProp?.class_id) await supabase.from("acct_classes").update({ is_active: false }).eq("company_id", companyId).eq("id", delProp.class_id);
  else await supabase.from("acct_classes").update({ is_active: false }).eq("company_id", companyId).eq("name", address);

  // 5. Archive recurring journal entries
  await supabase.from("recurring_journal_entries").update({ ...arch, status: "inactive" }).eq("company_id", companyId).eq("property", address).is("archived_at", null);

  // 6. Archive all operational data (parallel with error collection)
  const archAt = { archived_at: archiveTs };
  const archiveResults = await Promise.allSettled([
  supabase.from("work_orders").update(arch).eq("company_id", companyId).eq("property", address).is("archived_at", null),
  supabase.from("utilities").update(arch).eq("company_id", companyId).eq("property", address).is("archived_at", null),
  supabase.from("documents").update(arch).eq("company_id", companyId).eq("property", address).is("archived_at", null),
  supabase.from("vendor_invoices").update(archAt).eq("company_id", companyId).eq("property", address).is("archived_at", null),
  supabase.from("hoa_payments").update(arch).eq("company_id", companyId).eq("property", address).is("archived_at", null),
  supabase.from("inspections").update(archAt).eq("company_id", companyId).eq("property", address).is("archived_at", null),
  supabase.from("payments").update(archAt).eq("company_id", companyId).eq("property", address).is("archived_at", null),
  supabase.from("property_loans").update(arch).eq("company_id", companyId).eq("property", address).is("archived_at", null),
  supabase.from("property_insurance").update(arch).eq("company_id", companyId).eq("property", address).is("archived_at", null),
  supabase.from("property_setup_wizard").update({ status: "dismissed", updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("property_address", address).eq("status", "in_progress"),
  ]);
  const archiveFailures = archiveResults.filter(r => r.status === "rejected" || r.value?.error);
  if (archiveFailures.length > 0) {
  pmError("PM-2003", { raw: { message: archiveFailures.length + " table(s) failed to archive" }, context: "property archive batch for " + address, meta: { failures: archiveFailures.length } });
  }

  // 7. Clear security deposit liabilities before terminating leases
  const { data: activeLeases } = await supabase.from("leases").select("id, tenant_name, security_deposit, deposit_status").eq("company_id", companyId).eq("property", address).eq("status", "active");
  for (const lease of (activeLeases || [])) {
  const dep = safeNum(lease.security_deposit);
  if (dep > 0 && lease.deposit_status !== "returned" && lease.deposit_status !== "forfeited") {
  // Post JE to forfeit deposit (property deleted = deposit forfeited to other income)
  const classId = await getPropertyClassId(address, companyId);
  await autoPostJournalEntry({ companyId, date: formatLocalDate(new Date()), description: "Deposit forfeited — property deleted — " + (lease.tenant_name || ""), reference: "DEPFORF-" + shortId(), property: address,
  lines: [
  { account_id: "2100", account_name: "Security Deposits Held", debit: dep, credit: 0, class_id: classId, memo: "Clear liability: " + (lease.tenant_name || "") },
  { account_id: "4150", account_name: "Deposit Forfeiture Income", debit: 0, credit: dep, class_id: classId, memo: "Forfeited deposit: property deleted" },
  ]
  });
  await supabase.from("leases").update({ deposit_status: "forfeited" }).eq("id", lease.id).eq("company_id", companyId);
  }
  }
  // Terminate leases, disable autopay
  await supabase.from("leases").update({ status: "terminated" }).eq("company_id", companyId).eq("property", address).eq("status", "active");
  await supabase.from("autopay_schedules").update({ enabled: false }).eq("company_id", companyId).eq("property", address);

  // 8. Archive tenants — set balance to NULL (not 0), lease inactive
  for (const tid of tenantIds) {
  await supabase.from("tenants").update({ ...arch, balance: null, lease_status: "inactive" }).eq("id", tid).eq("company_id", companyId);
  }

  // 9. Archive the property
  const { error: archErr } = await supabase.rpc("archive_property", {
  p_company_id: companyId, p_property_id: String(id), p_address: address, p_archive_tenant: true, p_user_email: archiveBy
  });
  if (archErr) {
  await supabase.from("properties").update(arch).eq("id", id).eq("company_id", companyId);
  }

  // 10. Audit trail with reason
  logAudit("delete", "properties",
  `DELETED property: ${address}\nReason: ${deleteReason}\nArchived: ${jeIds.length} journal entries voided, ${tenantNames.length} tenant(s) [${tenantNames.join(", ")}] archived (balance cleared), all related data archived. Restorable within 180 days.`,
  id, archiveBy, userRole, companyId);
  addNotification("🗑️", `Property deleted: ${address}`);
  showToast("Property and all related data deleted. Restorable within 180 days. Reason logged to audit trail.", "success");
  // Clear caches
  delete _classIdCache[`${companyId}::${address}`];
  delete _acctIdCache[companyId];
  for (const tn of tenantNames) { delete _tenantArCache[`${companyId}::${tn}`]; }
  fetchProperties();
  } finally { guardRelease("deleteProperty"); }
  }

  // Admin: approve change request
  async function approveRequest(req) {
  if (!guardSubmit("approveRequest")) return;
  try {
  if (req.request_type === "add") {
  const { error: apErr } = await supabase.from("properties").insert([{ company_id: companyId, address: req.address, type: req.type, status: req.property_status, rent: req.rent, tenant: req.tenant, lease_end: req.lease_end, notes: req.notes }]);
  if (apErr) { showToast("Error adding property: " + apErr.message, "error"); return; }
  // Auto-create accounting class for this property
  const classId = crypto.randomUUID();
  const { data: newClass, error: classErr } = await supabase.from("acct_classes").upsert([{ id: classId, name: req.address, description: `${req.type} · ${formatCurrency(req.rent)}/mo`, color: pickColor(req?.address || ""), is_active: true, company_id: companyId }], { onConflict: "company_id,name" }).select("id").maybeSingle();
  if (classErr) pmError("PM-4010", { raw: classErr, context: "accounting class creation", silent: true });
  if (newClass?.id) await supabase.from("properties").update({ class_id: newClass.id }).eq("company_id", companyId).eq("address", req.address);
  addNotification("✅", `Property approved & added: ${req.address}`);
  } else if (req.request_type === "edit" && req.property_id) {
  // Check if address changed and cascade
  const { data: oldProp } = await supabase.from("properties").select("address").eq("company_id", companyId).eq("id", req.property_id).maybeSingle();
  const { error: editErr } = await supabase.from("properties").update({ address: req.address, type: req.type, status: req.property_status, rent: req.rent, tenant: req.tenant, lease_end: req.lease_end, notes: req.notes }).eq("id", req.property_id).eq("company_id", companyId);
  if (editErr) { showToast("Error updating property: " + editErr.message, "error"); return; }
  if (oldProp && oldProp.address !== req.address) {
  // Atomic cascade rename via RPC
  const { error: cascErr } = await supabase.rpc("rename_property_v2", {
  p_company_id: companyId, p_property_id: req.property_id,
  p_new_address: req.address
  });
  if (cascErr) showToast("Property updated but cascade rename failed: " + cascErr.message + ". Some related records may still show the old address.", "error");
  }
  addNotification("✅", `Property edit approved: ${req.address}`);
  } else if (req.request_type === "delete" && req.property_id) {
  await deleteProperty(req.property_id, req.address);
  addNotification("✅", `Property delete approved: ${req.address}`);
  }
  const { data: { user } } = await supabase.auth.getUser();
  const { error: statusErr } = await supabase.from("property_change_requests").update({ status: "approved", reviewed_by: user?.email || "admin", reviewed_at: new Date().toISOString(), review_note: reviewNotes[req.id] || "" }).eq("company_id", companyId).eq("id", req.id);
  if (statusErr) showToast("Warning: Property was updated but the request status could not be marked as approved: " + statusErr.message, "error");
  logAudit("approve", "properties", `Approved ${req.request_type} request: ${req.address} (requested by ${req.requested_by})`, req.id, user?.email, "admin", companyId);
  setReviewNotes(prev => { const n = {...prev}; delete n[req.id]; return n; });
  fetchProperties();
  fetchChangeRequests();
  } finally { guardRelease("approveRequest"); }
  }

  // Admin: reject change request
  async function rejectRequest(req) {
  if (!guardSubmit("rejectRequest")) return;
  try {
  const { data: { user } } = await supabase.auth.getUser();
  const { error: rejStatusErr } = await supabase.from("property_change_requests").update({ status: "rejected", reviewed_by: user?.email || "admin", reviewed_at: new Date().toISOString(), review_note: reviewNotes[req.id] || "" }).eq("company_id", companyId).eq("id", req.id);
  if (rejStatusErr) showToast("Warning: Could not mark request as rejected: " + rejStatusErr.message, "error");
  addNotification("❌", `Property request rejected: ${req.address}`);
  logAudit("reject", "properties", `Rejected ${req.request_type} request: ${req.address} (requested by ${req.requested_by})`, req.id, user?.email, "admin", companyId);
  setReviewNotes(prev => { const n = {...prev}; delete n[req.id]; return n; });
  fetchChangeRequests();
  } finally { guardRelease("rejectRequest"); }
  }

  // Timeline (same as before)
  async function loadTimeline(p) {
  setTimelineProperty(p);
  const [pay, wo, docs] = await Promise.all([
  supabase.from("payments").select("*").eq("company_id", companyId).eq("property", p.address).is("archived_at", null).limit(200),
  supabase.from("work_orders").select("*").eq("company_id", companyId).eq("property", p.address).is("archived_at", null),
  supabase.from("documents").select("*").eq("company_id", companyId).eq("property", p.address).is("archived_at", null),
  ]);
  const all = [
  ...(pay.data || []).map(x => ({ ...x, _type: "payment", _date: x.date })),
  ...(wo.data || []).map(x => ({ ...x, _type: "work_order", _date: x.created })),
  ...(docs.data || []).map(x => ({ ...x, _type: "document", _date: x.created_at })),
  ].sort((a, b) => new Date(b._date) - new Date(a._date));
  setTimelineData(all);
  }

  async function assignPM(property) {
  if (!guardSubmit("assignPM")) return;
  try {
  if (!pmCode.trim()) { showToast("Please enter the PM company's 8-digit code.", "error"); return; }
  const { data: pmCompany } = await supabase.from("companies").select("id, name, company_role").eq("company_code", pmCode.trim()).maybeSingle();
  if (!pmCompany) { showToast("No company found with that code.", "error"); return; }
  if (pmCompany.company_role !== "management") { showToast(pmCompany.name + " is not a management company. Only management companies can be assigned as PM.", "error"); return; }
  // Check for existing pending or accepted assignment
  const { data: existingReq } = await supabase.from("pm_assignment_requests").select("id, status")
  .eq("owner_company_id", companyId).eq("pm_company_id", pmCompany.id).eq("property_id", property.id)
  .in("status", ["pending", "accepted"]).maybeSingle();
  if (existingReq?.status === "pending") { showToast("A request to assign " + pmCompany.name + " is already pending for this property.", "error"); return; }
  if (existingReq?.status === "accepted") { showToast(pmCompany.name + " is already assigned as PM for this property.", "error"); return; }
  // Also check if property already has this PM directly assigned
  if (property.pm_company_id === pmCompany.id) { showToast(pmCompany.name + " is already the property manager for this property.", "error"); return; }
  if (!await showConfirm({ message: "Request " + pmCompany.name + " to manage " + property.address + "?\n\nThey will need to accept before getting access to this property." })) return;
  // Create assignment REQUEST (not direct assignment)
  const { error: reqErr } = await supabase.from("pm_assignment_requests").insert([{
  owner_company_id: companyId,
  pm_company_id: pmCompany.id,
  pm_company_name: pmCompany.name,
  property_id: property.id,
  property_address: property.address,
  requested_by: normalizeEmail(userProfile?.email),
  }]);
  if (reqErr) { showToast("Error creating PM request: " + reqErr.message, "error"); return; }
  addNotification("📨", "PM assignment request sent to " + pmCompany.name + " for " + property.address);
  logAudit("create", "pm_requests", "Requested PM: " + pmCompany.name + " for " + property.address, property.id, userProfile?.email, userRole, companyId);
  setShowPmAssign(null);
  setPmCode("");
  fetchProperties();
  } finally { guardRelease("assignPM"); }
  }

  async function removePM(property) {
  if (!guardSubmit("removePM")) return;
  try {
  if (!await showConfirm({ message: "Remove " + (property.pm_company_name || "PM") + " as property manager for " + property.address + "?\n\nYou will regain full operational control.", variant: "danger", confirmText: "Delete" })) return;
  const { error: rmErr } = await supabase.from("properties").update({ pm_company_id: null, pm_company_name: null }).eq("id", property.id).eq("company_id", companyId);
  if (rmErr) { showToast("Error removing PM: " + rmErr.message, "error"); return; }
  addNotification("🏠", "PM removed from " + property.address + ". You now have full control.");
  logAudit("update", "properties", "Removed PM from " + property.address, property.id, userProfile?.email, userRole, companyId);
  fetchProperties();
  } finally { guardRelease("removePM"); }
  }

  // Check if current company is an owner company viewing a PM-managed property
  function isReadOnly(property) {
  // Property is read-only if its company_id differs from the active company
  // This makes PM-managed properties read-only for the PM, and owned properties editable for the owner
  return property.company_id !== (companyId);
  }

  const [viewMode, setViewMode] = useState("card");
  const [filterType, setFilterType] = useState("all");
  const [filterOwnership, setFilterOwnership] = useState("all");
  const [filterOwner, setFilterOwner] = useState("all");
  const [filterCity, setFilterCity] = useState("all");
  const [visibleCols, setVisibleCols] = useState(["address","type","status","rent","tenant","lease_end"]);
  const [showColPicker, setShowColPicker] = useState(false);
  const [showPmAssign, setShowPmAssign] = useState(null);
  const [showRecurringSetup, setShowRecurringSetup] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedProperties, setArchivedProperties] = useState([]); // { tenant, property, rent }
  const [showDocChecklist, setShowDocChecklist] = useState(null);
  const [showDocUpload, setShowDocUpload] = useState(null); // { property, tenant }
  const [showPropertyWizard, setShowPropertyWizard] = useState(null);
  const [selectedProperty, setSelectedProperty] = useState(null);
  const [propertyDetailTab, setPropertyDetailTab] = useState("overview");
  const [propertyDocs, setPropertyDocs] = useState([]);
  const [propertyWorkOrders, setPropertyWorkOrders] = useState([]);
  const [historicalTenants, setHistoricalTenants] = useState([]);
  const [propertyUtilities, setPropertyUtilities] = useState([]);
  const [propertyHoas, setPropertyHoas] = useState([]);
  const [propertyLoans, setPropertyLoans] = useState([]);
  const [propertyInsurance, setPropertyInsurance] = useState([]);
  const [propertyLicenses, setPropertyLicenses] = useState([]);
  const [showLicenseForm, setShowLicenseForm] = useState(null); // null | { license? , propertyId, propertyAddress }
  const [historicalTenantDetail, setHistoricalTenantDetail] = useState(null); // { tenant, ledger, docs, messages, leases, activeTab }
  const [pmCode, setPmCode] = useState("");
  const [incompleteWizards, setIncompleteWizards] = useState([]);
  const [allWizards, setAllWizards] = useState([]);

  // Fetch all wizards on load (in_progress + completed)
  useEffect(() => {
  supabase.from("property_setup_wizard").select("*").eq("company_id", companyId).in("status", ["in_progress", "completed"])
  .then(({ data }) => {
    const wizards = data || [];
    setAllWizards(wizards);
    setIncompleteWizards(wizards.filter(w => w.status === "in_progress"));
  });
  }, [companyId, showPropertyWizard]);

  // Calculate setup completeness for a property
  function getSetupStatus(property) {
    const wizard = allWizards.find(w => w.property_address === property.address);
    if (!wizard) return { wizard: null, completedSteps: [], missing: [], total: 0, completed: 0, isInProgress: false, isComplete: true };
    // If wizard was explicitly completed or dismissed, it's done
    if (wizard.status === "completed" || wizard.status === "dismissed") return { wizard, completedSteps: wizard.completed_steps || [], missing: [], total: 0, completed: 0, isInProgress: false, isComplete: true };
    const completedSteps = wizard.completed_steps || [];
    const isOccupied = property.status === "occupied";
    const optionalSteps = ["utilities", "hoa", "documents", "insurance"];
    if (isOccupied) optionalSteps.push("tenant_lease", "recurring_rent");
    if (userRole === "admin" || userRole === "owner") optionalSteps.push("loan");
    const missing = optionalSteps.filter(s => !completedSteps.includes(s));
    return { wizard, completedSteps, missing, total: optionalSteps.length, completed: optionalSteps.length - missing.length, isInProgress: true, isComplete: missing.length === 0 };
  }

  const allCols = [
  { id: "address", label: "Address" }, { id: "type", label: "Type" }, { id: "status", label: "Status" },
  { id: "rent", label: "Rent" }, { id: "tenant", label: "Tenant" }, { id: "lease_end", label: "Lease End" },
  { id: "notes", label: "Notes" }, { id: "owner_name", label: "Owner" },
  ];
  const propertyTypes = [...new Set(properties.map(p => p.type).filter(Boolean))];
  const propertyOwners = [...new Set(properties.map(p => p.owner_name).filter(Boolean))];
  const propertyCities = [...new Set(properties.map(p => {
  const parts = (p.address || "").split(",").map(s => s.trim());
  return parts.length >= 2 ? parts[parts.length - 2] : "";
  }).filter(Boolean))].sort();
  const hasManagedProps = properties.some(p => p._ownership === "managed");
  const pendingRequests = changeRequests.filter(r => r.status === "pending");

  if (loading) return <Spinner />;
  const filtered = properties.filter(p => {
  if (filter !== "all" && p.status !== filter) return false;
  if (filterType !== "all" && p.type !== filterType) return false;
  if (filterOwnership !== "all" && p._ownership !== filterOwnership) return false;
  if (filterOwner !== "all" && p.owner_name !== filterOwner) return false;
  if (filterCity !== "all") {
  const parts = (p.address || "").split(",").map(s => s.trim());
  const city = parts.length >= 2 ? parts[parts.length - 2] : "";
  if (city !== filterCity) return false;
  }
  const q = search.toLowerCase();
  if (q && !p.address?.toLowerCase().includes(q) && !p.type?.toLowerCase().includes(q) && !p.tenant?.toLowerCase()?.includes(q) && !p.owner_name?.toLowerCase()?.includes(q)) return false;
  return true;
  });

  return (
  <div>
  <div className="flex flex-col md:flex-row md:items-center justify-between mb-4 gap-2">
  <PageHeader title="Properties" />
  <div className="flex items-center gap-3">
  <Btn variant="secondary" onClick={exportProperties}><span className="material-icons-outlined text-sm align-middle mr-1">download</span>Export</Btn>
  <div className="flex gap-1">
  <button onClick={() => setShowArchived(false)} className={"px-3 py-1.5 text-xs font-medium rounded-lg " + (!showArchived ? "bg-brand-600 text-white" : "bg-subtle-100 text-subtle-600 hover:bg-subtle-200")}>Active ({properties.length})</button>
  <button onClick={() => { setShowArchived(true); fetchArchivedProperties(); }} className={"px-3 py-1.5 text-xs font-medium rounded-lg " + (showArchived ? "bg-brand-600 text-white" : "bg-subtle-100 text-subtle-600 hover:bg-subtle-200")}>Archived ({archivedProperties.length})</button>
  </div>
  </div>
  </div>

  {showArchived ? (
  <div>
  {archivedProperties.length === 0 ? (
  <div className="text-center py-12 bg-white rounded-xl border border-subtle-100"><div className="text-subtle-400">No archived properties</div></div>
  ) : (
  <div className="space-y-2">
  {archivedProperties.map(p => (
  <div key={p.id} className="bg-white rounded-xl border border-subtle-200 p-4 flex items-center gap-4 opacity-70">
  <div className="flex-1">
  <div className="font-semibold text-subtle-700 text-sm">{p.address}</div>
  <div className="text-xs text-subtle-400">Archived {p.archived_at ? new Date(p.archived_at).toLocaleDateString() : ""} by {p.archived_by || "unknown"}</div>
  <div className="text-xs text-warn-600 mt-1">{p.archived_at ? Math.max(0, 180 - Math.floor((Date.now() - new Date(p.archived_at)) / 86400000)) : "?"} days until auto-purge</div>
  </div>
  <button onClick={() => restoreProperty(p)} className="text-xs bg-success-50 text-success-700 px-3 py-1.5 rounded-lg hover:bg-success-100 border border-success-200">Restore</button>
  <button onClick={() => permanentDeleteProperty(p)} className="text-xs bg-danger-50 text-danger-600 px-3 py-1.5 rounded-lg hover:bg-danger-100 border border-danger-200">Delete Forever</button>
  </div>
  ))}
  </div>
  )}
  </div>
  ) : (<>

  {isAdmin && pendingRequests.length > 0 && (
  <div className="bg-warn-50 border border-warn-200 rounded-xl p-3 mb-4 flex items-center justify-between">
  <span className="text-sm text-warn-800">📋 <strong>{pendingRequests.length}</strong> property change {pendingRequests.length === 1 ? "request" : "requests"} awaiting review</span>
  <button onClick={() => setShowRequests(!showRequests)} className="text-xs bg-warn-200 text-warn-800 px-3 py-1.5 rounded-lg font-medium hover:bg-warn-300">{showRequests ? "Hide" : "Review"}</button>
  </div>
  )}
  {!isAdmin && changeRequests.filter(r => r.status === "pending").length > 0 && (
  <div className="bg-info-50 border border-info-200 rounded-xl p-3 mb-4">
  <span className="text-sm text-info-800">📋 You have <strong>{changeRequests.filter(r => r.status === "pending").length}</strong> pending request(s)</span>
  </div>
  )}

  {isAdmin && showRequests && pendingRequests.length > 0 && (
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-4 mb-4 space-y-3">
  <h3 className="font-semibold text-neutral-800">Pending Approval</h3>
  {pendingRequests.map(req => (
  <div key={req.id} className="border border-warn-100 rounded-3xl p-4 bg-warn-50/30">
  <div className="flex items-start justify-between gap-3">
  <div>
  <div className="flex items-center gap-2 mb-1">
  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${req.request_type === "add" ? "bg-success-100 text-success-700" : "bg-info-100 text-info-700"}`}>{req.request_type === "add" ? "New" : "Edit"}</span>
  <span className="text-xs text-neutral-400">by {req.requested_by}</span>
  </div>
  <p className="font-semibold text-neutral-800">{req.address}</p>
  <p className="text-xs text-neutral-400 mt-1">{req.type} · ${req.rent}/mo</p>
  </div>
  <div className="flex flex-col gap-2 shrink-0">
  <Input value={reviewNotes[req.id] || ""} onChange={e => setReviewNotes(prev => ({...prev, [req.id]: e.target.value}))} placeholder="Note" className="text-xs w-32" />
  <div className="flex gap-1">
  <Btn variant="success-fill" size="sm" onClick={() => approveRequest(req)}>✓ Approve</Btn>
  <Btn variant="danger-fill" size="sm" onClick={() => rejectRequest(req)}>✕ Reject</Btn>
  </div>
  </div>
  </div>
  </div>
  ))}
  </div>
  )}

  <div className="flex items-center gap-2 mb-4 flex-wrap">
  <Input placeholder="Search properties..." value={search} onChange={e => setSearch(e.target.value)} className="w-64" />
  <Select filter value={filter} onChange={e => setFilter(e.target.value)} className="w-auto text-sm" >
  <option value="all">All Status</option><option value="occupied">Occupied</option><option value="vacant">Vacant</option><option value="maintenance">Maintenance</option>
  </Select>
  <Select filter value={filterType} onChange={e => setFilterType(e.target.value)} className="w-auto text-sm" >
  <option value="all">All Types</option>
  {propertyTypes.map(t => <option key={t} value={t}>{t}</option>)}
  </Select>
  {hasManagedProps && (
  <Select filter value={filterOwnership} onChange={e => setFilterOwnership(e.target.value)} className="w-auto text-sm" >
  <option value="all">All Properties</option>
  <option value="owned">Owned by Us</option>
  <option value="managed">PM-Managed</option>
  </Select>
  )}
  {propertyOwners.length > 1 && (
  <Select filter value={filterOwner} onChange={e => setFilterOwner(e.target.value)} className="w-auto text-sm" >
  <option value="all">All Owners</option>
  {propertyOwners.map(o => <option key={o} value={o}>{o}</option>)}
  </Select>
  )}
  {propertyCities.length > 1 && (
  <Select filter value={filterCity} onChange={e => setFilterCity(e.target.value)} className="w-auto text-sm" >
  <option value="all">All Cities</option>
  {propertyCities.map(c => <option key={c} value={c}>{c}</option>)}
  </Select>
  )}
  <div className="flex bg-brand-50 rounded-xl p-0.5">
  {[["card","▦"],["table","☰"],["compact","≡"]].map(([m,icon]) => (
  <button key={m} onClick={() => setViewMode(m)} className={`px-2 py-1 text-sm rounded-md ${viewMode === m ? "bg-white shadow-sm text-brand-700 font-semibold" : "text-neutral-400"}`} title={m}>{icon}</button>
  ))}
  </div>
  {viewMode === "table" && (
  <div className="relative">
  <button onClick={() => setShowColPicker(!showColPicker)} className="border border-brand-100 rounded-xl px-3 py-1.5 text-xs text-neutral-400 hover:bg-brand-50/30">⚙️ Columns</button>
  {showColPicker && (
  <div className="absolute right-0 top-10 bg-white border border-brand-100 rounded-3xl shadow-lg p-3 z-50 w-48 max-w-[calc(100vw-2rem)]">
  {allCols.map(c => (
  <label key={c.id} className="flex items-center gap-2 py-1 text-xs text-neutral-700 cursor-pointer">
  <input type="checkbox" checked={visibleCols.includes(c.id)} onChange={() => setVisibleCols(prev => prev.includes(c.id) ? prev.filter(x => x !== c.id) : [...prev, c.id])} className="rounded" />
  {c.label}
  </label>
  ))}
  </div>
  )}
  </div>
  )}
  <Btn onClick={() => { setShowPropertyWizard({ propertyId: null, address: "", isOccupied: false, tenant: "", rent: 0, isNew: true }); }} >
  + Add
  </Btn>
  </div>

  {/* ===== PROPERTY DETAIL PANEL ===== */}
  {selectedProperty && (
  <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex justify-end">
  <div className="bg-white w-full max-w-lg h-full flex flex-col shadow-2xl overflow-y-auto">
  {/* Header */}
  <div className={"p-6 text-white " + (selectedProperty.status === "occupied" ? "bg-gradient-to-r from-success-600 to-success-800" : selectedProperty.status === "vacant" ? "bg-gradient-to-r from-warn-500 to-warn-700" : "bg-gradient-to-r from-subtle-600 to-subtle-800")}>
  <div className="flex items-center justify-between">
  <div>
  <h2 className="text-lg font-bold">{selectedProperty.address_line_1 || selectedProperty.address}</h2>
  <div className="text-sm opacity-80">{[selectedProperty.city, selectedProperty.state, selectedProperty.zip].filter(Boolean).join(", ")}</div>
  {selectedProperty.address_line_2 && <div className="text-xs opacity-60">{selectedProperty.address_line_2}</div>}
  </div>
  <IconBtn icon="close" onClick={() => setSelectedProperty(null)} className="text-white/70 hover:text-white" />
  </div>
  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
  <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs opacity-70">Status</div><div className="text-sm font-bold capitalize">{selectedProperty.status}</div></div>
  <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs opacity-70">Type</div><div className="text-sm font-bold">{selectedProperty.type}</div></div>
  <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs opacity-70">Rent</div><div className="text-sm font-bold">{selectedProperty.rent ? "$" + safeNum(selectedProperty.rent).toLocaleString() : "—"}</div></div>
  <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs opacity-70">Lease End</div><div className="text-sm font-bold">{selectedProperty.lease_end || "—"}</div></div>
  </div>
  </div>

  {/* Tenant Info */}
  {selectedProperty.tenant && (
  <div className="px-6 py-4 border-b border-brand-50">
  <div className="text-xs font-semibold text-neutral-400 uppercase mb-2">Current Tenant{(selectedProperty.tenant_2 || selectedProperty.tenant_3 || selectedProperty.tenant_4 || selectedProperty.tenant_5) ? "s" : ""}</div>
  <div className="flex items-center gap-3">
  <div className="w-10 h-10 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 font-bold">{selectedProperty.tenant?.[0]}</div>
  <div>
  <div className="font-semibold text-neutral-800">{selectedProperty.tenant}</div>
  <div className="text-xs text-neutral-400">{selectedProperty._tenantEmail || ""} · {selectedProperty._tenantPhone || ""}</div>
  </div>
  </div>
  {selectedProperty.tenant_2 && (
  <div className="flex items-center gap-3 mt-2">
  <div className="w-10 h-10 rounded-full bg-brand-50 flex items-center justify-center text-brand-500 font-bold text-sm">{selectedProperty.tenant_2?.[0]}</div>
  <div>
  <div className="font-medium text-neutral-700 text-sm">{selectedProperty.tenant_2}</div>
  <div className="text-xs text-neutral-400">{selectedProperty.tenant_2_email || ""} · {selectedProperty.tenant_2_phone || ""}</div>
  </div>
  </div>
  )}
  {selectedProperty.tenant_3 && (
  <div className="flex items-center gap-3 mt-2">
  <div className="w-10 h-10 rounded-full bg-brand-50 flex items-center justify-center text-brand-500 font-bold text-sm">{selectedProperty.tenant_3?.[0]}</div>
  <div>
  <div className="font-medium text-neutral-700 text-sm">{selectedProperty.tenant_3}</div>
  <div className="text-xs text-neutral-400">{selectedProperty.tenant_3_email || ""} · {selectedProperty.tenant_3_phone || ""}</div>
  </div>
  </div>
  )}
  {selectedProperty.tenant_4 && (
  <div className="flex items-center gap-3 mt-2">
  <div className="w-10 h-10 rounded-full bg-brand-50 flex items-center justify-center text-brand-500 font-bold text-sm">{selectedProperty.tenant_4?.[0]}</div>
  <div>
  <div className="font-medium text-neutral-700 text-sm">{selectedProperty.tenant_4}</div>
  <div className="text-xs text-neutral-400">{selectedProperty.tenant_4_email || ""} · {selectedProperty.tenant_4_phone || ""}</div>
  </div>
  </div>
  )}
  {selectedProperty.tenant_5 && (
  <div className="flex items-center gap-3 mt-2">
  <div className="w-10 h-10 rounded-full bg-brand-50 flex items-center justify-center text-brand-500 font-bold text-sm">{selectedProperty.tenant_5?.[0]}</div>
  <div>
  <div className="font-medium text-neutral-700 text-sm">{selectedProperty.tenant_5}</div>
  <div className="text-xs text-neutral-400">{selectedProperty.tenant_5_email || ""} · {selectedProperty.tenant_5_phone || ""}</div>
  </div>
  </div>
  )}
  </div>
  )}

  {/* Tab Navigation */}
  <div className="flex border-b border-neutral-200 px-6 overflow-x-auto">
  {[["overview","Details"],["documents","Documents"],["licenses","Licenses"],["workorders","Work Orders"],["history","History"]].map(([id, label]) => (
  <button key={id} onClick={() => { setPropertyDetailTab(id); if (id === "history") setHistoricalTenantDetail(null); }} className={"px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap " + (propertyDetailTab === id ? "border-brand-600 text-brand-700" : "border-transparent text-neutral-400 hover:text-neutral-500")}>{label}{id === "documents" ? ` (${propertyDocs.length})` : id === "licenses" ? ` (${propertyLicenses.length})` : id === "workorders" ? ` (${propertyWorkOrders.length})` : id === "history" ? ` (${historicalTenants.length})` : ""}</button>
  ))}
  </div>

  {/* Details Tab — comprehensive property info */}
  {propertyDetailTab === "overview" && (
  <div className="px-6 py-4 space-y-4">

  {/* Quick Actions */}
  <div className="flex gap-2">
  {!isReadOnly(selectedProperty) && <Btn variant="primary" size="sm" onClick={() => { setShowPropertyWizard({ propertyId: selectedProperty.id, address: selectedProperty.address, isOccupied: selectedProperty.status === "occupied", tenant: selectedProperty.tenant || "", rent: Number(selectedProperty.rent) || 0, leaseStart: selectedProperty.lease_start || "", leaseEnd: selectedProperty.lease_end || "", securityDeposit: Number(selectedProperty.security_deposit) || 0, isEdit: true }); setSelectedProperty(null); }}><span className="material-icons-outlined text-sm">edit</span>Edit Setup</Btn>}
  <Btn variant="secondary" size="sm" onClick={() => setShowDocUpload({ property: selectedProperty.address, tenant: selectedProperty.tenant || "" })}><span className="material-icons-outlined text-sm">upload_file</span>Upload Doc</Btn>
  <Btn variant="secondary" size="sm" onClick={() => { setPage("maintenance"); setSelectedProperty(null); }}><span className="material-icons-outlined text-sm">build</span>Work Order</Btn>
  </div>

  {/* Lease & Financials */}
  {selectedProperty.status === "occupied" && (
  <div className="bg-neutral-50 rounded-xl p-4">
  <div className="text-xs font-semibold text-neutral-400 uppercase mb-3">Lease & Financials</div>
  <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
  <div><span className="text-neutral-400 text-xs">Monthly Rent</span><div className="font-semibold text-neutral-800">{formatCurrency(selectedProperty.rent)}</div></div>
  <div><span className="text-neutral-400 text-xs">Security Deposit</span><div className="font-semibold text-neutral-800">{selectedProperty.security_deposit ? formatCurrency(selectedProperty.security_deposit) : "—"}</div></div>
  <div><span className="text-neutral-400 text-xs">Lease Start</span><div className="font-medium text-neutral-700">{selectedProperty.lease_start || "—"}</div></div>
  <div><span className="text-neutral-400 text-xs">Lease End</span><div className="font-medium text-neutral-700">{selectedProperty.lease_end || "—"}</div></div>
  </div>
  </div>
  )}

  {/* Utilities */}
  <div className="bg-neutral-50 rounded-xl p-4">
  <div className="text-xs font-semibold text-neutral-400 uppercase mb-3 flex items-center justify-between"><div className="flex items-center gap-1"><span className="material-icons-outlined text-sm">bolt</span>Utilities</div>{!isReadOnly(selectedProperty) && <button onClick={() => { setShowPropertyWizard({ propertyId: selectedProperty.id, address: selectedProperty.address, isOccupied: selectedProperty.status === "occupied", tenant: selectedProperty.tenant || "", rent: Number(selectedProperty.rent) || 0, isEdit: true }); setSelectedProperty(null); }} className="text-xs text-brand-600 hover:underline">Edit</button>}</div>
  {propertyUtilities.length === 0 ? <p className="text-xs text-neutral-400">No utilities configured</p> : (
  <div className="space-y-2">
  {propertyUtilities.map((u, i) => (
  <div key={u.id || i} className="flex items-center justify-between text-sm">
  <div className="flex items-center gap-2">
  <span className="text-xs bg-brand-50 text-brand-700 px-2 py-0.5 rounded-full font-medium">{u.type || "Other"}</span>
  <span className="text-neutral-700">{u.provider}</span>
  </div>
  <span className="text-xs text-neutral-400">{u.responsibility === "tenant_pays" ? "Tenant pays" : "Owner pays"}{u.due_date ? " · Due " + u.due_date : ""}</span>
  </div>
  ))}
  </div>
  )}
  </div>

  {/* HOA */}
  <div className="bg-neutral-50 rounded-xl p-4">
  <div className="text-xs font-semibold text-neutral-400 uppercase mb-3 flex items-center justify-between"><div className="flex items-center gap-1"><span className="material-icons-outlined text-sm">holiday_village</span>HOA</div>{!isReadOnly(selectedProperty) && <button onClick={() => { setShowPropertyWizard({ propertyId: selectedProperty.id, address: selectedProperty.address, isOccupied: selectedProperty.status === "occupied", tenant: selectedProperty.tenant || "", rent: Number(selectedProperty.rent) || 0, isEdit: true }); setSelectedProperty(null); }} className="text-xs text-brand-600 hover:underline">Edit</button>}</div>
  {propertyHoas.length === 0 ? <p className="text-xs text-neutral-400">No HOA</p> : (
  <div className="space-y-2">
  {propertyHoas.map((h, i) => (
  <div key={h.id || i} className="flex items-center justify-between text-sm">
  <span className="text-neutral-700 font-medium">{h.hoa_name || h.name}</span>
  <span className="text-neutral-500">{formatCurrency(h.amount)} · {h.frequency || "Monthly"}</span>
  </div>
  ))}
  </div>
  )}
  </div>

  {/* Loans — admin/owner only */}
  {(userRole === "admin" || userRole === "owner") && (
  <div className="bg-neutral-50 rounded-xl p-4">
  <div className="text-xs font-semibold text-neutral-400 uppercase mb-3 flex items-center justify-between"><div className="flex items-center gap-1"><span className="material-icons-outlined text-sm">account_balance</span>Loan / Mortgage</div>{!isReadOnly(selectedProperty) && <button onClick={() => { setShowPropertyWizard({ propertyId: selectedProperty.id, address: selectedProperty.address, isOccupied: selectedProperty.status === "occupied", tenant: selectedProperty.tenant || "", rent: Number(selectedProperty.rent) || 0, isEdit: true }); setSelectedProperty(null); }} className="text-xs text-brand-600 hover:underline">Edit</button>}</div>
  {propertyLoans.length === 0 ? <p className="text-xs text-neutral-400">No loan configured</p> : (
  <div className="space-y-2">
  {propertyLoans.map((l, i) => (
  <div key={l.id || i} className="text-sm">
  <div className="flex items-center justify-between">
  <span className="text-neutral-700 font-medium">{l.lender_name}</span>
  <span className="text-xs bg-neutral-200 text-neutral-600 px-2 py-0.5 rounded-full">{l.loan_type || "Conventional"}</span>
  </div>
  <div className="grid grid-cols-3 gap-2 mt-2 text-xs text-neutral-500">
  <div><span className="block text-neutral-400">Payment</span>{l.monthly_payment ? formatCurrency(l.monthly_payment) : "—"}</div>
  <div><span className="block text-neutral-400">Balance</span>{l.current_balance ? formatCurrency(l.current_balance) : "—"}</div>
  <div><span className="block text-neutral-400">Rate</span>{l.interest_rate ? l.interest_rate + "%" : "—"}</div>
  </div>
  </div>
  ))}
  </div>
  )}
  </div>
  )}

  {/* Insurance */}
  <div className="bg-neutral-50 rounded-xl p-4">
  <div className="text-xs font-semibold text-neutral-400 uppercase mb-3 flex items-center justify-between"><div className="flex items-center gap-1"><span className="material-icons-outlined text-sm">verified_user</span>Insurance</div>{!isReadOnly(selectedProperty) && <button onClick={() => { setShowPropertyWizard({ propertyId: selectedProperty.id, address: selectedProperty.address, isOccupied: selectedProperty.status === "occupied", tenant: selectedProperty.tenant || "", rent: Number(selectedProperty.rent) || 0, isEdit: true }); setSelectedProperty(null); }} className="text-xs text-brand-600 hover:underline">Edit</button>}</div>
  {propertyInsurance.length === 0 ? <p className="text-xs text-neutral-400">No insurance configured</p> : (
  <div className="space-y-2">
  {propertyInsurance.map((ins, i) => (
  <div key={ins.id || i} className="flex items-center justify-between text-sm">
  <div>
  <span className="text-neutral-700 font-medium">{ins.provider}</span>
  {ins.policy_number && <span className="text-xs text-neutral-400 ml-2">#{ins.policy_number}</span>}
  </div>
  <div className="text-right text-xs text-neutral-500">
  {ins.premium_amount ? formatCurrency(ins.premium_amount) + "/" + (ins.premium_frequency || "year").toLowerCase().slice(0, 3) : "—"}
  {ins.expiration_date && <div className={new Date(ins.expiration_date) < new Date() ? "text-danger-500 font-medium" : ""}>{ins.expiration_date < new Date().toISOString().slice(0, 10) ? "Expired " : "Exp "}{ins.expiration_date}</div>}
  </div>
  </div>
  ))}
  </div>
  )}
  </div>

  {/* Property Manager & Notes */}
  {(selectedProperty.pm_company_name || selectedProperty.notes) && (
  <div className="bg-neutral-50 rounded-xl p-4">
  {selectedProperty.pm_company_name && <div className="text-sm mb-2"><span className="text-neutral-400 text-xs block">Property Manager</span><span className="font-semibold text-highlight-700">{selectedProperty.pm_company_name}</span></div>}
  {selectedProperty.notes && <div className="text-sm"><span className="text-neutral-400 text-xs block">Notes</span><span className="text-neutral-500">{selectedProperty.notes}</span></div>}
  </div>
  )}

  </div>
  )}

  {/* Documents Tab */}
  {propertyDetailTab === "documents" && (
  <div className="px-6 py-4 flex-1">
  <div className="flex items-center justify-between mb-3">
  <div className="text-sm font-semibold text-neutral-700">Documents</div>
  <Btn variant="primary" size="sm" onClick={() => setShowDocUpload({ property: selectedProperty.address, tenant: selectedProperty.tenant || "" })}><span className="material-icons-outlined text-sm">upload</span>Upload</Btn>
  </div>
  {propertyDocs.length === 0 ? (
  <div className="text-center py-8">
  <span className="material-icons-outlined text-4xl text-neutral-300 mb-2">folder_open</span>
  <div className="text-sm text-neutral-400">No documents uploaded yet</div>
  <button onClick={() => setShowDocUpload({ property: selectedProperty.address, tenant: selectedProperty.tenant || "" })} className="mt-3 text-xs text-brand-600 hover:underline">Upload your first document</button>
  </div>
  ) : (
  <div className="space-y-2">
  {propertyDocs.map(d => (
  <div key={d.id} className="flex items-center justify-between bg-neutral-50 rounded-lg px-4 py-3 hover:bg-neutral-100 transition-colors">
  <div className="flex items-center gap-3">
  <span className="material-icons-outlined text-neutral-400 text-lg">{d.type === "Lease" ? "description" : d.type === "ID" ? "badge" : d.type === "Insurance" ? "verified_user" : d.type === "Inspection" ? "search" : "insert_drive_file"}</span>
  <div>
  <div className="text-sm font-medium text-neutral-700">{d.name}</div>
  <div className="text-xs text-neutral-400">{d.type} · {d.uploaded_at?.slice(0, 10)}{d.tenant ? " · " + d.tenant : ""}{d.archived_by ? " · deleted by " + d.archived_by : ""}</div>
  </div>
  </div>
  <div className="flex items-center gap-2">
  <button onClick={async () => { const url = await getSignedUrl("documents", d.file_name || d.url); if (url) window.open(url, "_blank", "noopener,noreferrer"); }} className="text-xs text-brand-600 hover:underline flex items-center gap-1"><span className="material-icons-outlined text-sm">open_in_new</span>View</button>
  <button onClick={async () => {
  if (!guardSubmit("delPropDoc", d.id)) return;
  try {
  if (!await showConfirm({ message: `Delete document "${d.name}"?\n\nThis will remove the document from active views. It can be recovered within 180 days.`, variant: "danger", confirmText: "Delete" })) return;
  const { error } = await supabase.from("documents").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email }).eq("id", d.id).eq("company_id", companyId);
  if (error) { pmError("PM-7004", { raw: error, context: "delete document" }); return; }
  showToast("Document deleted: " + d.name, "success");
  logAudit("delete", "documents", "Deleted document: " + d.name, d.id, userProfile?.email, userRole, companyId);
  const { data: refreshed } = await supabase.from("documents").select("*").eq("company_id", companyId).eq("property", selectedProperty.address).is("archived_at", null).order("uploaded_at", { ascending: false }).limit(100);
  setPropertyDocs(refreshed || []);
  } finally { guardRelease("delPropDoc", d.id); }
  }} className="text-xs text-danger-400 hover:text-danger-600 flex items-center gap-0.5"><span className="material-icons-outlined text-sm">delete</span></button>
  </div>
  </div>
  ))}
  </div>
  )}
  </div>
  )}

  {/* Licenses Tab */}
  {propertyDetailTab === "licenses" && (
  <div className="px-6 py-4">
  <div className="flex items-center justify-between mb-3">
  <div>
  <div className="text-sm font-semibold text-neutral-700">Rental Licenses & Permits</div>
  <div className="text-xs text-neutral-400 mt-0.5">Track license numbers, jurisdictions, and expiry dates</div>
  </div>
  <Btn variant="primary" size="sm" onClick={() => setShowLicenseForm({ propertyId: selectedProperty.id, propertyAddress: selectedProperty.address })}><span className="material-icons-outlined text-sm">add</span>Add License</Btn>
  </div>
  {propertyLicenses.length === 0 ? (
  <div className="text-center py-8">
  <span className="material-icons-outlined text-4xl text-neutral-300 mb-2">verified</span>
  <div className="text-sm text-neutral-400">No licenses on file</div>
  <div className="text-xs text-neutral-400 mt-1">Add rental licenses, lead paint certs, fire inspections, etc.</div>
  </div>
  ) : (
  <div className="space-y-2">
  {propertyLicenses.map(lic => {
  const today = new Date();
  const expiry = new Date(lic.expiry_date + "T00:00:00");
  const daysLeft = Math.floor((expiry - today) / 86400000);
  const isExpired = daysLeft < 0;
  const isUrgent = daysLeft >= 0 && daysLeft <= 30;
  const isSoon = daysLeft > 30 && daysLeft <= 90;
  const badgeColor = isExpired ? "bg-danger-100 text-danger-700 border-danger-200"
    : isUrgent ? "bg-amber-100 text-amber-700 border-amber-200"
    : isSoon ? "bg-yellow-50 text-yellow-700 border-yellow-200"
    : "bg-emerald-50 text-emerald-700 border-emerald-200";
  const statusLabel = isExpired ? `Expired ${-daysLeft}d ago` : daysLeft === 0 ? "Expires today" : `${daysLeft}d left`;
  const typeLabel = LICENSE_TYPE_LABELS[lic.license_type] || lic.license_type_custom || lic.license_type;
  return (
  <div key={lic.id} className="flex items-center justify-between bg-neutral-50 rounded-lg px-4 py-3">
  <div className="flex-1 min-w-0">
  <div className="flex items-center gap-2 flex-wrap">
  <div className="text-sm font-medium text-neutral-700">{typeLabel}</div>
  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${badgeColor}`}>{statusLabel}</span>
  {lic.status === "pending_renewal" && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-brand-50 text-brand-700 border-brand-200">Renewal filed</span>}
  </div>
  <div className="text-xs text-neutral-400 mt-0.5">
  {lic.license_number && <span>#{lic.license_number}</span>}
  {lic.jurisdiction && <span>{lic.license_number ? " · " : ""}{lic.jurisdiction}</span>}
  <span>{(lic.license_number || lic.jurisdiction) ? " · " : ""}Expires {lic.expiry_date}</span>
  </div>
  </div>
  <div className="flex items-center gap-2 shrink-0">
  {lic.status !== "pending_renewal" && !isExpired && (
  <button onClick={async () => {
  if (!guardSubmit("licRenew", lic.id)) return;
  try {
  const { error } = await supabase.from("property_licenses").update({ status: "pending_renewal" }).eq("id", lic.id).eq("company_id", companyId);
  if (error) { pmError("PM-2002", { raw: error, context: "license mark pending renewal" }); return; }
  showToast("Marked as pending renewal", "success");
  logAudit("update", "property_licenses", `Marked license pending renewal: ${typeLabel}`, lic.id, userProfile?.email, userRole, companyId);
  setPropertyLicenses(propertyLicenses.map(l => l.id === lic.id ? { ...l, status: "pending_renewal" } : l));
  } finally { guardRelease("licRenew", lic.id); }
  }} className="text-xs text-brand-600 hover:underline" title="Mark as pending renewal">Renew</button>
  )}
  <button onClick={() => setShowLicenseForm({ license: lic, propertyId: selectedProperty.id, propertyAddress: selectedProperty.address })} className="text-xs text-neutral-500 hover:text-neutral-700 flex items-center gap-0.5"><span className="material-icons-outlined text-sm">edit</span>Edit</button>
  <button onClick={async () => {
  if (!guardSubmit("licDel", lic.id)) return;
  try {
  if (!await showConfirm({ message: `Archive license "${typeLabel}"?\n\nIt can be restored within 180 days.`, variant: "danger", confirmText: "Archive" })) return;
  const { error } = await supabase.from("property_licenses").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email }).eq("id", lic.id).eq("company_id", companyId);
  if (error) { pmError("PM-2003", { raw: error, context: "license archive" }); return; }
  showToast("License archived", "success");
  logAudit("delete", "property_licenses", `Archived license: ${typeLabel}`, lic.id, userProfile?.email, userRole, companyId);
  setPropertyLicenses(propertyLicenses.filter(l => l.id !== lic.id));
  } finally { guardRelease("licDel", lic.id); }
  }} className="text-xs text-danger-500 hover:text-danger-600 flex items-center gap-0.5"><span className="material-icons-outlined text-sm">delete</span>Archive</button>
  </div>
  </div>
  );
  })}
  </div>
  )}
  </div>
  )}

  {/* Work Orders Tab */}
  {propertyDetailTab === "workorders" && (
  <div className="px-6 py-4">
  <div className="flex items-center justify-between mb-3">
  <div className="text-sm font-semibold text-neutral-700">Work Orders</div>
  <Btn variant="primary" size="sm" onClick={() => { setPage("maintenance"); setSelectedProperty(null); }}><span className="material-icons-outlined text-sm">add</span>New</Btn>
  </div>
  {propertyWorkOrders.length === 0 ? (
  <div className="text-center py-8">
  <span className="material-icons-outlined text-4xl text-neutral-300 mb-2">build</span>
  <div className="text-sm text-neutral-400">No work orders</div>
  </div>
  ) : (
  <div className="space-y-2">
  {propertyWorkOrders.map(w => (
  <div key={w.id} className="flex items-center justify-between bg-neutral-50 rounded-lg px-4 py-3">
  <div><div className="text-sm font-medium text-neutral-700">{w.issue}</div><div className="text-xs text-neutral-400">{w.priority} · {w.created}</div></div>
  <Badge status={w.status} />
  </div>
  ))}
  </div>
  )}
  </div>
  )}

  {/* Historical Tenants Tab */}
  {propertyDetailTab === "history" && !historicalTenantDetail && (
  <div className="px-6 py-4 flex-1">
  <div className="text-sm font-semibold text-neutral-700 mb-3">Previous Tenants</div>
  {historicalTenants.length === 0 ? (
  <div className="text-center py-8">
  <span className="material-icons-outlined text-4xl text-neutral-300 mb-2">history</span>
  <div className="text-sm text-neutral-400">No previous tenants at this property</div>
  </div>
  ) : (
  <div className="space-y-3">
  {historicalTenants.map((t, i) => {
  const lease = t._leases?.[0];
  return (
  <div key={t.id || i} onClick={async () => {
  // Fetch full detail for this historical tenant
  const [ledgerRes, docsRes, msgsRes] = await Promise.all([
  t.id ? supabase.from("ledger_entries").select("*").eq("company_id", companyId).ilike("tenant", t.name).order("date", { ascending: false }).limit(200) : Promise.resolve({ data: [] }),
  supabase.from("documents").select("*").eq("company_id", companyId).ilike("tenant", t.name).order("uploaded_at", { ascending: false }).limit(100),
  supabase.from("messages").select("*").eq("company_id", companyId).ilike("tenant", t.name).order("created_at", { ascending: true }).limit(100),
  ]);
  setHistoricalTenantDetail({ tenant: t, ledger: ledgerRes.data || [], docs: docsRes.data || [], messages: msgsRes.data || [], leases: t._leases || [], activeTab: "overview" });
  }} className="bg-white border border-neutral-200 rounded-xl p-4 cursor-pointer hover:border-brand-300 hover:shadow-sm transition-all">
  <div className="flex items-center justify-between mb-2">
  <div className="flex items-center gap-3">
  <div className="w-10 h-10 rounded-full bg-neutral-200 flex items-center justify-center text-neutral-500 font-bold">{t.name?.[0]}</div>
  <div>
  <div className="font-semibold text-neutral-800">{t.name}</div>
  <div className="text-xs text-neutral-400">{t.email || ""}{t.phone ? " · " + t.phone : ""}</div>
  </div>
  </div>
  <span className="text-xs bg-neutral-100 text-neutral-500 px-2 py-1 rounded-full">{lease?.status || t.lease_status || "archived"}</span>
  </div>
  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
  <div><span className="text-neutral-400 block">Move In</span><span className="font-medium text-neutral-700">{lease?.start_date || t.lease_start || t.move_in || "—"}</span></div>
  <div><span className="text-neutral-400 block">Move Out</span><span className="font-medium text-neutral-700">{lease?.end_date || t.move_out || "—"}</span></div>
  <div><span className="text-neutral-400 block">Rent</span><span className="font-medium text-neutral-700">{lease?.rent_amount ? formatCurrency(lease.rent_amount) : t.rent ? formatCurrency(t.rent) : "—"}</span></div>
  <div><span className="text-neutral-400 block">Deposit</span><span className="font-medium text-neutral-700">{lease?.security_deposit ? formatCurrency(lease.security_deposit) : "—"}{lease?.deposit_status ? " · " + lease.deposit_status : ""}</span></div>
  </div>
  {t.archived_at && <div className="text-xs text-neutral-400 mt-2">Archived {new Date(t.archived_at).toLocaleDateString()}{t.archived_by ? " by " + t.archived_by : ""}</div>}
  </div>
  );
  })}
  </div>
  )}
  </div>
  )}

  {/* Historical Tenant Detail View */}
  {propertyDetailTab === "history" && historicalTenantDetail && (
  <div className="px-6 py-4 flex-1">
  <button onClick={() => setHistoricalTenantDetail(null)} className="text-xs text-brand-600 hover:underline mb-3 flex items-center gap-1"><span className="material-icons-outlined text-sm">arrow_back</span>Back to Previous Tenants</button>
  <div className="flex items-center gap-3 mb-4">
  <div className="w-12 h-12 rounded-full bg-neutral-200 flex items-center justify-center text-neutral-500 font-bold text-lg">{historicalTenantDetail.tenant.name?.[0]}</div>
  <div>
  <div className="font-bold text-neutral-800 text-lg">{historicalTenantDetail.tenant.name}</div>
  <div className="text-xs text-neutral-400">{historicalTenantDetail.tenant.email || ""}{historicalTenantDetail.tenant.phone ? " · " + historicalTenantDetail.tenant.phone : ""}</div>
  </div>
  </div>
  {/* Sub-tabs */}
  <div className="flex border-b border-neutral-200 mb-4">
  {[["overview","Overview"],["ledger","Ledger"],["docs","Documents"],["messages","Messages"]].map(([id, label]) => (
  <button key={id} onClick={() => setHistoricalTenantDetail(prev => ({ ...prev, activeTab: id }))} className={"px-3 py-2 text-xs font-medium border-b-2 whitespace-nowrap " + (historicalTenantDetail.activeTab === id ? "border-brand-600 text-brand-700" : "border-transparent text-neutral-400 hover:text-neutral-500")}>{label}{id === "ledger" ? ` (${historicalTenantDetail.ledger.length})` : id === "docs" ? ` (${historicalTenantDetail.docs.length})` : ""}</button>
  ))}
  </div>

  {/* Overview */}
  {historicalTenantDetail.activeTab === "overview" && (
  <div>
  {historicalTenantDetail.leases.length > 0 && (
  <div className="mb-4">
  <div className="text-xs font-semibold text-neutral-400 uppercase mb-2">Lease History</div>
  {historicalTenantDetail.leases.map((l, i) => (
  <div key={l.id || i} className="bg-neutral-50 rounded-lg p-3 mb-2">
  <div className="grid grid-cols-2 gap-2 text-xs">
  <div><span className="text-neutral-400 block">Period</span><span className="font-medium text-neutral-700">{l.start_date || "—"} → {l.end_date || "—"}</span></div>
  <div><span className="text-neutral-400 block">Status</span><span className="font-medium text-neutral-700 capitalize">{l.status}</span></div>
  <div><span className="text-neutral-400 block">Rent</span><span className="font-medium text-neutral-700">{l.rent_amount ? formatCurrency(l.rent_amount) : "—"}</span></div>
  <div><span className="text-neutral-400 block">Security Deposit</span><span className="font-medium text-neutral-700">{l.security_deposit ? formatCurrency(l.security_deposit) : "—"}{l.deposit_status ? " · " + l.deposit_status : ""}</span></div>
  {l.deposit_returned > 0 && <div><span className="text-neutral-400 block">Deposit Returned</span><span className="font-medium text-positive-600">{formatCurrency(l.deposit_returned)}</span></div>}
  {l.deposit_deductions && <div className="col-span-2"><span className="text-neutral-400 block">Deductions</span><span className="font-medium text-neutral-700">{l.deposit_deductions}</span></div>}
  </div>
  </div>
  ))}
  </div>
  )}
  <div className="grid grid-cols-2 gap-3 text-xs">
  <div><span className="text-neutral-400 block">Final Balance</span><span className={"font-semibold " + (safeNum(historicalTenantDetail.tenant.balance) > 0 ? "text-danger-500" : "text-positive-600")}>{historicalTenantDetail.tenant.balance != null ? formatCurrency(Math.abs(safeNum(historicalTenantDetail.tenant.balance))) + (safeNum(historicalTenantDetail.tenant.balance) > 0 ? " owed" : " settled") : "—"}</span></div>
  <div><span className="text-neutral-400 block">Move Out</span><span className="font-medium text-neutral-700">{historicalTenantDetail.tenant.move_out || "—"}</span></div>
  </div>
  </div>
  )}

  {/* Ledger */}
  {historicalTenantDetail.activeTab === "ledger" && (
  <div>
  {historicalTenantDetail.ledger.length === 0 ? <div className="text-center py-6 text-neutral-400 text-sm">No transaction history</div> : (
  <div className="space-y-1">
  {historicalTenantDetail.ledger.map((e, i) => (
  <div key={item.id || i} className="flex items-center justify-between py-2.5 border-b border-neutral-100 text-sm">
  <div>
  <div className="font-medium text-neutral-700">{e.description}</div>
  <div className="text-xs text-neutral-400">{e.date}{e.type ? " · " + e.type : ""}</div>
  </div>
  <div className="text-right">
  <div className={"font-semibold font-mono " + (e.amount < 0 ? "text-positive-600" : "text-danger-500")}>{e.amount < 0 ? "+" : "-"}{formatCurrency(Math.abs(e.amount))}</div>
  {e.balance != null && <div className="text-xs text-neutral-400">Bal: {formatCurrency(e.balance)}</div>}
  </div>
  </div>
  ))}
  </div>
  )}
  </div>
  )}

  {/* Documents */}
  {historicalTenantDetail.activeTab === "docs" && (
  <div>
  {historicalTenantDetail.docs.length === 0 ? <div className="text-center py-6 text-neutral-400 text-sm">No documents</div> : (
  <div className="space-y-2">
  {historicalTenantDetail.docs.map(d => (
  <div key={d.id} className="flex items-center justify-between bg-neutral-50 rounded-lg px-4 py-3 hover:bg-neutral-100 transition-colors">
  <div className="flex items-center gap-3">
  <span className="material-icons-outlined text-neutral-400 text-lg">{d.type === "Lease" ? "description" : d.type === "ID" ? "badge" : d.type === "Insurance" ? "verified_user" : "insert_drive_file"}</span>
  <div>
  <div className="text-sm font-medium text-neutral-700">{d.name}</div>
  <div className="text-xs text-neutral-400">{d.type} · {d.uploaded_at?.slice(0, 10)}</div>
  </div>
  </div>
  <button onClick={async () => { const url = await getSignedUrl("documents", d.file_name || d.url); if (url) window.open(url, "_blank", "noopener,noreferrer"); }} className="text-xs text-brand-600 hover:underline flex items-center gap-1"><span className="material-icons-outlined text-sm">open_in_new</span>View</button>
  </div>
  ))}
  </div>
  )}
  </div>
  )}

  {/* Messages */}
  {historicalTenantDetail.activeTab === "messages" && (
  <div>
  {historicalTenantDetail.messages.length === 0 ? <div className="text-center py-6 text-neutral-400 text-sm">No messages</div> : (
  <div className="space-y-2 max-h-64 overflow-y-auto">
  {historicalTenantDetail.messages.map((m, i) => (
  <div key={i} className={"rounded-xl px-3 py-2 max-w-[85%] text-sm " + (m.sender === "admin" ? "bg-brand-50 text-brand-800 ml-auto" : "bg-neutral-100 text-neutral-700")}>
  <div>{m.message}</div>
  <div className="text-xs text-neutral-400 mt-1">{m.sender} · {m.created_at?.slice(0, 16).replace("T", " ")}</div>
  </div>
  ))}
  </div>
  )}
  </div>
  )}
  </div>
  )}

  </div>
  </div>
  )}


  {incompleteWizards.length > 0 && !showPropertyWizard && (
  <div className="mb-4 space-y-2">
  {incompleteWizards.map(w => (
  <div key={w.id} className="bg-warn-50 border border-warn-200 rounded-xl p-4 flex items-center justify-between">
  <div className="flex items-center gap-3">
  <span className="material-icons-outlined text-warn-600">construction</span>
  <div>
  <div className="text-sm font-semibold text-warn-800">Setup incomplete: {w.property_address?.split(",")[0]}</div>
  <div className="text-xs text-warn-600">{(w.completed_steps || []).length} steps completed · {w.status === "in_progress" ? "In progress" : w.status}</div>
  </div>
  </div>
  <button onClick={() => {
  const prop = properties.find(p => p.address === w.property_address);
  setShowPropertyWizard({
  propertyId: prop?.id || w.property_id,
  address: w.property_address,
  isOccupied: prop?.status === "occupied",
  tenant: prop?.tenant || "",
  rent: Number(prop?.rent) || 0,
  leaseStart: prop?.lease_start || "",
  leaseEnd: prop?.lease_end || "",
  securityDeposit: Number(prop?.security_deposit) || 0,
  });
  }} className="bg-warn-600 text-white text-xs px-4 py-2 rounded-lg hover:bg-warn-700 font-semibold">Resume Setup</button>
  </div>
  ))}
  </div>
  )}

  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
  <div className="bg-white rounded-3xl border border-brand-50 px-3 py-2 text-center"><div className="text-lg font-manrope font-bold text-neutral-800">{properties.length}</div><div className="text-xs text-neutral-400">Total</div></div>
  <div className="bg-white rounded-3xl border border-brand-50 px-3 py-2 text-center"><div className="text-lg font-bold text-success-600">{properties.filter(p => p.status === "occupied").length}</div><div className="text-xs text-neutral-400">Occupied</div></div>
  <div className="bg-white rounded-3xl border border-brand-50 px-3 py-2 text-center"><div className="text-lg font-bold text-warn-600">{properties.filter(p => p.status === "vacant").length}</div><div className="text-xs text-neutral-400">Vacant</div></div>
  <div className="bg-white rounded-3xl border border-brand-50 px-3 py-2 text-center"><div className="text-lg font-bold text-brand-600">${properties.reduce((s, p) => s + safeNum(p.rent), 0).toLocaleString()}</div><div className="text-xs text-neutral-400">Total Rent</div></div>
  </div>

  {viewMode === "card" && (
  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
  {filtered.map(p => (
  <div key={p.id} onClick={() => openPropertyDetail(p)} className={`bg-white rounded-xl border shadow-sm p-4 cursor-pointer hover:shadow-md hover:border-brand-200 transition-all ${isReadOnly(p) ? "border-highlight-200 bg-highlight-50/30" : "border-brand-50"}`}>
  <div className="flex items-start justify-between mb-2">
  <div>
  <h3 className="font-semibold text-neutral-800 text-sm">{p.address_line_1 || p.address}</h3>{(p.city || p.state) && <div className="text-xs text-neutral-400">{[p.city, p.state, p.zip].filter(Boolean).join(", ")}{p.county && <span className="ml-1 text-neutral-500">· {p.county}</span>}</div>}
  <p className="text-xs text-neutral-400">{p.type}</p>
  </div>
  <div className="flex flex-col items-end gap-1">
  <Badge status={p.status} label={p.status} />
  {p.pm_company_name && <span className="text-xs bg-highlight-100 text-highlight-700 px-2 py-0.5 rounded-full">PM: {p.pm_company_name}</span>}
  </div>
  </div>
  <div className="text-sm text-neutral-500 space-y-1">
  <div className="flex justify-between"><span>Rent:</span><span className="font-semibold">${safeNum(p.rent).toLocaleString()}</span></div>
  {p.tenant && <div className="flex justify-between"><span>Tenant:</span><span>{formatAllTenants(p)}</span></div>}
  {p.lease_end && <div className="flex justify-between"><span>Lease End:</span><span>{p.lease_end}</span></div>}
  </div>
  {isReadOnly(p) && <div className="mt-2 text-xs text-highlight-600 bg-highlight-50 rounded-lg px-2 py-1">🔒 Managed property — view only</div>}
  {p.status === "inactive" && <div className="mt-2 text-xs text-warn-600 bg-warn-50 rounded-lg px-2 py-1">⏸ Inactive — accounting history preserved</div>}
  {(() => { const ss = getSetupStatus(p); return (!ss.isComplete && ss.total > 0) ? <div onClick={(e) => { e.stopPropagation(); setShowPropertyWizard({ propertyId: p.id, address: p.address, isOccupied: p.status === "occupied", tenant: p.tenant || "", rent: Number(p.rent) || 0, leaseStart: p.lease_start || "", leaseEnd: p.lease_end || "", securityDeposit: Number(p.security_deposit) || 0 }); }} className="mt-2 text-xs text-info-600 bg-info-50 rounded-lg px-2 py-1 flex items-center gap-1 cursor-pointer hover:bg-info-100 transition-colors"><span className="material-icons-outlined text-sm">pending</span>Setup Incomplete — {ss.missing.length} step{ss.missing.length !== 1 ? "s" : ""} remaining</div> : null; })()}
  <div className="flex gap-2 mt-3 pt-3 border-t border-brand-50/50 flex-wrap" onClick={e => e.stopPropagation()}>
  {!isReadOnly(p) && <button onClick={(e) => { e.stopPropagation(); setShowPropertyWizard({ propertyId: p.id, address: p.address, isOccupied: p.status === "occupied", tenant: p.tenant || "", rent: Number(p.rent) || 0, leaseStart: p.lease_start || "", leaseEnd: p.lease_end || "", securityDeposit: Number(p.security_deposit) || 0, isEdit: true }); }} className="text-xs text-brand-600 hover:underline">Edit</button>}
  {!isReadOnly(p) && p.status === "vacant" && <button onClick={(e) => { e.stopPropagation(); setShowPropertyWizard({ propertyId: p.id, address: p.address, isOccupied: false, tenant: "", rent: 0, isNew: false }); }} className="text-xs text-positive-600 hover:underline">Add Tenant</button>}
  {!isReadOnly(p) && isAdmin && p.status !== "inactive" && <button onClick={() => deactivateProperty(p)} className="text-xs text-warn-600 hover:underline">Deactivate</button>}
  {!isReadOnly(p) && isAdmin && p.status === "inactive" && <button onClick={() => reactivateProperty(p)} className="text-xs text-positive-600 hover:underline">Reactivate</button>}
  {!isReadOnly(p) && isAdmin && <button onClick={() => deleteProperty(p.id, p.address)} className="text-xs text-danger-500 hover:underline">Delete</button>}
  {!isReadOnly(p) && !isAdmin && <button onClick={() => requestDeleteProperty(p)} className="text-xs text-danger-400 hover:underline">Request Delete</button>}
  {!p.pm_company_id && !isReadOnly(p) && isAdmin && <button onClick={() => { setShowPmAssign(p); setPmCode(""); }} className="text-xs text-highlight-600 hover:underline">Assign PM</button>}
  {p.pm_company_id && !isReadOnly(p) && isAdmin && <button onClick={() => removePM(p)} className="text-xs text-notice-600 hover:underline">Remove PM</button>}
  <button onClick={() => loadTimeline(p)} className="text-xs text-neutral-400 hover:underline ml-auto">Timeline</button>
  </div>
  </div>
  ))}
  </div>
  )}

  {viewMode === "table" && (
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 overflow-x-auto">
  <table className="w-full text-sm">
  <thead className="bg-brand-50/30 text-xs text-neutral-400 uppercase">
  <tr>
  {visibleCols.includes("address") && <th className="px-4 py-3 text-left">Address</th>}
  {visibleCols.includes("type") && <th className="px-4 py-3 text-left">Type</th>}
  {visibleCols.includes("status") && <th className="px-4 py-3 text-left">Status</th>}
  {visibleCols.includes("rent") && <th className="px-4 py-3 text-right">Rent</th>}
  {visibleCols.includes("tenant") && <th className="px-4 py-3 text-left">Tenant</th>}
  {visibleCols.includes("lease_end") && <th className="px-4 py-3 text-left">Lease End</th>}
  {visibleCols.includes("owner_name") && <th className="px-4 py-3 text-left">Owner</th>}
  {visibleCols.includes("notes") && <th className="px-4 py-3 text-left">Notes</th>}
  <th className="px-4 py-3 text-right">Actions</th>
  </tr>
  </thead>
  <tbody>
  {filtered.map(p => (
  <tr key={p.id} onClick={() => openPropertyDetail(p)} className="border-t border-brand-50/50 hover:bg-brand-50/30/50 cursor-pointer">
  {visibleCols.includes("address") && <td className="px-4 py-2.5 font-medium text-neutral-800">{p.address}</td>}
  {visibleCols.includes("type") && <td className="px-4 py-2.5 text-neutral-500">{p.type}</td>}
  {visibleCols.includes("status") && <td className="px-4 py-2.5"><Badge status={p.status} label={p.status} /></td>}
  {visibleCols.includes("rent") && <td className="px-4 py-2.5 text-right font-semibold">${safeNum(p.rent).toLocaleString()}</td>}
  {visibleCols.includes("tenant") && <td className="px-4 py-2.5 text-neutral-500">{formatAllTenants(p) || "—"}</td>}
  {visibleCols.includes("lease_end") && <td className="px-4 py-2.5 text-neutral-400">{p.lease_end || "—"}</td>}
  {visibleCols.includes("owner_name") && <td className="px-4 py-2.5 text-neutral-500">{p.owner_name || "—"}</td>}
  {visibleCols.includes("notes") && <td className="px-4 py-2.5 text-xs text-neutral-400 max-w-32 truncate">{p.notes || "—"}</td>}
  <td className="px-4 py-2.5 text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
  {p.pm_company_name && <span className="text-xs bg-highlight-100 text-highlight-600 px-1.5 py-0.5 rounded mr-2">PM</span>}
  {isReadOnly(p) && <span className="text-xs text-highlight-500 mr-2">🔒 view only</span>}
  {!isReadOnly(p) && <button onClick={() => { setShowPropertyWizard({ propertyId: p.id, address: p.address, isOccupied: p.status === "occupied", tenant: p.tenant || "", rent: Number(p.rent) || 0, leaseStart: p.lease_start || "", leaseEnd: p.lease_end || "", securityDeposit: Number(p.security_deposit) || 0, isEdit: true }); }} className="text-xs text-brand-600 hover:underline mr-2">Edit</button>}
  {!isReadOnly(p) && isAdmin && <button onClick={() => deleteProperty(p.id, p.address)} className="text-xs text-danger-500 hover:underline mr-2">Delete</button>}
  {!isReadOnly(p) && !isAdmin && <button onClick={() => requestDeleteProperty(p)} className="text-xs text-danger-400 hover:underline mr-2">Request Delete</button>}
  {!p.pm_company_id && !isReadOnly(p) && isAdmin && <button onClick={() => { setShowPmAssign(p); setPmCode(""); }} className="text-xs text-highlight-600 hover:underline mr-2">PM</button>}
  {p.pm_company_id && !isReadOnly(p) && isAdmin && <button onClick={() => removePM(p)} className="text-xs text-notice-600 hover:underline mr-2">-PM</button>}
  <button onClick={() => loadTimeline(p)} className="text-xs text-neutral-400 hover:underline">TL</button>
  </td>
  </tr>
  ))}
  </tbody>
  </table>
  {filtered.length === 0 && <div className="text-center py-8 text-neutral-400 text-sm">No properties found</div>}
  </div>
  )}

  {viewMode === "compact" && (
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 divide-y divide-brand-50/50">
  {filtered.map(p => (
  <div key={p.id} onClick={() => openPropertyDetail(p)} className={`flex items-center gap-3 px-4 py-2.5 hover:bg-brand-50/30/50 cursor-pointer ${isReadOnly(p) ? "bg-highlight-50/30" : ""}`}>
  <div className={`w-2 h-2 rounded-full ${p.status === "occupied" ? "bg-success-500" : p.status === "vacant" ? "bg-warn-500" : "bg-danger-500"}`} />
  <div className="flex-1 min-w-0">
  <span className="text-sm font-medium text-neutral-800">{p.address}</span>
  <span className="text-xs text-neutral-400 ml-2">{p.type}</span>
  {p.pm_company_name && <span className="text-xs bg-highlight-100 text-highlight-600 px-1.5 py-0.5 rounded ml-2">PM: {p.pm_company_name}</span>}
  </div>
  <span className="text-sm font-semibold text-neutral-700">${safeNum(p.rent).toLocaleString()}</span>
  <span className="text-xs text-neutral-400 w-28 truncate">{p.tenant || "—"}</span>
  <Badge status={p.status} label={p.status} />
  {!isReadOnly(p) && <button onClick={(e) => { e.stopPropagation(); setShowPropertyWizard({ propertyId: p.id, address: p.address, isOccupied: p.status === "occupied", tenant: p.tenant || "", rent: Number(p.rent) || 0, leaseStart: p.lease_start || "", leaseEnd: p.lease_end || "", securityDeposit: Number(p.security_deposit) || 0, isEdit: true }); }} className="text-xs text-brand-600 hover:underline">Edit</button>}
  {isReadOnly(p) && <span className="text-xs text-highlight-400">🔒</span>}
  </div>
  ))}
  {filtered.length === 0 && <div className="text-center py-8 text-neutral-400 text-sm">No properties found</div>}
  </div>
  )}

  {/* PM Assignment Modal */}
  {showPmAssign && (
  <Modal title={`Assign Property Manager — ${showPmAssign.address}`} onClose={() => setShowPmAssign(null)}>
  <div className="space-y-4">
  <div className="bg-highlight-50 rounded-xl p-3 text-sm">
  <div className="font-semibold text-highlight-800 mb-1">What this does:</div>
  <div className="text-xs text-highlight-600 space-y-1">
  <div>The PM company gets operational control (tenants, leases, maintenance, payments)</div>
  <div>You retain financial oversight and can view statements</div>
  <div>You can remove the PM at any time to regain full control</div>
  </div>
  </div>
  <div>
  <label className="text-xs font-medium text-neutral-500 block mb-1">PM Company's 8-Digit Code</label>
  <Input value={pmCode} onChange={e => setPmCode(e.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="e.g. 12345678" maxLength={8} className="font-mono tracking-wider" />
  <p className="text-xs text-neutral-400 mt-1">Ask the property manager for their company code</p>
  </div>
  <Btn variant="purple" className="w-full" onClick={() => assignPM(showPmAssign)}>Assign Property Manager</Btn>
  </div>
  </Modal>
  )}

  {timelineProperty && (
  <Modal title={`Timeline: ${timelineProperty.address}`} onClose={() => setTimelineProperty(null)}>
  <div className="space-y-3 max-h-96 overflow-y-auto">
  {timelineData.map((item, i) => (
  <div key={i} className="flex gap-3 items-start">
  <span className="text-lg">{item._type === "payment" ? "💰" : item._type === "work_order" ? "🔧" : "📄"}</span>
  <div>
  <p className="text-sm font-medium text-neutral-800">{item._type === "payment" ? `${formatCurrency(item.amount)} - ${item.type}` : item._type === "work_order" ? item.issue : item.name}</p>
  <p className="text-xs text-neutral-400">{new Date(item._date).toLocaleDateString()}</p>
  </div>
  </div>
  ))}
  {timelineData.length === 0 && <p className="text-sm text-neutral-400 text-center py-4">No activity found.</p>}
  </div>
  </Modal>
  )}

  {/* Recurring Rent Setup Modal */}
  {showRecurringSetup && (
  <Modal title="Set Up Recurring Rent" onClose={() => setShowRecurringSetup(null)}>
  <div className="space-y-4">
  <p className="text-sm text-subtle-600">Would you like to set up automatic monthly rent posting for <strong>{showRecurringSetup.tenant}</strong> at <strong>{showRecurringSetup.property}</strong>?</p>
  <div className="bg-brand-50 rounded-lg p-3">
  <div className="grid grid-cols-2 gap-3">
  <div><div className="text-xs text-subtle-500">Monthly Rent</div><div className="font-bold text-subtle-800">${safeNum(showRecurringSetup.rent).toLocaleString()}</div></div>
  <div><div className="text-xs text-subtle-500">Posts On</div><div className="font-bold text-subtle-800">1st of each month</div></div>
  </div>
  </div>
  <div className="bg-warn-50 rounded-lg p-3">
  <div className="text-xs font-semibold text-warn-700 mb-1">Late Fee Settings</div>
  <div className="grid grid-cols-2 gap-3">
  <div><label className="text-xs text-subtle-500">Grace Period (days)</label><Input type="number" defaultValue={5} id="rr-grace" className="mt-1" /></div>
  <div><label className="text-xs text-subtle-500">Late Fee ($)</label><Input type="number" defaultValue={50} id="rr-latefee" className="mt-1" /></div>
  </div>
  </div>
  <div className="flex gap-2">
  <Btn className="flex-1" onClick={async () => {
  const grace = Number(document.getElementById("rr-grace")?.value) || 5;
  const lateFee = Number(document.getElementById("rr-latefee")?.value) || 50;
  const { error } = await supabase.from("recurring_journal_entries").insert([{
  company_id: companyId,
  description: "Monthly rent — " + showRecurringSetup.tenant + " — " + showRecurringSetup.property,
  frequency: "monthly",
  day_of_month: 1,
  amount: showRecurringSetup.rent,
  tenant_name: showRecurringSetup.tenant,
  tenant_id: showRecurringSetup.tenantId,
  property: showRecurringSetup.property,
  debit_account_id: "1200",
  debit_account_name: "Accounts Receivable",
  credit_account_id: "4000",
  credit_account_name: "Rental Income",
  status: "active",
  late_fee_enabled: true,
  grace_period_days: grace,
  late_fee_amount: lateFee,
  next_post_date: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString().split("T")[0],
  created_by: userProfile?.email || "",
  }]);
  if (error) { pmError("PM-4008", { raw: error, context: "create recurring entry for " + showRecurringSetup.tenant }); }
  else { addNotification("🔄", "Recurring rent set up for " + showRecurringSetup.tenant); }
  setShowRecurringSetup(null);
  }}>Yes, Set Up Recurring Rent</Btn>
  <Btn variant="ghost" className="flex-1" onClick={() => setShowRecurringSetup(null)}>Skip for Now</Btn>
  </div>
  </div>
  </Modal>
  )}


  </>)}
  {showDocUpload && <DocUploadModal onClose={() => setShowDocUpload(null)} companyId={companyId} property={showDocUpload.property} tenant={showDocUpload.tenant} showToast={showToast} onUploaded={() => { if (selectedProperty) { supabase.from("documents").select("*").eq("company_id", companyId).eq("property", selectedProperty.address).is("archived_at", null).order("uploaded_at", { ascending: false }).limit(100).then(({ data }) => { setPropertyDocs(data || []); setPropertyDetailTab("documents"); }); } }} />}
  {savingProperty && (
  <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-[60] flex items-center justify-center">
  <div className="bg-white rounded-2xl shadow-2xl px-8 py-6 flex flex-col items-center gap-3">
  <div className="w-10 h-10 border-4 border-brand-200 border-t-brand-600 rounded-full animate-spin" />
  <div className="text-sm font-medium text-neutral-700">Setting up property...</div>
  <div className="text-xs text-neutral-400">Creating tenant, lease & posting entries</div>
  </div>
  </div>
  )}
  {showPropertyWizard && <PropertySetupWizard wizardData={showPropertyWizard} companyId={companyId} showToast={showToast} userProfile={userProfile} userRole={userRole} onComplete={() => { setShowPropertyWizard(null); setPendingRecurringEntry(null); fetchProperties(); showToast("Property setup complete!", "success"); }} onDismiss={() => { setShowPropertyWizard(null); setPendingRecurringEntry(null); fetchProperties(); }} />}
  {pendingRecurringEntry && <RecurringEntryModal entry={pendingRecurringEntry} companyId={companyId} showToast={showToast} onComplete={() => setPendingRecurringEntry(null)} />}
  {showLicenseForm && <LicenseFormModal license={showLicenseForm.license} propertyId={showLicenseForm.propertyId} propertyAddress={showLicenseForm.propertyAddress} companyId={companyId} userProfile={userProfile} userRole={userRole} showToast={showToast} showConfirm={showConfirm} onClose={() => setShowLicenseForm(null)} onSaved={async () => { if (selectedProperty) { const { data } = await supabase.from("property_licenses").select("*").eq("company_id", companyId).eq("property_id", selectedProperty.id).is("archived_at", null).order("expiry_date", { ascending: true }); setPropertyLicenses(data || []); } }} />}
  </div>
  );
}

export { PropertySetupWizard, Properties };
