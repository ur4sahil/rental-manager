// Which licences a property must hold.
//
// The lead-paint rule is PRE-1978. The federal ban on lead-based paint
// took effect in 1978, so disclosure and Maryland's MDE registration
// apply to housing built BEFORE then. Sahil asked for it as "properties
// built after 1978"; building it that way round would flag exactly the
// wrong properties and miss every one that actually needs a certificate,
// so it is implemented as pre-1978 and pinned here.
import fs from "fs";
import path from "path";
const src = fs.readFileSync(path.join(import.meta.dirname, "../src/utils/helpers.js"), "utf8");
const i = src.indexOf("export const LEAD_PAINT_CUTOFF_YEAR");
const j = src.indexOf("export function getWizardApplicableSteps");
const body = src.slice(i, j).replace(/^export /gm, "");
const { requiredLicenses, LEAD_PAINT_CUTOFF_YEAR } = await import(
  "data:text/javascript," + encodeURIComponent(body +
    "\nexport { requiredLicenses, LEAD_PAINT_CUTOFF_YEAR };"));

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`); }
};
const leadFor = (y) => requiredLicenses({ yearBuilt: y }).find(r => r.type === "lead_paint");

check("the cutoff is 1978", LEAD_PAINT_CUTOFF_YEAR === 1978);

// --- the direction of the rule, which is the whole point ---------------
check("1977 (pre-1978) REQUIRES a lead certificate", leadFor(1977)?.required === true);
check("1900 requires one", leadFor(1900)?.required === true);
check("1978 itself does NOT require one", leadFor(1978) === undefined,
  "1978 is the first year of the ban, so it is not pre-1978");
check("1979 does not require one", leadFor(1979) === undefined);
check("2015 does not require one", leadFor(2015) === undefined);

// --- an unknown year is its own answer ---------------------------------
// Treating NULL as pre-1978 flags the whole portfolio; treating it as
// post-1978 flags none. Neither is honest.
for (const v of [null, undefined, "", 0]) {
  check(`year ${JSON.stringify(v)} reports as unknown, not assumed`,
    leadFor(v)?.required === "unknown");
}
check("a non-numeric year is unknown, not silently pre-1978",
  leadFor("not a year")?.required === "unknown");

// --- the rental licence is always required -----------------------------
for (const y of [null, 1900, 1978, 2020]) {
  const r = requiredLicenses({ yearBuilt: y }).find(x => x.type === "rental_license");
  check(`a rental licence is required regardless of year (${y})`, r?.required === true);
}
check("no arguments does not throw", Array.isArray(requiredLicenses()));

// --- string years, as they arrive from a form or a spreadsheet ---------
check('the string "1977" is treated as pre-1978', leadFor("1977")?.required === true);
check('the string "1990" is not', leadFor("1990") === undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
