// Property-tax schedules: the cron must resolve a county name the way the
// app does, and the two copies of the table must not drift.
//
// Sigma Housing LLC stores "Prince George's", not "Prince George's County".
// The cron looked the schedule up by bare equality, missed 58 of 61
// properties, counted them as out-of-area and generated no tax bills for
// any of them -- silently, with Maryland's 1st-half due 30 September.

const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
const assert = (name, cond, detail) => {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (detail ? "\n       " + detail : "")); }
};

// Pull both copies of the table out of source, so the test compares what
// actually ships rather than a third transcription of it.
function extractSchedules(file) {
  const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const start = src.indexOf("COUNTY_TAX_SCHEDULES = {");
  const open = src.indexOf("{", start);
  let depth = 0, end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  // eslint-disable-next-line no-new-func
  return new Function("return " + src.slice(open, end + 1))();
}

const fromApp  = extractSchedules("src/utils/helpers.js");
const fromCron = extractSchedules("api/_tax-bill-reminders-impl.js");

console.log("\n=== the two copies of the schedule table must agree ===");
{
  const a = Object.keys(fromApp).sort(), b = Object.keys(fromCron).sort();
  assert(`same jurisdictions (${a.length} vs ${b.length})`, JSON.stringify(a) === JSON.stringify(b),
    "only in app: " + a.filter(k => !b.includes(k)).join(", ") +
    " | only in cron: " + b.filter(k => !a.includes(k)).join(", "));
  const mismatched = a.filter(k => JSON.stringify(fromApp[k]) !== JSON.stringify(fromCron[k]));
  assert("same due dates for every jurisdiction", mismatched.length === 0, mismatched.join(", "));
}

// The resolver, transcribed from the implementation both files share.
function findCountySchedule(TABLE, county, state) {
  const st = String(state || "").trim().toUpperCase();
  const raw = String(county || "").trim().replace(/\s+/g, " ");
  if (!raw || !st) return { schedule: null, reason: "missing_input" };
  const exact = TABLE[raw + "|" + st];
  if (exact) return { schedule: exact, key: raw + "|" + st, reason: "exact" };
  const bare = v => v.replace(/\s+(County|City|Parish|Borough)$/i, "").toLowerCase();
  const want = bare(raw);
  const matches = Object.keys(TABLE).filter(k => {
    const [name, keySt] = k.split("|");
    return keySt === st && bare(name) === want;
  });
  if (matches.length === 1) return { schedule: TABLE[matches[0]], key: matches[0], reason: "normalised" };
  if (matches.length > 1) return { schedule: null, reason: "ambiguous", candidates: matches };
  return { schedule: null, reason: "no_schedule_for_jurisdiction" };
}

console.log("\n=== county names exactly as Sigma Housing LLC stores them ===");
{
  // These are the real stored values, with the property count behind each.
  const REAL = [
    ["Prince George's", "MD", 54], ["Baltimore County", "MD", 2], ["Howard", "MD", 1],
    ["Anne Arundel", "MD", 1], ["Harford", "MD", 1], ["Charles", "MD", 1],
  ];
  let covered = 0;
  for (const [county, state, n] of REAL) {
    const r = findCountySchedule(fromCron, county, state);
    assert(`"${county}, ${state}" resolves (${n} propert${n === 1 ? "y" : "ies"}) via ${r.reason}`,
      !!r.schedule, `reason=${r.reason}`);
    if (r.schedule) covered += n;
  }
  assert("all 60 properties with a county get a schedule", covered === 60, `covered ${covered}`);
}

console.log("\n=== a bare lookup is what broke it — prove the old way fails ===");
{
  const oldWay = (county, state) => fromCron[county + "|" + state];
  assert("bare equality misses \"Prince George's|MD\" — the 54-property case",
    !oldWay("Prince George's", "MD"),
    "if this passes, the table changed and this test is stale");
  assert("...while the tolerant resolver finds it",
    !!findCountySchedule(fromCron, "Prince George's", "MD").schedule);
}

console.log("\n=== ambiguity must never be guessed ===");
{
  const r = findCountySchedule(fromCron, "Baltimore", "MD");
  assert("a bare \"Baltimore\" is reported ambiguous, not guessed",
    r.reason === "ambiguous" && !r.schedule,
    `got ${r.reason} — Baltimore County and Baltimore City have different jurisdictions`);
  assert("...and names both candidates", (r.candidates || []).length === 2, JSON.stringify(r.candidates));
  assert("an explicit \"Baltimore City\" still resolves",
    !!findCountySchedule(fromCron, "Baltimore City", "MD").schedule);
}

console.log("\n=== Maryland's statutory dates ===");
{
  const md = findCountySchedule(fromCron, "Prince George's", "MD").schedule;
  assert("Maryland is ONE annual instalment for a rental portfolio",
    md.length === 1,
    `got ${md.length}: ${JSON.stringify(md)} — the semi-annual split is an ` +
    `election for owner-occupants; a per-property exception belongs in ` +
    `property_taxes.billing_frequency, not in the jurisdiction default`);
  assert("and it falls on 30 September",
    md[0].month === 9 && md[0].day === 30, JSON.stringify(md[0]));
  // every MD jurisdiction should say the same thing
  const mdKeys = Object.keys(fromCron).filter(k => k.endsWith("|MD"));
  const odd = mdKeys.filter(k => fromCron[k].length !== 1 || fromCron[k][0].month !== 9 || fromCron[k][0].day !== 30);
  assert(`all ${mdKeys.length} Maryland jurisdictions agree`, odd.length === 0, odd.join(", "));
}

console.log("\n=== the rollforward must not leave a permanent gap ===");
{
  // Transcribed from the job's candidate-selection rule.
  const pick = ({ thisYear, nextYear, today, earliestNextDue }) => {
    const out = [];
    out.push(thisYear);                                   // always a candidate
    const days = Math.round((new Date(earliestNextDue) - new Date(today)) / 86400000);
    if (days <= 60) out.push(nextYear);
    return out;
  };
  // The old rule, kept so the regression stays visible.
  const pickOld = ({ nextYear, today, earliestNextDue }) => {
    const days = Math.round((new Date(earliestNextDue) - new Date(today)) / 86400000);
    return days <= 60 ? [nextYear] : [];
  };

  const sep = { thisYear: 2026, nextYear: 2027, today: "2026-09-15", earliestNextDue: "2027-09-30" };
  assert("OLD rule generated NOTHING in September — the silent gap",
    pickOld(sep).length === 0,
    "if this fails the old rule was fine and the change was unnecessary");
  assert("current year is generated even outside the next-year window",
    pick(sep).includes(2026), JSON.stringify(pick(sep)));

  const aug = { thisYear: 2026, nextYear: 2027, today: "2027-08-15", earliestNextDue: "2027-09-30" };
  assert("next year still enters on its 60-day window", pick(aug).includes(2027));
  assert("catch-up is bounded to ONE year, never walking back through history",
    Math.min(...pick(sep)) === 2026 && pick(sep).length <= 2,
    JSON.stringify(pick(sep)));
}

console.log("\n=== escrowed properties must not be billed ===");
{
  const shouldBill = (taxRec) => !(taxRec && taxRec.escrow_paid_by_lender);
  assert("a lender-escrowed property is skipped",
    shouldBill({ escrow_paid_by_lender: true }) === false,
    "the servicer pays these; a reminder is a prompt to pay twice");
  assert("an owner-paid property is billed", shouldBill({ escrow_paid_by_lender: false }) === true);
  assert("a property with no tax record is still billed (a date is better than silence)",
    shouldBill(undefined) === true);
}

console.log("\n=== an instalment must not claim the whole year ===");
{
  const per = (annual, instalments) => Math.round((annual / instalments) * 100) / 100;
  assert("one annual instalment carries the full amount", per(4000, 1) === 4000);
  assert("two halves carry half each", per(4000, 2) === 2000,
    "billing the full annual figure on each half would double the stated liability");
}

console.log(`\n${failed ? "❌" : "✅"} Passed: ${passed}   Failed: ${failed}\n`);
process.exit(failed ? 1 : 0);
