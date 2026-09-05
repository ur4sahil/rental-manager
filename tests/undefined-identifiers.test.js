// Guards the single most damaging bug class this codebase has produced:
// an identifier that does not exist, referenced inside a try/catch that
// swallows the ReferenceError.
//
// Two real ones, both silent in production:
//   * Properties.js called atomicPostJEAndLedger without importing it,
//     so the security deposit and first month's rent were never posted
//     for any tenant onboarded through the Property Setup Wizard. It
//     surfaced only as a generic PM-4002 in the error log.
//   * CompanySelector.js rendered <UserProfile> without importing it,
//     white-screening the company picker's Profile button.
//
// The second is why this checks react/jsx-no-undef as well as no-undef:
// a bare no-undef sweep does not see JSX component references at all,
// and that gap hid the crash for as long as the import was missing.
const { execSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "  — " + detail : ""}`); }
}

console.log("==============================================");
console.log("Undefined identifiers");
console.log("==============================================");

let out = "";
try {
  execSync(
    `npx eslint src --rule '{"no-undef":"error","react/jsx-no-undef":"error"}' -f compact`,
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
} catch (e) {
  // eslint exits non-zero when it reports an error; the report is on stdout.
  out = (e.stdout || "") + (e.stderr || "");
}

const errors = out
  .split("\n")
  .filter((l) => l.includes(", Error - "))
  // Node/CRA globals that the browser-targeted config does not declare.
  // These are environment, not missing imports.
  .filter((l) => !/'(process|module|require|__dirname|test|expect|jest|describe|it)' is not defined/.test(l));

assert(
  "no undefined identifiers in src/",
  errors.length === 0,
  errors.length ? "\n   " + errors.join("\n   ") : "clean"
);

console.log(`\n✅ Passed: ${passed}\n❌ Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
