// Renewals, rent changes and addenda: the rules. PURE -- no imports, no
// I/O -- so tests can load this file in plain node.
//
// A change to a lease is a row in lease_changes (see migration
// 20261003040000). It does nothing until its effective date, and a renewal
// or addendum does nothing until everyone has signed. These functions
// decide what may be scheduled and say it in words; the database applies
// it (_apply_lease_change).

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n) => String(n).padStart(2, "0");
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const cents = (n) => Math.round(num(n) * 100) / 100;
const isIso = (s) => ISO.test(String(s || ""));

// Calendar arithmetic on "YYYY-MM-DD" strings. UTC throughout, so a
// daylight-saving change can never move a date by a day.
const toUtc = (s) => { const m = String(s).match(ISO); return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); };
const fromUtc = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export function addDays(iso, days) {
  if (!isIso(iso)) return "";
  const d = toUtc(iso); d.setUTCDate(d.getUTCDate() + Number(days || 0)); return fromUtc(d);
}
/** Same day N months later, clamped to the month's length (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(iso, months) {
  if (!isIso(iso)) return "";
  const m = String(iso).match(ISO);
  const total = (+m[1]) * 12 + (+m[2] - 1) + Number(months || 0);
  const y = Math.floor(total / 12), mo = total % 12;
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return `${y}-${pad(mo + 1)}-${pad(Math.min(+m[3], last))}`;
}
export function daysBetween(fromIso, toIso) {
  if (!isIso(fromIso) || !isIso(toIso)) return NaN;
  return Math.round((toUtc(toIso) - toUtc(fromIso)) / 86400000);
}
/** The 1st of the month on or after a date. Rent changes read cleanest from the 1st. */
export function firstOfMonthOnOrAfter(iso) {
  if (!isIso(iso)) return "";
  const m = String(iso).match(ISO);
  return m[3] === "01" ? iso : addMonths(`${m[1]}-${m[2]}-01`, 1);
}

// ── Where a lease's term stands ────────────────────────────────────────
// A lease that is not renewed carries on month to month (the lease itself
// says so, Section XXVI). A passed end date is therefore a normal tenancy,
// not an expiry, and nothing here ever ends a tenancy by itself.
export function leaseTermState(lease, today, openRenewal = null) {
  const end = String(lease?.end_date || "").slice(0, 10);
  if (!lease || lease.status !== "active" || !isIso(end) || !isIso(today)) return { key: "none", label: "" };
  if (openRenewal && openRenewal.status === "scheduled") return { key: "renewal_scheduled", label: "Renewal starts " + openRenewal.effective_date };
  if (openRenewal && openRenewal.status === "awaiting_signature") return { key: "renewal_out", label: "Renewal out for signature" };
  const left = daysBetween(today, end);
  if (left < 0) return { key: "month_to_month", label: "Month-to-month since " + end, since: end };
  if (left <= 90) return { key: "ending_soon", label: left === 0 ? "Term ends today" : `Term ends in ${left} day${left === 1 ? "" : "s"}`, daysLeft: left };
  return { key: "fixed", label: "Term ends " + end, daysLeft: left };
}

// ── Renewal ────────────────────────────────────────────────────────────
/** What the renewal form opens with: the day after the current term, for a year, at the current rent. */
export function renewalDefaults(lease, today) {
  const end = String(lease?.end_date || "").slice(0, 10);
  // A lease already running month to month renews from the 1st of next month.
  const start = isIso(end) && isIso(today) && end >= today ? addDays(end, 1)
    : isIso(today) ? firstOfMonthOnOrAfter(addDays(today, 1)) : "";
  return { startDate: start, endDate: start ? addDays(addMonths(start, 12), -1) : "", rent: cents(lease?.rent_amount) };
}
export function checkRenewal({ lease, startDate, endDate, rent, date = (d) => d }) {
  if (!lease || lease.status !== "active") return { ok: false, error: "Only an active lease can be renewed." };
  if (!isIso(startDate) || !isIso(endDate)) return { ok: false, error: "The renewal needs a start date and an end date." };
  if (endDate <= startDate) return { ok: false, error: "The renewal must end after it starts." };
  if (!(cents(rent) > 0)) return { ok: false, error: "The rent must be more than zero." };
  const curStart = String(lease.start_date || "").slice(0, 10);
  if (isIso(curStart) && startDate <= curStart) return { ok: false, error: "The renewal must start after the current lease began (" + date(curStart) + ")." };
  return { ok: true, startDate, endDate, rent: cents(rent) };
}

// ── Rent change ────────────────────────────────────────────────────────
// An INCREASE needs written notice a set number of days ahead (Maryland: 90
// days for a term longer than a month -- see the plan's [LAW] list; the
// number is a company setting). A decrease needs none.
export const DEFAULT_RENT_NOTICE_DAYS = 90;
export function earliestRentIncreaseDate({ noticeDate, noticeDays = DEFAULT_RENT_NOTICE_DAYS }) {
  return isIso(noticeDate) ? addDays(noticeDate, Math.max(0, Math.floor(num(noticeDays)))) : "";
}
export function checkRentChange({ currentRent, newRent, effectiveDate, noticeDate, noticeDays = DEFAULT_RENT_NOTICE_DAYS, date = (d) => d }) {
  const from = cents(currentRent), to = cents(newRent);
  if (!(to > 0)) return { ok: false, error: "Enter the new rent." };
  if (to === from) return { ok: false, error: "The new rent is the same as the current rent." };
  if (!isIso(effectiveDate)) return { ok: false, error: "Choose the date the new rent starts." };
  if (!isIso(noticeDate)) return { ok: false, error: "The notice date is missing." };
  const increase = to > from;
  const pct = from > 0 ? Math.round((to - from) / from * 1000) / 10 : null;
  if (effectiveDate < noticeDate) return { ok: false, error: "The new rent cannot start before the notice is given." };
  if (increase) {
    const earliest = earliestRentIncreaseDate({ noticeDate, noticeDays });
    if (effectiveDate < earliest) {
      return { ok: false, increase, pct, earliest,
        error: `An increase needs ${Math.floor(num(noticeDays))} days' notice. With notice on ${date(noticeDate)}, the earliest start is ${date(earliest)}.` };
    }
  }
  return { ok: true, increase, pct, amount: cents(to - from), from, to };
}

// ── Addendum ───────────────────────────────────────────────────────────
export const MAX_ADULTS = 5;   // the tenant and four others: the property holds four more names
export function checkAddendum({ kind, tenantName = "", coTenants = [], person = {}, removeName = "", newRent, currentRent, effectiveDate, text = "" }) {
  if (!isIso(effectiveDate)) return { ok: false, error: "Choose the date the change starts." };
  const names = (coTenants || []).map(n => String(n || "").trim()).filter(Boolean);
  if (kind === "add_person") {
    const name = String(person.name || "").trim();
    if (!name) return { ok: false, error: "Enter the name of the person joining the lease." };
    if ([tenantName, ...names].some(n => n.trim().toLowerCase() === name.toLowerCase())) return { ok: false, error: name + " is already on the lease." };
    if (names.length + 1 >= MAX_ADULTS) return { ok: false, error: "A tenancy holds at most five adults." };
    const email = String(person.email || "").trim().toLowerCase();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "That email address does not look right." };
    return { ok: true, payload: { add_people: [{ name, email, phone: String(person.phone || "").trim() }] } };
  }
  if (kind === "remove_person") {
    const name = String(removeName || "").trim();
    if (!name) return { ok: false, error: "Choose who is leaving the lease." };
    if (!names.some(n => n.toLowerCase() === name.toLowerCase())) return { ok: false, error: name + " is not one of the other adults on this lease." };
    return { ok: true, payload: { remove_people: [name] } };
  }
  if (kind === "rent") {
    const to = cents(newRent);
    if (!(to > 0)) return { ok: false, error: "Enter the new monthly rent." };
    if (to === cents(currentRent)) return { ok: false, error: "The new rent is the same as the current rent." };
    return { ok: true, payload: { rent: to } };
  }
  if (!String(text || "").trim()) return { ok: false, error: "Write what the addendum changes." };
  return { ok: true, payload: {} };
}

// ── In words ───────────────────────────────────────────────────────────
export const CHANGE_KIND_LABEL = { renewal: "Renewal", rent_increase: "Rent change", addendum: "Addendum" };
export const CHANGE_STATUS_LABEL = { awaiting_signature: "Waiting for signatures", scheduled: "Scheduled", applied: "In effect", cancelled: "Cancelled" };
const usd = (n) => "$" + num(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** One line saying what a change does. */
export function describeLeaseChange(change, money = usd, date = (d) => d) {
  const p = change?.payload || {};
  if (change?.kind === "renewal") {
    return `New term ${date(change.effective_date)} – ${date(p.end_date)}` + (p.rent != null && p.rent !== "" ? ` at ${money(p.rent)} a month` : "");
  }
  if (change?.kind === "rent_increase") return `Rent becomes ${money(p.rent)} a month from ${date(change.effective_date)}`;
  const parts = [];
  for (const a of (Array.isArray(p.add_people) ? p.add_people : [])) if (a?.name) parts.push(a.name + " joins the lease");
  for (const r of (Array.isArray(p.remove_people) ? p.remove_people : [])) if (r) parts.push(r + " leaves the lease");
  if (p.rent != null && p.rent !== "") parts.push("rent becomes " + money(p.rent) + " a month");
  if (!parts.length) parts.push(p.summary ? String(p.summary) : "wording only; nothing changes in the records");
  const text = parts.join("; ");
  return text.charAt(0).toUpperCase() + text.slice(1) + " from " + date(change.effective_date);
}

/** The sentence(s) an addendum document states, built from what it does. */
export function addendumText(payload, { money = usd, text = "" } = {}) {
  const p = payload || {};
  const out = [];
  for (const a of (Array.isArray(p.add_people) ? p.add_people : [])) if (a?.name) out.push(`${a.name} is added to the Lease as a Tenant and is bound, jointly and severally with every other Tenant, by all of its terms.`);
  for (const r of (Array.isArray(p.remove_people) ? p.remove_people : [])) if (r) out.push(`${r} is removed from the Lease as a Tenant as of the effective date and has no further right to occupy the Premises. The remaining Tenant(s) stay bound by all of its terms.`);
  if (p.rent != null && p.rent !== "") out.push(`The monthly Rent is changed to ${money(p.rent)}.`);
  if (String(text || "").trim()) out.push(String(text).trim());
  return out.join("\n\n");
}

// ── Reading the terms back out of the finished document ────────────────
// Staff can still change the rent or a date while filling in the document.
// What is scheduled must be what the document says, so the terms are read
// back from its fields. `fieldMap` says which field holds which term:
//   { effective_date: "renewal_start", end_date: "renewal_end", rent: "new_rent" }
const isoFrom = (v) => {
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${pad(m[1])}-${pad(m[2])}` : null;
};
const moneyFrom = (v) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.-]/g, "")); return Number.isFinite(n) && n > 0 ? cents(n) : null; };
export function changeFromFields(change, fieldValues) {
  const map = change?.fieldMap || {};
  const out = { kind: change.kind, effective_date: change.effective_date, payload: { ...(change.payload || {}) } };
  const v = (key) => (map[key] ? fieldValues?.[map[key]] : undefined);
  const eff = isoFrom(v("effective_date")); if (eff) out.effective_date = eff;
  const end = isoFrom(v("end_date")); if (end) out.payload.end_date = end;
  const rent = moneyFrom(v("rent")); if (rent != null && (map.rent)) out.payload.rent = rent;
  return out;
}
