import React from "react";
import { Btn, TextLink, DetailPanel, DetailRow, DetailCard, DetailAlert } from "../ui";
import { safeNum, formatCurrency, fmtDate, parseLocalDate, canManage } from "../utils/helpers";

// The property detail PAGE.
//
// Replaces a 512px drawer whose first tab was a stack of grey boxes. The
// change that matters is not the width: a property is a place several
// tenancies pass through, and the drawer listed them as `tenant`, `tenant_2`,
// `tenant_3` with no dates, so "who actually lives here" was unanswerable on
// the screen that exists to answer it. See <Occupancy> below.
//
// Presentational. Properties.js keeps the data, the writes and the remaining
// tabs, which arrive whole through `tabs`.

const DAY = 86400000;

function dateOf(v) {
  if (!v) return null;
  const d = parseLocalDate(String(v).slice(0, 10));
  return isNaN(d.getTime()) ? null : d;
}

// ---- occupancy -----------------------------------------------------------
// One shared track, one bar per tenancy. Bars that overlap were in the unit at
// the same time, which on a one-bedroom is either a roommate arrangement or a
// records error — and either way it is the first thing worth seeing. Drawn
// only for 2+ tenancies: a single bar says nothing a date range doesn't.
function Occupancy({ tenancies }) {
  const dated = tenancies.filter(t => t.start);
  if (dated.length < 2) return null;

  const now = Date.now();
  const min = Math.min(...dated.map(t => t.start.getTime()));
  const max = Math.max(now, ...dated.map(t => (t.end || new Date()).getTime()));
  const span = Math.max(max - min, DAY);
  const pct = ms => ((ms - min) / span) * 100;

  // The window in which more than one tenancy was live.
  let overlap = null;
  for (let i = 0; i < dated.length; i++) {
    for (let j = i + 1; j < dated.length; j++) {
      const a = dated[i], b = dated[j];
      const s = Math.max(a.start.getTime(), b.start.getTime());
      const e = Math.min((a.end || new Date()).getTime(), (b.end || new Date()).getTime());
      if (e > s) overlap = overlap ? { s: Math.min(overlap.s, s), e: Math.max(overlap.e, e) } : { s, e };
    }
  }
  const months = overlap ? Math.round((overlap.e - overlap.s) / (DAY * 30.44)) : 0;

  return (
    <div className="bg-white border border-brand-50 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-brand-50">
        <h2 className="text-sm font-semibold flex-1 text-neutral-700">Occupancy</h2>
        <span className="text-xs text-neutral-400">{fmtDate(new Date(min))} – today</span>
      </div>
      <div className="relative px-4 pt-3 pb-1">
        {overlap && (
          <div className="absolute top-8 bottom-1 bg-warn-100/50 border-x border-dashed border-warn-300 pointer-events-none"
            style={{ left: `calc(9.25rem + (100% - 11.25rem) * ${pct(overlap.s) / 100})`, width: `calc((100% - 11.25rem) * ${(pct(overlap.e) - pct(overlap.s)) / 100})` }} />
        )}
        <div className="absolute top-8 bottom-1 w-px bg-danger-500 z-10" style={{ left: `calc(9.25rem + (100% - 11.25rem) * ${pct(now) / 100})` }}>
          <span className="absolute -top-4 -right-1 text-[10px] font-bold text-danger-600 bg-white px-1">today</span>
        </div>
        <div className="h-4" />
        {tenancies.map((t, i) => (
          <div key={t.id || i} className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2.5 items-center py-1">
            <span className="text-[12.5px] truncate text-neutral-600" title={t.name}>{t.name}</span>
            <div className="relative h-[19px] bg-neutral-100 rounded-md">
              {t.start ? (
                <div title={`${fmtDate(t.start)} – ${t.end ? fmtDate(t.end) : "open"}`}
                  className={"absolute top-0 h-[19px] rounded-md flex items-center px-1.5 text-[10.5px] font-semibold overflow-hidden whitespace-nowrap "
                    + (t.current ? "bg-brand-50 text-brand-700 border border-brand-200" : "bg-neutral-50 text-neutral-400 border border-dashed border-neutral-200")}
                  style={{ left: pct(t.start.getTime()) + "%", width: Math.max(pct((t.end || new Date()).getTime()) - pct(t.start.getTime()), 2) + "%" }}>
                  {fmtDate(t.start)} – {t.end ? fmtDate(t.end) : "open"}
                </div>
              ) : (
                <span className="absolute inset-0 flex items-center px-1.5 text-[10.5px] italic text-neutral-400">no lease dates recorded</span>
              )}
            </div>
          </div>
        ))}
      </div>
      {overlap && months > 0 && (
        <p className="text-[11.5px] text-neutral-400 px-4 py-2.5 border-t border-dashed border-brand-50">
          Shaded: {months === 1 ? "1 month" : months + " months"} with more than one tenancy live on this property.
        </p>
      )}
    </div>
  );
}




export default function PropertyPage({
  property, tenants = [], utilities = [], hoas = [], loans = [], insurance = [], readOnly, userRole,
  onBack, onEdit, onUploadDoc, onWorkOrder, onOpenTenant, onAddTenant, onArchive,
  onDeactivate, onReactivate, onDelete, onRequestDelete,
  tabs,
}) {
  if (!property) return null;

  const p = property;
  const tenancies = tenants.map(t => ({
    id: t.id, name: t.name, raw: t,
    start: dateOf(t.lease_start || t.move_in),
    end: dateOf(t.lease_end_date || t.move_out),
    current: String(t.lease_status || "").toLowerCase() === "current",
    balance: safeNum(t.balance),
  }));
  const current = tenancies.filter(t => t.current);
  const owed = tenancies.reduce((n, t) => n + Math.max(t.balance, 0), 0);
  const inArrears = tenancies.filter(t => t.balance > 0).length;
  // A lease that ended before today, on a tenancy still marked current.
  const staleCurrent = current.filter(t => t.end && t.end.getTime() < Date.now());

  return (
    <div className="max-w-[1180px] mx-auto pb-16">

      <div className="text-[13px] text-neutral-400 mb-2.5">
        <TextLink tone="neutral" size="xs" onClick={onBack}>Properties</TextLink>
        <span className="mx-1.5">›</span>
        <span>{p.short_name || p.address_line_1 || p.address}</span>
      </div>

      <div className="bg-white border border-brand-50 rounded-2xl p-5 mb-3.5">
        <div className="flex gap-4 items-start flex-wrap">
          <div className="w-11 h-11 rounded-xl bg-brand-50 text-brand-700 grid place-items-center shrink-0">
            <span className="material-icons-outlined text-xl">home_work</span>
          </div>

          <div className="flex-1 min-w-[220px]">
            <h1 className="text-[22px] font-bold text-neutral-800 leading-tight">{p.short_name || p.address_line_1 || p.address}</h1>
            <div className="text-[13.5px] text-neutral-400 mt-0.5">
              {[p.address_line_2, p.city, p.state, p.zip].filter(Boolean).join(", ")}
              {p.county ? " · " + p.county : ""}
            </div>
            <div className="flex gap-1.5 flex-wrap mt-2">
              {p.type && <span className="text-[11.5px] font-semibold px-2.5 py-0.5 rounded-full bg-neutral-100 text-neutral-600">{p.type}</span>}
              {(p.bedrooms || p.bathrooms) && <span className="text-[11.5px] font-semibold px-2.5 py-0.5 rounded-full bg-neutral-100 text-neutral-600">{safeNum(p.bedrooms)} bd · {safeNum(p.bathrooms)} ba</span>}
              {p.sqft ? <span className="text-[11.5px] font-semibold px-2.5 py-0.5 rounded-full bg-neutral-100 text-neutral-600">{safeNum(p.sqft).toLocaleString()} sqft</span> : null}
              {p.year_built ? <span className="text-[11.5px] font-semibold px-2.5 py-0.5 rounded-full bg-neutral-100 text-neutral-600">Built {p.year_built}</span> : null}
              <span className={"text-[11.5px] font-semibold px-2.5 py-0.5 rounded-full capitalize "
                + (p.status === "occupied" ? "bg-positive-50 text-positive-700" : p.status === "vacant" ? "bg-warn-50 text-warn-700" : "bg-neutral-100 text-neutral-500")}>{p.status || "no status"}</span>
            </div>
          </div>

          <div className="text-right shrink-0 max-[620px]:text-left">
            <span className="block text-[11px] font-semibold tracking-[0.06em] uppercase text-neutral-400">
              {owed > 0 ? "Owed on this property" : "Monthly rent"}
            </span>
            <span className={"block text-3xl font-semibold tabular-nums tracking-tight mt-0.5 " + (owed > 0 ? "text-danger-600" : "text-neutral-700")}>
              {formatCurrency(owed > 0 ? owed : safeNum(p.rent))}
            </span>
            <span className="block text-xs text-neutral-400 mt-0.5">
              {owed > 0
                ? `${inArrears} of ${tenancies.length} tenant${tenancies.length === 1 ? "" : "s"} in arrears`
                : (safeNum(p.rent) > 0 ? "market rent on the property record" : "no rent set")}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] mt-4 border border-brand-50 rounded-xl overflow-hidden bg-neutral-50/60">
          <DetailPanel title="Property">
            <DetailRow label="Market rent" tone={safeNum(p.rent) > 0 ? undefined : "warn"}>{safeNum(p.rent) > 0 ? formatCurrency(p.rent) : "Not set"}</DetailRow>
            <DetailRow label="Deposit on file">{safeNum(p.security_deposit) > 0 ? formatCurrency(p.security_deposit) : <span className="text-neutral-400">None</span>}</DetailRow>
            <DetailRow label="Last inspection" tone={p.last_inspection ? undefined : "warn"}>{p.last_inspection ? fmtDate(p.last_inspection) : "Never recorded"}</DetailRow>
            <DetailRow label="Utilities">{utilities.length ? `${utilities.length} account${utilities.length === 1 ? "" : "s"}` : <span className="text-neutral-400">None configured</span>}</DetailRow>
          </DetailPanel>

          <DetailPanel title="Ownership">
            <DetailRow label="Owner">{p.owner_name || <span className="text-neutral-400">Not set</span>}</DetailRow>
            <DetailRow label="Manager">{p.pm_company_name || <span className="text-neutral-400">In-house</span>}</DetailRow>
            <DetailRow label="Class">{p.short_name || <span className="text-neutral-400">Not set</span>}</DetailRow>
            <DetailRow label="Tenancies">{tenancies.length} on record{current.length ? ` · ${current.length} current` : ""}</DetailRow>
          </DetailPanel>

          <DetailPanel title="Actions">
            <div className="grid grid-cols-2 gap-1.5">
              {!readOnly && <Btn variant="secondary" size="sm" className="w-full justify-center" onClick={() => onEdit?.(p)}>Edit property</Btn>}
              <Btn variant="secondary" size="sm" className="w-full justify-center" onClick={() => onAddTenant?.(p)}>Add tenant</Btn>
              <Btn variant="secondary" size="sm" className="w-full justify-center" onClick={() => onWorkOrder?.(p)}>Work order</Btn>
              <Btn variant="secondary" size="sm" className="w-full justify-center" onClick={() => onUploadDoc?.(p)}>Upload doc</Btn>
              {!readOnly && canManage(userRole) && p.status !== "inactive" && <Btn variant="secondary" size="sm" className="w-full justify-center text-warn-600" onClick={() => onDeactivate?.(p)}>Deactivate</Btn>}
              {!readOnly && canManage(userRole) && p.status === "inactive" && <Btn variant="secondary" size="sm" className="w-full justify-center text-positive-600" onClick={() => onReactivate?.(p)}>Reactivate</Btn>}
              {!readOnly && canManage(userRole) && <Btn variant="secondary" size="sm" className="w-full justify-center text-danger-600" onClick={() => onDelete?.(p)}>Delete</Btn>}
              {!readOnly && !canManage(userRole) && <Btn variant="secondary" size="sm" className="w-full justify-center col-span-2 text-danger-600" onClick={() => onRequestDelete?.(p)}>Request Delete</Btn>}
            </div>
          </DetailPanel>
        </div>
      </div>

      {current.length > 1 && (
        <div className="flex gap-2.5 items-start bg-warn-50 border border-warn-200 border-l-[3px] border-l-warn-500 rounded-r-xl px-3.5 py-2.5 mb-2.5 text-[13.5px] text-neutral-600">
          <span className="material-icons-outlined text-base text-warn-600">warning_amber</span>
          <div className="flex-1"><b className="text-neutral-800">{current.length} tenants are marked Current on this property.</b> If they are not sharing the unit, all but one need to be moved out or corrected.</div>
        </div>
      )}
      {staleCurrent.length > 0 && (
        <div className="flex gap-2.5 items-start bg-warn-50 border border-warn-200 border-l-[3px] border-l-warn-500 rounded-r-xl px-3.5 py-2.5 mb-2.5 text-[13.5px] text-neutral-600">
          <span className="material-icons-outlined text-base text-warn-600">warning_amber</span>
          <div className="flex-1">
            <b className="text-neutral-800">{staleCurrent.length === 1 ? "A lease has expired" : `${staleCurrent.length} leases have expired`}</b> while the tenancy still reads Current: {staleCurrent.map(t => `${t.name} (ended ${fmtDate(t.end)})`).join(", ")}.
          </div>
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1.85fr)_minmax(280px,1fr)] max-[940px]:grid-cols-1 gap-3.5 items-start">
        <div className="space-y-3.5">
          <Occupancy tenancies={tenancies} />

          <DetailCard title="Tenants" sub={`${tenancies.length} on record${current.length ? ` · ${current.length} current` : ""}`} flush
            action={<Btn variant="secondary" size="sm" onClick={() => onAddTenant?.(p)}>Add</Btn>}>
            {tenancies.length === 0 ? (
              <p className="px-4 py-8 text-center text-[13px] text-neutral-400">No tenant has ever been recorded against this property.</p>
            ) : tenancies.map((t, i) => (
              <div key={t.id || i} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 gap-y-1 items-center px-4 py-3 border-t border-brand-50 hover:bg-neutral-50">
                <div className="text-sm font-semibold text-neutral-800 truncate">
                  {t.name}
                  <span className={"text-[10.5px] font-bold tracking-wider uppercase px-1.5 py-px rounded ml-2 align-[1px] "
                    + (t.current ? "bg-positive-50 text-positive-700" : "bg-neutral-100 text-neutral-500")}>{t.current ? "Current" : "Past"}</span>
                </div>
                <div className="col-start-1 text-xs text-neutral-400">
                  {t.start
                    ? <>Lease {fmtDate(t.start)} – {t.end ? fmtDate(t.end) : "open"}</>
                    : <span className="text-warn-700">No lease dates recorded</span>}
                </div>
                <div className={"row-span-2 text-right tabular-nums text-sm whitespace-nowrap " + (t.balance > 0 ? "font-semibold text-danger-600" : "text-neutral-400")}>
                  {formatCurrency(Math.abs(t.balance))}{t.balance < 0 ? " cr" : ""}
                </div>
                <div className="row-span-2"><TextLink tone="brand" size="xs" onClick={() => onOpenTenant?.(t.raw)}>Open</TextLink></div>
              </div>
            ))}
          </DetailCard>

          {/* What this unit SHOULD bill, beside what each tenancy actually
              carries -- a property renting at $1,900 whose tenants are all
              recorded at $0.00 bills nothing, and nothing else on the page
              puts those two numbers next to each other. */}
          {tenancies.length > 0 && (
            <DetailCard title="Rent roll" sub="what this unit bills">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 py-2 border-b border-brand-50">
                <span className="text-[13px] text-neutral-700">Property market rent</span>
                <span className="row-span-2 self-center text-[13px] tabular-nums text-neutral-700">{formatCurrency(p.rent)}</span>
                <span className="text-[11.5px] text-neutral-400">set on the property record</span>
              </div>
              {current.map((t, i) => (
                <div key={t.id || i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 py-2 border-b border-brand-50 last:border-b-0">
                  <span className="text-[13px] text-neutral-700 truncate">{t.name}</span>
                  <span className={"row-span-2 self-center text-[13px] tabular-nums " + (safeNum(t.raw.rent) > 0 ? "text-neutral-700" : "text-warn-700")}>{formatCurrency(t.raw.rent)}</span>
                  <span className={"text-[11.5px] " + (safeNum(t.raw.rent) > 0 ? "text-neutral-400" : "text-warn-700")}>
                    {safeNum(t.raw.rent) > 0 ? "on the tenancy" : "rent not set — nothing bills automatically"}
                  </span>
                </div>
              ))}
            </DetailCard>
          )}
        </div>

        <div className="space-y-3.5">
          <DetailCard title="Utilities" sub={utilities.length ? `${utilities.length} account${utilities.length === 1 ? "" : "s"}` : null}>
            {utilities.length === 0 ? (
              <p className="text-[13px] text-neutral-400">No utilities configured for this property.</p>
            ) : utilities.map((u, i) => (
              <div key={u.id || i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-0.5 py-2 border-b border-brand-50 last:border-b-0">
                <span className="text-[13px] text-neutral-700 truncate">{u.provider || "Unnamed provider"}</span>
                <span className="row-span-2 self-center text-[11.5px] text-neutral-400 whitespace-nowrap">
                  {u.username_encrypted ? "credentials saved" : u.due_date ? "due " + fmtDate(u.due_date) : ""}
                </span>
                <span className="text-[11.5px] text-neutral-400 tabular-nums truncate">{u.account_number || "no account number"}</span>
              </div>
            ))}
          </DetailCard>

          {hoas.length > 0 && (
            <DetailCard title="HOA">
              {hoas.map((h, i) => (
                <div key={h.id || i} className="flex justify-between gap-3 text-[13px] py-1">
                  <span className="text-neutral-700 truncate">{h.hoa_name || h.name}</span>
                  <span className="text-neutral-400 whitespace-nowrap">{formatCurrency(h.amount)} · {h.frequency || "Monthly"}</span>
                </div>
              ))}
            </DetailCard>
          )}

          {/* Debt is owner-and-admin information, not something every staff
              role on a maintenance ticket should be shown. */}
          {(userRole === "admin" || userRole === "owner") && loans.length > 0 && (
            <DetailCard title="Loan / mortgage">
              {loans.map((l, i) => (
                <div key={l.id || i} className="py-1 border-b border-brand-50 last:border-b-0">
                  <div className="flex justify-between gap-3 text-[13px]">
                    <span className="text-neutral-700 truncate">{l.lender_name}</span>
                    <span className="text-[11px] bg-neutral-100 text-neutral-500 px-2 py-px rounded-full whitespace-nowrap">{l.loan_type || "Conventional"}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-1 text-[11.5px] text-neutral-500">
                    <div><span className="block text-neutral-400">Payment</span>{l.monthly_payment ? formatCurrency(l.monthly_payment) : "—"}</div>
                    <div><span className="block text-neutral-400">Balance</span>{l.current_balance ? formatCurrency(l.current_balance) : "—"}</div>
                    <div><span className="block text-neutral-400">Rate</span>{l.interest_rate ? l.interest_rate + "%" : "—"}</div>
                  </div>
                </div>
              ))}
            </DetailCard>
          )}

          <DetailCard title="Insurance" sub={insurance.length ? null : "none on file"}>
            {insurance.length === 0 ? (
              <p className="text-[13px] text-warn-700">No policy is recorded against this property.</p>
            ) : insurance.map((ins, i) => {
              const expired = ins.expiration_date && dateOf(ins.expiration_date) && dateOf(ins.expiration_date).getTime() < Date.now();
              return (
                <div key={ins.id || i} className="flex justify-between gap-3 py-1 border-b border-brand-50 last:border-b-0">
                  <div className="min-w-0">
                    <span className="text-[13px] text-neutral-700 truncate block">{ins.provider}</span>
                    {ins.policy_number && <span className="text-[11.5px] text-neutral-400">#{ins.policy_number}</span>}
                  </div>
                  <div className="text-right text-[11.5px] text-neutral-500 whitespace-nowrap">
                    {ins.premium_amount ? formatCurrency(ins.premium_amount) + "/" + String(ins.premium_frequency || "year").toLowerCase().slice(0, 3) : "—"}
                    {ins.expiration_date && <div className={expired ? "text-danger-600 font-medium" : ""}>{expired ? "Expired " : "Exp "}{fmtDate(ins.expiration_date)}</div>}
                  </div>
                </div>
              );
            })}
          </DetailCard>

          {(p.pm_company_name || p.notes) && (
            <DetailCard title="Notes">
              {p.pm_company_name && <DetailRow label="Property manager">{p.pm_company_name}</DetailRow>}
              {p.notes && <p className="text-[13px] text-neutral-500 mt-1">{p.notes}</p>}
            </DetailCard>
          )}
        </div>
      </div>

      {/* Documents, Licences, Work Orders and History keep their own tabs:
          each is a list with its own filters and actions, and folding four
          lists into one page would only rebuild the scrolling problem the
          drawer had. */}
      {tabs && <div className="mt-3.5 bg-white border border-brand-50 rounded-xl overflow-hidden">{tabs}</div>}
    </div>
  );
}
