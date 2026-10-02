// Starting a tenancy's books, for a prospect who has just been converted.
//
// convert_prospect_to_tenant (the database function) has already made the
// tenant, the lease and the occupied property in one transaction. This is
// the other half: the receivable ledger, the monthly rent schedule, the
// deposit and the first month's rent.
//
// EVERY STEP CAN BE RUN AGAIN. Each one first looks for what it would
// create -- the tenant's ledger by tenant id, the schedule by tenant id,
// each entry by its reference -- and skips it if it is there. So a dropped
// connection halfway through is repaired by pressing "Finish setup", never
// by charging something twice. The references are the same ones the
// property wizard uses (DEP-T<id>, RENT1-/PRORENT-T<id>-<date>,
// RECUR-<schedule>-<month>), so the wizard, the Tenants page and this
// function all recognise each other's entries.
import { supabase } from "../supabase";
import { escapeFilterValue, propertyLabel, formatLocalDate } from "./helpers";
import { pmError } from "./errors";
import {
  tenantOwnArAccountId, resolveAccountId, getPropertyClassId, depositReference, depositAlreadyPosted,
  atomicPostJEAndLedger, autoPostJournalEntry, autoPostRecurringEntries, checkPeriodLock,
} from "./accounting";
import { planTenancyCharges } from "./onboardingRules";

/**
 * @param {{ companyId: string, tenantId: number|string, tenantName: string, property: string,
 *           leaseStart: string, rent: number, deposit?: number, userEmail?: string, today?: string }} args
 * @returns {Promise<{ ok: boolean, steps: Array<{key:string,label:string,status:"done"|"already"|"failed"|"locked",detail?:string}>, failures: string[] }>}
 */
export async function startTenancyBooks({ companyId, tenantId, tenantName, property, leaseStart, rent, deposit = 0, userEmail = "", today = formatLocalDate(new Date()) }) {
  const steps = [];
  const add = (key, label, status, detail = "") => { steps.push({ key, label, status, detail }); return status; };
  const finish = () => ({
    ok: steps.every(s => s.status === "done" || s.status === "already"),
    steps,
    failures: steps.filter(s => s.status === "failed" || s.status === "locked").map(s => s.label + (s.detail ? " (" + s.detail + ")" : "")),
  });

  const plan = planTenancyCharges({ leaseStart, rent, deposit, today });
  if (!companyId || tenantId === null || tenantId === undefined || tenantId === "" || !tenantName || !property) {
    add("input", "Tenant details", "failed", "missing company, tenant or property");
    return finish();
  }
  if (!plan.ok) { add("input", "Lease terms", "failed", plan.error); return finish(); }
  const name = String(tenantName).trim();
  const tid = Number(tenantId);

  // ── 1. the tenant's own receivable ledger (never the shared 1100)
  let arId = null, revenueId = null, classId = null;
  try {
    arId = await tenantOwnArAccountId(companyId, name, tid);
    revenueId = await resolveAccountId("4000", companyId);
    classId = await getPropertyClassId(property, companyId);
  } catch (e) { pmError("PM-4006", { raw: e, context: "tenancy books: accounts", silent: true }); }
  if (!arId || !revenueId) {
    add("ledger", "Tenant ledger", "failed", !arId ? "the tenant's receivable ledger could not be created" : "Rental Income (4000) not found");
    return finish();   // nothing below can be posted without it
  }
  add("ledger", "Tenant ledger", "done");

  // ── 2. the monthly rent schedule (one per tenant; the database enforces it)
  let schedule = null;
  try {
    const { data: existing, error: exErr } = await supabase.from("recurring_journal_entries")
      .select("id, description").eq("company_id", companyId).eq("tenant_id", tid)
      .eq("status", "active").is("archived_at", null).limit(1).maybeSingle();
    if (exErr) throw exErr;
    if (existing) { schedule = existing; add("schedule", "Monthly rent schedule", "already"); }
    else {
      const { data: made, error } = await supabase.from("recurring_journal_entries").insert([{
        company_id: companyId,
        description: "Monthly rent — " + name + " — " + propertyLabel(property),
        frequency: "monthly", day_of_month: 1, amount: plan.monthly,
        tenant_name: name, tenant_id: tid, property,
        debit_account_id: arId, debit_account_name: "AR - " + name,
        credit_account_id: revenueId, credit_account_name: "Rental Income",
        status: "active", next_post_date: plan.scheduleFrom, created_by: userEmail || "",
      }]).select("id, description").maybeSingle();
      if (error || !made) throw error || new Error("schedule was not created");
      schedule = made;
      add("schedule", "Monthly rent schedule", "done", "from " + plan.scheduleFrom);
    }
  } catch (e) {
    pmError("PM-4008", { raw: e, context: "tenancy books: rent schedule", silent: true });
    add("schedule", "Monthly rent schedule", "failed", e?.message || "");
  }

  // ── 3. security deposit: owed, then paid (DR the tenant's ledger, CR 2100)
  if (plan.deposit) {
    try {
      if (await depositAlreadyPosted(companyId, tid)) add("deposit", "Security deposit", "already");
      else if (await checkPeriodLock(companyId, plan.deposit.date)) add("deposit", "Security deposit", "locked", "the books are closed for " + plan.deposit.date);
      else {
        const res = await atomicPostJEAndLedger({
          companyId, date: plan.deposit.date,
          description: "Security deposit received — " + name + " — " + property,
          reference: depositReference(tid), property,
          lines: [
            { account_id: arId, account_name: "AR - " + name, debit: plan.deposit.amount, credit: 0, class_id: classId, memo: "Security deposit from " + name },
            { account_id: "2100", account_name: "Security Deposits Held", debit: 0, credit: plan.deposit.amount, class_id: classId, memo: name + " — " + property },
          ],
          ledgerEntry: { tenant: name, tenant_id: tid, property, date: plan.deposit.date, description: "Security deposit collected", amount: plan.deposit.amount, type: "deposit" },
        });
        add("deposit", "Security deposit", res?.jeId ? "done" : "failed", res?.jeId ? "" : (res?.error || "entry was not posted"));
      }
    } catch (e) {
      pmError("PM-4002", { raw: e, context: "tenancy books: deposit", silent: true });
      add("deposit", "Security deposit", "failed", e?.message || "");
    }
  }

  // ── 4. first month's rent (full, or prorated from the lease start)
  try {
    // Matched by PREFIX: a corrected lease start changes the date in the
    // reference, and an exact match would then charge the first month twice.
    // The prefix ends with the hyphen after the tenant id, so T12 cannot match T123.
    const prefix = escapeFilterValue("T" + tid + "-");
    const hits = await Promise.all(["RENT1-", "PRORENT-"].map(fam =>
      supabase.from("acct_journal_entries").select("id").eq("company_id", companyId).neq("status", "voided")
        .like("reference", fam + prefix + "%").limit(1)));
    // A failed lookup must not read as "nothing posted".
    if (hits.some(h => h.error)) add("first", "First month's rent", "failed", "could not check whether it was already posted");
    else if (hits.some(h => (h.data || []).length)) add("first", "First month's rent", "already");
    else if (await checkPeriodLock(companyId, plan.firstMonth.date)) add("first", "First month's rent", "locked", "the books are closed for " + plan.firstMonth.date);
    else {
      const key = plan.firstMonth.date.replace(/-/g, "");
      const prorated = plan.firstMonth.kind === "prorated";
      const what = prorated ? `Prorated rent (${plan.firstMonth.days}/${plan.firstMonth.daysInMonth} days)` : "First month rent";
      const res = await atomicPostJEAndLedger({
        companyId, date: plan.firstMonth.date,
        description: what + " — " + name + " — " + String(property).split(",")[0],
        reference: (prorated ? "PRORENT-T" : "RENT1-T") + tid + "-" + key, property,
        lines: [
          { account_id: arId, account_name: "AR - " + name, debit: plan.firstMonth.amount, credit: 0, class_id: classId, memo: prorated ? "Prorated first month rent" : "First month rent" },
          { account_id: revenueId, account_name: "Rental Income", debit: 0, credit: plan.firstMonth.amount, class_id: classId, memo: prorated ? `${plan.firstMonth.days}/${plan.firstMonth.daysInMonth} days @ $${plan.monthly}/mo` : "Full month rent" },
        ],
        ledgerEntry: { tenant: name, tenant_id: tid, property, date: plan.firstMonth.date, description: what, amount: plan.firstMonth.amount, type: "charge" },
      });
      add("first", "First month's rent", res?.jeId ? "done" : "failed", res?.jeId ? "" : (res?.error || "entry was not posted"));
    }
  } catch (e) {
    pmError("PM-4002", { raw: e, context: "tenancy books: first month", silent: true });
    add("first", "First month's rent", "failed", e?.message || "");
  }

  // ── 5. whole months that passed before today (see onboardingRules.js).
  // Posted under the schedule's own reference, so the recurring worker
  // recognises them as its months and never bills one of them again.
  if (plan.catchUp.length) {
    if (!schedule?.id) add("catchup", "Rent for months already passed", "failed", "no rent schedule to post them under");
    else {
      for (const month of plan.catchUp) {
        const label = "Rent for " + month;
        try {
          const ref = "RECUR-" + String(schedule.id).slice(0, 8) + "-" + month;
          const date = month + "-01";
          const { data: have, error: haveErr } = await supabase.from("acct_journal_entries").select("id")
            .eq("company_id", companyId).eq("reference", ref).neq("status", "voided").limit(1);
          if (haveErr) { add("catchup-" + month, label, "failed", "could not check whether it was already posted"); continue; }
          if ((have || []).length) { add("catchup-" + month, label, "already"); continue; }
          if (await checkPeriodLock(companyId, date)) { add("catchup-" + month, label, "locked", "the books are closed for " + month); continue; }
          const desc = schedule.description || ("Monthly rent — " + name + " — " + propertyLabel(property));
          const jeId = await autoPostJournalEntry({
            companyId, date, description: desc, reference: ref, property,
            lines: [
              { account_id: arId, account_name: "AR - " + name, debit: plan.monthly, credit: 0, class_id: classId, memo: desc },
              { account_id: revenueId, account_name: "Rental Income", debit: 0, credit: plan.monthly, class_id: classId, memo: desc },
            ],
          });
          add("catchup-" + month, label, jeId ? "done" : "failed", jeId ? "" : "entry was not posted");
        } catch (e) {
          pmError("PM-4002", { raw: e, context: "tenancy books: catch-up " + month, silent: true });
          add("catchup-" + month, label, "failed", e?.message || "");
        }
      }
    }
  }

  // ── 6. let the schedule post anything that is already due (this month's rent)
  try { await autoPostRecurringEntries(companyId); }
  catch (e) { pmError("PM-4008", { raw: e, context: "tenancy books: recurring catch-up", silent: true }); }

  return finish();
}
