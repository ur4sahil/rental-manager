import React, { useState, useEffect, useRef } from "react";
import { supabase } from "../supabase";
import { Input, Btn, Select, Checkbox, FileInput, IconBtn, TextLink} from "../ui";
import { safeNum, parseLocalDate, formatLocalDate, shortId, sanitizeFileName, escapeHtml, escapeFilterValue, ALLOWED_DOC_TYPES, ALLOWED_DOC_EXTENSIONS, statusColors, recomputeTenantDocStatus } from "../utils/helpers";
import { pmError, reportError } from "../utils/errors";
import { printTheme } from "../utils/theme";
import { getOrCreateTenantAR, resolveAccountId } from "../utils/accounting";

// Format all tenants on a property as "John Smith / Jane Doe"
export function formatAllTenants(property) {
  if (!property) return "";
  const names = [property.tenant, property.tenant_2, property.tenant_3, property.tenant_4, property.tenant_5].filter(n => n && n.trim());
  return names.join(" / ") || "";
}

export class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null, errorCode: "PM-8009" }; }
  static getDerivedStateFromError(error) { return { hasError: true, error, errorCode: "PM-8009" }; }
  componentDidCatch(error, info) {
    // Route through pmError so the event is dedup'd, tagged with company /
    // role, enriched with component stack, and written to error_log.
    pmError("PM-8009", {
      raw: error,
      context: "React ErrorBoundary",
      silent: true,
      meta: { componentStack: (info?.componentStack || "").slice(0, 1500) },
    });
  }
  render() {
  if (this.state.hasError) {
  return (
  <div className="flex items-center justify-center min-h-screen bg-subtle-50">
  <div className="text-center p-8 max-w-md">
  <div className="text-5xl mb-4">⚠️</div>
  <h2 className="text-xl font-bold text-subtle-800 mb-2">Something went wrong</h2>
  <p className="text-sm text-subtle-500 mb-2">We've logged this issue automatically.</p>
  <div className="inline-block bg-danger-50 text-danger-700 font-mono text-sm px-3 py-1 rounded mb-4">{this.state.errorCode}</div>
  <p className="text-xs text-subtle-400 mb-6">If this keeps happening, share this code with your admin.</p>
  <Btn variant="primary" onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}>Reload App</Btn>
  </div>
  </div>
  );
  }
  return this.props.children;
  }
}

export function Badge({ status, label }) {
  const color = statusColors[status] || "bg-neutral-100 text-neutral-600";
  return <span className={`px-2.5 py-1 rounded-full text-xs font-semibold uppercase tracking-wide ${color}`}>{label || status}</span>;
}

export function StatCard({ label, value, sub, color = "text-neutral-800", onClick }) {
  return (
  <div onClick={onClick} className={"bg-white rounded-3xl shadow-card border border-brand-50 p-5" + (onClick ? " cursor-pointer hover:border-brand-200 hover:shadow-md transition-all" : "")}>
  <div className="text-xs text-neutral-400 font-medium uppercase tracking-widest mb-1">{label}</div>
  <div className={`text-2xl font-manrope font-bold ${color}`}>{value}</div>
  {sub && <div className="text-xs text-neutral-400 mt-1">{sub}</div>}
  </div>
  );
}

export function Spinner() {
  return (
  <div className="flex items-center justify-center py-20">
  <div className="w-8 h-8 border-4 border-brand-200 border-t-brand-600 rounded-full animate-spin"></div>
  </div>
  );
}

export function Modal({ title, onClose, children }) {
  return (
  <div className="fixed inset-0 bg-black bg-opacity-40 z-[60] flex items-center justify-center p-4">
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 w-full max-w-lg max-h-[90vh] overflow-y-auto">
  <div className="flex items-center justify-between px-6 py-4 border-b border-brand-50 sticky top-0 bg-white rounded-t-3xl">
  <h3 className="font-manrope font-bold text-neutral-800 text-lg">{title}</h3>
  <IconBtn icon="close" onClick={onClose} />
  </div>
  <div className="p-6">{children}</div>
  </div>
  </div>
  );
}

export function ToastContainer({ toasts, removeToast }) {
  return (
  <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
  {toasts.map(t => (
  <div key={t.id} className={"flex items-start gap-3 px-4 py-3 rounded-2xl shadow-lg border backdrop-blur-md animate-slide-up " + (t.type === "error" ? "bg-danger-50 border-danger-200 text-danger-800" : t.type === "warning" ? "bg-warn-50 border-warn-200 text-warn-800" : t.type === "success" ? "bg-success-50 border-success-200 text-success-800" : "bg-white border-brand-100 text-neutral-700")}>
  {t.isError ? (<>
    <span className="material-icons-outlined text-lg mt-0.5">{t.type === "error" ? "error" : "warning"}</span>
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-xs font-mono px-1.5 py-0.5 rounded font-bold ${t.type === "error" ? "bg-danger-100 text-danger-700" : "bg-warn-100 text-warn-700"}`}>{t.code}</span>
        {t.action === "retry" && <span className="text-xs opacity-70">Try again</span>}
        {t.action === "contact" && <span className="text-xs opacity-70">Contact admin</span>}
      </div>
      <p className="text-sm">{t.message}</p>
    </div>
    <div className="flex items-center gap-1 shrink-0">
      <button onClick={() => reportError(t.code)} className="text-xs bg-white/20 hover:bg-white/30 px-2 py-1 rounded transition-colors" title="Report this error">Report</button>
      <button onClick={() => removeToast(t.id)} className="text-xs opacity-60 hover:opacity-100 px-1">✕</button>
    </div>
  </>) : (<>
    <span className="material-icons-outlined text-lg mt-0.5">{t.type === "error" ? "error" : t.type === "warning" ? "warning" : t.type === "success" ? "check_circle" : "info"}</span>
    <div className="flex-1 text-sm">{t.message}</div>
    <TextLink tone="neutral" size="xs" underline={false} onClick={() => removeToast(t.id)} className="ml-1"><span className="material-icons-outlined text-sm">close</span></TextLink>
  </>)}
  </div>
  ))}
  </div>
  );
}

export function ConfirmModal({ config, onConfirm, onCancel }) {
  if (!config) return null;
  const isDanger = config.variant === "danger";
  return (
  <div className="fixed inset-0 bg-black bg-opacity-40 z-[90] flex items-center justify-center p-4">
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 w-full max-w-md">
  <div className="px-6 py-4 border-b border-brand-50">
  <h3 className="font-manrope font-bold text-neutral-800 text-lg">{config.title || (isDanger ? "Confirm Action" : "Are you sure?")}</h3>
  </div>
  <div className="px-6 py-5">
  <p className="text-sm text-neutral-600 whitespace-pre-line">{config.message}</p>
  </div>
  <div className="px-6 py-4 border-t border-brand-50 flex justify-end gap-3">
  <Btn variant="slate" onClick={onCancel}>{config.cancelText || "Cancel"}</Btn>
  <Btn variant={isDanger ? "danger-fill" : "primary"} onClick={onConfirm}>{config.confirmText || (isDanger ? "Delete" : "Confirm")}</Btn>
  </div>
  </div>
  </div>
  );
}

export function PropertyDropdown({ value, onChange, className = "", required = false, label = "Property", companyId }) {
  const [properties, setProperties] = useState([]);
  useEffect(() => {
  supabase.from("properties").select("id, address, type, status").eq("company_id", companyId).is("archived_at", null).order("address").then(({ data }) => setProperties(data || []));
  }, [companyId]);
  return (
  <div>
  {label && <label className="text-xs font-medium text-neutral-500 uppercase tracking-widest block mb-1">{label} {required && "*"}</label>}
  <Select value={value || ""} onChange={e => { const sel = properties.find(p => p.address === e.target.value); onChange(e.target.value, sel ? sel.id : null); }} className={className} required={required}>
  <option value="">Select property...</option>
  {properties.map(p => <option key={p.id} value={p.address}>{p.address} ({p.type})</option>)}
  </Select>
  </div>
  );
}

export function TenantSelect({ value, onChange, className = "", companyId }) {
  const [tenants, setTenants] = useState([]);
  useEffect(() => {
  supabase.from("tenants").select("id, name, property").eq("company_id", companyId).is("archived_at", null).order("name").then(({ data }) => setTenants(data || []));
  }, [companyId]);
  return (
  <Select value={value || ""} onChange={e => { const sel = tenants.find(t => t.name === e.target.value); onChange(e.target.value, sel); }} className={className}>
  <option value="">Select tenant...</option>
  {tenants.map(t => <option key={t.id} value={t.name}>{t.name}{t.property ? " — " + t.property : ""}</option>)}
  </Select>
  );
}

export function PropertySelect({ value, onChange, className = "", companyId }) {
  const [properties, setProperties] = useState([]);
  useEffect(() => {
  supabase.from("properties").select("id, address, type, tenant, tenant_2, tenant_3, tenant_4, rent, status").eq("company_id", companyId).is("archived_at", null).order("address").then(({ data }) => setProperties(data || []));
  }, [companyId]);
  return (
  <Select value={value || ""} onChange={e => { const sel = properties.find(p => p.address === e.target.value); onChange(e.target.value, sel || null); }} className={className}>
  <option value="">Select property...</option>
  {properties.map(p => <option key={p.id} value={p.address}>{p.address}</option>)}
  </Select>
  );
}

export function RecurringEntryModal({ entry, companyId, showToast, onComplete }) {
  const [freq, setFreq] = useState("monthly");
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [amount, setAmount] = useState(entry?.rent || 0);
  const [saving, setSaving] = useState(false);

  // Calculate next post date (1st of next month)
  const today = new Date();
  const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const nextPostDate = formatLocalDate(nextMonth);

  async function handleCreate() {
  if (saving) return;
  setSaving(true);
  try {
  // Get or create tenant AR sub-account
  const tenantArId = await getOrCreateTenantAR(companyId, entry.tenantName, entry.tenantId);
  const revenueId = await resolveAccountId("4000", companyId);
  // Get the AR sub-account code for display
  const { data: arAcct } = await supabase.from("acct_accounts").select("code").eq("company_id", companyId).eq("id", tenantArId).maybeSingle();
  // Validate UUIDs before insert — skip fields that aren't valid UUIDs
  const isUUID = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  const payload = {
  company_id: companyId,
  description: "Monthly rent — " + entry.tenantName + " — " + entry.property?.split(",")[0],
  frequency: freq,
  day_of_month: dayOfMonth,
  amount: Number(amount),
  tenant_name: entry.tenantName,
  property: entry.property || "",
  debit_account_id: tenantArId,
  debit_account_name: "AR - " + entry.tenantName,
  credit_account_id: revenueId,
  credit_account_name: "Rental Income",
  status: "active",
  next_post_date: nextPostDate,
  created_by: "",
  };
  // Only include tenant_id if it's a valid UUID (some DBs use integer PKs)
  if (entry.tenantId && isUUID(String(entry.tenantId))) payload.tenant_id = entry.tenantId;
  const { error } = await supabase.from("recurring_journal_entries").insert([payload]);
  if (error) {
  pmError("PM-4008", { raw: error, context: "create recurring rent entry" });
  setSaving(false);
  return;
  }
  showToast("Recurring rent entry created for " + entry.tenantName + " — $" + Number(amount).toLocaleString() + "/" + freq, "success");
  onComplete();
  } catch (e) {
  pmError("PM-4008", { raw: e, context: "create recurring rent entry" });
  setSaving(false);
  }
  }

  if (!entry) return null;
  return (
  <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center p-4">
  <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-6">
  <div className="text-center mb-4">
  <div className="w-14 h-14 bg-brand-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
  <span className="material-icons-outlined text-brand-600 text-2xl">autorenew</span>
  </div>
  <h3 className="text-lg font-manrope font-bold text-neutral-800">Set Up Recurring Rent</h3>
  <p className="text-sm text-neutral-400 mt-1">Schedule automatic rent charges for <strong>{entry.tenantName}</strong></p>
  </div>
  <div className="space-y-3">
  <div className="bg-brand-50 rounded-xl p-3">
  <div className="flex justify-between text-sm"><span className="text-neutral-500">Property</span><span className="font-medium text-neutral-800">{entry.property?.split(",")[0]}</span></div>
  <div className="flex justify-between text-sm mt-1"><span className="text-neutral-500">Lease Period</span><span className="font-medium text-neutral-800">{entry.leaseStart} → {entry.leaseEnd}</span></div>
  </div>
  <div>
  <label className="text-xs font-medium text-neutral-500 block mb-1">Monthly Rent Amount ($)</label>
  <Input type="number" value={amount} onChange={e => setAmount(e.target.value)} />
  </div>
  <div className="grid grid-cols-2 gap-3">
  <div>
  <label className="text-xs font-medium text-neutral-500 block mb-1">Frequency</label>
  <Select value={freq} onChange={e => setFreq(e.target.value)}>
  <option value="monthly">Monthly</option>
  <option value="quarterly">Quarterly</option>
  </Select>
  </div>
  <div>
  <label className="text-xs font-medium text-neutral-500 block mb-1">Day of Month</label>
  <Input type="number" min="1" max="28" value={dayOfMonth} onChange={e => setDayOfMonth(Math.min(28, Math.max(1, Number(e.target.value))))} title="Day of month (1-28, to ensure valid date in all months)" />
  </div>
  </div>
  <div className="bg-neutral-50 rounded-xl p-3 text-xs text-neutral-500">
  <div className="flex justify-between"><span>Debit</span><span className="font-medium">AR - {entry.tenantName}</span></div>
  <div className="flex justify-between mt-1"><span>Credit</span><span className="font-medium">4000 Rental Income</span></div>
  <div className="flex justify-between mt-1"><span>Next charge</span><span className="font-medium">{nextPostDate}</span></div>
  </div>
  </div>
  <div className="flex gap-3 mt-4">
  <Btn size="lg" className="flex-1" onClick={handleCreate} disabled={saving || !amount || Number(amount) <= 0}>
  {saving ? "Creating..." : "Create Recurring Entry"}
  </Btn>
  <Btn variant="slate" size="lg" className="flex-1" onClick={onComplete}>Skip for Now</Btn>
  </div>
  </div>
  </div>
  );
}

export function DocUploadModal({ onClose, companyId, property, tenant, showToast, onUploaded, isTenantUpload }) {
  const [form, setForm] = useState({ name: "", type: "Lease", tenant_visible: !!isTenantUpload });
  const [uploading, setUploading] = useState(false);
  const [fileName, setFileName] = useState("");
  const fileRef = useRef();

  async function handleUpload() {
  const file = fileRef.current?.files?.[0];
  if (!file) { showToast("Please select a file", "error"); return; }
  if (!form.name.trim()) { showToast("Document name is required", "error"); return; }
  // Validate file type and size
  if (!ALLOWED_DOC_TYPES.includes(file.type) && !ALLOWED_DOC_EXTENSIONS.test(file.name)) { showToast("File type not allowed. Accepted: PDF, images, Word, Excel, text files.", "error"); return; }
  if (file.size > 25 * 1024 * 1024) { showToast("File must be under 25MB.", "error"); return; }
  // Magic bytes validation (prevents MIME spoofing)
  // Magic bytes validation (prevents MIME spoofing) — only allow text/plain and text/csv, not text/html or text/javascript
  try { const hdr = new Uint8Array(await file.slice(0, 8).arrayBuffer()); const hex = Array.from(hdr.slice(0, 4)).map(b => b.toString(16).padStart(2, "0")).join(""); const ok = ["25504446","89504e47","ffd8ffe0","ffd8ffe1","ffd8ffe2","47494638","504b0304","d0cf11e0"].some(m => hex.startsWith(m)) || file.type === "text/plain" || file.type === "text/csv"; if (!ok) { showToast("File content doesn't match expected format.", "error"); return; } } catch (_e) { pmError("PM-7002", { raw: _e, context: "file magic bytes validation", silent: true }); }
  setUploading(true);
  const fileName = companyId + "/" + shortId() + "_" + sanitizeFileName(file.name);
  const { error: uploadErr } = await supabase.storage.from("documents").upload(fileName, file, { cacheControl: "3600", upsert: false });
  if (uploadErr) { pmError("PM-7002", { raw: uploadErr, context: "document upload" }); setUploading(false); return; }
  const { error: insertErr } = await supabase.from("documents").insert([{
  company_id: companyId, name: form.name.trim(), file_name: fileName, url: fileName,
  property: property || "", tenant: tenant || "", type: form.type,
  tenant_visible: form.tenant_visible, uploaded_at: new Date().toISOString(),
  }]);
  if (insertErr) { pmError("PM-7003", { raw: insertErr, context: "document record insert after upload" }); setUploading(false); return; }
  if (tenant) await recomputeTenantDocStatus(companyId, tenant);
  showToast("Document uploaded", "success");
  setUploading(false);
  if (onUploaded) onUploaded();
  onClose();
  }

  return (
  <Modal title="Upload Document" onClose={onClose}>
  <div className="space-y-3">
  {property && <div className="text-xs text-neutral-400">Property: <span className="font-semibold text-neutral-600">{property}</span></div>}
  {tenant && <div className="text-xs text-neutral-400">Tenant: <span className="font-semibold text-neutral-600">{tenant}</span></div>}
  <div>
  <label className="text-xs font-medium text-neutral-400 block mb-1">Document Name *</label>
  <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Signed Lease Agreement" />
  </div>
  <div>
  <label className="text-xs font-medium text-neutral-400 block mb-1">Type</label>
  <Select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
  {["Lease","Notice","ID","Insurance","Inspection","Receipt","Other"].map(t => <option key={t} value={t}>{t}</option>)}
  </Select>
  </div>
  <div>
  <label className="text-xs font-medium text-neutral-400 block mb-1">File *</label>
  <div className="flex items-center gap-3 flex-wrap">
  <label className="inline-flex items-center gap-2 px-4 py-2 rounded-2xl bg-brand-50 text-brand-700 border border-brand-200 hover:bg-brand-100 cursor-pointer text-sm font-medium transition-colors">
  <span className="material-icons-outlined text-base">upload_file</span>
  <span>Choose File</span>
  <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx,.txt,.csv" className="hidden" onChange={e => setFileName(e.target.files?.[0]?.name || "")} />
  </label>
  <span className="text-xs text-neutral-500 truncate max-w-[220px]" title={fileName}>{fileName || "No file selected"}</span>
  </div>
  </div>
  {!isTenantUpload && <Checkbox label="Visible to tenant" checked={form.tenant_visible} onChange={e => setForm({ ...form, tenant_visible: e.target.checked })} className="text-xs" />}
  <Btn className="w-full" onClick={handleUpload} disabled={uploading}>{uploading ? "Uploading..." : "Upload"}</Btn>
  </div>
  </Modal>
  );
}

export function generatePaymentReceipt(payment, companyName = "PropManager") {
  const receiptDate = parseLocalDate(payment.date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const receiptNum = "REC-" + String(payment.id || shortId()).slice(-8).toUpperCase();

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Payment Receipt ${receiptNum}</title>
<style>
  @media print { @page { margin: 0.5in; } body { -webkit-print-color-adjust: exact; } }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: ${printTheme.inkStrong}; background: ${printTheme.surface}; padding: 40px; }
  .receipt { max-width: 600px; margin: 0 auto; border: 2px solid ${printTheme.borderLight}; border-radius: 12px; overflow: hidden; }
  .header { background: linear-gradient(135deg, ${printTheme.brandDark}, ${printTheme.brandLight}); color: white; padding: 30px; }
  .header h1 { font-size: 24px; margin-bottom: 4px; }
  .header .subtitle { font-size: 13px; opacity: 0.85; }
  .badge { display: inline-block; background: rgba(255,255,255,0.2); border-radius: 20px; padding: 4px 14px; font-size: 12px; font-weight: 600; margin-top: 10px; }
  .body { padding: 30px; }
  .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid ${printTheme.surfaceMuted}; }
  .row:last-child { border-bottom: none; }
  .label { color: ${printTheme.inkMuted}; font-size: 13px; }
  .value { font-weight: 600; font-size: 14px; text-align: right; }
  .amount-row { background: ${printTheme.successBg}; border-radius: 8px; padding: 16px; margin: 16px 0; display: flex; justify-content: space-between; align-items: center; }
  .amount-row .label { font-size: 15px; font-weight: 600; color: ${printTheme.inkStrong}; }
  .amount-row .value { font-size: 22px; color: ${printTheme.success}; font-weight: 700; }
  .footer { background: ${printTheme.surfaceMuted}; padding: 20px 30px; text-align: center; border-top: 1px solid ${printTheme.borderLight}; }
  .footer p { font-size: 11px; color: ${printTheme.inkSubtle}; }
  .stamp { color: ${printTheme.success}; font-size: 18px; font-weight: 700; border: 3px solid ${printTheme.success}; border-radius: 8px; padding: 6px 20px; display: inline-block; transform: rotate(-3deg); margin-bottom: 10px; }
</style></head>
<body>
<div class="receipt">
  <div class="header">
  <h1>${escapeHtml(companyName)}</h1>
  <div class="subtitle">Payment Receipt</div>
  <div class="badge">Receipt #${receiptNum}</div>
  </div>
  <div class="body">
  <div class="row"><span class="label">Date</span><span class="value">${receiptDate}</span></div>
  <div class="row"><span class="label">Tenant</span><span class="value">${escapeHtml(payment.tenant || "N/A")}</span></div>
  <div class="row"><span class="label">Property</span><span class="value">${escapeHtml(payment.property || "N/A")}</span></div>
  <div class="row"><span class="label">Payment Type</span><span class="value" style="text-transform:capitalize">${escapeHtml(payment.type || "rent")}</span></div>
  <div class="row"><span class="label">Payment Method</span><span class="value" style="text-transform:uppercase">${escapeHtml(payment.method || "N/A")}</span></div>
  <div class="row"><span class="label">Status</span><span class="value" style="text-transform:capitalize">${escapeHtml(payment.status || "paid")}</span></div>
  <div class="amount-row"><span class="label">Amount Paid</span><span class="value">$${safeNum(payment.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span></div>
  </div>
  <div class="footer">
  <div class="stamp">PAID</div>
  <p>This is an electronic receipt generated by ${escapeHtml(companyName)}.</p>
  <p>For questions, contact your property manager.</p>
  </div>
</div>
</body></html>`;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank", "noopener,noreferrer");
  if (win) {
  win.onload = () => { setTimeout(() => win.print(), 500); };
  }
}
