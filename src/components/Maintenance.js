import React, { useState, useEffect, useRef } from "react";
import { supabase } from "../supabase";
import { Btn, Checkbox, FilterPill, Input, PageHeader, Select, Textarea, TextLink} from "../ui";
import { safeNum, formatLocalDate, shortId, formatCurrency, exportToCSV, sanitizeFileName, getSignedUrl, parseLocalDate, formatPhoneInput, normalizeEmail, parseNameParts, formatPersonName, priorityColors, escapeFilterValue } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { queueNotification } from "../utils/notifications";
import { atomicPostJEAndLedger, autoPostJournalEntry, getPropertyClassId } from "../utils/accounting";
import { Badge, StatCard, Spinner, Modal, PropertySelect } from "./shared";

function Maintenance({ addNotification, userProfile, userRole, companyId, showToast, showConfirm }) {
  function exportWorkOrders() {
  exportToCSV(workOrders, [
  { label: "Property", key: "property" },
  { label: "Tenant", key: "tenant" },
  { label: "Issue", key: "issue" },
  { label: "Priority", key: "priority" },
  { label: "Status", key: "status" },
  { label: "Assigned", key: "assigned" },
  { label: "Cost", key: "cost" },
  { label: "Created", key: "created_at" },
  ], "work_orders_" + new Date().toLocaleDateString(), showToast);
  }
  const [maintTab, setMaintTab] = useState("workorders");
  const [workOrders, setWorkOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [showForm, setShowForm] = useState(false);
  const [editingWO, setEditingWO] = useState(null);
  const [viewingPhotos, setViewingPhotos] = useState(null);
  const [woPhotos, setWoPhotos] = useState([]);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const photoRef = useRef();
  const [form, setForm] = useState({ property: "", tenant: "", issue: "", priority: "normal", status: "open", assigned: "", cost: 0, notes: "" });
  const [woSearch, setWoSearch] = useState("");
  const [woFilterProp, setWoFilterProp] = useState("all");
  const [woFilterAssigned, setWoFilterAssigned] = useState("all");
  const [selectedWOs, setSelectedWOs] = useState(new Set());

  useEffect(() => { fetchWorkOrders(); }, [companyId]);

  async function fetchWorkOrders() {
  const { data, error } = await supabase.from("work_orders").select("*").eq("company_id", companyId).is("archived_at", null).order("created", { ascending: false }).limit(500);
  if (error) { pmError("PM-7005", { raw: error, context: "loading work orders" }); }
  setWorkOrders(data || []);
  setLoading(false);
  }

  async function bulkUpdateWOStatus(newStatus) {
  if (selectedWOs.size === 0) return;
  const ids = Array.from(selectedWOs);
  const { error } = await supabase.from("work_orders").update({ status: newStatus }).in("id", ids).eq("company_id", companyId);
  if (error) { pmError("PM-7002", { raw: error, context: "bulk updating work orders" }); return; }
  showToast(ids.length + " work order(s) updated to " + newStatus, "success");
  addNotification("🔧", ids.length + " work orders → " + newStatus);
  setSelectedWOs(new Set());
  fetchWorkOrders();
  }

  async function bulkAssignVendor(vendorName) {
  if (selectedWOs.size === 0 || !vendorName) return;
  const ids = Array.from(selectedWOs);
  const { error } = await supabase.from("work_orders").update({ assigned: vendorName }).in("id", ids).eq("company_id", companyId);
  if (error) { pmError("PM-7003", { raw: error, context: "bulk assigning vendor" }); return; }
  showToast(ids.length + " work order(s) assigned to " + vendorName, "success");
  setSelectedWOs(new Set());
  fetchWorkOrders();
  }

  async function saveWorkOrder() {
  if (!guardSubmit("saveWorkOrder")) return;
  try {
  if (!form.property.trim()) { showToast("Property is required.", "error"); return; }
  if (!form.issue.trim()) { showToast("Issue description is required.", "error"); return; }
  // #18: Check if property is archived
  if (!editingWO) {
  const { data: propCheck } = await supabase.from("properties").select("archived_at").eq("company_id", companyId).eq("address", form.property).maybeSingle();
  if (propCheck?.archived_at) { showToast("Cannot create a work order for an archived property.", "error"); return; }
  }
  // #20: Warn when editing cost on a completed work order (GL already posted)
  if (editingWO && editingWO.status === "completed" && safeNum(form.cost) !== safeNum(editingWO.cost)) {
  if (!await showConfirm({ message: `This work order is completed and its cost was already posted to accounting ($${safeNum(editingWO.cost)}). Changing the cost to $${safeNum(form.cost)} will NOT update the GL entry.\n\nYou may need to void and re-post the journal entry manually. Continue?` })) return;
  }
  const payload = { ...form };
  const { error } = editingWO
  ? await supabase.from("work_orders").update({ property: payload.property, tenant: payload.tenant, issue: payload.issue, priority: payload.priority, status: payload.status, assigned: payload.assigned, cost: payload.cost, notes: payload.notes }).eq("id", editingWO.id).eq("company_id", companyId)
  : await supabase.from("work_orders").insert([{ ...payload, created: formatLocalDate(new Date()), company_id: companyId }]);
  if (error) { pmError("PM-7001", { raw: error, context: "saving work order" }); return; }
  showToast(editingWO ? "Work order updated." : "Work order created.", "success");
  if (editingWO) {
  const costChanged = safeNum(form.cost) !== safeNum(editingWO.cost);
  addNotification("🔧", `Work order updated: ${form.issue}`);
  logAudit("update", "maintenance", `Updated work order: ${form.issue}${costChanged ? " (cost changed: $" + safeNum(editingWO.cost) + " → $" + safeNum(form.cost) + ")" : ""}`, editingWO?.id, userProfile?.email, userRole, companyId);
  } else {
  addNotification("🔧", `New work order: ${form.issue} at ${form.property}`);
  logAudit("create", "maintenance", `Work order: ${form.issue} at ${form.property}`, "", userProfile?.email, userRole, companyId);
  // #24: Queue notification for tenant about new work order
  if (form.tenant) {
  const { data: woTenant } = await supabase.from("tenants").select("email").eq("company_id", companyId).ilike("name", form.tenant).maybeSingle();
  if (woTenant?.email) queueNotification("work_order_created", woTenant.email, { tenant: form.tenant, issue: form.issue, property: form.property, priority: form.priority }, companyId);
  }
  }
  setShowForm(false);
  setEditingWO(null);
  setForm({ property: "", tenant: "", issue: "", priority: "normal", status: "open", assigned: "", cost: 0, notes: "" });
  fetchWorkOrders();
  } finally { guardRelease("saveWorkOrder"); }
  }

  async function billTenantForWO(wo) {
    if (!wo.tenant) { showToast("No tenant assigned to this work order.", "error"); return; }
    const amountStr = prompt(`Bill tenant "${wo.tenant}" for this work order.\n\nEnter amount ($):`, wo.cost || "0");
    if (!amountStr) return;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) { showToast("Invalid amount.", "error"); return; }
    const description = prompt("Description:", `Service charge — ${wo.issue?.slice(0, 50)}`);
    if (!description) return;
    if (!guardSubmit("billTenant", wo.id)) return;
    try {
      const { data: tenant } = await supabase.from("tenants").select("id, name, property").eq("company_id", companyId).ilike("name", wo.tenant).is("archived_at", null).maybeSingle();
      if (!tenant) { showToast("Tenant not found: " + wo.tenant, "error"); return; }
      const classId = await getPropertyClassId(wo.property, companyId);
      const result = await atomicPostJEAndLedger({ companyId,
        date: formatLocalDate(new Date()),
        description: description,
        reference: "WO-BILL-" + shortId(),
        property: wo.property,
        lines: [
          { account_id: "1100", account_name: "Accounts Receivable", debit: amount, credit: 0, class_id: classId, memo: description },
          { account_id: "4100", account_name: "Other Income", debit: 0, credit: amount, class_id: classId, memo: "Tenant billback — " + wo.issue?.slice(0, 30) },
        ],
        ledgerEntry: { tenant: tenant.name, tenant_id: tenant.id, property: wo.property, date: formatLocalDate(new Date()), description: description, amount: amount, type: "charge", balance: 0 },
        balanceUpdate: { tenantId: tenant.id, amount: amount },
      });
      if (!result.jeId) return;
      showToast(`Billed ${formatCurrency(amount)} to ${tenant.name}.`, "success");
      addNotification("💰", `${formatCurrency(amount)} billed to ${tenant.name} for work order`);
      logAudit("create", "maintenance", `Billed tenant ${tenant.name} $${amount} for WO: ${wo.issue}`, wo.id, userProfile?.email, userRole, companyId);
    } finally { guardRelease("billTenant", wo.id); }
  }

  async function updateStatus(wo, newStatus) {
  const { error } = await supabase.from("work_orders").update({ status: newStatus }).eq("company_id", companyId).eq("id", wo.id);
  if (error) { pmError("PM-7005", { raw: error, context: "updating work order status" }); return; }
  // AUTO-POST TO ACCOUNTING when completed with a cost (with duplicate guard)
  if (newStatus === "completed" && safeNum(wo.cost) > 0) {
  const { data: existingWoJE } = await supabase.from("acct_journal_entries").select("id").eq("company_id", companyId).eq("reference", "WO-" + wo.id).limit(1);
  if (existingWoJE && existingWoJE.length > 0) { addNotification("⚠️", "Accounting entry already exists for this work order"); fetchWorkOrders(); return; }
  const classId = await getPropertyClassId(wo.property, companyId);
  const amt = safeNum(wo.cost);
  const _jeOk = await autoPostJournalEntry({
  companyId,
  date: formatLocalDate(new Date()),
  description: `Maintenance: ${wo.issue} — ${wo.property}`,
  reference: `WO-${wo.id}`,
  property: wo.property,
  lines: [
  { account_id: "5300", account_name: "Repairs & Maintenance", debit: amt, credit: 0, class_id: classId, memo: `${wo.issue} — ${wo.assigned || "unassigned"}` },
  { account_id: "1000", account_name: "Checking Account", debit: 0, credit: amt, class_id: classId, memo: `Paid for: ${wo.issue}` },
  ]
  });
  if (!_jeOk) { pmError("PM-4001", { raw: new Error("JE post failed"), context: "posting work order accounting entry" }); }

  }
  addNotification("🔧", `Work order "${wo.issue}" marked as ${newStatus.replace("_", " ")}`);
  logAudit("update", "maintenance", `Work order status: ${wo.issue} → ${newStatus}${safeNum(wo.cost) > 0 ? " ($" + safeNum(wo.cost) + ")" : ""}`, wo.id, userProfile?.email, userRole, companyId);
  // #24: Notify tenant when work order completed
  if (newStatus === "completed" && wo.tenant) {
  const { data: woT } = await supabase.from("tenants").select("email").eq("company_id", companyId).ilike("name", wo.tenant).maybeSingle();
  if (woT?.email) queueNotification("work_order_completed", woT.email, { tenant: wo.tenant, issue: wo.issue, property: wo.property }, companyId);
  }
  fetchWorkOrders();
  }

  function startEdit(w) {
  setEditingWO(w);
  setForm({ property: w.property, tenant: w.tenant, issue: w.issue, priority: w.priority, status: w.status, assigned: w.assigned || "", cost: w.cost || 0, notes: w.notes || "" });
  setShowForm(true);
  }

  async function openPhotos(wo) {
  setViewingPhotos(wo);
  const { data } = await supabase.from("work_order_photos").select("*").eq("company_id", companyId).eq("work_order_id", wo.id).order("created_at", { ascending: false });
  // Resolve signed URLs for photos (handles both old public URLs and new file paths)
  const photos = await Promise.all((data || []).map(async (p) => {
  if (p.url && p.url.startsWith("http")) return p; // Old public URL — still works
  const bucket = p.storage_bucket || "maintenance-photos";
  const signedUrl = await getSignedUrl(bucket, p.url);
  return { ...p, url: signedUrl || p.url };
  }));
  setWoPhotos(photos);
  }

  async function uploadPhoto() {
  if (!guardSubmit("uploadPhoto")) return;
  try {
  const file = photoRef.current?.files?.[0];
  if (!file || !viewingPhotos) return;
  if (file.size > 10 * 1024 * 1024) { showToast("Photo must be under 10MB.", "error"); setUploadingPhoto(false); return; }
  const ALLOWED_PHOTO_TYPES = ["image/jpeg","image/png","image/gif","image/webp","image/heic","image/heif"];
  if (!ALLOWED_PHOTO_TYPES.includes(file.type) && !/\.(jpg|jpeg|png|gif|webp|heic|heif)$/i.test(file.name)) { showToast("Only image files are allowed (JPG, PNG, GIF, WebP, HEIC).", "error"); return; }
  setUploadingPhoto(true);
  const fileName = `wo_${viewingPhotos.id}_${shortId()}_${sanitizeFileName(file.name)}`;
  const { error: uploadError } = await supabase.storage.from("maintenance-photos").upload(fileName, file);
  if (uploadError) { pmError("PM-7006", { raw: uploadError, context: "uploading work order photo" }); setUploadingPhoto(false); return; }
  // Store file path (not public URL) — signed URLs generated on display
  const storagePath = fileName;
  const { error: _photoErr } = await supabase.from("work_order_photos").insert([{ work_order_id: viewingPhotos.id, property: viewingPhotos.property, url: storagePath, caption: file.name, company_id: companyId, storage_bucket: "maintenance-photos" }]);
  if (_photoErr) { pmError("PM-7007", { raw: _photoErr, context: "saving work order photo record" }); setUploadingPhoto(false); return; }
  addNotification("📸", `Photo uploaded for: ${viewingPhotos.issue}`);
  setUploadingPhoto(false);
  if (photoRef.current) photoRef.current.value = "";
  openPhotos(viewingPhotos);
  } finally { guardRelease("uploadPhoto"); }
  }

  async function deletePhoto(id) {
  if (!guardSubmit("deletePhoto")) return;
  try {
  // Photos DO have company_id — delete is scoped to current company
  const { error: _photoDelErr } = await supabase.from("work_order_photos").delete().eq("company_id", companyId).eq("id", id);
  if (_photoDelErr) { pmError("PM-7008", { raw: _photoDelErr, context: "deleting work order photo" }); return; }
  openPhotos(viewingPhotos);
  } finally { guardRelease("deletePhoto"); }
  }

  if (loading) return <Spinner />;

  const filtered = workOrders.filter(w => {
  if (filter !== "all" && w.status !== filter && w.priority !== filter) return false;
  if (woFilterProp !== "all" && w.property !== woFilterProp) return false;
  if (woFilterAssigned !== "all") {
  if (woFilterAssigned === "_unassigned" && w.assigned) return false;
  if (woFilterAssigned !== "_unassigned" && w.assigned !== woFilterAssigned) return false;
  }
  if (woSearch) {
  const q = woSearch.toLowerCase();
  if (!w.issue?.toLowerCase().includes(q) && !w.property?.toLowerCase().includes(q) && !w.tenant?.toLowerCase().includes(q) && !w.assigned?.toLowerCase().includes(q)) return false;
  }
  return true;
  });

  return (
  <div>
  {viewingPhotos && (
  <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
  <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
  <div className="flex items-center justify-between px-6 py-4 border-b border-brand-50 sticky top-0 bg-white">
  <div><h3 className="font-bold text-neutral-800">📸 Photos — {viewingPhotos.issue}</h3><p className="text-xs text-neutral-400">{viewingPhotos.property}</p></div>
  <TextLink tone="neutral" size="xl" underline={false} onClick={() => setViewingPhotos(null)}>✕</TextLink>
  </div>
  <div className="p-6">
  <div className="bg-brand-50/30 rounded-3xl p-4 mb-4">
  <div className="text-xs font-semibold text-neutral-500 mb-2">Upload New Photo</div>
  <div className="flex gap-2">
  <Input type="file" accept="image/*" ref={photoRef} className="flex-1" />
  <Btn onClick={uploadPhoto} disabled={uploadingPhoto}>{uploadingPhoto ? "Uploading..." : "Upload"}</Btn>
  </div>
  </div>
  {woPhotos.length === 0 ? (
  <div className="text-center py-8 text-neutral-400">No photos yet.</div>
  ) : (
  <div className="grid grid-cols-2 gap-3">
  {woPhotos.map(p => (
  <div key={p.id} className="relative group rounded-3xl overflow-hidden border border-brand-50">
  <img src={p.url} alt={p.caption} className="w-full h-40 object-cover" />
  <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-40 transition-all flex items-center justify-center">
  <Btn variant="danger-fill" onClick={() => deletePhoto(p.id)} className="opacity-0 group-hover:opacity-100">Delete</Btn>
  </div>
  <div className="p-2 text-xs text-neutral-400 truncate">{p.caption}</div>
  </div>
  ))}
  </div>
  )}
  </div>
  </div>
  </div>
  )}
  <div className="flex flex-col md:flex-row md:items-center justify-between mb-5 gap-2">
  <PageHeader title="Maintenance" />
  <div className="flex items-center gap-2">
  <Btn variant="secondary" onClick={exportWorkOrders}><span className="material-icons-outlined text-sm align-middle mr-1">download</span>Export</Btn>
  </div>
  <div className="flex gap-1 overflow-x-auto pb-1">
  {[["workorders", "Work Orders"], ["inspections", "Inspections"], ["vendors", "Vendors"], ["archived", "Archived"]].map(([id, label]) => (
  <FilterPill key={id} active={maintTab === id} onClick={() => setMaintTab(id)}>{label}</FilterPill>
  ))}
  </div>
  </div>

  {maintTab === "archived" && (
  <ArchivedItems tableName="work_orders" label="Work Order" fields="id, issue, property, status, priority, archived_at, archived_by" companyId={companyId} addNotification={addNotification} showConfirm={showConfirm} userProfile={userProfile} userRole={userRole} onRestore={() => { fetchWorkOrders(); }} />
  )}
  {maintTab === "inspections" && <Inspections addNotification={addNotification} userProfile={userProfile} userRole={userRole} companyId={companyId} showToast={showToast} showConfirm={showConfirm} />}
  {maintTab === "vendors" && <VendorManagement addNotification={addNotification} userProfile={userProfile} userRole={userRole} companyId={companyId} />}
  {maintTab === "workorders" && (<>
  <div className="flex items-center justify-between mb-4">
  <div></div>
  <Btn onClick={() => { setEditingWO(null); setForm({ property: "", tenant: "", issue: "", priority: "normal", status: "open", assigned: "", cost: 0, notes: "" }); setShowForm(!showForm); }}>+ New Work Order</Btn>
  </div>

  {showForm && (
  <div className="bg-white rounded-xl border border-brand-100 shadow-sm p-4 mb-4">
  <h3 className="font-semibold text-neutral-700 mb-3">{editingWO ? "Edit Work Order" : "New Work Order"}</h3>
  <div className="grid grid-cols-2 gap-3">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Property *</label><PropertySelect value={form.property} onChange={(v, prop) => {
  setForm({ ...form, property: v, tenant: prop?.tenant || "" });
  }} companyId={companyId} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Tenant</label><Input placeholder={form.property && !form.tenant ? "Vacant — no tenant" : "Tenant name"} value={form.tenant} onChange={e => setForm({ ...form, tenant: e.target.value })} className={"border rounded-lg px-3 py-2 text-sm w-full " + (!form.tenant && form.property ? "border-subtle-100 bg-brand-50/30 text-neutral-400" : "border-brand-100")} readOnly={!!(form.property && !form.tenant)} /></div>
  <div className="col-span-2"><label className="text-xs font-medium text-neutral-400 mb-1 block">Issue *</label><Input placeholder="Describe the maintenance issue" value={form.issue} onChange={e => setForm({ ...form, issue: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Priority</label><Select value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}>
  {["normal", "emergency", "low"].map(p => <option key={p}>{p}</option>)}
  </Select></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Status</label><Select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
  {["open", "in_progress", "completed"].map(s => <option key={s}>{s}</option>)}
  </Select></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Assigned To</label><Input placeholder="Vendor or staff name" value={form.assigned} onChange={e => setForm({ ...form, assigned: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Cost ($)</label><Input placeholder="0.00" type="number" value={form.cost} onChange={e => setForm({ ...form, cost: e.target.value })} /></div>
  <div className="col-span-2"><label className="text-xs font-medium text-neutral-400 mb-1 block">Notes</label><Textarea placeholder="Completion details, parts used, etc." value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="border border-brand-100 rounded-xl px-3 py-1.5 text-sm w-full" rows={2} /></div>
  </div>
  <div className="flex gap-2 mt-3">
  <Btn onClick={saveWorkOrder}>Save</Btn>
  <Btn variant="slate" onClick={() => { setShowForm(false); setEditingWO(null); }}>Cancel</Btn>
  </div>
  </div>
  )}

  <div className="flex flex-wrap gap-2 mb-4">
  {["all", "open", "in_progress", "completed", "emergency"].map(s => (
  <FilterPill key={s} active={filter === s} onClick={() => setFilter(s)}><span className="capitalize">{s.replace("_", " ")}</span></FilterPill>
  ))}
  <div className="flex-1" />
  <Input placeholder="Search issue, property, tenant..." value={woSearch} onChange={e => setWoSearch(e.target.value)} className="w-64" />
  <Select filter value={woFilterProp} onChange={e => setWoFilterProp(e.target.value)} className="py-1.5">
  <option value="all">All Properties</option>
  {[...new Set(workOrders.map(w => w.property).filter(Boolean))].sort().map(p => <option key={p} value={p}>{p.length > 30 ? p.slice(0, 30) + "..." : p}</option>)}
  </Select>
  <Select filter value={woFilterAssigned} onChange={e => setWoFilterAssigned(e.target.value)} className="py-1.5">
  <option value="all">All Assigned</option><option value="_unassigned">Unassigned</option>
  {[...new Set(workOrders.map(w => w.assigned).filter(Boolean))].sort().map(a => <option key={a} value={a}>{a}</option>)}
  </Select>
  </div>
  <div className="text-xs text-neutral-400 mb-3">{filtered.length} of {workOrders.length} work orders</div>
  {/* WO Bulk Action Bar */}
  {selectedWOs.size > 0 && (
  <div className="bg-brand-50 border border-brand-200 rounded-2xl px-4 py-3 mb-3 flex items-center justify-between">
  <span className="text-sm font-medium text-brand-800">{selectedWOs.size} work order{selectedWOs.size > 1 ? "s" : ""} selected</span>
  <div className="flex gap-2">
  <Btn variant="purple" size="sm" onClick={() => bulkUpdateWOStatus("in_progress")}>In Progress</Btn>
  <Btn variant="success" size="sm" onClick={() => bulkUpdateWOStatus("completed")}>Complete</Btn>
  <Btn variant="slate" size="sm" onClick={() => bulkUpdateWOStatus("open")}>Reopen</Btn>
  <TextLink tone="neutral" size="xs" underline={false} onClick={() => setSelectedWOs(new Set())} className="px-3 py-1.5 rounded-lg hover:bg-neutral-100">Deselect</TextLink>
  </div>
  </div>
  )}
  <div className="space-y-3">
  {filtered.map(w => (
  <div key={w.id} className={"bg-white rounded-3xl shadow-card border p-4 " + (selectedWOs.has(w.id) ? "border-brand-300 ring-1 ring-brand-200" : "border-brand-50")}>
  <div className="flex justify-between items-start">
  <div className="flex items-start gap-3">
  <Checkbox checked={selectedWOs.has(w.id)} onChange={e => { const s = new Set(selectedWOs); e.target.checked ? s.add(w.id) : s.delete(w.id); setSelectedWOs(s); }} className="mt-1.5 accent-brand-600" />
  <div>
  <div className="flex items-center gap-2">
  <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${priorityColors[w.priority]}`}>{w.priority}</span>
  <span className="font-semibold text-neutral-800">{w.issue}</span>
  </div>
  <div className="text-xs text-neutral-400 mt-1">{w.property} · {w.tenant}{!w.assigned && w.tenant && <span className="ml-1 text-xs bg-warn-100 text-warn-700 px-1.5 py-0.5 rounded-full">Tenant Request</span>}</div>
  </div>
  </div>
  <Badge status={w.status} label={w.status?.replace("_", " ")} />
  </div>
  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
  <div><span className="text-neutral-400">Assigned</span><div className="font-semibold text-neutral-700">{w.assigned || "Unassigned"}</div></div>
  <div><span className="text-neutral-400">Created</span><div className="font-semibold text-neutral-700">{w.created || "—"}</div></div>
  <div><span className="text-neutral-400">Cost</span><div className="font-semibold text-neutral-700">{w.cost ? `${formatCurrency(w.cost)}` : "—"}</div></div>
  </div>
  {w.notes && <div className="mt-2 text-xs text-neutral-400 italic">{w.notes}</div>}
  <div className="mt-3 flex gap-2 flex-wrap">
  {w.status === "open" && <Btn variant="purple" size="xs" onClick={() => updateStatus(w, "in_progress")}>▶ In Progress</Btn>}
  {w.status === "in_progress" && <TextLink tone="positive" size="xs" underline={false} onClick={() => updateStatus(w, "completed")} className="border border-positive-200 px-3 py-1 rounded-lg hover:bg-positive-50">✓ Complete</TextLink>}
  {w.status === "completed" && <TextLink tone="neutral" size="xs" underline={false} onClick={() => updateStatus(w, "open")} className="border border-brand-100 px-3 py-1 rounded-lg hover:bg-brand-50/30">↩ Reopen</TextLink>}
  {w.tenant && <TextLink tone="danger" size="xs" underline={false} onClick={() => billTenantForWO(w)} className="border border-danger-200 px-3 py-1 rounded-lg hover:bg-danger-50">💰 Bill Tenant</TextLink>}
  <Btn variant="purple" size="xs" onClick={() => openPhotos(w)}>📸 Photos</Btn>
  <Btn variant="secondary" size="xs" onClick={() => startEdit(w)}>✏️ Edit</Btn>
  </div>
  </div>
  ))}
  </div>
  </>)}
  </div>
  );
}

function Inspections({ addNotification, userProfile, userRole, companyId, showToast, showConfirm }) {
  function exportInspections() {
  exportToCSV(inspections, [
  { label: "Property", key: "property" },
  { label: "Type", key: "type" },
  { label: "Inspector", key: "inspector" },
  { label: "Date", key: "date" },
  { label: "Status", key: "status" },
  { label: "Notes", key: "notes" },
  ], "inspections_" + new Date().toLocaleDateString(), showToast);
  }
  const [inspections, setInspections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [selectedInspection, setSelectedInspection] = useState(null);
  const [form, setForm] = useState({ property: "", type: "Move-In", inspector: "", date: formatLocalDate(new Date()), status: "scheduled", notes: "" });

  const checklistTemplates = {
  "Move-In": ["Front door & locks", "Windows & screens", "Walls & ceilings", "Floors & carpets", "Kitchen appliances", "Bathrooms", "HVAC system", "Smoke detectors", "Garage/parking"],
  "Move-Out": ["Front door & locks", "Windows & screens", "Walls & ceilings", "Floors & carpets", "Kitchen appliances", "Bathrooms", "HVAC system", "Smoke detectors", "Cleaning condition"],
  "Periodic": ["Exterior condition", "Roof & gutters", "HVAC filter", "Plumbing leaks", "Electrical", "Smoke detectors", "Pest signs", "General cleanliness"],
  };

  const [checklist, setChecklist] = useState({});

  useEffect(() => { fetchInspections(); }, [companyId]);

  async function fetchInspections() {
  const { data } = await supabase.from("inspections").select("*").eq("company_id", companyId).order("date", { ascending: false });
  setInspections(data || []);
  setLoading(false);
  }

  async function saveInspection() {
  if (!guardSubmit("saveInspection")) return;
  try {
  if (!form.property.trim()) { showToast("Property is required.", "error"); return; }
  if (!form.date) { showToast("Inspection date is required.", "error"); return; }
  const { error } = await supabase.from("inspections").insert([{ ...form, checklist: JSON.stringify(checklist), company_id: companyId }]);
  if (error) { pmError("PM-7006", { raw: error, context: "save inspection" }); return; }
  addNotification("🔍", `Inspection scheduled: ${form.type} at ${form.property}`);
  setShowForm(false);
  setForm({ property: "", type: "Move-In", inspector: "", date: formatLocalDate(new Date()), status: "scheduled", notes: "" });
  setChecklist({});
  fetchInspections();
  } finally { guardRelease("saveInspection"); }
  }

  async function updateStatus(id, status) {
  const { error: usErr } = await supabase.from("inspections").update({ status }).eq("company_id", companyId).eq("id", id);
  if (usErr) { showToast("Error updating status: " + usErr.message, "error"); return; }
  fetchInspections();
  }

  function initChecklist(type) {
  const items = checklistTemplates[type] || [];
  const initial = {};
  items.forEach(item => { initial[item] = { pass: null, notes: "" }; });
  setChecklist(initial);
  }

  if (loading) return <Spinner />;

  return (
  <div>
  {selectedInspection && (
  <Modal title={`Inspection — ${selectedInspection.property}`} onClose={() => setSelectedInspection(null)}>
  <div className="space-y-2 mb-4">
  <div className="flex justify-between text-sm"><span className="text-neutral-400">Type</span><span className="font-medium">{selectedInspection.type}</span></div>
  <div className="flex justify-between text-sm"><span className="text-neutral-400">Date</span><span className="font-medium">{selectedInspection.date}</span></div>
  <div className="flex justify-between text-sm"><span className="text-neutral-400">Inspector</span><span className="font-medium">{selectedInspection.inspector || "—"}</span></div>
  <div className="flex justify-between text-sm"><span className="text-neutral-400">Status</span><Badge status={selectedInspection.status} /></div>
  </div>
  {selectedInspection.notes && <div className="bg-brand-50/30 rounded-lg p-3 text-sm text-neutral-500 mb-4">{selectedInspection.notes}</div>}
  {selectedInspection.checklist && (() => {
  try {
  const cl = JSON.parse(selectedInspection.checklist);
  return (
  <div>
  <h4 className="font-semibold text-neutral-700 mb-2 text-sm">Checklist</h4>
  <div className="space-y-1">
  {Object.entries(cl).map(([item, val]) => (
  <div key={item} className="flex items-center justify-between text-sm py-1 border-b border-brand-50/50">
  <span className="text-neutral-700">{item}</span>
  <span className={val.pass === true ? "text-positive-600 font-semibold" : val.pass === false ? "text-danger-500 font-semibold" : "text-neutral-400"}>
  {val.pass === true ? "✓ Pass" : val.pass === false ? "✗ Fail" : "—"}
  </span>
  </div>
  ))}
  </div>
  </div>
  );
  } catch { return null; }
  })()}
  </Modal>
  )}

  <div className="flex items-center justify-between mb-5">
  <PageHeader title="Inspections" />
  <div className="flex gap-2">
  <Btn variant="secondary" onClick={exportInspections}><span className="material-icons-outlined text-sm align-middle mr-1">download</span>Export</Btn>
  <Btn onClick={() => { setShowForm(!showForm); initChecklist("Move-In"); }}>+ New Inspection</Btn>
  </div>
  </div>

  {showForm && (
  <div className="bg-white rounded-xl border border-brand-100 shadow-sm p-4 mb-4">
  <h3 className="font-semibold text-neutral-700 mb-3">New Inspection</h3>
  <div className="grid grid-cols-2 gap-3 mb-4">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Property *</label><PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} companyId={companyId} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Inspection Type</label><Select value={form.type} onChange={e => { setForm({ ...form, type: e.target.value }); initChecklist(e.target.value); }}>
  {["Move-In", "Move-Out", "Periodic"].map(t => <option key={t}>{t}</option>)}
  </Select></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Inspector</label><Input placeholder="Inspector name" value={form.inspector} onChange={e => setForm({ ...form, inspector: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Date</label><Input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} /></div>
  <div className="col-span-2"><label className="text-xs font-medium text-neutral-400 mb-1 block">Notes</label><Textarea placeholder="General notes about the inspection" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="border border-brand-100 rounded-xl px-3 py-1.5 text-sm w-full" rows={2} /></div>
  </div>

  {/* Checklist */}
  <h4 className="font-semibold text-neutral-700 mb-2 text-sm">Checklist Items</h4>
  <div className="space-y-2 mb-4">
  {Object.entries(checklist).map(([item, val]) => (
  <div key={item} className="flex items-center gap-3 bg-brand-50/30 rounded-lg px-3 py-2">
  <span className="text-sm text-neutral-700 flex-1">{item}</span>
  <button onClick={() => setChecklist({ ...checklist, [item]: { ...val, pass: true } })} className={`text-xs px-2 py-1 rounded ${val.pass === true ? "bg-positive-500 text-white" : "bg-neutral-200 text-neutral-500"}`}>Pass</button>
  <button onClick={() => setChecklist({ ...checklist, [item]: { ...val, pass: false } })} className={`text-xs px-2 py-1 rounded ${val.pass === false ? "bg-danger-500 text-white" : "bg-neutral-200 text-neutral-500"}`}>Fail</button>
  <Input placeholder="Note" value={val.notes} onChange={e => setChecklist({ ...checklist, [item]: { ...val, notes: e.target.value } })} className="border border-brand-100 rounded px-2 py-1 text-xs w-32" />
  </div>
  ))}
  </div>

  <div className="flex gap-2">
  <Btn onClick={saveInspection}>Save Inspection</Btn>
  <Btn variant="slate" onClick={() => setShowForm(false)}>Cancel</Btn>
  </div>
  </div>
  )}

  <div className="space-y-3">
  {inspections.map(insp => (
  <div key={insp.id} className="bg-white rounded-3xl shadow-card border border-brand-50 p-4">
  <div className="flex justify-between items-start">
  <div>
  <div className="font-semibold text-neutral-800">{insp.property}</div>
  <div className="text-xs text-neutral-400 mt-0.5">{insp.type} Inspection · {insp.inspector}</div>
  </div>
  <Badge status={insp.status} label={insp.status} />
  </div>
  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
  <div><span className="text-neutral-400">Date</span><div className="font-semibold text-neutral-700">{insp.date}</div></div>
  <div><span className="text-neutral-400">Type</span><div className="font-semibold text-neutral-700">{insp.type}</div></div>
  </div>
  <div className="mt-3 flex gap-2 flex-wrap">
  <Btn variant="secondary" size="xs" onClick={() => setSelectedInspection(insp)}>📋 View Report</Btn>
  {insp.status === "scheduled" && <Btn variant="success-fill" size="xs" onClick={() => updateStatus(insp.id, "completed")}>✓ Mark Complete</Btn>}
  {insp.status === "completed" && <Btn variant="warning-fill" size="xs" onClick={async () => {
  if (!guardSubmit("woFromInsp", insp.id)) return;
  try {
  const items = (() => { try { return JSON.parse(insp.items || "{}"); } catch { return {}; } })();
  const failed = Object.entries(items).filter(([, v]) => v.pass === false).map(([k]) => k);
  if (failed.length === 0) { showToast("No failed items in this inspection.", "info"); return; }
  if (!await showConfirm({ message: `Create work order for ${failed.length} failed item(s)?\n\n${failed.join(", ")}` })) return;
  // Find tenant at this property for the WO
  const { data: propTenant } = await supabase.from("tenants").select("name").eq("company_id", companyId).eq("property", insp.property).is("archived_at", null).eq("lease_status", "active").maybeSingle();
  const { error } = await supabase.from("work_orders").insert([{ company_id: companyId, property: insp.property, tenant: propTenant?.name || "", issue: `Inspection findings: ${failed.join(", ")}`, priority: "normal", status: "open", created: formatLocalDate(new Date()), notes: `Auto-created from ${insp.type} inspection on ${insp.date}` }]);
  if (error) { pmError("PM-7001", { raw: error, context: "create work order from inspection" }); return; }
  showToast("Work order created. Go to Maintenance to view it.", "success");
  addNotification("🔧", `Work order created from inspection at ${insp.property}`);
  } finally { guardRelease("woFromInsp", insp.id); }
  }}><span className="material-icons-outlined text-xs align-middle">build</span> Create Work Order</Btn>}
  </div>
  </div>
  ))}
  {inspections.length === 0 && <div className="text-center py-12 text-neutral-400">No inspections yet. Create one above.</div>}
  </div>
  </div>
  );
}

function VendorManagement({ addNotification, userProfile, userRole, companyId, showToast, showConfirm }) {
  const [vendors, setVendors] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [workOrders, setWorkOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("vendors");
  const [showForm, setShowForm] = useState(false);
  const [showInvoiceForm, setShowInvoiceForm] = useState(false);
  const [editingVendor, setEditingVendor] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterSpecialty, setFilterSpecialty] = useState("all");

  const specialties = ["General","Plumbing","Electrical","HVAC","Roofing","Painting","Landscaping","Carpentry","Appliance Repair","Cleaning","Pest Control","Locksmith","Flooring","Drywall","Windows","Other"];

  const [form, setForm] = useState({
  name: "", first_name: "", mi: "", last_name: "", company: "", email: "", phone: "", address: "",
  specialty: "General", license_number: "", insurance_expiry: "",
  hourly_rate: "", flat_rate: "", notes: "", status: "active",
  });

  const [invoiceForm, setInvoiceForm] = useState({
  vendor_id: "", vendor_name: "", work_order_id: "", property: "",
  description: "", amount: "", invoice_number: "", invoice_date: formatLocalDate(new Date()),
  due_date: "", payment_method: "", notes: "",
  });

  useEffect(() => { fetchData(); }, [companyId]);

  async function fetchData() {
  setLoading(true);
  const [v, inv, wo] = await Promise.all([
  supabase.from("vendors").select("*").eq("company_id", companyId).is("archived_at", null).order("name"),
  supabase.from("vendor_invoices").select("*").eq("company_id", companyId).order("created_at", { ascending: false }),
  supabase.from("work_orders").select("*").eq("company_id", companyId).is("archived_at", null).order("created", { ascending: false }).limit(100),
  ]);
  setVendors(v.data || []);
  setInvoices(inv.data || []);
  setWorkOrders(wo.data || []);
  setLoading(false);
  }

  async function saveVendor() {
  if (!guardSubmit("saveVendor")) return;
  try {
  if (!form.name) { showToast("Vendor name is required.", "error"); return; }
  if (form.hourly_rate && (isNaN(Number(form.hourly_rate)) || Number(form.hourly_rate) < 0)) { showToast("Hourly rate must be a valid positive number.", "error"); return; }
  if (form.flat_rate && (isNaN(Number(form.flat_rate)) || Number(form.flat_rate) < 0)) { showToast("Flat rate must be a valid positive number.", "error"); return; }
  const payload = {
  ...form,
  hourly_rate: Number(form.hourly_rate || 0),
  flat_rate: Number(form.flat_rate || 0),
  insurance_expiry: form.insurance_expiry || null,
  middle_initial: form.mi,
  };
  let error;
  if (editingVendor) {
  ({ error } = await supabase.from("vendors").update({ name: payload.name, first_name: payload.first_name, middle_initial: payload.middle_initial, last_name: payload.last_name, company: payload.company, email: normalizeEmail(payload.email), phone: payload.phone, address: payload.address, specialty: payload.specialty, license_number: payload.license_number, insurance_expiry: payload.insurance_expiry, hourly_rate: payload.hourly_rate, flat_rate: payload.flat_rate, notes: payload.notes, status: payload.status }).eq("id", editingVendor.id).eq("company_id", companyId));
  } else {
  const { mi: _mi, ...insertPayload } = payload;
  ({ error } = await supabase.from("vendors").insert([{ ...insertPayload, email: normalizeEmail(payload.email), company_id: companyId }]));
  }
  if (error) { pmError("PM-8006", { raw: error, context: editingVendor ? "update vendor" : "create vendor" }); return; }
  logAudit(editingVendor ? "update" : "create", "vendors", (editingVendor ? "Updated" : "Added") + " vendor: " + form.name, editingVendor?.id || "", userProfile?.email, userRole, companyId);
  resetVendorForm();
  fetchData();
  } finally { guardRelease("saveVendor"); }
  }

  function resetVendorForm() {
  setShowForm(false);
  setEditingVendor(null);
  setForm({ name: "", first_name: "", mi: "", last_name: "", company: "", email: "", phone: "", address: "", specialty: "General", license_number: "", insurance_expiry: "", hourly_rate: "", flat_rate: "", notes: "", status: "active" });
  }

  function startEditVendor(v) {
  setEditingVendor(v);
  const parsed = parseNameParts(v.name);
  setForm({ name: v.name, first_name: v.first_name || parsed.first_name, mi: v.middle_initial || parsed.middle_initial, last_name: v.last_name || parsed.last_name, company: v.company || "", email: v.email || "", phone: v.phone || "", address: v.address || "", specialty: v.specialty || "General", license_number: v.license_number || "", insurance_expiry: v.insurance_expiry || "", hourly_rate: String(v.hourly_rate || ""), flat_rate: String(v.flat_rate || ""), notes: v.notes || "", status: v.status || "active" });
  setShowForm(true);
  }

  async function deleteVendor(id, name) {
  if (!guardSubmit("deleteVendor")) return;
  try {
  if (!await showConfirm({ message: "Delete vendor " + name + "?", variant: "danger", confirmText: "Delete" })) return;
  await supabase.from("vendors").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email }).eq("id", id).eq("company_id", companyId);
  logAudit("delete", "vendors", "Archived vendor: " + name, id, userProfile?.email, userRole, companyId);
  fetchData();
  } finally { guardRelease("deleteVendor"); }
  }

  async function saveInvoice() {
  if (!guardSubmit("saveInvoice")) return;
  try {
  if (!invoiceForm.vendor_id) { showToast("Please select a vendor.", "error"); return; }
  if (!invoiceForm.amount || isNaN(Number(invoiceForm.amount)) || Number(invoiceForm.amount) <= 0) { showToast("Please enter a valid positive amount.", "error"); return; }
  const invDate = invoiceForm.invoice_date || formatLocalDate(new Date());
  if (invoiceForm.due_date && invoiceForm.due_date < invDate) { showToast("Due date cannot be before invoice date.", "error"); return; }
  // Clean empty strings for UUID columns to avoid "invalid input syntax for type uuid"
  const cleanForm = { ...invoiceForm };
  if (!cleanForm.work_order_id) delete cleanForm.work_order_id;
  if (!cleanForm.vendor_id) delete cleanForm.vendor_id;
  const { error } = await supabase.from("vendor_invoices").insert([{
  ...cleanForm,
  vendor_id: invoiceForm.vendor_id,
  amount: Number(invoiceForm.amount),
  due_date: invoiceForm.due_date || null,
  invoice_date: invDate,
  status: "pending",
  company_id: companyId,
  }]);
  if (error) { pmError("PM-8006", { raw: error, context: "save vendor invoice" }); return; }
  logAudit("create", "vendor_invoices", "Invoice: $" + invoiceForm.amount + " from " + invoiceForm.vendor_name, "", userProfile?.email, userRole, companyId);
  setShowInvoiceForm(false);
  setInvoiceForm({ vendor_id: "", vendor_name: "", work_order_id: "", property: "", description: "", amount: "", invoice_number: "", invoice_date: formatLocalDate(new Date()), due_date: "", payment_method: "", notes: "" });
  fetchData();
  } finally { guardRelease("saveInvoice"); }
  }

  async function payInvoice(inv) {
  if (!guardSubmit("payInvoice")) return;
  try {
  if (inv.status === "paid") { showToast("This invoice is already paid.", "error"); return; }
  if (!await showConfirm({ message: "Mark invoice #" + (inv.invoice_number || inv.id.slice(0,8)) + " as paid ($" + inv.amount + ")?" })) return;
  const today = formatLocalDate(new Date());
  const { error: invErr } = await supabase.from("vendor_invoices").update({ status: "paid", paid_date: today }).eq("company_id", companyId).eq("id", inv.id);
  if (invErr) { showToast("Error marking invoice as paid: " + invErr.message, "error"); return; }
  // Update vendor total_paid
  const vendor = vendors.find(v => String(v.id) === String(inv.vendor_id));
  if (vendor) {
  // Atomic increment via RPC (prevents concurrent update race)
  try {
  const { error: incErr } = await supabase.rpc("increment_vendor_totals", {
  p_company_id: companyId, p_vendor_id: String(vendor.id), p_amount: safeNum(inv.amount)
  });
  if (incErr) throw new Error(incErr.message);
  } catch (rpcE) {
  pmError("PM-8006", { raw: rpcE, context: "vendor increment RPC fallback", silent: true });
  const { data: freshVendor } = await supabase.from("vendors").select("total_paid, total_jobs").eq("company_id", companyId).eq("id", vendor.id).maybeSingle();
  if (freshVendor) {
  const { error: _vendErr } = await supabase.from("vendors").update({
  total_paid: safeNum(freshVendor.total_paid) + safeNum(inv.amount),
  total_jobs: (freshVendor.total_jobs || 0) + 1,
  }).eq("company_id", companyId).eq("id", vendor.id);
  if (_vendErr) pmError("PM-8006", { raw: _vendErr, context: "vendor totals fallback update", silent: true });
  }
  }
  }
  // Post to accounting
  const classId = await getPropertyClassId(inv.property, companyId);
  const _jeOk = await autoPostJournalEntry({
  companyId,
  date: today,
  description: "Vendor payment — " + inv.vendor_name + " — " + (inv.description || inv.invoice_number),
  reference: "VINV-" + shortId(),
  property: inv.property || "",
  lines: [
  { account_id: "5300", account_name: "Repairs & Maintenance", debit: safeNum(inv.amount), credit: 0, class_id: classId, memo: inv.vendor_name + ": " + inv.description },
  { account_id: "1000", account_name: "Checking Account", debit: 0, credit: safeNum(inv.amount), class_id: classId, memo: "Payment to " + inv.vendor_name },
  ]
  });
  if (!_jeOk) { showToast("Accounting entry failed. The transaction was recorded but the journal entry could not be posted. Please check the accounting module.", "error"); }
  
  logAudit("update", "vendor_invoices", "Paid invoice: $" + inv.amount + " to " + inv.vendor_name, inv.id, userProfile?.email, userRole, companyId);
  fetchData();
  } finally { guardRelease("payInvoice"); }
  }

  async function rateVendor(vendor, rating) {
  const { error } = await supabase.from("vendors").update({ rating }).eq("company_id", companyId).eq("id", vendor.id);
  if (error) { pmError("PM-8006", { raw: error, context: "update vendor rating" }); return; }
  fetchData();
  }

  if (loading) return <Spinner />;

  const activeVendors = vendors.filter(v => v.status === "active" || v.status === "preferred");
  const pendingInvoices = invoices.filter(i => i.status === "pending" || i.status === "approved");
  const totalOwed = pendingInvoices.reduce((s, i) => s + safeNum(i.amount), 0);
  const totalPaidAll = invoices.filter(i => i.status === "paid").reduce((s, i) => s + safeNum(i.amount), 0);
  const insuranceExpiring = vendors.filter(v => {
  if (!v.insurance_expiry) return false;
  const days = Math.ceil((parseLocalDate(v.insurance_expiry) - new Date()) / 86400000);
  return days <= 30 && days > 0;
  });

  const filteredVendors = vendors.filter(v =>
  (filterSpecialty === "all" || v.specialty === filterSpecialty) &&
  (!searchTerm || v.name.toLowerCase().includes(searchTerm.toLowerCase()) || (v.company || "").toLowerCase().includes(searchTerm.toLowerCase()) || (v.specialty || "").toLowerCase().includes(searchTerm.toLowerCase()))
  );

  return (
  <div>
  <div className="flex justify-between items-center mb-5">
  <PageHeader title="Vendor Management" />
  <div className="flex gap-2">
  <Btn variant="secondary" size="xs" onClick={() => setShowInvoiceForm(true)}>+ Invoice</Btn>
  <Btn onClick={() => { resetVendorForm(); setShowForm(true); }}>+ New Vendor</Btn>
  </div>
  </div>

  <div className="grid grid-cols-2 gap-3 mb-5 md:grid-cols-4">
  <StatCard label="Active Vendors" value={activeVendors.length} color="text-positive-600" sub="available" />
  <StatCard label="Pending Invoices" value={pendingInvoices.length} color={pendingInvoices.length > 0 ? "text-warn-600" : "text-neutral-400"} sub={"$" + totalOwed.toLocaleString() + " owed"} />
  <StatCard label="Total Paid (YTD)" value={"$" + totalPaidAll.toLocaleString()} color="text-info-600" sub="all vendors" />
  <StatCard label="Insurance Alerts" value={insuranceExpiring.length} color={insuranceExpiring.length > 0 ? "text-danger-500" : "text-neutral-400"} sub="expiring < 30d" />
  </div>

  {insuranceExpiring.length > 0 && (
  <div className="bg-danger-50 border border-danger-200 rounded-xl p-3 mb-4">
  <div className="font-semibold text-danger-800 text-sm mb-1">Insurance Expiring Soon</div>
  {insuranceExpiring.map(v => (
  <div key={v.id} className="text-xs text-danger-700">{v.name} ({v.specialty}) — expires {v.insurance_expiry}</div>
  ))}
  </div>
  )}

  <div className="flex gap-1 mb-4 border-b border-brand-50">
  {[["vendors","Vendors"],["invoices","Invoices"]].map(([id,label]) => (
  <button key={id} onClick={() => setActiveTab(id)} className={"px-4 py-2 text-sm font-medium border-b-2 " + (activeTab === id ? "border-brand-600 text-brand-700" : "border-transparent text-neutral-400")}>{label}</button>
  ))}
  </div>

  {/* New Vendor Form */}
  {showForm && (
  <div className="bg-white rounded-xl border border-brand-100 shadow-sm p-5 mb-5">
  <div className="flex items-center justify-between mb-4"><h3 className="font-manrope font-semibold text-neutral-800">{editingVendor ? "Edit Vendor" : "Add New Vendor"}</h3><Btn variant="ghost" onClick={resetVendorForm} title="Close">✕</Btn></div>
  <div className="grid grid-cols-2 gap-3 mb-4">
  <div className="col-span-2"><div className="grid grid-cols-6 gap-3">
  <div className="col-span-2"><label className="text-xs font-medium text-neutral-400 mb-1 block">First Name *</label><Input value={form.first_name} onChange={e => { const v = e.target.value; setForm(f => ({ ...f, first_name: v, name: formatPersonName(v, f.mi, f.last_name) })); }} placeholder="First" /></div>
  <div className="col-span-1"><label className="text-xs font-medium text-neutral-400 mb-1 block">MI</label><Input maxLength={1} value={form.mi} onChange={e => { const v = e.target.value.toUpperCase(); setForm(f => ({ ...f, mi: v, name: formatPersonName(f.first_name, v, f.last_name) })); }} placeholder="M" className="text-center" /></div>
  <div className="col-span-3"><label className="text-xs font-medium text-neutral-400 mb-1 block">Last Name *</label><Input value={form.last_name} onChange={e => { const v = e.target.value; setForm(f => ({ ...f, last_name: v, name: formatPersonName(f.first_name, f.mi, v) })); }} placeholder="Last" /></div>
  </div></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Company</label><Input value={form.company} onChange={e => setForm({...form, company: e.target.value})} placeholder="ABC Plumbing LLC" /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Email</label><Input type="email" placeholder="vendor@company.com" value={form.email} onChange={e => setForm({...form, email: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Phone</label><Input type="tel" placeholder="(555) 123-4567" value={form.phone} onChange={e => setForm({...form, phone: formatPhoneInput(e.target.value)})} maxLength={14} /></div>
  <div className="col-span-2"><label className="text-xs font-medium text-neutral-400 mb-1 block">Address</label><Input placeholder="123 Main St, City, State ZIP" value={form.address} onChange={e => setForm({...form, address: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Specialty</label>
  <Select value={form.specialty} onChange={e => setForm({...form, specialty: e.target.value})} >
  {specialties.map(s => <option key={s} value={s}>{s}</option>)}
  </Select>
  </div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Status</label>
  <Select value={form.status} onChange={e => setForm({...form, status: e.target.value})} >
  <option value="active">Active</option><option value="preferred">Preferred</option><option value="inactive">Inactive</option><option value="blocked">Blocked</option>
  </Select>
  </div>
  <div><label className="text-xs text-neutral-400 mb-1 block">License #</label><Input placeholder="e.g. VA-12345" value={form.license_number} onChange={e => setForm({...form, license_number: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Insurance Expiry</label><Input type="date" value={form.insurance_expiry} onChange={e => setForm({...form, insurance_expiry: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Hourly Rate ($)</label><Input placeholder="0.00" type="number" value={form.hourly_rate} onChange={e => setForm({...form, hourly_rate: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Flat Rate ($)</label><Input placeholder="0.00" type="number" value={form.flat_rate} onChange={e => setForm({...form, flat_rate: e.target.value})} /></div>
  </div>
  <div className="mb-4"><label className="text-xs text-neutral-400 mb-1 block">Notes</label><Textarea value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} className="w-full border border-brand-100 rounded-xl px-3 py-1.5 text-sm" rows={2} /></div>
  <div className="flex gap-2">
  <Btn onClick={saveVendor}>{editingVendor ? "Update" : "Add Vendor"}</Btn>
  <Btn variant="ghost" onClick={resetVendorForm}>Cancel</Btn>
  </div>
  </div>
  )}

  {/* Invoice Form */}
  {showInvoiceForm && (
  <div className="bg-white rounded-xl border border-brand-100 shadow-sm p-5 mb-5">
  <div className="flex items-center justify-between mb-4"><h3 className="font-manrope font-semibold text-neutral-800">New Vendor Invoice</h3><Btn variant="ghost" onClick={() => setShowInvoiceForm(false)} title="Close">✕</Btn></div>
  <div className="grid grid-cols-2 gap-3 mb-4">
  <div><label className="text-xs text-neutral-400 mb-1 block">Vendor *</label>
  <Select value={invoiceForm.vendor_id} onChange={e => { const v = vendors.find(v => String(v.id) === String(e.target.value)); setInvoiceForm({...invoiceForm, vendor_id: e.target.value, vendor_name: v?.name || ""}); }} className="truncate">
  <option value="">Select vendor...</option>
  {vendors.filter(v => v.status !== "blocked").map(v => <option key={v.id} value={v.id}>{v.name} ({v.specialty})</option>)}
  </Select>
  </div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Property</label><PropertySelect value={invoiceForm.property} onChange={v => setInvoiceForm({...invoiceForm, property: v})} companyId={companyId} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Amount ($) *</label><Input type="number" min="0" step="0.01" placeholder="500.00" value={invoiceForm.amount} onChange={e => setInvoiceForm({...invoiceForm, amount: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Invoice #</label><Input placeholder="INV-001" value={invoiceForm.invoice_number} onChange={e => setInvoiceForm({...invoiceForm, invoice_number: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Invoice Date</label><Input type="date" value={invoiceForm.invoice_date} onChange={e => setInvoiceForm({...invoiceForm, invoice_date: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Due Date</label><Input type="date" value={invoiceForm.due_date} onChange={e => setInvoiceForm({...invoiceForm, due_date: e.target.value})} /></div>
  <div className="col-span-2"><label className="text-xs text-neutral-400 mb-1 block">Description</label><Input value={invoiceForm.description} onChange={e => setInvoiceForm({...invoiceForm, description: e.target.value})} placeholder="Plumbing repair at 123 Main St" /></div>
  </div>
  <div className="flex gap-2">
  <Btn onClick={saveInvoice}>Save Invoice</Btn>
  <Btn variant="ghost" onClick={() => setShowInvoiceForm(false)}>Cancel</Btn>
  </div>
  </div>
  )}

  {/* VENDORS TAB */}
  {activeTab === "vendors" && (
  <div>
  <div className="flex gap-2 mb-4">
  <Input placeholder="Search vendors..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="w-64" />
  <Select filter value={filterSpecialty} onChange={e => setFilterSpecialty(e.target.value)} >
  <option value="all">All Specialties</option>
  {specialties.map(s => <option key={s} value={s}>{s}</option>)}
  </Select>
  </div>
  <div className="space-y-3">
  {filteredVendors.map(v => {
  const insExpired = v.insurance_expiry && parseLocalDate(v.insurance_expiry) < new Date();
  const insExpiring = v.insurance_expiry && !insExpired && Math.ceil((parseLocalDate(v.insurance_expiry) - new Date()) / 86400000) <= 30;
  const sc = { active: "bg-positive-100 text-positive-700", preferred: "bg-brand-100 text-brand-700", inactive: "bg-neutral-100 text-neutral-400", blocked: "bg-danger-100 text-danger-700" };
  return (
  <div key={v.id} className="bg-white rounded-3xl shadow-card border border-brand-50 p-4">
  <div className="flex justify-between items-start mb-2">
  <div>
  <div className="text-sm font-bold text-neutral-800">{v.name}{v.company ? " — " + v.company : ""}</div>
  <div className="text-xs text-neutral-400">{v.specialty}{v.license_number ? " · Lic: " + v.license_number : ""}</div>
  </div>
  <div className="flex items-center gap-2">
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (sc[v.status] || "bg-neutral-100")}>{v.status}</span>
  {v.rating > 0 && <span className="text-xs text-warn-500">{"\u2605".repeat(v.rating)}{"\u2606".repeat(5 - v.rating)}</span>}
  </div>
  </div>
  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-2 md:grid-cols-4">
  {v.phone && <div><span className="text-neutral-400">Phone:</span> <span className="font-medium">{v.phone}</span></div>}
  {v.email && <div><span className="text-neutral-400">Email:</span> <span className="font-medium">{v.email}</span></div>}
  {v.hourly_rate > 0 && <div><span className="text-neutral-400">Rate:</span> <span className="font-medium">${v.hourly_rate}/hr</span></div>}
  {v.flat_rate > 0 && <div><span className="text-neutral-400">Flat:</span> <span className="font-medium">${v.flat_rate}</span></div>}
  <div><span className="text-neutral-400">Jobs:</span> <span className="font-medium">{v.total_jobs || 0}</span></div>
  <div><span className="text-neutral-400">Total Paid:</span> <span className="font-medium">${safeNum(v.total_paid).toLocaleString()}</span></div>
  {v.insurance_expiry && <div><span className="text-neutral-400">Insurance:</span> <span className={"font-medium " + (insExpired ? "text-danger-600" : insExpiring ? "text-warn-600" : "text-positive-600")}>{v.insurance_expiry}{insExpired ? " (EXPIRED)" : ""}</span></div>}
  </div>
  {v.notes && <div className="text-xs text-neutral-400 mb-2">{v.notes}</div>}
  <div className="flex flex-wrap gap-2 pt-2 border-t border-brand-50/50">
  <Btn variant="secondary" size="xs" onClick={() => startEditVendor(v)}>Edit</Btn>
  <Btn variant="danger" size="xs" onClick={() => deleteVendor(v.id, v.name)}>Delete</Btn>
  <div className="flex items-center gap-0.5 ml-2">
  {[1,2,3,4,5].map(star => (
  <button key={star} onClick={() => rateVendor(v, star)} className={"text-sm " + (star <= (v.rating || 0) ? "text-warn-400" : "text-neutral-300")}>{star <= (v.rating || 0) ? "\u2605" : "\u2606"}</button>
  ))}
  </div>
  </div>
  </div>
  );
  })}
  {filteredVendors.length === 0 && <div className="text-center py-10 text-neutral-400">No vendors found</div>}
  </div>
  </div>
  )}

  {/* INVOICES TAB */}
  {activeTab === "invoices" && (
  <div className="space-y-3">
  {invoices.map(inv => {
  const isOverdue = inv.status === "pending" && inv.due_date && parseLocalDate(inv.due_date) < new Date();
  const sc = { pending: "bg-warn-100 text-warn-700", approved: "bg-info-100 text-info-700", paid: "bg-positive-100 text-positive-700", disputed: "bg-danger-100 text-danger-700" };
  return (
  <div key={inv.id} className={"bg-white rounded-xl border shadow-sm p-4 " + (isOverdue ? "border-danger-200" : "border-brand-50")}>
  <div className="flex justify-between items-start mb-2">
  <div>
  <div className="text-sm font-bold text-neutral-800">{inv.vendor_name}</div>
  <div className="text-xs text-neutral-400">{inv.description || "Invoice"}{inv.invoice_number ? " #" + inv.invoice_number : ""}</div>
  </div>
  <div className="text-right">
  <div className="text-sm font-bold text-neutral-800">${safeNum(inv.amount).toLocaleString()}</div>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (sc[inv.status] || "bg-neutral-100")}>{isOverdue ? "OVERDUE" : inv.status}</span>
  </div>
  </div>
  <div className="grid grid-cols-2 gap-x-4 text-xs md:grid-cols-4">
  {inv.property && <div><span className="text-neutral-400">Property:</span> <span className="font-medium">{inv.property}</span></div>}
  <div><span className="text-neutral-400">Date:</span> <span className="font-medium">{inv.invoice_date}</span></div>
  {inv.due_date && <div><span className="text-neutral-400">Due:</span> <span className={"font-medium " + (isOverdue ? "text-danger-600" : "")}>{inv.due_date}</span></div>}
  {inv.paid_date && <div><span className="text-neutral-400">Paid:</span> <span className="font-medium text-positive-600">{inv.paid_date}</span></div>}
  </div>
  {(inv.status === "pending" || inv.status === "approved") && (
  <div className="flex gap-2 pt-2 mt-2 border-t border-brand-50/50">
  <Btn variant="success-fill" size="xs" onClick={() => payInvoice(inv)}>Mark Paid</Btn>
  </div>
  )}
  </div>
  );
  })}
  {invoices.length === 0 && <div className="text-center py-10 text-neutral-400">No invoices yet</div>}
  </div>
  )}
  </div>
  );
}

export { Maintenance, Inspections, VendorManagement };
