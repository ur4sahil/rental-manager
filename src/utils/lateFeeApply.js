// The "Apply Late Fee" button, wherever it sits: a tenant's page and the
// Accounting ledger of their receivable account run this same function.
//
// Sahil, 2026-10-02: no automatic late fees; a button that charges 5% of
// the rent (or of a voucher tenant's own portion). The terms come from the
// tenant's own setting, else an active rule, else Settings; the fee is
// charged once a month, only after the due day plus the grace period, and
// posted DR the tenant's own receivable / CR Late Fee Income under the
// reference LATEFEE-<tenant>-YYYYMM, which refuses a duplicate.
import { supabase } from "../supabase";
import { formatCurrency } from "./helpers";
import { guardSubmit, guardRelease } from "./guards";
import { logAudit } from "./audit";
import { getPropertyClassId } from "./accounting";
import { postTenantLateFee, lateFeeAlreadyPosted, lateFeeMonth, lateFeeFailureReason } from "./lateFees";
import { lateFeeBase, lateFeeBaseLabel, lateFeeBusinessDate, resolveLateFeeTerms, computeLateFeeAmount, lateFeeEligibility, lateFeeDueDay, lateFeeOrdered, LATE_FEE_RULE_ORDER, LATE_FEE_LEASE_ORDER, LATE_FEE_SCHEDULE_ORDER } from "./lateFeeRules";

/**
 * Charge this month's late fee to one tenant, after asking. Explains every
 * refusal with a toast. Returns { posted, amount }.
 */
export async function applyLateFee({ companyId, tenant: t, companySettings = {}, showToast, showConfirm, addNotification = null, userProfile = null, userRole = "" }) {
  if (!t || !guardSubmit("lateFee", t.id)) return { posted: false };
  try {
    // Same four answers as the Late Fees page and the nightly job
    // (utils/lateFeeRules.js), in the job's own order so two active leases
    // give the same due day here as there.
    const [ruleRes, leaseRes, schedRes] = await Promise.all([
      lateFeeOrdered(supabase.from("late_fee_rules").select("fee_type, fee_amount, grace_days, is_active").eq("company_id", companyId).is("archived_at", null), LATE_FEE_RULE_ORDER).limit(20),
      lateFeeOrdered(supabase.from("leases").select("payment_due_day").eq("company_id", companyId).eq("tenant_id", t.id).eq("status", "active").gt("payment_due_day", 0), LATE_FEE_LEASE_ORDER).limit(5),
      lateFeeOrdered(supabase.from("recurring_journal_entries").select("day_of_month").eq("company_id", companyId).eq("tenant_id", t.id).eq("status", "active").is("archived_at", null).gt("day_of_month", 0), LATE_FEE_SCHEDULE_ORDER).limit(5),
    ]);
    const lfErr = ruleRes.error || leaseRes.error || schedRes.error;
    if (lfErr) { showToast("Could not load the late fee settings (" + lfErr.message + "). Nothing was posted.", "error"); return { posted: false }; }
    const rule = (ruleRes.data || []).find(r => r.is_active !== false) || null;
    const terms = resolveLateFeeTerms({ tenant: t, rule, settings: companySettings });
    if (terms.error) { showToast("Late fee not applied: " + terms.error + ".", "error"); return { posted: false }; }
    const today = lateFeeBusinessDate();
    const dueDay = lateFeeDueDay({ leases: leaseRes.data, schedules: schedRes.data });
    const elig = lateFeeEligibility({ tenant: t, today, dueDay, graceDays: terms.graceDays });
    if (!elig.ok) { showToast("Late fee not applied to " + t.name + ": " + elig.reason + ".", "warning"); return { posted: false }; }
    const base = lateFeeBase(t);
    const feeAmount = computeLateFeeAmount(terms, base);
    if (!feeAmount || feeAmount <= 0) { showToast("Late fee not applied: a percent fee needs the tenant's " + lateFeeBaseLabel(t) + " to be set.", "error"); return { posted: false }; }
    // Dedup: the shared one-per-month rule, checked here so the person is
    // told before the confirm dialog; postTenantLateFee checks again.
    const month = lateFeeMonth(today);
    const dup = await lateFeeAlreadyPosted(companyId, t.id, month);
    if (dup.error) { showToast("Could not check for an existing late fee (" + dup.error + "). Nothing was posted.", "error"); return { posted: false }; }
    if (dup.already) { showToast("Late fee already applied for " + t.name + " this month.", "warning"); return { posted: false }; }
    const monthName = new Date(today + "T12:00:00").toLocaleString("default", { month: "long", year: "numeric" });
    const feeLabel = terms.type === "percent" ? `${terms.amount}% of ${lateFeeBaseLabel(t)} $${base.toLocaleString()} = ${formatCurrency(feeAmount)}` : formatCurrency(feeAmount);
    if (!await showConfirm({ message: `Apply ${feeLabel} late fee to ${t.name} for ${monthName}?` })) return { posted: false };
    const classId = await getPropertyClassId(t.property, companyId);
    const res = await postTenantLateFee({ companyId, tenant: t, amount: feeAmount, date: today, classId,
      description: "Late fee — " + t.name + " — " + t.property,
      arMemo: "Late fee: " + t.name,
      incomeMemo: monthName + " late fee",
      ledgerDescription: `Late fee — ${monthName}`,
    });
    if (res.status === "duplicate") { showToast("Late fee already applied for " + t.name + " this month.", "warning"); return { posted: false }; }
    if (res.status !== "posted") { showToast("Late fee not applied: " + lateFeeFailureReason(res) + ". Nothing was posted.", "error"); return { posted: false }; }
    showToast(`Late fee ${formatCurrency(feeAmount)} applied to ${t.name}.`, "success");
    if (addNotification) addNotification("⚠️", `Late fee ${formatCurrency(feeAmount)} — ${t.name}`);
    logAudit("create", "late_fees", `Late fee ${formatCurrency(feeAmount)} for ${t.name}`, t.id, userProfile?.email, userRole, companyId);
    return { posted: true, amount: feeAmount };
  } finally { guardRelease("lateFee", t.id); }
}
