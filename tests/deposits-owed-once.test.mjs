// Security deposits: owed, then paid -- and released at most once.
//
// Owed, then paid: every path that books a deposit (setup wizard, property
// form, Tenants page, Leases page) charges it to the tenant's OWN AR account
// (DR tenant AR / CR 2100) under DEP-T<tenant id>; the tenant then pays it
// like rent. The Leases page used to debit Checking, as if the cash had
// already arrived.
//
// Released once: the Move-Out wizard and the Leases page "Process Deposit
// Return" post under one lease-derived key (DEPRET-T<tenant id>, or
// DEPRET-L<root lease id> for a lease chain with no tenant id), check
// depositReleaseState first (renewal chain, legacy random-ref releases,
// per-leg voids) and mark the lease. Property deletion does nothing with
// deposits. The Leases page warns when the tenant still owes money and can
// apply the deposit to that balance instead.
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
const UUID = "8f115d3b-ec19-4037-92af-382d4bb0069a", UUID2 = "060ebaaf-13e4-47cd-8cc6-0c94fa63f8c3";
assert("release claim is DEPRET-T<tenant id>", R.depositReleaseReference(41, UUID) === "DEPRET-T41");
assert("no tenant id -> DEPRET-L<lease id>", R.depositReleaseReference(null, UUID) === "DEPRET-L" + UUID);
assert("neither -> null, never DEPRET-Tundefined",
  R.depositReleaseReference(undefined, undefined) === null && R.depositReleaseReference("", "") === null
  && R.depositReleaseReference("undefined", "null") === null);
assert("deduction reference shares the key", R.depositDeductionReference(41, "x") === "DEPDED-T41");
assert("tenant id 0 is still an id", R.depositReleaseReference(0, null) === "DEPRET-T0");
const refs = R.depositReleaseReferences([41, "41", null], [UUID, null]);
assert("check covers claim + deduction under every tenant AND lease key, deduplicated",
  JSON.stringify(refs) === JSON.stringify(["DEPRET-T41", "DEPDED-T41", "DEPRET-L" + UUID, "DEPDED-L" + UUID]), JSON.stringify(refs));
assert("no ids -> nothing to check", R.depositReleaseReferences([], []).length === 0);
// Bug 2: one key per deposit, derived from the LEASE and its renewal chain.
assert("chain key: the lease's own tenant id", JSON.stringify(R.chainReleaseKey([{ id: UUID, tenant_id: 7 }])) === JSON.stringify({ tenantId: 7, leaseId: null }));
assert("chain key: a renewal with no tenant id uses the ROOT lease (so old and new rows share one key)",
  R.chainReleaseKey([{ id: UUID2, tenant_id: null }, { id: UUID, tenant_id: null }]).leaseId === UUID);
assert("chain key: an ancestor's tenant id wins over the root lease id",
  R.chainReleaseKey([{ id: UUID2, tenant_id: null }, { id: UUID, tenant_id: 9 }]).tenantId === 9);
assert("keyed refs recognised", R.isKeyedReleaseRef("DEPRET-T12") && R.isKeyedReleaseRef("DEPDED-L" + UUID));
assert("legacy random refs are NOT keyed", !R.isKeyedReleaseRef("DEPRET-a1b2c3d4e5f6") && !R.isKeyedReleaseRef("DEP-TFR-a1b2c3d4e5f6"));
assert("legacy prefixes recognised", ["DEP-TFR-a1b2c3d4e5f6", "DEPRET-a1b2c3d4e5f6", "DEPDED-0a0b0c0d0e0f", "DEPFORF-a1b2c3d4e5f6"].every(R.isLegacyReleaseRef));
assert("keyed refs and move-out deductions are not legacy releases", !R.isLegacyReleaseRef("DEPRET-T12") && !R.isLegacyReleaseRef("DEP-DED-a1b2c3d4e5f6") && !R.isLegacyReleaseRef("DEP-T12"));

console.log("\n🧮 LEGACY RELEASES (bug 3)");
const L = R.classifyLegacyReleases([
  { reference: "DEP-TFR-aaaaaaaaaaaa", date: "2026-06-01", description: "Deposit transferred to ledger — Jane Roe" },
  { reference: "DEPRET-bbbbbbbbbbbb", date: "2026-06-02", description: "legacy ret" },
  { reference: "DEPRET-cccccccccccc", date: "2025-01-01", description: "Security deposit return — Old Tenant" },
  { reference: "DEPRET-T99", date: "2026-06-03", description: "someone else, keyed" },
], { names: ["Jane Roe"], since: "2026-01-01" });
assert("legacy release naming the tenant -> definite", L.definite.length === 1 && L.definite[0].reference.startsWith("DEP-TFR-"));
assert("legacy release at the property naming nobody we know -> ambiguous", L.ambiguous.length === 1 && L.ambiguous[0].reference === "DEPRET-bbbbbbbbbbbb");
assert("legacy release before this tenancy started is ignored", ![...L.definite, ...L.ambiguous].some(e => e.date === "2025-01-01"));
assert("another tenant's KEYED release at the property is ignored", ![...L.definite, ...L.ambiguous].some(e => e.reference === "DEPRET-T99"));

console.log("\n🧮 ALREADY RELEASED?");
const D = R.decideDepositRelease;
const base = { deposit: 1000, claimReference: "DEPRET-T1", deductionReference: "DEPDED-T1" };
assert("nothing on the books, held -> not released, all of it releasable", (() => { const r = D({ ...base, depositStatuses: ["held"] }); return !r.released && r.remaining === 1000 && r.freeReferences.length === 2; })());
assert("no args -> not released", D().released === false);
assert("live release covering the deposit -> released", D({ ...base, entries: [{ reference: "DEPRET-T1", status: "posted", amount: 1000 }] }).released === true);
assert("live entry wins over a voided one", D({ ...base, entries: [{ reference: "DEPRET-T1", status: "voided", amount: 1000 }, { reference: "DEPRET-T1", status: "posted", amount: 1000 }] }).released === true);
assert("only a VOIDED release -> not released, even with a stale 'returned' status",
  D({ ...base, entries: [{ reference: "DEPRET-T1", status: "voided", amount: 1000 }], depositStatuses: ["returned"] }).released === false);
assert("legacy move-out credit -> released", D({ ...base, legacyMoveOutCredit: true, depositStatuses: ["held"] }).released === true);
// Bug 3 (E4): a voided new-style release must not override a live legacy release.
const e4 = D({ ...base, entries: [{ reference: "DEPRET-T1", status: "voided", amount: 1 }], depositStatuses: ["returned"], legacyAmbiguous: [{ reference: "DEPRET-bbbbbbbbbbbb", date: "2026-06-01" }] });
assert("E4: legacy release + voided new-style release -> still released", e4.released === true && /cannot be told apart/.test(e4.reason), e4.reason);
assert("E2: ambiguous legacy release (name-only AR, lease 'held') -> released, and says why",
  (() => { const r = D({ ...base, depositStatuses: ["held"], legacyAmbiguous: [{ reference: "DEP-TFR-aaaaaaaaaaaa" }] }); return r.released && /treated as released/.test(r.reason); })());
assert("definite legacy release -> released", D({ ...base, legacyDefinite: [{ reference: "DEP-TFR-aaaaaaaaaaaa" }] }).released === true);
assert("A4: deposit booking (DEP-T) only voided (property deleted) -> nothing to release",
  (() => { const r = D({ ...base, depositStatuses: ["held"], depositBookings: [{ reference: "DEP-T1", status: "voided" }] }); return r.released && /was voided/.test(r.reason); })());
assert("deposit booking voided AND re-posted -> still releasable",
  D({ ...base, depositStatuses: ["held"], depositBookings: [{ reference: "DEP-T1", status: "voided" }, { reference: "DEP-T1", status: "posted" }] }).released === false);
assert("no DEP-T booking known (QB import / legacy) -> not blocked by this rule", D({ ...base, depositStatuses: ["held"], depositBookings: [] }).released === false);
for (const st of ["returned", "partial_return", "forfeited"]) {
  assert(`deposit_status '${st}' on the lease or its renewal chain, no entries -> released`, D({ ...base, depositStatuses: ["held", st] }).released === true);
}
// Bug 7 (D2): per-leg.
const d2 = D({ ...base, entries: [{ reference: "DEPRET-T1", status: "voided", amount: 700 }, { reference: "DEPDED-T1", status: "posted", amount: 300 }] });
assert("D2: voided cash leg + live deduction -> PARTIAL, 700 still held", !d2.released && d2.partial && d2.remaining === 700, JSON.stringify(d2));
assert("D2: only the voided leg's reference is free", JSON.stringify(d2.freeReferences) === JSON.stringify(["DEPRET-T1"]));
const both = D({ ...base, entries: [{ reference: "DEPRET-T1", status: "posted", amount: 700 }, { reference: "DEPDED-T1", status: "posted", amount: 200 }] });
assert("live legs short of the deposit with both refs taken -> released, remainder must be manual", both.released && both.remaining === 100 && /manually/.test(both.reason));
assert("remaining never negative", D({ ...base, entries: [{ reference: "DEPRET-T1", status: "posted", amount: 1500 }] }).remaining === 0);
assert("RELEASED_DEPOSIT_STATUSES matches leases_deposit_status_check (minus 'held')",
  JSON.stringify(R.RELEASED_DEPOSIT_STATUSES) === JSON.stringify(["returned", "partial_return", "forfeited"]));

console.log("\n🧮 RELEASE LEGS + STATUS");
const P = R.planReleaseLegs;
const p1 = P({ returned: 700, deducted: 300, freeReferences: ["DEPRET-T1", "DEPDED-T1"] });
assert("split: cash leg takes the claim, deduction takes DEPDED", p1.legs[0].kind === "return" && p1.legs[0].reference === "DEPRET-T1" && p1.legs[1].reference === "DEPDED-T1");
const p2 = P({ returned: 0, deducted: 1000, freeReferences: ["DEPRET-T1", "DEPDED-T1"] });
assert("forfeit-only: the deduction takes the claim", p2.legs.length === 1 && p2.legs[0].reference === "DEPRET-T1");
assert("two legs but one free reference -> refused with a reason", !!P({ returned: 500, deducted: 200, freeReferences: ["DEPRET-T1"] }).error);
assert("one leg, one free reference -> uses it", P({ returned: 700, freeReferences: ["DEPRET-T1"] }).legs[0].reference === "DEPRET-T1");
assert("nothing to release -> error", !!P({ returned: 0, deducted: 0, freeReferences: ["DEPRET-T1"] }).error);
const S = R.releasedDepositStatus;
assert("status: all to tenant -> returned", S({ deposit: 1000, returnedNow: 1000 }) === "returned");
assert("status: some -> partial_return", S({ deposit: 1000, returnedNow: 700 }) === "partial_return");
assert("status: none -> forfeited", S({ deposit: 1000, returnedNow: 0 }) === "forfeited");
assert("status: earlier live cash leg counts", S({ deposit: 1000, priorReturned: 700, returnedNow: 300 }) === "returned");
assert("isDeductionEntry reads the description", R.isDeductionEntry({ description: "Deposit deduction — x" }) && !R.isDeductionEntry({ description: "Security deposit return — x" }) && !R.isDeductionEntry({ description: "Deposit applied to balance — x" }));

console.log("\n🧮 LEASES PAGE BUTTON");
const O = R.depositReturnOfferable;
const lease = { id: UUID, tenant_id: 7, deposit_status: "held", security_deposit: 1000 };
assert("held, nothing released -> offered", O(lease, []) === true);
assert("released at move-out (live DEPRET-T7) -> NOT offered", O(lease, [{ reference: "DEPRET-T7", status: "posted", amount: 1000 }]) === false);
assert("another tenant's release does not hide it", O(lease, [{ reference: "DEPRET-T70", status: "posted", amount: 1000 }]) === true);
assert("returned + only a voided release -> offered again", O({ ...lease, deposit_status: "returned" }, [{ reference: "DEPRET-T7", status: "voided", amount: 1000 }]) === true);
assert("returned, no entries (legacy) -> not offered", O({ ...lease, deposit_status: "returned" }, []) === false);
assert("partial: one leg voided, remainder still held -> offered",
  O({ ...lease, deposit_status: "partial_return" }, [{ reference: "DEPRET-T7", status: "voided", amount: 700 }, { reference: "DEPDED-T7", status: "posted", amount: 300 }]) === true);
assert("renewal without tenant id: released under the parent lease key -> not offered",
  O({ id: UUID2, tenant_id: null, renewed_from: UUID, deposit_status: "held", security_deposit: 1000 }, [{ reference: "DEPRET-L" + UUID, status: "posted", amount: 1000 }]) === false);
assert("null lease -> not offered", O(null, []) === false);

console.log("\n🧮 FAILS CLOSED");
const boom = { from() { throw new Error("network down"); } };
const closed = await R.depositReleaseStateWith(boom, "co", { tenantId: 1, leaseId: "L" });
assert("a thrown lookup reads as released, with the error", closed.released === true && !!closed.error);
const errResult = { data: null, error: { message: "boom" } };
const errClient = { from() { const q = { select: () => q, eq: () => q, in: () => q, neq: () => q, or: () => q, gt: () => q, ilike: () => q, limit: () => q, maybeSingle: async () => errResult, then: (res) => res(errResult) }; return q; } };
const closed2 = await R.depositReleaseStateWith(errClient, "co", { tenantId: 1, leaseId: "L" });
assert("an error response reads as released, with the error", closed2.released === true && closed2.error === "boom", JSON.stringify(closed2));
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
const rules = src("utils/depositRules.js");
assert("state walks the renewal chain both ways (renewed_from)", /\.in\("renewed_from", expand\)/.test(rules) && /\.in\("id", need\)/.test(rules));
assert("state looks for legacy releases at the lease's property", /\.in\("property", props\)/.test(rules) && /reference\.like\.DEP-TFR-%/.test(rules));
// Leases page
const openM = fnBody(leases, "async function openDepositModal(");
const ret = fnBody(leases, "async function processDepositReturn(");
const retBody = fnBody(leases, "async function _processDepositReturn(");
assert("Leases return: checks depositReleaseState before posting", /depositReleaseState\(companyId, \{ tenantId: lease\.tenant_id, leaseId: lease\.id \}\)/.test(ret)
  && /if \(rel\.released\)/.test(ret));
assert("Leases return: refusal is a clear message", /cannot be returned again: " \+ rel\.reason/.test(ret));
assert("Leases return: no random DEPRET-/DEPDED- reference", !/"DEPRET-" \+ shortId\(\)|"DEPDED-" \+ shortId\(\)/.test(leases));
assert("Leases return: legs take the state's free references (claim first)", /planReleaseLegs\(\{ returned, deducted, freeReferences: rel\.freeReferences \}\)/.test(retBody)
  && (retBody.match(/reference: leg\.reference/g) || []).length === 3);
assert("Leases return: only what is still held can be released", /const held = safeNum\(rel\.remaining\)/.test(retBody) && /const deducted = Math\.round\(\(held - returned\)/.test(retBody));
assert("Leases return: deposit_status set only when every leg posted (bug 7)", /if \(complete\) upd\.deposit_status = releasedDepositStatus/.test(retBody)
  && retBody.indexOf("upd.deposit_status") > retBody.indexOf("posted.push(leg)"));
assert("Leases return: a failed later leg says what is still held", /was not posted\. The lease stays “held”/.test(retBody));
assert("Leases return: cash leg unchanged (2100 -> 1000)", /account_id: "2100"[^\n]*debit: leg\.amount[^\n]*memo: "Return to "/.test(retBody) && /account_id: "1000"[^\n]*credit: leg\.amount/.test(retBody));
assert("Leases return: deduction leg unchanged (2100 -> 4150)", /account_id: "4150"[^\n]*credit: leg\.amount/.test(retBody));
// Owner decision B
assert("B: modal reads the tenant's balance fresh from the GL", /tenantOwedFromGL\(companyId, l\.tenant_id\)/.test(openM));
assert("B: processing re-reads the balance and warns (non-blocking) before a cash refund", /const owed = lease\.tenant_id \? await tenantOwedFromGL/.test(ret) && /still owes " \+ formatCurrency\(owed\)/.test(ret));
assert("B: 'apply to balance' posts 2100 -> the tenant's OWN AR", /leg\.kind === "return" && apply/.test(retBody) && /account_id: arId[^\n]*credit: leg\.amount/.test(retBody)
  && /tenantOwnArAccountId\(companyId, lease\.tenant_name, lease\.tenant_id\)/.test(retBody));
assert("B: modal offers Apply / Refund cash anyway", /Apply to balance/.test(leases) && /Refund cash anyway/.test(leases));
assert("tenantOwedFromGL sums the tenant's own AR, voided excluded", /\.eq\("tenant_id", tenantId\)/.test(fnBody(acct, "export async function tenantOwedFromGL(")) && /neq\("acct_journal_entries\.status", "voided"\)/.test(fnBody(acct, "export async function tenantOwedFromGL(")));
assert("Leases page: button uses depositReturnOfferable", /depositReturnOfferable\(l, depositReleases\)/.test(leases) && !/l\.deposit_status === "held" && \(l\.status/.test(leases));
assert("Leases page: release entries are fetched paged, with amounts", /fetchAllPaged\(\(\) => supabase\.from\("acct_journal_entries"\)\.select\("reference, status, acct_journal_lines\(debit\)"\)/.test(leases));
// Bug 2a: renewal
const renew = fnBody(leases, "async function renewLease(");
assert("2a: renewal carries deposit_status (and return details) to the new lease", /deposit_status: lease\.deposit_status \|\| "held"/.test(renew) && /deposit_returned: lease\.deposit_returned/.test(renew));
// Bug 4: tenant by id
const save = fnBody(leases, "async function saveLease(");
assert("4: Leases form picks the tenant by id", /const tenant = form\.tenant_id \? tenants\.find\(t => String\(t\.id\) === String\(form\.tenant_id\)\)/.test(save)
  && !/tenants\.find\(t => t\.name === form\.tenant_name\)/.test(leases));
assert("4: dropdown value is the tenant id", /<Select value=\{form\.tenant_id\}/.test(leases) && /<option key=\{t\.id\} value=\{String\(t\.id\)\}>/.test(leases));
assert("4: a new lease without a chosen tenant is refused", /\(!editingLease && !tenant\)/.test(save));
// Move-out
const sel = fnBody(life, "async function selectTenant(");
const mo = fnBody(life, "async function executeMoveOut(");
assert("5: move-out matches the lease by tenant_id first", /String\(l\.tenant_id\) === String\(t\.id\)/.test(sel));
assert("5: a lease without tenant_id only when name AND property match", /l\.tenant_name === t\.name && l\.property === t\.property/.test(sel));
assert("5: never by property alone / name alone", !/l\.tenant_name === t\.name \|\| l\.property === t\.property/.test(life));
assert("5: more than one candidate lease -> refused with a message", /candidates\.length > 1/.test(sel) && /cannot tell which one ends/.test(sel));
assert("move-out: checks depositReleaseState BEFORE move_out_commit_state",
  mo.indexOf("depositReleaseState(cid") > -1 && mo.indexOf("depositReleaseState(cid") < mo.indexOf('rpc("move_out_commit_state"'));
assert("move-out: a failed check stops the move-out (fails closed)", /if \(rel\.error\) \{[\s\S]{0,200}return;/.test(mo));
assert("2b: move-out posts under the state's lease-derived reference (same as Leases page)", /releaseRef = \(rel\.freeReferences \|\| \[\]\)\[0\]/.test(mo) && /reference: releaseRef/.test(mo) && !/depositReleaseReference\(selectedTenant/.test(mo));
assert("move-out: releases only what is still held", /releaseAmt = safeNum\(rel\.remaining\)/.test(mo) && /debit: releaseAmt/.test(mo) && /credit: releaseAmt/.test(mo));
assert("move-out: accounts unchanged (2100 -> tenant AR)", /account_id: "2100"[^\n]*debit: releaseAmt/.test(mo) && /account_id: unifiedArId[^\n]*credit: releaseAmt/.test(mo));
assert("6: releasedAmount set only after the release entry posted", /let releasedAmount = 0;/.test(mo) && /if \(depResult\.jeId\) \{\s*releasedAmount = releaseAmt;/.test(mo));
assert("6: write-off math uses what was actually released", /outstandingBalance - releasedAmount \+ totalDeductions/.test(mo)
  && mo.indexOf("outstandingBalance - releasedAmount") > mo.indexOf("releasedAmount = releaseAmt"));
assert("6: a refused release says 'already released', not 'post manually'", /already released elsewhere/.test(mo));
assert("move-out: marks the lease 'returned' only after a successful release", /releasedAmount = releaseAmt;[\s\S]{0,400}deposit_status: "returned"/.test(mo));
assert("7: a skipped release is shown, not just logged", /is not released again at this move-out/.test(mo));
// Owner decision A
const pdel = props.slice(props.indexOf("// 7. Security deposits: deleting a property"), props.indexOf("// Terminate leases, disable autopay"));
assert("A: property delete posts nothing for deposits", pdel.length > 0 && !/atomicPostJEAndLedger|autoPostJournalEntry|4150|2100/.test(pdel.replace(/\/\/.*$/gm, "")));
assert("A: property delete no longer marks leases forfeited", !/deposit_status: "forfeited"/.test(props));
assert("A: no DEPFORF / release helpers left in Properties.js", !/DEPFORF-" \+ shortId|depositReleaseState|depositReleaseReference/.test(props));
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
