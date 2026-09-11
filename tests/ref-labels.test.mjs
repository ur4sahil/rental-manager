import fs from "fs";
const src = fs.readFileSync("../src/components/Accounting.js", "utf8");
// One contiguous slice: REF_LABELS through the end of refLabelFull.
const a = src.indexOf("const REF_LABELS = [");
const b = src.indexOf("\n}", src.indexOf("export function refLabelFull")) + 2;
const code = src.slice(a, b).replace(/^export /gm, "") + "\nexport { refLabel, refLabelFull };";
const { refLabelFull } = await import("data:text/javascript," + encodeURIComponent(code));
const cases = [
  ["RECUR-6a0e0d78-2026-08", "Recurring · Aug 2026"],
  ["RENT1-T307-20260101",    "Rent Charge · Jan 1, 2026"],
  ["LATEFEE-41-2026-09",     "Late Fee · Sep 2026"],
  ["BANK-c6c86a53-016a",     "Bank Import"],
  ["PS 2504 A Kent Village Dr", "PS 2504 A Kent Village Dr"],
  ["", "—"],
];
let bad = 0;
for (const [inp, want] of cases) {
  const got = refLabelFull(inp);
  if (got !== want) bad++;
  console.log(`${got === want ? "ok  " : "FAIL"}  ${JSON.stringify(inp).padEnd(28)} -> ${JSON.stringify(got)}`);
}
console.log(bad ? `\n${bad} failed` : "\nall pass");
process.exit(bad ? 1 : 0);
