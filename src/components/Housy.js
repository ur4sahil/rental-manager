// Housy's review queue: every proposal, and the decision on each one.
//
// This page exists because the model never writes. A proposal sits here
// until a person approves it, and approving is where the write happens --
// which is why the queue shows WHAT WOULD CHANGE, not just a confidence
// score. A model's confidence is not calibrated; "4 of 6 fields, and here
// they are" is something a reviewer can actually check.
import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "../supabase";
import { Btn, Card, PageHeader, TabBar, EmptyState, DataTable, Input, FormField } from "../ui";
import { Spinner } from "./shared";
import { HOUSY, HOUSY_JOB_KINDS, HOUSY_STATUS, proposalCoverage } from "../utils/housy";
import { pmError } from "../utils/errors";
import { logAudit } from "../utils/audit";
import { formatLocalDate } from "../utils/helpers";

const TONE_PILL = {
  warn: "bg-warn-50 text-warn-700", success: "bg-success-50 text-success-700",
  danger: "bg-danger-50 text-danger-700", info: "bg-info-50 text-info-700",
  neutral: "bg-neutral-100 text-neutral-600",
};

export function Housy({ companyId, userProfile, userRole, showToast }) {
  const [tab, setTab] = useState("proposed");
  const [jobs, setJobs] = useState(null);
  const [open, setOpen] = useState(null);   // the proposal being reviewed
  const [edits, setEdits] = useState({});   // reviewer's corrections
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    const q = supabase.from("ai_jobs").select("*").eq("company_id", companyId)
      .order("created_at", { ascending: false }).limit(200);
    const { data, error } = tab === "all" ? await q : await q.eq("status", tab);
    if (error) { pmError("PM-8006", { raw: error, context: "load Housy jobs", silent: true }); setJobs([]); return; }
    setJobs(data || []);
  }, [companyId, tab]);

  useEffect(() => { load(); }, [load]);

  // A proposal's fields, with the reviewer's edits layered on top. The
  // edited value is what gets written -- `output` stays as the model said
  // it, so the two can be compared later.
  const fieldsOf = (job) => {
    const out = job?.output || {};
    return Object.keys(out).filter(k => !k.startsWith("_"))
      .map(k => ({ key: k, proposed: out[k], value: k in edits ? edits[k] : out[k] }));
  };

  async function decide(job, approve) {
    if (busy) return;
    setBusy(true);
    try {
      const fields = fieldsOf(job);
      const applied = Object.fromEntries(fields.map(f => [f.key, f.value === "" ? null : f.value]));
      const patch = {
        status: approve ? "approved" : "rejected",
        reviewed_at: new Date().toISOString(),
        reviewed_by: userProfile?.email || null,
        applied: approve ? applied : null,
      };
      const { error } = await supabase.from("ai_jobs").update(patch)
        .eq("id", job.id).eq("company_id", companyId);
      if (error) { showToast(`Could not record the decision: ${error.message}`, "error"); return; }

      if (approve) {
        const wrote = await applyProposal(job, applied);
        if (!wrote.ok) {
          await supabase.from("ai_jobs").update({ status: "failed", error: wrote.error.slice(0, 500) })
            .eq("id", job.id).eq("company_id", companyId);
          showToast(`Approved, but writing it failed: ${wrote.error}`, "error");
        } else {
          await supabase.from("ai_jobs").update({ status: "done", executed_at: new Date().toISOString() })
            .eq("id", job.id).eq("company_id", companyId);
          showToast(`${HOUSY.name}'s suggestion applied.`, "success");
        }
      } else {
        showToast("Rejected. Nothing was changed.", "success");
      }
      logAudit(approve ? "update" : "delete", "ai_jobs",
        `${approve ? "Approved" : "Rejected"} ${job.kind}`, job.id,
        userProfile?.email, userRole, companyId);
      setOpen(null); setEdits({}); load();
    } finally { setBusy(false); }
  }

  // The write. Deliberately explicit per job kind rather than a generic
  // "insert output into writes-table": a generic writer would happily put
  // whatever the model invented into whatever column matched.
  async function applyProposal(job, applied) {
    if (job.kind === "extract_license") {
      const propertyId = job.input?.property_id;
      if (!propertyId) return { ok: false, error: "no property is attached to this document, so there is nothing to file the license against" };
      if (!applied.expiry_date) return { ok: false, error: "expiry date is required — it is what the renewal reminders count down to" };
      const row = {
        company_id: companyId, property_id: Number(propertyId),
        license_type: applied.license_type || "rental_license",
        license_number: applied.license_number || null,
        jurisdiction: applied.jurisdiction || null,
        issue_date: applied.issue_date || null,
        expiry_date: applied.expiry_date,
        fee_amount: applied.fee_amount ?? null,
        status: "active",
      };
      const { data: found } = await supabase.from("property_licenses").select("id")
        .eq("company_id", companyId).eq("property_id", Number(propertyId))
        .eq("license_type", row.license_type).is("archived_at", null).limit(1);
      const hit = (found || [])[0];
      const { error } = hit
        ? await supabase.from("property_licenses").update(row).eq("id", hit.id).eq("company_id", companyId)
        : await supabase.from("property_licenses").insert([row]);
      return error ? { ok: false, error: error.message } : { ok: true };
    }
    return { ok: false, error: `nothing knows how to apply a "${job.kind}" proposal yet` };
  }

  if (jobs === null) return <Spinner />;

  const counts = { proposed: jobs.filter(j => j.status === "proposed").length };

  return (
    <div className="flex flex-col gap-0">
      <PageHeader title={HOUSY.name} subtitle={`${HOUSY.name} ${HOUSY.tagline}. Nothing is saved until you approve it.`} />

      <TabBar active={tab} onChange={t => { setTab(t); setOpen(null); }} tabs={[
        { id: "proposed", label: "Needs review", count: counts.proposed || null },
        { id: "done", label: "Applied" },
        { id: "rejected", label: "Rejected" },
        { id: "failed", label: "Failed" },
        { id: "all", label: "All" },
      ]} className="mb-4" />

      {jobs.length === 0 ? (
        <EmptyState size="compact" icon={HOUSY.icon}
          title={tab === "proposed" ? `Nothing waiting for you` : `Nothing here`}
          subtitle={tab === "proposed" ? `${HOUSY.name} will queue suggestions here as documents arrive.` : undefined} />
      ) : (
        <DataTable
          columns={[
            { key: "kind", label: "What", render: j => (HOUSY_JOB_KINDS[j.kind]?.label || j.kind) },
            { key: "about", label: "About", className: "text-neutral-600",
              render: j => (HOUSY_JOB_KINDS[j.kind]?.describe?.(j) || j.subject_id || "—") },
            { key: "filled", label: "Fields", align: "right", className: "text-xs",
              render: j => { const c = proposalCoverage(j.output); return c.total ? `${c.filled} of ${c.total}` : "—"; } },
            { key: "status", label: "Status",
              render: j => {
                const s = HOUSY_STATUS[j.status] || { label: j.status, tone: "neutral" };
                return <span className={`text-2xs px-2 py-0.5 rounded-full ${TONE_PILL[s.tone]}`}>{s.label}</span>;
              } },
            { key: "when", label: "When", align: "right", className: "text-2xs text-neutral-400",
              render: j => formatLocalDate(new Date(j.created_at)) },
          ]}
          rows={jobs}
          rowKey={j => j.id}
          onRowClick={j => { setOpen(j); setEdits({}); }}
          empty="Nothing here"
        />
      )}

      {open && (
        <Card className="mt-4">
          <div className="flex items-start justify-between mb-3">
            <div>
              <h3 className="text-lg font-display font-bold text-neutral-800">
                {HOUSY_JOB_KINDS[open.kind]?.label || open.kind}
              </h3>
              <p className="text-xs text-neutral-400">
                From {open.input?.source_name || open.subject_id || "a document"}
                {open.model ? ` · read by ${open.model}` : ""}
                {open.duration_ms ? ` · took ${Math.round(open.duration_ms / 1000)}s` : ""}
              </p>
            </div>
            <Btn variant="slate" size="sm" onClick={() => { setOpen(null); setEdits({}); }}>Close</Btn>
          </div>

          {open.error && (
            <div className="border rounded-xl p-3 bg-danger-50 border-danger-200 text-danger-800 mb-3" role="alert">
              <p className="text-sm">{open.error}</p>
            </div>
          )}

          {open.status === "proposed" ? (<>
            {/* Editable, because the reviewer correcting one field is the
                normal case and should not mean rejecting the whole thing
                and typing it again. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {fieldsOf(open).map(f => (
                <FormField key={f.key} label={f.key.replace(/_/g, " ")}>
                  <Input value={f.value ?? ""} placeholder="— not found —"
                    onChange={e => setEdits(v => ({ ...v, [f.key]: e.target.value }))} />
                  {f.value !== f.proposed && (
                    <p className="text-2xs text-warn-700 mt-1">
                      {HOUSY.name} said: {f.proposed === null || f.proposed === "" ? "nothing" : String(f.proposed)}
                    </p>
                  )}
                </FormField>
              ))}
            </div>
            <p className="text-xs text-neutral-500 mt-3">
              Approving writes this to {HOUSY_JOB_KINDS[open.kind]?.writes || "the record"}. Check the values first —
              {HOUSY.name} copies what it reads and can misread a scan.
            </p>
            <div className="flex justify-end gap-2 mt-3">
              <Btn variant="slate" onClick={() => decide(open, false)} disabled={busy}>Reject</Btn>
              <Btn variant="success-fill" onClick={() => decide(open, true)} disabled={busy}>
                {busy ? "Applying…" : "Approve and apply"}
              </Btn>
            </div>
          </>) : (
            <DataTable
              columns={[
                { key: "field", label: "Field", render: r => r.field.replace(/_/g, " ") },
                { key: "proposed", label: `${HOUSY.name} read`, render: r => String(r.proposed ?? "—") },
                { key: "applied", label: "Saved", render: r => String(r.applied ?? "—") },
              ]}
              rows={Object.keys(open.output || {}).filter(k => !k.startsWith("_")).map(k => ({
                field: k, proposed: open.output?.[k], applied: open.applied?.[k],
              }))}
              rowKey={r => r.field}
              empty="No fields were proposed"
            />
          )}
        </Card>
      )}
    </div>
  );
}

export default Housy;
