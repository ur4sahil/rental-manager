// Everything filed against one property, in folders.
//
// The property panel used to show ONE flat list, capped at 100 rows, drawn
// from the documents table alone. Three problems with that, all of which show
// up as "where is my paperwork":
//
//   THE CAP. .limit(100) with no paging. A property accumulating a utility
//   statement a month per provider crosses 100 within a couple of years, and
//   the rows that fall off are the OLDEST ones -- silently, with nothing on
//   screen to say the list is partial.
//
//   THE FLAT LIST. A lease, a tenant's ID, twelve gas statements and a
//   maintenance photo interleaved by upload date. Fine at five documents,
//   useless at eighty.
//
//   THE MISSING SOURCES. documents is not the only place a property's files
//   live. doc_generated holds generated and e-signed paperwork with its own
//   signed_pdf_path; work_order_photos holds maintenance photos. Neither
//   appeared here at all, so a signed lease was "not in the property's
//   documents" while sitting in the database.
//
// This reads all three, pages every one of them, and groups the result into
// folders -- with tenant paperwork broken out per tenant, because "the
// tenant's documents" means a different set of files for each person who has
// lived there.
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { supabase } from "../supabase";
import { Btn, TextLink, Input, Select } from "../ui";
import { Spinner } from "./shared";
import { DOC_TYPES, getSignedUrl, fmtDate } from "../utils/helpers";
import { fetchAllPaged } from "../utils/accounting";
import { pmError } from "../utils/errors";
import { logAudit } from "../utils/audit";
import { guardSubmit, guardRelease } from "../utils/guards";

// Folder order. Deliberately not alphabetical: this is the order a person
// looks for things in. The lease first because it is what gets opened most,
// then who lives there, then the recurring paperwork, then the history.
const FOLDER_ORDER = [
  "Lease", "Signed & Generated", "Tenant Documents", "ID", "Insurance",
  "Utility Bill", "Utility Receipt", "Utility Transfer", "Inspection",
  "Maintenance", "Maintenance Photos", "Financial", "Notice", "Other", "Unfiled",
];

const FOLDER_ICON = {
  "Lease": "description",
  "Signed & Generated": "draw",
  "Tenant Documents": "people",
  "ID": "badge",
  "Insurance": "verified_user",
  "Utility Bill": "receipt_long",
  "Utility Receipt": "price_check",
  "Utility Transfer": "swap_horiz",
  "Inspection": "search",
  "Maintenance": "build",
  "Maintenance Photos": "photo_library",
  "Financial": "account_balance",
  "Notice": "campaign",
  "Other": "folder",
  "Unfiled": "folder_off",
};

// Folders that belong to a PERSON when the document names one.
const PERSONAL_FOLDERS = ["ID", "Insurance", "Lease", "Signed & Generated", "Notice", "Other", "Unfiled"];

// Which folder a document's `type` belongs in.
//
// The stored types are not clean. Real data holds "Insurance" AND "insurance"
// as separate values, plus "inspection" in lower case and "Receipt", which is
// not in DOC_TYPES at all -- documents predate the picker, and some rows were
// written by imports and by hand.
//
// So: fold case before matching, which puts "insurance" and "Insurance" in
// one folder rather than two sitting next to each other. A type that matches
// nothing keeps its OWN folder under its own name -- "Receipt" is somebody's
// paperwork and burying it in "Other" is how it stops being findable.
const FOLDER_BY_LOWER = new Map(FOLDER_ORDER.map(f => [f.toLowerCase(), f]));
function folderForType(type) {
  const t = String(type || "").trim();
  if (!t) return "Unfiled";
  return FOLDER_BY_LOWER.get(t.toLowerCase()) || t;
}

// A statement or an ID is not the tenant's to read unless someone said so.
// Shown on the row so that is visible without opening anything.
function VisibilityChip({ visible }) {
  if (!visible) return null;
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning-50 text-warning-700 border border-warning-200 whitespace-nowrap">
      tenant can see
    </span>
  );
}

export default function PropertyDocuments({
  property, companyId, userProfile, userRole, showToast, showConfirm,
  onUpload, isReadOnly,
}) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [showArchived, setShowArchived] = useState(false);
  const [open, setOpen] = useState(() => new Set(["Lease", "Tenant Documents"]));
  const [busyId, setBusyId] = useState(null);
  // Which fetch this is. A slow first request must not overwrite the results
  // of a later one -- switching property twice quickly is enough to do it.
  const runRef = useRef(0);

  const address = property?.address || "";

  const load = useCallback(async () => {
    if (!companyId || !address) { setDocs([]); setLoading(false); return; }
    const run = ++runRef.current;
    setLoading(true);
    setTruncated(false);

    // No escapeFilterValue here on purpose: every query below uses .eq(),
    // which sends the value as a plain parameter. Escaping is for .or(),
    // .like() and .ilike(), where the value is parsed as filter syntax.
    const [docsRes, genRes, photoRes] = await Promise.all([
      // PAGED, all three of them. The point of the module.
      fetchAllPaged(() => {
        let b = supabase.from("documents")
          .select("id, name, file_name, url, type, tenant, tenant_id, uploaded_at, archived_at, archived_by, tenant_visible, size")
          .eq("company_id", companyId).eq("property", address);
        if (!showArchived) b = b.is("archived_at", null);
        return b.order("uploaded_at", { ascending: false });
      }, "property documents"),
      fetchAllPaged(() => {
        let b = supabase.from("doc_generated")
          .select("id, name, status, tenant_name, created_at, archived_at, file_path, pdf_output_path, signed_pdf_path, envelope_status")
          .eq("company_id", companyId).eq("property_address", address);
        if (!showArchived) b = b.is("archived_at", null);
        return b.order("created_at", { ascending: false });
      }, "generated documents"),
      fetchAllPaged(() => supabase.from("work_order_photos")
        .select("id, url, caption, created_at, work_order_id")
        .eq("company_id", companyId).eq("property", address)
        .order("created_at", { ascending: false }), "work order photos"),
    ]);

    if (run !== runRef.current) return;   // a newer load has started

    // A failed page is reported, not hidden behind an empty folder. An empty
    // list and a failed query look identical on screen otherwise, which is how
    // "my documents are gone" gets misdiagnosed as a deletion.
    const failed = [docsRes, genRes, photoRes].some(r => r.failed);
    setTruncated(failed);

    const rows = [];

    for (const d of (docsRes.rows || [])) {
      rows.push({
        key: "doc:" + d.id, id: d.id, source: "documents",
        name: d.name || d.file_name || "Untitled",
        path: d.file_name || d.url,
        type: d.type || "Unfiled",
        tenant: d.tenant || null,
        at: d.uploaded_at,
        archived: !!d.archived_at, archivedBy: d.archived_by,
        tenantVisible: !!d.tenant_visible,
        deletable: true,
      });
    }

    for (const g of (genRes.rows || [])) {
      // Prefer the SIGNED pdf: once a document is signed, the unsigned render
      // is a draft and opening it instead is the wrong answer.
      const path = g.signed_pdf_path || g.pdf_output_path || g.file_path;
      if (!path) continue;
      rows.push({
        key: "gen:" + g.id, id: g.id, source: "doc_generated",
        name: g.name || "Generated document",
        path,
        type: "Signed & Generated",
        tenant: g.tenant_name || null,
        at: g.created_at,
        archived: !!g.archived_at,
        tenantVisible: false,
        badge: g.signed_pdf_path ? "signed" : (g.envelope_status || g.status || null),
        deletable: false,
      });
    }

    for (const p of (photoRes.rows || [])) {
      if (!p.url) continue;
      rows.push({
        key: "wop:" + p.id, id: p.id, source: "work_order_photos",
        name: p.caption || "Maintenance photo",
        path: p.url,
        type: "Maintenance Photos",
        tenant: null,
        at: p.created_at,
        archived: false,
        tenantVisible: false,
        deletable: false,
      });
    }

    setDocs(rows);
    setLoading(false);
  }, [companyId, address, showArchived]);

  useEffect(() => { load(); }, [load]);

  // Folders. Tenant paperwork is split per person: one folder per tenant who
  // has documents here, so a past tenant's file does not sit in the middle of
  // the current one's.
  const folders = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = d => !needle
      || d.name.toLowerCase().includes(needle)
      || (d.tenant || "").toLowerCase().includes(needle)
      || d.type.toLowerCase().includes(needle);

    const visible = docs.filter(d => match(d) && (typeFilter === "all" || d.type === typeFilter));

    const byFolder = new Map();
    const put = (folder, row, sub = null) => {
      if (!byFolder.has(folder)) byFolder.set(folder, { rows: [], subs: new Map() });
      const f = byFolder.get(folder);
      if (sub) {
        if (!f.subs.has(sub)) f.subs.set(sub, []);
        f.subs.get(sub).push(row);
      } else f.rows.push(row);
    };

    for (const d of visible) {
      const folder = folderForType(d.type);
      // Anything tied to a person goes in that person's folder, whatever its
      // type -- their ID, their renters insurance, their signed lease. That is
      // what "the tenant's documents" means to someone looking for them.
      if (d.tenant && PERSONAL_FOLDERS.includes(folder)) put("Tenant Documents", d, d.tenant);
      else put(folder, d);
    }

    const ordered = [];
    for (const name of FOLDER_ORDER) {
      const f = byFolder.get(name);
      if (!f) continue;
      const count = f.rows.length + [...f.subs.values()].reduce((s, r) => s + r.length, 0);
      if (!count) continue;
      ordered.push({
        name, count,
        rows: f.rows,
        subs: [...f.subs.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      });
    }
    // Folders for types nobody planned for, alphabetically after the known
    // ones. Kept rather than dropped: a hand-entered type is still somebody's
    // paperwork, and "Other" is where things go to be lost.
    const extras = [...byFolder.entries()]
      .filter(([name]) => !FOLDER_ORDER.includes(name))
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: "base" }));
    for (const [name, f] of extras) {
      const count = f.rows.length + [...f.subs.values()].reduce((s, r) => s + r.length, 0);
      if (!count) continue;
      ordered.push({
        name, count, rows: f.rows,
        subs: [...f.subs.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      });
    }
    return ordered;
  }, [docs, q, typeFilter]);

  // The folders this property actually has. Built from every document
  // regardless of the active filter, so choosing a folder does not remove the
  // other options from the dropdown you chose it with.
  const presentFolders = useMemo(() => {
    const set = new Set();
    for (const d of docs) {
      const f = folderForType(d.type);
      set.add(d.tenant && PERSONAL_FOLDERS.includes(f) ? "Tenant Documents" : f);
    }
    return [...set].sort((a, b) => {
      const ia = FOLDER_ORDER.indexOf(a), ib = FOLDER_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b, undefined, { sensitivity: "base" });
    });
  }, [docs]);

  const total = docs.length;
  const shown = folders.reduce((s, f) => s + f.count, 0);

  const view = async (d) => {
    setBusyId(d.key);
    try {
      const url = await getSignedUrl("documents", d.path, 300);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      else showToast("That file could not be opened — it may have been moved or removed from storage.", "error");
    } finally { setBusyId(null); }
  };

  const remove = async (d) => {
    if (!d.deletable) return;
    if (!guardSubmit("delPropDoc", d.id)) return;
    try {
      if (!await showConfirm({
        message: `Delete "${d.name}"?\n\nIt is removed from active views and can be recovered within 180 days.`,
        variant: "danger", confirmText: "Delete",
      })) return;
      const { error } = await supabase.from("documents")
        .update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email })
        .eq("id", d.id).eq("company_id", companyId);
      if (error) { pmError("PM-7004", { raw: error, context: "delete property document" }); return; }
      showToast("Deleted: " + d.name, "success");
      logAudit("delete", "documents", "Deleted document: " + d.name, d.id, userProfile?.email, userRole, companyId);
      load();
    } finally { guardRelease("delPropDoc", d.id); }
  };

  const toggle = (name) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  const Row = ({ d }) => (
    <div className={`flex items-center justify-between rounded-lg px-3 py-2 hover:bg-neutral-100 transition-colors ${d.archived ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="material-icons-outlined text-neutral-400 text-base flex-shrink-0">
          {FOLDER_ICON[d.type] || "insert_drive_file"}
        </span>
        <div className="min-w-0">
          <div className="text-sm font-medium text-neutral-700 truncate flex items-center gap-2">
            {d.name}
            {d.badge && <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 border border-brand-100 whitespace-nowrap">{d.badge}</span>}
            <VisibilityChip visible={d.tenantVisible} />
          </div>
          <div className="text-xs text-neutral-400 truncate">
            {fmtDate(d.at)}
            {d.tenant ? " · " + d.tenant : ""}
            {d.archived ? ` · deleted${d.archivedBy ? " by " + d.archivedBy : ""}` : ""}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <TextLink tone="brand" size="xs" onClick={() => view(d)} className="flex items-center gap-1">
          <span className="material-icons-outlined text-sm">open_in_new</span>
          {busyId === d.key ? "Opening…" : "View"}
        </TextLink>
        <TextLink tone="positive" size="xs" onClick={async () => {
          const url = await getSignedUrl("documents", d.path, 300);
          if (url) window.open(url, "_blank", "noopener,noreferrer");
          else showToast("That file could not be opened — it may have been moved or removed from storage.", "error");
        }} className="flex items-center gap-1">
          <span className="material-icons-outlined text-sm">download</span>Download
        </TextLink>
        {d.deletable && !d.archived && !isReadOnly && (
          <TextLink tone="danger" size="xs" underline={false} onClick={() => remove(d)}>Delete</TextLink>
        )}
      </div>
    </div>
  );

  return (
    // data-testid so a test can scope to THIS module. The property panel has
    // its own Insurance and Utilities cards, so an unscoped query for a
    // folder named "Insurance" matches the panel's card as well and reports a
    // duplicate folder that does not exist.
    <div className="space-y-3" data-testid="property-documents">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm font-semibold text-neutral-700">
          Documents
          <span className="ml-2 text-xs font-normal text-neutral-400">
            {shown === total ? `${total} file${total === 1 ? "" : "s"}` : `${shown} of ${total}`}
          </span>
        </div>
        {!isReadOnly && (
          <Btn variant="primary" size="sm" onClick={() => onUpload && onUpload()}>
            <span className="material-icons-outlined text-sm">upload</span>Upload
          </Btn>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Input value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search this property's documents…" className="flex-1 min-w-[180px]" />
        <Select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="w-auto">
          <option value="all">All folders</option>
          {/* What this property actually has, not every folder that could
              exist -- a dropdown of empty folders is a dropdown of dead ends. */}
          {presentFolders.map(t => <option key={t} value={t}>{t}</option>)}
        </Select>
        <label className="flex items-center gap-1.5 text-xs text-neutral-500 cursor-pointer whitespace-nowrap">
          <input type="checkbox" className="rounded accent-brand-600"
            checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
          Show deleted
        </label>
      </div>

      {truncated && (
        <div className="bg-warning-50 border border-warning-200 rounded-lg px-3 py-2 text-xs text-warning-800">
          Some documents could not be loaded, so this list is incomplete. Reload the page;
          if it persists the error is in the Admin error log.
        </div>
      )}

      {loading ? (
        <div className="py-8 flex justify-center"><Spinner /></div>
      ) : total === 0 ? (
        <div className="text-center py-8">
          <span className="material-icons-outlined text-4xl text-neutral-300 mb-2">folder_open</span>
          <div className="text-sm text-neutral-400">No documents for this property yet</div>
          {!isReadOnly && (
            <TextLink tone="brand" size="xs" className="mt-3" onClick={() => onUpload && onUpload()}>
              Upload the first one
            </TextLink>
          )}
        </div>
      ) : shown === 0 ? (
        <div className="text-center py-6 text-sm text-neutral-400">
          Nothing matches “{q}”{typeFilter !== "all" ? ` in ${typeFilter}` : ""}.
        </div>
      ) : (
        <div className="space-y-1.5">
          {folders.map(f => {
            // A search is a request to see what matched, so folders open
            // themselves while one is active rather than making the person
            // click through every closed folder to find the hit.
            const isOpen = q.trim() ? true : open.has(f.name);
            return (
              <div key={f.name} className="border border-neutral-200 rounded-lg overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-neutral-50 cursor-pointer hover:bg-neutral-100"
                  onClick={() => toggle(f.name)} role="button" tabIndex={0}
                  onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(f.name); } }}>
                  <div className="flex items-center gap-2">
                    <span className="material-icons-outlined text-sm text-neutral-400">
                      {isOpen ? "expand_more" : "chevron_right"}
                    </span>
                    <span className="material-icons-outlined text-base text-neutral-500">
                      {FOLDER_ICON[f.name] || "folder"}
                    </span>
                    <span className="text-sm font-semibold text-neutral-700">{f.name}</span>
                  </div>
                  <span className="text-xs text-neutral-400 tabular-nums">{f.count}</span>
                </div>
                {isOpen && (
                  <div className="p-1.5 space-y-0.5">
                    {f.subs.map(([tenantName, rows]) => (
                      <div key={tenantName} className="mb-1">
                        <div className="px-3 pt-1.5 pb-1 text-xs font-semibold text-neutral-500 uppercase tracking-wide flex items-center gap-1.5">
                          <span className="material-icons-outlined text-sm">person</span>
                          {tenantName}
                          <span className="font-normal normal-case text-neutral-400">· {rows.length}</span>
                        </div>
                        {rows.map(d => <Row key={d.key} d={d} />)}
                      </div>
                    ))}
                    {f.rows.map(d => <Row key={d.key} d={d} />)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Exported for the tests, which assert the grouping rather than trusting it.
export const _folders = { FOLDER_ORDER, DOC_TYPES };
