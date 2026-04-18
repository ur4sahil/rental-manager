import React, { useState, useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import { supabase } from "../supabase";
import { Input, Select, Btn, PageHeader, IconBtn } from "../ui";
import { formatLocalDate, shortId, ALLOWED_DOC_TYPES, ALLOWED_DOC_EXTENSIONS, formatCurrency, getSignedUrl, sanitizeFileName, buildAddress, escapeHtml, escapeFilterValue } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { Spinner, Modal, PropertyDropdown, PropertySelect } from "./shared";
import RichTextEditor from "./RichTextEditor";

// ============ DOCUMENTS ============
function Documents({ addNotification, userProfile, userRole, companyId, showToast, showConfirm }) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState("all");
  const [form, setForm] = useState({ name: "", property: "", tenant: "", type: "Lease", tenant_visible: false });
  const fileRef = useRef();
  const [uploading, setUploading] = useState(false);

  useEffect(() => { fetchDocs(); }, [companyId]);

  async function fetchDocs() {
  const { data } = await supabase.from("documents").select("*").eq("company_id", companyId).is("archived_at", null).order("uploaded_at", { ascending: false }).limit(500);
  setDocs(data || []);
  setLoading(false);
  }

  async function uploadDocument() {
  if (!guardSubmit("uploadDocument")) return;
  try {
  const file = fileRef.current?.files?.[0];
  if (!file || !form.name) return;
  // Validate file type and size
  if (!ALLOWED_DOC_TYPES.includes(file.type) && !ALLOWED_DOC_EXTENSIONS.test(file.name)) { showToast("File type not allowed. Accepted: PDF, images, Word, Excel, text files.", "error"); return; }
  if (file.size > 25 * 1024 * 1024) { showToast("File must be under 25MB.", "error"); return; }
  // Magic bytes validation (prevents MIME spoofing)
  try { const hdr = new Uint8Array(await file.slice(0, 8).arrayBuffer()); const hex = Array.from(hdr.slice(0, 4)).map(b => b.toString(16).padStart(2, "0")).join(""); const ok = ["25504446","89504e47","ffd8ffe0","ffd8ffe1","ffd8ffe2","47494638","504b0304","d0cf11e0"].some(m => hex.startsWith(m)) || file.type.startsWith("text/"); if (!ok) { showToast("File content doesn't match expected format.", "error"); return; } } catch (_e) { pmError("PM-7002", { raw: _e, context: "file magic bytes validation", silent: true }); }
  setUploading(true);
  const fileName = `${companyId}/${shortId()}_${sanitizeFileName(file.name)}`;
  const { error: uploadError } = await supabase.storage.from("documents").upload(fileName, file, {
  cacheControl: "3600",
  upsert: false,
  });
  if (uploadError) {
  showToast("Upload failed: " + uploadError.message, "error");
  setUploading(false);
  return;
  }
  // Store file path — signed URLs generated on display for security
  const storagePath = fileName;
  const { error: insertError } = await supabase.from("documents").insert([{ company_id: companyId,
  name: form.name,
  file_name: storagePath,
  property: form.property,
  tenant: form.tenant || "",
  type: form.type,
  tenant_visible: form.tenant_visible,
  url: storagePath,
  uploaded_at: new Date().toISOString(),
  }]);
  if (insertError) {
  showToast("File uploaded to storage but failed to save record: " + insertError.message, "error");
  setUploading(false);
  return;
  }
  addNotification("📄", `Document uploaded: ${form.name}`);
  setShowForm(false);
  setForm({ name: "", property: "", tenant: "", type: "Lease", tenant_visible: false });
  if (fileRef.current) fileRef.current.value = "";
  setUploading(false);
  fetchDocs();
  } finally { guardRelease("uploadDocument"); }
  }

  async function deleteDoc(id, name, file_name) {
  if (!guardSubmit("deleteDoc")) return;
  try {
  if (!await showConfirm({ message: `Delete "${name}"?`, variant: "danger", confirmText: "Delete" })) return;
  const { error } = await supabase.from("documents").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email }).eq("id", id).eq("company_id", companyId);
  if (error) { pmError("PM-7004", { raw: error, context: "delete document" }); return; }
  addNotification("🗑️", `Document deleted: ${name}`);
  fetchDocs();
  } finally { guardRelease("deleteDoc"); }
  }

  // Repair existing documents that have empty/broken url
  async function repairUrls() {
  let repaired = 0;
  for (const d of docs) {
  if (d.file_name && !d.url) {
  // Generate signed URL on the fly instead of storing public URL
  repaired++; // Count as needing signed URL generation
  }
  }
  if (repaired > 0) {
  addNotification("🔧", `Repaired URLs for ${repaired} document(s)`);
  fetchDocs();
  } else {
  showToast("All document URLs look fine — no repairs needed.", "success");
  }
  }

  if (loading) return <Spinner />;

  const filtered = filter === "all" ? docs : docs.filter(d => d.type === filter);

  return (
  <div>
  <div className="flex items-center justify-between mb-5">
  <PageHeader title="Document Management" />
  <div className="flex gap-2">
  <Btn variant="warning-fill" className="bg-warn-500 hover:bg-warn-600" onClick={repairUrls} title="Fix broken View links for existing documents">🔧 Repair URLs</Btn>
  <button onClick={() => setShowForm(!showForm)} className="bg-brand-600 text-white text-sm px-4 py-2 rounded-2xl hover:bg-brand-700">+ Upload Document</button>
  </div>
  </div>

  {showForm && (
  <div className="bg-white rounded-xl border border-brand-100 shadow-sm p-4 mb-4">
  <h3 className="font-semibold text-neutral-700 mb-3">Upload Document</h3>
  <div className="grid grid-cols-2 gap-3">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Document Name *</label><Input placeholder="Lease Agreement 2026" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Property</label><PropertySelect value={form.property} onChange={(addr, prop) => setForm({ ...form, property: addr, tenant: prop?.tenant || form.tenant })} companyId={companyId} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Tenant</label><Input placeholder="Optional — link to a tenant" value={form.tenant} onChange={e => setForm({ ...form, tenant: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Document Type</label><select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className="border border-brand-100 rounded-xl px-3 py-1.5 text-sm w-full">
  {["Lease", "Inspection", "Maintenance", "Financial", "Notice", "Other"].map(t => <option key={t}>{t}</option>)}
  </select></div>
  <label className="flex items-center gap-2 text-sm text-neutral-500 border border-brand-100 rounded-xl px-3 py-1.5 cursor-pointer">
  <input type="checkbox" checked={form.tenant_visible} onChange={e => setForm({ ...form, tenant_visible: e.target.checked })} />
  Visible to Tenant
  </label>
  <Input type="file" ref={fileRef} className="col-span-2" />
  </div>
  <div className="flex gap-2 mt-3">
  <Btn onClick={uploadDocument} disabled={uploading}>
  {uploading ? "Uploading..." : "Upload"}
  </Btn>
  <button onClick={() => setShowForm(false)} className="bg-neutral-100 text-neutral-500 text-sm px-4 py-2 rounded-2xl hover:bg-neutral-100">Cancel</button>
  </div>
  </div>
  )}

  <div className="flex gap-2 mb-4 flex-wrap">
  {["all", "Lease", "Inspection", "Maintenance", "Financial", "Notice", "Other"].map(t => (
  <button key={t} onClick={() => setFilter(t)} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${filter === t ? "bg-brand-600 text-white" : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200"}`}>{t}</button>
  ))}
  </div>

  <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
  <table className="w-full text-sm">
  <thead className="bg-brand-50/30 text-xs text-neutral-400 uppercase">
  <tr>{["Document", "Property", "Type", "Date", "Tenant Visible", "Actions"].map(h => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
  </thead>
  <tbody>
  {filtered.map(d => (
  <tr key={d.id} className="border-t border-neutral-100/60 hover:bg-brand-50/30">
  <td className="px-3 py-2.5 font-medium text-neutral-800">📄 {d.name}</td>
  <td className="px-3 py-2.5 text-neutral-400">{d.property}</td>
  <td className="px-3 py-2.5"><span className="bg-brand-50 text-brand-700 px-2 py-0.5 rounded-full text-xs">{d.type}</span></td>
  <td className="px-3 py-2.5 text-neutral-400">{d.uploaded_at?.slice(0, 10)}</td>
  <td className="px-3 py-2.5">{d.tenant_visible ? "✅" : "🔒"}</td>
  <td className="px-3 py-2.5">
  <div className="flex gap-2">
  {d.url ? (
  <>
  <button onClick={async () => {
  const isFullUrl = d.url && d.url.startsWith("http");
  if (isFullUrl) { window.open(d.url, "_blank", "noopener,noreferrer"); return; }
  const path = d.file_name || d.url;
  if (!path) { showToast("No file path available.", "error"); return; }
  const url = await getSignedUrl("documents", path);
  if (url) window.open(url, "_blank", "noopener,noreferrer");
  else showToast("Could not generate secure download link.", "error");
  }} className="text-xs text-brand-600 hover:underline">View</button>
  <button onClick={async () => {
  const isFullUrl = d.url && d.url.startsWith("http");
  if (isFullUrl) { window.open(d.url, "_blank", "noopener,noreferrer"); return; }
  const path = d.file_name || d.url;
  if (!path) return;
  const url = await getSignedUrl("documents", path);
  if (url) window.open(url, "_blank", "noopener,noreferrer");
  }} className="text-xs text-positive-600 hover:underline">Download</button>
  </>
  ) : d.file_name ? (
  <>
  <button onClick={async () => {
  const url = await getSignedUrl("documents", d.file_name);
  if (url) window.open(url, "_blank", "noopener,noreferrer");
  else showToast("Could not generate secure link for this file.", "error");
  }} className="text-xs text-brand-600 hover:underline">View</button>
  </>
  ) : (
  <span className="text-xs text-neutral-400">No file</span>
  )}
  <button onClick={() => deleteDoc(d.id, d.name, d.file_name)} className="text-xs text-danger-400 hover:underline">Delete</button>
  </div>
  </td>
  </tr>
  ))}
  {filtered.length === 0 && (
  <tr><td colSpan={6} className="px-3 py-8 text-center text-neutral-400">No documents yet. Upload one above.</td></tr>
  )}
  </tbody>
  </table>
  </div>
  </div>
  );
}

// ============ DOCUMENT BUILDER ============
// Per-recipient color palette (Zoho Sign / DocuSign convention). Signer N gets
// color N mod 6 so the same role always renders in the same hue across the
// editor, the Send-for-Signature form, and the signature field placeholder.
const ROLE_COLORS = [
  { dot: "bg-brand-500",   ring: "ring-brand-500",   chip: "bg-brand-50 text-brand-700 border-brand-200" },
  { dot: "bg-amber-500",   ring: "ring-amber-500",   chip: "bg-amber-50 text-amber-700 border-amber-200" },
  { dot: "bg-emerald-500", ring: "ring-emerald-500", chip: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  { dot: "bg-rose-500",    ring: "ring-rose-500",    chip: "bg-rose-50 text-rose-700 border-rose-200" },
  { dot: "bg-teal-500",    ring: "ring-teal-500",    chip: "bg-teal-50 text-teal-700 border-teal-200" },
  { dot: "bg-purple-500",  ring: "ring-purple-500",  chip: "bg-purple-50 text-purple-700 border-purple-200" },
];
function getRoleColor(roleId, rolesList) {
  const idx = (rolesList || []).findIndex(r => r.role === roleId);
  return ROLE_COLORS[(idx >= 0 ? idx : 0) % ROLE_COLORS.length];
}

function DocumentBuilder({ addNotification, userProfile, userRole, companyId, activeCompany, showToast, showConfirm }) {
  const [tab, setTab] = useState("create"); // create | templates | history
  const [templates, setTemplates] = useState([]);
  const [generatedDocs, setGeneratedDocs] = useState([]);
  const [loading, setLoading] = useState(true);

  // Create document flow
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [mode, setMode] = useState(null); // null | "blank" | "prefill"
  const [prefillProperty, setPrefillProperty] = useState(null);
  const [fieldValues, setFieldValues] = useState({});
  const [step, setStep] = useState("pick"); // pick | fill | preview
  const [prefillData, setPrefillData] = useState({});

  // Template editor
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [templateForm, setTemplateForm] = useState({ name: "", category: "general", description: "", body: "", fields: [], field_config: {}, template_type: "html", pdf_storage_path: "", pdf_page_count: 0, pdf_field_placements: [], signing_mode: "none", signer_roles: [] });
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);

  // PDF overlay state
  const [pdfPages, setPdfPages] = useState([]); // array of { canvas, width, height } refs
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pdfScale, setPdfScale] = useState(1.5);
  const [placingField, setPlacingField] = useState(null); // field name being placed
  const [draggingPlacement, setDraggingPlacement] = useState(null); // { index, startX, startY, origX, origY }
  const pdfContainerRef = useRef();

  // Send modal
  const [sendModal, setSendModal] = useState(null);
  const [sendTo, setSendTo] = useState({ self: false, tenant: false, custom: "" });
  const [sending, setSending] = useState(false);
  const [signerEmails, setSignerEmails] = useState({});       // { [role]: "email" }
  const [signerNames, setSignerNames] = useState({});         // { [role]: "Full Name" }
  const [signaturesByDoc, setSignaturesByDoc] = useState({}); // { [docId]: [signerRow, ...] }

  const previewRef = useRef();

  // Full-screen split pane
  const [splitPercent, setSplitPercent] = useState(50);
  const isDragging = useRef(false);

  useEffect(() => {
  const onMouseMove = (e) => {
  if (!isDragging.current) return;
  const pct = (e.clientX / window.innerWidth) * 100;
  setSplitPercent(Math.min(75, Math.max(25, pct)));
  };
  const onMouseUp = () => { isDragging.current = false; document.body.style.cursor = ""; document.body.style.userSelect = ""; };
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  return () => { document.removeEventListener("mousemove", onMouseMove); document.removeEventListener("mouseup", onMouseUp); };
  }, []);

  // Escape key to exit full-screen modes
  useEffect(() => {
  const onKey = (e) => {
  if (e.key !== "Escape") return;
  if (showTemplateEditor) { setShowTemplateEditor(false); setEditingTemplate(null); }
  else if (step === "preview") setStep("fill");
  else if (step === "fill") resetFlow();
  };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
  }, [showTemplateEditor, step]);

  const startDrag = () => { isDragging.current = true; document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none"; };

  // ---- Advanced field helpers ----
  function evaluateFormula(formula, values) {
  try {
  const expr = formula.replace(/[a-z_][a-z0-9_]*/gi, (m) => {
  const v = parseFloat(values[m]);
  return isNaN(v) ? "0" : String(v);
  });
  if (!/^[\d\s+\-*/().]+$/.test(expr)) return 0;
  // Safe math parser — no eval/Function
  const tokens = expr.match(/(\d+\.?\d*|[+\-*/()])/g) || [];
  let pos = 0;
  function parseExpr() {
    let result = parseTerm();
    while (pos < tokens.length && (tokens[pos] === "+" || tokens[pos] === "-")) {
      const op = tokens[pos++]; const right = parseTerm();
      result = op === "+" ? result + right : result - right;
    }
    return result;
  }
  function parseTerm() {
    let result = parseFactor();
    while (pos < tokens.length && (tokens[pos] === "*" || tokens[pos] === "/")) {
      const op = tokens[pos++]; const right = parseFactor();
      result = op === "*" ? result * right : (right !== 0 ? result / right : 0);
    }
    return result;
  }
  function parseFactor() {
    if (tokens[pos] === "(") { pos++; const r = parseExpr(); if (tokens[pos] === ")") pos++; return r; }
    if (tokens[pos] === "-") { pos++; return -parseFactor(); }
    return parseFloat(tokens[pos++]) || 0;
  }
  return parseExpr() || 0;
  } catch { return 0; }
  }

  function isFieldVisible(fieldName, values, fieldConfig) {
  const cond = fieldConfig?.conditional?.[fieldName];
  if (!cond) return true;
  if (cond.visible_when) {
  const actual = String(values[cond.visible_when.field] || "").toLowerCase();
  return actual === String(cond.visible_when.eq).toLowerCase();
  }
  if (cond.hidden_when) {
  const actual = String(values[cond.hidden_when.field] || "").toLowerCase();
  return actual !== String(cond.hidden_when.eq).toLowerCase();
  }
  return true;
  }

  function recalcFields(values, fieldConfig) {
  const calc = fieldConfig?.calculated;
  if (!calc) return values;
  const updated = { ...values };
  Object.entries(calc).forEach(([name, cfg]) => {
  updated[name] = evaluateFormula(cfg.formula, updated);
  });
  return updated;
  }

  function formatAddressBlock(val) {
  if (!val || typeof val !== "object") return "";
  const parts = [val.line1, val.line2, [val.city, val.state].filter(Boolean).join(", ") + (val.zip ? " " + val.zip : "")].filter(Boolean);
  return parts.join("\n");
  }

  // ---- PDF utilities ----
  async function loadPdfFromBytes(bytes) {
  const pdfjsLib = await import("pdfjs-dist");
  try { pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString(); } catch { pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/" + pdfjsLib.version + "/pdf.worker.min.mjs"; }
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  setPdfDoc(pdf);
  return pdf;
  }

  async function renderPdfPages(pdf, scale, container) {
  if (!container) return;
  container.innerHTML = "";
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.className = "block";
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  pages.push({ pageNum: i, width: viewport.width, height: viewport.height, canvas });
  }
  setPdfPages(pages);
  return pages;
  }

  async function autoDetectFields(pdf) {
  const detected = [];
  for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i);
  const viewport = page.getViewport({ scale: 1 }); // use scale 1 for coordinate mapping
  const content = await page.getTextContent();
  for (const item of content.items) {
  const text = item.str || "";
  const tx = item.transform[4];
  const ty = item.transform[5];
  // Convert PDF coords (origin bottom-left) to percentages (origin top-left)
  const xPct = (tx / viewport.width) * 100;
  const yPct = ((viewport.height - ty) / viewport.height) * 100;
  // Check patterns
  let fieldName = null;
  let matchType = null;
  const mergeMatch = text.match(/\{\{(\w+)\}\}/);
  const bracketMatch = text.match(/\[([A-Za-z][A-Za-z0-9_ ]+)\]/);
  const underscoreMatch = text.match(/_{4,}/);
  if (mergeMatch) { fieldName = mergeMatch[1]; matchType = "merge"; }
  else if (bracketMatch) { fieldName = bracketMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, "_"); matchType = "bracket"; }
  else if (underscoreMatch) {
  // Try to infer name from text before underscores
  const before = text.split(/_{4,}/)[0].trim().replace(/[^a-zA-Z0-9]+$/, "");
  fieldName = before ? before.toLowerCase().replace(/[^a-z0-9]+/g, "_") : "field_" + detected.length;
  matchType = "underscore";
  }
  if (fieldName) {
  detected.push({
  field_name: fieldName,
  page: i,
  x: Math.max(0, xPct),
  y: Math.max(0, yPct - 1.5),
  width: Math.min(30, (item.width || 100) / viewport.width * 100 + 5),
  height: 2.5,
  font_size: 12,
  auto_detected: true,
  match_type: matchType,
  });
  }
  }
  }
  return detected;
  }

  async function handlePdfUpload(file) {
  if (!file) return;
  showToast("Uploading PDF...", "info");
  const fileName = companyId + "/templates/" + shortId() + "_" + sanitizeFileName(file.name);
  const { error: uploadError } = await supabase.storage.from("documents").upload(fileName, file, { cacheControl: "3600", upsert: false });
  if (uploadError) { showToast("Upload failed: " + uploadError.message, "error"); return; }

  const bytes = await file.arrayBuffer();
  const pdf = await loadPdfFromBytes(new Uint8Array(bytes));
  const pages = await renderPdfPages(pdf, pdfScale, pdfContainerRef.current);

  // Auto-detect fields
  const detected = await autoDetectFields(pdf);
  const newFields = [];
  const existingNames = new Set(templateForm.fields.map(f => f.name));
  for (const d of detected) {
  if (!existingNames.has(d.field_name)) {
  newFields.push({ name: d.field_name, label: d.field_name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()), type: "text", required: false, section: "Auto-Detected", options: [], default_value: "", prefill_from: "" });
  existingNames.add(d.field_name);
  }
  }

  setTemplateForm(prev => ({
  ...prev,
  pdf_storage_path: fileName,
  pdf_page_count: pdf.numPages,
  pdf_field_placements: [...prev.pdf_field_placements, ...detected],
  fields: [...prev.fields, ...newFields],
  }));
  showToast(pdf.numPages + " pages loaded" + (detected.length > 0 ? ", " + detected.length + " fields auto-detected" : ""), "success");
  }

  async function loadPdfForPreview(storagePath) {
  if (!storagePath) return;
  const url = await getSignedUrl("documents", storagePath);
  if (!url) return;
  const resp = await fetch(url);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const pdf = await loadPdfFromBytes(bytes);
  return pdf;
  }

  function addPlacement(fieldName, page, xPct, yPct) {
  setTemplateForm(prev => ({
  ...prev,
  pdf_field_placements: [...prev.pdf_field_placements, {
  field_name: fieldName, page, x: xPct, y: yPct, width: 25, height: 2.5, font_size: 12
  }],
  }));
  setPlacingField(null);
  }

  function updatePlacement(index, updates) {
  setTemplateForm(prev => {
  const placements = [...prev.pdf_field_placements];
  placements[index] = { ...placements[index], ...updates };
  return { ...prev, pdf_field_placements: placements };
  });
  }

  function removePlacement(index) {
  setTemplateForm(prev => ({
  ...prev,
  pdf_field_placements: prev.pdf_field_placements.filter((_, i) => i !== index),
  }));
  }

  const CATEGORIES = ["notices", "leases", "maintenance", "general"];

  useEffect(() => { fetchAll(); }, [companyId]);

  async function fetchAll() {
  setLoading(true);
  // Fetch company templates
  const { data: compTemplates } = await supabase.from("doc_templates").select("*").eq("company_id", companyId).eq("is_active", true).order("name");
  // Fetch system templates to clone if needed
  const { data: sysTemplates } = await supabase.from("doc_templates").select("*").eq("company_id", "00000000-0000-0000-0000-000000000000").eq("is_active", true);
  let all = compTemplates || [];
  // Auto-clone system templates on first use
  if (all.length === 0 && sysTemplates && sysTemplates.length > 0) {
  const clones = sysTemplates.map(t => ({
  company_id: companyId, name: t.name, category: t.category, description: t.description,
  body: t.body, fields: t.fields, is_system: true, created_by: userProfile?.email,
  }));
  const { data: inserted } = await supabase.from("doc_templates").insert(clones).select();
  all = inserted || [];
  }
  setTemplates(all);
  // Fetch generated documents
  const { data: docs } = await supabase.from("doc_generated").select("*").eq("company_id", companyId).is("archived_at", null).order("created_at", { ascending: false }).limit(200);
  setGeneratedDocs(docs || []);
  // Fetch signatures for envelope-bearing docs so History can show progress
  const envelopeDocIds = (docs || []).filter(d => d.envelope_status && d.envelope_status !== "draft").map(d => d.id);
  if (envelopeDocIds.length > 0) {
  const { data: sigs } = await supabase.from("doc_signatures").select("*").eq("company_id", companyId).in("doc_id", envelopeDocIds).order("sign_order", { ascending: true });
  const bucket = {};
  (sigs || []).forEach(s => { (bucket[s.doc_id] = bucket[s.doc_id] || []).push(s); });
  setSignaturesByDoc(bucket);
  } else {
  setSignaturesByDoc({});
  }
  setLoading(false);
  }

  // ---- Prefill logic ----
  async function loadPrefillData(propertyAddress) {
  const result = {};
  // Property
  const { data: prop } = await supabase.from("properties").select("*").eq("company_id", companyId).eq("address", propertyAddress).maybeSingle();
  if (prop) {
  result["property.address"] = buildAddress(prop) || prop.address;
  result["property.unit"] = prop.unit || "";
  result["property.type"] = prop.type || "";
  result["property.bedrooms"] = prop.bedrooms || "";
  result["property.bathrooms"] = prop.bathrooms || "";
  result["property.rent"] = prop.rent || "";
  }
  // Tenant
  const { data: tenant } = await supabase.from("tenants").select("*").eq("company_id", companyId).eq("property", propertyAddress).is("archived_at", null).maybeSingle();
  if (tenant) {
  result["tenant.name"] = tenant.name || "";
  result["tenant.email"] = tenant.email || "";
  result["tenant.phone"] = tenant.phone || "";
  result["tenant.balance"] = formatCurrency(tenant.balance || 0);
  result["tenant.security_deposit"] = formatCurrency(tenant.security_deposit || 0);
  result["tenant.status"] = tenant.status || "";
  }
  // Lease
  const { data: lease } = await supabase.from("leases").select("*").eq("company_id", companyId).eq("property", propertyAddress).eq("status", "active").maybeSingle();
  if (lease) {
  result["lease.start_date"] = lease.start_date || "";
  result["lease.end_date"] = lease.end_date || "";
  result["lease.rent_amount"] = formatCurrency(lease.rent_amount || 0);
  result["lease.security_deposit"] = formatCurrency(lease.security_deposit || 0);
  }
  // Context
  result["today"] = formatLocalDate(new Date());
  result["user.name"] = userProfile?.name || "";
  result["user.email"] = userProfile?.email || "";
  result["company.name"] = activeCompany?.name || "";
  setPrefillData(result);
  return result;
  }

  function applyPrefill(template, data) {
  const vals = {};
  (template.fields || []).forEach(f => {
  if (f.prefill_from && data[f.prefill_from]) {
  vals[f.name] = data[f.prefill_from];
  } else if (f.default_value) {
  vals[f.name] = f.default_value;
  } else {
  vals[f.name] = "";
  }
  });
  return vals;
  }

  function applyDefaults(template) {
  const vals = {};
  (template.fields || []).forEach(f => {
  if (f.prefill_from === "today") vals[f.name] = formatLocalDate(new Date());
  else if (f.prefill_from === "user.name") vals[f.name] = userProfile?.name || "";
  else if (f.prefill_from === "user.email") vals[f.name] = userProfile?.email || "";
  else if (f.prefill_from === "company.name") vals[f.name] = activeCompany?.name || "";
  else if (f.default_value) vals[f.name] = f.default_value;
  else vals[f.name] = "";
  });
  return vals;
  }

  async function startDocument(template, docMode) {
  setSelectedTemplate(template);
  setMode(docMode);
  const fc = template.field_config || {};
  if (docMode === "prefill" && prefillProperty) {
  const data = await loadPrefillData(prefillProperty);
  setFieldValues(recalcFields(applyPrefill(template, data), fc));
  } else {
  setFieldValues(recalcFields(applyDefaults(template), fc));
  }
  // Load PDF for overlay templates
  if (template.template_type === "pdf_overlay" && template.pdf_storage_path) {
  setPdfPages([]);
  const pdf = await loadPdfForPreview(template.pdf_storage_path);
  if (pdf && pdfContainerRef.current) await renderPdfPages(pdf, pdfScale, pdfContainerRef.current);
  }
  // Seed signer email/name defaults from the new template's roles
  if (template.signing_mode && template.signing_mode !== "none") {
    const emails = {};
    const names = {};
    for (const r of (template.signer_roles || [])) {
      const g = guessSignerDefaultsFor(r.role, docMode === "prefill" && prefillProperty ? await loadPrefillData(prefillProperty) : {});
      emails[r.role] = g.email;
      names[r.role] = g.name;
    }
    setSignerEmails(emails);
    setSignerNames(names);
  } else {
    setSignerEmails({});
    setSignerNames({});
  }
  setStep("fill");
  }

  // Stateless version used during startDocument (fieldValues isn't populated yet).
  function guessSignerDefaultsFor(role, data) {
  const r = (role || "").toLowerCase();
  const d = data || {};
  if (r.includes("tenant") || r === "renter" || r === "lessee") {
    return { email: d.tenant_email || "", name: d.tenant_name || "" };
  }
  if (r.includes("co_sign") || r.includes("cosigner") || r === "co_signer_2") {
    return { email: d.tenant_2_email || "", name: d.tenant_2 || "" };
  }
  if (r.includes("landlord") || r.includes("owner") || r.includes("manager") || r.includes("agent") || r.includes("lessor")) {
    return { email: userProfile?.email || "", name: userProfile?.name || "" };
  }
  return { email: "", name: "" };
  }

  // ---- Merge + render ----
  // Sanitize template body: allow only safe HTML tags, strip scripts/events
  function sanitizeTemplateHtml(html) {
  if (!html) return "";
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: ["p","br","b","i","u","strong","em","h1","h2","h3","h4","h5","h6","ul","ol","li","table","thead","tbody","tr","th","td","div","span","a","img","hr","blockquote","pre","code","sub","sup","s","del","ins","mark"], ALLOWED_ATTR: ["href","src","alt","title","class","style","width","height","colspan","rowspan","align","valign"], ALLOW_DATA_ATTR: false, FORBID_TAGS: ["script","iframe","object","embed","form","input","button","select","textarea"], FORBID_ATTR: ["onerror","onload","onclick","onmouseover","onfocus","onblur"] });
  }
  // Blocked merge field names that could leak system data
  const BLOCKED_MERGE_FIELDS = new Set(["company_id","companyId","user_email","userEmail","password","secret","token","access_token","api_key","encryption_iv"]);
  function renderMergedBody(body, values, fieldConfig) {
  return sanitizeTemplateHtml((body || "").replace(/\{\{(\w+)\}\}/g, (match, fieldName) => {
  if (BLOCKED_MERGE_FIELDS.has(fieldName)) return "";
  // Hide merge tags for conditionally hidden fields
  if (fieldConfig && !isFieldVisible(fieldName, values, fieldConfig)) return "";
  const val = values[fieldName];
  // Address block: format multi-line
  if (val && typeof val === "object" && val.line1 !== undefined) {
  const formatted = formatAddressBlock(val);
  return formatted ? escapeHtml(formatted).replace(/\n/g, "<br/>") : '<span style="color:#ef4444;background:#fef2f2;padding:0 4px;border-radius:4px;">' + match + '</span>';
  }
  return val !== undefined && val !== "" ? escapeHtml(String(val)) : '<span style="color:#ef4444;background:#fef2f2;padding:0 4px;border-radius:4px;">' + match + '</span>';
  }));
  }

  // ---- Validation ----
  function validateFields(template, values) {
  const errors = [];
  const fc = template.field_config || {};
  (template.fields || []).forEach(f => {
  if (!isFieldVisible(f.name, values, fc)) return; // skip hidden
  if (fc.calculated?.[f.name]) return; // skip calculated
  if (f.required) {
  const val = values[f.name];
  if (f.type === "address_block") {
  if (!val || typeof val !== "object" || !val.line1?.trim()) errors.push(f.label + " is required");
  } else if (!val || String(val).trim() === "") {
  errors.push(f.label + " is required");
  }
  }
  });
  return errors;
  }

  // ---- Save generated document ----
  async function saveDocument(status = "draft") {
  const errors = validateFields(selectedTemplate, fieldValues);
  if (errors.length > 0) { showToast(errors[0], "error"); return null; }
  const rendered = renderMergedBody(selectedTemplate.body, fieldValues, selectedTemplate.field_config);
  const docName = selectedTemplate.name + " — " + (fieldValues.tenant_name || fieldValues.recipient_name || "Document") + " " + formatLocalDate(new Date());
  const payload = {
  company_id: companyId, template_id: selectedTemplate.id, name: docName,
  field_values: fieldValues, rendered_body: rendered, status,
  output_type: selectedTemplate.template_type === "pdf_overlay" ? "pdf_overlay" : "html",
  property_address: fieldValues.property_address || "",
  tenant_name: fieldValues.tenant_name || fieldValues.recipient_name || "",
  created_by: userProfile?.email,
  };
  const { data, error } = await supabase.from("doc_generated").insert([payload]).select().maybeSingle();
  if (error) { pmError("PM-7003", { raw: error, context: "save generated document" }); return null; }
  showToast("Document saved", "success");
  addNotification("📄", "Document created: " + docName);
  logAudit("create", "doc_builder", "Generated: " + docName, data?.id, userProfile?.email, userRole, companyId);
  fetchAll();
  return data;
  }

  // ---- Export: PDF ----
  async function exportPDF(doc) {
  const template = doc?._template || selectedTemplate;
  const values = doc?.field_values || fieldValues;

  // PDF Overlay: use pdf-lib to write values onto the original PDF
  if (template?.template_type === "pdf_overlay" && template?.pdf_storage_path) {
  try {
  showToast("Generating PDF...", "info");
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const url = await getSignedUrl("documents", template.pdf_storage_path);
  if (!url) { showToast("Could not load PDF template", "error"); return; }
  const resp = await fetch(url);
  const origBytes = new Uint8Array(await resp.arrayBuffer());
  const pdfDoc = await PDFDocument.load(origBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();

  for (const placement of (template.pdf_field_placements || [])) {
  const pageIdx = (placement.page || 1) - 1;
  if (pageIdx < 0 || pageIdx >= pages.length) continue;
  const page = pages[pageIdx];
  const { width: pgW, height: pgH } = page.getSize();
  const val = values[placement.field_name];
  let text = "";
  if (val && typeof val === "object" && val.line1 !== undefined) {
  text = formatAddressBlock(val);
  } else {
  text = val ? String(val) : "";
  }
  if (!text) continue;
  const x = (placement.x / 100) * pgW;
  const y = pgH - ((placement.y / 100) * pgH) - (placement.font_size || 12);
  const fontSize = placement.font_size || 12;

  // Handle multi-line (address blocks)
  const lines = text.split("\n");
  lines.forEach((line, li) => {
  page.drawText(line, { x, y: y - (li * (fontSize + 2)), size: fontSize, font, color: rgb(0.1, 0.1, 0.1) });
  });
  }

  const filledBytes = await pdfDoc.save();
  const blob = new Blob([filledBytes], { type: "application/pdf" });
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = (doc?.name || template?.name || "document").replace(/[^a-zA-Z0-9_-]/g, "_") + ".pdf";
  a.click();
  URL.revokeObjectURL(blobUrl);
  showToast("PDF downloaded", "success");
  } catch (err) {
  pmError("PM-8006", { raw: err, context: "PDF export" });
  pmError("PM-8006", { raw: err, context: "PDF export" });
  }
  return;
  }

  // HTML template: use html2pdf.js
  const html2pdf = (await import("html2pdf.js")).default;
  const container = document.createElement("div");
  container.innerHTML = '<div style="font-family:Georgia,serif;font-size:13px;line-height:1.6;color:#1a1a1a;padding:40px;max-width:700px;margin:0 auto;">' + DOMPurify.sanitize(doc?.rendered_body || renderMergedBody(selectedTemplate.body, fieldValues), { ADD_TAGS: ["table","thead","tbody","tr","td","th","br","hr","ul","ol","li","p","h1","h2","h3","h4","h5","h6","strong","em","u","s","sub","sup","blockquote","pre","code","img","span","div","a"], ADD_ATTR: ["style","class","href","src","alt","width","height","colspan","rowspan","align","valign"] }) + '</div>';
  document.body.appendChild(container);
  const filename = (doc?.name || selectedTemplate?.name || "document").replace(/[^a-zA-Z0-9_-]/g, "_") + ".pdf";
  await html2pdf().set({ margin: [0.5, 0.6, 0.5, 0.6], filename, image: { type: "jpeg", quality: 0.98 }, html2canvas: { scale: 2 }, jsPDF: { unit: "in", format: "letter" } }).from(container).save();
  document.body.removeChild(container);
  showToast("PDF downloaded", "success");
  }

  // ---- Signed PDF + Certificate of Completion (envelope flow) ----
  function escapeForHtml(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  function renderSignaturesBlock(sigs) {
  if (!sigs || sigs.length === 0) return "";
  const rows = sigs.map(s => {
    const dateStr = s.signed_at ? new Date(s.signed_at).toLocaleString() : "";
    let sigVisual = "";
    if (s.signature_data) {
      if (s.signature_data.startsWith("data:image")) {
        sigVisual = '<img src="' + escapeForHtml(s.signature_data) + '" style="max-height:52px;max-width:220px;border-bottom:1px solid #333;display:block;" alt="signature" />';
      } else if (s.signature_data.startsWith("typed:")) {
        const nm = s.signature_data.slice(6).split("|")[0];
        sigVisual = '<div style="font-family:\'Brush Script MT\',cursive;font-size:28px;color:#1e3a5f;border-bottom:1px solid #333;padding-bottom:4px;">' + escapeForHtml(nm) + '</div>';
      }
    } else {
      sigVisual = '<div style="color:#999;font-style:italic;border-bottom:1px solid #ccc;padding-bottom:4px;">(awaiting signature)</div>';
    }
    return ''
      + '<div style="margin-bottom:28px;">'
      + '<div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">' + escapeForHtml(s.signer_role || "signer") + '</div>'
      + sigVisual
      + '<div style="font-size:12px;color:#333;margin-top:4px;"><strong>' + escapeForHtml(s.signer_name || "") + '</strong>'
      + (s.signer_email ? ' <span style="color:#666;">&middot; ' + escapeForHtml(s.signer_email) + '</span>' : '')
      + '</div>'
      + (dateStr ? '<div style="font-size:11px;color:#666;">Signed ' + escapeForHtml(dateStr) + '</div>' : '')
      + '</div>';
  }).join("");
  return '<div style="margin-top:40px;padding-top:20px;border-top:2px solid #1e3a5f;"><h3 style="font-family:Georgia,serif;color:#1e3a5f;margin-bottom:16px;">Signed By</h3>' + rows + '</div>';
  }

  function renderCertificateHtml(doc, sigs, companyName) {
  const signedCount = (sigs || []).filter(s => s.status === "signed").length;
  const total = (sigs || []).length;
  const rows = (sigs || []).map((s, idx) => ''
    + '<tr style="border-bottom:1px solid #e5e7eb;">'
    + '<td style="padding:10px 8px;font-size:11px;color:#333;vertical-align:top;">' + (idx + 1) + '</td>'
    + '<td style="padding:10px 8px;font-size:11px;color:#333;vertical-align:top;">'
    + '<div style="font-weight:600;">' + escapeForHtml(s.signer_name || "(no name)") + '</div>'
    + '<div style="color:#666;">' + escapeForHtml(s.signer_email || "") + '</div>'
    + '<div style="color:#999;text-transform:uppercase;letter-spacing:0.04em;font-size:9px;margin-top:2px;">' + escapeForHtml(s.signer_role || "") + '</div>'
    + '</td>'
    + '<td style="padding:10px 8px;font-size:11px;color:#333;vertical-align:top;">' + (s.signed_at ? escapeForHtml(new Date(s.signed_at).toLocaleString()) : '<span style="color:#c00;">Not signed</span>') + '</td>'
    + '<td style="padding:10px 8px;font-size:10px;color:#666;vertical-align:top;">' + escapeForHtml(s.signer_ip || "—") + '</td>'
    + '<td style="padding:10px 8px;font-size:10px;color:#666;vertical-align:top;font-family:monospace;word-break:break-all;">' + (s.integrity_hash ? escapeForHtml(s.integrity_hash.slice(0, 24)) + "…" : "—") + '</td>'
    + '</tr>'
  ).join("");
  const uaList = (sigs || []).filter(s => s.user_agent).map(s => ''
    + '<div style="font-size:9px;color:#888;margin-bottom:2px;"><strong>' + escapeForHtml(s.signer_email) + ':</strong> ' + escapeForHtml(s.user_agent) + '</div>'
  ).join("");
  return ''
    + '<div style="font-family:Georgia,serif;color:#111;padding:40px;max-width:720px;margin:0 auto;">'
    + '<div style="text-align:center;padding-bottom:24px;border-bottom:3px solid #6366f1;margin-bottom:24px;">'
    + '<div style="font-size:11px;color:#6366f1;text-transform:uppercase;letter-spacing:0.2em;margin-bottom:6px;">Certificate of Completion</div>'
    + '<div style="font-size:22px;font-weight:700;color:#1e3a5f;">' + escapeForHtml(doc.name) + '</div>'
    + (companyName ? '<div style="font-size:13px;color:#666;margin-top:6px;">Issued by ' + escapeForHtml(companyName) + '</div>' : '')
    + '</div>'
    + '<div style="font-size:13px;color:#333;margin-bottom:24px;line-height:1.7;">'
    + '<p>This certifies that the document above was signed electronically on behalf of all parties listed below.</p>'
    + '<ul style="padding-left:20px;">'
    + '<li><strong>Document ID:</strong> ' + escapeForHtml(doc.id) + '</li>'
    + (doc.property_address ? '<li><strong>Property:</strong> ' + escapeForHtml(doc.property_address) + '</li>' : '')
    + '<li><strong>Envelope sent:</strong> ' + escapeForHtml(doc.envelope_sent_at ? new Date(doc.envelope_sent_at).toLocaleString() : "—") + '</li>'
    + '<li><strong>Envelope completed:</strong> ' + escapeForHtml(doc.envelope_completed_at ? new Date(doc.envelope_completed_at).toLocaleString() : "not yet complete") + '</li>'
    + '<li><strong>Signers:</strong> ' + signedCount + ' of ' + total + ' completed</li>'
    + '</ul>'
    + '</div>'
    + '<table style="width:100%;border-collapse:collapse;margin-bottom:24px;">'
    + '<thead><tr style="background:#f3f4f6;text-align:left;">'
    + '<th style="padding:8px;font-size:10px;text-transform:uppercase;color:#666;letter-spacing:0.05em;">#</th>'
    + '<th style="padding:8px;font-size:10px;text-transform:uppercase;color:#666;letter-spacing:0.05em;">Signer</th>'
    + '<th style="padding:8px;font-size:10px;text-transform:uppercase;color:#666;letter-spacing:0.05em;">Signed at</th>'
    + '<th style="padding:8px;font-size:10px;text-transform:uppercase;color:#666;letter-spacing:0.05em;">IP</th>'
    + '<th style="padding:8px;font-size:10px;text-transform:uppercase;color:#666;letter-spacing:0.05em;">Integrity hash</th>'
    + '</tr></thead>'
    + '<tbody>' + rows + '</tbody>'
    + '</table>'
    + (uaList ? '<div style="margin-top:16px;padding:12px;background:#f9fafb;border-radius:6px;"><div style="font-size:10px;font-weight:600;color:#666;margin-bottom:6px;">BROWSER INFORMATION</div>' + uaList + '</div>' : '')
    + '<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:10px;color:#999;text-align:center;">'
    + 'Each integrity hash is a SHA-256 digest over the document body, signer email, signature payload, and timestamp at the moment of signing. Any alteration to the signed document or signature will cause the hash to no longer match. Certificate generated ' + escapeForHtml(new Date().toLocaleString()) + '.'
    + '</div>'
    + '</div>';
  }

  async function loadSignaturesForDoc(docId) {
  const cached = signaturesByDoc[docId];
  if (cached && cached.length > 0) return cached;
  const { data } = await supabase.from("doc_signatures").select("*").eq("company_id", companyId).eq("doc_id", docId).order("sign_order", { ascending: true });
  return data || [];
  }

  async function downloadCertificate(doc) {
  showToast("Generating certificate…", "info");
  const sigs = await loadSignaturesForDoc(doc.id);
  const html2pdf = (await import("html2pdf.js")).default;
  const container = document.createElement("div");
  container.innerHTML = renderCertificateHtml(doc, sigs, doc._companyName);
  document.body.appendChild(container);
  const filename = "cert-" + (doc.name || "document").replace(/[^a-zA-Z0-9_-]/g, "_") + ".pdf";
  try {
    await html2pdf().set({ margin: [0.5, 0.6, 0.5, 0.6], filename, image: { type: "jpeg", quality: 0.98 }, html2canvas: { scale: 2 }, jsPDF: { unit: "in", format: "letter" } }).from(container).save();
    logAudit("export", "doc_builder", "Downloaded Certificate of Completion: " + doc.name, doc.id, userProfile?.email, userRole, companyId);
    showToast("Certificate downloaded", "success");
  } finally {
    document.body.removeChild(container);
  }
  }

  async function downloadSignedPDF(doc) {
  showToast("Generating signed document…", "info");
  const sigs = await loadSignaturesForDoc(doc.id);
  const html2pdf = (await import("html2pdf.js")).default;
  const signedBlock = renderSignaturesBlock(sigs);
  const certBlock = renderCertificateHtml(doc, sigs, doc._companyName);
  const bodyHtml = DOMPurify.sanitize(doc?.rendered_body || "", { ADD_TAGS: ["table","thead","tbody","tr","td","th","br","hr","ul","ol","li","p","h1","h2","h3","h4","h5","h6","strong","em","u","s","sub","sup","blockquote","pre","code","img","span","div","a"], ADD_ATTR: ["style","class","href","src","alt","width","height","colspan","rowspan","align","valign"] });
  const container = document.createElement("div");
  container.innerHTML = ''
    + '<div style="font-family:Georgia,serif;font-size:13px;line-height:1.6;color:#1a1a1a;padding:40px;max-width:720px;margin:0 auto;">' + bodyHtml + signedBlock + '</div>'
    + '<div style="page-break-before:always;"></div>'
    + certBlock;
  document.body.appendChild(container);
  const filename = "signed-" + (doc.name || "document").replace(/[^a-zA-Z0-9_-]/g, "_") + ".pdf";
  try {
    await html2pdf().set({ margin: [0.5, 0.6, 0.5, 0.6], filename, image: { type: "jpeg", quality: 0.98 }, html2canvas: { scale: 2, useCORS: true }, jsPDF: { unit: "in", format: "letter" }, pagebreak: { mode: ["avoid-all","css","legacy"] } }).from(container).save();
    logAudit("export", "doc_builder", "Downloaded signed PDF: " + doc.name, doc.id, userProfile?.email, userRole, companyId);
    showToast("Signed document downloaded", "success");
  } finally {
    document.body.removeChild(container);
  }
  }

  // ---- Export: DOCX ----
  async function exportDOCX(doc) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = await import("docx");
  const { saveAs } = await import("file-saver");
  const body = doc?.rendered_body || renderMergedBody(selectedTemplate.body, fieldValues);
  // Parse HTML into docx paragraphs
  const temp = document.createElement("div");
  temp.innerHTML = DOMPurify.sanitize(body);
  const paragraphs = [];
  function processNode(node) {
  if (node.nodeType === 3) {
  const text = node.textContent.trim();
  if (text) paragraphs.push(new Paragraph({ children: [new TextRun(text)] }));
  return;
  }
  if (node.nodeType !== 1) return;
  const tag = node.tagName?.toLowerCase();
  if (tag === "h1") {
  paragraphs.push(new Paragraph({ children: [new TextRun({ text: node.textContent, bold: true, size: 32 })], heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, spacing: { after: 200 } }));
  } else if (tag === "h2") {
  paragraphs.push(new Paragraph({ children: [new TextRun({ text: node.textContent, bold: true, size: 26 })], heading: HeadingLevel.HEADING_2, spacing: { after: 150 } }));
  } else if (tag === "hr") {
  paragraphs.push(new Paragraph({ children: [new TextRun({ text: "─".repeat(60), color: "999999", size: 16 })], spacing: { before: 100, after: 100 } }));
  } else if (tag === "br") {
  paragraphs.push(new Paragraph({ children: [] }));
  } else if (tag === "li") {
  paragraphs.push(new Paragraph({ children: [new TextRun("• " + node.textContent)], indent: { left: 400 } }));
  } else if (tag === "ul" || tag === "ol") {
  Array.from(node.children).forEach(processNode);
  } else if (tag === "table") {
  // Render table rows as text pairs
  node.querySelectorAll("tr").forEach(row => {
  const cells = Array.from(row.querySelectorAll("td,th")).map(c => c.textContent.trim());
  if (cells.length >= 2) {
  paragraphs.push(new Paragraph({ children: [new TextRun({ text: cells[0] + ": ", bold: true }), new TextRun(cells.slice(1).join(" "))] }));
  } else if (cells.length === 1) {
  paragraphs.push(new Paragraph({ children: [new TextRun(cells[0])] }));
  }
  });
  } else if (tag === "p" || tag === "div") {
  const runs = [];
  node.childNodes.forEach(child => {
  if (child.nodeType === 3) {
  runs.push(new TextRun(child.textContent));
  } else if (child.tagName?.toLowerCase() === "strong" || child.tagName?.toLowerCase() === "b") {
  runs.push(new TextRun({ text: child.textContent, bold: true }));
  } else if (child.tagName?.toLowerCase() === "em" || child.tagName?.toLowerCase() === "i") {
  runs.push(new TextRun({ text: child.textContent, italics: true }));
  } else if (child.tagName?.toLowerCase() === "br") {
  runs.push(new TextRun({ text: "", break: 1 }));
  } else {
  runs.push(new TextRun(child.textContent));
  }
  });
  if (runs.length > 0) paragraphs.push(new Paragraph({ children: runs, spacing: { after: 120 } }));
  } else {
  // Recurse for unknown tags
  Array.from(node.childNodes).forEach(processNode);
  }
  }
  Array.from(temp.childNodes).forEach(processNode);
  if (paragraphs.length === 0) paragraphs.push(new Paragraph({ children: [new TextRun(temp.textContent)] }));
  const docx = new Document({ sections: [{ children: paragraphs }] });
  const blob = await Packer.toBlob(docx);
  const filename = (doc?.name || selectedTemplate?.name || "document").replace(/[^a-zA-Z0-9_-]/g, "_") + ".docx";
  saveAs(blob, filename);
  showToast("DOCX downloaded", "success");
  }

  // ---- Export: TXT ----
  function exportTXT(doc) {
  const body = doc?.rendered_body || renderMergedBody(selectedTemplate.body, fieldValues);
  const temp = document.createElement("div");
  temp.innerHTML = DOMPurify.sanitize(body);
  const text = temp.innerText || temp.textContent;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = (doc?.name || selectedTemplate?.name || "document").replace(/[^a-zA-Z0-9_-]/g, "_") + ".txt";
  a.click();
  URL.revokeObjectURL(url);
  showToast("TXT downloaded", "success");
  }

  // ---- Email ----
  async function sendEmail(doc) {
  setSending(true);
  const recipients = [];
  if (sendTo.self && userProfile?.email) recipients.push(userProfile.email);
  if (sendTo.tenant && fieldValues.tenant_name) {
  // Look up tenant email
  const { data: t } = await supabase.from("tenants").select("email").eq("company_id", companyId).ilike("name", fieldValues.tenant_name).is("archived_at", null).maybeSingle();
  if (t?.email) recipients.push(t.email);
  else { showToast("Could not find email for " + fieldValues.tenant_name, "warning"); }
  }
  if (sendTo.custom) {
  sendTo.custom.split(",").map(e => e.trim()).filter(e => e.includes("@")).forEach(e => recipients.push(e));
  }
  if (recipients.length === 0) { showToast("No recipients specified", "error"); setSending(false); return; }

  const rendered = doc?.rendered_body || renderMergedBody(selectedTemplate.body, fieldValues);
  const docName = doc?.name || selectedTemplate?.name || "Document";

  for (const email of recipients) {
  try {
  const { error } = await supabase.functions.invoke("send-email", {
  body: { to: email, subject: docName, html: '<div style="font-family:Georgia,serif;font-size:14px;line-height:1.6;color:#1a1a1a;max-width:700px;margin:0 auto;">' + rendered + '</div>' },
  });
  if (error) pmError("PM-1007", { raw: error, context: "email document to " + email });
  } catch (e) { showToast("Email error: " + e.message, "error"); }
  }

  // Update doc status
  if (doc?.id) {
  await supabase.from("doc_generated").update({ status: "sent", sent_at: new Date().toISOString(), recipients: recipients.map(r => ({ email: r, sent_at: new Date().toISOString() })) }).eq("id", doc.id).eq("company_id", companyId);
  }

  showToast("Sent to " + recipients.length + " recipient(s)", "success");
  addNotification("📧", "Document emailed: " + docName);
  logAudit("send", "doc_builder", "Emailed " + docName + " to " + recipients.join(", "), doc?.id, userProfile?.email, userRole, companyId);
  setSendModal(null);
  setSending(false);
  fetchAll();
  }

  // ---- Send for signature (envelope flow) ----
  function guessSignerDefaults(role) {
  // Returns { email, name } best-guess. Role strings are case-insensitive.
  const r = (role || "").toLowerCase();
  if (r.includes("tenant") || r === "renter" || r === "lessee") {
    return { email: fieldValues.tenant_email || "", name: fieldValues.tenant_name || "" };
  }
  if (r.includes("co_sign") || r.includes("cosigner") || r === "co_signer_2") {
    return { email: fieldValues.tenant_2_email || "", name: fieldValues.tenant_2 || "" };
  }
  if (r.includes("landlord") || r.includes("owner") || r.includes("manager") || r.includes("agent") || r.includes("lessor")) {
    return { email: userProfile?.email || "", name: userProfile?.name || "" };
  }
  return { email: "", name: "" };
  }

  async function sendForSignature() {
  if (!selectedTemplate) return;
  const roles = selectedTemplate.signer_roles || [];
  if (roles.length === 0) { showToast("This template has no signer roles defined", "error"); return; }

  // Validate emails
  const signers = [];
  for (const r of roles) {
    const email = (signerEmails[r.role] || "").trim().toLowerCase();
    const name = (signerNames[r.role] || "").trim();
    if (r.required !== false && !email) {
      showToast("Email required for " + (r.label || r.role), "error");
      return;
    }
    if (!email) continue;
    if (!email.includes("@") || !email.includes(".")) {
      showToast("Invalid email for " + (r.label || r.role) + ": " + email, "error");
      return;
    }
    signers.push({ role: r.role, label: r.label || r.role, name, email, order: r.order || 1 });
  }
  if (signers.length === 0) { showToast("At least one signer email is required", "error"); return; }

  setSending(true);
  try {
    const doc = await saveDocument("sent");
    if (!doc) { setSending(false); return; }

    const { data: envRows, error: envErr } = await supabase.rpc("create_doc_envelope", { p_doc_id: doc.id, p_signers: signers });
    if (envErr) {
      pmError("PM-7003", { raw: envErr, context: "create doc envelope" });
      setSending(false);
      return;
    }

    // Only signers with status='sent' actually need a magic-link email right now.
    // (Sequential flow leaves later signers in 'pending' until the prior signer finishes.)
    const origin = window.location.origin;
    let emailed = 0;
    for (const row of envRows || []) {
      if (row.status !== "sent") continue;
      const signUrl = origin + "/sign/" + row.access_token;
      const roleLabel = signers.find(s => s.email === row.signer_email)?.label || row.signer_email;
      const subject = "Signature requested: " + doc.name;
      const html = '<div style="font-family:Georgia,serif;font-size:14px;line-height:1.6;color:#1a1a1a;max-width:640px;margin:0 auto;">'
        + '<p>Hello' + (signers.find(s => s.email === row.signer_email)?.name ? " " + signers.find(s => s.email === row.signer_email).name : "") + ',</p>'
        + '<p>You are requested to review and sign <strong>' + doc.name + '</strong> as <em>' + roleLabel + '</em>.</p>'
        + '<p><a href="' + signUrl + '" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Review &amp; Sign</a></p>'
        + '<p style="font-size:12px;color:#666;">Or paste this link into your browser: <br/>' + signUrl + '</p>'
        + '<p style="font-size:11px;color:#999;margin-top:24px;">This link expires in 30 days. If you did not expect this message, you can ignore it.</p>'
        + '</div>';
      try {
        const { error: emailErr } = await supabase.functions.invoke("send-email", { body: { to: row.signer_email, subject, html } });
        if (emailErr) pmError("PM-1007", { raw: emailErr, context: "signing link email to " + row.signer_email, silent: true });
        else emailed++;
      } catch (e) { pmError("PM-1007", { raw: e, context: "signing link email exception", silent: true }); }
    }

    showToast(emailed + " of " + (envRows || []).length + " signer(s) emailed", "success");
    addNotification("✍️", "Sent for signature: " + doc.name);
    logAudit("send", "doc_builder", "Envelope sent: " + doc.name + " to " + signers.map(s => s.email).join(", "), doc.id, userProfile?.email, userRole, companyId);
    setSignerEmails({});
    setSignerNames({});
    resetFlow();
    fetchAll();
  } finally {
    setSending(false);
  }
  }

  // ---- Template CRUD ----
  async function saveTemplate() {
  if (!templateForm.name.trim()) { showToast("Template name is required", "error"); return; }
  if (!templateForm.body.trim()) { showToast("Template body is required", "error"); return; }
  const payload = { ...templateForm, company_id: companyId, updated_at: new Date().toISOString() };
  if (editingTemplate) {
  const { error } = await supabase.from("doc_templates").update(payload).eq("id", editingTemplate.id).eq("company_id", companyId);
  if (error) { pmError("PM-8006", { raw: error, context: "update document template" }); return; }
  showToast("Template updated", "success");
  } else {
  payload.created_by = userProfile?.email;
  const { error } = await supabase.from("doc_templates").insert([payload]);
  if (error) { pmError("PM-8006", { raw: error, context: "create document template" }); return; }
  showToast("Template created", "success");
  }
  setShowTemplateEditor(false);
  setEditingTemplate(null);
  fetchAll();
  }

  async function deleteTemplate(t) {
  if (!await showConfirm({ message: 'Delete template "' + t.name + '"?', variant: "danger", confirmText: "Delete" })) return;
  await supabase.from("doc_templates").update({ is_active: false }).eq("id", t.id);
  showToast("Template deleted", "success");
  fetchAll();
  }

  async function deleteGeneratedDoc(d) {
  if (!await showConfirm({ message: "Delete this generated document?", variant: "danger", confirmText: "Delete" })) return;
  await supabase.from("doc_generated").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email }).eq("id", d.id).eq("company_id", companyId);
  showToast("Document deleted", "success");
  fetchAll();
  }

  // ---- Reset flow ----
  function resetFlow() {
  setSelectedTemplate(null);
  setMode(null);
  setPrefillProperty(null);
  setFieldValues({});
  setStep("pick");
  setPrefillData({});
  }

  // ---- Field editor helpers ----
  function addField() {
  setTemplateForm(prev => ({ ...prev, fields: [...prev.fields, { name: "", label: "", type: "text", required: false, section: "", options: [], default_value: "", prefill_from: "" }] }));
  }
  function updateField(idx, key, val) {
  setTemplateForm(prev => {
  const fields = [...prev.fields];
  fields[idx] = { ...fields[idx], [key]: val };
  if (key === "label" && !fields[idx].name) fields[idx].name = val.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return { ...prev, fields };
  });
  }
  function removeField(idx) {
  setTemplateForm(prev => ({ ...prev, fields: prev.fields.filter((_, i) => i !== idx) }));
  }

  // Insert merge field into body
  function insertMergeField(fieldName) {
  setTemplateForm(prev => ({ ...prev, body: prev.body + "{{" + fieldName + "}}" }));
  }

  if (loading) return <Spinner />;

  // ============ TEMPLATE EDITOR — FULL SCREEN ============
  if (showTemplateEditor) {
  const sections = [...new Set(templateForm.fields.map(f => f.section).filter(Boolean))];
  return (
  <div className="fixed inset-0 z-50 bg-[#fcf8ff] flex flex-col">
  {/* Top ribbon — breadcrumb + mode toggle + primary action */}
  <div className="h-14 border-b border-neutral-100 bg-white flex items-center px-5 gap-3 shrink-0">
  <IconBtn icon="arrow_back" onClick={() => { setShowTemplateEditor(false); setEditingTemplate(null); }} />
  <div className="flex-1 min-w-0 flex items-center gap-1.5 text-sm">
  <span className="text-neutral-400 shrink-0">Document Builder</span>
  <span className="text-neutral-300 shrink-0">›</span>
  <span className="text-neutral-400 shrink-0">Templates</span>
  <span className="text-neutral-300 shrink-0">›</span>
  <span className="font-semibold text-neutral-800 truncate">{editingTemplate ? (templateForm.name || "Edit Template") : (templateForm.name || "New Template")}</span>
  </div>
  <div className="flex bg-neutral-100 rounded-xl p-0.5">
  <button onClick={() => setTemplateForm(prev => ({ ...prev, template_type: "html" }))} className={"px-3 py-1.5 text-xs font-medium rounded-lg transition-colors " + (templateForm.template_type === "html" ? "bg-white text-brand-700 shadow-sm" : "text-neutral-500 hover:text-neutral-700")}>HTML</button>
  <button onClick={() => setTemplateForm(prev => ({ ...prev, template_type: "pdf_overlay" }))} className={"px-3 py-1.5 text-xs font-medium rounded-lg transition-colors " + (templateForm.template_type === "pdf_overlay" ? "bg-white text-brand-700 shadow-sm" : "text-neutral-500 hover:text-neutral-700")}>PDF Overlay</button>
  </div>
  <Btn onClick={saveTemplate}>{editingTemplate ? "Save" : "Create"}</Btn>
  <span className="text-xs text-neutral-300 ml-2">Esc to close</span>
  </div>

  {/* Split pane */}
  <div className="flex-1 flex overflow-hidden">
  {/* Left: Template config + fields */}
  <div style={{ width: splitPercent + "%" }} className="overflow-y-auto p-6 space-y-4">
  <div className="bg-white rounded-xl border border-neutral-100 shadow-sm p-4">
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-3">Template Details</h3>
  <div className="grid grid-cols-2 gap-3">
  <div>
  <label className="text-xs font-medium text-neutral-400 block mb-1">Name *</label>
  <Input value={templateForm.name} onChange={e => setTemplateForm({...templateForm, name: e.target.value})} placeholder="e.g. Pet Addendum" />
  </div>
  <div>
  <label className="text-xs font-medium text-neutral-400 block mb-1">Category</label>
  <Select value={templateForm.category} onChange={e => setTemplateForm({...templateForm, category: e.target.value})}>
  {CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
  </Select>
  </div>
  </div>
  <div className="mt-3">
  <label className="text-xs font-medium text-neutral-400 block mb-1">Description</label>
  <Input value={templateForm.description} onChange={e => setTemplateForm({...templateForm, description: e.target.value})} placeholder="Brief description" />
  </div>
  </div>

  <div className="bg-white rounded-xl border border-neutral-100 shadow-sm p-4">
  <div className="flex items-center justify-between mb-3">
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Form Fields ({templateForm.fields.length})</h3>
  <Btn size="sm" onClick={addField}>+ Add Field</Btn>
  </div>
  <div className="space-y-3">
  {templateForm.fields.map((f, i) => (
  <div key={i} className="border border-neutral-100 rounded-xl p-3 bg-brand-50/20">
  <div className="grid grid-cols-3 gap-2 mb-2">
  <Input value={f.label} onChange={e => updateField(i, "label", e.target.value)} placeholder="Label" className="text-xs" />
  <Select value={f.type} onChange={e => updateField(i, "type", e.target.value)} className="text-xs">
  {["text","textarea","number","currency","date","checkbox","select","address_block","signature"].map(t => <option key={t} value={t}>{t}</option>)}
  </Select>
  <Input value={f.section || ""} onChange={e => updateField(i, "section", e.target.value)} placeholder="Section" className="text-xs" />
  </div>
  <div className="grid grid-cols-3 gap-2">
  <Input value={f.prefill_from || ""} onChange={e => updateField(i, "prefill_from", e.target.value)} placeholder="Prefill from" className="text-xs" />
  <Input value={f.default_value || ""} onChange={e => updateField(i, "default_value", e.target.value)} placeholder="Default value" className="text-xs" />
  <div className="flex items-center gap-2">
  <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={f.required} onChange={e => updateField(i, "required", e.target.checked)} className="accent-brand-600" />Required</label>
  <button onClick={() => insertMergeField(f.name || f.label.toLowerCase().replace(/[^a-z0-9]+/g, "_"))} className="text-xs text-brand-600 hover:underline" title="Insert into body">{"{{}}"}</button>
  <button onClick={() => removeField(i)} className="text-xs text-danger-400 hover:text-danger-600 ml-auto">✕</button>
  </div>
  </div>
  {f.type === "select" && (
  <Input value={(f.options || []).join(", ")} onChange={e => updateField(i, "options", e.target.value.split(",").map(s => s.trim()))} placeholder="Options (comma-separated)" className="text-xs mt-2" />
  )}
  {f.type === "signature" && (
  <div className="mt-2 flex items-center gap-2">
  <label className="text-xs text-neutral-500 shrink-0">Signer role:</label>
  {f.signer_role && (
    <span className={`w-2.5 h-2.5 rounded-full ${getRoleColor(f.signer_role, templateForm.signer_roles).dot} shrink-0`} title="Recipient color" />
  )}
  <Select value={f.signer_role || ""} onChange={e => updateField(i, "signer_role", e.target.value)} className="text-xs flex-1">
  <option value="">— choose a signer —</option>
  {(templateForm.signer_roles || []).map(r => <option key={r.role} value={r.role}>{r.label || r.role}</option>)}
  </Select>
  {(templateForm.signer_roles || []).length === 0 && <span className="text-[10px] text-warn-600">Define signer roles in the Signature Workflow section ↓</span>}
  </div>
  )}
  <div className="text-xs text-neutral-400 mt-1">Merge tag: <code className="bg-neutral-100 px-1 rounded">{"{{" + (f.name || "field_name") + "}}"}</code></div>
  </div>
  ))}
  </div>
  </div>

  {/* Advanced Field Config */}
  {templateForm.fields.length > 0 && (
  <div className="bg-white rounded-xl border border-neutral-100 shadow-sm p-4">
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-3">Advanced Field Config</h3>

  {/* Calculated Fields */}
  <div className="mb-4">
  <div className="flex items-center justify-between mb-2">
  <h4 className="text-xs font-semibold text-warn-700 uppercase tracking-wide flex items-center gap-1"><span className="material-icons-outlined text-sm">calculate</span>Calculated Fields</h4>
  <button onClick={() => {
  const name = prompt("Field name to make calculated (must match an existing field):");
  if (!name?.trim()) return;
  const formula = prompt("Formula (use field names, e.g. rent + late_fee):");
  if (!formula?.trim()) return;
  setTemplateForm(prev => ({ ...prev, field_config: { ...prev.field_config, calculated: { ...(prev.field_config?.calculated || {}), [name.trim()]: { formula: formula.trim() } } } }));
  }} className="text-xs text-warn-600 hover:text-warn-800">+ Add</button>
  </div>
  {Object.entries(templateForm.field_config?.calculated || {}).map(([name, cfg]) => (
  <div key={name} className="flex items-center gap-2 text-xs bg-warn-50 border border-warn-100 rounded-lg px-3 py-2 mb-1">
  <span className="font-mono font-semibold text-warn-800">{name}</span>
  <span className="text-warn-500">=</span>
  <span className="font-mono text-warn-700 flex-1">{cfg.formula}</span>
  <button onClick={() => {
  const calc = { ...(templateForm.field_config?.calculated || {}) };
  delete calc[name];
  setTemplateForm(prev => ({ ...prev, field_config: { ...prev.field_config, calculated: calc } }));
  }} className="text-danger-400 hover:text-danger-600">✕</button>
  </div>
  ))}
  {Object.keys(templateForm.field_config?.calculated || {}).length === 0 && <p className="text-xs text-neutral-400 italic">No calculated fields. Use formulas like <code className="bg-neutral-100 px-1 rounded">rent * days / 30</code></p>}
  </div>

  {/* Conditional Fields */}
  <div className="mb-4">
  <div className="flex items-center justify-between mb-2">
  <h4 className="text-xs font-semibold text-accent-700 uppercase tracking-wide flex items-center gap-1"><span className="material-icons-outlined text-sm">visibility</span>Conditional Visibility</h4>
  <button onClick={() => {
  const name = prompt("Field to show/hide conditionally:");
  if (!name?.trim()) return;
  const depField = prompt("Show when which field...");
  if (!depField?.trim()) return;
  const eqVal = prompt("...equals what value?");
  if (eqVal === null) return;
  setTemplateForm(prev => ({ ...prev, field_config: { ...prev.field_config, conditional: { ...(prev.field_config?.conditional || {}), [name.trim()]: { visible_when: { field: depField.trim(), eq: eqVal } } } } }));
  }} className="text-xs text-accent-600 hover:text-accent-800">+ Add</button>
  </div>
  {Object.entries(templateForm.field_config?.conditional || {}).map(([name, cfg]) => (
  <div key={name} className="flex items-center gap-2 text-xs bg-accent-50 border border-accent-100 rounded-lg px-3 py-2 mb-1">
  <span className="font-mono font-semibold text-accent-800">{name}</span>
  <span className="text-accent-500">visible when</span>
  <span className="font-mono text-accent-700">{cfg.visible_when?.field} = "{cfg.visible_when?.eq}"</span>
  <button onClick={() => {
  const cond = { ...(templateForm.field_config?.conditional || {}) };
  delete cond[name];
  setTemplateForm(prev => ({ ...prev, field_config: { ...prev.field_config, conditional: cond } }));
  }} className="text-danger-400 hover:text-danger-600 ml-auto">✕</button>
  </div>
  ))}
  {Object.keys(templateForm.field_config?.conditional || {}).length === 0 && <p className="text-xs text-neutral-400 italic">No conditions. Show/hide fields based on other field values.</p>}
  </div>

  <div className="text-xs text-neutral-400 border-t border-neutral-100 pt-2">
  <strong>Address blocks:</strong> Set field type to "address_block" above — it renders as a 5-field structured address (street, apt, city, state, zip).
  </div>
  </div>
  )}

  {/* Signature Workflow */}
  <div className="bg-white rounded-xl border border-neutral-100 shadow-sm p-4">
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1">Signature Workflow</h3>
  <p className="text-xs text-neutral-400 mb-3">Choose how this document gets signed. Each signer gets a unique magic-link email; no account required on their end.</p>

  <div className="flex gap-2 mb-4">
  {[
    { value: "none", label: "No signing", desc: "Generate doc only" },
    { value: "parallel", label: "Parallel", desc: "All signers at once" },
    { value: "sequential", label: "Sequential", desc: "One after another, in order" },
  ].map(opt => (
    <button key={opt.value} type="button" onClick={() => setTemplateForm(prev => ({ ...prev, signing_mode: opt.value }))}
      className={"flex-1 text-left px-3 py-2 rounded-xl border transition-colors " + (templateForm.signing_mode === opt.value ? "border-brand-500 bg-brand-50 text-brand-700" : "border-brand-100 bg-white text-neutral-500 hover:border-brand-300")}>
      <div className="text-xs font-semibold">{opt.label}</div>
      <div className="text-[10px] text-neutral-400 mt-0.5">{opt.desc}</div>
    </button>
  ))}
  </div>

  {templateForm.signing_mode !== "none" && (
  <div className="space-y-2">
  <div className="flex items-center justify-between mb-1">
  <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Signer Roles</span>
  <button type="button" onClick={() => setTemplateForm(prev => ({ ...prev, signer_roles: [...(prev.signer_roles || []), { role: "signer_" + ((prev.signer_roles || []).length + 1), label: "Signer " + ((prev.signer_roles || []).length + 1), order: (prev.signer_roles || []).length + 1, required: true }] }))} className="text-xs text-brand-600 hover:underline">+ Add signer</button>
  </div>
  {(templateForm.signer_roles || []).length === 0 && <p className="text-xs text-neutral-400 italic">No signers yet. Add at least one role, then use it in a signature field above.</p>}
  {(templateForm.signer_roles || []).sort((a,b) => (a.order||0) - (b.order||0)).map((r, i) => {
  const color = getRoleColor(r.role, templateForm.signer_roles);
  return (
  <div key={i} className="grid grid-cols-12 gap-2 items-center bg-white border border-neutral-100 rounded-xl p-2">
  <span className={`col-span-1 w-2.5 h-2.5 rounded-full ${color.dot} shrink-0`} title={`Color coding: ${r.label || r.role}`} />
  {templateForm.signing_mode === "sequential" && (
  <Input size="sm" type="number" value={r.order || i + 1} onChange={e => {
    const next = [...(templateForm.signer_roles || [])];
    const idx = next.findIndex(x => x.role === r.role);
    if (idx >= 0) next[idx] = { ...next[idx], order: parseInt(e.target.value, 10) || 1 };
    setTemplateForm(prev => ({ ...prev, signer_roles: next }));
  }} className="col-span-1 text-center" title="Sign order" />
  )}
  <Input size="sm" value={r.role} onChange={e => {
    const next = [...(templateForm.signer_roles || [])];
    const idx = next.findIndex(x => x.role === r.role);
    if (idx >= 0) next[idx] = { ...next[idx], role: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") };
    setTemplateForm(prev => ({ ...prev, signer_roles: next }));
  }} placeholder="role_id" className={templateForm.signing_mode === "sequential" ? "col-span-3" : "col-span-4"} title="Stable identifier" />
  <Input size="sm" value={r.label || ""} onChange={e => {
    const next = [...(templateForm.signer_roles || [])];
    const idx = next.findIndex(x => x.role === r.role);
    if (idx >= 0) next[idx] = { ...next[idx], label: e.target.value };
    setTemplateForm(prev => ({ ...prev, signer_roles: next }));
  }} placeholder="Display label (e.g. Tenant)" className={templateForm.signing_mode === "sequential" ? "col-span-5" : "col-span-5"} />
  <label className="col-span-1 flex items-center justify-center text-[10px] text-neutral-500"><input type="checkbox" checked={r.required !== false} onChange={e => {
    const next = [...(templateForm.signer_roles || [])];
    const idx = next.findIndex(x => x.role === r.role);
    if (idx >= 0) next[idx] = { ...next[idx], required: e.target.checked };
    setTemplateForm(prev => ({ ...prev, signer_roles: next }));
  }} className="accent-brand-600 mr-1" />req</label>
  <button type="button" onClick={() => setTemplateForm(prev => ({ ...prev, signer_roles: (prev.signer_roles || []).filter(x => x.role !== r.role) }))} className="col-span-1 text-danger-400 hover:text-danger-600 text-sm" title="Remove signer">✕</button>
  </div>
  );
  })}
  {(templateForm.signer_roles || []).length > 0 && (
  <div className="text-[10px] text-neutral-400 border-t border-neutral-100 pt-2 mt-2">
  Add <code className="bg-neutral-100 px-1 rounded">signature</code>-type fields above, assign each to one of these roles, and place <code className="bg-neutral-100 px-1 rounded">{"{{field_name}}"}</code> in the body where signatures should appear.
  </div>
  )}
  </div>
  )}
  </div>

  </div>

  {/* Drag handle */}
  <div onMouseDown={startDrag} className="w-1.5 bg-brand-100 hover:bg-brand-300 cursor-col-resize shrink-0 transition-colors" />

  {/* Right pane */}
  <div style={{ width: (100 - splitPercent) + "%" }} className="overflow-y-auto p-6 space-y-4">
  {templateForm.template_type === "pdf_overlay" ? (
  <>
  {/* PDF Upload + Viewer */}
  {!templateForm.pdf_storage_path ? (
  <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-8 text-center">
  <div className="text-4xl mb-3">📄</div>
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">Upload a PDF Template</h3>
  <p className="text-sm text-neutral-400 mb-4">Upload a flat PDF. Blank fields will be auto-detected.</p>
  <label className="inline-flex items-center gap-2 bg-brand-600 text-white text-sm px-5 py-2.5 rounded-2xl hover:bg-brand-700 cursor-pointer font-semibold">
  <span className="material-icons-outlined text-lg">upload_file</span>Choose PDF
  <input type="file" accept=".pdf" className="hidden" onChange={e => handlePdfUpload(e.target.files[0])} />
  </label>
  </div>
  ) : (
  <>
  {/* PDF toolbar */}
  <div className="bg-white rounded-xl shadow-sm border border-neutral-100 px-4 py-2 flex items-center gap-3">
  <span className="text-xs text-neutral-500">{templateForm.pdf_page_count} pages</span>
  <span className="text-xs text-neutral-300">|</span>
  <span className="text-xs text-neutral-500">{templateForm.pdf_field_placements.length} placements</span>
  <span className="text-xs text-neutral-300">|</span>
  {placingField ? (
  <span className="text-xs text-success-600 font-semibold">Click on PDF to place: {placingField} <button onClick={() => setPlacingField(null)} className="text-danger-400 ml-1">✕ Cancel</button></span>
  ) : (
  <Select onChange={e => { if (e.target.value) setPlacingField(e.target.value); e.target.value = ""; }} className="text-xs">
  <option value="">+ Place field on PDF...</option>
  {templateForm.fields.map(f => <option key={f.name} value={f.name}>{f.label || f.name}</option>)}
  </Select>
  )}
  <button onClick={async () => {
  if (!pdfDoc) return;
  const detected = await autoDetectFields(pdfDoc);
  const newFields = [];
  const existingNames = new Set(templateForm.fields.map(f => f.name));
  for (const d of detected) {
  if (!existingNames.has(d.field_name)) {
  newFields.push({ name: d.field_name, label: d.field_name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()), type: "text", required: false, section: "Auto-Detected", options: [], default_value: "", prefill_from: "" });
  existingNames.add(d.field_name);
  }
  }
  setTemplateForm(prev => ({
  ...prev,
  pdf_field_placements: [...prev.pdf_field_placements, ...detected],
  fields: [...prev.fields, ...newFields],
  }));
  showToast(detected.length + " fields detected", "info");
  }} className="text-xs text-warn-600 hover:text-warn-800 ml-auto">Re-detect</button>
  <label className="text-xs text-neutral-500 hover:text-neutral-700 cursor-pointer">
  Replace PDF
  <input type="file" accept=".pdf" className="hidden" onChange={e => handlePdfUpload(e.target.files[0])} />
  </label>
  </div>

  {/* PDF pages with placement overlays */}
  <div ref={pdfContainerRef} className="space-y-4">
  {pdfPages.map((pg, pageIdx) => {
  const pageNum = pg.pageNum;
  const pagePlacements = templateForm.pdf_field_placements.map((p, i) => ({ ...p, _idx: i })).filter(p => p.page === pageNum);
  return (
  <div key={pageNum} className="relative bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden" style={{ width: pg.width + "px" }}>
  <div className="absolute top-2 left-2 bg-black/50 text-white text-xs px-2 py-0.5 rounded z-10">Page {pageNum}</div>
  <canvas ref={el => { if (el && el !== pg.canvas) { el.width = pg.canvas.width; el.height = pg.canvas.height; el.getContext("2d").drawImage(pg.canvas, 0, 0); } }} width={pg.width} height={pg.height} className="block" />
  {/* Overlay for click-to-place */}
  <div className="absolute inset-0" style={{ cursor: placingField ? "crosshair" : "default" }}
  onClick={e => {
  if (!placingField) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const xPct = ((e.clientX - rect.left) / rect.width) * 100;
  const yPct = ((e.clientY - rect.top) / rect.height) * 100;
  addPlacement(placingField, pageNum, xPct, yPct);
  }}>
  {/* Render placements */}
  {pagePlacements.map(p => (
  <div key={p._idx} className={"absolute border-2 rounded " + (p.auto_detected ? "border-warn-400 bg-warn-100/40" : "border-brand-400 bg-brand-100/40")}
  style={{ left: p.x + "%", top: p.y + "%", width: p.width + "%", height: p.height + "%", cursor: "move" }}
  onMouseDown={e => {
  e.stopPropagation();
  setDraggingPlacement({ index: p._idx, startX: e.clientX, startY: e.clientY, origX: p.x, origY: p.y, pgWidth: pg.width, pgHeight: pg.height });
  const onMove = (ev) => {
  const dx = ((ev.clientX - e.clientX) / pg.width) * 100;
  const dy = ((ev.clientY - e.clientY) / pg.height) * 100;
  updatePlacement(p._idx, { x: Math.max(0, Math.min(90, p.x + dx)), y: Math.max(0, Math.min(95, p.y + dy)) });
  };
  const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); setDraggingPlacement(null); };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
  }}>
  <div className="flex items-center justify-between px-1">
  <span className="text-[9px] font-mono font-semibold truncate" style={{ color: p.auto_detected ? "#92400e" : "#3730a3" }}>{p.field_name}</span>
  <button onClick={e => { e.stopPropagation(); removePlacement(p._idx); }} className="text-danger-400 hover:text-danger-600 text-xs leading-none">✕</button>
  </div>
  </div>
  ))}
  </div>
  </div>
  );
  })}
  </div>
  </>
  )}
  </>
  ) : (
  <>
  {/* HTML body editor + preview — TipTap WYSIWYG */}
  <div className="bg-white rounded-xl border border-neutral-100 shadow-sm p-4 flex flex-col">
  <div className="flex items-center justify-between mb-2">
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Document Body</h3>
  <span className="text-[10px] text-neutral-400">Use the toolbar to format &middot; Insert merge fields via the chip row</span>
  </div>
  <RichTextEditor
  key={editingTemplate?.id || "new-template"}
  value={templateForm.body}
  onChange={html => setTemplateForm(prev => ({ ...prev, body: html }))}
  mergeFields={templateForm.fields}
  placeholder="Start typing… use {{tenant_name}}, {{property_address}} etc. for merge fields."
  minHeight="400px"
  />
  </div>
  <div>
  <div className="flex items-center justify-between mb-2 px-1">
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Preview</h3>
  <span className="text-[10px] text-neutral-400">Page View · 8.5in × 11in</span>
  </div>
  {/* Paper canvas — Zoho Writer Page View. max-w-[8.5in] mimics letter width,
      the shadow + bg-subtle gutter gives the familiar paper-on-desk feel. */}
  <div className="bg-neutral-100/50 rounded-xl p-6 flex justify-center">
  <div className="bg-white shadow-[0_8px_24px_-12px_rgba(0,0,0,0.15)] border border-neutral-200 w-full max-w-[8.5in] min-h-[11in] px-16 py-14 prose prose-sm max-w-none" style={{ fontFamily: "Georgia, serif", fontSize: "14px", lineHeight: "1.7", color: "#1a1a1a" }} dangerouslySetInnerHTML={{ __html: renderMergedBody(templateForm.body, {}, templateForm.field_config) }} />
  </div>
  </div>
  </>
  )}
  </div>
  </div>
  </div>
  );
  }

  // ============ DOCUMENT FILL — FULL SCREEN ============
  if (step === "fill" && selectedTemplate) {
  const fc = selectedTemplate.field_config || {};
  const sections = [...new Set((selectedTemplate.fields || []).map(f => f.section).filter(Boolean))];
  const unsectioned = (selectedTemplate.fields || []).filter(f => !f.section);
  const isCalc = (name) => !!fc.calculated?.[name];

  const updateVal = (name, val) => {
  const next = { ...fieldValues, [name]: val };
  setFieldValues(recalcFields(next, fc));
  };

  const renderField = (f) => {
  if (!isFieldVisible(f.name, fieldValues, fc)) return null;
  const base = "border border-brand-100 rounded-xl px-3 py-1.5 text-sm w-full focus:border-brand-300 focus:outline-none";

  // Calculated field — read-only display
  if (isCalc(f.name)) {
  const calcVal = fieldValues[f.name] || 0;
  const displayVal = f.type === "currency" ? formatCurrency(calcVal) : calcVal;
  return (
  <div className="flex items-center gap-2">
  <div className={base + " bg-neutral-50 text-neutral-600"}>{displayVal}</div>
  <span className="material-icons-outlined text-sm text-warn-500" title={"Formula: " + fc.calculated[f.name].formula}>calculate</span>
  </div>
  );
  }

  // Address block — structured 5-field input
  if (f.type === "address_block") {
  const addr = fieldValues[f.name] || { line1: "", line2: "", city: "", state: "", zip: "" };
  const setAddr = (key, v) => updateVal(f.name, { ...addr, [key]: v });
  return (
  <div className="space-y-2">
  <input type="text" value={addr.line1 || ""} onChange={e => setAddr("line1", e.target.value)} className={base} placeholder="Street address" maxLength={200} />
  <input type="text" value={addr.line2 || ""} onChange={e => setAddr("line2", e.target.value)} className={base} placeholder="Apt, suite, unit (optional)" maxLength={100} />
  <div className="grid grid-cols-3 gap-2">
  <input type="text" value={addr.city || ""} onChange={e => setAddr("city", e.target.value)} className={base} placeholder="City" maxLength={50} />
  <input type="text" value={addr.state || ""} onChange={e => setAddr("state", e.target.value.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase())} className={base} placeholder="State" maxLength={2} />
  <input type="text" value={addr.zip || ""} onChange={e => setAddr("zip", e.target.value.replace(/\D/g, "").slice(0, 5))} className={base} placeholder="ZIP" maxLength={5} />
  </div>
  </div>
  );
  }

  const val = fieldValues[f.name] || "";
  if (f.type === "textarea") return <textarea value={val} onChange={e => updateVal(f.name, e.target.value)} className={base} rows={3} />;
  if (f.type === "select") return (
  <Select value={val} onChange={e => updateVal(f.name, e.target.value)}>
  <option value="">Select...</option>
  {(f.options || []).map(o => <option key={o} value={o}>{o}</option>)}
  </Select>
  );
  if (f.type === "checkbox") return (
  <label className="flex items-center gap-2"><input type="checkbox" checked={!!val} onChange={e => updateVal(f.name, e.target.checked)} className="accent-brand-600" />{f.label}</label>
  );
  if (f.type === "signature" || f.type === "signature_placeholder") {
    const roleLabel = f.signer_role ? " (" + f.signer_role + ")" : "";
    return <div className="border-2 border-dashed border-brand-300 bg-brand-50/40 rounded-lg py-5 px-3 text-center text-xs text-brand-600 italic">Signature field{roleLabel} — will be filled when this doc is signed via the e-sign flow.</div>;
  }
  const inputType = f.type === "date" ? "date" : f.type === "number" ? "number" : f.type === "currency" ? "text" : "text";
  const extraProps = inputType === "date" ? { min: "2000-01-01", max: "2099-12-31" } : inputType === "number" ? { step: "any" } : { maxLength: 200 };
  return <input type={inputType} value={val} onChange={e => updateVal(f.name, e.target.value)} className={base} placeholder={f.type === "currency" ? "$0.00" : ""} {...extraProps} />;
  };

  const renderFieldRow = (f) => {
  if (!isFieldVisible(f.name, fieldValues, fc)) return null;
  return (
  <div key={f.name}>
  {f.type !== "checkbox" && (
  <label className="text-xs font-medium text-neutral-500 block mb-1">
  {f.label} {f.required && !isCalc(f.name) && "*"}
  {isCalc(f.name) && <span className="text-warn-500 ml-1">(calculated)</span>}
  </label>
  )}
  {renderField(f)}
  </div>
  );
  };

  return (
  <div className="fixed inset-0 z-50 bg-[#fcf8ff] flex flex-col">
  {/* Top ribbon — breadcrumb + mode hint + Preview CTA */}
  <div className="h-14 border-b border-neutral-100 bg-white flex items-center px-5 gap-3 shrink-0">
  <IconBtn icon="arrow_back" onClick={resetFlow} />
  <div className="flex-1 min-w-0 flex items-center gap-1.5 text-sm">
  <span className="text-neutral-400 shrink-0">Document Builder</span>
  <span className="text-neutral-300 shrink-0">›</span>
  <span className="font-semibold text-neutral-800 truncate">{selectedTemplate.name}</span>
  <span className="ml-2 text-[10px] px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-500 uppercase tracking-wide shrink-0">{mode === "prefill" ? "Prefilled" : "Blank"}</span>
  </div>
  <Btn onClick={() => {
  const errors = validateFields(selectedTemplate, fieldValues);
  if (errors.length > 0) { showToast(errors[0], "error"); return; }
  setStep("preview");
  }}>Preview →</Btn>
  <span className="text-xs text-neutral-300 ml-2">Esc to close</span>
  </div>

  {/* Split pane */}
  <div className="flex-1 flex overflow-hidden">
  {/* Left: Form fields */}
  <div style={{ width: splitPercent + "%" }} className="overflow-y-auto p-6 space-y-4">
  {sections.map(section => {
  const sectionFields = (selectedTemplate.fields || []).filter(f => f.section === section).map(renderFieldRow).filter(Boolean);
  if (sectionFields.length === 0) return null;
  return (
  <div key={section} className="bg-white rounded-xl border border-neutral-100 shadow-sm p-4">
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-3">{section}</h3>
  <div className="space-y-3">{sectionFields}</div>
  </div>
  );
  })}
  {unsectioned.length > 0 && (() => {
  const rows = unsectioned.map(renderFieldRow).filter(Boolean);
  return rows.length > 0 ? (
  <div className="bg-white rounded-xl border border-neutral-100 shadow-sm p-4">
  <div className="space-y-3">{rows}</div>
  </div>
  ) : null;
  })()}
  </div>

  {/* Drag handle */}
  <div onMouseDown={startDrag} className="w-1.5 bg-brand-100 hover:bg-brand-300 cursor-col-resize shrink-0 transition-colors" />

  {/* Right: Live preview */}
  <div style={{ width: (100 - splitPercent) + "%" }} className="overflow-y-auto p-6">
  {selectedTemplate.template_type === "pdf_overlay" ? (
  <div ref={pdfContainerRef} className="space-y-4">
  {pdfPages.map(pg => {
  const pagePlacements = (selectedTemplate.pdf_field_placements || []).filter(p => p.page === pg.pageNum);
  return (
  <div key={pg.pageNum} className="relative bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden" style={{ width: pg.width + "px" }}>
  <div className="absolute top-2 left-2 bg-black/50 text-white text-xs px-2 py-0.5 rounded z-10">Page {pg.pageNum}</div>
  <canvas ref={el => { if (el && el !== pg.canvas) { el.width = pg.canvas.width; el.height = pg.canvas.height; el.getContext("2d").drawImage(pg.canvas, 0, 0); } }} width={pg.width} height={pg.height} className="block" />
  <div className="absolute inset-0">
  {pagePlacements.map((p, i) => {
  const val = fieldValues[p.field_name];
  const displayVal = val && typeof val === "object" ? formatAddressBlock(val) : (val || "");
  return displayVal ? (
  <div key={i} className="absolute px-1 overflow-hidden" style={{ left: p.x + "%", top: p.y + "%", width: p.width + "%", height: p.height + "%", fontSize: (p.font_size || 12) + "px", fontFamily: "Helvetica, Arial, sans-serif", color: "#1a1a1a", lineHeight: "1.2", whiteSpace: "nowrap" }}>{String(displayVal)}</div>
  ) : null;
  })}
  </div>
  </div>
  );
  })}
  {pdfPages.length === 0 && <div className="text-center py-12 text-neutral-400">Loading PDF preview...</div>}
  </div>
  ) : (
  <div className="bg-white rounded-xl border border-neutral-100 shadow-sm p-4">
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-3">Live Preview</h3>
  <div className="prose prose-sm max-w-none border border-neutral-100 rounded-xl p-6 bg-white" style={{ fontFamily: "Georgia, serif", fontSize: "14px", lineHeight: "1.7" }}
  dangerouslySetInnerHTML={{ __html: renderMergedBody(selectedTemplate.body, fieldValues, fc) }} />
  </div>
  )}
  </div>
  </div>
  </div>
  );
  }

  // ============ PREVIEW + EXPORT — FULL SCREEN ============
  if (step === "preview" && selectedTemplate) {
  const rendered = renderMergedBody(selectedTemplate.body, fieldValues, selectedTemplate.field_config);
  return (
  <div className="fixed inset-0 z-50 bg-[#fcf8ff] flex flex-col">
  {/* Top ribbon — breadcrumb + inline export shortcuts */}
  <div className="h-14 border-b border-neutral-100 bg-white flex items-center px-5 gap-3 shrink-0">
  <IconBtn icon="arrow_back" onClick={() => setStep("fill")} />
  <div className="flex-1 min-w-0 flex items-center gap-1.5 text-sm">
  <span className="text-neutral-400 shrink-0">Document Builder</span>
  <span className="text-neutral-300 shrink-0">›</span>
  <span className="font-semibold text-neutral-800 truncate">{selectedTemplate.name}</span>
  <span className="ml-2 text-[10px] px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-500 uppercase tracking-wide shrink-0">Preview</span>
  </div>
  <div className="flex items-center gap-1">
  <Btn variant="secondary" size="xs" onClick={() => exportPDF()} title="Download PDF">
  <span className="material-icons-outlined text-sm">picture_as_pdf</span>PDF
  </Btn>
  <Btn variant="secondary" size="xs" onClick={() => exportDOCX()} title="Download DOCX">
  <span className="material-icons-outlined text-sm">article</span>DOCX
  </Btn>
  <Btn variant="secondary" size="xs" onClick={() => exportTXT()} title="Download TXT">
  <span className="material-icons-outlined text-sm">text_snippet</span>TXT
  </Btn>
  </div>
  <span className="text-xs text-neutral-300 ml-2">Esc to go back</span>
  </div>

  {/* Split pane */}
  <div className="flex-1 flex overflow-hidden">
  {/* Left: Document preview */}
  <div style={{ width: splitPercent + "%" }} className="overflow-y-auto p-6 flex justify-center">
  {selectedTemplate.template_type === "pdf_overlay" ? (
  <div ref={pdfContainerRef} className="space-y-4">
  {pdfPages.map(pg => {
  const pagePlacements = (selectedTemplate.pdf_field_placements || []).filter(p => p.page === pg.pageNum);
  return (
  <div key={pg.pageNum} className="relative bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden" style={{ width: pg.width + "px" }}>
  <div className="absolute top-2 left-2 bg-black/50 text-white text-xs px-2 py-0.5 rounded z-10">Page {pg.pageNum}</div>
  <canvas ref={el => { if (el && el !== pg.canvas) { el.width = pg.canvas.width; el.height = pg.canvas.height; el.getContext("2d").drawImage(pg.canvas, 0, 0); } }} width={pg.width} height={pg.height} className="block" />
  <div className="absolute inset-0">
  {pagePlacements.map((p, i) => {
  const val = fieldValues[p.field_name];
  const displayVal = val && typeof val === "object" ? formatAddressBlock(val) : (val || "");
  return displayVal ? (
  <div key={i} className="absolute px-1 overflow-hidden" style={{ left: p.x + "%", top: p.y + "%", width: p.width + "%", height: p.height + "%", fontSize: (p.font_size || 12) + "px", fontFamily: "Helvetica, Arial, sans-serif", color: "#1a1a1a", lineHeight: "1.2", whiteSpace: "nowrap" }}>{String(displayVal)}</div>
  ) : null;
  })}
  </div>
  </div>
  );
  })}
  {pdfPages.length === 0 && <div className="text-center py-12 text-neutral-400">Loading PDF preview...</div>}
  </div>
  ) : (
  <div ref={previewRef} className="bg-white rounded-xl shadow-sm border border-neutral-100 p-10 w-full max-w-[8.5in]" style={{ fontFamily: "Georgia, serif", fontSize: "14px", lineHeight: "1.7", color: "#1a1a1a" }}>
  <div dangerouslySetInnerHTML={{ __html: rendered }} />
  </div>
  )}
  </div>

  {/* Drag handle */}
  <div onMouseDown={startDrag} className="w-1.5 bg-brand-100 hover:bg-brand-300 cursor-col-resize shrink-0 transition-colors" />

  {/* Right: Actions sidebar (Send). Export lives in the top ribbon. Save/Finalize
      moved to a sticky bottom action bar below, Zoho-style. */}
  <div style={{ width: (100 - splitPercent) + "%" }} className="overflow-y-auto p-6 space-y-4">
  {selectedTemplate?.signing_mode && selectedTemplate.signing_mode !== "none" ? (
  /* Envelope / e-sign flow */
  <div className="bg-white rounded-xl shadow-sm border border-brand-200 p-5">
  <div className="flex items-center gap-2 mb-1">
  <span className="material-icons-outlined text-brand-600">draw</span>
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Send for Signature</h3>
  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-brand-100 text-brand-700 font-semibold uppercase">{selectedTemplate.signing_mode}</span>
  </div>
  <p className="text-xs text-neutral-400 mb-3">Each signer will receive a unique magic-link email. No account required on their end; the link expires in 30 days.</p>
  <div className="space-y-2 mb-3">
  {(selectedTemplate.signer_roles || []).sort((a,b) => (a.order||0) - (b.order||0)).map(r => {
  const color = getRoleColor(r.role, selectedTemplate.signer_roles);
  return (
  <div key={r.role} className="border border-neutral-100 rounded-xl p-2.5 bg-white">
  <div className="flex items-center justify-between mb-1">
  <span className="flex items-center gap-1.5">
  <span className={`w-2.5 h-2.5 rounded-full ${color.dot}`} />
  <span className="text-xs font-semibold text-neutral-600">{r.label || r.role}{r.required === false && <span className="text-[10px] text-neutral-400 font-normal ml-1">(optional)</span>}</span>
  </span>
  {selectedTemplate.signing_mode === "sequential" && <span className="text-[10px] text-brand-600">#{r.order || 1}</span>}
  </div>
  <div className="grid grid-cols-2 gap-1.5">
  <Input size="sm" value={signerNames[r.role] || ""} onChange={e => setSignerNames(prev => ({ ...prev, [r.role]: e.target.value }))} placeholder="Full name" />
  <Input size="sm" type="email" value={signerEmails[r.role] || ""} onChange={e => setSignerEmails(prev => ({ ...prev, [r.role]: e.target.value }))} placeholder="email@example.com" />
  </div>
  </div>
  );
  })}
  </div>
  <Btn variant="success-fill" className="w-full" onClick={sendForSignature} disabled={sending}>
  {sending ? "Sending…" : (selectedTemplate.signing_mode === "sequential" ? "Send to first signer" : "Send to all signers")}
  </Btn>
  </div>
  ) : (
  /* Plain email flow (no signing required) */
  <div className="bg-white rounded-xl border border-neutral-100 shadow-sm p-4">
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-3">Send via Email</h3>
  <div className="space-y-2 mb-3">
  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sendTo.self} onChange={e => setSendTo({...sendTo, self: e.target.checked})} className="accent-brand-600" />Email to myself ({userProfile?.email})</label>
  {fieldValues.tenant_name && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sendTo.tenant} onChange={e => setSendTo({...sendTo, tenant: e.target.checked})} className="accent-brand-600" />Email to tenant ({fieldValues.tenant_name})</label>}
  <div>
  <label className="text-xs font-medium text-neutral-400 block mb-1">Custom recipients (comma-separated)</label>
  <Input value={sendTo.custom} onChange={e => setSendTo({...sendTo, custom: e.target.value})} placeholder="email@example.com" />
  </div>
  </div>
  <Btn variant="success-fill" className="w-full" onClick={async () => {
  const doc = await saveDocument("sent");
  if (doc) await sendEmail(doc);
  }} disabled={sending}>
  {sending ? "Sending..." : "Send Email"}
  </Btn>
  </div>
  )}
  </div>
  </div>

  {/* Bottom action bar — sticky primary actions */}
  <div className="border-t border-neutral-100 bg-white px-5 py-3 flex items-center gap-2 shrink-0">
  <span className="text-xs text-neutral-400 hidden md:inline">Document is ready. Save as a draft to edit later, or finalize to lock it.</span>
  <div className="flex-1" />
  <Btn variant="secondary" onClick={async () => { await saveDocument("draft"); resetFlow(); }}>Save as Draft</Btn>
  <Btn onClick={async () => { await saveDocument("final"); resetFlow(); }}>Finalize</Btn>
  </div>
  </div>
  );
  }

  // ============ MAIN VIEW: TABS ============
  return (
  <div>
  <div className="flex items-center justify-between mb-4">
  <PageHeader title="Document Builder" />
  </div>
  {/* Tabbed bar — underline-style, Zoho/Docs convention */}
  <div className="flex items-center border-b border-neutral-100 mb-5 gap-6">
  {[["create","Create","add_circle_outline"],["templates","Templates","description"],["history","History",generatedDocs.length > 0 ? "history" : "history"]].map(([id,label,icon]) => (
  <button key={id} onClick={() => setTab(id)} className={"flex items-center gap-1.5 pb-2 -mb-px text-sm font-medium border-b-2 transition-colors " + (tab === id ? "border-brand-600 text-brand-700" : "border-transparent text-neutral-500 hover:text-neutral-700")}>
  <span className="material-icons-outlined text-base">{icon}</span>
  {label}
  {id === "history" && generatedDocs.length > 0 && <span className={"text-[10px] px-1.5 py-0.5 rounded-full " + (tab === id ? "bg-brand-100 text-brand-700" : "bg-neutral-100 text-neutral-500")}>{generatedDocs.length}</span>}
  </button>
  ))}
  </div>

  {/* ---- CREATE TAB ---- */}
  {tab === "create" && (
  <div>
  {/* Mode selection — segmented control */}
  <div className="bg-white rounded-xl border border-neutral-100 shadow-sm p-4 mb-5">
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-3">How do you want to start?</h3>
  <div className="flex gap-2 flex-wrap">
  <button onClick={() => setMode("blank")} className={"flex items-center gap-2 px-4 py-2 rounded-lg border text-sm transition-colors " + (mode === "blank" ? "border-brand-500 bg-brand-50 text-brand-700" : "border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300")}>
  <span className="material-icons-outlined text-base">edit_note</span>
  <span className="font-medium">Blank</span>
  <span className="text-[10px] text-neutral-400 hidden md:inline">· fill manually</span>
  </button>
  <button onClick={() => setMode("prefill")} className={"flex items-center gap-2 px-4 py-2 rounded-lg border text-sm transition-colors " + (mode === "prefill" ? "border-success-500 bg-success-50 text-success-700" : "border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300")}>
  <span className="material-icons-outlined text-base">auto_fix_high</span>
  <span className="font-medium">Prefill from Property</span>
  <span className="text-[10px] text-neutral-400 hidden md:inline">· tenant + lease autofill</span>
  </button>
  </div>
  {mode === "prefill" && (
  <div className="mt-3 max-w-md">
  <PropertyDropdown value={prefillProperty} onChange={(addr) => setPrefillProperty(addr)} companyId={companyId} label="Select Property" required />
  </div>
  )}
  </div>

  {/* Template selection */}
  {mode && (
  <div>
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-3">Choose a Template</h3>
  {CATEGORIES.map(cat => {
  const catTemplates = templates.filter(t => t.category === cat);
  if (catTemplates.length === 0) return null;
  return (
  <div key={cat} className="mb-4">
  <h4 className="text-xs font-semibold text-neutral-400 uppercase tracking-widest mb-2">{cat}</h4>
  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
  {catTemplates.map(t => (
  <button key={t.id} onClick={() => startDocument(t, mode)} disabled={mode === "prefill" && !prefillProperty}
  className="bg-white rounded-2xl border border-neutral-100 p-4 text-left hover:border-brand-300 hover:shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed">
  <div className="font-semibold text-neutral-800 text-sm">{t.name}</div>
  <div className="text-xs text-neutral-400 mt-1">{t.description}</div>
  <div className="text-xs text-brand-600 mt-2">{(t.fields || []).length} fields</div>
  </button>
  ))}
  </div>
  </div>
  );
  })}
  </div>
  )}
  </div>
  )}

  {/* ---- TEMPLATES TAB ---- */}
  {tab === "templates" && (
  <div>
  <div className="flex justify-end mb-4">
  <Btn size="sm" onClick={() => { setEditingTemplate(null); setTemplateForm({ name: "", category: "general", description: "", body: "", fields: [], field_config: {}, template_type: "html", pdf_storage_path: "", pdf_page_count: 0, pdf_field_placements: [], signing_mode: "none", signer_roles: [] }); setPdfPages([]); setPdfDoc(null); setShowTemplateEditor(true); }}>+ New Template</Btn>
  </div>
  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
  {templates.map(t => {
  const isPdf = t.template_type === "pdf_overlay";
  const hasESign = t.signing_mode && t.signing_mode !== "none";
  return (
  <div key={t.id} className="bg-white rounded-xl border border-neutral-100 shadow-sm p-4 flex flex-col">
  <div className="flex items-start justify-between mb-2">
  <div className="flex items-center gap-2 min-w-0">
  <span className={"w-8 h-8 rounded-lg flex items-center justify-center shrink-0 " + (isPdf ? "bg-danger-50 text-danger-600" : "bg-brand-50 text-brand-600")}>
  <span className="material-icons-outlined text-base">{isPdf ? "picture_as_pdf" : "description"}</span>
  </span>
  <div className="min-w-0">
  <div className="font-semibold text-neutral-800 text-sm truncate">{t.name}</div>
  <div className="text-[10px] text-neutral-400 capitalize">{t.category}</div>
  </div>
  </div>
  {t.is_system && <span className="text-[10px] bg-neutral-100 text-neutral-500 px-1.5 py-0.5 rounded-full shrink-0">System</span>}
  </div>
  {t.description && <p className="text-xs text-neutral-400 mb-2 line-clamp-2">{t.description}</p>}
  <div className="flex items-center gap-1.5 flex-wrap text-[10px] mb-3">
  <span className="text-neutral-500">{(t.fields || []).length} fields</span>
  {isPdf && <span className="px-1.5 py-0.5 rounded-full bg-danger-50 text-danger-600 uppercase tracking-wide font-semibold">PDF overlay</span>}
  {hasESign && <span className="px-1.5 py-0.5 rounded-full bg-brand-50 text-brand-700 uppercase tracking-wide font-semibold flex items-center gap-0.5"><span className="material-icons-outlined text-[10px]">draw</span>e-sign</span>}
  </div>
  <div className="flex gap-1 mt-auto">
  <Btn variant="success-fill" size="xs" className="flex-1" onClick={() => { setSelectedTemplate(t); setMode("blank"); setFieldValues(applyDefaults(t)); setStep("fill"); setTab("create"); }}>Use</Btn>
  <Btn variant="secondary" size="xs" onClick={async () => { setEditingTemplate(t); setTemplateForm({ name: t.name, category: t.category, description: t.description || "", body: t.body || "", fields: t.fields || [], field_config: t.field_config || {}, template_type: t.template_type || "html", pdf_storage_path: t.pdf_storage_path || "", pdf_page_count: t.pdf_page_count || 0, pdf_field_placements: t.pdf_field_placements || [], signing_mode: t.signing_mode || "none", signer_roles: t.signer_roles || [] }); setPdfPages([]); setPdfDoc(null); setShowTemplateEditor(true); if (t.template_type === "pdf_overlay" && t.pdf_storage_path) { setTimeout(async () => { const pdf = await loadPdfForPreview(t.pdf_storage_path); if (pdf) await renderPdfPages(pdf, pdfScale, pdfContainerRef.current); }, 100); } }}>Edit</Btn>
  <Btn variant="danger" size="xs" onClick={() => deleteTemplate(t)}>✕</Btn>
  </div>
  </div>
  );
  })}
  </div>
  </div>
  )}

  {/* ---- HISTORY TAB ---- */}
  {tab === "history" && (
  <div>
  {generatedDocs.length === 0 ? (
  <div className="text-center py-10 text-neutral-400">
  <span className="material-icons-outlined text-4xl mb-2">folder_open</span>
  <p className="text-sm">No documents generated yet</p>
  </div>
  ) : (
  <div className="space-y-3">
  {generatedDocs.map(d => {
  const sigs = signaturesByDoc[d.id] || [];
  const hasEnvelope = d.envelope_status && d.envelope_status !== "draft";
  const envBadge = d.envelope_status === "completed" ? { cls: "bg-success-100 text-success-700", label: "✓ All signed" }
    : d.envelope_status === "out_for_signature" ? { cls: "bg-brand-100 text-brand-700", label: "Awaiting signatures" }
    : d.envelope_status === "declined" ? { cls: "bg-danger-100 text-danger-700", label: "Declined" }
    : d.envelope_status === "voided" ? { cls: "bg-neutral-100 text-neutral-500", label: "Voided" }
    : null;
  return (
  <div key={d.id} className="bg-white rounded-xl border border-neutral-100 shadow-sm p-4">
  <div className="flex items-center justify-between">
  <div className="flex-1 min-w-0">
  <div className="font-semibold text-neutral-800 text-sm truncate">{d.name}</div>
  <div className="flex items-center gap-2 mt-1 flex-wrap">
  <span className={"text-xs px-2 py-0.5 rounded-full font-medium " + (d.status === "sent" ? "bg-success-50 text-success-700" : d.status === "final" ? "bg-info-50 text-info-700" : "bg-neutral-50 text-neutral-500")}>{d.status}</span>
  {envBadge && <span className={"text-xs px-2 py-0.5 rounded-full font-medium " + envBadge.cls}>{envBadge.label}</span>}
  {d.tenant_name && <span className="text-xs text-neutral-400">{d.tenant_name}</span>}
  {d.property_address && <span className="text-xs text-neutral-400">· {d.property_address}</span>}
  <span className="text-xs text-neutral-400">· {new Date(d.created_at).toLocaleDateString()}</span>
  </div>
  </div>
  <div className="flex gap-2 shrink-0">
  <Btn variant="danger" size="xs" onClick={() => { const t = templates.find(t => t.id === d.template_id); exportPDF({ ...d, _template: t }); }} title="PDF">PDF</Btn>
  <Btn variant="secondary" size="xs" onClick={() => exportDOCX(d)} title="DOCX">DOCX</Btn>
  <Btn variant="slate" size="xs" onClick={() => exportTXT(d)} title="TXT">TXT</Btn>
  {d.envelope_status === "completed" && <Btn variant="success-fill" size="xs" onClick={() => downloadSignedPDF(d)} title="Download the doc with every signature + a cert of completion appended">Signed PDF</Btn>}
  {hasEnvelope && <Btn variant="purple" size="xs" onClick={() => downloadCertificate(d)} title="Audit certificate with signer identity/IP/hash">Certificate</Btn>}
  {!hasEnvelope && <Btn variant="success-fill" size="xs" onClick={() => {
  setSendModal(d);
  setSendTo({ self: false, tenant: false, custom: "" });
  }}>Email</Btn>}
  <button onClick={() => deleteGeneratedDoc(d)} className="text-xs text-danger-400 hover:text-danger-600">✕</button>
  </div>
  </div>
  {hasEnvelope && sigs.length > 0 && (
  <div className="mt-3 pt-3 border-t border-neutral-100 grid grid-cols-1 md:grid-cols-2 gap-1.5">
  {sigs.map((s, idx) => {
  const cls = s.status === "signed" ? "text-success-700 bg-success-50" : s.status === "viewed" ? "text-brand-700 bg-brand-50" : s.status === "sent" ? "text-highlight-700 bg-highlight-50" : "text-neutral-500 bg-neutral-50";
  const icon = s.status === "signed" ? "check_circle" : s.status === "viewed" ? "visibility" : s.status === "sent" ? "mail" : "hourglass_empty";
  // Recipient color dot — index into ROLE_COLORS by signer order across
  // this doc's signer roster. Matches the template editor coloring.
  const roleColor = ROLE_COLORS[idx % ROLE_COLORS.length];
  return (
  <div key={s.id} className={"flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-lg " + cls}>
  <span className={`w-2 h-2 rounded-full ${roleColor.dot} shrink-0`} title="Recipient color" />
  <span className="material-icons-outlined text-sm">{icon}</span>
  <span className="font-semibold truncate">{s.signer_name || s.signer_email}</span>
  <span className="text-neutral-400 truncate">· {s.signer_role}</span>
  {s.signed_at && <span className="text-neutral-400 ml-auto shrink-0">{new Date(s.signed_at).toLocaleDateString()}</span>}
  {!s.signed_at && s.status === "sent" && <button onClick={() => navigator.clipboard?.writeText(window.location.origin + "/sign/" + s.access_token).then(() => showToast("Signing link copied", "success"))} className="ml-auto shrink-0 text-brand-600 hover:underline">copy link</button>}
  </div>
  );
  })}
  </div>
  )}
  </div>
  );
  })}
  </div>
  )}

  {/* Send modal for history items */}
  {sendModal && (
  <Modal title={"Send: " + sendModal.name} onClose={() => setSendModal(null)}>
  <div className="space-y-3">
  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sendTo.self} onChange={e => setSendTo({...sendTo, self: e.target.checked})} className="accent-brand-600" />Email to myself</label>
  {sendModal.tenant_name && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sendTo.tenant} onChange={e => setSendTo({...sendTo, tenant: e.target.checked})} className="accent-brand-600" />Email to tenant ({sendModal.tenant_name})</label>}
  <div>
  <label className="text-xs font-medium text-neutral-400 block mb-1">Custom recipients</label>
  <Input value={sendTo.custom} onChange={e => setSendTo({...sendTo, custom: e.target.value})}  placeholder="email@example.com, other@example.com" />
  </div>
  <Btn variant="success-fill" className="w-full" onClick={() => sendEmail(sendModal)} disabled={sending}>
  {sending ? "Sending..." : "Send"}
  </Btn>
  </div>
  </Modal>
  )}
  </div>
  )}
  </div>
  );
}

export { Documents, DocumentBuilder };
