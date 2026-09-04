// ============ BULK PROPERTY IMPORT ============
//
// Download a workbook pre-filled with what you already have, fill the
// gaps, upload it back. Nothing is written until the preview has shown
// exactly what will change -- in particular every address change, because
// the accounting class is named after the address and renaming it moves
// years of ledger history.
//
// No journal entries are ever posted here. The books are left exactly as
// the QuickBooks import left them.

import React, { useState, useMemo } from "react";
import ExcelJS from "exceljs";
import { supabase } from "../supabase";
import { Btn, FileInput, TextLink } from "../ui";
import { Spinner } from "./shared";
import { pmError } from "../utils/errors";
import { logAudit } from "../utils/audit";
import { guardSubmit, guardRelease } from "../utils/guards";
import {
  PROPERTY_COLUMNS, TENANT_COLUMNS, SHEET_PROPERTIES, SHEET_TENANTS,
  buildTemplate, parseWorkbook, buildImportPlan, inferTenantStatus, computeAddress,
} from "../utils/propertyImport";

const STEPS = [
  { id: "download", label: "Download" },
  { id: "upload",   label: "Upload" },
  { id: "preview",  label: "Review" },
  { id: "done",     label: "Done" },
];

export default function PropertyImport({ companyId, companyName, properties = [], showToast, onImported }) {
  const [step, setStep] = useState("download");
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState(null);
  const [plan, setPlan] = useState(null);
  const [existing, setExisting] = useState(null);
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState(null);

  // Everything the template needs, and the same snapshot the plan is
  // validated against -- so what you download and what you upload against
  // cannot drift apart mid-session.
  async function loadExisting() {
    const [{ data: props }, { data: tens }, { data: owners }, { data: accts }] = await Promise.all([
      supabase.from("properties").select("id,address,address_line_1,address_line_2,city,state,zip,county,short_name,type,status,bedrooms,bathrooms,sqft,owner_name,rent,security_deposit,notes")
        .eq("company_id", companyId).is("archived_at", null).order("address"),
      supabase.from("tenants").select("id,name,property,email,phone,move_in,move_out,lease_start,lease_end_date,rent,balance,is_voucher,voucher_number,tenant_portion,voucher_portion,lease_status")
        .eq("company_id", companyId).is("archived_at", null).order("name"),
      supabase.from("owners").select("name").eq("company_id", companyId).is("archived_at", null),
      supabase.from("acct_accounts").select("id,tenant_id").eq("company_id", companyId).not("tenant_id", "is", null),
    ]);

    // Ledger recency per tenant. This is what decides Current vs Past --
    // balance looks like a clean signal on this data but is a coincidence
    // of it: someone paid up in full looks identical to someone who left.
    const arByTenant = new Map((accts || []).map(a => [String(a.tenant_id), a.id]));
    const accountIds = (accts || []).map(a => a.id);
    const activity = new Map();
    for (let i = 0; i < accountIds.length; i += 100) {
      const chunk = accountIds.slice(i, i + 100);
      const { data: lines } = await supabase
        .from("acct_journal_lines")
        .select("account_id, acct_journal_entries!inner(date)")
        .eq("company_id", companyId).in("account_id", chunk);
      for (const l of lines || []) {
        const d = l.acct_journal_entries?.date;
        const cur = activity.get(l.account_id) || { last: null, n: 0 };
        cur.n += 1;
        if (!cur.last || (d && d > cur.last)) cur.last = d;
        activity.set(l.account_id, cur);
      }
    }

    const tenantRows = (tens || []).map(t => {
      const arId = arByTenant.get(String(t.id)) || null;
      const act = arId ? activity.get(arId) : null;
      const enriched = {
        ...t, arAccountId: arId,
        lastActivity: act?.last || null, ledgerLines: act?.n || 0,
      };
      return {
        ...t,
        tenant_status: inferTenantStatus(enriched),
        is_voucher: t.is_voucher ? "Yes" : "No",
        _balance: t.balance, _lastActivity: act?.last || null, _ledgerLines: act?.n || 0,
      };
    });

    return {
      properties: (props || []).map(p => ({ ...p, short_name: p.short_name || p.address })),
      tenants: tenantRows,
      owners: [...new Set((owners || []).map(o => o.name).filter(Boolean))],
    };
  }

  async function handleDownload() {
    if (!guardSubmit("propImportDownload")) return;
    setBusy(true);
    try {
      const data = await loadExisting();
      setExisting(data);
      const wb = await buildTemplate(ExcelJS, {
        companyName, properties: data.properties, tenants: data.tenants, owners: data.owners,
      });
      const buf = await wb.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(companyName || "properties").replace(/[^\w-]+/g, "_")}-properties.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      setStep("upload");
    } catch (e) {
      pmError("PM-2010", { raw: e, context: "build property import template" });
    } finally { setBusy(false); guardRelease("propImportDownload"); }
  }

  async function handleFile(file) {
    if (!file) return;
    setBusy(true);
    try {
      // Re-read current state rather than trusting the snapshot taken at
      // download time: the sheet may have been filled in over days.
      const data = existing || await loadExisting();
      setExisting(data);
      const buf = await file.arrayBuffer();
      const p = await parseWorkbook(ExcelJS, buf);
      if (p.fatal.length) { showToast(p.fatal[0], "error"); return; }
      setParsed(p);
      setPlan(buildImportPlan({
        properties: p.properties, tenants: p.tenants,
        existingProperties: data.properties, existingTenants: data.tenants,
      }));
      setStep("preview");
    } catch (e) {
      pmError("PM-2011", { raw: e, context: "parse property import workbook" });
      showToast("Could not read that file. Is it the downloaded template?", "error");
    } finally { setBusy(false); }
  }

  async function handleCommit() {
    if (!guardSubmit("propImportCommit")) return;
    setBusy(true);
    const done = { created: 0, updated: 0, renamed: 0, tenantsCreated: 0, tenantsUpdated: 0, archived: 0, failed: [] };
    const total = plan.creates.length + plan.updates.length + plan.tenantCreates.length + plan.tenantUpdates.length;
    let n = 0;
    const tick = (label) => { n += 1; setProgress({ done: n, total, label }); };

    try {
      // --- new properties, through the wizard's own transactional RPC ---
      for (const c of plan.creates) {
        tick(c.newAddress);
        const r = c.record;
        const { error } = await supabase.rpc("commit_property_wizard", {
          p_payload: {
            company_id: companyId, wizard_id: null, mode: "fresh", property_id_for_edit: null,
            property: {
              address: c.newAddress,
              address_line_1: r.address_line_1, address_line_2: r.address_line_2 || "",
              city: r.city || "", state: r.state || "", zip: r.zip || "", county: r.county || "",
              type: r.type || "Single Family", status: r.status || "vacant", notes: r.notes || "",
            },
            // Tenants come from their own sheet, so the wizard never
            // creates one here -- that would duplicate a row the Tenants
            // sheet is already responsible for.
            // utilities and hoas are iterated with jsonb_array_elements inside
            // the RPC, so they must be arrays -- null makes them scalars and
            // the call fails with "cannot extract elements from a scalar".
            // The object-shaped fields take null quite happily.
            tenant: null, utilities: [], hoas: [], loan: null, insurance: null,
            taxes: null, recurring: null,
          },
        });
        if (error) { done.failed.push({ what: c.newAddress, why: error.message }); continue; }
        done.created += 1;
      }

      // --- existing properties -----------------------------------------
      for (const u of plan.updates) {
        tick(u.newAddress);
        const r = u.record;
        // The address is DERIVED by trigger, so it is changed by writing
        // the component columns and letting the cascade follow -- never by
        // setting `address` directly, which the trigger would overwrite.
        if (u.addressChanged) {
          const { error } = await supabase.rpc("rename_property_from_components", {
            p_company_id: companyId, p_property_id: Number(u.id),
            p_line1: r.address_line_1, p_line2: r.address_line_2 || "",
            p_city: r.city || "", p_state: r.state || "", p_zip: r.zip || "",
          });
          if (error) { done.failed.push({ what: u.newAddress, why: error.message }); continue; }
          done.renamed += 1;
        }
        const patch = {
          county: r.county || null, short_name: r.short_name || null,
          type: r.type || null, status: r.status || null,
          bedrooms: r.bedrooms, bathrooms: r.bathrooms, sqft: r.sqft,
          owner_name: r.owner_name || "", rent: r.rent, security_deposit: r.security_deposit,
          notes: r.notes || "",
        };
        Object.keys(patch).forEach(k => { if (patch[k] === null || patch[k] === undefined) delete patch[k]; });
        if (Object.keys(patch).length) {
          const { error } = await supabase.from("properties").update(patch)
            .eq("id", u.id).eq("company_id", companyId);
          if (error) { done.failed.push({ what: u.newAddress, why: error.message }); continue; }
        }
        done.updated += 1;
      }

      // --- tenants -----------------------------------------------------
      for (const t of plan.tenantUpdates) {
        tick(t.record.name);
        const r = t.record;
        const patch = {
          email: r.email || null, phone: r.phone || null,
          move_in: r.move_in, move_out: r.move_out,
          lease_start: r.lease_start, lease_end_date: r.lease_end_date,
          rent: r.rent,
          is_voucher: /^y/i.test(r.is_voucher || "") ? true : (/^n/i.test(r.is_voucher || "") ? false : null),
          voucher_number: r.voucher_number || null,
          tenant_portion: r.tenant_portion, voucher_portion: r.voucher_portion,
        };
        if (t.status === "Current") patch.lease_status = "current";
        else if (t.status === "Past") patch.lease_status = "past";
        // "Not a tenant" is archived rather than deleted: the rows survive
        // and stay reversible, and their ledger history is untouched.
        if (t.status === "Not a tenant") {
          patch.archived_at = new Date().toISOString();
          patch.archived_by = "property-import";
        }
        Object.keys(patch).forEach(k => { if (patch[k] === null || patch[k] === undefined) delete patch[k]; });
        if (!Object.keys(patch).length) { done.tenantsUpdated += 1; continue; }
        const { error } = await supabase.from("tenants").update(patch)
          .eq("id", t.id).eq("company_id", companyId);
        if (error) { done.failed.push({ what: r.name, why: error.message }); continue; }
        if (t.status === "Not a tenant") done.archived += 1; else done.tenantsUpdated += 1;
      }

      for (const t of plan.tenantCreates) {
        tick(t.record.name);
        const r = t.record;
        const { error } = await supabase.from("tenants").insert([{
          company_id: companyId, name: r.name, property: r.property || "",
          email: r.email || "", phone: r.phone || "",
          move_in: r.move_in, move_out: r.move_out,
          lease_start: r.lease_start, lease_end_date: r.lease_end_date,
          rent: r.rent, balance: 0,
          lease_status: t.status === "Past" ? "past" : "current",
          is_voucher: /^y/i.test(r.is_voucher || ""),
          voucher_number: r.voucher_number || "",
          tenant_portion: r.tenant_portion, voucher_portion: r.voucher_portion,
        }]);
        if (error) { done.failed.push({ what: r.name, why: error.message }); continue; }
        done.tenantsCreated += 1;
      }

      // --- pendencies ---------------------------------------------------
      // Gaps become setup rows the wizard already knows how to surface in
      // Tasks & Approvals, rather than a new parallel mechanism.
      const pend = plan.warnings.filter(w => w.kind === "pendency" && w.sheet === SHEET_PROPERTIES);
      if (pend.length) {
        const wanted = plan.updates
          .filter(u => pend.some(p => p.row === u.row))
          .map(u => ({
            company_id: companyId, property_id: Number(u.id), property_address: u.newAddress,
            current_step: "property_details", completed_steps: ["property_details"],
            status: "in_progress", wizard_data: { source: "bulk_import" },
          }));
        // property_setup_wizard has no unique index on
        // (company_id, property_address) -- only the primary key -- so an
        // upsert naming that conflict target fails with 42P10. Read what
        // exists, insert only the gap.
        const addresses = wanted.map(w => w.property_address);
        const have = new Set();
        for (let i = 0; i < addresses.length; i += 100) {
          const { data } = await supabase.from("property_setup_wizard")
            .select("property_address").eq("company_id", companyId)
            .in("property_address", addresses.slice(i, i + 100));
          (data || []).forEach(r => have.add(r.property_address));
        }
        const rows = wanted.filter(w => !have.has(w.property_address));
        for (let i = 0; i < rows.length; i += 50) {
          const { error } = await supabase.from("property_setup_wizard").insert(rows.slice(i, i + 50));
          if (error) pmError("PM-2013", { raw: error, context: "create import pendencies", silent: true });
        }
      }

      await logAudit("import", "properties",
        `Bulk property import: ${done.created} created, ${done.updated} updated, ${done.renamed} renamed, ` +
        `${done.tenantsCreated} tenants created, ${done.tenantsUpdated} updated, ${done.archived} archived`,
        null, undefined, undefined, companyId);

      setResult(done);
      setStep("done");
      if (typeof onImported === "function") onImported();
    } catch (e) {
      pmError("PM-2012", { raw: e, context: "commit property import" });
      showToast("Import failed. Nothing further was written — see the error log.", "error");
    } finally { setBusy(false); setProgress(null); guardRelease("propImportCommit"); }
  }

  const stepIdx = STEPS.findIndex(s => s.id === step);

  return (
  <div className="space-y-5">
    <div>
      <h3 className="text-lg font-semibold text-neutral-900">Import properties from Excel</h3>
      <p className="text-sm text-neutral-400">
        Set up many properties at once instead of one at a time in the wizard.
      </p>
    </div>

    <div className="flex items-center gap-2">
      {STEPS.map((s, i) => (
        <React.Fragment key={s.id}>
          <div className={`flex items-center gap-1.5 text-xs font-medium ${i <= stepIdx ? "text-brand-700" : "text-neutral-300"}`}>
            <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${i < stepIdx ? "bg-brand-600 text-white" : i === stepIdx ? "bg-brand-100 text-brand-700 ring-2 ring-brand-400" : "bg-neutral-100"}`}>
              {i < stepIdx ? "✓" : i + 1}
            </span>
            {s.label}
          </div>
          {i < STEPS.length - 1 && <div className={`h-px flex-1 ${i < stepIdx ? "bg-brand-400" : "bg-neutral-200"}`} />}
        </React.Fragment>
      ))}
    </div>

    {step === "download" && (
      <div className="rounded-2xl border border-brand-100 bg-brand-50/30 p-5 space-y-3">
        <p className="text-sm text-neutral-700">
          The file comes pre-filled with your <strong>{properties.length} existing properties</strong> and their
          tenants. Fill in the highlighted gaps, add new rows at the bottom, then upload it back.
        </p>
        <ul className="text-xs text-neutral-500 space-y-1 list-disc pl-5">
          <li>Grey columns hold the record IDs — leave them alone.</li>
          <li>Tenant status is pre-filled from ledger activity, with balances shown so you can check it.</li>
          <li>Nothing is posted to your books.</li>
        </ul>
        <Btn variant="primary" icon="download" onClick={handleDownload} disabled={busy}>
          {busy ? "Preparing…" : "Download template"}
        </Btn>
      </div>
    )}

    {step === "upload" && (
      <div className="rounded-2xl border border-brand-100 p-5 space-y-3">
        <p className="text-sm text-neutral-700">Upload the filled-in workbook. You'll see what will change before anything is saved.</p>
        <FileInput accept=".xlsx" onChange={e => handleFile(e.target.files?.[0])} disabled={busy} />
        {busy && <div className="flex items-center gap-2 text-sm text-neutral-500"><Spinner /> Reading…</div>}
        <TextLink tone="neutral" size="xs" onClick={() => setStep("download")}>← Back to download</TextLink>
      </div>
    )}

    {step === "preview" && plan && (
      <PreviewStep plan={plan} busy={busy} progress={progress}
        onBack={() => setStep("upload")} onCommit={handleCommit} />
    )}

    {step === "done" && result && (
      <DoneStep result={result} onAgain={() => { setStep("download"); setParsed(null); setPlan(null); setResult(null); }} />
    )}
  </div>
  );
}

function Stat({ label, value, tone = "neutral" }) {
  const tones = {
    neutral: "text-neutral-800", good: "text-success-700",
    warn: "text-warning-700", bad: "text-danger-600",
  };
  return (
    <div className="rounded-xl border border-neutral-100 px-3 py-2">
      <div className={`text-xl font-semibold ${tones[tone]}`}>{value}</div>
      <div className="text-[11px] text-neutral-500 uppercase tracking-wide">{label}</div>
    </div>
  );
}

function PreviewStep({ plan, busy, progress, onBack, onCommit }) {
  const s = plan.summary;
  const blocked = s.errors > 0 && (s.propertiesToCreate + s.propertiesToUpdate + s.tenantsToCreate + s.tenantsToUpdate) === 0;
  return (
  <div className="space-y-4">
    <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
      <Stat label="New properties" value={s.propertiesToCreate} tone="good" />
      <Stat label="Updated" value={s.propertiesToUpdate} />
      <Stat label="Address changes" value={s.addressChanges} tone={s.addressChanges ? "warn" : "neutral"} />
      <Stat label="New tenants" value={s.tenantsToCreate} tone="good" />
      <Stat label="Tenants updated" value={s.tenantsToUpdate} />
      <Stat label="Problems" value={s.errors} tone={s.errors ? "bad" : "good"} />
    </div>

    {plan.renames.length > 0 && (
      <div className="rounded-2xl border-2 border-warning-300 bg-warning-50/50 p-4">
        <div className="text-sm font-semibold text-warning-800 mb-1">
          {plan.renames.length} address{plan.renames.length === 1 ? "" : "es"} will change
        </div>
        <p className="text-xs text-warning-700 mb-2">
          Each also renames the matching accounting class. Ledger history stays attached — it is linked by
          id, not by name — but the name shown in reports changes. Your Short Name column is what reports display.
        </p>
        <div className="max-h-48 overflow-y-auto rounded-xl bg-white border border-warning-200 divide-y divide-warning-100">
          {plan.renames.map(r => (
            <div key={r.id} className="px-3 py-1.5 text-xs">
              <span className="text-neutral-400">row {r.row}</span>{" "}
              <span className="text-neutral-500 line-through">{r.from}</span>{" "}
              <span className="text-neutral-400">→</span>{" "}
              <span className="text-neutral-800 font-medium">{r.to}</span>
            </div>
          ))}
        </div>
      </div>
    )}

    {plan.errors.length > 0 && (
      <div className="rounded-2xl border-2 border-danger-300 bg-danger-50/50 p-4">
        <div className="text-sm font-semibold text-danger-700 mb-1">
          {plan.errors.length} row{plan.errors.length === 1 ? "" : "s"} will be skipped
        </div>
        <p className="text-xs text-danger-600 mb-2">Everything else still imports. Fix these and upload again — rows already imported are recognised and left alone.</p>
        <div className="max-h-52 overflow-y-auto rounded-xl bg-white border border-danger-200 divide-y divide-danger-100">
          {plan.errors.map((e, i) => (
            <div key={i} className="px-3 py-1.5 text-xs">
              <span className="font-medium text-neutral-700">{e.sheet} row {e.row}</span>
              <span className="text-neutral-400"> · {e.field} · </span>
              <span className="text-danger-700">{e.message}</span>
            </div>
          ))}
        </div>
      </div>
    )}

    {plan.warnings.length > 0 && (
      <details className="rounded-2xl border border-neutral-200 p-4">
        <summary className="text-sm font-medium text-neutral-700 cursor-pointer">
          {plan.warnings.length} item{plan.warnings.length === 1 ? "" : "s"} will need approval
        </summary>
        <p className="text-xs text-neutral-500 mt-1 mb-2">
          These import fine, but the gaps become pending items for a manager or admin in Tasks &amp; Approvals.
        </p>
        <div className="max-h-48 overflow-y-auto text-xs text-neutral-600 divide-y divide-neutral-100">
          {plan.warnings.map((w, i) => <div key={i} className="py-1">{w.message}</div>)}
        </div>
      </details>
    )}

    {progress && (
      <div className="rounded-xl bg-brand-50 border border-brand-100 px-4 py-3">
        <div className="flex justify-between text-xs text-brand-700 mb-1">
          <span>{progress.label}</span><span>{progress.done} of {progress.total}</span>
        </div>
        <div className="h-1.5 bg-brand-100 rounded-full overflow-hidden">
          <div className="h-full bg-brand-600 transition-all" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
        </div>
      </div>
    )}

    <div className="flex justify-between pt-1">
      <Btn variant="slate" onClick={onBack} disabled={busy}>← Upload a different file</Btn>
      <Btn variant="success-fill" onClick={onCommit} disabled={busy || blocked}>
        {busy ? "Importing…" : blocked ? "Nothing to import" : "Import"}
      </Btn>
    </div>
  </div>
  );
}

function DoneStep({ result, onAgain }) {
  return (
  <div className="space-y-4">
    <div className="rounded-2xl border-2 border-success-300 bg-success-50/50 p-5">
      <div className="text-base font-semibold text-success-800 mb-2">Import complete</div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        <Stat label="Properties created" value={result.created} tone="good" />
        <Stat label="Properties updated" value={result.updated} />
        <Stat label="Addresses changed" value={result.renamed} />
        <Stat label="Tenants created" value={result.tenantsCreated} tone="good" />
        <Stat label="Tenants updated" value={result.tenantsUpdated} />
        <Stat label="Archived" value={result.archived} />
      </div>
      <p className="text-xs text-neutral-500 mt-3">No journal entries were posted. Your books are unchanged.</p>
    </div>
    {result.failed.length > 0 && (
      <div className="rounded-2xl border border-danger-200 bg-danger-50/40 p-4">
        <div className="text-sm font-semibold text-danger-700 mb-1">{result.failed.length} row{result.failed.length === 1 ? "" : "s"} failed</div>
        <div className="max-h-40 overflow-y-auto text-xs divide-y divide-danger-100">
          {result.failed.map((f, i) => (
            <div key={i} className="py-1"><span className="font-medium">{f.what}</span> <span className="text-danger-600">— {f.why}</span></div>
          ))}
        </div>
      </div>
    )}
    <Btn variant="ghost" onClick={onAgain}>Import another file</Btn>
  </div>
  );
}
