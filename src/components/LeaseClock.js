import React, { useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "../supabase";
import { TextLink } from "../ui";
import { fmtDate } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { resendSignatureRequest, summarizeSends } from "../utils/docService";
import { CLOCK_KINDS, SEVERITY_LABEL, clockAction, clockSummary, clockPage, clockKindsPresent } from "../utils/leaseClockRules";

// ============ NEEDS ATTENTION ============
// Dates used to be stored and never acted on: a lease reached its end with
// nobody told, a document sat unsigned for weeks, a signed applicant's start
// date came and went. This card is the list of those things, today. It
// stores nothing: the database works it out each time (lease_clock_items),
// so a line disappears by itself once the thing is done. The same list
// drives the morning email (api/_lease-clock-impl.js).

const SEVERITY_TONE = { overdue: "text-danger-600", high: "text-warn-700", normal: "text-neutral-500" };
const SEVERITY_DOT = { overdue: "bg-danger-500", high: "bg-warn-500", normal: "bg-neutral-300" };

export function NeedsAttentionCard({ companyId, setPage, showToast, userEmail = "" }) {
  const [items, setItems] = useState(null);
  const [failed, setFailed] = useState(false);
  const [kind, setKind] = useState("all");
  const [expanded, setExpanded] = useState(false);
  const [busyKey, setBusyKey] = useState("");

  const load = useCallback(async () => {
    if (!companyId) return;
    const { data, error } = await supabase.rpc("lease_clock_items", { p_company_id: companyId });
    if (error) {
      // A database that predates this feature has no such function: show
      // nothing rather than an error on the dashboard.
      pmError("PM-8006", { raw: error, context: "load needs-attention list", silent: true });
      setFailed(true); setItems([]);
      return;
    }
    setFailed(false); setItems(data || []);
  }, [companyId]);
  useEffect(() => { load(); }, [load]);

  const kinds = useMemo(() => clockKindsPresent(items || []), [items]);
  const page = useMemo(() => clockPage(items || [], { kind, expanded }), [items, kind, expanded]);
  // A filter whose last line was dismissed falls back to everything.
  useEffect(() => { if (kind !== "all" && !kinds.some(k => k.kind === kind)) setKind("all"); }, [kind, kinds]);

  async function dismiss(item) {
    setBusyKey(item.item_key);
    const { error } = await supabase.from("lease_clock_dismissed").insert([{ company_id: companyId, item_key: item.item_key, dismissed_by: userEmail || null }]);
    setBusyKey("");
    // 23505: someone else dismissed it a moment ago. Same result.
    if (error && error.code !== "23505") { pmError("PM-8006", { raw: error, context: "dismiss needs-attention item" }); return; }
    setItems(list => (list || []).filter(i => i.item_key !== item.item_key));
  }

  async function remind(item) {
    setBusyKey(item.item_key);
    try {
      const { data: sigs, error } = await supabase.from("doc_signatures").select("id, signer_name, signer_email, status")
        .eq("company_id", companyId).eq("doc_id", item.doc_id).in("status", ["sent", "viewed"]);
      if (error) { pmError("PM-8006", { raw: error, context: "load signers to remind" }); return; }
      if (!(sigs || []).length) { showToast("Nobody is waiting to sign this right now.", "info"); load(); return; }
      const results = [];
      for (const sig of sigs) {
        const r = await resendSignatureRequest(companyId, sig.id);
        results.push({ status: r.ok ? r.status : "failed", email: sig.signer_email, delivered_to: r.delivered_to, error: r.error });
      }
      const sum = summarizeSends(results);
      showToast("Reminder: " + sum.text, sum.tone);
      load();
    } finally { setBusyKey(""); }
  }

  if (items === null || failed || items.length === 0) return null;

  return (
    <div className="bg-white rounded-xl border border-neutral-200 shadow-card p-4 mb-4" data-testid="needs-attention">
      <h3 className="font-semibold text-neutral-800 mb-1 flex items-center justify-between gap-2">
        <span><span className="material-icons-outlined text-sm align-middle mr-1">notifications_active</span>Needs attention <span className="text-neutral-400 font-normal">({items.length})</span></span>
        <span className="text-xs font-normal text-neutral-500">{clockSummary(items)}</span>
      </h3>
      {kinds.length > 1 && (
        <div className="flex gap-1.5 flex-wrap mb-2 mt-2">
          {[{ kind: "all", label: "All", count: items.length }, ...kinds].map(k => (
            <button key={k.kind} type="button" onClick={() => { setKind(k.kind); setExpanded(false); }}
              className={"text-xs rounded-full px-2.5 py-1 border transition-colors " + (kind === k.kind ? "border-brand-500 bg-brand-50 text-brand-700" : "border-neutral-200 text-neutral-600 hover:bg-neutral-50")}>
              {k.label} · {k.count}
            </button>
          ))}
        </div>
      )}
      <div>
        {page.shown.map(item => {
          const meta = CLOCK_KINDS[item.kind] || { label: "Other", icon: "info" };
          const action = clockAction(item);
          const busy = busyKey === item.item_key;
          return (
            <div key={item.item_key} className="flex items-start gap-3 py-2.5 border-b border-neutral-100 last:border-0" data-testid="clock-item" data-kind={item.kind}>
              <span className={"mt-1.5 w-2 h-2 rounded-full shrink-0 " + (SEVERITY_DOT[item.severity] || SEVERITY_DOT.normal)} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-neutral-800 break-words">{item.title}</div>
                <div className="text-xs text-neutral-600 mt-0.5 break-words">{item.detail}</div>
                <div className="text-xs mt-1 flex gap-3 flex-wrap items-center">
                  <span className={SEVERITY_TONE[item.severity] || SEVERITY_TONE.normal}>{meta.label} · {SEVERITY_LABEL[item.severity] || ""}{item.due_date ? " · " + fmtDate(item.due_date) : ""}</span>
                  {action && setPage && <TextLink tone="brand" size="xs" onClick={() => setPage(action.page, action.action)}>{action.label}</TextLink>}
                  {item.kind === "unsigned_doc" && item.doc_id && <TextLink tone="brand" size="xs" onClick={() => { if (!busy) remind(item); }}>{busy ? "Sending…" : "Send a reminder"}</TextLink>}
                  <TextLink tone="neutral" size="xs" onClick={() => { if (!busy) dismiss(item); }}>Dismiss</TextLink>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {(page.hidden > 0 || expanded) && page.total > 6 && (
        <div className="text-xs text-neutral-500 text-center pt-2">
          <TextLink tone="brand" size="xs" onClick={() => setExpanded(e => !e)}>{expanded ? "Show fewer" : "Show all " + page.total}</TextLink>
        </div>
      )}
    </div>
  );
}
