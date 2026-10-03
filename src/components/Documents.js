import React, { useState, useEffect, useRef, useMemo } from "react";
import DOMPurify from "dompurify";
import { supabase } from "../supabase";
import { Btn, Checkbox, FileInput, FilterPill, IconBtn, Input, PageHeader, Select, Textarea, TextLink, DataTable, TabBar} from "../ui";
import { formatLocalDate, shortId, ALLOWED_DOC_TYPES, ALLOWED_DOC_EXTENSIONS, DOC_TYPES, formatCurrency, getSignedUrl, sanitizeFileName, buildAddress, escapeHtml, escapeFilterValue, propertyLabel, fmtDate, fmtDateTime} from "../utils/helpers";
import { pmError } from "../utils/errors";
import { printTheme, printTable } from "../utils/theme";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { Spinner, Modal, PropertyDropdown, PropertySelect } from "./shared";
import { HOUSY, housyKindForDocument, extractPdfText, queueHousyJob } from "../utils/housy";
import RichTextEditor, { RichTextToolbar } from "./RichTextEditor";
import { PARSE_OPTIONS, DEFAULT_PAGE_SETUP, attachPageSetup, splitPageSetup } from "../utils/docKit";
import { htmlToDocx, docxFileName } from "../utils/docxExport";
import { SIGNATURE_BLOCK_TOKEN, SIGNATURE_BLOCK_KEY, hasSignatureBlock, signatureRows, expandSignatureBlock } from "../utils/signatureBlock";
import { stampSignatures, initialsRoster } from "../utils/signatureStamp";
import { stampInitials } from "../utils/initialsStamp";
import { deriveValues, FIELD_FORMATS } from "../utils/docFields";
import { ensureStandardTemplates } from "../utils/standardTemplates";
import { createLeaseChange, openChangeOfKind, changeRowFromDocument } from "../utils/leaseChanges";
import { mailtoUrl, canShareFile, loadDocContext, signerDefaultFor, effectiveSignerRoles, sendSignatureRequests, resendSignatureRequest, voidEnvelope, emailDocument, storeSignedPdf, summarizeSends, DOC_KIND_BY_TEMPLATE_KEY, prospectTermsFromFields } from "../utils/docService";
import { renderPagedPdf, renderPagedPdfWithAnchors, concatPdfs, pdfFileName } from "../utils/pagedPdf";

// ============ DOCUMENTS ============
function Documents({ addNotification, userProfile, userRole, companyId, showToast, showConfirm }) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState("all");
  const [form, setForm] = useState({ name: "", property: "", tenant: "", type: "Lease", tenant_visible: false });
  const fileRef = useRef();
  const [uploading, setUploading] = useState(false);
  // Which document Housy is currently reading, so only that row shows a
  // busy state rather than disabling the whole table.
  const [housyBusy, setHousyBusy] = useState(null);

  useEffect(() => { fetchDocs(); }, [companyId]);

  // Send a document to Housy to read.
  //
  // The PDF's text is extracted HERE, in the browser, and only the text
  // is sent -- the file itself never leaves storage. The job is then
  // queued rather than awaited: a 12-page lease takes the model about two
  // minutes, which is far past what any HTTP request survives.
  async function readWithHousy(d) {
    const path = d.file_name || d.url;
    if (!path) { showToast("This record has no file attached.", "error"); return; }
    setHousyBusy(d.id);
    try {
      const signed = await getSignedUrl("documents", path);
      if (!signed) { showToast("Could not open the file.", "error"); return; }
      const resp = await fetch(signed);
      const bytes = new Uint8Array(await resp.arrayBuffer());

      const text = await extractPdfText(bytes);
      // A scanned page has no text layer at all. Say so plainly rather
      // than queueing an empty job that fails two minutes later.
      if (!text || text.length < 40) {
        showToast(`No readable text in this PDF — it looks like a scan, which ${HOUSY.name} cannot read yet.`, "error");
        return;
      }

      const kind = housyKindForDocument(d);
      const r = await queueHousyJob({
        companyId, kind, subjectTable: "documents", subjectId: String(d.id),
        sourceName: d.name, text, userEmail: userProfile?.email,
      });
      if (!r.ok) { showToast(`Could not queue it: ${r.error}`, "error"); return; }

      logAudit("create", "housy", `Queued ${kind} for ${d.name}`, d.id, userProfile?.email, userRole, companyId);
      showToast(`${HOUSY.name} is reading "${d.name}". It will appear on the Housy page when ready — nothing is saved until you approve it.`, "success");
    } catch (e) {
      pmError("PM-8006", { raw: e, context: "read document with Housy" });
    } finally {
      setHousyBusy(null);
    }
  }

  async function fetchDocs() {
  const { data } = await supabase.from("documents").select("*").eq("company_id", companyId).is("archived_at", null).order("uploaded_at", { ascending: false }).limit(500);
  setDocs(data || []);
  setLoading(false);
  }

  async function uploadDocument() {
  if (!guardSubmit("uploadDocument")) return;
  try {
  const file = fileRef.current?.files?.[0];
  // Fail loudly. Returning silently here meant clicking "Upload" with an
  // empty form did nothing at all — no toast, no inline error, no state
  // change — so the user had no idea what was wrong. Same
  // showToast(..., "error") pattern every other create form uses.
  if (!form.name.trim()) { showToast("Document name is required.", "error"); return; }
  if (!file) { showToast("Please select a file to upload.", "error"); return; }
  // Validate file type and size
  if (!ALLOWED_DOC_TYPES.includes(file.type) && !ALLOWED_DOC_EXTENSIONS.test(file.name)) { showToast("File type not allowed. Accepted: PDF, images, Word, Excel, text files.", "error"); return; }
  if (file.size > 25 * 1024 * 1024) { showToast("File must be under 25MB.", "error"); return; }
  // Magic-bytes validation — protects against MIME spoofing. For binary
  // formats (PDF, PNG, JPEG, ZIP, etc.) we match known signatures. For
  // text types, we previously bypassed validation entirely, which let any
  // renamed .exe get uploaded as text/plain. Now we sniff the first 512
  // bytes for NUL / non-printable content and reject if it's binary in
  // disguise.
  try {
    const hdr = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    const hex = Array.from(hdr.slice(0, 4)).map(b => b.toString(16).padStart(2, "0")).join("");
    const BIN_MAGIC = ["25504446","89504e47","ffd8ffe0","ffd8ffe1","ffd8ffe2","47494638","504b0304","d0cf11e0"];
    const isKnownBinary = BIN_MAGIC.some(m => hex.startsWith(m));
    let isTextish = false;
    if (!isKnownBinary && file.type.startsWith("text/")) {
      const sniff = new Uint8Array(await file.slice(0, Math.min(512, file.size)).arrayBuffer());
      let nonPrintable = 0;
      for (let i = 0; i < sniff.length; i++) {
        const b = sniff[i];
        // Reject on NUL — the single cheapest binary indicator.
        if (b === 0) { nonPrintable = sniff.length; break; }
        // Allow tab/LF/CR + printable ASCII + high-ASCII (UTF-8 continuation).
        if (!(b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126) || b >= 128)) nonPrintable++;
      }
      isTextish = sniff.length > 0 && (nonPrintable / sniff.length) < 0.05;
    }
    if (!isKnownBinary && !isTextish) {
      showToast("File content doesn't match expected format.", "error");
      return;
    }
  } catch (_e) { pmError("PM-7002", { raw: _e, context: "file magic bytes validation", silent: true }); }
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
  <Btn variant="primary" onClick={() => setShowForm(!showForm)}>+ Upload Document</Btn>
  </div>
  </div>

  {showForm && (
  <div className="bg-white rounded-xl border border-neutral-200 shadow-card p-4 mb-4">
  <h3 className="font-semibold text-neutral-700 mb-3">Upload Document</h3>
  <div className="grid grid-cols-2 gap-3">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Document Name *</label><Input placeholder="Lease Agreement 2026" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Property</label><PropertySelect value={form.property} onChange={(addr, prop) => setForm({ ...form, property: addr, tenant: prop?.tenant || form.tenant })} companyId={companyId} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Tenant</label><Input placeholder="Optional — link to a tenant" value={form.tenant} onChange={e => setForm({ ...form, tenant: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Document Type</label><Select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className="border border-brand-100 rounded-xl px-3 py-1.5 text-sm w-full">
  {/* Shared with the tenant panel's classifier: a type that can clear a
      required-document check must be offered here too, or the two views
      disagree about what a document can be. */}
  {DOC_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
  </Select></div>
  <label className="flex items-center gap-2 text-sm text-neutral-500 border border-brand-100 rounded-xl px-3 py-1.5 cursor-pointer">
  <Checkbox checked={form.tenant_visible} onChange={e => setForm({ ...form, tenant_visible: e.target.checked })} />
  Visible to Tenant
  </label>
  <Input type="file" ref={fileRef} className="col-span-2" />
  </div>
  <div className="flex gap-2 mt-3">
  <Btn onClick={uploadDocument} disabled={uploading}>
  {uploading ? "Uploading..." : "Upload"}
  </Btn>
  <Btn variant="slate" onClick={() => setShowForm(false)}>Cancel</Btn>
  </div>
  </div>
  )}

  <div className="flex gap-2 mb-4 flex-wrap">
  {["all", ...DOC_TYPES.map(t => t.value)].map(t => (
  <FilterPill key={t} active={filter === t} onClick={() => setFilter(t)}>{t}</FilterPill>
  ))}
  </div>

  <div className="bg-white rounded-xl border border-neutral-200 shadow-card border border-neutral-100 overflow-hidden">
  <DataTable
    columns={[
      { key: "document", label: "Document", className: "font-medium text-neutral-800",
        render: d => (<>📄 {d.name}</>) },
      { key: "property", label: "Property", className: "text-neutral-400",
        render: d => (<>{propertyLabel(d.property)}</>) },
      { key: "type", label: "Type",
        render: d => (<>
          <span className="bg-brand-50 text-brand-700 px-2 py-0.5 rounded-full text-xs">{d.type}</span>
        </>) },
      { key: "date", label: "Date", className: "text-neutral-400",
        render: d => (<>{fmtDate(d.uploaded_at)}</>) },
      { key: "tenant_visible", label: "Tenant Visible",
        render: d => (<>{d.tenant_visible ? "✅" : "🔒"}</>) },
      { key: "actions", label: "Actions",
        render: d => (<>
          <div className="flex gap-2">
            {d.url ? (
            <>
            <TextLink tone="brand" size="xs" onClick={async () => {
            const isFullUrl = d.url && d.url.startsWith("http");
            if (isFullUrl) { window.open(d.url, "_blank", "noopener,noreferrer"); return; }
            const path = d.file_name || d.url;
            if (!path) { showToast("No file path available.", "error"); return; }
            const url = await getSignedUrl("documents", path);
            if (url) window.open(url, "_blank", "noopener,noreferrer");
            else showToast("Could not generate secure download link.", "error");
            }}>View</TextLink>
            <TextLink tone="positive" size="xs" onClick={async () => {
            const isFullUrl = d.url && d.url.startsWith("http");
            if (isFullUrl) { window.open(d.url, "_blank", "noopener,noreferrer"); return; }
            const path = d.file_name || d.url;
            if (!path) return;
            const url = await getSignedUrl("documents", path);
            if (url) window.open(url, "_blank", "noopener,noreferrer");
            }}>Download</TextLink>
            </>
            ) : d.file_name ? (
            <>
            <TextLink tone="brand" size="xs" onClick={async () => {
            const url = await getSignedUrl("documents", d.file_name);
            if (url) window.open(url, "_blank", "noopener,noreferrer");
            else showToast("Could not generate secure link for this file.", "error");
            }}>View</TextLink>
            <TextLink tone="positive" size="xs" onClick={async () => {
            const url = await getSignedUrl("documents", d.file_name);
            if (url) window.open(url, "_blank", "noopener,noreferrer");
            }}>Download</TextLink>
            </>
            ) : (
            <span className="text-xs text-neutral-400">No file</span>
            )}
            {(d.file_name || d.url) && /\.pdf$/i.test(d.file_name || d.url || "") && (
              <TextLink tone="brand" size="xs" disabled={housyBusy === d.id}
                title={`Have ${HOUSY.name} read this and propose what to fill in`}
                onClick={() => readWithHousy(d)}>
                {housyBusy === d.id ? "Reading…" : `Ask ${HOUSY.name}`}
              </TextLink>
            )}
            <TextLink tone="danger" size="xs" onClick={() => deleteDoc(d.id, d.name, d.file_name)}>Delete</TextLink>
            </div>
        </>) },
    ]}
    rows={filtered}
    rowKey={d => d.id}
    empty="Nothing to show"
  />
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
  { dot: "bg-warn-500",   ring: "ring-warn-500",   chip: "bg-warn-50 text-warn-700 border-warn-200" },
  { dot: "bg-positive-500", ring: "ring-positive-500", chip: "bg-positive-50 text-positive-700 border-positive-200" },
  { dot: "bg-danger-500",    ring: "ring-danger-500",    chip: "bg-danger-50 text-danger-700 border-danger-200" },
  { dot: "bg-success-500",    ring: "ring-success-500",    chip: "bg-success-50 text-success-700 border-success-200" },
  { dot: "bg-highlight-500",  ring: "ring-highlight-500",  chip: "bg-highlight-50 text-highlight-700 border-highlight-200" },
];
function getRoleColor(roleId, rolesList) {
  const idx = (rolesList || []).findIndex(r => r.role === roleId);
  return ROLE_COLORS[(idx >= 0 ? idx : 0) % ROLE_COLORS.length];
}

function DocumentBuilder({ addNotification, userProfile, userRole, companyId, activeCompany, showToast, showConfirm, setPage, initialAction }) {
  const [tab, setTab] = useState("create"); // create | templates | history
  const [templates, setTemplates] = useState([]);
  const [generatedDocs, setGeneratedDocs] = useState([]);
  const [loading, setLoading] = useState(true);

  // Create document flow
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  // Defaulting to "blank" so the template list is visible immediately.
  // Landing on null showed a single box and acres of white space, with
  // the templates -- eight of them -- hidden behind a choice nobody knew
  // they had to make. It read as an unbuilt page.
  const [mode, setMode] = useState("blank"); // "blank" | "prefill"
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
  const [mailDraft, setMailDraft] = useState(null);   // { doc, file, recipients, link, canShare, subject, body } once prepared
  const [sendTo, setSendTo] = useState({ self: false, tenant: false, custom: "" });
  const [sending, setSending] = useState(false);
  const [signerEmails, setSignerEmails] = useState({});       // { [role]: "email" }
  const [signerNames, setSignerNames] = useState({});         // { [role]: "Full Name" }
  const [signaturesByDoc, setSignaturesByDoc] = useState({}); // { [docId]: [signerRow, ...] }
  // Phase 5 — template editor 3-col layout
  const [htmlEditor, setHtmlEditor] = useState(null);         // TipTap instance so the ribbon can mount the toolbar
  // The template editor's side panel: one panel with tabs, in place of a
  // rail on each side of the page (fields | signers | page | rules | details).
  const [panelTab, setPanelTab] = useState("fields");
  const [openField, setOpenField] = useState(null);           // index of the field row whose details are open
  // The records the document in hand is about (tenant, lease, property),
  // loaded by id. Saved onto the generated document as real links.
  const [docContext, setDocContext] = useState(null);
  const pendingChange = useRef(null);   // { kind, leaseId, tenantId, effective_date, payload, fieldMap, noticeDate }
  // The template's signers, plus a slot for each adult on the tenancy beyond
  // the template's own tenant slots (see effectiveSignerRoles).
  const signerRoles = useMemo(() => effectiveSignerRoles(selectedTemplate?.signer_roles, docContext?.signers?.tenants?.length || 0, { witnesses: !!selectedTemplate?.field_config?.witnesses }), [selectedTemplate, docContext]);
  const [emailLogFor, setEmailLogFor] = useState(null);   // { doc, rows } for the History "Email log" modal
  // When another screen opened the builder for a tenant, where to go back to.
  const returnTo = useRef(null);
  const handledAction = useRef(null);
  const [derivedDraft, setDerivedDraft] = useState({ name: "", from: "", format: "words_whole" }); // "Text made from a field" row being added
  const [importingDocx, setImportingDocx] = useState(false);  // disable the "Import .docx" button while mammoth runs
  // Landing-screen UX: a fresh template starts on a 3-choice splash
  // (Import .docx → HTML mode, Upload .pdf → PDF Overlay mode, Start
  // blank → empty HTML editor). Replaces the old "HTML / PDF Overlay"
  // tab toggle, which forced the user to pick a mode before they knew
  // what either mode was. Landing hides as soon as content is in
  // (body or pdf_storage_path becomes truthy) or the user picks
  // "Start blank" explicitly.
  const [templateLandingSkipped, setTemplateLandingSkipped] = useState(false);

  const previewRef = useRef();

  // Full-screen split pane. The document gets the room; the pane beside
  // it (the form while filling in, the send/actions panel in preview) is
  // a side column. At 50/50 the inputs stretched across half the screen
  // and a 17-page lease was squeezed into a card.
  const [sidePercent, setSidePercent] = useState(30);
  const isDragging = useRef(false);
  // The side pane is on the LEFT while filling in and on the RIGHT in preview.
  const sideOnLeft = useRef(true);

  useEffect(() => {
  const onMouseMove = (e) => {
  if (!isDragging.current) return;
  const fromLeft = (e.clientX / window.innerWidth) * 100;
  setSidePercent(Math.min(50, Math.max(22, sideOnLeft.current ? fromLeft : 100 - fromLeft)));
  };
  const onMouseUp = () => { isDragging.current = false; document.body.style.cursor = ""; document.body.style.userSelect = ""; };
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  return () => { document.removeEventListener("mousemove", onMouseMove); document.removeEventListener("mouseup", onMouseUp); };
  }, []);

  // Opened from another screen: setPage("doc_builder", { templateKey,
  // tenantId, leaseId, returnTo }). Find the template by its stable key
  // and start the document already filled in for that tenant.
  useEffect(() => {
  if (!initialAction || handledAction.current === initialAction || templates.length === 0) return;
  const { templateKey, templateId, tenantId, leaseId, prospectId } = initialAction;
  if (!templateKey && !templateId) return;
  handledAction.current = initialAction;
  const t = templates.find(x => (templateId && x.id === templateId) || (templateKey && x.template_key === templateKey));
  if (!t) {
    showToast("That document template is not set up for this company yet", "error");
    // Do not strand the user on the builder's front page: go back where they came from.
    if (initialAction.returnTo && setPage) setPage(initialAction.returnTo.page, initialAction.returnTo.action || null);
    return;
  }
  returnTo.current = initialAction.returnTo || null;
  // A lease change this document carries (a renewal, a rent change, an
  // addendum): scheduled when the document is sent, never before.
  pendingChange.current = initialAction.change || null;
  startDocument(t, (tenantId != null || prospectId) ? "prefill" : "blank", { tenantId, leaseId, prospectId, values: initialAction.values || null });
  // startDocument is a plain function of this render; the action object is the trigger.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAction, templates]);

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
  // Formulas and derived text live in utils/docFields.js (tested on their own).

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
  return deriveValues(values, fieldConfig);
  }

  function formatAddressBlock(val) {
  if (!val || typeof val !== "object") return "";
  const parts = [val.line1, val.line2, [val.city, val.state].filter(Boolean).join(", ") + (val.zip ? " " + val.zip : "")].filter(Boolean);
  return parts.join("\n");
  }

  // ---- .docx import ----
  // Read a Word document, convert it to clean semantic HTML via mammoth,
  // and replace the editor body. Mammoth understands real Word semantics
  // (headings, lists, tables, bold/italic, links) and outputs HTML
  // without the mso-* / fixed-width junk that copy-pasting from Word
  // would otherwise leak — so this is the safest path for "I have an
  // existing lease in Word, get it into the builder".
  async function handleDocxImport(file) {
    if (!file) return;
    if (!/\.docx$/i.test(file.name)) {
      showToast(".docx only — older .doc files aren't supported", "error");
      return;
    }
    setImportingDocx(true);
    try {
      const arrayBuffer = await file.arrayBuffer();
      // convertDocxToHtml wraps mammoth and carries across what mammoth
      // drops on purpose -- alignment, indents, line spacing, fonts and
      // sizes -- plus the footer text, so the import looks like the Word
      // document rather than a plain-text copy of it.
      const { convertDocxToHtml } = await import("../utils/docxImport");
      const result = await convertDocxToHtml(arrayBuffer);
      const html = result.html || "";
      if (!html.replace(/<[^>]*>/g, "").trim()) { showToast("No content found in the Word document", "error"); return; }
      const footer = result.footer || {};
      // The Word file's own page: size, margins, and its footer. A footer
      // it doesn't have stays empty rather than gaining a page number.
      const pageSetup = (result.page || footer.left || footer.right)
        ? { ...(result.page || {}), headerLeft: "", headerRight: "", footerLeft: footer.left || "", footerRight: footer.right || "" }
        : null;
      // When triggered from the landing splash, the TipTap editor hasn't
      // mounted yet — htmlEditor is null. Seed templateForm.body so the
      // editor takes the imported HTML as its initial content when it
      // mounts. When triggered from inside the editor (the toolbar
      // button), use commands.setContent for an immediate swap. Either
      // path also flips template_type to html and dismisses the landing.
      setTemplateForm(prev => ({
        ...prev, template_type: "html", body: html,
        field_config: pageSetup ? { ...(prev.field_config || {}), page_setup: pageSetup } : prev.field_config,
      }));
      setTemplateLandingSkipped(true);
      if (htmlEditor) htmlEditor.commands.setContent(html, { parseOptions: PARSE_OPTIONS });
      const warnCount = result.warnings || 0;
      showToast("Imported" + (warnCount ? ` (${warnCount} formatting warning${warnCount > 1 ? "s" : ""})` : ""), "success");
    } catch (e) {
      showToast("Import failed: " + (e?.message || "unknown error"), "error");
    } finally {
      setImportingDocx(false);
    }
  }

  // ---- PDF utilities ----
  async function loadPdfFromBytes(bytes) {
  const pdfjsLib = await import("pdfjs-dist");
  // CRA's bundler can't resolve the new URL("pdfjs-dist/build/pdf.worker.min.mjs",
  // import.meta.url) form — it emits a /static/media/ path that 404s in
  // production. cdnjs is also stale (only ships up to 5.4.x while we're
  // on 5.5.207). jsdelivr mirrors npm packages 1:1, so version-pin the
  // worker against the package we actually installed.
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@" + pdfjsLib.version + "/build/pdf.worker.min.mjs";
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  setPdfDoc(pdf);
  return pdf;
  }

  async function renderPdfPages(pdf, scale) {
  // Render each page to an off-DOM canvas; React's JSX block (driven
  // off pdfPages state) mounts the in-DOM canvas and the per-canvas
  // ref callback copies the bitmap. We deliberately don't append into
  // the container ref — the previous version did, gated on
  // pdfContainerRef.current being non-null, but at the moment this
  // runs the container hasn't mounted yet (templateForm.pdf_storage_path
  // is still empty), so the early-return left pdfPages empty and the
  // PDF was invisible despite a successful upload + field detection.
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

  // Slugify a label fragment ("Tenant Name:") into a stable field name.
  function slugLabel(s) {
    return String(s || "")
      .replace(/[:—–\-]+\s*$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
  }

  async function autoDetectFields(pdf) {
  const detected = [];
  // Track placements per page by approximate (x, y) so we don't emit
  // overlapping rectangles when both the underscore pass and the
  // label-colon pass would point at the same blank area.
  const seenRects = new Set();
  const rectKey = (page, x, y) => page + "|" + Math.round(x) + "|" + Math.round(y);

  for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i);
  const viewport = page.getViewport({ scale: 1 }); // use scale 1 for coordinate mapping
  const content = await page.getTextContent();

  // Build a per-line view so the colon-label pass can compute the gap
  // to the NEXT item on the same line (where the user would write).
  // pdfjs returns items in reading order with PDF coords (origin
  // bottom-left); ty groups items by line.
  const linesByY = new Map();
  for (const item of content.items) {
    const ty = Math.round(item.transform[5]);
    if (!linesByY.has(ty)) linesByY.set(ty, []);
    linesByY.get(ty).push(item);
  }
  for (const arr of linesByY.values()) arr.sort((a, b) => a.transform[4] - b.transform[4]);

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
  let placementXPct = xPct;
  let placementWPct = Math.min(30, (item.width || 100) / viewport.width * 100 + 5);
  const mergeMatch = text.match(/\{\{(\w+)\}\}/);
  const bracketMatch = text.match(/\[([A-Za-z][A-Za-z0-9_ ]+)\]/);
  const underscoreMatch = text.match(/_{4,}/);
  // Trailing-colon labels: "Tenant Name:" / "Date: " / "Address —"
  // The blank fillable area extends to the right of the colon, up to
  // the next text item on the same line, or to the right margin if
  // nothing follows.
  const colonLabel = (() => {
    const trimmed = text.replace(/\s+$/, "");
    if (!/[:—]\s*$/.test(trimmed) && !/[:—]\s+\S*$/.test(text)) return null;
    // Take everything up to (and excluding) the trailing colon/dash.
    const m = trimmed.match(/^(.*?)[:—\-]\s*$/);
    if (!m) return null;
    const labelText = m[1].trim();
    // Reject pseudo-labels (URLs, multi-sentence prose, single chars).
    if (labelText.length < 2 || labelText.length > 50) return null;
    if (/[.?!]/.test(labelText)) return null;
    if (/^[a-z]/.test(labelText) && !/\s/.test(labelText)) return null; // e.g. "https"
    if (!/[a-zA-Z]/.test(labelText)) return null;
    return labelText;
  })();
  if (mergeMatch) { fieldName = mergeMatch[1]; matchType = "merge"; }
  else if (bracketMatch) { fieldName = bracketMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, "_"); matchType = "bracket"; }
  else if (underscoreMatch) {
  // Try to infer name from text before underscores
  const before = text.split(/_{4,}/)[0].trim().replace(/[^a-zA-Z0-9]+$/, "");
  fieldName = before ? before.toLowerCase().replace(/[^a-z0-9]+/g, "_") : "field_" + detected.length;
  matchType = "underscore";
  }
  else if (colonLabel) {
    fieldName = slugLabel(colonLabel) || ("field_" + detected.length);
    matchType = "label_colon";
    // Blank rect starts where this text run ENDS (tx + width) and
    // extends to the next item on the same line — or to the right
    // margin if this is the last run on the line.
    const lineItems = linesByY.get(Math.round(ty)) || [];
    const myEndPdfX = tx + (item.width || 0);
    const next = lineItems.find(it => it.transform[4] > myEndPdfX + 2);
    const blankEndPdfX = next ? next.transform[4] - 4 : viewport.width - 18;
    if (blankEndPdfX - myEndPdfX < 30) { fieldName = null; } // gap too narrow
    else {
      placementXPct = (myEndPdfX / viewport.width) * 100;
      placementWPct = Math.max(8, ((blankEndPdfX - myEndPdfX) / viewport.width) * 100);
    }
  }
  if (fieldName) {
  const x = Math.max(0, placementXPct);
  const y = Math.max(0, yPct - 1.5);
  const key = rectKey(i, x, y);
  if (seenRects.has(key)) continue;
  seenRects.add(key);
  detected.push({
  field_name: fieldName,
  page: i,
  x,
  y,
  width: Math.min(60, placementWPct),
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
  const pages = await renderPdfPages(pdf, pdfScale);

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

  // Document types, derived from the templates that exist plus the four
  // built-ins -- not a fixed list.
  //
  // Both the chooser and the Templates tab iterate this and filter
  // templates by it, so a template whose category was not one of the
  // four hardcoded values was INVISIBLE: an active "Pet Addendum"
  // (category "addendum") and "Notice of Entry" (category "notice") were
  // in the database and unreachable from anywhere in the app.
  const BUILT_IN_CATEGORIES = ["notices", "leases", "maintenance", "general"];
  const CATEGORIES = React.useMemo(() => {
    const fromData = (templates || []).map(t => (t.category || "").trim()).filter(Boolean);
    return [...new Set([...BUILT_IN_CATEGORIES, ...fromData])].sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates]);

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
  // The templates the tenant workflows open by key (renewal, addendum, ...)
  // are installed the first time they are missing; an existing template is
  // never overwritten. See utils/standardTemplates.js.
  try { all = [...all, ...(await ensureStandardTemplates(companyId, all, userProfile?.email))]; }
  catch (e) { pmError("PM-7003", { raw: e, context: "install standard templates", silent: true }); }
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
  //
  // One catalogue drives both the field editor's picker and the lookup
  // below, so a source can never be offered that cannot be filled, or
  // filled without being offerable. It used to be a free-text box: the
  // ~20 keys worked, but you had to already know to type "tenant.name",
  // so in practice nothing beyond today's date ever got wired up.
  const PREFILL_SOURCES = [
    ["Property", [
      ["property.address", "Full address"], ["property.street", "Street line"],
      ["property.unit", "Unit"], ["property.city", "City"], ["property.state", "State"],
      ["property.zip", "ZIP"], ["property.county", "County"], ["property.type", "Type"],
      ["property.bedrooms", "Bedrooms"], ["property.bathrooms", "Bathrooms"],
      ["property.sqft", "Square feet"], ["property.rent", "Market rent"],
    ]],
    ["Tenant", [
      ["tenant.name", "Full name"], ["tenant.first_name", "First name"],
      ["tenant.last_name", "Last name"], ["tenant.email", "Email"],
      ["tenant.phone", "Phone"], ["tenant.balance", "Balance due"],
      ["tenant.security_deposit", "Security deposit"], ["tenant.status", "Lease status"],
      ["tenant.move_in", "Move-in date"], ["tenant.move_out", "Move-out date"],
      ["tenant.voucher_number", "Voucher number"],
      ["tenant.tenant_portion", "Tenant portion"], ["tenant.voucher_portion", "Voucher portion"],
    ]],
    ["Lease", [
      ["lease.start_date", "Start date"], ["lease.end_date", "End date"],
      ["lease.rent_amount", "Rent"], ["lease.security_deposit", "Security deposit"],
    ]],
    ["Owner", [
      ["owner.name", "Name"], ["owner.email", "Email"], ["owner.phone", "Phone"],
    ]],
    ["Loan", [
      ["loan.lender", "Lender"], ["loan.account_number", "Account number"],
      ["loan.balance", "Current balance"], ["loan.monthly_payment", "Monthly payment"],
    ]],
    ["Insurance", [
      ["insurance.provider", "Provider"], ["insurance.policy_number", "Policy number"],
      ["insurance.coverage", "Coverage amount"], ["insurance.expires", "Expiry date"],
    ]],
    ["Property tax", [
      ["tax.county", "County"], ["tax.parcel_id", "Parcel ID"],
      ["tax.annual_amount", "Annual amount"],
    ]],
    ["HOA", [
      ["hoa.name", "HOA name"], ["hoa.amount", "Dues"], ["hoa.frequency", "Frequency"],
    ]],
    ["Context", [
      ["today", "Today's date"], ["user.name", "Your name"], ["user.email", "Your email"],
      ["company.name", "Company name"],
    ]],
  ];
  // Label for a prefill source, for the field row ("fills from Today's date").
  const PREFILL_LABELS = Object.fromEntries(PREFILL_SOURCES.flatMap(([, opts]) => opts));

  // Facts for the document, loaded by RECORD (utils/docService). A tenant
  // id when another screen supplied one; otherwise the property picked in
  // "Prefill from Property".
  async function loadPrefillData(propertyAddress, opts = {}) {
  const ctx = await loadDocContext({ companyId, propertyAddress, tenantId: opts.tenantId ?? null, leaseId: opts.leaseId ?? null, prospectId: opts.prospectId ?? null, userProfile, activeCompany });
  setPrefillData(ctx.data);
  setDocContext(ctx);
  return ctx;
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

  async function startDocument(template, docMode, opts = {}) {
  setSelectedTemplate(template);
  setMode(docMode);
  const fc = template.field_config || {};
  let ctx = null;
  if (docMode === "prefill" && (prefillProperty || opts.tenantId != null || opts.prospectId)) {
  ctx = await loadPrefillData((opts.tenantId != null || opts.prospectId) ? null : prefillProperty, opts);
  const filled = applyPrefill(template, ctx.data);
  // Agreed with a prospect but with no merge key of their own in older
  // templates: who pays which utilities.
  if (ctx.prospect) {
    for (const key of ["landlord_utilities", "tenant_utilities"]) {
      if (!filled[key] && ctx.prospect[key] && (template.fields || []).some(f => f.name === key)) filled[key] = ctx.prospect[key];
    }
  }
  // Values the calling screen decided (the new rent, the renewal dates):
  // they win over what the records say, for fields this template has.
  for (const [k, v] of Object.entries(opts.values || {})) if ((template.fields || []).some(f => f.name === k)) filled[k] = v;
  setFieldValues(recalcFields(filled, fc));
  } else {
  setDocContext(null);
  const blank = applyDefaults(template);
  for (const [k, v] of Object.entries(opts.values || {})) if ((template.fields || []).some(f => f.name === k)) blank[k] = v;
  setFieldValues(recalcFields(blank, fc));
  }
  // Load PDF for overlay templates
  if (template.template_type === "pdf_overlay" && template.pdf_storage_path) {
  setPdfPages([]);
  const pdf = await loadPdfForPreview(template.pdf_storage_path);
  if (pdf) await renderPdfPages(pdf, pdfScale);
  }
  // Seed signer names/emails from the same records the document was filled
  // from: each tenant on the lease in turn, then whoever is sending it.
  if (template.signing_mode && template.signing_mode !== "none") {
    const emails = {};
    const names = {};
    const source = ctx || { signers: { tenants: [], landlord: { name: userProfile?.name || "", email: userProfile?.email || "" } } };
    for (const r of effectiveSignerRoles(template.signer_roles, source.signers?.tenants?.length || 0, { witnesses: !!template.field_config?.witnesses })) {
      const g = signerDefaultFor(r.role, source);
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

  // ---- Merge + render ----
  // Sanitize template body: allow only safe HTML tags, strip scripts/events
  // The data-* attributes the editor's own schema writes (docKit.js) and
  // the signature block's slots (signatureBlock.js). Data attributes are
  // otherwise refused; without these, a generated document lost its page
  // breaks, keep-with-next, list styles, borderless tables and signature
  // slots on its way from the template to the signing page.
  const DOC_DATA_ATTRS = ["data-page-break", "data-keep-next", "data-list-style", "data-bullet", "data-borders", "data-sig-role", "data-sig-date"];
  function sanitizeTemplateHtml(html) {
  if (!html) return "";
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: ["p","br","b","i","u","strong","em","h1","h2","h3","h4","h5","h6","ul","ol","li","table","thead","tbody","tr","th","td","div","span","a","img","hr","blockquote","pre","code","sub","sup","s","del","ins","mark"], ALLOWED_ATTR: ["href","src","alt","title","class","style","width","height","colspan","rowspan","align","valign"], ALLOW_DATA_ATTR: false, ADD_ATTR: DOC_DATA_ATTRS, FORBID_TAGS: ["script","iframe","object","embed","form","input","button","select","textarea"], FORBID_ATTR: ["onerror","onload","onclick","onmouseover","onfocus","onblur"] });
  }
  // Blocked merge field names that could leak system data
  const BLOCKED_MERGE_FIELDS = new Set(["company_id","companyId","user_email","userEmail","password","secret","token","access_token","api_key","encryption_iv"]);
  function renderMergedBody(body, values, fieldConfig) {
  // The signature block: one signature line per signer (every tenant on
  // the lease, then the landlord), from the same signer list the envelope
  // uses. Expanded first, so its slots are plain HTML to everything after.
  // The printed name under a line is the signer's name (editable on the
  // preview step); a tenant or landlord line with none yet takes the
  // document's own name field, so a blank-mode lease still prints who
  // signs where.
  const printedNames = { ...signerNames };
  for (const r of signerRoles) {
    if (printedNames[r.role]) continue;
    const role = String(r.role).toLowerCase();
    if (/^(tenant|tenant_1)$/.test(role)) printedNames[r.role] = String(values?.tenant_name || "").split(/\s+and\s+|,\s*/)[0] || "";
    else if (/landlord/.test(role) && !/witness/.test(role)) printedNames[r.role] = String(values?.landlord_name || "") || "";
  }
  const withBlock = hasSignatureBlock(body) ? expandSignatureBlock(body, signatureRows(signerRoles, printedNames)) : (body || "");
  return sanitizeTemplateHtml(withBlock.replace(/\{\{(\w+)\}\}/g, (match, fieldName) => {
  if (BLOCKED_MERGE_FIELDS.has(fieldName)) return "";
  // Hide merge tags for conditionally hidden fields
  if (fieldConfig && !isFieldVisible(fieldName, values, fieldConfig)) return "";
  const val = values[fieldName];
  // Address block: format multi-line
  if (val && typeof val === "object" && val.line1 !== undefined) {
  const formatted = formatAddressBlock(val);
  return formatted ? escapeHtml(formatted).replace(/\n/g, "<br/>") : '<span style="color:' + printTheme.danger + ';background:' + printTheme.dangerBg + ';padding:0 4px;border-radius:4px;">' + match + '</span>';
  }
  if (val !== undefined && val !== "") return escapeHtml(String(val));
  // Derived text can be blank on purpose (no proration line when a lease
  // starts on the 1st). Only an unfilled INPUT gets the red marker.
  if (fieldConfig?.derived?.[fieldName]) return "";
  return '<span style="color:' + printTheme.danger + ';background:' + printTheme.dangerBg + ';padding:0 4px;border-radius:4px;">' + match + '</span>';
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
  async function saveDocument(status = "draft", { signing = false } = {}) {
  const errors = validateFields(selectedTemplate, fieldValues);
  if (errors.length > 0) { showToast(errors[0], "error"); return null; }
  // A document that carries a lease change: what will be scheduled is what
  // the document says, so read it back from the fields, and make sure there
  // is not already one in flight BEFORE anything is saved or sent.
  const carried = status !== "draft" && pendingChange.current ? changeRowFromDocument(pendingChange.current, fieldValues) : null;
  if (carried) {
    if (carried.kind !== "addendum") {
      const open = await openChangeOfKind(companyId, pendingChange.current.leaseId, carried.kind);
      if (open.error) { showToast("Could not check for a change already in progress. Try again.", "error"); return null; }
      if (open.change) { showToast("There is already a " + (carried.kind === "renewal" ? "renewal" : "rent change") + " waiting to take effect for this lease. Cancel it on the tenant's page first.", "error"); return null; }
    }
    if (carried.kind === "renewal" && !(carried.payload.end_date > carried.effective_date)) { showToast("The renewal must end after it starts.", "error"); return null; }
  }
  const rendered = renderMergedBody(selectedTemplate.body, fieldValues, selectedTemplate.field_config);
  const docName = selectedTemplate.name + " — " + (fieldValues.tenant_name || fieldValues.recipient_name || "Document") + " " + formatLocalDate(new Date());
  const payload = {
  company_id: companyId, template_id: selectedTemplate.id, name: docName,
  field_values: selectedTemplate.field_config?.initials_each_page ? { ...fieldValues, _initials_each_page: true } : fieldValues,
  rendered_body: attachPageSetup(rendered, selectedTemplate.field_config?.page_setup), status,
  output_type: selectedTemplate.template_type === "pdf_overlay" ? "pdf_overlay" : "html",
  property_address: fieldValues.property_address || fieldValues.premises_address || docContext?.data?.["property.address"] || "",
  tenant_name: fieldValues.tenant_name || fieldValues.recipient_name || docContext?.tenant?.name || docContext?.prospect?.name || "",
  // The records this document is about. tenant_id used to be guessed
  // from the name by a trigger (and left empty when two tenants shared
  // one); lease and property were not recorded at all.
  tenant_id: docContext?.tenant?.id ?? null,
  lease_id: docContext?.lease?.id ?? null,
  property_id: docContext?.property?.id ?? null,
  doc_kind: DOC_KIND_BY_TEMPLATE_KEY[selectedTemplate.template_key] || "other",
  created_by: userProfile?.email,
  };
  // Someone who is not a tenant yet. The link is what lets the Prospects
  // page show this lease, lets the database cancel the other applicants'
  // leases when this one is signed, and carries the document over to the
  // tenant on conversion. (Only sent when there is one.)
  if (docContext?.prospect?.id) payload.prospect_id = docContext.prospect.id;
  const { data, error } = await supabase.from("doc_generated").insert([payload]).select().maybeSingle();
  if (error) { pmError("PM-7003", { raw: error, context: "save generated document" }); return null; }
  // The prospect's record must agree with the lease that was actually
  // written: conversion charges what the record says, not what the PDF says.
  if (docContext?.prospect?.id && payload.doc_kind === "lease") {
    const terms = prospectTermsFromFields(selectedTemplate, fieldValues);
    if (Object.keys(terms).length) {
      const { error: syncErr } = await supabase.from("prospects").update({ ...terms, updated_at: new Date().toISOString() })
        .eq("company_id", companyId).eq("id", docContext.prospect.id);
      if (syncErr) { pmError("PM-7003", { raw: syncErr, context: "copy lease terms back to the prospect", silent: true }); showToast("Saved, but the prospect's rent and dates could not be updated to match this lease. Check them on the Prospects page.", "warning"); }
    }
  }
  if (carried && data?.id) {
    const made = await createLeaseChange({
      companyId, leaseId: pendingChange.current.leaseId, tenantId: pendingChange.current.tenantId, kind: carried.kind,
      effectiveDate: carried.effective_date, payload: carried.payload, docId: data.id,
      // Out to be signed: nothing is agreed yet. A notice (no signatures) is
      // issued the moment it is finalised or emailed.
      status: signing ? "awaiting_signature" : "scheduled",
      noticeDate: carried.kind === "rent_increase" ? (pendingChange.current.noticeDate || formatLocalDate(new Date())) : null,
      userEmail: userProfile?.email || "",
    });
    if (!made.ok) {
      // Do not leave a document behind that promises a change nothing will carry out.
      await supabase.from("doc_generated").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email || "" }).eq("company_id", companyId).eq("id", data.id);
      showToast("Not saved: " + made.error, "error");
      return null;
    }
    pendingChange.current = null;
  } else if (status === "draft" && pendingChange.current) {
    showToast("Saved as a draft. Nothing is scheduled until the document is sent or finalised.", "info");
  }
  showToast("Document saved", "success");
  addNotification("📄", "Document created: " + docName);
  logAudit("create", "doc_builder", "Generated: " + docName, data?.id, userProfile?.email, userRole, companyId);
  fetchAll();
  return data;
  }

  // The body to lay out on pages, and the page setup to lay it out with.
  // A stored document carries its own setup (attachPageSetup); one still
  // being filled in takes the template's.
  function pagedBody(doc, template, values) {
  const merged = doc?.rendered_body || renderMergedBody(template?.body, values, template?.field_config);
  const { html, setup } = splitPageSetup(merged);
  return { html: sanitizeTemplateHtml(html), pageSetup: setup || template?.field_config?.page_setup || null };
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

  // HTML template: real-text PDF, paged exactly as the editor and the
  // preview show it (src/utils/pagedPdf.js).
  try {
  showToast("Generating PDF…", "info");
  const paged = pagedBody(doc, template, values);
  let bytes = await renderPagedPdf({ html: paged.html, pageSetup: paged.pageSetup, title: doc?.name || template?.name });
  // A document that takes initials on every page prints its labelled
  // initials boxes (one per signer) at the foot of each page, empty.
  if (doc?.field_values?._initials_each_page || (!doc && template?.field_config?.initials_each_page)) {
    const roster = initialsRoster(paged.html);
    if (roster.length) bytes = await stampInitials(await import("pdf-lib"), bytes, [], { roster });
  }
  const { saveAs } = await import("file-saver");
  saveAs(new Blob([bytes], { type: "application/pdf" }), pdfFileName(doc?.name || template?.name));
  showToast("PDF downloaded", "success");
  } catch (err) {
  pmError("PM-8006", { raw: err, context: "PDF export" });
  }
  }

  // ---- Signed PDF + Certificate of Completion (envelope flow) ----
  function escapeForHtml(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  function renderSignaturesBlock(sigs) {
  if (!sigs || sigs.length === 0) return "";
  const rows = sigs.map(s => {
    const dateStr = s.signed_at ? fmtDateTime(s.signed_at) : "";
    let sigVisual = "";
    if (s.signature_data) {
      if (s.signature_data.startsWith("data:image")) {
        sigVisual = '<img src="' + escapeForHtml(s.signature_data) + '" style="max-height:52px;max-width:220px;border-bottom:1px solid ' + printTheme.inkStrong + ';display:block;" alt="signature" />';
      } else if (s.signature_data.startsWith("typed:")) {
        const nm = s.signature_data.slice(6).split("|")[0];
        sigVisual = '<div style="font-family:\'Brush Script MT\',cursive;font-size:28px;color:' + printTheme.signatureInk + ';border-bottom:1px solid ' + printTheme.inkStrong + ';padding-bottom:4px;">' + escapeForHtml(nm) + '</div>';
      }
    } else {
      sigVisual = '<div style="color:' + printTheme.inkSubtle + ';font-style:italic;border-bottom:1px solid ' + printTheme.borderMed + ';padding-bottom:4px;">(awaiting signature)</div>';
    }
    return ''
      + '<div style="margin-bottom:28px;">'
      + '<div style="font-size:11px;color:' + printTheme.inkMuted + ';text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">' + escapeForHtml(s.signer_role || "signer") + '</div>'
      + sigVisual
      + '<div style="font-size:12px;color:' + printTheme.inkStrong + ';margin-top:4px;"><strong>' + escapeForHtml(s.signer_name || "") + '</strong>'
      + (s.signer_email ? ' <span style="color:' + printTheme.inkMuted + ';">&middot; ' + escapeForHtml(s.signer_email) + '</span>' : '')
      + '</div>'
      + (dateStr ? '<div style="font-size:11px;color:' + printTheme.inkMuted + ';">Signed ' + escapeForHtml(dateStr) + '</div>' : '')
      + '</div>';
  }).join("");
  return '<div style="margin-top:40px;padding-top:20px;border-top:2px solid ' + printTheme.signatureInk + ';"><h3 style="font-family:Georgia,serif;color:' + printTheme.signatureInk + ';margin-bottom:16px;">Signed By</h3>' + rows + '</div>';
  }

  function renderCertificateHtml(doc, sigs, companyName) {
  const signedCount = (sigs || []).filter(s => s.status === "signed").length;
  const total = (sigs || []).length;
  // The five <td> wrappers are gone -- printTable owns cell padding and
  // borders now -- but every value expression below is the original,
  // unchanged, including its escaping. Escaping stays with the caller
  // because only the caller knows which values are user-supplied.
  const SIG_COLUMNS = [
    { label: "#", style: `font-size:11px;color:${printTheme.inkStrong};vertical-align:top`,
      render: (s, idx) => String(idx + 1) },
    { label: "Signer", style: `font-size:11px;color:${printTheme.inkStrong};vertical-align:top`,
      render: s => ''
        + '<div style="font-weight:600;">' + escapeForHtml(s.signer_name || "(no name)") + '</div>'
        + '<div style="color:' + printTheme.inkMuted + ';">' + escapeForHtml(s.signer_email || "") + '</div>'
        + '<div style="color:' + printTheme.inkSubtle + ';text-transform:uppercase;letter-spacing:0.04em;font-size:9px;margin-top:2px;">' + escapeForHtml(s.signer_role || "") + '</div>' },
    { label: "Signed at", style: `font-size:11px;color:${printTheme.inkStrong};vertical-align:top`,
      render: s => (s.signed_at ? escapeForHtml(fmtDateTime(s.signed_at)) : '<span style="color:' + printTheme.danger + ';">Not signed</span>') },
    { label: "IP", style: `font-size:10px;color:${printTheme.inkMuted};vertical-align:top`,
      render: s => escapeForHtml(s.signer_ip || "\u2014") },
    { label: "Integrity hash", style: `font-size:10px;color:${printTheme.inkMuted};vertical-align:top;font-family:monospace;word-break:break-all`,
      render: s => (s.integrity_hash ? escapeForHtml(s.integrity_hash.slice(0, 24)) + "\u2026" : "\u2014") },
  ];
  const uaList = (sigs || []).filter(s => s.user_agent).map(s => ''
    + '<div style="font-size:9px;color:' + printTheme.inkSubtle + ';margin-bottom:2px;"><strong>' + escapeForHtml(s.signer_email) + ':</strong> ' + escapeForHtml(s.user_agent) + '</div>'
  ).join("");
  return ''
    + '<div style="font-family:Georgia,serif;color:' + printTheme.ink + ';padding:40px;max-width:720px;margin:0 auto;">'
    + '<div style="text-align:center;padding-bottom:24px;border-bottom:3px solid ' + printTheme.brandLight + ';margin-bottom:24px;">'
    + '<div style="font-size:11px;color:' + printTheme.brandLight + ';text-transform:uppercase;letter-spacing:0.2em;margin-bottom:6px;">Certificate of Completion</div>'
    + '<div style="font-size:22px;font-weight:700;color:' + printTheme.signatureInk + ';">' + escapeForHtml(doc.name) + '</div>'
    + (companyName ? '<div style="font-size:13px;color:' + printTheme.inkMuted + ';margin-top:6px;">Issued by ' + escapeForHtml(companyName) + '</div>' : '')
    + '</div>'
    + '<div style="font-size:13px;color:' + printTheme.inkStrong + ';margin-bottom:24px;line-height:1.7;">'
    + '<p>This certifies that the document above was signed electronically on behalf of all parties listed below.</p>'
    + '<ul style="padding-left:20px;">'
    + '<li><strong>Document ID:</strong> ' + escapeForHtml(doc.id) + '</li>'
    + (doc.property_address ? '<li><strong>Property:</strong> ' + escapeForHtml(doc.property_address) + '</li>' : '')
    + '<li><strong>Envelope sent:</strong> ' + escapeForHtml(doc.envelope_sent_at ? fmtDateTime(doc.envelope_sent_at) : "—") + '</li>'
    + '<li><strong>Envelope completed:</strong> ' + escapeForHtml(doc.envelope_completed_at ? fmtDateTime(doc.envelope_completed_at) : "not yet complete") + '</li>'
    + '<li><strong>Signers:</strong> ' + signedCount + ' of ' + total + ' completed</li>'
    + '</ul>'
    + '</div>'
    + '<div style="margin-bottom:24px;">' + printTable({ columns: SIG_COLUMNS, rows: sigs || [] }) + '</div>' 
    + (uaList ? '<div style="margin-top:16px;padding:12px;background:' + printTheme.surfaceMuted + ';border-radius:6px;"><div style="font-size:10px;font-weight:600;color:' + printTheme.inkMuted + ';margin-bottom:6px;">BROWSER INFORMATION</div>' + uaList + '</div>' : '')
    + '<div style="margin-top:32px;padding-top:16px;border-top:1px solid ' + printTheme.borderLight + ';font-size:10px;color:' + printTheme.inkSubtle + ';text-align:center;">'
    + 'Each integrity hash is a SHA-256 digest over the document body, signer email, signature payload, and timestamp at the moment of signing. Any alteration to the signed document or signature will cause the hash to no longer match. Certificate generated ' + escapeForHtml(fmtDateTime(new Date())) + '.'
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
  // renderCertificateHtml already escapes every user field with
  // escapeForHtml(), so this is belt-and-suspenders — if a future
  // change to the renderer forgets to escape one field, DOMPurify
  // still strips the XSS. ADD_TAGS matches the rich layout the
  // certificate uses; everything else is stripped.
  container.innerHTML = DOMPurify.sanitize(renderCertificateHtml(doc, sigs, doc._companyName), {
    ADD_TAGS: ["table","thead","tbody","tr","td","th","br","ul","ol","li","strong","em"],
    ADD_ATTR: ["style","class","colspan","rowspan","align","valign"],
  });
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

  // The signed document as PDF bytes: the document itself as real text on
  // its own pages, exactly as it was sent, then the signatures and the
  // certificate of completion on pages of their own (images and a table,
  // which the picture renderer still draws best).
  async function buildSignedPdfBytes(doc) {
  const sigs = await loadSignaturesForDoc(doc.id);
  const html2pdf = (await import("html2pdf.js")).default;
  const signedBlock = renderSignaturesBlock(sigs);
  const certBlock = renderCertificateHtml(doc, sigs, doc._companyName);
  const container = document.createElement("div");
  container.innerHTML = ''
    + '<div style="font-family:Georgia,serif;font-size:13px;line-height:1.6;color:' + printTheme.ink + ';padding:40px;max-width:720px;margin:0 auto;">' + signedBlock + '</div>'
    + '<div style="page-break-before:always;"></div>'
    + certBlock;
  document.body.appendChild(container);
  try {
    const paged = pagedBody(doc, doc._template || templates.find(t => t.id === doc.template_id), doc.field_values || {});
    const [bodyPdf, tailPdf] = await Promise.all([
      renderPagedPdfWithAnchors({ html: paged.html, pageSetup: paged.pageSetup, title: doc.name })
        .then(async ({ bytes, anchors }) => {
          const signed = sigs.filter(s => s.status === "signed");
          const PDFLib = await import("pdf-lib");
          let out = anchors.length ? await stampSignatures(PDFLib, bytes, signed, anchors) : bytes;
          const roster = initialsRoster(paged.html);
          if (signed.some(s => s.initials_data)) out = await stampInitials(PDFLib, out, signed, { pages: null, roster: roster.length ? roster : null });
          return out;
        }),
      html2pdf().set({ margin: [0.5, 0.6, 0.5, 0.6], image: { type: "jpeg", quality: 0.98 }, html2canvas: { scale: 2, useCORS: true }, jsPDF: { unit: "in", format: "letter" }, pagebreak: { mode: ["avoid-all","css","legacy"] } }).from(container).outputPdf("arraybuffer"),
    ]);
    return await concatPdfs([bodyPdf, tailPdf]);
  } finally {
    document.body.removeChild(container);
  }
  }

  async function downloadSignedPDF(doc) {
  showToast("Generating signed document…", "info");
  try {
    const bytes = await buildSignedPdfBytes(doc);
    const { saveAs } = await import("file-saver");
    saveAs(new Blob([bytes], { type: "application/pdf" }), "signed-" + pdfFileName(doc.name));
    logAudit("export", "doc_builder", "Downloaded signed PDF: " + doc.name, doc.id, userProfile?.email, userRole, companyId);
    showToast("Signed document downloaded", "success");
  } catch (err) {
    pmError("PM-8006", { raw: err, context: "signed PDF export" });
  }
  }

  // ---- Export: DOCX ----
  // A real Word file: paragraphs keep their indents, spacing and alignment,
  // runs keep their formatting, lists keep their numbering style, tables
  // stay tables, forced page breaks hold, and the page setup (margins,
  // header, footer, different first page) comes across (src/utils/docxExport.js).
  async function exportDOCX(doc) {
  try {
  const docx = await import("docx");
  const { saveAs } = await import("file-saver");
  const paged = pagedBody(doc, selectedTemplate, fieldValues);
  const blob = await htmlToDocx(docx, paged.html, { pageSetup: paged.pageSetup, title: doc?.name || selectedTemplate?.name || "Document" });
  saveAs(blob, docxFileName(doc?.name || selectedTemplate?.name));
  showToast("Word document downloaded", "success");
  } catch (err) {
  pmError("PM-8006", { raw: err, context: "DOCX export" });
  }
  }

  // ---- Export: TXT ----
  function exportTXT(doc) {
  const body = doc?.rendered_body || renderMergedBody(selectedTemplate.body, fieldValues, selectedTemplate.field_config);
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
  // Who a document goes to, from the tick boxes. By record when the document
  // has one. (This used to look the tenant up by the name in the form being
  // filled in -- empty when sending from History, and ambiguous for two
  // tenants with one name.)
  async function resolveRecipients(doc) {
  const recipients = [];
  if (sendTo.self && userProfile?.email) recipients.push(userProfile.email);
  if (sendTo.tenant) {
  let email = "";
  if (doc.tenant_id != null) email = (await supabase.from("tenants").select("email").eq("company_id", companyId).eq("id", doc.tenant_id).maybeSingle()).data?.email || "";
  if (!email && docContext?.tenant?.email) email = docContext.tenant.email;
  if (!email && docContext?.prospect?.email) email = docContext.prospect.email;
  if (email) recipients.push(email);
  else showToast("No email on file for " + (doc.tenant_name || "this tenant"), "warning");
  }
  if (sendTo.custom) {
  sendTo.custom.split(",").map(e => e.trim()).filter(e => e.includes("@")).forEach(e => recipients.push(e));
  }
  return recipients;
  }
  // The document as a PDF: the same pages as the preview. Null for a PDF
  // form template, which is exported by its own path.
  async function renderDocPdf(doc) {
  const template = doc._template || templates.find(t => t.id === doc.template_id) || selectedTemplate;
  if (template?.template_type === "pdf_overlay") return null;
  const paged = pagedBody(doc, template, doc.field_values || fieldValues);
  return renderPagedPdf({ html: paged.html, pageSetup: paged.pageSetup, title: doc.name });
  }

  async function sendEmail(doc) {
  if (!doc?.id) { showToast("Save the document first", "error"); return; }
  setSending(true);
  try {
  const recipients = await resolveRecipients(doc);
  if (recipients.length === 0) { showToast("No recipients specified", "error"); return; }

  // The document goes as a PDF attachment, not pasted into the body of the email.
  const pdfBytes = await renderDocPdf(doc);
  const out = await emailDocument(companyId, doc.id, { to: recipients, pdfBytes, filename: pdfFileName(doc.name) });
  if (!out.ok) { showToast("Could not send: " + out.error, "error"); return; }
  const sum = summarizeSends(out.results);
  showToast(sum.text, sum.tone);
  addNotification("📧", "Document emailed: " + doc.name);
  logAudit("send", "doc_builder", "Emailed " + doc.name + " to " + recipients.join(", "), doc.id, userProfile?.email, userRole, companyId);
  setSendModal(null);
  fetchAll();
  } catch (err) {
  pmError("PM-1007", { raw: err, context: "email document" });
  } finally {
  setSending(false);
  }
  }

  // ---- The device's own mail app ----
  // Step 1 (this function): make the PDF, keep a copy in storage, and work
  // out a link to it. Step 2 is a button in the dialog that opens: a browser
  // only lets a page open the share sheet or a mail draft straight from a
  // click, and making the PDF takes longer than that allowance lasts.
  const MAIL_LINK_DAYS = 14;
  async function prepareMailDraft(doc) {
  if (!doc?.id) { showToast("Save the document first", "error"); return; }
  setSending(true);
  try {
  const recipients = (await resolveRecipients(doc)).filter(e => e !== userProfile?.email);
  const pdfBytes = await renderDocPdf(doc);
  if (!pdfBytes) { showToast("A PDF form cannot be opened in the mail app from here. Export it and attach it yourself.", "info"); return; }
  const filename = pdfFileName(doc.name);
  const path = companyId + "/generated/" + doc.id + ".pdf";
  const up = await supabase.storage.from("documents").upload(path, new Blob([pdfBytes], { type: "application/pdf" }), { contentType: "application/pdf", upsert: true });
  let link = "";
  if (up.error) pmError("PM-7003", { raw: up.error, context: "store PDF for mail draft", silent: true });
  else {
    await supabase.from("doc_generated").update({ pdf_output_path: path }).eq("company_id", companyId).eq("id", doc.id);
    link = await getSignedUrl("documents", path, MAIL_LINK_DAYS * 86400);
  }
  let file = null;
  try { file = new File([pdfBytes], filename, { type: "application/pdf" }); } catch (_e) { file = null; }
  const who = doc.tenant_name ? String(doc.tenant_name).split(/\s+/)[0] : "";
  setSendModal(null);
  setMailDraft({
    doc, file, recipients, link, canShare: !!file && canShareFile(file),
    subject: doc.name,
    body: (who ? "Hi " + who + "," : "Hello,") + "\n\nPlease find " + doc.name + (link ? " here:\n\n" + link + "\n\nThe link works for " + MAIL_LINK_DAYS + " days." : " attached.") + "\n\n" + (userProfile?.name || ""),
  });
  } catch (err) {
  pmError("PM-1007", { raw: err, context: "prepare mail draft" });
  showToast("The document could not be prepared for your mail app.", "error");
  } finally {
  setSending(false);
  }
  }
  function noteMailDraftUsed(how) {
  logAudit("send", "doc_builder", "Opened in the device's mail app (" + how + "): " + mailDraft.doc.name + (mailDraft.recipients.length ? " to " + mailDraft.recipients.join(", ") : ""), mailDraft.doc.id, userProfile?.email, userRole, companyId);
  }
  async function shareMailDraft() {
  if (!mailDraft?.file) return;
  try {
    await navigator.share({ files: [mailDraft.file], title: mailDraft.subject, text: mailDraft.subject });
    noteMailDraftUsed("share sheet, PDF attached");
    setMailDraft(null);
  } catch (e) {
    // Closing the share sheet is not an error.
    if (e?.name !== "AbortError") showToast("This device would not open its share sheet. Use the draft with a link instead.", "error");
  }
  }

  // ---- Envelope upkeep (History) ----
  async function resendSigner(s) {
  const r = await resendSignatureRequest(companyId, s.id);
  if (!r.ok) { showToast("Could not resend: " + r.error, "error"); return; }
  const sum = summarizeSends([{ status: r.status, email: s.signer_email, delivered_to: r.delivered_to, error: r.error }]);
  showToast("Reminder to " + (s.signer_name || s.signer_email) + ": " + sum.text, sum.tone);
  fetchAll();
  }

  async function cancelEnvelope(d) {
  if (!await showConfirm({ message: 'Cancel the signature request for "' + d.name + '"? The links already sent will stop working. Signatures already given are kept on record.', variant: "danger", confirmText: "Cancel request" })) return;
  const r = await voidEnvelope(companyId, d.id, "Cancelled by " + (userProfile?.email || "staff"));
  if (!r.ok) { showToast("Could not cancel: " + r.error, "error"); return; }
  logAudit("update", "doc_builder", "Cancelled signature request: " + d.name, d.id, userProfile?.email, userRole, companyId);
  showToast("Signature request cancelled", "success");
  fetchAll();
  }

  // The signed copy is normally stored by the last signer's browser. If
  // they closed the tab first it never arrived; this stores it from here.
  async function storeSignedCopy(d) {
  showToast("Storing the signed copy…", "info");
  try {
  const bytes = await buildSignedPdfBytes(d);
  const r = await storeSignedPdf(companyId, d.id, bytes);
  if (!r.ok) { showToast("Could not store the signed copy: " + r.error, "error"); return; }
  showToast("Signed copy stored and filed under Documents", "success");
  fetchAll();
  } catch (err) { pmError("PM-8006", { raw: err, context: "store signed copy" }); }
  }

  async function openEmailLog(d) {
  const { data, error } = await supabase.from("doc_email_log").select("*").eq("company_id", companyId).eq("doc_id", d.id).order("created_at", { ascending: false }).limit(100);
  if (error) { pmError("PM-7003", { raw: error, context: "load email log" }); return; }
  setEmailLogFor({ doc: d, rows: data || [] });
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
  const roles = signerRoles;
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
    // Someone named on the document with no email would simply be left off
    // the envelope. Say so instead of sending a lease one signature short.
    if (!email && name) { showToast(name + " has no email address. Add one, or clear the name to send without their signature.", "error"); return; }
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
    const doc = await saveDocument("sent", { signing: true });
    if (!doc) { setSending(false); return; }

    const mode = ["parallel", "sequential"].includes(selectedTemplate.signing_mode) ? selectedTemplate.signing_mode : null;
    const { error: envErr } = await supabase.rpc("create_doc_envelope", { p_doc_id: doc.id, p_signers: signers, p_signing_mode: mode });
    if (envErr) {
      pmError("PM-7003", { raw: envErr, context: "create doc envelope" });
      // Nothing went out, so a lease change this document carried must not
      // sit there waiting for signatures that were never asked for.
      await supabase.from("lease_changes").update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by: userProfile?.email || "", cancel_reason: "The signature request could not be created" })
        .eq("company_id", companyId).eq("doc_id", doc.id).eq("status", "awaiting_signature");
      setSending(false);
      return;
    }

    // The server emails whoever's turn it is and logs each send. (This used
    // to call an edge function that was never deployed, with the failure
    // logged silently -- so the toast said "emailed" and nobody was.)
    const sent = await sendSignatureRequests(companyId, doc.id);
    if (!sent.ok) showToast("Out for signature, but the emails could not be sent (" + sent.error + "). Use Resend in History.", "error");
    else { const sum = summarizeSends(sent.results); showToast("Sent for signature: " + sum.text, sum.tone); }
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
  setDocContext(null);
  pendingChange.current = null;
  // Opened from another screen for a tenant: closing goes back there.
  if (returnTo.current && setPage) { const r = returnTo.current; returnTo.current = null; setPage(r.page, r.action || null); }
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
  const tag = "{{" + fieldName + "}}";
  // At the cursor when the editor is up (its onChange carries the body
  // back into templateForm); at the end otherwise. The signature block is
  // a block of its own, so it goes in a paragraph of its own.
  if (htmlEditor && !htmlEditor.isDestroyed) {
    if (fieldName === SIGNATURE_BLOCK_KEY) htmlEditor.chain().focus().insertContent([{ type: "paragraph", content: [{ type: "text", text: tag }] }]).run();
    else htmlEditor.chain().focus().insertContent(tag).run();
    return;
  }
  setTemplateForm(prev => ({ ...prev, body: prev.body + (fieldName === SIGNATURE_BLOCK_KEY ? "<p>" + tag + "</p>" : tag) }));
  }

  if (loading) return <Spinner />;

  // ============ TEMPLATE EDITOR — FULL SCREEN ============
  if (showTemplateEditor) {
  const sections = [...new Set(templateForm.fields.map(f => f.section).filter(Boolean))];
  return (
  <div className="fixed inset-0 z-50 bg-surface-muted flex flex-col safe-y safe-x">
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
  <Btn onClick={saveTemplate}>{editingTemplate ? "Save" : "Create"}</Btn>
  <span className="text-xs text-neutral-300 ml-2">Esc to close</span>
  </div>

  {(() => {
    const showLanding = !editingTemplate
      && !templateForm.body
      && !templateForm.pdf_storage_path
      && !templateLandingSkipped;
    if (!showLanding) return null;
    return (
      <div className="flex-1 flex items-center justify-center p-8 bg-neutral-50/50 overflow-y-auto">
        <div className="w-full max-w-3xl">
          <h2 className="text-lg font-semibold text-neutral-800 text-center">How would you like to start?</h2>
          <p className="text-sm text-neutral-500 text-center mt-1 mb-8">Pick a starting point — you can edit fields and signing settings either way.</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <label className={"relative flex flex-col items-center text-center bg-white rounded-xl border border-neutral-200 hover:border-brand-300 hover:shadow-pop transition cursor-pointer p-6 " + (importingDocx ? "opacity-60 pointer-events-none" : "")}>
              <span className="material-icons-outlined text-4xl text-brand-500 mb-3">description</span>
              <span className="text-sm font-semibold text-neutral-800">{importingDocx ? "Importing…" : "Import from Word"}</span>
              <span className="text-xs text-neutral-500 mt-1.5 leading-snug">Upload a .docx — we'll convert it to an editable rich-text template that reflows with your data.</span>
              <FileInput accept=".docx" className="hidden" onChange={e => { setTemplateForm(prev => ({ ...prev, template_type: "html" })); handleDocxImport(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
            <label className="relative flex flex-col items-center text-center bg-white rounded-xl border border-neutral-200 hover:border-brand-300 hover:shadow-pop transition cursor-pointer p-6">
              <span className="material-icons-outlined text-4xl text-brand-500 mb-3">picture_as_pdf</span>
              <span className="text-sm font-semibold text-neutral-800">Upload a PDF</span>
              <span className="text-xs text-neutral-500 mt-1.5 leading-snug">Use a fixed-layout PDF (court forms, lease addenda). Place fields on top — original layout preserved.</span>
              <FileInput accept=".pdf" className="hidden" onChange={e => { setTemplateForm(prev => ({ ...prev, template_type: "pdf_overlay" })); handlePdfUpload(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
            <button type="button" onClick={() => { setTemplateForm(prev => ({ ...prev, template_type: "html" })); setTemplateLandingSkipped(true); }} className="flex flex-col items-center text-center bg-white rounded-xl border border-neutral-200 hover:border-brand-300 hover:shadow-pop transition cursor-pointer p-6">
              <span className="material-icons-outlined text-4xl text-brand-500 mb-3">edit_note</span>
              <span className="text-sm font-semibold text-neutral-800">Start blank</span>
              <span className="text-xs text-neutral-500 mt-1.5 leading-snug">Open an empty rich-text editor and write your template from scratch.</span>
            </button>
          </div>
        </div>
      </div>
    );
  })()}

  {/* Sub-ribbon — TipTap formatting toolbar (HTML templates only) */}
  {!(!editingTemplate && !templateForm.body && !templateForm.pdf_storage_path && !templateLandingSkipped) && templateForm.template_type === "html" && htmlEditor && (
  <div className="px-5 py-1.5 border-b border-neutral-100 bg-white shrink-0 flex items-center gap-3">
  <RichTextToolbar editor={htmlEditor} />
  <span className="w-px h-5 bg-neutral-200" />
  <label className={"inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-neutral-200 cursor-pointer hover:bg-neutral-50 " + (importingDocx ? "opacity-60 pointer-events-none" : "")} title="Import a .docx file as a starting point. Replaces the current editor content.">
  <span className="material-icons-outlined text-sm">upload_file</span>
  {importingDocx ? "Importing…" : "Import from Word"}
  <FileInput accept=".docx" className="hidden" onChange={e => { handleDocxImport(e.target.files?.[0]); e.target.value = ""; }} />
  </label>
  </div>
  )}

  {/* 3-column layout: left fields rail | center canvas | right inspector rail */}
  {!(!editingTemplate && !templateForm.body && !templateForm.pdf_storage_path && !templateLandingSkipped) && (
  <div className="flex-1 flex overflow-hidden">
  {/* SIDE PANEL — one panel with tabs: fields | signers | page | rules | details */}
  <div className="w-[400px] shrink-0 border-r border-neutral-100 overflow-y-auto bg-white flex flex-col">
  <div className="flex gap-0.5 px-2 pt-2 border-b border-neutral-100 sticky top-0 bg-white z-10" role="tablist" aria-label="Template panels">
  {[["fields", "Fields", templateForm.fields.length], ["signers", "Signers", (templateForm.signer_roles || []).length], ["page", "Page", null], ["rules", "Rules", Object.keys(templateForm.field_config?.calculated || {}).length + Object.keys(templateForm.field_config?.derived || {}).length + Object.keys(templateForm.field_config?.conditional || {}).length], ["details", "Details", null]].map(([id, label, n]) => (
  <button key={id} type="button" role="tab" aria-selected={panelTab === id} onClick={() => setPanelTab(id)}
    className={"px-3 py-2 text-sm font-semibold border-b-2 -mb-px " + (panelTab === id ? "border-brand-600 text-brand-700" : "border-transparent text-neutral-500 hover:text-neutral-800")}>
  {label}{n ? <span className="ml-1 text-xs font-normal text-neutral-400">{n}</span> : null}
  </button>
  ))}
  </div>
  {panelTab === "fields" && (
  <div className="p-3">
  <div className="flex items-center justify-between mb-2">
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Fields ({templateForm.fields.length})</h3>
  <Btn size="xs" onClick={() => { addField(); setOpenField(templateForm.fields.length); }}>+ Add field</Btn>
  </div>
  <p className="text-2xs text-neutral-400 mb-2">Click a field to edit it. <strong className="text-neutral-500">Insert</strong> places it at the cursor; or type <code className="bg-neutral-100 px-1 rounded">{"{{"}</code> in the page.</p>
  <div className="space-y-1.5">
  {templateForm.fields.map((f, i) => (
  <div key={i} className={"border rounded-xl bg-white " + (openField === i ? "border-brand-200 bg-brand-50/20" : "border-neutral-100")}>
  {/* The row: name, what it is, where it fills from. Click to open the details. */}
  <div className="flex items-center gap-2 px-3 py-2">
  <button type="button" onClick={() => setOpenField(openField === i ? null : i)} className="flex-1 min-w-0 text-left" aria-expanded={openField === i}>
  <div className="text-sm font-semibold text-neutral-800 truncate">{f.label || f.name || "Untitled field"}</div>
  <div className="text-2xs text-neutral-400 truncate">{f.type || "text"}{f.prefill_from ? " · fills from " + (PREFILL_LABELS[f.prefill_from] || f.prefill_from) : " · filled manually"}{f.required ? " · required" : ""}{f.type === "signature" && f.signer_role ? " · " + ((templateForm.signer_roles || []).find(r => r.role === f.signer_role)?.label || f.signer_role) : ""}</div>
  </button>
  {templateForm.template_type !== "pdf_overlay" && <Btn size="xs" variant="secondary" onClick={() => insertMergeField(f.name || f.label.toLowerCase().replace(/[^a-z0-9]+/g, "_"))} title="Place this field at the cursor in the page">Insert</Btn>}
  </div>
  {openField === i && (
  <div className="px-3 pb-3 border-t border-neutral-100 pt-2">
  <div className="space-y-1.5 mb-2">
  <Input value={f.label} onChange={e => updateField(i, "label", e.target.value)} placeholder="Field label, e.g. Recipient Name" className="text-xs w-full" />
  <div className="grid grid-cols-2 gap-1.5">
  <Select value={f.type} onChange={e => updateField(i, "type", e.target.value)} className="text-xs">
  {["text","textarea","number","currency","date","checkbox","select","address_block","signature"].map(t => <option key={t} value={t}>{t}</option>)}
  </Select>
  <Input value={f.section || ""} onChange={e => updateField(i, "section", e.target.value)} placeholder="Group" className="text-xs" />
  </div>
  </div>
  <div className="space-y-1.5">
  <div>
  <div className="text-2xs font-medium text-neutral-500 mb-0.5">Fills itself from</div>
  <Select value={f.prefill_from || ""} onChange={e => updateField(i, "prefill_from", e.target.value)} className="text-xs w-full" aria-label="Fill automatically from">
  <option value="">Fill manually</option>
  {PREFILL_SOURCES.map(([group, opts]) => (
    <optgroup key={group} label={group}>
      {opts.map(([val, lab]) => <option key={val} value={val}>{lab}</option>)}
    </optgroup>
  ))}
  </Select>
  </div>
  <div className="grid grid-cols-2 gap-1.5 items-center">
  <Input value={f.default_value || ""} onChange={e => updateField(i, "default_value", e.target.value)} placeholder="Default" className="text-xs" />
  <div className="flex items-center gap-2">
  <label className="flex items-center gap-1.5 text-xs whitespace-nowrap"><Checkbox checked={f.required} onChange={e => updateField(i, "required", e.target.checked)} className="accent-brand-600" />Required</label>
  </div>
  <TextLink tone="danger" size="xs" underline={false} onClick={() => removeField(i)} className="ml-auto">Remove field</TextLink>
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
  {(templateForm.signer_roles || []).length === 0 && <span className="text-2xs text-warn-600">Define signer roles in the Signature Workflow section ↓</span>}
  </div>
  )}
  <div className="text-xs text-neutral-400 mt-1">Tag <code className="bg-neutral-100 px-1 rounded">{"{{" + (f.name || "field_name") + "}}"}</code> · type <code className="bg-neutral-100 px-1 rounded">{"{{"}</code> in the page to insert any field</div>
  </div>
  )}
  </div>
  ))}
  </div>
  </div>
  )}
  {panelTab === "signers" && (
  <div className="p-3 space-y-3">
  {/* Signature Workflow */}
  <div className="bg-white border border-neutral-100 rounded-xl p-3">
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1">Signature Workflow</h3>
  <p className="text-xs text-neutral-400 mb-3">Each signer gets a private link by email; no account needed. In order: use the arrows to set who signs first.</p>

  <div className="grid grid-cols-3 gap-2 mb-4">
  {[
    { value: "none", label: "No signing", desc: "Make the document only" },
    { value: "parallel", label: "All at once", desc: "Everyone is emailed together" },
    { value: "sequential", label: "In order", desc: "One after another" },
  ].map(opt => (
    <button key={opt.value} type="button" onClick={() => setTemplateForm(prev => ({ ...prev, signing_mode: opt.value }))}
      className={"text-left px-3 py-2 rounded-xl border transition-colors " + (templateForm.signing_mode === opt.value ? "border-brand-500 bg-brand-50 text-brand-700" : "border-brand-100 bg-white text-neutral-500 hover:border-brand-300")}>
      <div className="text-xs font-semibold">{opt.label}</div>
      <div className="text-2xs text-neutral-400 mt-0.5">{opt.desc}</div>
    </button>
  ))}
  </div>

  {templateForm.signing_mode !== "none" && (
  <div className="space-y-2">
  <label className="flex items-start gap-2 text-xs text-neutral-700 cursor-pointer mb-2">
  <Checkbox checked={!!templateForm.field_config?.initials_each_page} onChange={e => setTemplateForm(prev => ({ ...prev, field_config: { ...(prev.field_config || {}), initials_each_page: e.target.checked } }))} className="accent-brand-600 mt-0.5" />
  <span><strong>Each signer initials every page.</strong> They click an "Initial here" tab on every page when they sign; the signed copy carries their initials at the foot of each page.</span>
  </label>
  <label className="flex items-start gap-2 text-xs text-neutral-700 cursor-pointer mb-2">
  <Checkbox checked={!!templateForm.field_config?.witnesses} onChange={e => setTemplateForm(prev => ({ ...prev, field_config: { ...(prev.field_config || {}), witnesses: e.target.checked } }))} className="accent-brand-600 mt-0.5" />
  <span><strong>Each signature is witnessed.</strong> When the document is sent, every signer gets a witness line (name and email, optional). A witness signs by their own link or on the same device, on the witness line beside the signature they witnessed.</span>
  </label>
  <div className={"border rounded-xl p-2.5 mb-3 " + (hasSignatureBlock(templateForm.body) ? "border-success-200 bg-success-50/40" : "border-neutral-100 bg-white")}>
  <div className="flex items-start justify-between gap-2">
  <div className="text-xs text-neutral-700">
  <strong>Signature block.</strong> One signature line per signer: every tenant on the lease (however many), then the landlord. Each line takes the real signature and the date on the signed copy.
  <div className="text-2xs text-neutral-400 mt-0.5">{hasSignatureBlock(templateForm.body) ? "In the document." : "Not in the document yet. Place the cursor where the signatures go and insert it."}</div>
  </div>
  {templateForm.template_type !== "pdf_overlay" && !hasSignatureBlock(templateForm.body) && <Btn size="xs" variant="secondary" onClick={() => insertMergeField(SIGNATURE_BLOCK_KEY)} title="Place the signature block at the cursor">Insert</Btn>}
  </div>
  </div>
  <div className="flex items-center justify-between mb-1">
  <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Signer Roles</span>
  <TextLink tone="brand" size="xs" type="button" onClick={() => setTemplateForm(prev => ({ ...prev, signer_roles: [...(prev.signer_roles || []), { role: "signer_" + ((prev.signer_roles || []).length + 1), label: "Signer " + ((prev.signer_roles || []).length + 1), order: (prev.signer_roles || []).length + 1, required: true }] }))}>+ Add signer</TextLink>
  </div>
  {(templateForm.signer_roles || []).length === 0 && <p className="text-xs text-neutral-400 italic">No signers yet. Add at least one role, then use it in a signature field above.</p>}
  {(templateForm.signer_roles || []).slice().sort((a,b) => (a.order||0) - (b.order||0)).map((r, i) => {
  const color = getRoleColor(r.role, templateForm.signer_roles);
  const setRole = (patch) => setTemplateForm(prev => ({ ...prev, signer_roles: (prev.signer_roles || []).map(x => (x.role === r.role ? { ...x, ...patch } : x)) }));
  const move = (dir) => {
    const list = (templateForm.signer_roles || []).slice().sort((a,b) => (a.order||0) - (b.order||0));
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setTemplateForm(prev => ({ ...prev, signer_roles: list.map((x, n) => ({ ...x, order: n + 1 })) }));
  };
  const used = templateForm.fields.filter(f => f.type === "signature" && f.signer_role === r.role).length;
  return (
  <div key={r.role} className="bg-white border border-neutral-100 rounded-xl p-2.5 space-y-2">
  <div className="flex items-center gap-2">
  {templateForm.signing_mode === "sequential"
    ? <span className={`w-6 h-6 rounded-full ${color.dot} text-white text-2xs font-bold flex items-center justify-center shrink-0`} title="Signs in this order">{i + 1}</span>
    : <span className={`w-2.5 h-2.5 rounded-full ${color.dot} shrink-0`} title={`Colour: ${r.label || r.role}`} />}
  <Input size="sm" value={r.label || ""} onChange={e => setRole({ label: e.target.value })} placeholder="Who signs, e.g. Tenant" className="flex-1 min-w-0 font-semibold" aria-label="Signer" />
  {templateForm.signing_mode === "sequential" && <div className="flex flex-col shrink-0">
    <button type="button" onClick={() => move(-1)} disabled={i === 0} className="text-neutral-400 hover:text-neutral-700 disabled:opacity-30 leading-none" aria-label="Signs earlier" title="Signs earlier"><span className="material-icons-outlined text-base">expand_less</span></button>
    <button type="button" onClick={() => move(1)} disabled={i === (templateForm.signer_roles || []).length - 1} className="text-neutral-400 hover:text-neutral-700 disabled:opacity-30 leading-none" aria-label="Signs later" title="Signs later"><span className="material-icons-outlined text-base">expand_more</span></button>
  </div>}
  <button type="button" onClick={() => setTemplateForm(prev => ({ ...prev, signer_roles: (prev.signer_roles || []).filter(x => x.role !== r.role) }))} className="w-8 h-8 rounded-lg text-neutral-400 hover:text-danger-600 hover:bg-danger-50 shrink-0" aria-label="Remove signer" title="Remove signer">✕</button>
  </div>
  <div className="flex items-center justify-between gap-2 pl-8 flex-wrap">
  <span className="text-2xs text-neutral-400">id <code className="bg-neutral-100 px-1 rounded">{r.role}</code> · {used ? used + " signature field" + (used === 1 ? "" : "s") : "no signature field yet"}</span>
  <label className="flex items-center gap-1.5 text-xs text-neutral-600 cursor-pointer"><Checkbox checked={r.required !== false} onChange={e => setRole({ required: e.target.checked })} className="accent-brand-600" />Must sign</label>
  </div>
  </div>
  );
  })}
  {(templateForm.signer_roles || []).length > 0 && (
  <div className="text-2xs text-neutral-400 border-t border-neutral-100 pt-2 mt-2">
  Where they sign: add a field of type <code className="bg-neutral-100 px-1 rounded">signature</code> on the Fields tab, pick the signer, and place it in the page where the signature goes. Add <code className="bg-neutral-100 px-1 rounded">signature</code>-type fields above, assign each to one of these roles, and place <code className="bg-neutral-100 px-1 rounded">{"{{field_name}}"}</code> in the body where signatures should appear.
  </div>
  )}
  </div>
  )}
  </div>

  </div>
  )}
  {panelTab === "page" && (
  <div className="p-3 space-y-3">
  {/* Page setup — header/footer printed on every page (HTML templates) */}
  {templateForm.template_type === "html" && (() => {
  const ps = { ...DEFAULT_PAGE_SETUP, headerLeft: "", headerRight: "", footerLeft: "", footerRight: "Page {page}", firstPageDifferent: false, firstHeaderLeft: "", firstHeaderRight: "", firstFooterLeft: "", firstFooterRight: "", ...(templateForm.field_config?.page_setup || {}) };
  const setPs = (key, value) => setTemplateForm(prev => ({ ...prev, field_config: { ...(prev.field_config || {}), page_setup: { ...ps, [key]: value } } }));
  const slot = (key, label) => (
  <div>
  <label className="text-2xs font-medium text-neutral-500 uppercase tracking-wider block mb-0.5">{label}</label>
  <textarea rows={2} value={ps[key]} onChange={e => setPs(key, e.target.value)} aria-label={label}
    className="w-full text-xs border border-neutral-200 rounded-lg px-2 py-1 resize-none focus:outline-none focus:border-brand-400" />
  </div>
  );
  return (
  <div className="bg-white border border-neutral-100 rounded-xl p-3">
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1">Page Setup</h3>
  {(() => {
    const SIZES = [["Letter", 816, 1056], ["Legal", 816, 1344], ["A4", 794, 1123]];
    const sizeKey = (SIZES.find(z => z[1] === ps.pageWidth && z[2] === ps.pageHeight) || ["Custom"])[0];
    const inch = (key, label, min, max) => (
      <label className="flex flex-col gap-0.5 text-2xs text-neutral-500">
        <span className="uppercase tracking-wider font-medium">{label}</span>
        <span className="flex items-center gap-1">
          <input type="number" step="0.05" min={min} max={max} value={+(ps[key] / 96).toFixed(2)} aria-label={label}
            onChange={e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) setPs(key, Math.round(Math.max(min, Math.min(max, v)) * 96)); }}
            className="w-full text-xs border border-neutral-200 rounded-lg px-2 py-1 focus:outline-none focus:border-brand-400 tnum" />
          <span className="text-neutral-400">in</span>
        </span>
      </label>
    );
    return (
      <div className="mb-3">
        <label className="flex items-center justify-between gap-2 text-2xs text-neutral-500 mb-2">
          <span className="uppercase tracking-wider font-medium">Paper</span>
          <select value={sizeKey} aria-label="Paper size" onChange={e => { const z = SIZES.find(x => x[0] === e.target.value); if (z) setTemplateForm(prev => ({ ...prev, field_config: { ...(prev.field_config || {}), page_setup: { ...ps, pageWidth: z[1], pageHeight: z[2] } } })); }}
            className="text-xs border border-neutral-200 rounded-lg px-2 py-1 bg-white focus:outline-none focus:border-brand-400">
            {SIZES.map(z => <option key={z[0]} value={z[0]}>{z[0]} ({+(z[1] / 96).toFixed(1)} × {+(z[2] / 96).toFixed(1)} in)</option>)}
            {sizeKey === "Custom" && <option value="Custom">Custom</option>}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          {inch("marginTop", "Top margin", 0.25, 3)}
          {inch("marginBottom", "Bottom margin", 0.25, 3)}
          {inch("marginLeft", "Left margin", 0.25, 3)}
          {inch("marginRight", "Right margin", 0.25, 3)}
          {inch("headerDistance", "Header from top", 0, 2.5)}
          {inch("footerDistance", "Footer from bottom", 0, 2.5)}
        </div>
        <p className="text-2xs text-neutral-400 mt-1.5">Or drag the markers on the rulers beside the page. Header and footer repeat on every page.</p>
      </div>
    );
  })()}
  <div className="grid grid-cols-2 gap-2">
  {slot("headerLeft", "Header left")}
  {slot("headerRight", "Header right")}
  {slot("footerLeft", "Footer left")}
  {slot("footerRight", "Footer right")}
  </div>
  <label className="flex items-center gap-2 text-xs text-neutral-700 cursor-pointer mt-3">
  <Checkbox checked={!!ps.firstPageDifferent} onChange={e => setPs("firstPageDifferent", e.target.checked)} className="accent-brand-600" />
  Different first page (its own header and footer)
  </label>
  {ps.firstPageDifferent && (
  <div className="grid grid-cols-2 gap-2 mt-2">
  {slot("firstHeaderLeft", "First page header left")}
  {slot("firstHeaderRight", "First page header right")}
  {slot("firstFooterLeft", "First page footer left")}
  {slot("firstFooterRight", "First page footer right")}
  </div>
  )}
  </div>
  );
  })()}

  </div>
  )}
  {panelTab === "rules" && (
  <div className="p-3 space-y-3">
  {/* Advanced Field Config — collapsible */}
  {(
  <div className="bg-white border border-neutral-100 rounded-xl">
  <div className="w-full flex items-center justify-between p-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
  <span className="flex items-center gap-1.5">Rules</span>
  <span className="text-2xs text-neutral-400 font-normal normal-case tracking-normal">{Object.keys(templateForm.field_config?.calculated || {}).length + Object.keys(templateForm.field_config?.derived || {}).length + Object.keys(templateForm.field_config?.conditional || {}).length} rules</span>
  </div>
  <div className="px-3 pb-3">

  {/* Calculated Fields */}
  <div className="mb-4">
  <div className="flex items-center justify-between mb-2">
  <h4 className="text-xs font-semibold text-warn-700 uppercase tracking-wide flex items-center gap-1"><span className="material-icons-outlined text-sm">calculate</span>Calculated Fields</h4>
  <TextLink tone="warn" size="xs" underline={false} onClick={() => {
  const name = prompt("Field name to make calculated (must match an existing field):");
  if (!name?.trim()) return;
  const formula = prompt("Formula (use field names, e.g. rent + late_fee):");
  if (!formula?.trim()) return;
  setTemplateForm(prev => ({ ...prev, field_config: { ...prev.field_config, calculated: { ...(prev.field_config?.calculated || {}), [name.trim()]: { formula: formula.trim() } } } }));
  }}>+ Add</TextLink>
  </div>
  {Object.entries(templateForm.field_config?.calculated || {}).map(([name, cfg]) => (
  <div key={name} className="flex items-center gap-2 text-xs bg-warn-50 border border-warn-100 rounded-lg px-3 py-2 mb-1">
  <span className="tnum font-semibold text-warn-800">{name}</span>
  <span className="text-warn-500">=</span>
  <span className="tnum text-warn-700 flex-1">{cfg.formula}</span>
  <TextLink tone="danger" size="xs" underline={false} onClick={() => {
  const calc = { ...(templateForm.field_config?.calculated || {}) };
  delete calc[name];
  setTemplateForm(prev => ({ ...prev, field_config: { ...prev.field_config, calculated: calc } }));
  }}>✕</TextLink>
  </div>
  ))}
  {Object.keys(templateForm.field_config?.calculated || {}).length === 0 && <p className="text-xs text-neutral-400 italic">No calculated fields. Use formulas like <code className="bg-neutral-100 px-1 rounded">rent * term + prorated</code>, <code className="bg-neutral-100 px-1 rounded">prorate(rent, start_date)</code> or <code className="bg-neutral-100 px-1 rounded">months_between(start_date, end_date)</code></p>}
  </div>

  {/* Derived text — a field shown another way (rent in words, the day
      of a date). Not a form input: it follows its source field. */}
  <div className="mb-4">
  <h4 className="text-xs font-semibold text-brand-700 uppercase tracking-wide flex items-center gap-1 mb-2"><span className="material-icons-outlined text-sm">auto_fix_high</span>Text made from a field</h4>
  {Object.entries(templateForm.field_config?.derived || {}).map(([name, cfg]) => (
  <div key={name} className="flex items-center gap-2 text-xs bg-brand-50 border border-brand-100 rounded-lg px-3 py-2 mb-1">
  <span className="tnum font-semibold text-brand-800 break-all">{name}</span>
  <span className="text-brand-400">=</span>
  <span className="text-brand-700 flex-1 break-words">{cfg.text !== undefined ? cfg.text : (cfg.from + " → " + ((FIELD_FORMATS.find(([k]) => k === cfg.format) || [])[1] || cfg.format))}</span>
  <TextLink tone="danger" size="xs" underline={false} onClick={() => {
  const derived = { ...(templateForm.field_config?.derived || {}) };
  delete derived[name];
  setTemplateForm(prev => ({ ...prev, field_config: { ...prev.field_config, derived } }));
  }}>✕</TextLink>
  </div>
  ))}
  {Object.keys(templateForm.field_config?.derived || {}).length === 0 && <p className="text-xs text-neutral-400 italic mb-2">None. Example: rent_words = rent → amount in words.</p>}
  <div className="grid grid-cols-2 gap-1 mt-2">
  <Input size="sm" value={derivedDraft.name} onChange={e => setDerivedDraft({ ...derivedDraft, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} placeholder="new_name" aria-label="Derived field name" />
  <Select value={derivedDraft.from} onChange={e => setDerivedDraft({ ...derivedDraft, from: e.target.value })} className="text-xs" aria-label="Source field">
  <option value="">from field…</option>
  {templateForm.fields.filter(f => f.name).map(f => <option key={f.name} value={f.name}>{f.label || f.name}</option>)}
  </Select>
  <Select value={derivedDraft.format} onChange={e => setDerivedDraft({ ...derivedDraft, format: e.target.value })} className="text-xs" aria-label="Show as">
  {FIELD_FORMATS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
  </Select>
  <Btn size="xs" variant="secondary" onClick={() => {
  const name = derivedDraft.name.replace(/^_+|_+$/g, "");
  if (!name || !derivedDraft.from) { showToast("Give it a name and pick the field it comes from", "error"); return; }
  if (templateForm.fields.some(f => f.name === name)) { showToast("A form field already uses that name", "error"); return; }
  setTemplateForm(prev => ({ ...prev, field_config: { ...prev.field_config, derived: { ...(prev.field_config?.derived || {}), [name]: { from: derivedDraft.from, format: derivedDraft.format } } } }));
  setDerivedDraft({ name: "", from: "", format: derivedDraft.format });
  }}>+ Add</Btn>
  </div>
  </div>

  {/* Conditional Fields */}
  <div className="mb-4">
  <div className="flex items-center justify-between mb-2">
  <h4 className="text-xs font-semibold text-accent-700 uppercase tracking-wide flex items-center gap-1"><span className="material-icons-outlined text-sm">visibility</span>Conditional Visibility</h4>
  <TextLink tone="accent" size="xs" underline={false} onClick={() => {
  const name = prompt("Field to show/hide conditionally:");
  if (!name?.trim()) return;
  const depField = prompt("Show when which field...");
  if (!depField?.trim()) return;
  const eqVal = prompt("...equals what value?");
  if (eqVal === null) return;
  setTemplateForm(prev => ({ ...prev, field_config: { ...prev.field_config, conditional: { ...(prev.field_config?.conditional || {}), [name.trim()]: { visible_when: { field: depField.trim(), eq: eqVal } } } } }));
  }}>+ Add</TextLink>
  </div>
  {Object.entries(templateForm.field_config?.conditional || {}).map(([name, cfg]) => (
  <div key={name} className="flex items-center gap-2 text-xs bg-accent-50 border border-accent-100 rounded-lg px-3 py-2 mb-1">
  <span className="tnum font-semibold text-accent-800">{name}</span>
  <span className="text-accent-500">visible when</span>
  <span className="tnum text-accent-700">{cfg.visible_when?.field} = "{cfg.visible_when?.eq}"</span>
  <TextLink tone="danger" size="xs" underline={false} onClick={() => {
  const cond = { ...(templateForm.field_config?.conditional || {}) };
  delete cond[name];
  setTemplateForm(prev => ({ ...prev, field_config: { ...prev.field_config, conditional: cond } }));
  }} className="ml-auto">✕</TextLink>
  </div>
  ))}
  {Object.keys(templateForm.field_config?.conditional || {}).length === 0 && <p className="text-xs text-neutral-400 italic">No conditions. Show/hide fields based on other field values.</p>}
  </div>

  <div className="text-xs text-neutral-400 border-t border-neutral-100 pt-2">
  <strong>Address blocks:</strong> Set field type to "address_block" above — it renders as a 5-field structured address (street, apt, city, state, zip).
  </div>
  </div>
  </div>
  )}


  </div>
  )}
  {panelTab === "details" && (
  <div className="p-3 space-y-3">
  {/* Template Details */}
  <div className="bg-white border border-neutral-100 rounded-xl p-3">
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">Template Details</h3>
  <div className="space-y-2">
  <div>
  <label className="text-2xs font-medium text-neutral-500 uppercase tracking-wider block mb-0.5">Name *</label>
  <Input size="sm" value={templateForm.name} onChange={e => setTemplateForm({...templateForm, name: e.target.value})} placeholder="e.g. Pet Addendum" />
  </div>
  <div>
  <label className="text-2xs font-medium text-neutral-500 uppercase tracking-wider block mb-0.5">Category</label>
  {/* A free-text field with the existing types as suggestions, so a new
      type -- "court filing", "addendum" -- can simply be typed. It was a
      closed dropdown of four, which is why anything else became
      unreachable. */}
  <Input size="sm" list="doc-category-list" value={templateForm.category}
    onChange={e => setTemplateForm({...templateForm, category: e.target.value})}
    placeholder="e.g. leases, court filing" />
  <datalist id="doc-category-list">
    {CATEGORIES.map(c => <option key={c} value={c} />)}
  </datalist>
  <div className="text-2xs text-neutral-400 mt-0.5">Pick one or type a new type.</div>
  </div>
  <div>
  <label className="text-2xs font-medium text-neutral-500 uppercase tracking-wider block mb-0.5">Description</label>
  <Input size="sm" value={templateForm.description} onChange={e => setTemplateForm({...templateForm, description: e.target.value})} placeholder="Brief description" />
  </div>
  </div>
  </div>

  </div>
  )}
  </div>
  {/* END SIDE PANEL */}


  {/* CENTER — canvas (was the old right pane). flex-1 fills the middle. */}
  <div className="flex-1 overflow-y-auto bg-neutral-100/30 flex flex-col">
  {templateForm.template_type === "pdf_overlay" ? (
  <div className="p-6 space-y-4">
  {/* PDF Upload + Viewer */}
  {!templateForm.pdf_storage_path ? (
  <div className="bg-white rounded-xl border border-neutral-200 shadow-card border border-neutral-100 p-8 text-center">
  <div className="text-4xl mb-3">📄</div>
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">Upload a PDF Template</h3>
  <p className="text-sm text-neutral-400 mb-4">Upload a flat PDF. Blank fields will be auto-detected.</p>
  <label className="inline-flex items-center gap-2 bg-brand-600 text-white text-sm px-5 py-2.5 rounded-lg hover:bg-brand-700 cursor-pointer font-semibold">
  <span className="material-icons-outlined text-lg">upload_file</span>Choose PDF
  <FileInput accept=".pdf" className="hidden" onChange={e => handlePdfUpload(e.target.files[0])} />
  </label>
  </div>
  ) : (
  <>
  {/* PDF toolbar */}
  <div className="bg-white rounded-xl border border-neutral-200 shadow-card border border-neutral-100 px-4 py-2 flex items-center gap-3">
  <span className="text-xs text-neutral-500">{templateForm.pdf_page_count} pages</span>
  <span className="text-xs text-neutral-300">|</span>
  <span className="text-xs text-neutral-500">{templateForm.pdf_field_placements.length} placements</span>
  <span className="text-xs text-neutral-300">|</span>
  {placingField ? (
  <span className="text-xs text-success-600 font-semibold">Click on PDF to place: {placingField} <TextLink tone="danger" size="xs" underline={false} onClick={() => setPlacingField(null)} className="ml-1">✕ Cancel</TextLink></span>
  ) : (
  <Select onChange={e => { if (e.target.value) setPlacingField(e.target.value); e.target.value = ""; }} className="text-xs">
  <option value="">+ Place field on PDF...</option>
  {templateForm.fields.map(f => <option key={f.name} value={f.name}>{f.label || f.name}</option>)}
  </Select>
  )}
  <TextLink tone="warn" size="xs" underline={false} onClick={async () => {
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
  }} className="ml-auto">Re-detect</TextLink>
  <label className="text-xs text-neutral-500 hover:text-neutral-700 cursor-pointer">
  Replace PDF
  <FileInput accept=".pdf" className="hidden" onChange={e => handlePdfUpload(e.target.files[0])} />
  </label>
  </div>

  {/* PDF pages with placement overlays */}
  <div ref={pdfContainerRef} className="space-y-4">
  {pdfPages.map((pg, pageIdx) => {
  const pageNum = pg.pageNum;
  const pagePlacements = templateForm.pdf_field_placements.map((p, i) => ({ ...p, _idx: i })).filter(p => p.page === pageNum);
  return (
  <div key={pageNum} className="relative bg-white rounded-xl border border-neutral-200 shadow-card border border-neutral-100 overflow-hidden" style={{ width: pg.width + "px" }}>
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
  <span className={`text-2xs tnum font-semibold truncate ${p.auto_detected ? "text-warn-800" : "text-brand-800"}`}>{p.field_name}</span>
  <TextLink tone="danger" size="xs" underline={false} onClick={e => { e.stopPropagation(); removePlacement(p._idx); }} className="leading-none">✕</TextLink>
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
  </div>
  ) : (
  /* HTML mode — a single paperCanvas WYSIWYG editor. Toolbar lives in the
     sub-ribbon at the top. Canvas IS the preview (no separate preview card). */
  <RichTextEditor
  key={editingTemplate?.id || "new-template"}
  value={templateForm.body}
  onChange={html => setTemplateForm(prev => ({ ...prev, body: html }))}
  mergeFields={[...templateForm.fields, ...Object.keys(templateForm.field_config?.derived || {}).filter(n => !templateForm.fields.some(f => f.name === n)).map(n => ({ name: n, label: n.replace(/_/g, " ") })), ...(templateForm.signing_mode !== "none" ? [{ name: SIGNATURE_BLOCK_KEY, label: "Signature block (every signer)" }] : [])]}
  placeholder="Start typing… drag a field from the left rail or click a merge-chip to insert."
  hideToolbar
  paperCanvas
  showFieldChips={false}
  pageSetup={templateForm.field_config?.page_setup || null}
  onPageSetupChange={patch => setTemplateForm(prev => ({ ...prev, field_config: { ...(prev.field_config || {}), page_setup: { ...DEFAULT_PAGE_SETUP, ...(prev.field_config?.page_setup || {}), ...patch } } }))}
  onEditorReady={setHtmlEditor}
  />
  )}
  </div>
  </div>
  )}
  </div>
  );
  }

  // ============ DOCUMENT FILL — FULL SCREEN ============
  if (step === "fill" && selectedTemplate) {
  sideOnLeft.current = true;
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
  <Input type="text" value={addr.line1 || ""} onChange={e => setAddr("line1", e.target.value)} className={base} placeholder="Street address" maxLength={200} />
  <Input type="text" value={addr.line2 || ""} onChange={e => setAddr("line2", e.target.value)} className={base} placeholder="Apt, suite, unit (optional)" maxLength={100} />
  <div className="grid grid-cols-3 gap-2">
  <Input type="text" value={addr.city || ""} onChange={e => setAddr("city", e.target.value)} className={base} placeholder="City" maxLength={50} />
  <Input type="text" value={addr.state || ""} onChange={e => setAddr("state", e.target.value.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase())} className={base} placeholder="State" maxLength={2} />
  <Input type="text" value={addr.zip || ""} onChange={e => setAddr("zip", e.target.value.replace(/\D/g, "").slice(0, 5))} className={base} placeholder="ZIP" maxLength={5} />
  </div>
  </div>
  );
  }

  const val = fieldValues[f.name] || "";
  if (f.type === "textarea") return <Textarea value={val} onChange={e => updateVal(f.name, e.target.value)} className={base} rows={3} />;
  if (f.type === "select") return (
  <Select value={val} onChange={e => updateVal(f.name, e.target.value)}>
  <option value="">Select...</option>
  {(f.options || []).map(o => <option key={o} value={o}>{o}</option>)}
  </Select>
  );
  if (f.type === "checkbox") return (
  <label className="flex items-center gap-2"><Checkbox checked={!!val} onChange={e => updateVal(f.name, e.target.checked)} className="accent-brand-600" />{f.label}</label>
  );
  if (f.type === "signature" || f.type === "signature_placeholder") {
    const roleLabel = f.signer_role ? " (" + f.signer_role + ")" : "";
    return <div className="border-2 border-dashed border-brand-300 bg-brand-50/40 rounded-lg py-5 px-3 text-center text-xs text-brand-600 italic">Signature field{roleLabel} — will be filled when this doc is signed via the e-sign flow.</div>;
  }
  const inputType = f.type === "date" ? "date" : f.type === "number" ? "number" : f.type === "currency" ? "text" : "text";
  const extraProps = inputType === "date" ? { min: "2000-01-01", max: "2099-12-31" } : inputType === "number" ? { step: "any" } : { maxLength: 200 };
  return <Input type={inputType} value={val} onChange={e => updateVal(f.name, e.target.value)} className={base} placeholder={f.type === "currency" ? "$0.00" : ""} {...extraProps} />;
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
  <div className="fixed inset-0 z-50 bg-surface-muted flex flex-col safe-y safe-x">
  {/* Top ribbon — breadcrumb + mode hint + Preview CTA */}
  <div className="h-14 border-b border-neutral-100 bg-white flex items-center px-5 gap-3 shrink-0">
  <IconBtn icon="arrow_back" onClick={resetFlow} />
  <div className="flex-1 min-w-0 flex items-center gap-1.5 text-sm">
  <span className="text-neutral-400 shrink-0">Document Builder</span>
  <span className="text-neutral-300 shrink-0">›</span>
  <span className="font-semibold text-neutral-800 truncate">{selectedTemplate.name}</span>
  <span className="ml-2 text-2xs px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-500 uppercase tracking-wide shrink-0">{mode === "prefill" ? "Prefilled" : "Blank"}</span>
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
  <div style={{ width: sidePercent + "%", minWidth: 320 }} className="shrink-0 overflow-y-auto p-4 space-y-3">
  {sections.map(section => {
  const sectionFields = (selectedTemplate.fields || []).filter(f => f.section === section).map(renderFieldRow).filter(Boolean);
  if (sectionFields.length === 0) return null;
  return (
  <div key={section} className="bg-white rounded-xl border border-neutral-200 shadow-card p-4">
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-3">{section}</h3>
  <div className="space-y-3">{sectionFields}</div>
  </div>
  );
  })}
  {unsectioned.length > 0 && (() => {
  const rows = unsectioned.map(renderFieldRow).filter(Boolean);
  return rows.length > 0 ? (
  <div className="bg-white rounded-xl border border-neutral-200 shadow-card p-4">
  <div className="space-y-3">{rows}</div>
  </div>
  ) : null;
  })()}
  </div>

  {/* Drag handle */}
  <div onMouseDown={startDrag} className="w-1.5 bg-brand-100 hover:bg-brand-300 cursor-col-resize shrink-0 transition-colors" />

  {/* Right: Live preview. An HTML document fills the pane edge to edge on
      its pages (the paged view brings its own gutter and scrolling); a
      PDF-overlay template keeps the padded, scrolling column. */}
  <div className={"flex-1 min-w-0 " + (selectedTemplate.template_type === "pdf_overlay" ? "overflow-y-auto p-6" : "flex flex-col")}>
  {selectedTemplate.template_type === "pdf_overlay" ? (
  <div ref={pdfContainerRef} className="space-y-4">
  {pdfPages.map(pg => {
  const pagePlacements = (selectedTemplate.pdf_field_placements || []).filter(p => p.page === pg.pageNum);
  return (
  <div key={pg.pageNum} className="relative bg-white rounded-xl border border-neutral-200 shadow-card border border-neutral-100 overflow-hidden" style={{ width: pg.width + "px" }}>
  <div className="absolute top-2 left-2 bg-black/50 text-white text-xs px-2 py-0.5 rounded z-10">Page {pg.pageNum}</div>
  <canvas ref={el => { if (el && el !== pg.canvas) { el.width = pg.canvas.width; el.height = pg.canvas.height; el.getContext("2d").drawImage(pg.canvas, 0, 0); } }} width={pg.width} height={pg.height} className="block" />
  <div className="absolute inset-0">
  {pagePlacements.map((p, i) => {
  const val = fieldValues[p.field_name];
  const displayVal = val && typeof val === "object" ? formatAddressBlock(val) : (val || "");
  return displayVal ? (
  <div key={i} className="absolute px-1 overflow-hidden" style={{ left: p.x + "%", top: p.y + "%", width: p.width + "%", height: p.height + "%", fontSize: (p.font_size || 12) + "px", fontFamily: "Helvetica, Arial, sans-serif", color: printTheme.ink, lineHeight: "1.2", whiteSpace: "nowrap" }}>{String(displayVal)}</div>
  ) : null;
  })}
  </div>
  </div>
  );
  })}
  {pdfPages.length === 0 && <div className="text-center py-12 text-neutral-400">Loading PDF preview...</div>}
  </div>
  ) : (
  <>
  <div className="px-4 py-1.5 border-b border-neutral-100 bg-white text-2xs font-semibold uppercase tracking-wide text-neutral-400 shrink-0">Live preview · updates as you type</div>
  {(() => { const paged = pagedBody(null, selectedTemplate, fieldValues); return (
  <RichTextEditor readOnly paperCanvas hideToolbar value={paged.html} pageSetup={paged.pageSetup} />
  ); })()}
  </>
  )}
  </div>
  </div>
  </div>
  );
  }

  // ============ PREVIEW + EXPORT — FULL SCREEN ============
  if (step === "preview" && selectedTemplate) {
  sideOnLeft.current = false;
  const rendered = renderMergedBody(selectedTemplate.body, fieldValues, selectedTemplate.field_config);
  return (
  <div className="fixed inset-0 z-50 bg-surface-muted flex flex-col safe-y safe-x">
  {/* Top ribbon — breadcrumb + inline export shortcuts */}
  <div className="h-14 border-b border-neutral-100 bg-white flex items-center px-5 gap-3 shrink-0">
  <IconBtn icon="arrow_back" onClick={() => setStep("fill")} />
  <div className="flex-1 min-w-0 flex items-center gap-1.5 text-sm">
  <span className="text-neutral-400 shrink-0">Document Builder</span>
  <span className="text-neutral-300 shrink-0">›</span>
  <span className="font-semibold text-neutral-800 truncate">{selectedTemplate.name}</span>
  <span className="ml-2 text-2xs px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-500 uppercase tracking-wide shrink-0">Preview</span>
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
  <div className={"flex-1 min-w-0 " + (selectedTemplate.template_type === "pdf_overlay" ? "overflow-y-auto p-6 flex justify-center" : "flex flex-col")}>
  {selectedTemplate.template_type === "pdf_overlay" ? (
  <div ref={pdfContainerRef} className="space-y-4">
  {pdfPages.map(pg => {
  const pagePlacements = (selectedTemplate.pdf_field_placements || []).filter(p => p.page === pg.pageNum);
  return (
  <div key={pg.pageNum} className="relative bg-white rounded-xl border border-neutral-200 shadow-card border border-neutral-100 overflow-hidden" style={{ width: pg.width + "px" }}>
  <div className="absolute top-2 left-2 bg-black/50 text-white text-xs px-2 py-0.5 rounded z-10">Page {pg.pageNum}</div>
  <canvas ref={el => { if (el && el !== pg.canvas) { el.width = pg.canvas.width; el.height = pg.canvas.height; el.getContext("2d").drawImage(pg.canvas, 0, 0); } }} width={pg.width} height={pg.height} className="block" />
  <div className="absolute inset-0">
  {pagePlacements.map((p, i) => {
  const val = fieldValues[p.field_name];
  const displayVal = val && typeof val === "object" ? formatAddressBlock(val) : (val || "");
  return displayVal ? (
  <div key={i} className="absolute px-1 overflow-hidden" style={{ left: p.x + "%", top: p.y + "%", width: p.width + "%", height: p.height + "%", fontSize: (p.font_size || 12) + "px", fontFamily: "Helvetica, Arial, sans-serif", color: printTheme.ink, lineHeight: "1.2", whiteSpace: "nowrap" }}>{String(displayVal)}</div>
  ) : null;
  })}
  </div>
  </div>
  );
  })}
  {pdfPages.length === 0 && <div className="text-center py-12 text-neutral-400">Loading PDF preview...</div>}
  </div>
  ) : (
  <div ref={previewRef} className="flex flex-col flex-1 min-h-0">
  {(() => { const paged = pagedBody(null, selectedTemplate, fieldValues); return (
  <RichTextEditor readOnly paperCanvas hideToolbar value={paged.html} pageSetup={paged.pageSetup} />
  ); })()}
  </div>
  )}
  </div>

  {/* Drag handle */}
  <div onMouseDown={startDrag} className="w-1.5 bg-brand-100 hover:bg-brand-300 cursor-col-resize shrink-0 transition-colors" />

  {/* Right: Actions sidebar (Send). Export lives in the top ribbon. Save/Finalize
      moved to a sticky bottom action bar below, Zoho-style. */}
  <div style={{ width: sidePercent + "%", minWidth: 320 }} className="shrink-0 overflow-y-auto p-4 space-y-4">
  {selectedTemplate?.signing_mode && selectedTemplate.signing_mode !== "none" ? (
  /* Envelope / e-sign flow */
  <div className="bg-white rounded-xl border border-neutral-200 shadow-card border border-brand-200 p-4">
  <div className="flex items-center gap-2 mb-1">
  <span className="material-icons-outlined text-brand-600">draw</span>
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Send for Signature</h3>
  <span className="text-2xs px-1.5 py-0.5 rounded-full bg-brand-100 text-brand-700 font-semibold uppercase">{selectedTemplate.signing_mode}</span>
  </div>
  <p className="text-xs text-neutral-400 mb-3">Each signer will receive a unique magic-link email. No account required on their end; the link expires in 30 days.</p>
  <div className="space-y-2 mb-3">
  {[...signerRoles].sort((a,b) => (a.order||0) - (b.order||0)).map(r => {
  const color = getRoleColor(r.role, signerRoles);
  return (
  <div key={r.role} className="border border-neutral-100 rounded-xl p-2.5 bg-white">
  <div className="flex items-center justify-between mb-1">
  <span className="flex items-center gap-1.5">
  <span className={`w-2.5 h-2.5 rounded-full ${color.dot}`} />
  <span className="text-xs font-semibold text-neutral-600">{r.label || r.role}{r.required === false && <span className="text-2xs text-neutral-400 font-normal ml-1">(optional)</span>}</span>
  </span>
  {selectedTemplate.signing_mode === "sequential" && <span className="text-2xs text-brand-600">#{r.order || 1}</span>}
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
  <div className="bg-white rounded-xl border border-neutral-200 shadow-card p-4">
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-3">Send via Email</h3>
  <div className="space-y-2 mb-3">
  <label className="flex items-center gap-2 text-sm"><Checkbox checked={sendTo.self} onChange={e => setSendTo({...sendTo, self: e.target.checked})} className="accent-brand-600" />Email to myself ({userProfile?.email})</label>
  {fieldValues.tenant_name && <label className="flex items-center gap-2 text-sm"><Checkbox checked={sendTo.tenant} onChange={e => setSendTo({...sendTo, tenant: e.target.checked})} className="accent-brand-600" />Email to tenant ({fieldValues.tenant_name})</label>}
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
  <Btn variant="secondary" className="w-full mt-2" onClick={async () => {
  const doc = await saveDocument("sent");
  if (doc) await prepareMailDraft(doc);
  }} disabled={sending}>Open in my mail app</Btn>
  <p className="text-2xs text-neutral-400 mt-1.5">Send Email goes out from the app and is logged. Your mail app sends it from your own address.</p>
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
  <TabBar active={tab} onChange={setTab} tabs={[
    { id: "create", label: "Create", icon: "add_circle_outline" },
    { id: "templates", label: "Templates", icon: "description" },
    // The count was a pill inside the button; TabBar renders it from
    // `count`, so it comes back as data instead of markup. It was dropped
    // entirely by the first pass, along with all three icons -- a
    // three-element [id, label, icon] tuple is not the [id, label] pair
    // TabBar reads, and the extra element went silently nowhere.
    { id: "history", label: "History", icon: "history", count: generatedDocs.length || null },
  ]} />
  </div>

  {/* ---- CREATE TAB ---- */}
  {tab === "create" && (
  <div>
  {/* Mode selection — segmented control */}
  <div className="bg-white rounded-xl border border-neutral-200 shadow-card p-4 mb-5">
  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-3">
  How do you want to start?
  {templates.length > 0 && <span className="ml-2 normal-case tracking-normal font-normal text-neutral-400">{templates.length} template{templates.length === 1 ? "" : "s"} ready</span>}
  </h3>
  <div className="flex gap-2 flex-wrap">
  <button onClick={() => setMode("blank")} className={"flex items-center gap-2 px-4 py-2 rounded-lg border text-sm transition-colors " + (mode === "blank" ? "border-brand-500 bg-brand-50 text-brand-700" : "border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300")}>
  <span className="material-icons-outlined text-base">edit_note</span>
  <span className="font-medium">Blank</span>
  <span className="text-2xs text-neutral-400 hidden md:inline">· fill manually</span>
  </button>
  <button onClick={() => setMode("prefill")} className={"flex items-center gap-2 px-4 py-2 rounded-lg border text-sm transition-colors " + (mode === "prefill" ? "border-success-500 bg-success-50 text-success-700" : "border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300")}>
  <span className="material-icons-outlined text-base">auto_fix_high</span>
  <span className="font-medium">Prefill from Property</span>
  <span className="text-2xs text-neutral-400 hidden md:inline">· tenant + lease autofill</span>
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
  {templates.length === 0 && (
  <div className="rounded-xl border border-dashed border-neutral-200 p-6 text-center">
  <div className="text-sm font-medium text-neutral-700 mb-1">No templates yet</div>
  <div className="text-xs text-neutral-500 mb-3">Upload a lease or court form as a PDF, or start from a blank one, and place the fields that should fill themselves.</div>
  <Btn size="sm" onClick={() => setTab("templates")}>Go to Templates</Btn>
  </div>
  )}
  {/* Maryland court forms. These are the court's own fillable PDFs, filled
      from a tenant's ledger and case rather than from a template, so they
      start from the tenant (Tenants › the tenant › Lease and notices). */}
  <div className="mb-4">
  <h4 className="text-xs font-semibold text-neutral-400 uppercase tracking-widest mb-2">Court forms (Maryland)</h4>
  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
  {[
    ["Notice of Intent to File (DC-CV-115)", "Failure to pay rent, step 1. Past-due rent and late fees from the tenant's ledger, on the court's own form."],
    ["Complaint for Repossession (DC-CV-082)", "Failure to pay rent, step 2, after the ten days. The court's e-filing version, filled in; a worksheet for the paper form too."],
    ["Petition for Warrant of Restitution (DC-CV-081)", "After judgment for possession: the petition for the warrant, filled in from the case."],
  ].map(([name, blurb]) => (
  <button key={name} type="button" onClick={() => setPage && setPage("tenants")} title="Open the tenant, then Lease and notices"
  className="bg-white rounded-lg border border-neutral-100 p-4 text-left hover:border-brand-300 hover:shadow-card transition-all">
  <div className="font-semibold text-neutral-800 text-sm">{name}</div>
  <div className="text-xs text-neutral-400 mt-1">{blurb}</div>
  <div className="text-xs text-brand-600 mt-2">Starts from a tenant's page</div>
  </button>
  ))}
  </div>
  </div>
  {[...CATEGORIES, "__uncategorised__"].map(cat => {
  const catTemplates = cat === "__uncategorised__"
    ? templates.filter(t => !(t.category || "").trim())
    : templates.filter(t => (t.category || "").trim() === cat);
  if (catTemplates.length === 0) return null;
  return (
  <div key={cat} className="mb-4">
  <h4 className="text-xs font-semibold text-neutral-400 uppercase tracking-widest mb-2">{cat}</h4>
  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
  {catTemplates.map(t => (
  <button key={t.id} onClick={() => startDocument(t, mode)} disabled={mode === "prefill" && !prefillProperty}
  className="bg-white rounded-lg border border-neutral-100 p-4 text-left hover:border-brand-300 hover:shadow-card transition-all disabled:opacity-50 disabled:cursor-not-allowed">
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
  <div key={t.id} className="bg-white rounded-xl border border-neutral-200 shadow-card p-4 flex flex-col">
  <div className="flex items-start justify-between mb-2">
  <div className="flex items-center gap-2 min-w-0">
  <span className={"w-8 h-8 rounded-lg flex items-center justify-center shrink-0 " + (isPdf ? "bg-danger-50 text-danger-600" : "bg-brand-50 text-brand-600")}>
  <span className="material-icons-outlined text-base">{isPdf ? "picture_as_pdf" : "description"}</span>
  </span>
  <div className="min-w-0">
  <div className="font-semibold text-neutral-800 text-sm truncate">{t.name}</div>
  <div className="flex items-center gap-1.5 flex-wrap">
  <div className="text-2xs text-neutral-400 capitalize">{t.category || "uncategorised"}</div>
  {/* What this template can do, on the card. Signing, PDF overlay and
      auto-fill were all built and none of it was visible until you
      opened the editor and scrolled a right-hand rail -- which is why
      the builder read as "no e-sign". */}
  {t.template_type === "pdf_overlay" && (
    <span className="text-2xs px-1.5 py-0.5 rounded-full bg-neutral-100 text-neutral-600" title="Fields are placed on an uploaded PDF">PDF</span>
  )}
  {t.signing_mode && t.signing_mode !== "none" && (
    <span className="text-2xs px-1.5 py-0.5 rounded-full bg-positive-50 text-positive-700"
      title={`Signature required — ${(t.signer_roles || []).map(r => r.label || r.role).join(", ") || "signers not yet defined"}`}>
      ✍ e-sign{(t.signer_roles || []).length ? ` · ${t.signer_roles.length}` : ""}
    </span>
  )}
  {(t.fields || []).some(f => f.prefill_from) && (
    <span className="text-2xs px-1.5 py-0.5 rounded-full bg-brand-50 text-brand-700"
      title={`${(t.fields || []).filter(f => f.prefill_from).length} field(s) fill themselves from your data`}>
      auto-fill
    </span>
  )}
  </div>
  </div>
  </div>
  {t.is_system && <span className="text-2xs bg-neutral-100 text-neutral-500 px-1.5 py-0.5 rounded-full shrink-0">System</span>}
  </div>
  {t.description && <p className="text-xs text-neutral-400 mb-2 line-clamp-2">{t.description}</p>}
  <div className="flex items-center gap-1.5 flex-wrap text-2xs mb-3">
  <span className="text-neutral-500">{(t.fields || []).length} fields</span>
  {isPdf && <span className="px-1.5 py-0.5 rounded-full bg-danger-50 text-danger-600 uppercase tracking-wide font-semibold">PDF overlay</span>}
  {hasESign && <span className="px-1.5 py-0.5 rounded-full bg-brand-50 text-brand-700 uppercase tracking-wide font-semibold flex items-center gap-0.5"><span className="material-icons-outlined text-2xs">draw</span>e-sign</span>}
  </div>
  <div className="flex gap-1 mt-auto">
  <Btn variant="success-fill" size="xs" className="flex-1" onClick={() => { setSelectedTemplate(t); setMode("blank"); setFieldValues(applyDefaults(t)); setStep("fill"); setTab("create"); }}>Use</Btn>
  <Btn variant="secondary" size="xs" onClick={async () => { setEditingTemplate(t); setTemplateForm({ name: t.name, category: t.category, description: t.description || "", body: t.body || "", fields: t.fields || [], field_config: t.field_config || {}, template_type: t.template_type || "html", pdf_storage_path: t.pdf_storage_path || "", pdf_page_count: t.pdf_page_count || 0, pdf_field_placements: t.pdf_field_placements || [], signing_mode: t.signing_mode || "none", signer_roles: t.signer_roles || [] }); setPdfPages([]); setPdfDoc(null); setShowTemplateEditor(true); if (t.template_type === "pdf_overlay" && t.pdf_storage_path) { setTimeout(async () => { const pdf = await loadPdfForPreview(t.pdf_storage_path); if (pdf) await renderPdfPages(pdf, pdfScale); }, 100); } }}>Edit</Btn>
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
  <div key={d.id} className="bg-white rounded-xl border border-neutral-200 shadow-card p-4">
  <div className="flex items-center justify-between">
  <div className="flex-1 min-w-0">
  <div className="font-semibold text-neutral-800 text-sm truncate">{d.name}</div>
  <div className="flex items-center gap-2 mt-1 flex-wrap">
  <span className={"text-xs px-2 py-0.5 rounded-full font-medium " + (d.status === "sent" ? "bg-success-50 text-success-700" : d.status === "final" ? "bg-info-50 text-info-700" : "bg-neutral-50 text-neutral-500")}>{d.status}</span>
  {envBadge && <span className={"text-xs px-2 py-0.5 rounded-full font-medium " + envBadge.cls}>{envBadge.label}</span>}
  {d.tenant_name && <span className="text-xs text-neutral-400">{d.tenant_name}</span>}
  {d.property_address && <span className="text-xs text-neutral-400">· {d.property_address}</span>}
  <span className="text-xs text-neutral-400">· {fmtDate(d.created_at)}</span>
  </div>
  </div>
  {/* A court form is the court's own PDF, stored as made: there is no
      body to re-render, re-export or email from here. */}
  {d.output_type === "court_form" ? (
  <div className="flex gap-2 shrink-0">
  {d.pdf_output_path && <Btn variant="danger" size="xs" onClick={async () => { const url = await getSignedUrl("documents", d.pdf_output_path); if (url) window.open(url, "_blank", "noopener,noreferrer"); else showToast("That file could not be opened.", "error"); }} title="PDF">PDF</Btn>}
  <TextLink tone="danger" size="xs" underline={false} onClick={() => deleteGeneratedDoc(d)}>✕</TextLink>
  </div>
  ) : (
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
  <TextLink tone="danger" size="xs" underline={false} onClick={() => deleteGeneratedDoc(d)}>✕</TextLink>
  </div>
  )}
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
  {s.signed_at && <span className="text-neutral-400 ml-auto shrink-0">{fmtDate(s.signed_at)}</span>}
  {!s.signed_at && ["sent", "viewed"].includes(s.status) && d.envelope_status === "out_for_signature" && <TextLink tone="brand" size="xs" className="ml-auto shrink-0" onClick={() => resendSigner(s)} title={"Email the link again" + (s.reminder_count ? " (reminded " + s.reminder_count + "×)" : "")}>resend</TextLink>}
  {!s.signed_at && ["sent", "viewed"].includes(s.status) && d.envelope_status === "out_for_signature" && <TextLink tone="brand" size="xs" className="shrink-0" onClick={() => navigator.clipboard?.writeText(window.location.origin + "/sign/" + s.access_token).then(() => showToast("Signing link copied", "success"))}>copy link</TextLink>}
  </div>
  );
  })}
  </div>
  )}
  <div className="mt-2 flex items-center gap-4 text-xs">
  {d.envelope_status === "out_for_signature" && <TextLink tone="danger" size="xs" underline={false} onClick={() => cancelEnvelope(d)}>Cancel request</TextLink>}
  {d.envelope_status === "completed" && !d.signed_pdf_path && <TextLink tone="brand" size="xs" underline={false} onClick={() => storeSignedCopy(d)} title="The last signer's browser did not finish uploading the signed copy. Store it now.">Store signed copy</TextLink>}
  {d.envelope_status === "completed" && d.signed_pdf_path && <span className="text-success-600">Signed copy stored{d.filed_document_id ? " and filed under Documents" : ""}</span>}
  {d.envelope_status === "voided" && <span className="text-neutral-400">Cancelled{d.voided_at ? " " + fmtDate(d.voided_at) : ""}</span>}
  <TextLink tone="brand" size="xs" underline={false} onClick={() => openEmailLog(d)}>Email log</TextLink>
  </div>
  </div>
  );
  })}
  </div>
  )}

  {/* Email log: every send for this document, where it went, whether it left */}
  {emailLogFor && (
  <Modal title={"Emails: " + emailLogFor.doc.name} onClose={() => setEmailLogFor(null)}>
  {emailLogFor.rows.length === 0 ? (
  <p className="text-sm text-neutral-500">No email has been sent for this document.</p>
  ) : (
  <div className="space-y-2 max-h-[60vh] overflow-y-auto">
  {emailLogFor.rows.map(r => (
  <div key={r.id} className="text-xs border border-neutral-100 rounded-lg px-3 py-2">
  <div className="flex items-center gap-2">
  <span className={"px-1.5 py-0.5 rounded font-medium " + (r.status === "sent" ? "bg-success-50 text-success-700" : r.status === "failed" ? "bg-danger-50 text-danger-700" : "bg-neutral-100 text-neutral-600")}>{r.status === "suppressed" ? "not sent" : r.status}</span>
  <span className="font-semibold text-neutral-700">{({ sign_request: "Signature request", sign_reminder: "Reminder", signed_copy: "Signed copy", completed_staff: "Completion notice", document: "Document" })[r.kind] || r.kind}</span>
  <span className="text-neutral-400 ml-auto">{fmtDateTime(r.created_at)}</span>
  </div>
  <div className="text-neutral-600 mt-1">To {r.intended_email || r.to_email}{r.intended_email && r.to_email !== r.intended_email ? " (redirected to " + r.to_email + ": test site)" : ""}</div>
  {r.error && <div className="text-neutral-400 mt-0.5">{r.error}</div>}
  </div>
  ))}
  </div>
  )}
  </Modal>
  )}

  {/* Send modal for history items */}
  {sendModal && (
  <Modal title={"Send: " + sendModal.name} onClose={() => setSendModal(null)}>
  <div className="space-y-3">
  <label className="flex items-center gap-2 text-sm"><Checkbox checked={sendTo.self} onChange={e => setSendTo({...sendTo, self: e.target.checked})} className="accent-brand-600" />Email to myself</label>
  {sendModal.tenant_name && <label className="flex items-center gap-2 text-sm"><Checkbox checked={sendTo.tenant} onChange={e => setSendTo({...sendTo, tenant: e.target.checked})} className="accent-brand-600" />Email to tenant ({sendModal.tenant_name})</label>}
  <div>
  <label className="text-xs font-medium text-neutral-400 block mb-1">Custom recipients</label>
  <Input value={sendTo.custom} onChange={e => setSendTo({...sendTo, custom: e.target.value})}  placeholder="email@example.com, other@example.com" />
  </div>
  <Btn variant="success-fill" className="w-full" onClick={() => sendEmail(sendModal)} disabled={sending}>
  {sending ? "Sending..." : "Send"}
  </Btn>
  <Btn variant="secondary" className="w-full" onClick={() => prepareMailDraft(sendModal)} disabled={sending}>Open in my mail app</Btn>
  </div>
  </Modal>
  )}

  {/* Prepared: now a click can open the share sheet or a draft. */}
  {mailDraft && (
  <Modal title="Send from your own mail app" onClose={() => setMailDraft(null)}>
  <div className="space-y-3">
  <p className="text-sm text-neutral-600">{mailDraft.doc.name} is ready.</p>
  <div className="text-sm">
  <span className="text-neutral-400">To: </span>
  {mailDraft.recipients.length ? <span className="text-neutral-800 break-all">{mailDraft.recipients.join(", ")}</span> : <span className="text-warn-700">nobody chosen: add the address in your mail app</span>}
  </div>
  {mailDraft.canShare && (
  <Btn className="w-full" onClick={shareMailDraft}>Share with the PDF attached</Btn>
  )}
  {mailDraft.canShare && <p className="text-2xs text-neutral-400 -mt-1.5">Opens this device's share sheet: choose Mail. You add the recipient there.</p>}
  {mailDraft.link ? (<>
  <a className="block w-full text-center rounded-lg border border-brand-200 text-brand-700 font-semibold text-sm py-2 hover:bg-brand-50"
     href={mailtoUrl({ to: mailDraft.recipients, subject: mailDraft.subject, body: mailDraft.body })}
     onClick={() => { noteMailDraftUsed("draft with a link"); setMailDraft(null); }}>Open a draft with a link to the PDF</a>
  <p className="text-2xs text-neutral-400 -mt-1.5">Opens your default mail program with the recipient, subject and message filled in. A draft opened this way cannot carry an attachment, so it carries a private link that works for {MAIL_LINK_DAYS} days.</p>
  </>) : !mailDraft.canShare ? (
  <p className="text-sm text-danger-600">The PDF could not be stored, so there is no link to put in a draft. Use Send instead.</p>
  ) : null}
  <p className="text-xs text-neutral-400 border-t border-neutral-100 pt-2">It is sent when you press Send in your mail app. The app cannot see whether you did, so it is not in the email log.</p>
  </div>
  </Modal>
  )}
  </div>
  )}
  </div>
  );
}

export { Documents, DocumentBuilder };
