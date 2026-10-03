import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Btn, Input, FormField, Alert, Select, TextLink } from "../ui";
import { formatLocalDate, fmtDate, formatCurrency, getSignedUrl } from "../utils/helpers";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { CATEGORY_LABEL, CHARGE_CATEGORIES, lateFeesOverCap, manualClaim, money } from "../utils/arrears";
import { DCCV115, DCCV082, DCCV081, NOTICE_METHODS, noticeMethod, dccv115Values, fillDccv115, dccv082Values, fillDccv082, dccv081Values, fillDccv081, districtsFor, dccv082Lines, worksheetPdf, complaintReadiness, cureDeadline, usDate, MILITARY_LABEL } from "../utils/courtForms";
import { loadFtprContext, partiesFrom, claimFrom, saveNotice, saveWorksheet, saveCaseForm, recordFiling, updateCaseFacts, loadCaseDocs } from "../utils/ftprData";
import { Modal, Spinner } from "./shared";

// ============ FAILURE TO PAY RENT (Maryland) ============
// Step 1 is the court's own Notice of Intent (DC-CV-115), filled in from
// the ledger: past-due rent and late fees, each with its period. Step 2,
// only once ten days have passed with rent still owed, is a worksheet for
// the complaint (DC-CV-082), which the court does not allow to be filled
// in online. Neither is signed electronically or emailed by the app.

const KIND_LABEL = { notice_of_intent: "Notice of Intent (DC-CV-115)", ftpr_complaint: "Complaint (DC-CV-082)", late_notice: "Late notice", court_other: "Court form" };

async function openStored(path, showToast) {
  const url = await getSignedUrl("documents", path);
  if (!url) { showToast("That file could not be opened.", "error"); return; }
  window.open(url, "_blank", "noopener,noreferrer");
}

function useFtprContext({ companyId, tenantId, userProfile, activeCompany }) {
  const [ctx, setCtx] = useState(null);
  const [failed, setFailed] = useState("");
  useEffect(() => {
    let live = true;
    setCtx(null); setFailed("");
    loadFtprContext({ companyId, tenantId, userProfile, activeCompany })
      .then(c => { if (!live) return; if (!c.tenant) setFailed("That tenant could not be found."); else if (c.ledgerFailed) setFailed("The tenant's ledger could not be read. Try again."); else setCtx(c); })
      .catch(() => { if (live) setFailed("The tenant's details could not be loaded. Try again."); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, tenantId]);
  return { ctx, failed };
}

// What is owed, with each unpaid charge and what it counts as. A person can
// correct the kind of a charge: imported entries do not always say.
function ClaimTable({ claim, overrides, setOverrides, monthlyRent }) {
  const [showLines, setShowLines] = useState(false);
  const over = lateFeesOverCap(claim.open, monthlyRent);
  return (
    <div>
      <div className="rounded-xl border border-neutral-200 divide-y divide-neutral-100 text-sm">
        <div className="flex justify-between px-3 py-2"><span className="text-neutral-600">Past-due rent{claim.rent.amount > 0 ? <span className="text-xs text-neutral-400"> · {fmtDate(claim.rent.from)} to {fmtDate(claim.rent.to)}</span> : null}</span><span className="font-semibold text-neutral-800" data-testid="claim-rent">{formatCurrency(claim.rent.amount)}</span></div>
        <div className="flex justify-between px-3 py-2"><span className="text-neutral-600">Late fees{claim.lateFees.amount > 0 ? <span className="text-xs text-neutral-400"> · {fmtDate(claim.lateFees.from)} to {fmtDate(claim.lateFees.to)}</span> : null}</span><span className="font-semibold text-neutral-800" data-testid="claim-fees">{formatCurrency(claim.lateFees.amount)}</span></div>
        <div className="flex justify-between px-3 py-2 bg-neutral-50 rounded-b-xl"><span className="font-semibold text-neutral-700">Total on the form</span><span className="font-bold text-neutral-900" data-testid="claim-total">{formatCurrency(claim.total)}</span></div>
      </div>
      {claim.notClaimed.amount > 0 && <p className="text-xs text-neutral-500 mt-2">{formatCurrency(claim.notClaimed.amount)} of other unpaid charges ({claim.notClaimed.count}) is left off: the form covers rent and late fees only, not utilities, other fees or court costs.</p>}
      {claim.voucherTenancy && claim.voucherSide && claim.voucherSide.owedByAuthority > 0 && <p className="text-xs text-neutral-500 mt-2">The housing authority's own share ({formatCurrency(claim.voucherSide.owedByAuthority)} unpaid) is not claimed from the tenant.</p>}
      {over.length > 0 && <Alert tone="warn" className="mt-2">{over.length === 1 ? "A late fee is" : over.length + " late fees are"} more than 5% of the monthly rent ({formatCurrency(over[0].cap)}). Maryland caps a late fee at 5% of the rent due. Check before serving.</Alert>}
      {!claim.manual && claim.open.length > 0 && (
        <div className="mt-2">
          <TextLink tone="brand" size="xs" onClick={() => setShowLines(s => !s)}>{showLines ? "Hide" : "Show"} the {claim.open.length} unpaid charge{claim.open.length === 1 ? "" : "s"}</TextLink>
          {showLines && (
            <div className="mt-2 rounded-xl border border-neutral-200 max-h-56 overflow-y-auto divide-y divide-neutral-100">
              {claim.open.map(c => (
                <div key={c.id + "-" + c.share} className="flex items-center gap-2 px-3 py-1.5 text-xs" data-testid="open-charge">
                  <span className="text-neutral-500 w-20 shrink-0">{fmtDate(c.date)}</span>
                  <span className="flex-1 min-w-0 truncate text-neutral-700" title={c.label}>{c.label || "Charge"}</span>
                  <span className="text-neutral-800 font-medium w-20 text-right shrink-0">{formatCurrency(c.stillOpen)}</span>
                  <select aria-label="What this charge is" className="border border-neutral-200 rounded px-1 py-0.5 text-xs bg-white shrink-0" value={c.category}
                    onChange={e => setOverrides(o => ({ ...o, [c.id]: e.target.value }))}>
                    {CHARGE_CATEGORIES.map(k => <option key={k} value={k}>{CATEGORY_LABEL[k]}</option>)}
                  </select>
                </div>
              ))}
            </div>
          )}
          {Object.keys(overrides).length > 0 && <p className="text-xs text-neutral-400 mt-1">You changed what {Object.keys(overrides).length} charge{Object.keys(overrides).length === 1 ? " counts" : "s count"} as. <TextLink tone="neutral" size="xs" onClick={() => setOverrides({})}>Undo</TextLink></p>}
        </div>
      )}
    </div>
  );
}

// A person's own figures, for a voucher tenancy the ledger cannot split.
function ManualClaimFields({ value, onChange }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="grid grid-cols-3 gap-3 mt-3">
      <FormField label="Tenant's unpaid rent"><Input type="number" min="0" step="0.01" value={value.rent} onChange={set("rent")} /></FormField>
      <FormField label="From"><Input type="date" value={value.rentFrom} onChange={set("rentFrom")} /></FormField>
      <FormField label="To"><Input type="date" value={value.rentTo} onChange={set("rentTo")} /></FormField>
      <FormField label="Late fees"><Input type="number" min="0" step="0.01" value={value.lateFees} onChange={set("lateFees")} /></FormField>
      <FormField label="From"><Input type="date" value={value.feesFrom} onChange={set("feesFrom")} /></FormField>
      <FormField label="To"><Input type="date" value={value.feesTo} onChange={set("feesTo")} /></FormField>
    </div>
  );
}
const EMPTY_MANUAL = { rent: "", rentFrom: "", rentTo: "", lateFees: "", feesFrom: "", feesTo: "" };

// Shared by both dialogs: the claim from the ledger, or a person's figures.
function useClaim(ctx) {
  const [overrides, setOverrides] = useState({});
  const [useManual, setUseManual] = useState(false);
  const [manual, setManual] = useState(EMPTY_MANUAL);
  const fromLedger = useMemo(() => (ctx ? claimFrom(ctx, overrides) : null), [ctx, overrides]);
  const manualResult = useMemo(() => manualClaim(manual), [manual]);
  const blocked = !!fromLedger?.unreliable;
  const claim = useManual ? manualResult.claim : fromLedger;
  return { claim, fromLedger, blocked, overrides, setOverrides, useManual, setUseManual, manual, setManual, manualErrors: useManual ? manualResult.errors : [] };
}

export function FtprNoticeDialog({ tenantId, companyId, activeCompany, userProfile, userRole, showToast, onClose, onDone }) {
  const today = formatLocalDate(new Date());
  const { ctx, failed } = useFtprContext({ companyId, tenantId, userProfile, activeCompany });
  const c = useClaim(ctx);
  const [noticeDate, setNoticeDate] = useState(today);
  const [method, setMethod] = useState("mail");
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const parties = useMemo(() => (ctx ? partiesFrom(ctx) : null), [ctx]);
  const values = useMemo(() => (ctx && c.claim ? dccv115Values({ ...parties, claim: c.claim, noticeDate, method, tenantAskedForElectronic: asked }) : null), [ctx, parties, c.claim, noticeDate, method, asked]);
  const m = noticeMethod(method);
  // DC-CV-115 is a Maryland District Court form. A home in Virginia or DC
  // has its own notice and its own waiting period.
  const state = String(ctx?.property?.state || "").trim().toUpperCase();
  const wrongState = !!state && state !== "MD" && state !== "MARYLAND";
  const problems = [...(c.useManual ? c.manualErrors : []), ...(values ? values.problems : [])].filter((p, i, a) => a.indexOf(p) === i);
  const stop = wrongState || (c.blocked && !c.useManual) || problems.length > 0 || noticeDate > today;

  async function make() {
    if (stop || !guardSubmit("ftprNotice", tenantId)) return;
    try {
      setBusy(true);
      const res = await fetch(DCCV115.file);
      if (!res.ok || !/pdf/i.test(res.headers.get("content-type") || "")) { showToast("The court form could not be loaded. Check your connection and try again.", "error"); return; }
      const PDFLib = await import("pdf-lib");
      let pdfBytes;
      try { pdfBytes = await fillDccv115(PDFLib, await res.arrayBuffer(), values); }
      catch (e) { showToast(e.message || "The court form could not be filled in.", "error"); return; }
      const out = await saveNotice({ companyId, ctx, parties, claim: c.claim, noticeDate, method, pdfBytes, userEmail: userProfile?.email || "" });
      if (out.error && !out.path) { showToast(out.error, "error"); return; }
      if (out.error) showToast(out.error, "warning");
      logAudit("create", "evictions", `Notice of Intent (DC-CV-115) made for ${ctx.tenant.name}: ${formatCurrency(c.claim.total)} claimed, provided ${noticeDate} by ${m.label.toLowerCase()}`, out.caseId || "", userProfile?.email, userRole, companyId);
      setDone({ path: out.path, caseId: out.caseId, deadline: out.deadline || cureDeadline(noticeDate) });
      if (onDone) onDone(out);
    } finally { setBusy(false); guardRelease("ftprNotice", tenantId); }
  }

  const title = "Failure to pay rent — Notice of Intent" + (ctx?.tenant?.name ? " — " + ctx.tenant.name : "");
  if (failed) return <Modal title={title} onClose={onClose}><Alert tone="danger">{failed}</Alert><div className="mt-4"><Btn variant="secondary" onClick={onClose}>Close</Btn></div></Modal>;
  if (!ctx) return <Modal title={title} onClose={onClose}><Spinner /></Modal>;

  if (done) {
    return (
      <Modal title={title} onClose={onClose}>
        <Alert tone="success" title="The notice is ready">Print it, sign it, and provide it to the tenant {m.electronic ? "electronically, keeping proof it was sent" : m.key === "mail" ? "by first-class mail with a certificate of mailing" : "by affixing it to the door"}. Keep a copy.</Alert>
        <p className="text-sm text-neutral-700 mt-3">The tenant has until the end of <strong>{fmtDate(done.deadline)}</strong> to pay {formatCurrency(c.claim.total)}. If the rent is still owed after that, the complaint can be prepared from the case.</p>
        <p className="text-xs text-neutral-400 mt-2">A case has been opened so the deadline is tracked. The tenant's status has not changed: this is not a notice to vacate.</p>
        <div className="flex gap-2 mt-4 flex-wrap">
          <Btn onClick={() => openStored(done.path, showToast)} icon="print">Open the notice (PDF)</Btn>
          <Btn variant="secondary" onClick={onClose}>Done</Btn>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={title} onClose={() => { if (!busy) onClose(); }}>
      <p className="text-xs text-neutral-500 mb-3">{ctx.property?.address || ctx.tenant.property} · This fills in the court's own form, {DCCV115.revision}. It is not a notice of eviction: it tells the tenant what is past due and gives them 10 days to pay.</p>
      {wrongState && <Alert tone="danger" className="mb-3" title="This home is not in Maryland">This is a Maryland District Court form. For a home in {state}, use that state's own notice.</Alert>}
      {ctx.openCase && <Alert tone="info" className="mb-3">{ctx.openCase.notice_served_on ? "A notice was already provided on " + fmtDate(ctx.openCase.notice_served_on) + (["notice", "cure_period"].includes(ctx.openCase.current_stage) ? ". Making another replaces it and restarts the 10 days." : ". The case is already in court; this adds a further notice to it.") : "There is already an open case for this tenant. This notice is added to it."}</Alert>}
      {c.blocked && !c.useManual && <Alert tone="danger" className="mb-3" title="The amount cannot be worked out from the ledger">{c.fromLedger.blockedReason} Enter the tenant's own unpaid share yourself.</Alert>}
      {c.useManual ? <ManualClaimFields value={c.manual} onChange={c.setManual} /> : c.fromLedger && !c.blocked && <ClaimTable claim={c.fromLedger} overrides={c.overrides} setOverrides={c.setOverrides} monthlyRent={parties.fullRent} />}
      <div className="mt-2">
        <TextLink tone="neutral" size="xs" onClick={() => c.setUseManual(v => !v)}>{c.useManual ? "Use the amounts from the ledger" : "Enter the amounts myself"}</TextLink>
      </div>

      <div className="grid grid-cols-2 gap-3 mt-4">
        <FormField label="Notice provided on" required><Input type="date" value={noticeDate} max={today} onChange={e => setNoticeDate(e.target.value)} /></FormField>
        <FormField label="How it is provided" required>
          <Select value={method} onChange={e => { setMethod(e.target.value); setAsked(false); }}>
            {NOTICE_METHODS.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
          </Select>
        </FormField>
      </div>
      {m?.electronic && (
        <label className="flex items-start gap-2 mt-3 text-sm text-neutral-700 cursor-pointer">
          <input type="checkbox" className="mt-0.5" checked={asked} onChange={e => setAsked(e.target.checked)} />
          <span>The tenant asked to receive notices electronically, and I will keep proof that it was sent.</span>
        </label>
      )}
      {problems.length > 0 && !(c.blocked && !c.useManual) && <Alert tone="warn" className="mt-3">{problems.map((p, i) => <div key={i}>{p}</div>)}</Alert>}
      <p className="text-xs text-neutral-400 mt-3">The form is left unsigned for you to sign by hand. {noticeDate && "The tenant may pay until the end of " + fmtDate(cureDeadline(noticeDate)) + "."}</p>
      <div className="flex gap-2 mt-4 flex-wrap">
        <Btn onClick={make} disabled={busy || stop}>{busy ? "Making the notice…" : "Make the notice"}</Btn>
        <Btn variant="ghost" onClick={onClose} disabled={busy}>Cancel</Btn>
      </div>
    </Modal>
  );
}

export function FtprComplaintDialog({ evCase, companyId, activeCompany, userProfile, userRole, showToast, onClose, onDone }) {
  const today = formatLocalDate(new Date());
  const { ctx, failed } = useFtprContext({ companyId, tenantId: evCase.tenant_id, userProfile, activeCompany });
  const c = useClaim(ctx);
  const parties = useMemo(() => (ctx ? partiesFrom(ctx) : null), [ctx]);
  const [f, setF] = useState(null);     // the form's answers; seeded once the context is in
  const [busy, setBusy] = useState("");
  const [done, setDone] = useState(null);
  useEffect(() => {
    if (!parties || f) return;
    const districts = districtsFor(ctx.property?.county, ctx.property?.city);
    const known = DCCV082.districts.includes(evCase.court) ? evCase.court : "";
    setF({
      district: known || districts[0] || "", courtAddress: "",
      licenseStatus: parties.license.number ? "yes" : "yes", licenseNumber: parties.license.number || "", licenseExpires: parties.license.expires || "", licenseReason: "exempt", licenseText: "",
      leadStatus: parties.lead.number ? "affected" : "not_affected", leadCertificate: parties.lead.number || "", leadReason: "exempt",
      moneyJudgment: false, subsidyKind: "s8",
      monthlyRent: String(parties.monthlyRent || ""), dueDay: String(parties.dueDay || 1), perWeek: false, utilityCredits: "",
      future: false, futureAmount: String(parties.monthlyRent || ""), priorJudgments: "", deceased: false,
      military: "", militaryFacts: "", dodVerified: false,
      signerName: userProfile?.name || "", attorneyNumber: "", signerAddress: [parties.landlord.address, parties.landlord.cityStateZip].filter(Boolean).join(", "), signerPhone: parties.landlord.phone || "",
    });
  }, [parties, f, ctx, evCase.court, userProfile]);
  const set = (k) => (e) => setF(v => ({ ...v, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const splitLandlord = parties ? (() => { const m = String(parties.landlord.cityStateZip || "").match(/^(.*?),\s*([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?)$/); return { name: parties.landlord.name, address: parties.landlord.address, city: m ? m[1] : parties.landlord.cityStateZip, state: m ? m[2].toUpperCase() : "", zip: m ? m[3] : "" }; })() : null;
  const premises = ctx ? { address: parties.premises.address, city: ctx.property?.city || "", state: ctx.property?.state || "", zip: ctx.property?.zip || "" } : null;

  const values = useMemo(() => {
    if (!ctx || !c.claim || !f) return null;
    return dccv082Values({
      district: f.district, courtAddress: f.courtAddress, landlord: splitLandlord, tenants: parties.tenants, premises, propertyName: "",
      license: { status: f.licenseStatus, number: f.licenseNumber, expires: f.licenseExpires, reason: f.licenseReason, text: f.licenseText },
      lead: { status: f.leadStatus, certificate: f.leadCertificate, reason: f.leadReason },
      moneyJudgment: f.moneyJudgment, subsidized: parties.voucher, subsidyKind: f.subsidyKind,
      monthlyRent: Number(f.monthlyRent) || 0, dueDay: Number(f.dueDay) || 1, perWeek: f.perWeek, claim: c.claim, utilityCredits: Number(f.utilityCredits) || 0,
      futureRent: f.future ? Number(f.futureAmount) || 0 : 0, priorJudgments: f.priorJudgments, deceased: f.deceased,
      military: f.military, militaryFacts: f.militaryFacts, dodVerified: f.dodVerified,
      notice: { providedOn: evCase.notice_served_on, method: evCase.notice_served_method },
      signer: { name: f.signerName, attorneyNumber: f.attorneyNumber, address: f.signerAddress, phone: f.signerPhone }, signedDate: today,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, c.claim, f, evCase, today]);
  const ready = complaintReadiness({ providedOn: evCase.notice_served_on, today });
  const hard = [];
  if (!ready.ready) hard.push(ready.reason);
  if (c.blocked && !c.useManual) hard.push("The amount cannot be worked out from the ledger. Enter the tenant's own unpaid share yourself.");
  if (c.useManual) hard.push(...c.manualErrors);
  if (c.claim && !(money(c.claim.rent.amount) > 0)) hard.push("No rent is past due any more. If the tenant paid, close the case as paid.");
  const problems = [...hard, ...(values ? values.problems : [])].filter((p, i, a) => a.indexOf(p) === i);

  async function makeForm() {
    if (problems.length || !values || !guardSubmit("ftprWorksheet", evCase.id)) return;
    try {
      setBusy("form");
      const res = await fetch(DCCV082.file);
      if (!res.ok || !/pdf/i.test(res.headers.get("content-type") || "")) { showToast("The court form could not be loaded. Check your connection and try again.", "error"); return; }
      const PDFLib = await import("pdf-lib");
      let pdfBytes;
      try { pdfBytes = await fillDccv082(PDFLib, await res.arrayBuffer(), values); }
      catch (e) { showToast(e.message || "The court form could not be filled in.", "error"); return; }
      const answers = { ...f, total: values.total, subtotal: values.subtotal };
      const out = await saveWorksheet({ companyId, ctx, evCase, claim: c.claim, total: values.total, answers, pdfBytes, userEmail: userProfile?.email || "" });
      if (out.error && !out.path) { showToast(out.error, "error"); return; }
      if (out.error) showToast(out.error, "warning");
      logAudit("create", "evictions", `Complaint (DC-CV-082) filled in for ${evCase.tenant_name}: ${formatCurrency(values.total)}`, evCase.id, userProfile?.email, userRole, companyId);
      setDone({ path: out.path, total: values.total, kind: "form" });
      if (onDone) onDone(out);
    } finally { setBusy(""); guardRelease("ftprWorksheet", evCase.id); }
  }
  async function makeWorksheet() {
    if (!ctx || !c.claim || !guardSubmit("ftprWorksheet", evCase.id)) return;
    try {
      setBusy("sheet");
      const PDFLib = await import("pdf-lib");
      const sheet = dccv082Lines({
        ...parties, court: f.district ? "District Court of Maryland for " + f.district : (evCase.court || parties.court),
        license: { number: f.licenseStatus === "yes" ? f.licenseNumber : "", expires: f.licenseExpires, exemptReason: f.licenseStatus === "no" ? "not required to be licensed" : f.licenseStatus === "unlicensed" ? (f.licenseText || f.licenseReason) : "" },
        lead: { number: f.leadStatus === "affected" ? f.leadCertificate : "", notAffected: f.leadStatus !== "affected" },
        subsidized: parties.voucher, subsidyKind: parties.voucher ? "housing voucher" : "", claim: c.claim, monthlyRent: Number(f.monthlyRent) || 0, dueDay: Number(f.dueDay) || 1,
        futureRent: f.future ? Number(f.futureAmount) || 0 : 0, notice: { providedOn: evCase.notice_served_on, method: evCase.notice_served_method, today },
        military: f.military, priorJudgments: f.priorJudgments, signer: { name: f.signerName, address: f.signerAddress, phone: f.signerPhone, email: userProfile?.email || "" },
      });
      const pdfBytes = await worksheetPdf(PDFLib, {
        title: "Failure to Pay Rent complaint (DC-CV-082): worksheet for the paper form",
        subtitle: (ctx.tenant?.name || evCase.tenant_name) + " · " + (ctx.property?.address || evCase.property) + " · prepared " + usDate(today),
        lines: sheet.lines, warnings: sheet.problems,
        footer: "For filing at the counter, the District Court requires its own carbonless multi-part DC-CV-082. Copy each answer onto that form, sign it under the penalties of perjury, and attach the Notice of Intent with its proof of mailing or delivery. Amounts are from the tenant's ledger on " + usDate(today) + ": rent and late fees only, payments applied to the oldest charge first.",
      });
      const out = await saveWorksheet({ companyId, ctx, evCase, claim: c.claim, total: sheet.total, answers: { ...f }, pdfBytes, userEmail: userProfile?.email || "", worksheet: true });
      if (out.error && !out.path) { showToast(out.error, "error"); return; }
      logAudit("create", "evictions", `Complaint worksheet (DC-CV-082) made for ${evCase.tenant_name}: ${formatCurrency(sheet.total)}`, evCase.id, userProfile?.email, userRole, companyId);
      setDone({ path: out.path, total: sheet.total, kind: "sheet" });
      if (onDone) onDone(out);
    } finally { setBusy(""); guardRelease("ftprWorksheet", evCase.id); }
  }

  const title = "Failure to pay rent — the complaint — " + evCase.tenant_name;
  if (failed) return <Modal title={title} onClose={onClose}><Alert tone="danger">{failed}</Alert><div className="mt-4"><Btn variant="secondary" onClick={onClose}>Close</Btn></div></Modal>;
  if (!ctx || !f) return <Modal title={title} onClose={onClose}><Spinner /></Modal>;
  if (done) {
    return (
      <Modal title={title} onClose={onClose}>
        <Alert tone="success" title={done.kind === "form" ? "The complaint is filled in" : "The worksheet is ready"}>
          {done.kind === "form" ? "Check every page, sign it, and file it through Maryland's e-filing (MDEC) with the Notice of Intent and its proof of delivery attached. Then record the filing date and case number on the case." : "Copy each answer onto the court's paper DC-CV-082 at the counter. Then record the filing date and case number on the case."}
        </Alert>
        <div className="flex gap-2 mt-4 flex-wrap">
          <Btn onClick={() => openStored(done.path, showToast)} icon="print">Open the PDF</Btn>
          <Btn variant="secondary" onClick={onClose}>Done</Btn>
        </div>
      </Modal>
    );
  }
  const districts = districtsFor(ctx.property?.county, ctx.property?.city);
  const Radio = ({ k, v, label }) => <label className="flex items-center gap-2 text-sm text-neutral-700 cursor-pointer"><input type="radio" name={k} checked={f[k] === v} onChange={() => setF(x => ({ ...x, [k]: v }))} />{label}</label>;
  return (
    <Modal title={title} onClose={() => { if (!busy) onClose(); }}>
      <p className="text-xs text-neutral-500 mb-3">This fills in the court's own complaint, {DCCV082.revision}: the version Maryland accepts through e-filing. The counter still wants its carbonless paper form; a worksheet for that is the second button.</p>
      {c.blocked && !c.useManual && <Alert tone="danger" className="mb-3" title="The amount cannot be worked out from the ledger">{c.fromLedger.blockedReason}</Alert>}
      {c.useManual ? <ManualClaimFields value={c.manual} onChange={c.setManual} /> : c.fromLedger && !c.blocked && <ClaimTable claim={c.fromLedger} overrides={c.overrides} setOverrides={c.setOverrides} monthlyRent={parties.fullRent} />}
      <div className="mt-2"><TextLink tone="neutral" size="xs" onClick={() => c.setUseManual(v => !v)}>{c.useManual ? "Use the amounts from the ledger" : "Enter the amounts myself"}</TextLink></div>

      <div className="grid grid-cols-2 gap-3 mt-4">
        <FormField label="Court" required>
          <Select value={f.district} onChange={set("district")}>
            <option value="">Choose…</option>
            {(districts.length ? districts : DCCV082.districts).map(d => <option key={d} value={d}>{d}</option>)}
            {districts.length > 0 && <optgroup label="Elsewhere">{DCCV082.districts.filter(d => !districts.includes(d)).map(d => <option key={d} value={d}>{d}</option>)}</optgroup>}
          </Select>
        </FormField>
        <FormField label="Court address (optional)"><Input value={f.courtAddress} onChange={set("courtAddress")} placeholder="Located at…" /></FormField>
        <FormField label="Monthly rent the tenant is responsible for" required><Input type="number" min="0" step="0.01" value={f.monthlyRent} onChange={set("monthlyRent")} /></FormField>
        <FormField label="Rent due on day" required><Input type="number" min="1" max="31" value={f.dueDay} onChange={set("dueDay")} /></FormField>
        <FormField label="Less tenant payments for utilities, fees, deposits (RP 8-212.3)"><Input type="number" min="0" step="0.01" value={f.utilityCredits} onChange={set("utilityCredits")} placeholder="0.00" /></FormField>
        <FormField label="Prior judgments in the past 12 months"><Input value={f.priorJudgments} onChange={set("priorJudgments")} placeholder="Case numbers and dates, or blank" /></FormField>
      </div>

      <div className="mt-3 rounded-xl border border-neutral-200 p-3 space-y-1">
        <div className="text-xs font-semibold text-neutral-500 uppercase">2. Rental licence</div>
        <Radio k="licenseStatus" v="yes" label="Required and licensed" />
        {f.licenseStatus === "yes" && <div className="grid grid-cols-2 gap-2 pl-6"><Input value={f.licenseNumber} onChange={set("licenseNumber")} placeholder="Licence number" /><Input type="date" value={f.licenseExpires} onChange={set("licenseExpires")} /></div>}
        <Radio k="licenseStatus" v="no" label="Not required to be licensed" />
        <Radio k="licenseStatus" v="unlicensed" label="Required, but unlicensed because" />
        {f.licenseStatus === "unlicensed" && <div className="pl-6 flex gap-3 flex-wrap text-sm"><Radio k="licenseReason" v="exempt" label="exempt" /><Radio k="licenseReason" v="reasons" label="RP 8-406(c)(1)(iii), (iv) or (v)" /><Radio k="licenseReason" v="other" label="other" />{f.licenseReason === "other" && <Input value={f.licenseText} onChange={set("licenseText")} placeholder="Why" />}</div>}
      </div>
      <div className="mt-3 rounded-xl border border-neutral-200 p-3 space-y-1">
        <div className="text-xs font-semibold text-neutral-500 uppercase">3. Lead paint (Environment Article 6-801)</div>
        <Radio k="leadStatus" v="not_affected" label="Not affected property (built in 1978 or later)" />
        <Radio k="leadStatus" v="affected" label="Affected property; MDE registration current. Inspection certificate number:" />
        {f.leadStatus === "affected" && <div className="pl-6"><Input value={f.leadCertificate} onChange={set("leadCertificate")} placeholder="MDE inspection certificate number" /></div>}
        <Radio k="leadStatus" v="owner_unable" label="Affected; owner unable to state the certificate number because" />
        {f.leadStatus === "owner_unable" && <div className="pl-6 flex gap-3 text-sm"><Radio k="leadReason" v="exempt" label="exempt" /><Radio k="leadReason" v="non_cooperation" label="tenant non-cooperation during remedial work" /></div>}
      </div>
      <div className="mt-3 rounded-xl border border-neutral-200 p-3 space-y-2">
        <div className="text-xs font-semibold text-neutral-500 uppercase">Military status (required)</div>
        <Select value={f.military} onChange={set("military")}>
          <option value="">Choose…</option>
          {Object.entries(MILITARY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        {f.military === "none" && <Input value={f.militaryFacts} onChange={set("militaryFacts")} placeholder="The facts: e.g. DOD SCRA search on 10/14/2026, no active duty found" />}
        <label className="flex items-center gap-2 text-sm text-neutral-700 cursor-pointer"><input type="checkbox" checked={f.dodVerified} onChange={set("dodVerified")} />Verified through the DOD website (scra.dmdc.osd.mil)</label>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="flex items-center gap-2 text-sm text-neutral-700 cursor-pointer"><input type="checkbox" checked={f.moneyJudgment} onChange={set("moneyJudgment")} />Request a money judgment (requires personal service)</label>
        <label className="flex items-center gap-2 text-sm text-neutral-700 cursor-pointer"><input type="checkbox" checked={f.future} onChange={set("future")} />Also ask for rent due by the trial date</label>
        {f.future && <div className="col-span-2 w-48"><Input type="number" min="0" step="0.01" value={f.futureAmount} onChange={set("futureAmount")} /></div>}
        {parties.voucher && <div className="col-span-2 flex gap-3 text-sm"><span className="text-neutral-500">Subsidy:</span><Radio k="subsidyKind" v="s8" label="Section 8" /><Radio k="subsidyKind" v="other" label="other" /></div>}
        <label className="flex items-center gap-2 text-sm text-neutral-700 cursor-pointer"><input type="checkbox" checked={f.deceased} onChange={set("deceased")} />The tenant is deceased, intestate, without next of kin</label>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <FormField label="Signer (print name)" required><Input value={f.signerName} onChange={set("signerName")} /></FormField>
        <FormField label="Attorney number / party #"><Input value={f.attorneyNumber} onChange={set("attorneyNumber")} /></FormField>
        <FormField label="Signer's address"><Input value={f.signerAddress} onChange={set("signerAddress")} /></FormField>
        <FormField label="Telephone"><Input value={f.signerPhone} onChange={set("signerPhone")} /></FormField>
      </div>

      {problems.length > 0 && <Alert tone="warn" className="mt-3">{problems.map((p, i) => <div key={i}>{p}</div>)}</Alert>}
      {values && problems.length === 0 && <p className="text-sm text-neutral-700 mt-3">Net rent {formatCurrency(values.net)} · subtotal {formatCurrency(values.subtotal)} · total on the complaint: <strong data-testid="complaint-total">{formatCurrency(values.total)}</strong></p>}
      <p className="text-xs text-neutral-400 mt-2">The signature is left blank for you to sign by hand (or through e-filing). Nothing is sent to the tenant or the court from here.</p>
      <div className="flex gap-2 mt-4 flex-wrap">
        <Btn onClick={makeForm} disabled={!!busy || problems.length > 0}>{busy === "form" ? "Filling in the form…" : "Fill in the complaint (e-filing)"}</Btn>
        <Btn variant="secondary" onClick={makeWorksheet} disabled={!!busy || hard.length > 0}>{busy === "sheet" ? "Making…" : "Worksheet for the paper form"}</Btn>
        <Btn variant="ghost" onClick={onClose} disabled={!!busy}>Cancel</Btn>
      </div>
    </Modal>
  );
}

// After judgment for possession: the petition for the warrant of
// restitution (DC-CV-081), filled on the court's form.
export function FtprWarrantDialog({ evCase, companyId, activeCompany, userProfile, userRole, showToast, onClose, onDone }) {
  const today = formatLocalDate(new Date());
  const { ctx, failed } = useFtprContext({ companyId, tenantId: evCase.tenant_id, userProfile, activeCompany });
  const parties = useMemo(() => (ctx ? partiesFrom(ctx) : null), [ctx]);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  useEffect(() => {
    if (!parties || f) return;
    const districts = districtsFor(ctx.property?.county, ctx.property?.city);
    const judged = evCase.claim_detail?.complaint?.total ?? evCase.claim_total ?? "";
    setF({
      district: DCCV082.districts.includes(evCase.court) ? evCase.court : (districts[0] || ""), courtAddress: evCase.claim_detail?.complaint?.answers?.courtAddress || "", courtPhone: "",
      caseNumber: evCase.case_number || "", judgmentDate: evCase.judgment_date || "", amountDue: judged === null ? "" : String(judged), costs: "", premisesDescription: [parties.premises.address, parties.premises.cityStateZip].filter(Boolean).join(", "),
      noRightToRedeem: false, amountPaid: "",
      signerName: userProfile?.name || "", attorneyNumber: "", phone: parties.landlord.phone || "", fax: "", email: userProfile?.email || parties.landlord.email || "", signerAddress: parties.landlord.address || "", signerCityStateZip: parties.landlord.cityStateZip || "",
    });
  }, [parties, f, ctx, evCase, userProfile]);
  const set = (k) => (e) => setF(v => ({ ...v, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const values = useMemo(() => {
    if (!ctx || !f) return null;
    const m = String(parties.landlord.cityStateZip || "").match(/^(.*?),\s*([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?)$/);
    return dccv081Values({
      district: f.district, courtAddress: f.courtAddress, courtPhone: f.courtPhone, caseNumber: f.caseNumber,
      landlord: { name: parties.landlord.name, address: parties.landlord.address, city: m ? m[1] : parties.landlord.cityStateZip, state: m ? m[2].toUpperCase() : "", zip: m ? m[3] : "" },
      tenants: parties.tenants, premises: { address: parties.premises.address, city: ctx.property?.city || "", state: ctx.property?.state || "", zip: ctx.property?.zip || "" },
      judgmentDate: f.judgmentDate, amountDue: Number(f.amountDue) || 0, costs: Number(f.costs) || 0, premisesDescription: f.premisesDescription, noRightToRedeem: f.noRightToRedeem, amountPaid: Number(f.amountPaid) || 0,
      signer: { name: f.signerName, attorneyNumber: f.attorneyNumber, phone: f.phone, fax: f.fax, email: f.email, address: f.signerAddress, cityStateZip: f.signerCityStateZip }, signedDate: today,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, f, today]);
  async function make() {
    if (!values || !values.ok || !guardSubmit("ftprWarrant", evCase.id)) return;
    try {
      setBusy(true);
      const res = await fetch(DCCV081.file);
      if (!res.ok || !/pdf/i.test(res.headers.get("content-type") || "")) { showToast("The court form could not be loaded. Check your connection and try again.", "error"); return; }
      const PDFLib = await import("pdf-lib");
      let pdfBytes;
      try { pdfBytes = await fillDccv081(PDFLib, await res.arrayBuffer(), values); }
      catch (e) { showToast(e.message || "The court form could not be filled in.", "error"); return; }
      const out = await saveCaseForm({ companyId, ctx, evCase, kind: "court_other", pdfBytes, userEmail: userProfile?.email || "",
        name: "Petition for Warrant of Restitution (DC-CV-081) — " + (ctx.tenant?.name || evCase.tenant_name) + " " + today,
        summary: `<p>Petition for Warrant of Restitution, court form DC-CV-081, filled in and stored as a PDF. Balance due $${values.balance.toFixed(2)}.</p>`,
        fields: { ...f, balance: values.balance }, note: "Petition for Warrant of Restitution (DC-CV-081) filled in: balance $" + values.balance.toFixed(2) + "." });
      if (out.error && !out.path) { showToast(out.error, "error"); return; }
      logAudit("create", "evictions", `Petition for Warrant of Restitution (DC-CV-081) filled in for ${evCase.tenant_name}`, evCase.id, userProfile?.email, userRole, companyId);
      setDone({ path: out.path });
      if (onDone) onDone(out);
    } finally { setBusy(false); guardRelease("ftprWarrant", evCase.id); }
  }
  const title = "Petition for Warrant of Restitution — " + evCase.tenant_name;
  if (failed) return <Modal title={title} onClose={onClose}><Alert tone="danger">{failed}</Alert><div className="mt-4"><Btn variant="secondary" onClick={onClose}>Close</Btn></div></Modal>;
  if (!ctx || !f) return <Modal title={title} onClose={onClose}><Spinner /></Modal>;
  if (done) return (
    <Modal title={title} onClose={onClose}>
      <Alert tone="success" title="The petition is filled in">Check it, sign it, and file it with the court that gave the judgment. Once the warrant is issued, record its date under "Edit court details".</Alert>
      <div className="flex gap-2 mt-4 flex-wrap"><Btn onClick={() => openStored(done.path, showToast)} icon="print">Open the PDF</Btn><Btn variant="secondary" onClick={onClose}>Done</Btn></div>
    </Modal>
  );
  const districts = districtsFor(ctx.property?.county, ctx.property?.city);
  return (
    <Modal title={title} onClose={() => { if (!busy) onClose(); }}>
      <p className="text-xs text-neutral-500 mb-3">After the court has given judgment for possession, this asks it to issue the warrant the sheriff acts on. {DCCV081.revision}.</p>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Court" required><Select value={f.district} onChange={set("district")}><option value="">Choose…</option>{(districts.length ? districts : DCCV082.districts).map(d => <option key={d} value={d}>{d}</option>)}{districts.length > 0 && <optgroup label="Elsewhere">{DCCV082.districts.filter(d => !districts.includes(d)).map(d => <option key={d} value={d}>{d}</option>)}</optgroup>}</Select></FormField>
        <FormField label="Case number" required><Input value={f.caseNumber} onChange={set("caseNumber")} /></FormField>
        <FormField label="Court address"><Input value={f.courtAddress} onChange={set("courtAddress")} /></FormField>
        <FormField label="Court telephone"><Input value={f.courtPhone} onChange={set("courtPhone")} /></FormField>
        <FormField label="Date of the judgment" required><Input type="date" value={f.judgmentDate} max={today} onChange={set("judgmentDate")} /></FormField>
        <FormField label="Amount the court determined due" required><Input type="number" min="0" step="0.01" value={f.amountDue} onChange={set("amountDue")} /></FormField>
        <FormField label="Court costs awarded"><Input type="number" min="0" step="0.01" value={f.costs} onChange={set("costs")} /></FormField>
        <FormField label="Paid by the tenant since the judgment"><Input type="number" min="0" step="0.01" value={f.amountPaid} onChange={set("amountPaid")} placeholder="0.00" /></FormField>
        <FormField label="The premises, as described in the judgment" className="col-span-2"><Input value={f.premisesDescription} onChange={set("premisesDescription")} /></FormField>
      </div>
      <label className="flex items-center gap-2 mt-3 text-sm text-neutral-700 cursor-pointer"><input type="checkbox" checked={f.noRightToRedeem} onChange={set("noRightToRedeem")} />The court found the tenant does not have the right to redeem</label>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <FormField label="Signer (print name)" required><Input value={f.signerName} onChange={set("signerName")} /></FormField>
        <FormField label="Attorney number"><Input value={f.attorneyNumber} onChange={set("attorneyNumber")} /></FormField>
        <FormField label="Telephone"><Input value={f.phone} onChange={set("phone")} /></FormField>
        <FormField label="E-mail"><Input value={f.email} onChange={set("email")} /></FormField>
        <FormField label="Address"><Input value={f.signerAddress} onChange={set("signerAddress")} /></FormField>
        <FormField label="City, State, Zip"><Input value={f.signerCityStateZip} onChange={set("signerCityStateZip")} /></FormField>
      </div>
      {values && values.problems.length > 0 && <Alert tone="warn" className="mt-3">{values.problems.map((p, i) => <div key={i}>{p}</div>)}</Alert>}
      {values && values.ok && <p className="text-sm text-neutral-700 mt-3">Balance due on the petition: <strong>{formatCurrency(values.balance)}</strong> (not including court costs)</p>}
      <div className="flex gap-2 mt-4 flex-wrap">
        <Btn onClick={make} disabled={busy || !values || !values.ok}>{busy ? "Filling in the form…" : "Fill in the petition"}</Btn>
        <Btn variant="ghost" onClick={onClose} disabled={busy}>Cancel</Btn>
      </div>
    </Modal>
  );
}

function FilingDialog({ evCase, companyId, userProfile, userRole, showToast, onClose, onSaved }) {
  const today = formatLocalDate(new Date());
  const [filedOn, setFiledOn] = useState(evCase.filing_date || today);
  const [caseNumber, setCaseNumber] = useState(evCase.case_number || "");
  const [court, setCourt] = useState(evCase.court || "");
  const [busy, setBusy] = useState(false);
  const bad = !filedOn || filedOn > today || (evCase.cure_deadline && filedOn <= evCase.cure_deadline);
  async function save() {
    if (bad || !guardSubmit("ftprFiling", evCase.id)) return;
    try {
      setBusy(true);
      const total = evCase.claim_detail?.complaint?.total;
      const out = await recordFiling({ companyId, evCase, filedOn, caseNumber: caseNumber.trim(), court: court.trim(), claimTotal: total ?? null, userEmail: userProfile?.email || "" });
      if (out.error) { showToast(out.error, "error"); return; }
      logAudit("update", "evictions", `Complaint filed for ${evCase.tenant_name}${caseNumber.trim() ? ", case " + caseNumber.trim() : ""}`, evCase.id, userProfile?.email, userRole, companyId);
      showToast("Filing recorded.", "success");
      onSaved();
    } finally { setBusy(false); guardRelease("ftprFiling", evCase.id); }
  }
  return (
    <Modal title={"Record the filing — " + evCase.tenant_name} onClose={() => { if (!busy) onClose(); }}>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Filed on" required><Input type="date" value={filedOn} max={today} onChange={e => setFiledOn(e.target.value)} /></FormField>
        <FormField label="Case number"><Input value={caseNumber} onChange={e => setCaseNumber(e.target.value)} placeholder="From the court" /></FormField>
        <FormField label="Court" className="col-span-2"><Input value={court} onChange={e => setCourt(e.target.value)} placeholder="District Court of Maryland for …" /></FormField>
      </div>
      {evCase.cure_deadline && filedOn && filedOn <= evCase.cure_deadline && <Alert tone="warn" className="mt-3">The tenant had until the end of {fmtDate(evCase.cure_deadline)} to pay. A complaint cannot be filed before {fmtDate(cureDeadline(evCase.cure_deadline, 1))}.</Alert>}
      <p className="text-xs text-neutral-400 mt-3">The case number can be added later if the court has not given one yet. A filing fee is recorded with "Advance to next stage" below, which posts it to the books.</p>
      <div className="flex gap-2 mt-4"><Btn onClick={save} disabled={busy || bad}>{busy ? "Saving…" : "Record the filing"}</Btn><Btn variant="ghost" onClick={onClose} disabled={busy}>Cancel</Btn></div>
    </Modal>
  );
}

// The failure-to-pay part of a case: what was claimed, the deadline, the
// court's number, the documents, and the next step.
export function FtprCasePanel({ evCase, companyId, activeCompany, userProfile, userRole, showToast, onChanged, onClosePaid }) {
  const today = formatLocalDate(new Date());
  const [docs, setDocs] = useState(null);
  const [dialog, setDialog] = useState("");
  const [edit, setEdit] = useState(null);
  const refresh = useCallback(() => { loadCaseDocs(companyId, evCase.id).then(setDocs); }, [companyId, evCase.id]);
  useEffect(() => { setDocs(null); refresh(); }, [refresh, evCase.notice_doc_id, evCase.complaint_doc_id]);

  const active = evCase.status === "active";
  const early = ["notice", "cure_period"].includes(evCase.current_stage);
  const ready = complaintReadiness({ providedOn: evCase.notice_served_on, today });
  const m = noticeMethod(evCase.notice_served_method);
  const daysLeft = evCase.cure_deadline ? Math.round((Date.parse(evCase.cure_deadline + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000) : null;
  const done = () => { setDialog(""); refresh(); if (onChanged) onChanged(); };

  async function saveEdit() {
    const out = await updateCaseFacts({ companyId, caseId: evCase.id, facts: edit });
    if (out.error) { showToast(out.error, "error"); return; }
    setEdit(null); showToast("Saved.", "success"); if (onChanged) onChanged();
  }
  const Fact = ({ label, children }) => <div><span className="text-neutral-400 text-xs block">{label}</span><span className="font-semibold text-neutral-700 break-words">{children}</span></div>;

  return (
    <div className="px-6 py-4 border-b border-brand-50" data-testid="ftpr-panel">
      <div className="text-xs font-semibold text-neutral-400 uppercase mb-2 flex items-center justify-between">
        <span>Failure to pay rent</span>
        {active && !edit && <TextLink tone="brand" size="xs" onClick={() => setEdit({ case_number: evCase.case_number || "", court: evCase.court || "", hearing_date: evCase.hearing_date || "", judgment_date: evCase.judgment_date || "", writ_date: evCase.writ_date || "" })}>Edit court details</TextLink>}
      </div>
      {!evCase.notice_served_on ? (
        <div>
          <p className="text-sm text-neutral-600">No Notice of Intent (DC-CV-115) is on file for this case. A failure-to-pay complaint cannot be filed in Maryland without one, provided at least 10 days before.</p>
          {active && evCase.tenant_id && <Btn size="sm" className="mt-2" onClick={() => setDialog("notice")}>Make the Notice of Intent</Btn>}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 text-sm">
          <Fact label="Claimed on the notice">{formatCurrency(evCase.claim_detail?.notice?.total ?? evCase.claim_total)}<span className="text-xs font-normal text-neutral-400"> · rent {formatCurrency(evCase.claim_detail?.notice?.rent?.amount ?? evCase.claim_rent)}, late fees {formatCurrency(evCase.claim_detail?.notice?.lateFees?.amount ?? evCase.claim_late_fees)}</span></Fact>
          <Fact label="Notice provided">{fmtDate(evCase.notice_served_on)}<span className="text-xs font-normal text-neutral-400"> · {m ? m.label.toLowerCase() : evCase.notice_served_method}</span></Fact>
          <Fact label="Tenant may pay until">{fmtDate(evCase.cure_deadline)}{active && early && daysLeft !== null ? <span className={"text-xs font-normal " + (daysLeft < 0 ? "text-danger-600" : "text-neutral-400")}> · {daysLeft > 0 ? daysLeft + " day" + (daysLeft === 1 ? "" : "s") + " left" : daysLeft === 0 ? "today is the last day" : "passed"}</span> : null}</Fact>
          <Fact label="Court">{evCase.court || "—"}</Fact>
          <Fact label="Case number">{evCase.case_number || "—"}</Fact>
          {evCase.filing_date && <Fact label="Filed">{fmtDate(evCase.filing_date)}{evCase.claim_detail?.complaint?.total != null ? <span className="text-xs font-normal text-neutral-400"> · {formatCurrency(evCase.claim_detail.complaint.total)} on the complaint</span> : null}</Fact>}
          {evCase.writ_date && <Fact label="Warrant of restitution">{fmtDate(evCase.writ_date)}</Fact>}
          {evCase.cured_on && <Fact label="Paid in full">{fmtDate(evCase.cured_on)}</Fact>}
        </div>
      )}

      {edit && (
        <div className="mt-3 rounded-xl border border-neutral-200 p-3">
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Case number"><Input value={edit.case_number} onChange={e => setEdit({ ...edit, case_number: e.target.value })} /></FormField>
            <FormField label="Court"><Input value={edit.court} onChange={e => setEdit({ ...edit, court: e.target.value })} /></FormField>
            <FormField label="Hearing date"><Input type="date" value={edit.hearing_date} onChange={e => setEdit({ ...edit, hearing_date: e.target.value })} /></FormField>
            <FormField label="Judgment date"><Input type="date" value={edit.judgment_date} onChange={e => setEdit({ ...edit, judgment_date: e.target.value })} /></FormField>
            <FormField label="Warrant of restitution date"><Input type="date" value={edit.writ_date} onChange={e => setEdit({ ...edit, writ_date: e.target.value })} /></FormField>
          </div>
          <div className="flex gap-2 mt-3"><Btn size="sm" onClick={saveEdit}>Save</Btn><Btn size="sm" variant="ghost" onClick={() => setEdit(null)}>Cancel</Btn></div>
        </div>
      )}

      <div className="mt-3">
        <div className="text-xs text-neutral-400 mb-1">Documents</div>
        {docs === null ? <div className="text-xs text-neutral-400">Loading…</div> : docs.length === 0 ? <div className="text-xs text-neutral-400">None yet.</div> : docs.map(d => (
          <div key={d.id} className="flex items-center gap-2 text-sm py-1" data-testid="case-doc">
            <span className="material-icons-outlined text-base text-neutral-400">description</span>
            <span className="flex-1 min-w-0 truncate text-neutral-700">{KIND_LABEL[d.doc_kind] || d.name}<span className="text-xs text-neutral-400"> · {fmtDate(d.created_at)}</span></span>
            {d.pdf_output_path && <TextLink tone="brand" size="xs" onClick={() => openStored(d.pdf_output_path, showToast)}>PDF</TextLink>}
          </div>
        ))}
      </div>

      {active && evCase.notice_served_on && (
        <div className="mt-3 flex gap-2 flex-wrap">
          {early && <Btn size="sm" onClick={() => setDialog("complaint")} disabled={!ready.ready} title={ready.ready ? "" : ready.reason}>Prepare the complaint (DC-CV-082)</Btn>}
          {early && ready.ready && <Btn size="sm" variant="secondary" onClick={() => setDialog("filing")}>Record the filing</Btn>}
          {early && evCase.tenant_id && <Btn size="sm" variant="secondary" onClick={() => setDialog("notice")}>Make a new notice</Btn>}
          {!early && evCase.tenant_id && <Btn size="sm" onClick={() => setDialog("warrant")} title={evCase.judgment_date ? "" : "Record the judgment date first (Edit court details); the petition needs it"}>Petition for Warrant of Restitution (DC-CV-081)</Btn>}
          {onClosePaid && <Btn size="sm" variant="secondary" onClick={() => onClosePaid(evCase)}>The tenant paid — close the case</Btn>}
        </div>
      )}
      {active && early && evCase.notice_served_on && !ready.ready && <p className="text-xs text-neutral-400 mt-2">{ready.reason}</p>}

      {dialog === "notice" && <FtprNoticeDialog tenantId={evCase.tenant_id} companyId={companyId} activeCompany={activeCompany} userProfile={userProfile} userRole={userRole} showToast={showToast} onClose={done} />}
      {dialog === "complaint" && <FtprComplaintDialog evCase={evCase} companyId={companyId} activeCompany={activeCompany} userProfile={userProfile} userRole={userRole} showToast={showToast} onClose={done} />}
      {dialog === "warrant" && <FtprWarrantDialog evCase={evCase} companyId={companyId} activeCompany={activeCompany} userProfile={userProfile} userRole={userRole} showToast={showToast} onClose={done} />}
      {dialog === "filing" && <FilingDialog evCase={evCase} companyId={companyId} userProfile={userProfile} userRole={userRole} showToast={showToast} onClose={() => setDialog("")} onSaved={done} />}
    </div>
  );
}
