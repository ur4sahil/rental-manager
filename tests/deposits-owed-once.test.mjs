// Security deposits: owed, then paid -- and released at most once.
//
// Owed, then paid: every path that books a deposit (setup wizard, property
// form, Tenants page, Leases page) charges it to the tenant's OWN AR account
// (DR tenant AR / CR 2100) under DEP-T<tenant id>; the tenant then pays it
// like rent. The Leases page used to debit Checking, as if the cash had
// already arrived.
//
// Released once: the Move-Out wizard, the Leases page "Process Deposit
// Return" and property deletion each took the deposit off 2100 under a random
// reference, and move-out never marked the lease -- so a deposit released at
// move-out could be returned again from the Leases page. All three now post
// their first entry under DEPRET-T<tenant id> (DEPRET-L<lease id> without a
// tenant id), check depositReleaseState first, and mark the lease.
//
// Part 1 tests the pure rules (src/utils/depositRules.js, no imports).
// Part 2 holds each path to them statically.
// Part 3 runs the real check read-only against the TEST project, if its
//        credentials are in tests/.env.
import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(import.meta.dirname, "..");
const src = (f) => fs.readFileSync(path.join(root, "src", f), "utf8");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     " + detail : "")); }
}
// A function body, from its declaration to the next top-level-ish function.
function fnBody(text, signature) {
  const i = text.indexOf(signature);
  if (i < 0) return "";
  const rest = text.slice(i + signature.length);
  const next = rest.search(/\n\s*(?:export\s+)?async function |\n\s*function /);
  return next < 0 ? rest : rest.slice(0, next);
}

const R = await import("data:text/javascript," + encodeURIComponent(src("utils/depositRules.js")));
assert("depositRules.js imports nothing", !/^\s*import\s/m.test(src("utils/depositRules.js")));

// ─── 1. PURE RULES ────────────────────────────────────────────────────────
console.log("\n🧮 REFERENCE SCHEME");
assert("release claim is DEPRET-T<tenant id>", R.depositReleaseReference(41, "lease-uuid") === "DEPRET-T41");
assert("string tenant id works the same", R.depositReleaseReference("41", null) === "DEPRET-T41");
assert("no tenant id -> DEPRET-L<lease id>", R.depositReleaseReference(null, "abc-123") === "DEPRET-Labc-123");
assert("neither -> null, never DEPRET-Tundefined",
  R.depositReleaseReference(undefined, undefined) === null && R.depositReleaseReference("", "") === null
  && R.depositReleaseReference("undefined", "null") === null);
assert("deduction reference shares the key", R.depositDeductionReference(41, "x") === "DEPDED-T41");
assert("tenant id 0 is still an id", R.depositReleaseReference(0, null) === "DEPRET-T0");
const refs = R.depositReleaseReferences([41, "41", null], "L9");
assert("check covers claim + deduction under tenant AND lease key, deduplicated",
  JSON.stringify(refs) === JSON.stringify(["DEPRET-T41", "DEPDED-T41", "DEPRET-LL9", "DEPDED-LL9"]), JSON.stringify(refs));
assert("no ids -> nothing to check", R.depositReleaseReferences([], null).length === 0);

console.log("\n🧮 ALREADY RELEASED?");
const D = R.decideDepositRelease;
assert("nothing on the books, held -> not released", D({ depositStatus: "held" }).released === false);
assert("no args -> not released", D().released === false);
assert("live release entry -> released", D({ entries: [{ reference: "DEPRET-T1", status: "posted" }], depositStatus: "held" }).released === true);
assert("live entry wins over a voided one", D({ entries: [{ reference: "DEPRET-T1", status: "voided" }, { reference: "DEPRET-T1", status: "posted" }] }).released === true);
assert("draft (non-voided) entry counts as released", D({ entries: [{ reference: "DEPRET-T1", status: "draft" }] }).released === true);
assert("only a VOIDED release -> not released, even with a stale 'returned' status",
  D({ entries: [{ reference: "DEPRET-T1", status: "voided" }], depositStatus: "returned" }).released === false);
assert("legacy move-out credit -> released", D({ legacyMoveOutCredit: true, depositStatus: "held" }).released === true);
assert("legacy move-out credit beats a voided new release",
  D({ entries: [{ reference: "DEPRET-T1", status: "voided" }], legacyMoveOutCredit: true }).released === true);
for (const st of ["returned", "partial_return", "forfeited"]) {
  assert(`deposit_status '${st}' with no entries (legacy random-ref release) -> released`, D({ depositStatus: st }).released === true);
}
assert("unknown status -> not released", D({ depositStatus: null }).released === false);
assert("released result carries a reason", typeof D({ depositStatus: "forfeited" }).reason === "string");
assert("RELEASED_DEPOSIT_STATUSES matches leases_deposit_status_check (minus 'held')",
  JSON.stringify(R.RELEASED_DEPOSIT_STATUSES) === JSON.stringify(["returned", "partial_return", "forfeited"]));

console.log("\n🧮 LEASES PAGE BUTTON");
const O = R.depositReturnOfferable;
const lease = { id: "L1", tenant_id: 7, deposit_status: "held" };
assert("held, nothing released -> offered", O(lease, []) === true);
assert("released at move-out (live DEPRET-T7) -> NOT offered", O(lease, [{ reference: "DEPRET-T7", status: "posted" }]) === false);
assert("another tenant's release does not hide it", O(lease, [{ reference: "DEPRET-T70", status: "posted" }]) === true);
assert("returned + only a voided release -> offered again", O({ ...lease, deposit_status: "returned" }, [{ reference: "DEPRET-T7", status: "voided" }]) === true);
assert("returned, no entries (legacy) -> not offered", O({ ...lease, deposit_status: "returned" }, []) === false);
assert("lease without tenant id keyed by lease", O({ id: "L1", tenant_id: null, deposit_status: "held" }, [{ reference: "DEPRET-LL1", status: "posted" }]) === false);
assert("null lease -> not offered", O(null, []) === false);

console.log("\n🧮 FAILS CLOSED");
const boom = { from() { throw new Error("network down"); } };
const closed = await R.depositReleaseStateWith(boom, "co", { tenantId: 1, leaseId: "L" });
assert("a thrown lookup reads as released, with the error", closed.released === true && !!closed.error);
const errClient = { from() { const q = { select: () => q, eq: () => q, in: () => q, maybeSingle: async () => ({ data: null, error: { message: "boom" } }), then: undefined }; return q; } };
const closed2 = await R.depositReleaseStateWith(errClient, "co", { tenantId: 1, leaseId: "L" });
assert("an error response reads as released, with the error", closed2.released === true && closed2.error === "boom");
const noCo = await R.depositReleaseStateWith(boom, "", { tenantId: 1 });
assert("missing company fails closed", noCo.released === true && !!noCo.error);

// ─── 2. EACH PATH ─────────────────────────────────────────────────────────
const acct = src("utils/accounting.js");
const leases = src("components/Leases.js");
const tenants = src("components/Tenants.js");
const props = src("components/Properties.js");
const life = src("components/Lifecycle.js");

console.log("\n📒 OWED, THEN PAID (deposit received)");
const own = fnBody(acct, "export async function tenantOwnArAccountId(");
assert("tenantOwnArAccountId exists", own.length > 0);
assert("tenantOwnArAccountId refuses an account whose tenant_id is not this tenant",
  /String\(data\.tenant_id\) === String\(tenantId\) \? data\.id : null/.test(own));
assert("tenantOwnArAccountId refuses when there is no tenant id", /tenantId === null \|\| tenantId === undefined/.test(own));
const leaseSave = fnBody(leases, "async function saveLease(");
assert("Leases page: deposit no longer debits Checking",
  !/account_id: "1000"[^\n]*debit: dep/.test(leaseSave) && !/Security deposit from[^\n]*\n[^\n]*"1000"/.test(leaseSave));
assert("Leases page: deposit debits the tenant's own AR", /tenantOwnArAccountId\(companyId, form\.tenant_name, tenant\?\.id\)/.test(leaseSave)
  && /account_id: depArId[^\n]*debit: dep, credit: 0/.test(leaseSave));
assert("Leases page: deposit credits 2100", /account_id: "2100"[^\n]*debit: 0, credit: dep/.test(leaseSave));
assert("Leases page: refuses (with a message) when no own AR", /if \(!depArId\) \{\s*showToast\(/.test(leaseSave));
for (const [label, body] of [["Tenants page", tenants], ["property form / wizard", props]]) {
  assert(`${label}: uses tenantOwnArAccountId for the deposit`, /tenantOwnArAccountId\(/.test(body));
}
assert("Tenants page: no deposit leg on getOrCreateTenantAR any more",
  !/getOrCreateTenantAR\(companyId, _name, tenantId\)\]\)/.test(tenants));
assert("wizard: deposit AR is the tenant's own", /const tenantArId = await tenantOwnArAccountId\(companyId, tName, resTenantId\)/.test(props));
assert("property form: deposit AR is the tenant's own", /const tenantArId = await tenantOwnArAccountId\(companyId, form\.tenant\.trim\(\), tenantId\)/.test(props));
// Every "Security deposit received" posting is DR <tenant AR var> / CR 2100.
for (const [label, body] of [["Leases", leases], ["Tenants", tenants], ["Properties", props]]) {
  const sites = body.split(/description: ['"]Security deposit received/).slice(1).map(s => s.slice(0, 900));
  assert(`${label}: every deposit posting uses depositReference and never a 1000 line`,
    sites.length > 0 && sites.every(s => /depositReference\(|depRef/.test(s) && !/account_id: ['"]1000['"]/.test(s)),
    `${sites.length} site(s)`);
}

console.log("\n📒 RELEASED ONCE");
assert("accounting.js re-exports the rules and binds the check", /export function depositReleaseState\(/.test(acct) && /depositReleaseStateWith\(supabase/.test(acct));
// Leases page
const ret = fnBody(leases, "async function processDepositReturn(");
const retBody = fnBody(leases, "async function _processDepositReturn(");
assert("Leases return: checks depositReleaseState before posting", /depositReleaseState\(companyId, \{ tenantId: lease\.tenant_id, leaseId: lease\.id \}\)/.test(ret)
  && /if \(rel\.released\)/.test(ret));
assert("Leases return: refusal is a clear message", /cannot be returned again: " \+ rel\.reason/.test(ret));
assert("Leases return: no random DEPRET-/DEPDED- reference", !/"DEPRET-" \+ shortId\(\)|"DEPDED-" \+ shortId\(\)/.test(leases));
assert("Leases return: first entry carries the claim", /const claimRef = depositReleaseReference\(lease\.tenant_id, lease\.id\)/.test(retBody)
  && /reference: claimRef/.test(retBody));
assert("Leases return: a forfeit-only return puts the claim on the deduction",
  /const dedRef = returned > 0 \? depositDeductionReference\(lease\.tenant_id, lease\.id\) : claimRef/.test(retBody) && /reference: dedRef/.test(retBody));
assert("Leases return: deposit_status is written AFTER the release posts",
  retBody.indexOf("deposit_status: status") > retBody.indexOf("reference: dedRef"));
assert("Leases return: amounts/accounts unchanged (2100 -> 1000, 2100 -> 4150)",
  /account_id: "2100"[^\n]*debit: returned/.test(retBody) && /account_id: "1000"[^\n]*credit: returned/.test(retBody)
  && /account_id: "2100"[^\n]*debit: deducted/.test(retBody) && /account_id: "4150"[^\n]*credit: deducted/.test(retBody));
assert("Leases page: button uses depositReturnOfferable (hidden once released at move-out)",
  /depositReturnOfferable\(l, depositReleases\)/.test(leases) && !/l\.deposit_status === "held" && \(l\.status/.test(leases));
assert("Leases page: release entries are fetched paged", /fetchAllPaged\(\(\) => supabase\.from\("acct_journal_entries"\)\.select\("reference, status"\)/.test(leases));
// Move-out
const mo = fnBody(life, "async function executeMoveOut(");
assert("move-out: checks depositReleaseState BEFORE move_out_commit_state",
  mo.indexOf("depositReleaseState(cid") > -1 && mo.indexOf("depositReleaseState(cid") < mo.indexOf('rpc("move_out_commit_state"'));
assert("move-out: a failed check stops the move-out (fails closed)", /if \(rel\.error\) \{[\s\S]{0,200}return;/.test(mo));
assert("move-out: release uses the shared claim, not DEP-TFR-<random>",
  /reference: depositReleaseReference\(selectedTenant\.id, selectedLease\.id\)/.test(mo) && !/DEP-TFR-\$\{shortId\(\)\}/.test(mo));
assert("move-out: release posts only when not already released", /if \(releaseDeposit\) \{/.test(mo));
assert("move-out: marks the lease 'returned' after a successful release",
  /else if \(selectedLease\.id\) \{[\s\S]{0,200}deposit_status: "returned"/.test(mo));
assert("move-out: amounts/accounts unchanged (2100 -> tenant AR)",
  /account_id: "2100"[^\n]*debit: depositAmount/.test(mo) && /account_id: unifiedArId[^\n]*credit: depositAmount/.test(mo));
assert("move-out: write-off math uses what was actually released", /outstandingBalance - releasedAmount \+ totalDeductions/.test(mo));
// Property delete
const pdel = props.slice(props.indexOf("// 7. Clear security deposit liabilities"), props.indexOf("// Terminate leases, disable autopay"));
assert("property delete: checks depositReleaseState", /depositReleaseState\(companyId, \{ tenantId: lease\.tenant_id, leaseId: lease\.id \}\)/.test(pdel));
assert("property delete: uses the shared claim, not DEPFORF-<random>", /reference: depositReleaseReference\(lease\.tenant_id, lease\.id\)/.test(pdel) && !/DEPFORF-" \+ shortId/.test(pdel));
assert("property delete: marks forfeited only when the entry posted", /if \(forfJeId\) await supabase\.from\("leases"\)\.update\(\{ deposit_status: "forfeited" \}\)/.test(pdel));
// Nothing else releases 2100 under a random reference.
const all = ["components/Leases.js", "components/Lifecycle.js", "components/Properties.js", "components/Tenants.js"].map(src).join("\n");
assert("no random-reference deposit release anywhere", !/(DEP-TFR-|DEPRET-|DEPDED-|DEPFORF-)["'`]? ?\+ ?shortId|(DEP-TFR-|DEPRET-|DEPDED-|DEPFORF-)\$\{shortId/.test(all));

// ─── 3. READ-ONLY AGAINST TEST ────────────────────────────────────────────
console.log("\n🔎 TEST PROJECT (read-only)");
try { require("dotenv").config({ path: path.join(import.meta.dirname, ".env"), quiet: true }); } catch (_e) { /* optional */ }
const url = process.env.TEST_SUPABASE_URL, key = process.env.TEST_SUPABASE_SERVICE_KEY;
if (url && key && /vpeewlplgxthckpidhxo/.test(url)) {
  const { createClient } = require("@supabase/supabase-js");
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const none = await R.depositReleaseStateWith(sb, "sandbox-llc", { tenantId: 987654321, leaseId: null });
  assert("unknown tenant: not released, no error", none.released === false && !none.error, JSON.stringify(none));
  const { data: rows, error } = await sb.from("acct_journal_entries").select("company_id, reference")
    .like("reference", "DEPRET-T%").neq("status", "voided").limit(1000);
  if (error) assert("release entries readable", false, error.message);
  else {
    const seen = new Set(), dup = [];
    for (const r of rows || []) { const k = r.company_id + "|" + r.reference; if (seen.has(k)) dup.push(k); seen.add(k); }
    assert("no company has two live entries under one DEPRET-T claim", dup.length === 0, dup.slice(0, 5).join(", "));
  }
} else {
  console.log("  (skipped: no TEST_SUPABASE_URL / TEST_SUPABASE_SERVICE_KEY)");
}

console.log(`\n${fail === 0 ? "✅" : "❌"} Passed: ${pass}   ❌ Failed: ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
