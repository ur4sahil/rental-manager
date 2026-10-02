import React, { useState, useEffect } from "react";
import { Btn, Alert } from "../ui";
import { formatCurrency, fmtDate, formatLocalDate, propertyLabel, safeNum } from "../utils/helpers";
import { planTenancyCharges, describeTenancyCharges, defaultTenancyMode, runningBillFrom, describeRunningTenancy } from "../utils/onboardingRules";
import { startTenancyBooks, tenantLedgerFacts } from "../utils/tenantOnboarding";
import { Modal } from "./shared";

// ============ START BILLING ============
// Shown right after a tenant is added on the Tenants page, the property form
// or Leases "Create lease". It replaces the old "Set Up Recurring Rent"
// pop-up, which could be closed and then left the tenant with no rent
// schedule at all, and which never charged the first month.
//
// It says what will be posted before anything is, and asks the one question
// only a person can answer: is this a move-in, or someone who already lives
// there and is only now being entered? Everything is then posted by the same
// engine Prospects uses (startTenancyBooks).
//
//   entry = { tenantId, tenantName, property, rent, deposit, leaseStart, leaseEnd }

const OPTION = "w-full text-left rounded-xl border p-3 transition-colors disabled:opacity-50 ";
const STEP_ICON = { done: "check_circle", already: "check_circle", skipped: "remove_circle_outline", failed: "error", locked: "lock" };
const STEP_TONE = { done: "text-positive-600", already: "text-positive-600", skipped: "text-neutral-300", failed: "text-danger-600", locked: "text-warn-600" };
const STEP_NOTE = { already: "already there", skipped: "not needed", locked: "books closed" };

export function StartTenancyModal({ entry, companyId, userEmail = "", showToast, onComplete }) {
  const today = formatLocalDate(new Date());
  const [facts, setFacts] = useState(null);     // tenantLedgerFacts, once read
  const [mode, setMode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);   // startTenancyBooks' answer

  useEffect(() => {
    let alive = true;
    (async () => {
      const f = await tenantLedgerFacts({ companyId, tenantId: entry.tenantId, tenantName: entry.tenantName, leaseStart: entry.leaseStart, today });
      if (!alive) return;
      setFacts(f);
      setMode(defaultTenancyMode({ leaseStart: entry.leaseStart, today, continuing: f.continuing }));
    })();
    return () => { alive = false; };
    // The tenant this dialog is for does not change while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, entry.tenantId]);

  const rent = safeNum(entry.rent), deposit = safeNum(entry.deposit);
  const plan = planTenancyCharges({ leaseStart: entry.leaseStart, rent, deposit, today });
  const billFrom = runningBillFrom({ today, chargedThisMonth: !!facts?.chargedThisMonth });
  const newLines = plan.ok ? describeTenancyCharges(plan, formatCurrency, fmtDate) : [];
  const runningLines = describeRunningTenancy({ monthly: rent, billFrom }, formatCurrency, fmtDate);
  const hasSchedule = !!facts?.schedule;
  const canNew = plan.ok && !facts?.continuing;

  async function run() {
    if (busy || !mode) return;
    setBusy(true);
    const res = await startTenancyBooks({
      companyId, tenantId: entry.tenantId, tenantName: entry.tenantName, property: entry.property,
      leaseStart: entry.leaseStart, rent, deposit, userEmail, today, mode, billFrom,
    });
    setBusy(false);
    setResult(res);
    if (res.ok) {
      showToast(res.mode === "new"
        ? entry.tenantName + ": deposit, first month's rent and the monthly schedule are set up."
        : entry.tenantName + ": monthly rent is set up from " + fmtDate(billFrom) + ".", "success");
      onComplete(res);
    }
  }

  const close = () => { if (!busy) onComplete(result); };

  return (
    <Modal title={"Start billing " + entry.tenantName} onClose={close}>
      <p className="text-sm text-neutral-500 mb-3">
        {propertyLabel(entry.property)} · {formatCurrency(rent)} a month
        {entry.leaseStart ? <> · lease {fmtDate(entry.leaseStart)}{entry.leaseEnd ? " – " + fmtDate(entry.leaseEnd) : ""}</> : null}
      </p>

      {!facts ? (
        <p className="text-sm text-neutral-400 py-6 text-center">Checking the tenant's ledger…</p>
      ) : !facts.ok ? (
        <Alert tone="danger" className="mb-3">Billing could not be set up: {facts.error}. Close this and try again from the Recurring rent page.</Alert>
      ) : result && !result.ok ? (
        <>
          <Alert tone="warn" className="mb-3" title="Not everything was posted">Nothing is charged twice if you try again.</Alert>
          <ul className="text-sm space-y-1.5 mb-4">
            {result.steps.map(s => (
              <li key={s.key} className="flex gap-2 items-start">
                <span className={"material-icons-outlined text-base " + (STEP_TONE[s.status] || "text-neutral-300")}>{STEP_ICON[s.status] || "radio_button_unchecked"}</span>
                <span className="text-neutral-700">{s.label}{(s.detail || STEP_NOTE[s.status]) ? <span className="text-neutral-400"> · {s.detail || STEP_NOTE[s.status]}</span> : null}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          {facts.continuing && (
            <Alert tone="info" className="mb-3">{entry.tenantName}'s ledger already has charges from before {fmtDate(entry.leaseStart)}, so this lease is a renewal: no deposit or first-month charge is posted.</Alert>
          )}
          {hasSchedule && (
            <Alert tone="info" className="mb-3">{entry.tenantName} already has a rent schedule ({formatCurrency(facts.schedule.amount)} a month, next {fmtDate(facts.schedule.next_post_date)}). It is kept as it is.</Alert>
          )}
          <div className="space-y-2 mb-3" role="radiogroup" aria-label="What kind of tenancy is this">
            <button type="button" role="radio" aria-checked={mode === "new"} disabled={!canNew || busy} onClick={() => setMode("new")}
              className={OPTION + (mode === "new" ? "border-brand-500 bg-brand-50" : "border-neutral-200 bg-white hover:bg-neutral-50")}>
              <span className="block text-sm font-semibold text-neutral-800">Moving in: charge the deposit and rent from the lease start</span>
              {canNew ? (
                <ul className="mt-1.5 space-y-0.5">
                  {(hasSchedule ? newLines.slice(0, -1) : newLines).map((line, i) => <li key={i} className="text-xs text-neutral-600">{line}</li>)}
                </ul>
              ) : <span className="block text-xs text-neutral-400 mt-1">{facts.continuing ? "Not available for a renewal." : plan.error}</span>}
            </button>
            <button type="button" role="radio" aria-checked={mode === "running"} disabled={busy} onClick={() => setMode("running")}
              className={OPTION + (mode === "running" ? "border-brand-500 bg-brand-50" : "border-neutral-200 bg-white hover:bg-neutral-50")}>
              <span className="block text-sm font-semibold text-neutral-800">Already lives there: just bill the monthly rent</span>
              <ul className="mt-1.5 space-y-0.5">
                {(hasSchedule ? runningLines.slice(1) : runningLines).map((line, i) => <li key={i} className="text-xs text-neutral-600">{line}</li>)}
              </ul>
            </button>
          </div>
          <p className="text-xs text-neutral-400 mb-4">The amount and day can be changed later on the Recurring rent page. If you close this without starting, {entry.tenantName} is not billed and is listed there under "Not being billed".</p>
        </>
      )}

      <div className="flex gap-2">
        {facts?.ok && <Btn onClick={run} disabled={busy || !mode}>{busy ? "Setting up…" : result && !result.ok ? "Try again" : "Start billing"}</Btn>}
        <Btn variant="secondary" onClick={close} disabled={busy}>{result && !result.ok ? "Close" : "Not now"}</Btn>
      </div>
    </Modal>
  );
}
