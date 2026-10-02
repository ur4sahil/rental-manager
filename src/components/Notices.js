import React, { useState, useMemo } from "react";
import { supabase } from "../supabase";
import { Btn, Input, FormField, Alert } from "../ui";
import { formatLocalDate, fmtDate } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { checkNotice, defaultMoveOutDate, noticeTemplateFor, NOTICE_BY_LABEL } from "../utils/noticeRules";
import { Modal } from "./shared";

// ============ NOTICE THAT A TENANCY IS ENDING ============
// "Generate Move-Out Notice" used to set the tenant to "notice" with a
// move-out date and stop: no record of when notice was given or by whom,
// and no notice. This records both facts on the tenant and then writes it
// up: an acknowledgment when the tenant gave notice, a notice to vacate
// when the landlord did.

const OPTION = "w-full text-left rounded-xl border p-3 transition-colors ";
const optionClass = (on) => OPTION + (on ? "border-brand-500 bg-brand-50" : "border-neutral-200 bg-white hover:bg-neutral-50");

export function NoticeDialog({ tenant, companyId, companySettings = {}, userEmail = "", userRole = "", setPage, returnTo = null, showToast, onClose, onSaved }) {
  const today = formatLocalDate(new Date());
  const noticeDays = Number(companySettings.termination_notice_days) > 0 ? Number(companySettings.termination_notice_days) : 60;
  const [givenBy, setGivenBy] = useState(tenant?.notice_given_by || "tenant");
  const [noticeDate, setNoticeDate] = useState(tenant?.notice_given_on || today);
  const [moveOutDate, setMoveOutDate] = useState(String(tenant?.lease_status || "").toLowerCase() === "notice" && tenant?.move_out ? tenant.move_out : defaultMoveOutDate(today, noticeDays));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const alreadyOnNotice = String(tenant?.lease_status || "").toLowerCase() === "notice";

  const check = useMemo(() => checkNotice({ givenBy, noticeDate, moveOutDate, today, noticeDays, date: fmtDate }), [givenBy, noticeDate, moveOutDate, today, noticeDays]);

  async function save(withDocument) {
    if (!check.ok || !guardSubmit("recordNotice", tenant.id)) return;
    try {
      setBusy(true);
      // The LEASE stays "active": notice does not end a tenancy, the move-out does.
      const { error } = await supabase.from("tenants")
        .update({ lease_status: "notice", move_out: moveOutDate, notice_given_on: noticeDate, notice_given_by: givenBy })
        .eq("company_id", companyId).eq("id", tenant.id);
      if (error) { pmError("PM-3006", { raw: error, context: "record notice to vacate" }); return; }
      logAudit("update", "tenants", `Notice to vacate recorded for ${tenant.name}: given by ${NOTICE_BY_LABEL[givenBy]} on ${noticeDate}, moving out ${moveOutDate}`, tenant.id, userEmail, userRole, companyId);
      if (onSaved) onSaved({ ...tenant, lease_status: "notice", move_out: moveOutDate, notice_given_on: noticeDate, notice_given_by: givenBy });
      if (!withDocument || !setPage) {
        showToast("Notice recorded. " + tenant.name + " moves out " + fmtDate(moveOutDate) + ".", "success");
        onClose();
        return;
      }
      const landlord = givenBy === "landlord";
      setPage("doc_builder", {
        templateKey: noticeTemplateFor(givenBy), tenantId: Number(tenant.id), returnTo,
        values: landlord
          ? { notice_date: noticeDate, vacate_date: moveOutDate, vacate_reason: reason.trim() }
          : { notice_received: noticeDate, move_out_date: moveOutDate, deposit_days: String(companySettings.deposit_return_days || 45) },
      });
    } finally { setBusy(false); guardRelease("recordNotice", tenant.id); }
  }

  const docName = givenBy === "landlord" ? "notice to vacate" : "acknowledgment";
  return (
    <Modal title={"Notice to vacate — " + tenant.name} onClose={() => { if (!busy) onClose(); }}>
      {alreadyOnNotice && <Alert tone="info" className="mb-3">{tenant.name} is already on notice{tenant.notice_given_on ? ", given " + fmtDate(tenant.notice_given_on) : ""}, moving out {fmtDate(tenant.move_out)}. Saving changes those details.</Alert>}
      <div className="space-y-2 mb-3" role="radiogroup" aria-label="Who gave the notice">
        <button type="button" role="radio" aria-checked={givenBy === "tenant"} className={optionClass(givenBy === "tenant")} onClick={() => setGivenBy("tenant")}>
          <span className="block text-sm font-semibold text-neutral-800">The tenant gave notice</span>
          <span className="block text-xs text-neutral-600 mt-0.5">You confirm it in writing with an acknowledgment.</span>
        </button>
        <button type="button" role="radio" aria-checked={givenBy === "landlord"} className={optionClass(givenBy === "landlord")} onClick={() => setGivenBy("landlord")}>
          <span className="block text-sm font-semibold text-neutral-800">You are giving the tenant notice</span>
          <span className="block text-xs text-neutral-600 mt-0.5">You serve a notice to vacate.</span>
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormField label={givenBy === "tenant" ? "Notice received on" : "Notice given on"} required><Input type="date" value={noticeDate} max={today} onChange={e => { setNoticeDate(e.target.value); if (!alreadyOnNotice) setMoveOutDate(defaultMoveOutDate(e.target.value, noticeDays)); }} /></FormField>
        <FormField label="Move-out date" required><Input type="date" value={moveOutDate} onChange={e => setMoveOutDate(e.target.value)} /></FormField>
        {givenBy === "landlord" && <FormField label="Reason (optional, printed on the notice)" className="col-span-2"><Input value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. The lease will not be renewed" /></FormField>}
      </div>
      {!check.ok && <Alert tone="warn" className="mt-3">{check.error}</Alert>}
      {check.ok && check.warning && <Alert tone="warn" className="mt-3">{check.warning} It is recorded as given.</Alert>}
      <p className="text-xs text-neutral-400 mt-3">{tenant.name} is marked "on notice" and the home shows as available from the move-out date. The lease stays active and rent keeps billing until the move-out is run.</p>
      <div className="flex gap-2 mt-4 flex-wrap">
        <Btn onClick={() => save(true)} disabled={busy || !check.ok}>{busy ? "Saving…" : "Record it and write the " + docName}</Btn>
        <Btn variant="secondary" onClick={() => save(false)} disabled={busy || !check.ok}>Just record it</Btn>
        <Btn variant="ghost" onClick={onClose} disabled={busy}>Cancel</Btn>
      </div>
    </Modal>
  );
}
