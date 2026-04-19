// Property-tax bill generation. Stateless helpers that consume the
// COUNTY_TAX_SCHEDULES rules from helpers.js and upsert per-installment
// rows into property_tax_bills.
//
// Design principle: generation is IDEMPOTENT and NON-DESTRUCTIVE.
// - Re-running this for the same (company, property, year) is safe.
// - Existing rows are NEVER overwritten if the user has already touched
//   them (paid, skipped, or due_date edited). We only backfill
//   expected_amount if the user hasn't paid yet.
// - Manually-added bills (auto_generated=false) are left alone.
import { supabase } from "../supabase";
import { COUNTY_TAX_SCHEDULES } from "./helpers";
import { pmError } from "./errors";

/** YYYY-MM-DD for a local date (no UTC shift). */
function localISODate(y, m, d) {
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return y + "-" + mm + "-" + dd;
}

/**
 * Generate (or refresh) the per-installment tax bills for a single property
 * in a specific tax year, based on its county/state schedule.
 *
 * Safe to call repeatedly on the same property. Returns {created, updated, skipped, reason?}.
 *
 *  params:
 *    companyId            — (required)
 *    propertyAddress      — stored as `property` on the bill rows (required)
 *    propertyId           — integer FK (optional, stored if provided)
 *    county + state       — drives the schedule lookup (required)
 *    taxYear              — calendar year the installments fall in (default: current)
 *    expectedAnnualAmount — if provided, each installment's expected_amount
 *                           is set to (annual / N installments) for any
 *                           still-pending rows
 */
export async function generateBillsForProperty({
  companyId,
  propertyAddress,
  propertyId = null,
  county,
  state,
  taxYear,
  expectedAnnualAmount = null,
}) {
  if (!companyId || !propertyAddress || !county || !state) {
    return { created: 0, updated: 0, skipped: 0, reason: "missing_input" };
  }
  const year = Number(taxYear) || new Date().getFullYear();
  const key = county + "|" + state;
  const schedule = COUNTY_TAX_SCHEDULES[key];
  if (!schedule || schedule.length === 0) {
    return { created: 0, updated: 0, skipped: 0, reason: "no_schedule_for_jurisdiction" };
  }

  const annual = expectedAnnualAmount != null && !Number.isNaN(Number(expectedAnnualAmount))
    ? Number(expectedAnnualAmount)
    : null;
  const perInstallment = annual != null ? annual / schedule.length : null;

  let created = 0, updated = 0, skipped = 0;
  for (const inst of schedule) {
    const dueDate = localISODate(year, inst.month, inst.day);
    const { data: existing, error: selErr } = await supabase
      .from("property_tax_bills")
      .select("id, status, paid_date, expected_amount")
      .eq("company_id", companyId)
      .eq("property", propertyAddress)
      .eq("tax_year", year)
      .eq("installment_label", inst.label)
      .eq("auto_generated", true)
      .is("archived_at", null)
      .maybeSingle();
    if (selErr) {
      pmError("PM-8006", { raw: selErr, context: "read existing tax bill " + inst.label + " " + year, silent: true });
      skipped++;
      continue;
    }

    if (existing) {
      // Backfill expected_amount for still-pending rows if we now have one.
      if (perInstallment != null && existing.status === "pending" && !existing.paid_date) {
        const { error } = await supabase
          .from("property_tax_bills")
          .update({ expected_amount: perInstallment })
          .eq("id", existing.id);
        if (!error) { updated++; continue; }
        pmError("PM-8006", { raw: error, context: "backfill expected_amount on tax bill", silent: true });
      }
      skipped++;
      continue;
    }

    const row = {
      company_id: companyId,
      property: propertyAddress,
      property_id: propertyId || null,
      tax_year: year,
      installment_label: inst.label,
      due_date: dueDate,
      expected_amount: perInstallment,
      status: "pending",
      auto_generated: true,
    };
    const { error: insErr } = await supabase.from("property_tax_bills").insert([row]);
    if (insErr) {
      pmError("PM-8006", { raw: insErr, context: "insert tax bill " + inst.label + " " + year, silent: true });
      skipped++;
      continue;
    }
    created++;
  }
  return { created, updated, skipped };
}

/**
 * Mark a bill paid. Separate helper so the upcoming /tax-bills page +
 * dashboard widget + cron all share the same transition logic.
 *
 * We intentionally do NOT auto-post a journal entry (per Sahil's scope
 * cut — bank-recon posting comes later). Just updates the bill row.
 */
export async function markBillPaid({ billId, paidDate, paidAmount, paidNotes, companyId }) {
  if (!billId || !companyId) return { ok: false, reason: "missing_input" };
  const { error } = await supabase
    .from("property_tax_bills")
    .update({
      status: "paid",
      paid_date: paidDate || new Date().toISOString().slice(0, 10),
      paid_amount: paidAmount != null && paidAmount !== "" ? Number(paidAmount) : null,
      paid_notes: (paidNotes || "").trim() || null,
    })
    .eq("id", billId)
    .eq("company_id", companyId);
  if (error) {
    pmError("PM-8006", { raw: error, context: "mark tax bill paid" });
    return { ok: false, reason: error.message };
  }
  return { ok: true };
}

/** Revert status to pending (undo). */
export async function unmarkBillPaid({ billId, companyId }) {
  const { error } = await supabase
    .from("property_tax_bills")
    .update({ status: "pending", paid_date: null, paid_amount: null, paid_notes: null })
    .eq("id", billId)
    .eq("company_id", companyId);
  if (error) {
    pmError("PM-8006", { raw: error, context: "unmark tax bill paid" });
    return { ok: false, reason: error.message };
  }
  return { ok: true };
}

/** Skip a bill (e.g. escrow covers it — hides from pending). */
export async function skipBill({ billId, companyId, reason }) {
  const { error } = await supabase
    .from("property_tax_bills")
    .update({ status: "skipped", paid_notes: reason || null })
    .eq("id", billId)
    .eq("company_id", companyId);
  if (error) {
    pmError("PM-8006", { raw: error, context: "skip tax bill" });
    return { ok: false, reason: error.message };
  }
  return { ok: true };
}
