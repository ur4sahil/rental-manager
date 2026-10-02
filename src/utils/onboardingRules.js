// What starting a tenancy puts on the books, worked out from the lease
// terms alone. No imports and no database: the plan is shown to the user
// before anything is posted, and it is tested on its own.
//
// The amounts and dates are the property wizard's (Properties.js, "post
// commit" section) so a tenant converted from a prospect ends up with the
// same entries as one onboarded through the wizard:
//   - security deposit: charged on the lease start date;
//   - first month: the full rent if the lease starts on the 1st, otherwise
//     rent x remaining days / days in that month (Sahil's rule), dated the
//     lease start;
//   - the monthly schedule bills from the 1st of the month AFTER the lease
//     start.
//
// One thing the wizard does not do. The recurring worker never reaches back
// before the month a schedule was created (a guard against a re-created
// schedule re-billing a tenant's whole history), so a tenancy that is
// entered late -- lease started in July, converted in October -- would get
// July and then nothing until October. Those whole months in between are
// listed here as `catchUp` so they are charged once, at conversion.

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n) => String(n).padStart(2, "0");
const cents = (n) => Math.round(Number(n) * 100) / 100;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** "YYYY-MM" for the month after `ym`. */
export function nextMonth(ym) {
  const [y, m] = String(ym).split("-").map(n => parseInt(n, 10));
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}

/**
 * @param {{ leaseStart: string, rent: number|string, deposit?: number|string, today: string }} terms  dates as "YYYY-MM-DD"
 * @returns {{ ok: boolean, error?: string, deposit: null|{amount:number,date:string},
 *            firstMonth: null|{kind:"full"|"prorated", amount:number, date:string, days:number, daysInMonth:number},
 *            catchUp: string[], scheduleFrom: string, monthly: number }}
 */
export function planTenancyCharges({ leaseStart, rent, deposit = 0, today }) {
  const empty = { ok: false, deposit: null, firstMonth: null, catchUp: [], scheduleFrom: "", monthly: 0 };
  const s = String(leaseStart || "").slice(0, 10).match(ISO);
  const t = String(today || "").slice(0, 10).match(ISO);
  if (!s) return { ...empty, error: "The lease needs a start date." };
  if (!t) return { ...empty, error: "Today's date is missing." };
  const monthly = cents(num(rent));
  if (!(monthly > 0)) return { ...empty, error: "The rent must be more than zero." };

  const y = Number(s[1]), m = Number(s[2]), d = Number(s[3]);
  const start = `${s[1]}-${s[2]}-${s[3]}`;
  const startMonth = `${s[1]}-${s[2]}`;
  const thisMonth = `${t[1]}-${t[2]}`;
  const daysInMonth = new Date(y, m, 0).getDate();
  if (d < 1 || d > daysInMonth) return { ...empty, error: "The lease start date is not a real date." };

  const dep = cents(num(deposit));
  const days = daysInMonth - d + 1;
  const firstMonth = d === 1
    ? { kind: "full", amount: monthly, date: start, days: daysInMonth, daysInMonth }
    : { kind: "prorated", amount: cents(monthly * days / daysInMonth), date: start, days, daysInMonth };

  // Whole months after the first and before the current one. The current
  // month is the schedule's own to post.
  const catchUp = [];
  for (let ym = nextMonth(startMonth); ym < thisMonth; ym = nextMonth(ym)) {
    catchUp.push(ym);
    if (catchUp.length > 60) break;   // a five-year-old lease is a typo, not a backlog
  }

  return {
    ok: true,
    deposit: dep > 0 ? { amount: dep, date: start } : null,
    firstMonth,
    catchUp,
    scheduleFrom: nextMonth(startMonth) + "-01",
    monthly,
  };
}

/** The plan as plain sentences, for the confirmation before converting. */
export function describeTenancyCharges(plan, money = (n) => "$" + Number(n).toFixed(2), date = (d) => d) {
  if (!plan || !plan.ok) return [];
  const out = [];
  if (plan.deposit) out.push(`Security deposit ${money(plan.deposit.amount)}, dated ${date(plan.deposit.date)}`);
  if (plan.firstMonth) {
    out.push(plan.firstMonth.kind === "full"
      ? `First month's rent ${money(plan.firstMonth.amount)}, dated ${date(plan.firstMonth.date)}`
      : `First month's rent ${money(plan.firstMonth.amount)} (${plan.firstMonth.days} of ${plan.firstMonth.daysInMonth} days), dated ${date(plan.firstMonth.date)}`);
  }
  if (plan.catchUp.length) {
    out.push(`Rent ${money(plan.monthly)} for each month already passed: ${plan.catchUp.join(", ")}`);
  }
  out.push(`Rent ${money(plan.monthly)} on the 1st of every month from ${date(plan.scheduleFrom)}`);
  return out;
}

// ── New tenancy, or someone who already lives there? ───────────────────
// Five screens can start a tenant's books (Prospects, the Tenants page, the
// property wizard, the property form and Leases "Create lease"). They used
// to disagree: one charged the deposit and first month, three charged the
// deposit and left the rent schedule to a pop-up that could be closed, and
// none could tell a move-in from a renewal. All five now go through
// startTenancyBooks (tenantOnboarding.js), which works in one of two modes:
//
//   "new"      a move-in: deposit, first (possibly part) month, the whole
//              months already passed, and the monthly schedule;
//   "running"  someone who is already a tenant and was billed some other
//              way up to now: the monthly schedule only.
//
// The rules that pick between them are here, pure, so they can be tested.

/** Is this ledger line a rent charge (as opposed to a deposit or a late fee)? */
export function isRentCharge({ reference = "", memo = "", description = "" } = {}) {
  const ref = String(reference || ""), text = (String(memo || "") + " " + String(description || "")).toLowerCase();
  if (/^DEP-/.test(ref) || /deposit/.test(text)) return false;
  if (/late\s*fee|late\s*charge/.test(text)) return false;
  if (/^(RECUR|RENT1|PRORENT)-/.test(ref)) return true;
  return /\brent\b|\brental\b/.test(text);
}

/**
 * Which mode a screen should offer first. A lease that started long ago is
 * someone being entered late, not a move-in: charging their deposit and
 * every month since would bill them a second time for what was collected
 * outside the app.
 *
 * "new" when the lease starts in the future, this month or last month;
 * otherwise "running". `continuing` (the tenant's ledger already carries
 * charges from before the lease start: a renewal) always means "running".
 */
export function defaultTenancyMode({ leaseStart, today, continuing = false }) {
  if (continuing) return "running";
  const s = String(leaseStart || "").slice(0, 10).match(ISO), t = String(today || "").slice(0, 10).match(ISO);
  if (!s || !t) return "running";
  const lastMonth = Number(t[2]) === 1 ? `${Number(t[1]) - 1}-12` : `${t[1]}-${pad(Number(t[2]) - 1)}`;
  return `${s[1]}-${s[2]}` >= lastMonth ? "new" : "running";
}

/**
 * For "running": the first month the schedule bills. This month, unless
 * this month's rent is already on the tenant's ledger.
 */
export function runningBillFrom({ today, chargedThisMonth = false }) {
  const t = String(today || "").slice(0, 10).match(ISO);
  if (!t) return "";
  const thisMonth = `${t[1]}-${t[2]}`;
  return (chargedThisMonth ? nextMonth(thisMonth) : thisMonth) + "-01";
}

/** "running" as plain sentences, to show before anything is saved. */
export function describeRunningTenancy({ monthly, billFrom }, money = (n) => "$" + Number(n).toFixed(2), date = (d) => d) {
  return [
    `Rent ${money(monthly)} on the 1st of every month from ${date(billFrom)}`,
    "No deposit and no first-month charge are posted: those were handled before",
  ];
}
