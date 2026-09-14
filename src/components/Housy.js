// Housy's review queue: every proposal, and the decision on each one.
//
// This page exists because the model never writes. A proposal sits here
// until a person approves it, and approving is where the write happens --
// which is why the queue shows WHAT WOULD CHANGE, not just a confidence
// score. A model's confidence is not calibrated; "4 of 6 fields, and here
// they are" is something a reviewer can actually check.
import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "../supabase";
import { companyInsert } from "../utils/company";
import { Btn, Card, PageHeader, TabBar, EmptyState, DataTable, Input, FormField } from "../ui";
import { Spinner } from "./shared";
import { HOUSY, HOUSY_JOB_KINDS, HOUSY_STATUS, proposalCoverage } from "../utils/housy";
import { pmError } from "../utils/errors";
import { logAudit } from "../utils/audit";
import { formatLocalDate, escapeFilterValue} from "../utils/helpers";

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
  // Ask-a-question state. Separate from the review queue: asking is
  // synchronous, because retrieval sends a few passages rather than a
  // whole document and the answer comes back in seconds.
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState(null);

  const load = useCallback(async () => {
    if (!companyId) return;
    // The ask tab has no job list behind it.
    if (tab === "ask") { setJobs([]); return; }
    const q = supabase.from("ai_jobs").select("*").eq("company_id", companyId)
      .order("created_at", { ascending: false }).limit(200);
    // "working" is a VIEW over two real statuses, not a status itself --
    // filtering on it directly would silently return nothing.
    const { data, error } =
      tab === "all"     ? await q :
      tab === "working" ? await q.in("status", ["queued", "running"]) :
                          await q.eq("status", tab);
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
    if (job.kind === "abstract_lease") {
      // Every NOT NULL column on leases, checked before anything is
      // written. A lease missing its rent or its dates is not a lease, and
      // a half-written one is worse than none -- rent charges, late fees
      // and renewal reminders all count off these fields.
      const missing = [];
      if (!applied.tenant_name) missing.push("tenant name");
      if (!applied.lease_start) missing.push("start date");
      if (!applied.lease_end) missing.push("end date");
      if (applied.monthly_rent == null || applied.monthly_rent === "") missing.push("monthly rent");
      if (missing.length) {
        return { ok: false, error: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required — fill ${missing.length === 1 ? "it" : "them"} in above and approve again` };
      }
      if (String(applied.lease_end) <= String(applied.lease_start)) {
        return { ok: false, error: "the end date is not after the start date" };
      }

      // Which property. The document's own property wins over the address
      // the model read: the attachment is a fact, the reading is an
      // inference, and they disagree when a lease names the landlord's
      // office address instead of the unit.
      let propertyId = job.input?.property_id ? Number(job.input.property_id) : null;
      let propertyName = null;
      if (propertyId) {
        const { data: p } = await supabase.from("properties")
          .select("id, address, short_name").eq("id", propertyId).eq("company_id", companyId).maybeSingle();
        if (p) propertyName = p.short_name || p.address;
      }
      if (!propertyName && applied.property_address) {
        const { data: matches } = await supabase.from("properties")
          .select("id, address, short_name").eq("company_id", companyId)
          .ilike("address", `%${escapeFilterValue(String(applied.property_address).split(",")[0].trim())}%`)
          .is("archived_at", null).limit(2);
        // Exactly one, or refuse. Two candidates means picking the wrong
        // house, and every charge posted afterwards inherits the mistake.
        if ((matches || []).length === 1) {
          propertyId = matches[0].id;
          propertyName = matches[0].short_name || matches[0].address;
        } else if ((matches || []).length > 1) {
          return { ok: false, error: `"${applied.property_address}" matches more than one of your properties — open the document from the right property instead` };
        }
      }
      if (!propertyName) {
        return { ok: false, error: "could not tell which property this lease is for — attach the document to a property first" };
      }

      // Which tenant. Name-matched, and left unlinked when ambiguous: the
      // column allows a name without an id, and a lease pointed at the
      // wrong tenant leaks one person's terms to another.
      let tenantId = null;
      const { data: tenants } = await supabase.from("tenants")
        .select("id, name").eq("company_id", companyId)
        .ilike("name", escapeFilterValue(String(applied.tenant_name).trim()))
        .is("archived_at", null).limit(2);
      if ((tenants || []).length === 1) tenantId = tenants[0].id;

      // Never quietly create a second lease over a live one.
      const { data: live } = await supabase.from("leases").select("id, start_date, end_date")
        .eq("company_id", companyId).eq("property", propertyName)
        .eq("status", "active").is("archived_at", null).limit(1);
      if ((live || []).length) {
        return { ok: false, error: `${propertyName} already has an active lease (${live[0].start_date} to ${live[0].end_date}). End that one first.` };
      }

      const row = {
        tenant_name: String(applied.tenant_name).trim(),
        tenant_id: tenantId,
        property: propertyName,
        property_id: propertyId,
        start_date: applied.lease_start,
        end_date: applied.lease_end,
        rent_amount: Number(applied.monthly_rent),
        security_deposit: applied.security_deposit == null || applied.security_deposit === "" ? null : Number(applied.security_deposit),
        payment_due_day: applied.rent_due_day == null || applied.rent_due_day === "" ? null : Number(applied.rent_due_day),
        late_fee_amount: applied.late_fee == null || applied.late_fee === "" ? null : Number(applied.late_fee),
        // 'flat', not 'fixed' -- chk_lease_late_fee_type allows only
        // 'flat' or 'percent', and 'fixed' failed every insert carrying a
        // late fee. The model reads a dollar amount, so flat is right.
        late_fee_type: applied.late_fee ? "flat" : null,
        // Draft, not active. Activating a lease is what starts rent
        // charging, and that should be a deliberate act on the Leases page
        // rather than a side effect of approving a reading.
        status: "draft",
        created_by: userProfile?.email || null,
      };
      const { error } = await companyInsert("leases", [row], companyId);
      return error ? { ok: false, error: error.message } : { ok: true };
    }

    return { ok: false, error: `nothing knows how to apply a "${job.kind}" proposal yet` };
  }

  async function ask(e) {
    e?.preventDefault?.();
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setAnswer(null);
    try {
      // Data first: "which properties are behind on rent" is answerable
      // exactly, from a reviewed query, and no amount of document search
      // would find it. Only if nothing in the catalogue fits does this
      // fall through to reading the documents.
      const dataRes = await fetch("/api/ai?action=ask-data", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, question: q }),
      });
      const dataBody = await dataRes.json().catch(() => ({}));
      if (dataRes.ok && dataBody?.answered) { setAnswer({ ...dataBody, kind: "data" }); return; }

      const res = await fetch("/api/ai?action=ask", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, question: q }),
      });
      const body = await res.json();
      if (!res.ok) { showToast(body?.error || `Could not ask: HTTP ${res.status}`, "error"); return; }
      // Carry the catalogue across so a question that matched neither can
      // say what it COULD have answered.
      setAnswer({ ...body, kind: "document", available: dataBody?.available });
    } catch (err) {
      pmError("PM-8006", { raw: err, context: "ask Housy a question" });
    } finally {
      setAsking(false);
    }
  }

  if (jobs === null) return <Spinner />;

  const counts = {
    proposed: jobs.filter(j => j.status === "proposed").length,
    working: jobs.filter(j => j.status === "queued" || j.status === "running").length,
  };

  return (
    <div className="flex flex-col gap-0">
      <PageHeader title={HOUSY.menuLabel} subtitle={`${HOUSY.name} ${HOUSY.tagline}. Nothing is saved until you approve it.`} />

      <TabBar active={tab} onChange={t => { setTab(t); setOpen(null); }} tabs={[
        { id: "ask", label: "Ask" },
        { id: "proposed", label: "Needs review", count: counts.proposed || null },
        { id: "working", label: "In progress", count: counts.working || null },
        { id: "done", label: "Applied" },
        { id: "rejected", label: "Rejected" },
        { id: "failed", label: "Failed" },
        { id: "all", label: "All" },
      ]} className="mb-4" />

      {tab === "ask" ? (
        <Card>
          <form onSubmit={ask} className="flex gap-2 items-end">
            <FormField label={`Ask ${HOUSY.name} about your documents`} className="flex-1">
              <Input value={question} onChange={e => setQuestion(e.target.value)}
                placeholder="Does the lease at 100 Oak Street allow pets?" />
            </FormField>
            <Btn type="submit" variant="primary" disabled={asking || !question.trim()}>
              {asking ? "Reading…" : "Ask"}
            </Btn>
          </form>
          <p className="text-2xs text-neutral-400 mt-2">
            {HOUSY.name} answers only from documents it has read. Ask it to read one from
            the Documents page first.
          </p>

          {answer?.kind === "data" ? (
            <div className="mt-4 border-t border-neutral-200 pt-4">
              <p className="text-xs text-neutral-400 mb-2">{answer.question}</p>
              {answer.count === 0 ? (
                <p className="text-sm text-neutral-500">
                  Nothing matched.
                  {/* Never let an empty result read as an all-clear: it is
                      indistinguishable from having no records loaded. */}
                  <span className="block text-2xs text-neutral-400 mt-1">{answer.empty_means}</span>
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="text-sm w-full">
                    <thead>
                      <tr className="text-2xs uppercase tracking-wide text-neutral-400">
                        {Object.keys(answer.rows[0]).map(k => (
                          <th key={k} className="text-left font-medium pb-1 pr-4">{k.replace(/_/g, " ")}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {answer.rows.slice(0, 50).map((r, i) => (
                        <tr key={i} className="border-t border-neutral-100">
                          {Object.values(r).map((v, j) => (
                            <td key={j} className="py-1 pr-4 tabular-nums text-neutral-700">
                              {v === null ? "—" : String(v)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {answer.count > 50 && (
                    <p className="text-2xs text-neutral-400 mt-2">showing 50 of {answer.count}</p>
                  )}
                </div>
              )}
            </div>
          ) : answer && (
            <div className="mt-4 border-t border-neutral-200 pt-4">
              {answer.answer == null || answer.found === false ? (
                <div className="text-sm text-neutral-500">
                  <p>{answer.answer || answer.reason || "Nothing in your documents answers that."}</p>
                  {answer.available?.length > 0 && (
                    <div className="mt-2 text-2xs text-neutral-400">
                      <p className="mb-1">Things I can answer from your data:</p>
                      <ul className="list-disc ml-4 space-y-0.5">
                        {answer.available.slice(0, 6).map((a, i) => <li key={i}>{a}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <p className="text-sm text-neutral-800 whitespace-pre-wrap">{answer.answer}</p>
                  {/* The quote is the point: it is what lets a reader check
                      the answer against the document instead of trusting it. */}
                  {answer.quote && (
                    <blockquote className="mt-3 text-xs text-neutral-600 border-l-2 border-brand-300 pl-3 italic">
                      “{answer.quote}”
                    </blockquote>
                  )}
                  {(answer.chunks || []).length > 0 && (
                    <p className="text-2xs text-neutral-400 mt-3">
                      From {answer.chunks[Math.max(0, (answer.passage || 1) - 1)]?.source_name
                            || answer.chunks[0]?.source_name || "your documents"}
                      {answer.durationMs ? ` · ${Math.round(answer.durationMs / 1000)}s` : ""}
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </Card>
      ) : jobs.length === 0 ? (
        <EmptyState size="compact" icon={HOUSY.icon}
          title={tab === "proposed" ? `Nothing waiting for you`
               : tab === "working"  ? `Nothing in progress`
               : `Nothing here`}
          subtitle={tab === "proposed" ? `${HOUSY.name} will queue suggestions here as documents arrive.`
                  : tab === "working"  ? `Documents ${HOUSY.name} is still reading appear here until a proposal is ready.`
                  : undefined} />
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
