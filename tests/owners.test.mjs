// Owners: properties managed for outside owners.
//
// Five defects, one suite:
//  1. properties.owner_id was never written (only free-text owner_name), so
//     statements, the owner portal and the fee accrual never found a property.
//  2. `management_fee_pct || 10` charged a 0% owner 10%; the accrual said 0.
//  3. Statements read the payments table (capped at 500) and work_orders.cost,
//     not the books.
//  4. "Distributed (YTD)" summed fee accruals AND payouts.
//  5. Only autopay Run Now accrued the owner's share; manual ledger payments,
//     the Stripe webhook and Banking-page deposits did not.
//  Owner decision (2026-09-28): the fee base is RENT ONLY -- late fees and
//  other income pass through with no fee. A receipt is applied rent-first:
//  only the part paying this month's not-yet-accrued rent is reclassified
//  and charged the fee; the rest reaches the owner via the statement.
//
// Part 1 tests the pure rules (src/utils/ownerRules.js).
// Part 2 holds the code paths to them statically.
// Part 3 runs everything against the TEST project in a throwaway company
//        tagged QA-OWN (deleted afterwards; leftovers are counted): the real
//        utils (assignPropertyOwner, autoOwnerDistribution, loadOwnerLedger)
//        with the service-role client, and the REAL Stripe webhook handler
//        with only Stripe itself faked. The component-level journal entries
//        (the manual ledger payment, autopay Run Now, Pay Owner) are
//        reimplemented here exactly as the components write them.
//        OWNERS_TEST_KEEP=1 leaves the data in place (prints the company id)
//        for manual SQL checks; OWNERS_TEST_CLEANUP=<company id> removes it.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Readable } from "stream";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(import.meta.dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     " + detail : "")); }
}

const R = require(path.join(root, "src/utils/ownerRules.js"));

// ─── 1. PURE RULES ────────────────────────────────────────────────────────
console.log("\n🧮 MANAGEMENT FEE — ONE RULE");
assert("0 means 0 (not 10)", R.resolveMgmtFeePct({ management_fee_pct: 0 }).pct === 0 && R.resolveMgmtFeePct({ management_fee_pct: 0 }).isSet === true);
assert("'0' string means 0", R.resolveMgmtFeePct({ management_fee_pct: "0" }).pct === 0);
assert("8 means 8", R.resolveMgmtFeePct({ management_fee_pct: 8 }).pct === 8);
assert("null = not set -> 0%, flagged", R.resolveMgmtFeePct({ management_fee_pct: null }).pct === 0 && R.resolveMgmtFeePct({ management_fee_pct: null }).isSet === false);
assert("undefined / '' = not set", !R.resolveMgmtFeePct({}).isSet && !R.resolveMgmtFeePct({ management_fee_pct: "" }).isSet);
assert("not set + company default 7 -> 7, still flagged not set", R.resolveMgmtFeePct({ management_fee_pct: null }, 7).pct === 7 && R.resolveMgmtFeePct({ management_fee_pct: null }, 7).source === "company");
assert("owner 0 beats a company default", R.resolveMgmtFeePct({ management_fee_pct: 0 }, 7).pct === 0);
assert("negative clamps to 0", R.resolveMgmtFeePct({ management_fee_pct: -5 }).pct === 0);
assert("feeLabel: set / not set", R.feeLabel({ management_fee_pct: 0 }) === "0% fee" && R.feeLabel({ management_fee_pct: null }) === "Fee not set (0%)");
assert("parseFeeInput: blank -> null, 0 -> 0, 101 / abc -> error",
  R.parseFeeInput("").value === null && R.parseFeeInput("0").value === 0 && !!R.parseFeeInput("101").error && !!R.parseFeeInput("abc").error);
assert("fee cents: 8% of $1234.56 = $98.76; 0% = 0; negative income = 0",
  R.mgmtFeeCents(123456, 8) === 9876 && R.mgmtFeeCents(123456, 0) === 0 && R.mgmtFeeCents(-500, 10) === 0);

console.log("\n🧮 REFERENCES + KINDS");
const oid = "0f1e2d3c-aaaa-bbbb-cccc-000000000001";
assert("accrual ref is ODIST- and deterministic", R.ownerAccrualReference({ ownerId: oid, tenantName: "Jo Smith", date: "2026-09-05", cents: 150000 }) === "ODIST-" + oid + "-jo_smith-20260905-150000");
const pr = R.payoutReference({ ownerId: oid, date: "2026-09-28", cents: 100000, userRef: "Chk #1001" });
assert("payout ref is generated, not the user's text", pr === "DIST-0f1e2d3c-20260928-100000-CHK1001" && pr !== "Chk #1001", pr);
assert("payout ref: same inputs -> same ref (double-post collides)", pr === R.payoutReference({ ownerId: oid, date: "2026-09-28", cents: 100000, userRef: "chk 1001" }));
assert("payout ref: different check -> different ref", pr !== R.payoutReference({ ownerId: oid, date: "2026-09-28", cents: 100000, userRef: "1002" }));
assert("payout ref without user text", R.payoutReference({ ownerId: oid, date: "2026-09-28", cents: 5 }) === "DIST-0f1e2d3c-20260928-5");
assert("kind from reference: ODIST- accrual, else payout",
  R.distributionKindFromReference("ODIST-x") === "accrual" && R.distributionKindFromReference("DIST-x") === "payout" && R.distributionKindFromReference("") === "payout" && R.distributionKindFromReference("1001") === "payout");
const dists = [
  { kind: "accrual", amount: 644, date: "2026-03-01" },
  { kind: "payout", amount: 1000, date: "2026-03-02" },
  { kind: "payout", amount: 50, date: "2026-03-03", voided_at: "2026-03-04" },
  { kind: "payout", amount: 7, date: "2025-12-31" },
  { reference: "ODIST-legacy", amount: 99, date: "2026-01-01" },
  { reference: "old-typed-ref", amount: 3, date: "2026-01-02" },
];
assert("YTD counts payouts once: accruals + voided + other years excluded", R.sumPayouts(dists, { year: "2026" }) === 1003, String(R.sumPayouts(dists, { year: "2026" })));
assert("isLivePayout", R.isLivePayout({ kind: "payout" }) && !R.isLivePayout({ kind: "accrual" }) && !R.isLivePayout({ kind: "payout", voided_at: "x" }));

console.log("\n🧮 STATEMENT FROM THE LEDGER");
const accts = [
  { id: "i4000", code: "4000", name: "Rental Income", type: "Revenue" },
  { id: "i4010", code: "4010", name: "Late Fee Income", type: "Revenue" },
  { id: "i4200", code: "4200", name: "Management Fee Income", type: "Revenue" },
  { id: "x5300", code: "5300", name: "Repairs", type: "Expense" },
  { id: "x5400", code: "5400", name: "Utilities", type: "Expense" },
  { id: "a1000", code: "1000", name: "Checking", type: "Asset" },
  { id: "l2200", code: "2200", name: "Owner Dist Payable", type: "Liability" },
];
const je = (reference, date = "2026-09-10", status = "posted") => ({ reference, date, status, description: reference });
const glLines = [
  { id: 1, account_id: "i4000", debit: 0, credit: 1500, acct_journal_entries: je("RECUR-1") },
  { id: 2, account_id: "i4010", debit: 0, credit: 50, acct_journal_entries: je("LATEFEE-1") },
  { id: 3, account_id: "x5300", debit: 300, credit: 0, acct_journal_entries: je("BILL-1") },
  { id: 4, account_id: "x5400", debit: 120.5, credit: 0, acct_journal_entries: je("BILL-2") },
  { id: 5, account_id: "x5300", debit: 999, credit: 0, acct_journal_entries: je("BILL-3", "2026-09-10", "voided") },
  { id: 6, account_id: "x5300", debit: 55, credit: 0, acct_journal_entries: je("BILL-4", "2026-08-31") },
  { id: 7, account_id: "i4000", debit: 700, credit: 0, acct_journal_entries: je("ODIST-x") },
  { id: 8, account_id: "i4200", debit: 0, credit: 56, acct_journal_entries: je("ODIST-x") },
  { id: 9, account_id: "i4200", debit: 0, credit: 10, acct_journal_entries: je("MANUAL-fee") },
  { id: 3, account_id: "x5300", debit: 300, credit: 0, acct_journal_entries: je("BILL-1") },  // fetched twice
  { id: 10, account_id: "l2200", debit: 1000, credit: 0, acct_journal_entries: je("DIST-y") },
];
const st = R.buildOwnerStatement({ lines: glLines, accounts: accts, feeRule: R.resolveMgmtFeePct({ management_fee_pct: 8 }),
  payouts: [{ kind: "payout", amount: 1000, date: "2026-09-20", method: "check" }, { kind: "accrual", amount: 644, date: "2026-09-05" }], startDate: "2026-09-01", endDate: "2026-09-30" });
assert("income = rent + late fee (ODIST reclass and 4200 excluded)", st.totalIncome === 1550, String(st.totalIncome));
assert("expenses = posted, in period, de-duplicated (voided / last month excluded)", st.totalExpenses === 420.5, String(st.totalExpenses));
assert("fee = 8% of RENT only (late fee carries no fee)", st.managementFee === 120 && st.rentIncome === 1500, String(st.managementFee));
assert("net = income - expenses - fee", st.netToOwner === 1009.5, String(st.netToOwner));
assert("fee line reads 'x% of rent'", /^8% of rent 1500\.00/.test(st.lineItems.find(c => c.category === "Management Fee").items[0].description));
assert("distributions paid = payouts only", st.distributionsPaid === 1000);
assert("categories: Income, Expenses, Management Fee, Distributions Paid", st.lineItems.map(c => c.category).join(",") === "Income,Expenses,Management Fee,Distributions Paid");
const st0 = R.buildOwnerStatement({ lines: glLines, accounts: accts, feeRule: R.resolveMgmtFeePct({ management_fee_pct: 0 }), payouts: [], startDate: "2026-09-01", endDate: "2026-09-30" });
assert("0% owner is charged 0", st0.managementFee === 0 && st0.netToOwner === 1129.5);
const stN = R.buildOwnerStatement({ lines: glLines, accounts: accts, feeRule: R.resolveMgmtFeePct({ management_fee_pct: null }), payouts: [], startDate: "2026-09-01", endDate: "2026-09-30" });
assert("unset fee -> 0, and the statement says 'Fee not set'", stN.managementFee === 0 && /Fee not set/.test(stN.lineItems.find(c => c.category === "Management Fee").items[0].description));

console.log("\n🧮 RENT ONLY + RENT FIRST");
assert("rent account: code 4000 / 4000-xx / named Rental Income",
  R.isRentIncomeAccount({ code: "4000" }) && R.isRentIncomeAccount({ code: "4000-01" }) && R.isRentIncomeAccount({ code: "4050", name: "Rental Income - Unit B" }) &&
  !R.isRentIncomeAccount({ code: "4010", name: "Late Fee Income" }) && !R.isRentIncomeAccount({ code: "4100", name: "Other Income" }) && !R.isRentIncomeAccount({ code: "40001" }));
assert("rent-first: receipt within open rent -> all rent", R.rentPortionCents(70000, 150000, 0) === 70000);
assert("rent-first: receipt beyond open rent -> capped at open rent", R.rentPortionCents(130000, 120000, 0) === 120000);
assert("rent-first: rent already accrued -> nothing (late fee / other)", R.rentPortionCents(5000, 150000, 150000) === 0);
assert("rent-first: partly accrued", R.rentPortionCents(80000, 150000, 70000) === 80000 && R.rentPortionCents(90000, 150000, 70000) === 80000);

console.log("\n🧮 OWNER NAMES");
const ownerList = [{ id: "a", name: "Jane  Doe" }, { id: "b", name: "Twin" }, { id: "c", name: "twin" }, { id: "d", name: "Gone", archived_at: "x" }];
assert("findOwnerByName: case/space-insensitive", R.findOwnerByName(ownerList, " jane doe ")?.id === "a");
assert("findOwnerByName: ambiguous -> null, archived -> null", R.findOwnerByName(ownerList, "TWIN") === null && R.findOwnerByName(ownerList, "Gone") === null);
assert("propertyOwnerName: linked record wins, text is the fallback",
  R.propertyOwnerName({ owner_id: "a", owner_name: "stale" }, new Map([["a", { name: "Jane Doe" }]])) === "Jane Doe" &&
  R.propertyOwnerName({ owner_id: null, owner_name: "Text Only" }, new Map()) === "Text Only");

// ─── 2. STATIC: every path uses the rules ─────────────────────────────────
console.log("\n🔍 STATIC");
const owners = read("src/components/Owners.js");
const acct = read("src/utils/accounting.js");
const api = read("api/stripe.js");
const ten = read("src/components/Tenants.js");
const pay = read("src/components/Payments.js");
const props = read("src/components/Properties.js");
const imp = read("src/components/PropertyImport.js");
const docs = read("src/components/Documents.js");
const ownUtil = read("src/utils/owners.js");
const MIG = read("supabase/migrations/20260928100000_owner_distribution_kind.sql");
assert("no `|| 10` fee default left in Owners.js", !/management_fee_pct\s*\|\|\s*10/.test(owners) && !/feePct\s*=\s*owner\.management_fee_pct\s*\|\|/.test(owners));
assert("Owners.js resolves the fee with resolveMgmtFeePct", owners.includes("resolveMgmtFeePct(owner)"));
assert("statement built from the ledger (loadOwnerLedger + buildOwnerStatement), not payments/work_orders",
  owners.includes("loadOwnerLedger(companyId, ownerProps, startDate, endDate)") && owners.includes("buildOwnerStatement(") && !owners.includes('from("payments")') && !/work_orders"\)\.select\("\*"\)\.eq\("company_id", companyId\)\.in\("property", propAddresses\)/.test(owners));
assert("statement lines are paged (fetchAllPaged), no .limit(500)", ownUtil.includes("fetchAllPaged(() => base().in(\"class_id\"") && !owners.includes(".limit(500)"));
assert("YTD stat counts payouts only", owners.includes("sumPayouts(distributions, { year:"));
assert("Pay Owner: kind payout + generated reference, user text kept as memo",
  owners.includes('kind: "payout"') && owners.includes("payoutReference({ ownerId: owner.id") && !owners.includes("distForm.reference || \"DIST-\""));
assert("accrual writer sets kind accrual", read("src/utils/ownerRules.js").includes('kind: "accrual"'));
assert("autoOwnerDistribution runs the shared function", acct.includes("runOwnerDistributionAccrual(supabase,"));
assert("Stripe webhook runs the same shared function", api.includes('require("../src/utils/ownerRules")') && api.includes("runOwnerDistributionAccrual(sb,"));
assert("manual ledger payment accrues the owner's share", /newCharge\.type === "payment" && arLegIsPerTenant\)[\s\S]{0,80}autoOwnerDistribution\(companyId, selectedTenant\.property, Math\.abs\(amount\), today, selectedTenant\.name, selectedTenant\.id\)/.test(ten));
assert("Banking: add + split deposits run the owner accrual after a successful post",
  (read("src/components/Banking.js").match(/if \(isInflow\) await accrueOwnerShareForBankDeposit\(companyId, \{ date: txn\.posted_date/g) || []).length === 2);
assert("autopay Run Now still accrues", /autoOwnerDistribution\(companyId, s\.property, amt, today/.test(pay));
assert("wizard writes owner_id via assignPropertyOwner after commit", props.includes("assignPropertyOwner(companyId, resPropertyId, propForm.owner_id || null)") && props.includes("<OwnerPicker"));
assert("property page has the picker", props.includes("ownerSlot={") && read("src/components/PropertyPage.js").includes("ownerSlot ||"));
assert("Properties list reads the linked owner (propertyOwnerName / _ownerKey)", props.includes("propertyOwnerName(p, ownersById)") && props.includes("p._ownerKey !== filterOwner") && !props.includes("p.owner_name !== filterOwner"));
assert("import links owner records (creates when missing)", imp.includes("findOrCreateOwnerByName(companyId, name, ownerList)") && imp.includes("patch.owner_id =") && !imp.includes('owner_name: r.owner_name || ""'));
assert("Documents merge fields look the owner up by owner_id first", docs.includes('.eq("id", prop.owner_id)'));
assert("assignPropertyOwner derives owner_name from the record", /update\(\{ owner_id: owner \? owner\.id : null, owner_name: owner \? owner\.name : "" \}\)/.test(ownUtil));
assert("portal shows payouts only", owners.includes("setDistributions((d.data || []).filter(isLivePayout))"));
assert("migration: kind check + NOT NULL + backfill from reference", /CHECK \(kind IN \('accrual','payout'\)\)/.test(MIG) && /SET kind = CASE WHEN reference LIKE 'ODIST-%'/.test(MIG) && /ALTER COLUMN kind SET NOT NULL/.test(MIG));
assert("migration: void follows the journal entry", /AFTER UPDATE OF status ON public\.acct_journal_entries/.test(MIG));
assert("migration: gate on payouts only; no SECURITY DEFINER added", /= 'payout' THEN\s+v_destructive := true; v_action := 'record an owner payout'/.test(MIG) && !/SECURITY DEFINER/.test(MIG.replace(/^--.*$/mg, "")));
assert("migration: new functions revoked from PUBLIC, anon", (MIG.match(/REVOKE ALL ON FUNCTION public\.owner_distribution_\w+\(\) FROM PUBLIC, anon;/g) || []).length === 2);

// ─── 3. TEST DB ───────────────────────────────────────────────────────────
console.log("\n🌐 TEST DB (throwaway company QA-OWN)");
require("./sandbox-env");
const { createClient } = require("@supabase/supabase-js");
const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_SERVICE_KEY, ANON = process.env.TEST_SUPABASE_ANON_KEY;
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

async function cleanupCompany(CO, userIds = []) {
  const { data: jes } = await sb.from("acct_journal_entries").select("id").eq("company_id", CO);
  const ids = (jes || []).map(j => j.id);
  for (let i = 0; i < ids.length; i += 100) await sb.from("acct_journal_lines").delete().in("journal_entry_id", ids.slice(i, i + 100));
  for (const tb of ["bank_feed_transaction_link", "bank_posting_decision_line", "bank_posting_decision", "bank_feed_transaction", "bank_import_batch", "bank_account_feed",
                    "acct_journal_lines", "acct_journal_entries", "owner_distributions", "owner_statements", "payments", "ledger_entries",
                    "notification_queue", "notifications", "tenants", "properties", "owners", "acct_accounts", "acct_classes",
                    "company_members", "audit_trail", "error_log"]) {
    await sb.from(tb).delete().eq("company_id", CO);
  }
  await sb.from("companies").delete().eq("id", CO);
  for (const u of userIds) { try { await sb.auth.admin.deleteUser(u); } catch (_) { /* gone */ } }
}
async function leftovers(CO) {
  const out = {};
  for (const tb of ["bank_feed_transaction", "bank_account_feed", "acct_journal_entries", "acct_journal_lines", "owner_distributions", "owner_statements", "payments", "tenants", "properties", "owners", "acct_accounts", "acct_classes", "company_members"]) {
    const { count } = await sb.from(tb).select("id", { count: "exact", head: true }).eq("company_id", CO);
    if (count) out[tb] = count;
  }
  const { count: c } = await sb.from("companies").select("id", { count: "exact", head: true }).eq("id", CO);
  if (c) out.companies = c;
  return out;
}

if (process.env.OWNERS_TEST_CLEANUP) {
  await cleanupCompany(process.env.OWNERS_TEST_CLEANUP, (process.env.OWNERS_TEST_USERS || "").split(",").filter(Boolean));
  const left = await leftovers(process.env.OWNERS_TEST_CLEANUP);
  console.log("cleanup leftovers:", JSON.stringify(left));
  process.exit(Object.keys(left).length ? 1 : 0);
}

const TAG = "QA-OWN-" + crypto.randomBytes(3).toString("hex");
const CO = TAG.toLowerCase();
const userIds = [];
const KEEP = process.env.OWNERS_TEST_KEEP === "1";

// Browser modules in node, with the service-role client standing in for
// the signed-in staff client (the functions under test are unchanged).
process.chdir(path.join(root, "tests"));
if (typeof globalThis.window === "undefined") globalThis.window = { location: { href: "node-test" } };
await import("./esm-extensionless.mjs");
const { supabase } = await import("../src/supabase.js");
supabase.from = sb.from.bind(sb);
supabase.rpc = sb.rpc.bind(sb);
const A = await import("../src/utils/accounting.js");
const OU = await import("../src/utils/owners.js");

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const month = today.slice(0, 7);
const startDate = month + "-01";
const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
const endDate = month + "-" + pad(lastDay);
const prevMonthDay = new Date(now.getFullYear(), now.getMonth(), 0);
const prevDate = `${prevMonthDay.getFullYear()}-${pad(prevMonthDay.getMonth() + 1)}-${pad(prevMonthDay.getDate())}`;
const ok = (r, w) => { if (r.error) throw new Error(w + ": " + r.error.message); return r.data; };

try {
  ok(await sb.from("companies").insert([{ id: CO, name: TAG + " owners test (temp)" }]), "company");
  const acc = {};
  const mkAcct = async (code, name, type, extra = {}) => (acc[code] = ok(await sb.from("acct_accounts").insert([{ company_id: CO, code, name, type, is_active: true, old_text_id: CO + "-" + code, ...extra }]).select("*").single(), "acct " + code));
  await mkAcct("1000", "Checking Account", "Asset");
  await mkAcct("1100", "Accounts Receivable", "Asset");
  await mkAcct("2200", "Owner Distributions Payable", "Liability");
  await mkAcct("4000", "Rental Income", "Revenue");
  await mkAcct("4010", "Late Fee Income", "Revenue");
  await mkAcct("4100", "Other Income", "Revenue");
  await mkAcct("4200", "Management Fee Income", "Revenue");
  await mkAcct("5300", "Repairs", "Expense");
  await mkAcct("5400", "Utilities", "Expense");
  await mkAcct("5500", "HOA Dues", "Expense");
  await mkAcct("5600", "Property Taxes", "Expense");
  await mkAcct("5700", "Mortgage Interest", "Expense");

  // Five properties; P5 has no owner (control).
  const P = {};
  for (const [k, n] of [["P1", 101], ["P2", 102], ["P3", 103], ["P4", 104], ["P5", 105], ["P6", 106], ["P7", 107]]) {
    const row = ok(await sb.from("properties").insert([{ company_id: CO, address_line_1: `${n} ${TAG} Way`, city: "Testville", state: "MD", zip: "20001", address: `${n} ${TAG} Way, Testville, MD 20001`, type: "Single Family", status: "occupied" }]).select("*").single(), "property " + k);
    const cls = ok(await sb.from("acct_classes").insert([{ id: crypto.randomUUID(), company_id: CO, name: row.address, is_active: true }]).select("id").single(), "class " + k);
    ok(await sb.from("properties").update({ class_id: cls.id }).eq("id", row.id), "class link " + k);
    P[k] = { ...row, class_id: cls.id };
  }

  // Owners: 8% / 0% / not set. Created through the real createOwner.
  const O8 = (await OU.createOwner(CO, { name: TAG + " Eight Pct", management_fee_pct: 8, email: CO + "-owner@example.com" })).owner;
  const O0 = (await OU.createOwner(CO, { name: TAG + " Zero Pct", management_fee_pct: 0 })).owner;
  const ON = (await OU.createOwner(CO, { name: TAG + " Unset Pct" })).owner;
  assert("createOwner stores an unset fee as null (not 10)", ON && ON.management_fee_pct === null, JSON.stringify(ON));
  assert("createOwner stores 0 as 0", O0 && Number(O0.management_fee_pct) === 0);

  // Link through the picker's write path (assignPropertyOwner, as the
  // wizard's post-commit step and the property page call it).
  for (const [k, o] of [["P1", O8], ["P2", O8], ["P3", O0], ["P4", ON], ["P6", O8], ["P7", O8]]) {
    const r = await OU.assignPropertyOwner(CO, P[k].id, o.id);
    assert(`${k} linked to ${o.name}`, r.ok, r.error);
  }
  const { data: linked } = await sb.from("properties").select("id, owner_id, owner_name").eq("company_id", CO).order("id");
  assert("owner_id written and owner_name derived from the record", linked.filter(p => p.owner_id).length === 6 && linked.every(p => !p.owner_id || p.owner_name === [O8, O0, ON].find(o => o.id === p.owner_id).name));
  const un = await OU.assignPropertyOwner(CO, P.P5.id, null);
  assert("clearing an owner writes null + ''", un.ok && (await sb.from("properties").select("owner_id, owner_name").eq("id", P.P5.id).single()).data.owner_id === null);
  const bad = await OU.assignPropertyOwner(CO, P.P5.id, crypto.randomUUID());
  assert("an owner from nowhere is refused", !bad.ok);

  // Import resolution: existing name links, a new name creates one owner once.
  const pool = [O8, O0, ON].map(o => ({ ...o }));
  const f1 = await OU.findOrCreateOwnerByName(CO, "  " + O8.name.toLowerCase() + " ", pool);
  const f2 = await OU.findOrCreateOwnerByName(CO, TAG + " Imported Owner", pool);
  const f3 = await OU.findOrCreateOwnerByName(CO, TAG + " imported  owner", pool);
  assert("import: an existing owner's name links to that record", f1.owner?.id === O8.id && !f1.created);
  assert("import: a new name creates the owner once", f2.created && f3.owner?.id === f2.owner?.id && !f3.created);

  // Tenants + their own AR + this month's rent charge (RECUR-).
  const T = {};
  const tenantsSpec = [["T1", "P1", 1500], ["T2", "P2", 1200], ["T3", "P3", 1000], ["T4", "P4", 900], ["T5", "P7", 300], ["T6", "P6", 600]];
  let seq = 0;
  for (const [k, pk, rent] of tenantsSpec) {
    const t = ok(await sb.from("tenants").insert([{ company_id: CO, name: `${TAG} Tenant ${k}`, property: P[pk].address, lease_status: "active", balance: 0, rent, email: `${CO}-${k.toLowerCase()}@example.com` }]).select("*").single(), "tenant " + k);
    const ar = await mkAcct("1100-" + (++seq).toString().padStart(3, "0"), "AR - " + t.name, "Asset", { tenant_id: t.id, parent_id: acc["1100"].id });
    T[k] = { ...t, ar, rent, pk };
    const jeId = await A.autoPostJournalEntry({ companyId: CO, date: startDate, reference: `RECUR-${crypto.randomBytes(4).toString("hex")}-${month}`, description: "Rent " + t.name, property: P[pk].address,
      lines: [{ account_id: ar.id, account_name: ar.name, debit: rent, credit: 0, class_id: P[pk].class_id, memo: "rent" }, { account_id: acc["4000"].id, account_name: "Rental Income", debit: 0, credit: rent, class_id: P[pk].class_id, memo: "rent" }] });
    assert(`rent charge posted for ${k}`, !!jeId);
  }

  // ── receipts, one per path ──
  // (a) Manual ledger payment -- Tenants.js addLedgerEntry, type "payment".
  const manual = async (k, amt) => {
    const t = T[k];
    const res = await A.atomicPostJEAndLedger({ companyId: CO, date: today, description: "Manual payment — " + t.name, reference: "MANUAL-" + crypto.randomBytes(4).toString("hex"), property: t.property,
      lines: [{ account_id: acc["1000"].id, account_name: "Checking Account", debit: amt, credit: 0, class_id: P[t.pk].class_id, memo: t.name }, { account_id: t.ar.id, account_name: t.ar.name, debit: 0, credit: amt, class_id: P[t.pk].class_id, memo: "payment" }],
      ledgerEntry: { tenant: t.name, tenant_id: t.id, property: t.property, date: today, description: "payment", amount: -amt, type: "payment", balance: 0 }, balanceUpdate: null });
    assert(`manual receipt posted (${k})`, !!res.jeId, res.error);
    return A.autoOwnerDistribution(CO, t.property, amt, today, t.name, t.id);
  };
  const m1 = await manual("T1", 700);
  assert("manual ledger payment accrues the owner's share (8%)", m1.posted && m1.mgmtFee === 56 && m1.ownerNet === 644, JSON.stringify(m1));
  // (b) Autopay Run Now -- Payments.js runNow. A MIXED receipt: T2 also owes
  // a $100 other charge (4100), and pays $1,300. Rent-first: $1,200 is rent
  // (fee 8% = 96), the $100 is other income, no fee, not accrued.
  {
    const t0 = T.T2;
    const oc = await A.autoPostJournalEntry({ companyId: CO, date: startDate, reference: "MANUAL-" + crypto.randomBytes(4).toString("hex"), description: "Other charge " + t0.name, property: t0.property,
      lines: [{ account_id: t0.ar.id, account_name: t0.ar.name, debit: 100, credit: 0, class_id: P.P2.class_id, memo: "key replacement" }, { account_id: acc["4100"].id, account_name: "Other Income", debit: 0, credit: 100, class_id: P.P2.class_id, memo: "key replacement" }] });
    assert("other charge posted for T2", !!oc);
  }
  {
    const t = T.T2, amt = 1300;
    const res = await A.atomicPostJEAndLedger({ companyId: CO, date: today, description: "Autopay received — " + t.name, reference: "APAY-" + t.id + "-" + today.replace(/-/g, ""), property: t.property,
      lines: [{ account_id: "1000", account_name: "Checking Account", debit: amt, credit: 0, class_id: P.P2.class_id, memo: "Autopay" }, { account_id: t.ar.id, account_name: t.ar.name, debit: 0, credit: amt, class_id: P.P2.class_id, memo: "AR settlement" }],
      ledgerEntry: { tenant: t.name, tenant_id: t.id, property: t.property, date: today, description: "Autopay payment (ach)", amount: -amt, type: "payment", balance: 0 }, balanceUpdate: null });
    assert("autopay receipt posted", !!res.jeId, res.error);
    const a2 = await A.autoOwnerDistribution(CO, t.property, amt, today, t.name, t.id);
    assert("mixed autopay receipt $1,300: fee on the $1,200 rent only (96), net 1104", a2.posted && a2.rentPortion === 1200 && a2.mgmtFee === 96 && a2.ownerNet === 1104, JSON.stringify(a2));
    const { data: a2Lines } = await sb.from("acct_journal_lines").select("debit").eq("journal_entry_id", a2.jeId).gt("debit", 0);
    assert("…and only the rent ($1,200) is reclassified out of Rental Income", (a2Lines || []).length === 1 && Number(a2Lines[0].debit) === 1200);
    const { data: a2Dist } = await sb.from("owner_distributions").select("notes").eq("company_id", CO).eq("reference", a2.reference).single();
    assert("…and the accrual notes the $100 non-rent part", /100\.00 non-rent, no fee/.test(a2Dist?.notes || ""), a2Dist?.notes);
    const again = await A.autoOwnerDistribution(CO, t.property, amt, today, t.name, t.id);
    assert("the same receipt twice accrues once", again.skipped === "already accrued", JSON.stringify(again));
  }
  // (c) Stripe webhook -- the real handler, only Stripe itself faked.
  {
    const t = T.T1, rentCents = 80000, pi = "pi_" + CO.replace(/-/g, "_") + "_1";
    const event = { type: "payment_intent.succeeded", data: { object: { id: pi, metadata: { company_id: CO, tenant_id: String(t.id), rent_cents: String(rentCents), tenant_name: t.name, property: t.property } } } };
    const Module = require("module");
    const origLoad = Module._load;
    const FakeStripe = function () { return { webhooks: { constructEvent: (_raw, sig) => { if (sig !== "valid") throw new Error("bad sig"); return event; } } }; };
    Module._load = function (req) {
      if (req === "stripe") return FakeStripe;
      if (req === "web-push") return { setVapidDetails() {}, sendNotification: async () => {} };
      return origLoad.apply(this, arguments);
    };
    const saved = { ...process.env };
    process.env.STRIPE_SECRET_KEY = "sk_test_mock"; process.env.STRIPE_WEBHOOK_SECRET = "whsec_mock";
    process.env.SUPABASE_URL = SB_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = SB_KEY;
    delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; delete process.env.REACT_APP_VAPID_PUBLIC_KEY;
    const modPath = path.join(root, "api/stripe.js");
    delete require.cache[require.resolve(modPath)];
    const handler = require(modPath);
    Module._load = origLoad;
    const call = () => new Promise((resolve) => {
      const req = Readable.from([Buffer.from("{}")]);
      req.method = "POST"; req.headers = { "stripe-signature": "valid" }; req.query = { action: "webhook" };
      const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
        json(o) { resolve({ status: this.statusCode, body: o }); return this; }, end() { resolve({ status: this.statusCode, body: null }); return this; } };
      handler(req, res);
    });
    const r = await call();
    Object.assign(process.env, saved);
    assert("Stripe webhook posted the receipt", r.status === 200 && !r.body?.error, JSON.stringify(r));
    const { data: sj } = await sb.from("acct_journal_entries").select("id, date").eq("company_id", CO).eq("reference", "STRIPE-" + pi);
    const sDate = sj?.[0]?.date;
    const { data: sAcc } = await sb.from("owner_distributions").select("*").eq("company_id", CO).eq("kind", "accrual").like("reference", "ODIST-" + O8.id + "-%-" + String(sDate || "").replace(/-/g, "") + "-" + rentCents);
    assert("Stripe webhook accrues the owner's share server side (8% of $800 -> $736 net)", (sAcc || []).length === 1 && Number(sAcc[0].amount) === 736, JSON.stringify(sAcc));
    const r2 = await call();
    assert("a replayed webhook is idempotent (no second accrual)", r2.status === 200 && r2.body?.idempotent === true);
  }
  // T1's rent is now fully accrued (700 + 800 = 1,500): a further $50 (the
  // late fee) is not rent -- no accrual, no fee.
  {
    const late = await manual("T1", 50);
    assert("a receipt beyond this month's rent (late fee) accrues nothing, charges no fee", late.skipped && /no unaccrued rent/.test(late.skipped), JSON.stringify(late));
  }
  // (d) 0% owner and (e) unset-fee owner.
  const m3 = await manual("T3", 1000);
  assert("0% owner: charged 0, full amount to the owner", m3.posted && m3.mgmtFee === 0 && m3.ownerNet === 1000 && m3.feePct === 0, JSON.stringify(m3));
  const { data: m3Lines } = await sb.from("acct_journal_lines").select("account_id").eq("journal_entry_id", m3.jeId);
  assert("0% owner: the accrual has no management-fee line", (m3Lines || []).length === 2 && !(m3Lines || []).some(l => l.account_id === acc["4200"].id));
  const m4 = await manual("T4", 900);
  assert("unset-fee owner: 0 charged", m4.posted && m4.mgmtFee === 0 && m4.ownerNet === 900, JSON.stringify(m4));
  const { data: m4Dist } = await sb.from("owner_distributions").select("notes, kind").eq("company_id", CO).eq("reference", m4.reference).single();
  assert("unset-fee owner: accrual row flagged '(not set)'", m4Dist?.kind === "accrual" && /\(not set\)/.test(m4Dist.notes), JSON.stringify(m4Dist));
  // (f) Banking page: a deposit categorised to a tenant's AR through the real
  // post_bank_transaction RPC, then the post-success hook Banking.js runs
  // (accrueOwnerShareForBankDeposit) -- 'add' and 'split'.
  {
    const feed = ok(await sb.from("bank_account_feed").insert([{ company_id: CO, gl_account_id: acc["1000"].id, account_name: TAG + " feed", masked_number: "***0000", account_type: "checking", institution_name: "QA Bank", connection_type: "csv", status: "active" }]).select("id").single(), "feed");
    const mkTxn = async (n, amt) => ok(await sb.from("bank_feed_transaction").insert([{ company_id: CO, bank_account_feed_id: feed.id, source_type: "csv", provider_transaction_id: CO + "-" + n,
      posted_date: today, amount: amt, direction: "inflow", bank_description_raw: "DEPOSIT " + n, bank_description_clean: "DEPOSIT " + n, payee_normalized: "Tenant", fingerprint_hash: CO + "-fp-" + n, status: "for_review" }]).select("*").single(), "bank txn " + n);
    // 'add': $650 to T6's AR (rent $600) -> rent-first: $600 rent, fee 48, net 552.
    const t6 = T.T6, x1 = await mkTxn(1, 650);
    const { data: r1, error: e1 } = await sb.rpc("post_bank_transaction", { p_company_id: CO, p_txn_id: x1.id, p_kind: "add", p_description: "DEPOSIT 1", p_property: P.P6.address,
      p_lines: [{ account_id: acc["1000"].id, account_name: "Checking Account", debit: 650, credit: 0, class_id: P.P6.class_id, memo: "dep", entity_type: "customer", entity_id: String(t6.id), entity_name: t6.name },
                { account_id: t6.ar.id, account_name: t6.ar.name, debit: 0, credit: 650, class_id: P.P6.class_id, memo: "dep", entity_type: "customer", entity_id: String(t6.id), entity_name: t6.name }],
      p_decision: { payee: "Tenant", memo: "", header_class_id: P.P6.class_id }, p_decision_lines: [{ gl_account_id: t6.ar.id, gl_account_name: t6.ar.name, amount: 650, entry_side: "credit", memo: "" }] });
    assert("bank 'add' deposit posted by post_bank_transaction", !e1 && r1?.je_id, e1?.message);
    const b1 = await OU.accrueOwnerShareForBankDeposit(CO, { date: today, lines: [{ accountId: t6.ar.id, amount: 650 }] });
    assert("bank 'add' deposit accrues rent only: 600 rent, fee 48, net 552", b1.length === 1 && b1[0].posted && b1[0].rentPortion === 600 && b1[0].mgmtFee === 48 && b1[0].ownerNet === 552, JSON.stringify(b1));
    const b1again = await OU.accrueOwnerShareForBankDeposit(CO, { date: today, lines: [{ accountId: t6.ar.id, amount: 650 }] });
    assert("bank hook re-run is idempotent (same ODIST- reference)", b1again[0]?.skipped === "already accrued" && b1again[0]?.reference === b1[0].reference);
    // 'split': $325 -> $300 to T5's AR (rent $300) + $25 Other Income.
    const t5 = T.T5, x2 = await mkTxn(2, 325);
    const { data: r2, error: e2 } = await sb.rpc("post_bank_transaction", { p_company_id: CO, p_txn_id: x2.id, p_kind: "split", p_description: "Split — DEPOSIT 2", p_property: P.P7.address,
      p_lines: [{ account_id: acc["1000"].id, account_name: "Checking Account", debit: 325, credit: 0, class_id: null, memo: "Split transaction" },
                { account_id: t5.ar.id, account_name: t5.ar.name, debit: 0, credit: 300, class_id: P.P7.class_id, memo: "rent" },
                { account_id: acc["4100"].id, account_name: "Other Income", debit: 0, credit: 25, class_id: P.P7.class_id, memo: "laundry" }],
      p_decision: { memo: "Split into 2 lines" }, p_decision_lines: [
        { line_no: 1, gl_account_id: t5.ar.id, gl_account_name: t5.ar.name, amount: 300, entry_side: "credit", memo: "rent", class_id: P.P7.class_id },
        { line_no: 2, gl_account_id: acc["4100"].id, gl_account_name: "Other Income", amount: 25, entry_side: "credit", memo: "laundry", class_id: P.P7.class_id }] });
    assert("bank 'split' deposit posted by post_bank_transaction", !e2 && r2?.je_id, e2?.message);
    const b2 = await OU.accrueOwnerShareForBankDeposit(CO, { date: today, lines: [{ accountId: t5.ar.id, amount: 300 }, { accountId: acc["4100"].id, amount: 25 }] });
    assert("bank 'split': only the tenant-AR leg accrues (300 rent, fee 24, net 276); the $25 other income does not",
      b2.length === 1 && b2[0].posted && b2[0].rentPortion === 300 && b2[0].mgmtFee === 24 && b2[0].ownerNet === 276, JSON.stringify(b2));
  }
  const noOwner = await A.autoOwnerDistribution(CO, P.P5.address, 100, today, "x", null);
  assert("no owner -> nothing accrued", noOwner.skipped === "no owner");

  // ── expenses of several kinds (and noise that must not count) ──
  const exp = async (code, amt, pk, { classless = false, date = today, voided = false } = {}) => {
    const cls = classless ? null : P[pk].class_id;
    const id = await A.autoPostJournalEntry({ companyId: CO, date, reference: "QAEXP-" + crypto.randomBytes(4).toString("hex"), description: acc[code].name + " bill", property: P[pk].address, status: voided ? "voided" : "posted",
      lines: [{ account_id: acc[code].id, account_name: acc[code].name, debit: amt, credit: 0, class_id: cls, memo: "bill" }, { account_id: acc["1000"].id, account_name: "Checking", debit: 0, credit: amt, class_id: cls, memo: "bill" }] });
    assert(`expense posted (${acc[code].name} ${amt}${classless ? ", no class" : ""}${voided ? ", voided" : ""})`, !!id);
  };
  await exp("5300", 300, "P1");                       // repairs
  await exp("5400", 120.5, "P2");                     // utilities
  await exp("5500", 200, "P2", { classless: true });  // HOA -- no class, entry property text only
  await exp("5600", 400, "P1");                       // property tax
  await exp("5700", 250.25, "P2");                    // mortgage interest
  await exp("5300", 999, "P1", { voided: true });     // voided: excluded
  await exp("5300", 55, "P1", { date: prevDate });    // last month: excluded
  await exp("5300", 777, "P5");                       // not this owner's: excluded
  // late fee income on P1
  {
    const t = T.T1;
    const id = await A.autoPostJournalEntry({ companyId: CO, date: today, reference: "LATEFEE-" + t.id + "-" + month.replace("-", ""), description: "Late fee", property: t.property,
      lines: [{ account_id: t.ar.id, account_name: t.ar.name, debit: 50, credit: 0, class_id: P.P1.class_id, memo: "late" }, { account_id: acc["4010"].id, account_name: "Late Fee Income", debit: 0, credit: 50, class_id: P.P1.class_id, memo: "late" }] });
    assert("late fee posted", !!id);
  }

  // ── payout: Owners.js payOwner, with a user reference that already exists ──
  const collide = await A.autoPostJournalEntry({ companyId: CO, date: today, reference: "1001", description: "unrelated entry referenced 1001", property: "",
    lines: [{ account_id: acc["1000"].id, account_name: "Checking", debit: 1, credit: 0 }, { account_id: acc["1000"].id, account_name: "Checking", debit: 0, credit: 1 }] });
  assert("an unrelated entry already uses reference 1001", !!collide);
  const payAmt = 1000, userRef = "1001";
  const distRef = R.payoutReference({ ownerId: O8.id, date: today, cents: R.toCents(payAmt), userRef });
  const { data: dupJe } = await sb.from("acct_journal_entries").select("id").eq("company_id", CO).eq("reference", distRef).neq("status", "voided").limit(1);
  assert("payout pre-check finds no duplicate", (dupJe || []).length === 0);
  const distRow = ok(await sb.from("owner_distributions").insert([{ company_id: CO, owner_id: O8.id, kind: "payout", amount: payAmt, method: "check", reference: distRef, date: today, notes: "Ref #" + userRef }]).select("id").maybeSingle(), "payout row");
  const payRes = await A.atomicPostJEAndLedger({ companyId: CO, date: today, description: `Owner distribution — ${O8.name} (ref ${userRef})`, reference: distRef, property: "",
    lines: [{ account_id: "2200", account_name: "Owner Distributions Payable", debit: payAmt, credit: 0, class_id: P.P1.class_id, memo: "Distribution (ref 1001)" }, { account_id: "1000", account_name: "Checking Account", debit: 0, credit: payAmt, class_id: P.P1.class_id, memo: "Paid (ref 1001)" }], requireJE: false });
  assert("payout posted despite the user's '1001' (generated reference)", !!payRes.jeId && distRef !== "1001" && !!distRow?.id, JSON.stringify(payRes));

  // ── statement vs a direct GL query ──
  const ownerProps = [P.P1, P.P2, P.P6, P.P7];
  const gl = await OU.loadOwnerLedger(CO, ownerProps, startDate, endDate);
  const { data: allDists } = await sb.from("owner_distributions").select("*").eq("company_id", CO);
  const stmt = R.buildOwnerStatement({ lines: gl.lines, accounts: gl.accounts, feeRule: R.resolveMgmtFeePct(O8), payouts: allDists.filter(d => d.owner_id === O8.id), startDate, endDate });
  // Direct: every posted line in the period in the company, joined by hand.
  const { data: raw } = await sb.from("acct_journal_lines").select("id, account_id, debit, credit, class_id, acct_journal_entries!inner(date, reference, status, property)").eq("company_id", CO);
  const byAcct = new Map((await sb.from("acct_accounts").select("id, code, type").eq("company_id", CO)).data.map(a => [a.id, a]));
  const cls = new Set(ownerProps.map(p => p.class_id)), addrs = new Set(ownerProps.map(p => p.address));
  let dInc = 0, dExp = 0, dRent = 0;
  for (const l of raw) {
    const j = l.acct_journal_entries;
    if (j.status !== "posted" || j.date < startDate || j.date > endDate) continue;
    if (!(cls.has(l.class_id) || (l.class_id === null && addrs.has(j.property)))) continue;
    if (/^O?DIST-/.test(j.reference)) continue;
    const a = byAcct.get(l.account_id);
    if (a.code === "4200") continue;
    if (a.type === "Revenue") dInc += Math.round((l.credit - l.debit) * 100);
    if (a.type === "Revenue" && a.code === "4000") dRent += Math.round((l.credit - l.debit) * 100);
    if (a.type === "Expense") dExp += Math.round((l.debit - l.credit) * 100);
  }
  console.log(`     statement: income ${stmt.totalIncome} · rent ${stmt.rentIncome} · expenses ${stmt.totalExpenses} · fee ${stmt.managementFee} · net ${stmt.netToOwner} · paid ${stmt.distributionsPaid}`);
  console.log(`     direct GL: income ${dInc / 100} · rent ${dRent / 100} · expenses ${dExp / 100}`);
  assert("statement income = direct GL income", !gl.failed && stmt.totalIncome === dInc / 100);
  assert("statement expenses = direct GL expenses", stmt.totalExpenses === dExp / 100);
  assert("statement rent = direct GL rent (4000)", stmt.rentIncome === dRent / 100);
  assert("statement fee = 8% of direct GL rent", stmt.managementFee === Math.round(dRent * 8 / 100) / 100);
  assert("expected figures: income 3775 (rent 1500+1200+600+300, late fee 50, other 100+25)", stmt.totalIncome === 3775, String(stmt.totalIncome));
  assert("expected figures: expenses 1270.75 (repairs, utilities, HOA via property text, tax, interest)", stmt.totalExpenses === 1270.75, String(stmt.totalExpenses));
  assert("fee 8% of rent 3600 = 288 (not of 3775), net 2216.25", stmt.rentIncome === 3600 && stmt.managementFee === 288 && stmt.netToOwner === 2216.25, stmt.managementFee + " / " + stmt.netToOwner);
  assert("statement fee line reads '8% of rent 3600.00'", /^8% of rent 3600\.00/.test(stmt.lineItems.find(c => c.category === "Management Fee").items[0].description));
  assert("distributions paid in period = the payout only (1000)", stmt.distributionsPaid === 1000);
  const st0db = R.buildOwnerStatement({ ...(await OU.loadOwnerLedger(CO, [P.P3], startDate, endDate)), feeRule: R.resolveMgmtFeePct(O0), payouts: [], startDate, endDate });
  assert("0% owner's statement: income 1000, fee 0", st0db.totalIncome === 1000 && st0db.managementFee === 0);
  const stNdb = R.buildOwnerStatement({ ...(await OU.loadOwnerLedger(CO, [P.P4], startDate, endDate)), feeRule: R.resolveMgmtFeePct(ON), payouts: [], startDate, endDate });
  assert("unset-fee owner's statement: fee 0, marked 'Fee not set'", stNdb.managementFee === 0 && stNdb.feeIsSet === false);
  // owner_statements accepts what generateStatement writes
  const ins = await sb.from("owner_statements").insert([{ company_id: CO, owner_id: O8.id, owner_name: O8.name, period: month, start_date: startDate, end_date: endDate,
    total_income: stmt.totalIncome, total_expenses: stmt.totalExpenses, management_fee: stmt.managementFee, net_to_owner: stmt.netToOwner, line_items: JSON.stringify(stmt.lineItems), notes: "x", status: "draft" }]);
  assert("owner_statements insert accepted", !ins.error, ins.error?.message);

  // ── YTD counts payouts once ──
  const o8d = allDists.filter(d => d.owner_id === O8.id);
  const naive = o8d.reduce((s, d) => s + Number(d.amount), 0);
  const ytd = R.sumPayouts(allDists, { year: today.slice(0, 4) });
  console.log(`     owner_distributions for the 8% owner: ${o8d.length} rows (${o8d.filter(d => d.kind === "accrual").length} accruals); old YTD sum ${naive}, new ${ytd}`);
  assert("YTD = payouts only (1000), not accruals + payouts", ytd === 1000 && naive > 1000, `naive ${naive}`);
  // An old client (no kind) still gets the right kind from the reference.
  const legacy = ok(await sb.from("owner_distributions").insert([{ company_id: CO, owner_id: O8.id, amount: 1, reference: "ODIST-legacy-" + CO, date: today }]).select("kind").single(), "legacy insert");
  assert("insert without kind: ODIST- becomes 'accrual' (trigger)", legacy.kind === "accrual");
  await sb.from("owner_distributions").delete().eq("company_id", CO).eq("reference", "ODIST-legacy-" + CO);
  // Voiding the payout's journal entry voids the distribution.
  if (!KEEP) {
    ok(await sb.from("acct_journal_entries").update({ status: "voided" }).eq("id", payRes.jeId), "void payout JE");
    const { data: vd } = await sb.from("owner_distributions").select("voided_at").eq("id", distRow.id).single();
    const { data: after } = await sb.from("owner_distributions").select("*").eq("company_id", CO);
    assert("voiding the DIST- entry marks the distribution void", !!vd.voided_at);
    assert("…and YTD drops it", R.sumPayouts(after, { year: today.slice(0, 4) }) === 0);
    ok(await sb.from("acct_journal_entries").update({ status: "posted" }).eq("id", payRes.jeId), "un-void payout JE");
    const { data: uv } = await sb.from("owner_distributions").select("voided_at").eq("id", distRow.id).single();
    assert("un-voiding clears it", uv.voided_at === null);
  }

  // ── as real users: owner portal (RLS) and the office-assistant gate ──
  const mkUser = async (email, role) => {
    const password = "Qa!" + crypto.randomBytes(9).toString("hex");
    const { data, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error("createUser " + email + ": " + error.message);
    userIds.push(data.user.id);
    ok(await sb.from("company_members").insert([{ company_id: CO, user_email: email, role, status: "active", auth_user_id: data.user.id }]), "member " + role);
    const c = createClient(SB_URL, ANON, { auth: { persistSession: false } });
    const { error: sErr } = await c.auth.signInWithPassword({ email, password });
    if (sErr) throw new Error("signIn " + email + ": " + sErr.message);
    return c;
  };
  const ownerClient = await mkUser(O8.email, "owner");
  const { data: seen, error: seenErr } = await ownerClient.from("properties").select("id").eq("company_id", CO);
  const seenIds = (seen || []).map(p => p.id).sort((a, b) => a - b);
  assert("owner portal: the owner sees exactly their four properties", !seenErr && JSON.stringify(seenIds) === JSON.stringify(ownerProps.map(p => p.id).sort((a, b) => a - b)), JSON.stringify(seenIds) + " " + (seenErr?.message || ""));
  const { data: od } = await ownerClient.from("owner_distributions").select("owner_id, kind").eq("company_id", CO);
  assert("owner portal: only their own distributions", (od || []).length > 0 && od.every(d => d.owner_id === O8.id));
  const { data: os } = await ownerClient.from("owner_statements").select("owner_id").eq("company_id", CO);
  assert("owner portal: sees their statement", (os || []).length === 1 && os[0].owner_id === O8.id);
  const { data: others } = await ownerClient.from("properties").select("id").in("id", [P.P3.id, P.P4.id, P.P5.id]);
  assert("owner portal: cannot see other owners' / company properties", (others || []).length === 0);

  const oa = await mkUser(CO + "-oa@example.com", "office_assistant");
  const accIns = await oa.from("owner_distributions").insert([{ company_id: CO, owner_id: O8.id, kind: "accrual", amount: 1, reference: "ODIST-oa-" + CO, date: today }]);
  assert("office assistant: an ACCRUAL (rent receipt) is allowed through the gate", !accIns.error, accIns.error?.message);
  const payIns = await oa.from("owner_distributions").insert([{ company_id: CO, owner_id: O8.id, kind: "payout", amount: 1, reference: "DIST-oa-" + CO, date: today }]);
  assert("office assistant: a PAYOUT is still refused (management tier only)", !!payIns.error && /manager, owner, or admin/.test(payIns.error.message), payIns.error?.message);
} catch (e) {
  assert("owners TEST-DB scenario ran", false, e.stack || e.message);
} finally {
  if (KEEP) {
    console.log(`\n  OWNERS_TEST_KEEP=1: left company ${CO} in place. Remove with:\n  OWNERS_TEST_CLEANUP=${CO} OWNERS_TEST_USERS=${userIds.join(",")} node owners.test.mjs`);
  } else {
    await cleanupCompany(CO, userIds);
    const left = await leftovers(CO);
    assert("QA-OWN company removed: zero leftovers", Object.keys(left).length === 0, JSON.stringify(left));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
