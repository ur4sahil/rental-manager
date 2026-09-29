// A reopened wizard must not bring back an old tenant from its snapshot.
// 6950 Hawthorne (2026-09-29): vacant, both tenants archived, but a DISMISSED
// wizard session reopened as "occupied -- Kendall Orebeaux"; saving it would
// have written that tenant back. Static checks on Properties.js.
import fs from "fs";
let passed = 0, failed = 0;
const assert = (n, ok) => { if (ok) { passed++; console.log("  ✅ " + n); } else { failed++; console.log("  ❌ " + n); } };
const src = fs.readFileSync(new URL("../src/components/Properties.js", import.meta.url), "utf8");
const fn = src.slice(src.indexOf("async function loadLiveWizardData"), src.indexOf("async function loadLiveWizardData") + 9000);
assert("loadLiveWizardData takes a tablesWin option", /loadLiveWizardData\(address, \{ refreshProperty = false, tablesWin = false \} = \{\}\)/.test(src));
assert("no live tenant + tablesWin + live property -> tenant form reset to blank",
  /if \(!primary && tablesWin && propRow\) \{\s*tenantLoadedRef\.current = null;\s*setTenantForm\(blankTenantForm\(\)\);/.test(fn));
assert("a session revived from DISMISSED lets the tables win (property + tenant)",
  /revivedFromDismissed = true;/.test(src) && /loadLiveWizardData\(addr, revivedFromDismissed \? \{ refreshProperty: true, tablesWin: true \} : \{\}\)/.test(src));
assert("a reopened COMPLETED wizard lets the tables win", /loadLiveWizardData\(addr, \{ refreshProperty: true, tablesWin: true \}\)/.test(src));
assert("the initial blank form and the reset share one definition", /return blankTenantForm\(\);/.test(src) && (src.match(/const blankTenantForm = /g) || []).length === 1);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
