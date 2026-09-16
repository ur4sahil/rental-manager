import React from "react";
import { Btn, TextLink, Select, DetailPanel, DetailRow, DetailCard, DetailAlert } from "../ui";
import {
  safeNum, formatCurrency, fmtDate, splitParties, sharedContacts, initialsFor,
  REQUIRED_TENANT_DOCS, DOC_TYPES, isRequiredDocMet, parseLocalDate,
} from "../utils/helpers";

// The tenant detail PAGE.
//
// This replaces a 400-line right-hand drawer whose five tabs (Ledger,
// Documents, Messages, Actions, Lease) each hid the other four, so answering
// "do they owe money and are their documents in order" meant clicking twice
// and remembering the first answer. A tenant record is not deep enough to
// need tabs and is too wide for a 512px drawer: one page, everything visible.
//
// Presentational by design. Every write still belongs to Tenants.js, which
// owns the data and the toasts; this file decides only what is shown and
// where. That split is what keeps it reviewable at this size.

const MONTH_MS = 1000 * 60 * 60 * 24 * 30.44;

// "Expired 19 months ago" / "Ends in 3 months". Returns null when there is no
// end date, because "—" in a status row reads as "fine" and it is not.
function leaseStanding(tenant) {
  const end = tenant?.lease_end_date || tenant?.move_out;
  if (!end) return null;
  const d = parseLocalDate(String(end).slice(0, 10));
  if (isNaN(d.getTime())) return null;
  const months = Math.round((Date.now() - d.getTime()) / MONTH_MS);
  if (months > 0) return { expired: true, text: `Expired ${months === 1 ? "1 month" : months + " months"} ago` };
  if (months === 0) return { expired: false, text: "Ends this month" };
  return { expired: false, text: `Ends in ${-months === 1 ? "1 month" : -months + " months"}` };
}





export default function TenantPage({
  tenant, ledger = [], docs = [], docExceptions = [], userRole,
  onBack, onOpenProperty,
  onEdit, onInvite, onRenew, onMoveOut, onArchive, onAddEntry, onMessage,
  onExportPdf, onApplyLateFee, onPrepareFiling, onSetRent,
  onUploadDoc, onViewDoc, onSetDocType, onWaiveDoc, onRequestException,
  // Rendered by Tenants.js and handed in whole: the add-entry form and the
  // message thread carry too much of that component's state to be worth
  // marshalling through a dozen props, and neither is a layout decision.
  addEntryForm, messagesPanel, lateFeeAction,
  ledgerShowAll, onToggleLedgerAll,
}) {
  if (!tenant) return null;

  // One row, several people. See splitParties(): contact details are personal,
  // the money below is not.
  const parties = splitParties(tenant);
  const shared = sharedContacts(tenant);
  const balance = safeNum(tenant.balance);
  const standing = leaseStanding(tenant);
  const rentSet = safeNum(tenant.rent) > 0;

  const approvedExceptions = (() => {
    const v = tenant.approved_doc_exceptions;
    if (Array.isArray(v)) return v;
    if (typeof v === "string") { try { return JSON.parse(v); } catch { return []; } }
    return [];
  })();

  const reqs = REQUIRED_TENANT_DOCS.map(r => {
    const uploaded = isRequiredDocMet(docs, r);
    const waived = approvedExceptions.includes(r.label);
    const pending = (docExceptions || []).find(x => x.status === "pending" && x.tenant_name === tenant.name && x.doc_type === r.label);
    // The file that satisfies it, so the row can say WHICH one did -- a bare
    // tick invites "met by what?" and the answer is two clicks away.
    const met = uploaded ? (docs.find(d => isRequiredDocMet([d], r)) || null) : null;
    return { ...r, uploaded, waived, pending, met, satisfied: uploaded || waived };
  });
  // A charge raises what is owed; a payment or credit lowers it. Everything
  // else -- a write-off, an adjustment -- is charge-side, which is why "Bad
  // debt" used to read as green money in.
  const isCredit = e => e.type === "payment" || e.type === "credit";
  const charged = ledger.reduce((n, e) => n + (isCredit(e) ? 0 : Math.abs(safeNum(e.amount))), 0);
  const paid = ledger.reduce((n, e) => n + (isCredit(e) ? Math.abs(safeNum(e.amount)) : 0), 0);

  const metCount = reqs.filter(r => r.satisfied).length;
  const canWaive = userRole === "admin" || userRole === "owner";

  return (
    <div className="max-w-[1180px] mx-auto pb-16">

      <div className="text-[13px] text-neutral-400 mb-2.5">
        <TextLink tone="neutral" size="xs" onClick={onBack}>Tenants</TextLink>
        <span className="mx-1.5">›</span>
        <span>{tenant.name}</span>
      </div>

      {/* ---- identity, and the one number that appears nowhere else ---- */}
      <div className="bg-white border border-brand-50 rounded-2xl p-5 mb-3.5">
        <div className="flex gap-4 items-start flex-wrap">
          <div className="flex shrink-0">
            {parties.slice(0, 3).map((p, i) => (
              <div key={p.name + i}
                className={"w-11 h-11 rounded-xl bg-brand-50 text-brand-700 grid place-items-center font-bold text-[15px] shrink-0"
                  + (i ? " -ml-3.5 border-2 border-white" : "")}>
                {initialsFor(p.name)}
              </div>
            ))}
          </div>

          <div className="flex-1 min-w-[220px]">
            <h1 className="text-[22px] font-bold text-neutral-800 leading-tight">{tenant.name}</h1>
            <div className="text-[13.5px] text-neutral-400 mt-0.5">
              {tenant.property
                ? <TextLink tone="neutral" size="xs" onClick={() => onOpenProperty?.(tenant)}>{tenant.property}</TextLink>
                : <span className="text-warn-700">No property assigned</span>}
            </div>
            <div className="flex gap-1.5 flex-wrap mt-2">
              <span className={"text-[11.5px] font-semibold px-2.5 py-0.5 rounded-full "
                + (String(tenant.lease_status).toLowerCase() === "current" ? "bg-positive-50 text-positive-700" : "bg-neutral-100 text-neutral-500")}>
                {tenant.lease_status ? String(tenant.lease_status)[0].toUpperCase() + String(tenant.lease_status).slice(1) : "No status"} tenant
              </span>
              {parties.length > 1 && <span className="text-[11.5px] font-semibold px-2.5 py-0.5 rounded-full bg-neutral-100 text-neutral-600">{parties.length} on the lease</span>}
              {tenant.is_voucher && <span className="text-[11.5px] font-semibold px-2.5 py-0.5 rounded-full bg-highlight-50 text-highlight-700">Voucher{tenant.voucher_number ? " " + tenant.voucher_number : ""}</span>}
            </div>
          </div>

          <div className="text-right shrink-0 max-[620px]:text-left">
            <span className="block text-[11px] font-semibold tracking-[0.06em] uppercase text-neutral-400">
              {balance < 0 ? "Credit held" : "Balance owed"}
            </span>
            <span className={"block text-3xl font-semibold tabular-nums tracking-tight mt-0.5 "
              + (balance > 0 ? "text-danger-600" : balance < 0 ? "text-positive-600" : "text-neutral-400")}>
              {formatCurrency(Math.abs(balance))}
            </span>
            {parties.length > 1 && balance > 0 && <span className="block text-xs text-neutral-400 mt-0.5">owed jointly, not split</span>}
          </div>
        </div>

        {/* ---- lease terms, contact, actions: the reference facts, stated once ---- */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] mt-4 border border-brand-50 rounded-xl overflow-hidden bg-neutral-50/60">
          <DetailPanel title="Lease terms">
            <DetailRow label="Term">
              <span className="tabular-nums">
                {fmtDate(tenant.lease_start || tenant.move_in, "—")} – {fmtDate(tenant.lease_end_date || tenant.move_out, "—")}
              </span>
            </DetailRow>
            {standing && <DetailRow label="Status" tone={standing.expired ? "warn" : undefined}>{standing.text}</DetailRow>}
            <DetailRow label="Rent" tone={rentSet ? undefined : "warn"}>
              {rentSet ? formatCurrency(tenant.rent) : "Not set"}
            </DetailRow>
            <DetailRow label="Deposit">{safeNum(tenant.security_deposit) > 0 ? formatCurrency(tenant.security_deposit) : <span className="text-neutral-400">None recorded</span>}</DetailRow>
            {tenant.is_voucher
              ? <DetailRow label="Tenant portion">{formatCurrency(tenant.tenant_portion || 0)}</DetailRow>
              : <DetailRow label="Voucher">Market rate</DetailRow>}
          </DetailPanel>

          <DetailPanel title={parties.length > 1 ? `Contact · ${parties.length} tenants` : "Contact"}>
            {parties.length > 1 ? (
              <>
                {parties.map((p, i) => (
                  <div key={p.name + i} className={"py-0.5" + (i ? " border-t border-dashed border-brand-50 mt-1 pt-1.5" : "")}>
                    <b className="block text-[12.5px] font-semibold text-neutral-700">{p.name}</b>
                    <span className="text-[12.5px] text-neutral-400">
                      {p.phone ? <a className="text-brand-600 hover:underline" href={"tel:" + p.phone}>{p.phone}</a> : <span className="text-warn-700">no phone</span>}
                      {" · "}
                      {p.email ? <a className="text-brand-600 hover:underline break-all" href={"mailto:" + p.email}>{p.email}</a> : <span className="text-warn-700">no email</span>}
                    </span>
                  </div>
                ))}
                {(shared.phones.length > 0 || shared.emails.length > 0) && (
                  <div className="text-[11.5px] text-neutral-400 mt-1.5 pt-1.5 border-t border-dashed border-brand-50">
                    On the tenancy, not attributed: {[...shared.phones, ...shared.emails].join(", ")}
                  </div>
                )}
              </>
            ) : (
              <>
                <DetailRow label="Email">{tenant.email ? <a className="text-brand-600 hover:underline break-all" href={"mailto:" + tenant.email}>{tenant.email}</a> : <span className="text-warn-700">None</span>}</DetailRow>
                <DetailRow label="Phone">{tenant.phone ? <a className="text-brand-600 hover:underline" href={"tel:" + tenant.phone}>{tenant.phone}</a> : <span className="text-warn-700">None</span>}</DetailRow>
              </>
            )}
            <DetailRow label="Portal">{tenant.stripe_customer_id || tenant.email ? <span className="text-neutral-400">Not invited</span> : <span className="text-neutral-400">Needs an email first</span>}</DetailRow>
          </DetailPanel>

          <DetailPanel title="Actions">
            {/* Edit sits with its peers rather than as a filled primary: this
                page is for reading, and one loud button pulls the eye off the
                balance. */}
            <div className="grid grid-cols-2 gap-1.5">
              <Btn variant="secondary" size="sm" className="w-full justify-center" onClick={() => onEdit?.(tenant)}>{parties.length > 1 ? "Edit tenants" : "Edit tenant"}</Btn>
              <Btn variant="secondary" size="sm" className="w-full justify-center" onClick={() => onMessage?.(tenant)}>{parties.length > 1 ? "Message both" : "Message"}</Btn>
              <Btn variant="secondary" size="sm" className="w-full justify-center" onClick={() => onRenew?.(tenant)}>Renew lease</Btn>
              <Btn variant="secondary" size="sm" className="w-full justify-center" onClick={() => onInvite?.(tenant)}>Send invite</Btn>
              <Btn variant="secondary" size="sm" className="w-full justify-center" onClick={() => onMoveOut?.(tenant)}>Move-out</Btn>
              <Btn variant="secondary" size="sm" className="w-full justify-center" onClick={() => onAddEntry?.(tenant)}>Add entry</Btn>
              <Btn variant="secondary" size="sm" className="w-full justify-center col-span-2 text-danger-600" onClick={() => onArchive?.(tenant)}>Archive tenant</Btn>
            </div>
          </DetailPanel>
        </div>
      </div>

      {/* ---- what is wrong with this record, said once each ---- */}
      {!rentSet && balance > 0 && (
        <DetailAlert fix="Set rent" onFix={() => onSetRent?.(tenant)}>
          <b className="text-neutral-800">Rent is not set on this tenant</b>, yet {formatCurrency(balance)} is outstanding. Nothing will bill automatically and arrears will stop accruing.
        </DetailAlert>
      )}
      {standing?.expired && String(tenant.lease_status).toLowerCase() === "current" && (
        <DetailAlert fix="Renew or move out" onFix={() => onRenew?.(tenant)}>
          <b className="text-neutral-800">The lease ended {fmtDate(tenant.lease_end_date || tenant.move_out)}</b> and the tenancy still reads Current.
        </DetailAlert>
      )}
      {parties.length > 1 && parties.every(p => !p.email) && (
        <DetailAlert fix="Split contacts" onFix={() => onEdit?.(tenant)}>
          <b className="text-neutral-800">Both tenants share one contact record</b> and neither has an email, so a notice reaches whoever answers the phone first.
        </DetailAlert>
      )}

      <div className="grid grid-cols-[minmax(0,1.85fr)_minmax(280px,1fr)] max-[940px]:grid-cols-1 gap-3.5 items-start">

        <div className="space-y-3.5">
          <DetailCard title="Ledger" sub={ledger.length ? `${charged ? formatCurrency(charged) + " charged · " : ""}${paid ? formatCurrency(paid) + " paid" : ""}` || `${ledger.length} entries` : null} flush
            action={<><Btn variant="secondary" size="sm" onClick={() => onExportPdf?.(tenant, ledger)}>Export PDF</Btn>
              <Btn variant="secondary" size="sm" onClick={() => onAddEntry?.(tenant)}>Add entry</Btn></>}>
            {addEntryForm && <div className="px-4 pt-3.5">{addEntryForm}</div>}
            {lateFeeAction && <div className="px-4 pt-3.5">{lateFeeAction}</div>}
            {ledger.length === 0 ? (
              <div className="px-4 py-8 text-center text-[13px] text-neutral-400">
                No ledger entries have been posted for this tenant.
                {balance !== 0 && <div className="mt-1">The {formatCurrency(Math.abs(balance))} balance came from an opening import rather than from posted charges.</div>}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13.5px] min-w-[520px]">
                  <thead>
                    <tr>{["Date", "Description", "Type", "Charge", "Paid", "Balance"].map((h, i) => (
                      <th key={h} className={"text-[10.5px] font-semibold tracking-[0.06em] uppercase text-neutral-400 px-4 py-2 bg-neutral-50 border-b border-brand-50 whitespace-nowrap " + (i > 2 ? "text-right" : "text-left")}>{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {(ledgerShowAll ? ledger : ledger.slice(0, 20)).map((e, i) => {
                      // A payment or credit is stored as a NEGATIVE amount; the
                      // type is what says which, so the sign is not read twice.
                      const credit = e.type === "payment" || e.type === "credit";
                      const amount = Math.abs(safeNum(e.amount));
                      // "Journal Entry #1478 Bad debt" leads with an internal
                      // number. Show it quietly and let the words read first.
                      const m = String(e.description || "").match(/^Journal Entry #(\d+)\s*(.*)$/i);
                      const label = (m && m[2]) || e.description || "—";
                      return (
                        <tr key={e.id || i} className="border-b border-brand-50 last:border-b-0">
                          <td className="px-4 py-2.5 align-top tabular-nums whitespace-nowrap">{fmtDate(e.date)}</td>
                          <td className="px-4 py-2.5 align-top">
                            <div className="truncate">{label}</div>
                            {m && <div className="text-[11.5px] text-neutral-400">JE #{m[1]}</div>}
                          </td>
                          <td className="px-4 py-2.5 align-top text-[11px] uppercase tracking-[0.06em] text-neutral-400">{e.type || "—"}</td>
                          <td className="px-4 py-2.5 align-top text-right tabular-nums whitespace-nowrap text-danger-600">{credit ? "—" : formatCurrency(amount)}</td>
                          <td className="px-4 py-2.5 align-top text-right tabular-nums whitespace-nowrap text-positive-600">{credit ? formatCurrency(amount) : "—"}</td>
                          <td className="px-4 py-2.5 align-top text-right tabular-nums whitespace-nowrap text-neutral-400 text-[12.5px]">{e.balance != null ? formatCurrency(e.balance) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {ledger.length > 20 && (
                  <div className="flex items-center gap-2.5 px-4 py-2.5 border-t border-brand-50 bg-neutral-50 text-[12.5px] text-neutral-400">
                    <span className="flex-1">{ledgerShowAll ? `All ${ledger.length} entries.` : `Showing the 20 most recent of ${ledger.length}.`}</span>
                    <TextLink tone="brand" size="xs" onClick={onToggleLedgerAll}>{ledgerShowAll ? "Show 20 only" : "Show all"}</TextLink>
                  </div>
                )}
              </div>
            )}
          </DetailCard>

          {messagesPanel && (
            <DetailCard title="Messages" flush>
              <div className="flex flex-col" style={{ minHeight: "300px", maxHeight: "60vh" }}>{messagesPanel}</div>
            </DetailCard>
          )}

          {balance > 0 && (
            <DetailCard title="Arrears" sub="for a filing">
              <div className="flex justify-between text-[13px] py-0.5"><span className="text-neutral-400">Outstanding</span><span className="tabular-nums">{formatCurrency(balance)}</span></div>
              <p className="text-xs text-neutral-400 mt-2.5 mb-3">
                {parties.length > 1
                  ? <>A filing names <b className="text-neutral-600">all {parties.length} tenants</b> as defendants for the full amount — neither can be served for half.</>
                  : <>Arrears are allocated oldest-first when a filing is prepared.</>}
              </p>
              <Btn variant="secondary" size="sm" className="w-full justify-center" onClick={() => onPrepareFiling?.(tenant)}>Prepare filing</Btn>
            </DetailCard>
          )}
        </div>

        <div className="space-y-3.5">
          <DetailCard title="Documents" sub={`${metCount} of ${reqs.length} required`}
            action={<Btn variant="secondary" size="sm" onClick={() => onUploadDoc?.(tenant)}>Upload</Btn>}>
            {reqs.map(r => (
              <div key={r.label} className="grid grid-cols-[15px_minmax(0,1fr)_auto] gap-2.5 items-center py-1.5 border-b border-brand-50 last:border-b-0 text-[13.5px]">
                <span className={"w-[15px] h-[15px] rounded-full grid place-items-center text-[9px] font-bold leading-none "
                  + (r.satisfied ? "bg-positive-600 text-white" : "border-[1.5px] border-dashed border-brand-100 text-transparent")}>✓</span>
                <span className={r.satisfied ? "text-neutral-700" : "text-neutral-600"}>{r.label}</span>
                {r.uploaded ? <span className="text-xs text-neutral-400 truncate max-w-[140px]" title={r.met?.name}>{r.met?.name || "on file"}</span>
                  : r.waived ? <span className="text-xs text-info-600">Waived</span>
                  : r.pending ? <span className="text-xs text-warn-700">Review pending</span>
                  : <button type="button" onClick={() => (canWaive ? onWaiveDoc : onRequestException)?.(tenant, r.label)}
                      className="text-[11.5px] font-semibold text-neutral-400 border border-brand-50 rounded-md px-2 py-px hover:text-brand-600 hover:border-brand-600">
                      {canWaive ? "Waive" : "Request"}
                    </button>}
              </div>
            ))}

            {docs.length > 0 && (
              <>
                <div className="flex items-center gap-2 mt-3 pt-2.5 border-t border-dashed border-brand-50">
                  <h3 className="text-[10.5px] font-semibold tracking-[0.07em] uppercase text-neutral-400 flex-1">On file · {docs.length}</h3>
                </div>
                {docs.map(d => (
                  <div key={d.id} className="grid grid-cols-[17px_minmax(0,1fr)_auto] gap-x-2.5 gap-y-0.5 py-2 border-b border-brand-50 last:border-b-0 items-center">
                    <span className="row-span-2 self-start mt-0.5 w-[17px] h-[17px] rounded bg-neutral-100 text-neutral-400 grid place-items-center text-[8.5px] font-bold">
                      {(d.name || "").split(".").pop().slice(0, 3).toUpperCase() || "DOC"}
                    </span>
                    <span className="text-[13px] truncate" title={d.name}>{d.name}</span>
                    <TextLink tone="brand" size="xs" onClick={() => onViewDoc?.(d)} className="whitespace-nowrap">View</TextLink>
                    <Select size="sm" className="col-span-2 justify-self-start max-w-full text-[11.5px]"
                      value={d.type || "Other"} onChange={e => onSetDocType?.(d, e.target.value)}>
                      {DOC_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </Select>
                  </div>
                ))}
                <p className="text-xs text-neutral-400 mt-2.5 pt-2 border-t border-dashed border-brand-50">
                  A requirement clears when a file is given the matching type — the filename alone is not relied upon.
                </p>
              </>
            )}
          </DetailCard>
        </div>
      </div>
    </div>
  );
}
