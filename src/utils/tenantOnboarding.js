// Starting a tenancy's books. ONE way, for every screen that can make a
// tenant: Prospects (convert), the Tenants page, the property wizard, the
// property form and Leases "Create lease".
//
// The tenant, the lease and the occupied property already exist when this
// runs (the screens and convert_prospect_to_tenant make those). This is the
// other half: the receivable ledger, the monthly rent schedule, the deposit
// and the first month's rent.
//
// Two modes (the rules are in onboardingRules.js):
//   "new"      a move-in: deposit, first (possibly part) month, the whole
//              months already passed, and the monthly schedule;
//   "running"  someone who already lives there: the monthly schedule only.
// A tenant whose ledger already carries charges from before the lease start
// is a RENEWAL, whatever the caller asked for, and is treated as "running":
// a renewal lease starting on the 3rd once produced a second deposit and a
// 28-day "first month" for a tenant of several years.
//
// EVERY STEP CAN BE RUN AGAIN. Each one first looks for what it would
// create -- the tenant's ledger by tenant id, the schedule by tenant id,
// each entry by its reference, each month by a rent charge already on the
// ledger -- and skips it if it is there. So a dropped connection halfway
// through is repaired by running it again, never by charging something
// twice. The references are the ones the property wizard always used
// (DEP-T<id>, RENT1-/PRORENT-T<id>-<date>, RECUR-<schedule>-<month>).
import { supabase } from "../supabase";
import { escapeFilterValue, propertyLabel, formatLocalDate } from "./helpers";
import { pmError } from "./errors";
import {
  tenantOwnArAccountId, resolveAccountId, getPropertyClassId, depositReference, depositAlreadyPosted,
  atomicPostJEAndLedger, autoPostJournalEntry, autoPostRecurringEntries, checkPeriodLock,
} from "./accounting";
import { planTenancyCharges, isRentCharge, runningBillFrom } from "./onboardingRules";

/**
 * What the tenant's ledger and schedule look like right now. Read by the
 * "start billing" dialog (to offer the right mode) and by startTenancyBooks
 * (to refuse to charge a month twice).
 *
 * @returns {Promise<{ ok: boolean, error?: string, arId: string|null, continuing: boolean,
 *   rentMonths: string[], chargedThisMonth: boolean, schedule: null|{id:string,amount:number,next_post_date:string,description:string} }>}
 */
export async function tenantLedgerFacts({ companyId, tenantId, tenantName, leaseStart = "", today = formatLocalDate(new Date()) }) {
  const out = { ok: false, arId: null, continuing: false, rentMonths: [], chargedThisMonth: false, schedule: null };
  try {
    const tid = Number(tenantId);
    const arId = await tenantOwnArAccountId(companyId, String(tenantName || "").trim(), tid);
    if (!arId) return { ...out, error: "the tenant's receivable ledger could not be found or created" };
    out.arId = arId;
    const start = String(leaseStart || "").slice(0, 10);
    const hasStart = /^\d{4}-\d{2}-\d{2}$/.test(start);
    const from = hasStart && start.slice(0, 7) < today.slice(0, 7) ? start.slice(0, 7) + "-01" : today.slice(0, 7) + "-01";
    const [earlier, later, sched] = await Promise.all([
      // Charged before this lease began? Then they already live there. A
      // deposit taken ahead of move-in is not rent and does not count; a
      // null memo must (imported rent lines have none).
      hasStart ? supabase.from("acct_journal_lines")
        .select("id, acct_journal_entries!inner(date, status)")
        .eq("company_id", companyId).eq("account_id", arId).gt("debit", 0)
        .neq("acct_journal_entries.status", "voided").lt("acct_journal_entries.date", start)
        .or("memo.is.null,memo.not.ilike.%deposit%").limit(1) : Promise.resolve({ data: [] }),
      supabase.from("acct_journal_lines")
        .select("memo, debit, acct_journal_entries!inner(reference, date, status, description)")
        .eq("company_id", companyId).eq("account_id", arId).gt("debit", 0)
        .neq("acct_journal_entries.status", "voided").gte("acct_journal_entries.date", from).limit(1000),
      supabase.from("recurring_journal_entries").select("id, amount, next_post_date, description")
        .eq("company_id", companyId).eq("tenant_id", tid).eq("status", "active").is("archived_at", null).limit(1).maybeSingle(),
    ]);
    if (earlier.error || later.error || sched.error) return { ...out, error: "the tenant's ledger could not be read" };
    out.continuing = (earlier.data || []).length > 0;
    const months = new Set();
    for (const l of later.data || []) {
      const je = Array.isArray(l.acct_journal_entries) ? l.acct_journal_entries[0] : l.acct_journal_entries;
      if (je && isRentCharge({ reference: je.reference, memo: l.memo, description: je.description })) months.add(String(je.date || "").slice(0, 7));
    }
    out.rentMonths = [...months].sort();
    out.chargedThisMonth = months.has(today.slice(0, 7));
    out.schedule = sched.data || null;
    out.ok = true;
    return out;
  } catch (e) {
    pmError("PM-4006", { raw: e, context: "tenancy books: read ledger", silent: true });
    return { ...out, error: e?.message || "the tenant's ledger could not be read" };
  }
}

/** Does this tenant have an active rent schedule? A failed lookup answers yes: never offer to make a second. */
export async function tenantHasRentSchedule(companyId, tenantId) {
  const { data, error } = await supabase.from("recurring_journal_entries").select("id")
    .eq("company_id", companyId).eq("tenant_id", Number(tenantId)).eq("status", "active").is("archived_at", null).limit(1);
  return !!error || (data || []).length > 0;
}

/**
 * @param {{ companyId: string, tenantId: number|string, tenantName: string, property: string,
 *           leaseStart: string, rent: number, deposit?: number, userEmail?: string, today?: string,
 *           mode?: "new"|"running", billFrom?: string, createSchedule?: boolean, catchUp?: "always"|"first-run" }} args
 *   mode            see the top of this file. Default "new".
 *   billFrom        "running" only: the first month the schedule bills ("YYYY-MM-01"). Default: this
 *                   month, or next month when this month's rent is already on the ledger.
 *   createSchedule  false when the caller makes the schedule itself (the property wizard's RPC does).
 *   catchUp         "first-run": only charge the months already passed in the same run that posts the
 *                   first month. The wizard is re-saved for years; it must never go back and bill.
 * @returns {Promise<{ ok: boolean, mode: "new"|"running", continuing: boolean,
 *   steps: Array<{key:string,label:string,status:"done"|"already"|"skipped"|"failed"|"locked",detail?:string}>, failures: string[] }>}
 */
export async function startTenancyBooks({
  companyId, tenantId, tenantName, property, leaseStart, rent, deposit = 0, userEmail = "",
  today = formatLocalDate(new Date()), mode = "new", billFrom = "", createSchedule = true, catchUp = "always",
}) {
  const steps = [];
  let effectiveMode = mode === "running" ? "running" : "new";
  let continuing = false;
  const add = (key, label, status, detail = "") => { steps.push({ key, label, status, detail }); return status; };
  const finish = () => ({
    ok: steps.every(s => s.status === "done" || s.status === "already" || s.status === "skipped"),
    mode: effectiveMode, continuing, steps,
    failures: steps.filter(s => s.status === "failed" || s.status === "locked").map(s => s.label + (s.detail ? " (" + s.detail + ")" : "")),
  });

  if (!companyId || tenantId === null || tenantId === undefined || tenantId === "" || !tenantName || !property) {
    add("input", "Tenant details", "failed", "missing company, tenant or property");
    return finish();
  }
  const monthly = Math.round(Number(rent) * 100) / 100;
  if (!(monthly > 0)) { add("input", "Lease terms", "failed", "The rent must be more than zero."); return finish(); }
  const name = String(tenantName).trim();
  const tid = Number(tenantId);

  // ── 1. the tenant's own receivable ledger (never the shared 1100), and
  // what is already on it
  let revenueId = null, classId = null;
  const facts = await tenantLedgerFacts({ companyId, tenantId: tid, tenantName: name, leaseStart, today });
  const arId = facts.arId;
  try {
    revenueId = await resolveAccountId("4000", companyId);
    classId = await getPropertyClassId(property, companyId);
  } catch (e) { pmError("PM-4006", { raw: e, context: "tenancy books: accounts", silent: true }); }
  if (!arId || !revenueId || !facts.ok) {
    add("ledger", "Tenant ledger", "failed", !arId || !facts.ok ? (facts.error || "the tenant's receivable ledger could not be created") : "Rental Income (4000) not found");
    return finish();   // nothing below can be posted without it
  }
  add("ledger", "Tenant ledger", "done");
  continuing = facts.continuing;
  if (effectiveMode === "new" && continuing) effectiveMode = "running";

  const plan = effectiveMode === "new" ? planTenancyCharges({ leaseStart, rent: monthly, deposit, today }) : null;
  if (plan && !plan.ok) { add("input", "Lease terms", "failed", plan.error); return finish(); }
  const rentMonths = new Set(facts.rentMonths);

  // ── 2. the monthly rent schedule (one per tenant; the database enforces it)
  let schedule = facts.schedule;
  if (schedule) add("schedule", "Monthly rent schedule", "already");
  else if (!createSchedule) add("schedule", "Monthly rent schedule", "skipped", "none set up on this screen");
  else {
    const from = effectiveMode === "new" ? plan.scheduleFrom
      : (/^\d{4}-\d{2}-\d{2}$/.test(String(billFrom)) ? String(billFrom).slice(0, 7) + "-01" : runningBillFrom({ today, chargedThisMonth: facts.chargedThisMonth }));
    try {
      const { data: made, error } = await supabase.from("recurring_journal_entries").insert([{
        company_id: companyId,
        description: "Monthly rent — " + name + " — " + propertyLabel(property),
        frequency: "monthly", day_of_month: 1, amount: monthly,
        tenant_name: name, tenant_id: tid, property,
        debit_account_id: arId, debit_account_name: "AR - " + name,
        credit_account_id: revenueId, credit_account_name: "Rental Income",
        status: "active", next_post_date: from, created_by: userEmail || "",
      }]).select("id, description").maybeSingle();
      if (error || !made) throw error || new Error("schedule was not created");
      schedule = made;
      add("schedule", "Monthly rent schedule", "done", "from " + from);
    } catch (e) {
      pmError("PM-4008", { raw: e, context: "tenancy books: rent schedule", silent: true });
      add("schedule", "Monthly rent schedule", "failed", e?.message || "");
    }
  }

  if (effectiveMode === "running") {
    const why = continuing && mode !== "running"
      ? "already being charged before this lease start, so this is a renewal, not a move-in"
      : "already a tenant; handled before";
    add("deposit", "Security deposit", "skipped", why);
    add("first", "First month's rent", "skipped", why);
  } else {
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
    let firstPostedNow = false;
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
      // Rent for that month entered some other way (by hand, an import).
      else if (rentMonths.has(plan.firstMonth.date.slice(0, 7))) add("first", "First month's rent", "already", "the ledger already has a rent charge that month");
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
        firstPostedNow = !!res?.jeId;
        add("first", "First month's rent", res?.jeId ? "done" : "failed", res?.jeId ? "" : (res?.error || "entry was not posted"));
      }
    } catch (e) {
      pmError("PM-4002", { raw: e, context: "tenancy books: first month", silent: true });
      add("first", "First month's rent", "failed", e?.message || "");
    }

    // ── 5. whole months that passed before today (see onboardingRules.js).
    // Posted under the schedule's own reference, so the recurring worker
    // recognises them as its months and never bills one of them again.
    if (plan.catchUp.length && (catchUp !== "first-run" || firstPostedNow)) {
      if (!schedule?.id) add("catchup", "Rent for months already passed", createSchedule ? "failed" : "skipped", "no rent schedule to post them under");
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
            // Billed some other way that month (another schedule, by hand):
            // never a second charge.
            if (rentMonths.has(month)) { add("catchup-" + month, label, "already", "the ledger already has a rent charge that month"); continue; }
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
  }

  // ── 6. let the schedule post anything that is already due (this month's rent)
  try { await autoPostRecurringEntries(companyId); }
  catch (e) { pmError("PM-4008", { raw: e, context: "tenancy books: recurring catch-up", silent: true }); }

  return finish();
}
