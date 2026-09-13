// findCountySchedule — tolerant county matching for tax bills.
//
// Properties store the county as typed: "Charles", not "Charles County".
// The lookup key is "<county>|<state>", so an exact match missed 66 of the
// 79 properties that HAVE a county set (Anne Arundel, Charles, Harford,
// Howard, Prince George's). No tax bills were generated for any of them,
// and the app reported them as "out-of-area" -- which is not what
// happened. Sahil hit this as "only one property tax due is being
// populated for 119 Charles Pl, Indian Head, MD 20640".
import fs from "fs";
import path from "path";
const src = fs.readFileSync(path.join(import.meta.dirname, "../src/utils/helpers.js"), "utf8");
const i = src.indexOf("export const COUNTY_TAX_SCHEDULES");
const j = src.indexOf("export function findCountySchedule");
if (i < 0 || j < 0) throw new Error("COUNTY_TAX_SCHEDULES or findCountySchedule missing");
const end = src.indexOf("\nexport ", j + 10);
const body = src.slice(i, end < 0 ? undefined : end).replace(/^export /gm, "");
const { findCountySchedule, COUNTY_TAX_SCHEDULES } = await import(
  "data:text/javascript," + encodeURIComponent(body +
    "\nexport { findCountySchedule, COUNTY_TAX_SCHEDULES };"));

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`); }
};

// --- the reported bug ---------------------------------------------------
const charles = findCountySchedule("Charles", "MD");
check("bare 'Charles' MD resolves", charles.schedule && charles.schedule.length === 1,
  `reason=${charles.reason} key=${charles.key}`);
check("...and it is Charles County, not something else", charles.key === "Charles County|MD");
// Maryland is ONE annual payment due 30 Sep, not two halves. Sahil:
// "Maryland LLC need to pay all tax together." Generating a 31 Dec second
// half put a bill on every MD property that is never paid.
check("Maryland is a single annual bill", charles.schedule &&
  charles.schedule.map(s => `${s.month}/${s.day}`).join(",") === "9/30",
  JSON.stringify(charles.schedule));
check("...labelled as annual, not a half",
  charles.schedule && /annual/i.test(charles.schedule[0].label));
// Every MD county must agree -- a split one would quietly reintroduce it.
const mdSplit = Object.entries(COUNTY_TAX_SCHEDULES)
  .filter(([k]) => k.endsWith("|MD")).filter(([, v]) => v.length !== 1);
check("no Maryland county still has a split schedule", mdSplit.length === 0,
  mdSplit.map(([k]) => k).join(", "));

// --- every bare county actually present in the data ----------------------
for (const c of ["Anne Arundel", "Harford", "Howard", "Prince George's"]) {
  const r = findCountySchedule(c, "MD");
  check(`bare "${c}" MD resolves`, !!r.schedule, `reason=${r.reason}`);
}

// --- exact names must still work -----------------------------------------
for (const c of ["Charles County", "Prince George's County", "Baltimore County", "Baltimore City"]) {
  const r = findCountySchedule(c, "MD");
  check(`exact "${c}" still resolves`, !!r.schedule, `reason=${r.reason}`);
}

// --- ambiguity must NOT be guessed ---------------------------------------
// Maryland has both a Baltimore County and a Baltimore City, filed with
// different jurisdictions. Picking one would silently file against the
// wrong due dates.
const balt = findCountySchedule("Baltimore", "MD");
check("bare 'Baltimore' MD is refused as ambiguous", balt.reason === "ambiguous" && !balt.schedule,
  `reason=${balt.reason} key=${balt.key}`);
check("...and says which jurisdictions it could mean",
  Array.isArray(balt.candidates) && balt.candidates.length === 2, JSON.stringify(balt.candidates));

// --- shape and hygiene ----------------------------------------------------
check("case and spacing are tolerated",
  !!findCountySchedule("  charles   county ", "md").schedule);
check("a genuinely unknown county is still rejected",
  findCountySchedule("Nowhere", "MD").reason === "no_schedule_for_jurisdiction");
check("a wrong STATE does not match a right county name",
  !findCountySchedule("Charles", "VA").schedule);
check("empty input is refused", findCountySchedule("", "MD").reason === "missing_input");
check("null input does not throw", findCountySchedule(null, null).reason === "missing_input");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
