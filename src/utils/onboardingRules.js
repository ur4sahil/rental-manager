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
