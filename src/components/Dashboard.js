import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { PageHeader, TextLink} from "../ui";
import { safeNum, parseLocalDate, formatLocalDate, formatCurrency, priorityColors } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { Badge, StatCard, Spinner } from "./shared";

// ============ DASHBOARD ============
function Dashboard({ companySettings = {}, notifications, setPage, companyId, addNotification, showToast, showConfirm }) {
  const [properties, setProperties] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [workOrders, setWorkOrders] = useState([]);
  const [payments, setPayments] = useState([]);
  const [utilities, setUtilities] = useState([]);
  const [hoaDue, setHoaDue] = useState([]);
  const [licensesDue, setLicensesDue] = useState([]);
  const [taxBillsDue, setTaxBillsDue] = useState([]);
  const [loading, setLoading] = useState(true);

  const [acctRevenue, setAcctRevenue] = useState(0);
  const [acctExpenses, setAcctExpenses] = useState(0);


  useEffect(() => {
  async function fetchData() {
  // Surface load failures as an error toast so the dashboard doesn't
  // silently render empty. Each bucket's `error` is logged individually
  // so the admin Error Log tells us which table went down.
  //
  // Column lists are the MINIMUM required by the stats + widgets below.
  // If you add a new Dashboard stat that reads a field not listed here,
  // you MUST add it to the select list — silent `undefined` reads will
  // quietly break the stat. Previously this was `select("*")`; at scale
  // that sends ~2-5 MB on first paint for a portfolio of a few dozen
  // properties and thousands of payments.
  const PROP_COLS = "id, address, status, pm_company_id";
  const TENANT_COLS = "id, name, property, balance, doc_status, lease_end_date, move_out, is_voucher, reexam_date, voucher_number";
  const WO_COLS = "id, status, priority, issue, property, cost";
  const PAY_COLS = "type, status, date, amount";
  const UTIL_COLS = "id, status, provider, property, responsibility, amount";
  const [p, t, w, pay, u] = await Promise.all([
  supabase.from("properties").select(PROP_COLS).eq("company_id", companyId).is("archived_at", null),
  supabase.from("tenants").select(TENANT_COLS).eq("company_id", companyId).is("archived_at", null),
  supabase.from("work_orders").select(WO_COLS).eq("company_id", companyId).is("archived_at", null),
  supabase.from("payments").select(PAY_COLS).eq("company_id", companyId).is("archived_at", null),
  supabase.from("utilities").select(UTIL_COLS).eq("company_id", companyId).is("archived_at", null),
  ]);
  if (p.error) pmError("PM-2002", { raw: p.error, context: "dashboard properties fetch", silent: true });
  if (t.error) pmError("PM-3002", { raw: t.error, context: "dashboard tenants fetch", silent: true });
  if (w.error) pmError("PM-7005", { raw: w.error, context: "dashboard work orders fetch", silent: true });
  if (pay.error) pmError("PM-6001", { raw: pay.error, context: "dashboard payments fetch", silent: true });
  if (u.error) pmError("PM-8006", { raw: u.error, context: "dashboard utilities fetch", silent: true });
  // PM-managed properties from other companies — same column shape as owned.
  const { data: managedProps, error: mpErr } = await supabase.from("properties").select(PROP_COLS).eq("pm_company_id", companyId).is("archived_at", null).limit(500);
  if (mpErr) pmError("PM-2002", { raw: mpErr, context: "dashboard managed properties fetch", silent: true });
  const allProps = (p.data || []).map(x => ({ ...x, _ownership: "owned" }));
  (managedProps || []).forEach(mp => { if (!allProps.find(x => x.id === mp.id)) allProps.push({ ...mp, _ownership: "managed", _readOnly: true }); });
  setProperties(allProps);
  setTenants(t.data || []);
  setWorkOrders(w.data || []);
  setPayments(pay.data || []);
  setUtilities(u.data || []);
  // Fetch upcoming HOA payments (due within 14 days)
  const fourteenDays = new Date(Date.now() + (companySettings.hoa_upcoming_window_days || 14) * 86400000).toISOString().slice(0, 10);
  const { data: hoaData, error: hoaErr } = await supabase.from("hoa_payments").select("*").eq("company_id", companyId).eq("status", "unpaid").is("archived_at", null).lte("due_date", fourteenDays).order("due_date", { ascending: true });
  if (hoaErr) pmError("PM-8006", { raw: hoaErr, context: "dashboard hoa fetch", silent: true });
  setHoaDue(hoaData || []);
  // Fetch upcoming license expirations — includes already-expired so they stay visible until renewed
  const licenseWindow = new Date(Date.now() + (companySettings.license_upcoming_window_days || 60) * 86400000).toISOString().slice(0, 10);
  const { data: licData, error: licErr } = await supabase.from("property_licenses").select("*").eq("company_id", companyId).is("archived_at", null).neq("status", "revoked").lte("expiry_date", licenseWindow).order("expiry_date", { ascending: true });
  if (licErr) pmError("PM-8006", { raw: licErr, context: "dashboard license fetch", silent: true });
  setLicensesDue(licData || []);
  // Fetch pending tax bills due within the next 30 days OR already overdue.
  const taxWindow = new Date(Date.now() + (companySettings.tax_bill_upcoming_window_days || 30) * 86400000).toISOString().slice(0, 10);
  const { data: taxData, error: taxErr } = await supabase.from("property_tax_bills").select("*").eq("company_id", companyId).eq("status", "pending").is("archived_at", null).lte("due_date", taxWindow).order("due_date", { ascending: true });
  if (taxErr) pmError("PM-8006", { raw: taxErr, context: "dashboard tax bills fetch", silent: true });
  setTaxBillsDue(taxData || []);
  // Pull financials from accounting module (journal entries are the GL source of truth,
  // but dashboard stats also reference payments/tenants tables for quick metrics)
  try {
  // Dashboard stats only need recent activity. Unbounded fetch would grow
  // with the JE table — at 10k entries/month this page would slow to a
  // crawl. Cap to the most recent 2000 posted entries by date.
  const { data: jeHeaders } = await supabase.from("acct_journal_entries").select("id").eq("company_id", companyId).eq("status", "posted").order("date", { ascending: false }).limit(2000);
  const jeIds = (jeHeaders || []).map(j => j.id);
  const { data: jeLines } = jeIds.length > 0 ? await supabase.from("acct_journal_lines").select("account_id, debit, credit").eq("company_id", companyId).in("journal_entry_id", jeIds) : { data: [] };
  const { data: accounts } = await supabase.from("acct_accounts").select("id, type").eq("company_id", companyId);
  if (jeLines && accounts) {
  const acctMap = {};
  accounts.forEach(a => { acctMap[a.id] = (a.type || "").toLowerCase(); });
  let rev = 0, exp = 0;
  jeLines.forEach(l => {
  const type = acctMap[l.account_id];
  if (type === "revenue" || type === "other income" || type === "income") rev += safeNum(l.credit) - safeNum(l.debit);
  if (type === "expense" || type === "cost of goods sold" || type === "other expense") exp += safeNum(l.debit) - safeNum(l.credit);
  });
  setAcctRevenue(rev);
  setAcctExpenses(exp);
  }
  } catch(e) { pmError("PM-4002", { raw: e, context: "dashboard accounting fetch", silent: true }); }
  setLoading(false);
  }
  fetchData();
  }, [companyId]);

  if (loading) return <Spinner />;

  const occupied = properties.filter(p => p.status === "occupied").length;
  const dashMonth = formatLocalDate(new Date()).slice(0, 7);
  const totalRent = payments.filter(p => p.type === "rent" && p.status === "paid" && p.date?.startsWith(dashMonth)).reduce((s, p) => s + safeNum(p.amount), 0);
  const delinquent = tenants.filter(t => t.balance > 0).length;
  const openWO = workOrders.filter(w => w.status !== "completed").length;

  return (
  <div>
  <div className="flex items-center justify-between mb-5">
  <PageHeader title="Dashboard" />
  </div>

  {/* Notifications accessible via bell icon in header */}

  <div className="grid grid-cols-2 gap-3 mb-4 md:grid-cols-4">
  <StatCard onClick={() => setPage("properties")} label="Occupancy" value={`${occupied}/${properties.length}`} sub={`${properties.length ? Math.round(occupied / properties.length * 100) : 0}% occupied`} color="text-positive-600" />
  <StatCard onClick={() => setPage("accounting")} label="Revenue (Acctg)" value={`${formatCurrency(acctRevenue)}`} sub="from journal entries" color="text-info-600" />
  <StatCard onClick={() => setPage("accounting")} label="Expenses (Acctg)" value={`${formatCurrency(acctExpenses)}`} sub="from journal entries" color="text-danger-500" />
  <StatCard onClick={() => setPage("accounting")} label="Net Income" value={formatCurrency(acctRevenue - acctExpenses)} sub="revenue - expenses" color={acctRevenue - acctExpenses >= 0 ? "text-success-600" : "text-danger-600"} />
  </div>
  <div className="grid grid-cols-2 gap-3 mb-6 md:grid-cols-4">
  <StatCard onClick={() => setPage("payments")} label="Rent Collected" value={`${formatCurrency(totalRent)}`} sub="payments table" color="text-brand-600" />
  <StatCard onClick={() => setPage("tenants")} label="Delinquent" value={delinquent} sub="tenants with balance" color="text-notice-500" />
  <StatCard onClick={() => setPage("maintenance")} label="Open Work Orders" value={openWO} sub={`${workOrders.filter(w => w.priority === "emergency").length} emergency`} color="text-notice-500" />
  <StatCard onClick={() => setPage("utilities")} label="Pending Utilities" value={utilities.filter(u => u.status === "pending").length} sub="awaiting payment" color="text-caution-600" />
  </div>
  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-4">
  <h3 className="font-semibold text-neutral-700 mb-3">Lease Expirations</h3>
  {(() => {
    // Compute the filtered list once so the empty-state check matches
    // what's actually rendered. Previously the display filtered by
    // (has end date AND in next 90 days) but the empty-state check
    // fired only when NO tenant had a move_out at all — properties
    // where every lease was >90 days out still showed a blank panel
    // with no explanation.
    const nowMs = Date.now();
    const expiring = tenants.filter(t => {
      const endStr = t.lease_end_date || t.move_out;
      if (!endStr) return false;
      const end = parseLocalDate(endStr);
      if (!(end instanceof Date) || isNaN(end)) return false;
      const daysUntil = Math.ceil((end - nowMs) / 86400000);
      return daysUntil >= 0 && daysUntil <= 90;
    });
    if (expiring.length === 0) {
      return <div className="text-sm text-neutral-400 text-center py-4">No upcoming lease expirations in the next 90 days</div>;
    }
    return expiring.map(t => (
      <div key={t.id} className="flex justify-between items-center py-2 border-b border-brand-50/50 last:border-0">
        <div>
          <div className="text-sm font-medium text-neutral-800">{t.name}</div>
          <div className="text-xs text-neutral-400">{t.property}</div>
        </div>
        <div className="text-sm text-notice-500 font-semibold">{t.lease_end_date || t.move_out}</div>
      </div>
    ));
  })()}
  </div>
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-4">
  <h3 className="font-semibold text-neutral-700 mb-3">Recent Maintenance</h3>
  {workOrders.slice(0, 3).map(w => (
  <div key={w.id} className="flex justify-between items-center py-2 border-b border-brand-50/50 last:border-0">
  <div>
  <div className="text-sm font-medium text-neutral-800">{w.issue}</div>
  <div className="text-xs text-neutral-400">{w.property}</div>
  </div>
  <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${priorityColors[w.priority]}`}>{w.priority}</span>
  </div>
  ))}
  {workOrders.length === 0 && <div className="text-sm text-neutral-400 text-center py-4">No recent maintenance</div>}
  </div>
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-4">
  <h3 className="font-semibold text-neutral-700 mb-3">Utilities Due</h3>
  {utilities.filter(u => u.status === "pending").map(u => (
  <div key={u.id} className="flex justify-between items-center py-2 border-b border-brand-50/50 last:border-0">
  <div>
  <div className="text-sm font-medium text-neutral-800">{u.provider}</div>
  <div className="text-xs text-neutral-400">{u.property} · {u.responsibility}</div>
  </div>
  <div className="text-right">
  <div className="text-sm font-semibold text-neutral-800">${u.amount}</div>
  <Badge status={u.status} />
  </div>
  </div>
  ))}
  {utilities.filter(u => u.status === "pending").length === 0 && <div className="text-sm text-neutral-400 text-center py-4">No pending utilities</div>}
  </div>
  {licensesDue.length > 0 && (() => {
  const LIC_LABELS = { rental_license: "Rental License", rental_registration: "Rental Registration", lead_paint: "Lead Paint Cert", lead_risk_assessment: "Lead Risk Assessment", fire_inspection: "Fire Inspection", bbl: "Business License (BBL)", other: "License" };
  const propById = Object.fromEntries(properties.map(p => [p.id, p.address]));
  return (
  <div className="bg-white rounded-3xl shadow-card border border-warn-200 p-4">
  <h3 className="font-semibold text-warn-700 mb-3 flex items-center justify-between">
  <span><span className="material-icons-outlined text-sm align-middle mr-1">verified</span>License Expirations</span>
  <TextLink tone="brand" size="xs" onClick={() => setPage("properties")} className="font-normal">View all</TextLink>
  </h3>
  {licensesDue.slice(0, 6).map(lic => {
  const daysLeft = Math.ceil((new Date(lic.expiry_date + "T00:00:00").getTime() - Date.now()) / 86400000);
  const expired = daysLeft < 0;
  const typeLabel = LIC_LABELS[lic.license_type] || lic.license_type_custom || "License";
  return (
  <div key={lic.id} onClick={() => setPage("properties")} className="flex justify-between items-center py-2 border-b border-warn-50 last:border-0 cursor-pointer hover:bg-warn-50/40 -mx-2 px-2 rounded">
  <div className="min-w-0">
  <div className="text-sm font-medium text-neutral-800 truncate">{typeLabel}{lic.jurisdiction ? <span className="text-xs text-neutral-400 font-normal"> · {lic.jurisdiction}</span> : null}</div>
  <div className="text-xs text-neutral-400 truncate">{propById[lic.property_id] || "Unknown property"}</div>
  </div>
  <div className="text-right shrink-0 ml-2">
  <div className="text-sm font-semibold">{lic.expiry_date}</div>
  <div className={`text-xs font-bold ${expired ? "text-danger-600" : daysLeft <= 30 ? "text-danger-500" : daysLeft <= 60 ? "text-warn-600" : "text-positive-600"}`}>{expired ? `Expired ${-daysLeft}d ago` : daysLeft === 0 ? "Expires today" : `${daysLeft}d left`}</div>
  </div>
  </div>
  );
  })}
  {licensesDue.length > 6 && <div className="text-xs text-neutral-400 text-center pt-2">+{licensesDue.length - 6} more</div>}
  </div>
  );
  })()}
  {taxBillsDue.length > 0 && (() => {
  return (
  <div className="bg-white rounded-3xl shadow-card border border-warn-200 p-4">
  <h3 className="font-semibold text-warn-700 mb-3 flex items-center justify-between">
  <span><span className="material-icons-outlined text-sm align-middle mr-1">receipt_long</span>Property Tax Bills Due</span>
  <TextLink tone="brand" size="xs" onClick={() => setPage("tax_bills")} className="font-normal">Manage</TextLink>
  </h3>
  {taxBillsDue.slice(0, 6).map(tb => {
  const d = parseLocalDate(tb.due_date);
  d.setHours(0, 0, 0, 0);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const daysLeft = Math.ceil((d - now) / 86400000);
  const overdue = daysLeft < 0;
  return (
  <div key={tb.id} onClick={() => setPage("tax_bills")} className="flex justify-between items-center py-2 border-b border-warn-50 last:border-0 cursor-pointer hover:bg-warn-50/40 -mx-2 px-2 rounded">
  <div className="min-w-0">
  <div className="text-sm font-medium text-neutral-800 truncate">{tb.installment_label} <span className="text-xs text-neutral-400 font-normal">· {tb.tax_year}</span></div>
  <div className="text-xs text-neutral-400 truncate">{tb.property}</div>
  </div>
  <div className="text-right shrink-0 ml-2">
  <div className="text-sm font-semibold">{tb.due_date}</div>
  <div className={`text-xs font-bold ${overdue ? "text-danger-600" : daysLeft <= 7 ? "text-danger-500" : daysLeft <= 14 ? "text-warn-600" : "text-warn-600"}`}>{overdue ? `Overdue ${-daysLeft}d` : daysLeft === 0 ? "Due today" : `${daysLeft}d left`}</div>
  </div>
  </div>
  );
  })}
  {taxBillsDue.length > 6 && <div className="text-xs text-neutral-400 text-center pt-2 cursor-pointer hover:text-neutral-600" onClick={() => setPage("tax_bills")}>+{taxBillsDue.length - 6} more — view all</div>}
  </div>
  );
  })()}
  {hoaDue.length > 0 && (
  <div className="bg-white rounded-3xl shadow-card border border-warn-100 p-4">
  <h3 className="font-semibold text-warn-700 mb-3"><span className="material-icons-outlined text-sm align-middle mr-1">holiday_village</span>HOA Payments Due</h3>
  {hoaDue.map(h => {
  const daysLeft = Math.ceil((new Date(h.due_date).getTime() - Date.now()) / 86400000);
  return (
  <div key={h.id} className="flex justify-between items-center py-2 border-b border-warn-50 last:border-0">
  <div>
  <div className="text-sm font-medium text-neutral-800">{h.hoa_name}</div>
  <div className="text-xs text-neutral-400">{h.property}</div>
  </div>
  <div className="text-right">
  <div className="text-sm font-semibold text-warn-700">${safeNum(h.amount).toLocaleString()}</div>
  <div className={`text-xs ${daysLeft <= 3 ? "text-danger-500 font-bold" : "text-warn-500"}`}>{daysLeft <= 0 ? "OVERDUE" : `${daysLeft}d left`}</div>
  </div>
  </div>);
  })}
  </div>
  )}
  {/* Voucher Re-examination Alerts */}
  {(() => { const reexamTenants = tenants.filter(t => t.is_voucher && t.reexam_date && Math.ceil((new Date(t.reexam_date).getTime() - Date.now()) / 86400000) <= (companySettings.voucher_reexam_window_days || 120) && Math.ceil((new Date(t.reexam_date).getTime() - Date.now()) / 86400000) >= -30); return reexamTenants.length > 0 ? (
  <div className="bg-white rounded-3xl shadow-card border border-highlight-200 p-4">
  <h3 className="font-semibold text-highlight-700 mb-3"><span className="material-icons-outlined text-sm align-middle mr-1">event</span>Voucher Re-examination Due</h3>
  {reexamTenants.map(t => {
  const daysLeft = Math.ceil((new Date(t.reexam_date).getTime() - Date.now()) / 86400000);
  return (
  <div key={t.id} className="flex justify-between items-center py-2 border-b border-highlight-50 last:border-0">
  <div>
  <div className="text-sm font-medium text-neutral-800">{t.name} <span className="text-xs bg-highlight-100 text-highlight-700 px-1.5 py-0.5 rounded-full ml-1">Voucher</span></div>
  <div className="text-xs text-neutral-400">{t.property}{t.voucher_number ? " · " + t.voucher_number : ""}</div>
  </div>
  <div className="text-right">
  <div className="text-sm font-semibold">{t.reexam_date}</div>
  <div className={`text-xs font-bold ${daysLeft <= 0 ? "text-danger-600" : daysLeft <= 30 ? "text-danger-500" : daysLeft <= 60 ? "text-warn-600" : "text-highlight-600"}`}>{daysLeft <= 0 ? "OVERDUE" : `${daysLeft} days left`}</div>
  </div>
  </div>);
  })}
  </div>
  ) : null; })()}
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-4">
  <h3 className="font-semibold text-neutral-700 mb-3">Net Operating Income</h3>
  <div className="space-y-2">
  {[
  ["Gross Rent Collected", `${formatCurrency(totalRent)}`, "text-positive-600"],
  ["Maintenance Costs", `-$${workOrders.reduce((s, w) => s + safeNum(w.cost), 0).toLocaleString()}`, "text-danger-500"],
  ["Utility Expenses", `-$${utilities.reduce((s, u) => s + safeNum(u.amount), 0).toLocaleString()}`, "text-danger-500"],
  ["NOI", `$${(totalRent - workOrders.reduce((s, w) => s + safeNum(w.cost), 0) - utilities.reduce((s, u) => s + safeNum(u.amount), 0)).toLocaleString()}`, "text-info-700 font-bold"],
  ].map(([l, v, c]) => (
  <div key={l} className="flex justify-between">
  <span className="text-sm text-neutral-500">{l}</span>
  <span className={`text-sm ${c}`}>{v}</span>
  </div>
  ))}
  </div>
  </div>
  </div>
  </div>
  );
}

export { Dashboard };
