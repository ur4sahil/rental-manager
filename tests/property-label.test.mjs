// propertyLabel() -- the short label shown wherever a property is named.
//
// Written against the REAL addresses in the test database, including the
// malformed ones, because the bug being fixed was invisible on the tidy
// ones: 22 call sites did address.split(",")[0], which is correct for
// "6918 Aquamarine Court, Capitol Heights, MD 20743" and silently drops
// the unit for "353 Gatewater Ct, B, Glen Burnie, MD 21061".
// helpers.js imports the Supabase client, so it cannot be imported in
// plain node. Lift the real function out of the shipped source and
// evaluate that, rather than testing a copy that can drift.
import fs from "fs";
import path from "path";
const src = fs.readFileSync(path.join(import.meta.dirname, "../src/utils/helpers.js"), "utf8");
const i = src.indexOf("export function propertyLabel(");
if (i < 0) throw new Error("propertyLabel not found in helpers.js");
const body = src.slice(i).replace(/^export /, "");
const { propertyLabel } = await import(
  "data:text/javascript," + encodeURIComponent(`${body}\nexport { propertyLabel };`));

let pass = 0, fail = 0;
const is = (input, want, why) => {
  const got = propertyLabel(input);
  if (got === want) { pass++; console.log(`PASS  ${JSON.stringify(input)} -> ${JSON.stringify(got)}`); }
  else { fail++; console.log(`FAIL  ${JSON.stringify(input)}\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}${why ? "\n      " + why : ""}`); }
};

// --- the ordinary case: street, city, state zip -----------------------
is("6918 Aquamarine Court, Capitol Heights, MD 20743", "6918 Aquamarine Court");
is("4229 Crosswick Turn, Bowie, MD 20715", "4229 Crosswick Turn");
is("6904 Hawthorne, Landover, MD 20785", "6904 Hawthorne");
is("2602B Kent Village, Landover, MD 20785", "2602B Kent Village");

// --- the regression: a unit in its own segment ------------------------
// These are the twelve that were showing the building, not the home.
is("353 Gatewater Ct, B, Glen Burnie, MD 21061", "353 Gatewater Ct B");
is("1865 Dutch Village, J-290, Hyattsville, MD 20785", "1865 Dutch Village J-290");
is("904 Westhaven, 11-103, Bowie, MD 20721", "904 Westhaven 11-103");
is("9195 Hitching Post Lane, E, Laurel, MD 20723", "9195 Hitching Post Lane E");
is("1 Barberry Ct, 40-1, Upper Marlboro, MD 20774", "1 Barberry Ct 40-1");
is("35 Watkins, 18, Upper Marlboro, MD 20774", "35 Watkins 18");
is("4747 River Valley, 63, Bowie, MD 20720", "4747 River Valley 63");
is("3845 Saint Barnabas, 101, Suitland, MD 20746", "3845 Saint Barnabas 101");
is("7200 Bogley, 203, Windsor Mill, MD 21244", "7200 Bogley 203");
is("4748 Colonel Ashton, 447, Upper Marlboro, MD 20772", "4748 Colonel Ashton 447");

// --- the unit is already in line 1, so must not be repeated -----------
is("2010 Alice Ave #104, 104, Oxon Hill, MD 20745", "2010 Alice Ave #104",
   "line2 '104' is already spelled in line1 as '#104'");
is("8457 greenbelt #202, 202, Greenbelt, MD 20770", "8457 greenbelt #202");

// --- malformed: line1 already holds a whole address -------------------
// Guessing here would produce something worse than what it showed before,
// so it falls back to the first segment.
is("8463 Greenbelt Rd #102, Greenbelt, MD 20770, 102, Greenbelt, MD 20770",
   "8463 Greenbelt Rd #102");

// --- not an address at all -------------------------------------------
is("Overhead", "Overhead", "the non-property class used for shared costs");
is("", "");
is(null, "");
is(undefined, "");
is(123, "", "a number must not throw");
is({}, "", "an object must not throw");

// --- shapes that would break a naive implementation -------------------
is("1234 Main St", "1234 Main St", "no city at all");
is("1234 Main St, Bowie", "1234 Main St", "city but no state/zip -- two segments");
is(",,,", "", "separators only");
is("  6918 Aquamarine Court ,  Capitol Heights , MD 20743 ", "6918 Aquamarine Court",
   "surrounding whitespace is trimmed");
is("500 A St, B, Bowie, MD 20715", "500 A St B",
   "a single-letter unit that also appears as a word in line1 must survive");
is("7 Oak, 7, Bowie, MD 20715", "7 Oak 7",
   "the '7' in line1 is the house number, not the unit -- the de-dupe is anchored to the END of line1 so a leading number is never mistaken for a repeated unit");
is("7 Oak 7, 7, Bowie, MD 20715", "7 Oak 7",
   "here line1 really does end in the unit, so it is not repeated");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
