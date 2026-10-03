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
//  Owner decisions: the fee base is RENT ONLY (2026-09-28); statements are
//  "billed, but show collected" -- fee and net distribution on collected
//  rent, equal to 4200 / 2200 -- and each accrual / billed month belongs to
//  whoever owned the property then (2026-09-29). The accrual is the SQL
//  function owner_accrual_sync (migration 20260928170000): receipts are
//  allocated oldest-first to rent charges in any month, under a per-tenant
//  lock, kept in step by triggers on receipts, charges and voids.
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
// Billed, but show collected (owner decision 1): accruals are the owner's
// collected rent -- the fee and the net distribution come from them.
const accr = [
  { kind: "accrual", rent_amount: 700, amount: 644, date: "2026-09-05", charge_je_id: "C1" },
  { kind: "accrual", rent_amount: 500, amount: 460, date: "2026-09-12", charge_je_id: "C1" },
  { kind: "accrual", rent_amount: 300, amount: 276, date: "2026-10-02", charge_je_id: "C1" },      // collected after the period
  { kind: "accrual", rent_amount: 999, amount: 900, date: "2026-09-12", charge_je_id: "C1", voided_at: "x" },
  { kind: "accrual", rent_amount: 400, amount: 368, date: "2026-09-03", charge_je_id: "OLD" },     // August rent paid in September
];
const glC = glLines.map(l => ({ ...l, journal_entry_id: l.id === 1 ? "C1" : "J" + l.id }));
const st = R.buildOwnerStatement({ lines: glC, accounts: accts, feeRule: R.resolveMgmtFeePct({ management_fee_pct: 8 }), accruals: accr,
  payouts: [{ kind: "payout", amount: 1000, date: "2026-09-20", method: "check" }, { kind: "accrual", amount: 644, date: "2026-09-05" }], startDate: "2026-09-01", endDate: "2026-09-30" });
assert("income billed = rent + late fee (ODIST reclass and 4200 excluded)", st.totalIncome === 1550, String(st.totalIncome));
assert("expenses = posted, in period, de-duplicated (voided / last month excluded)", st.totalExpenses === 420.5, String(st.totalExpenses));
assert("rent billed 1500; collected = live accruals dated in period (700+500+400 = 1600)", st.rentBilled === 1500 && st.rentCollected === 1600, JSON.stringify([st.rentBilled, st.rentCollected]));
assert("unpaid = billed this period - collected against this period's charges, as of now (1500 - 1500 = 0)", st.rentUnpaid === 0, String(st.rentUnpaid));
assert("fee and net are the accruals' (= 4200 / 2200): fee 56+40+32 = 128, net 644+460+368 = 1472", st.managementFee === 128 && st.netToOwner === 1472, st.managementFee + " / " + st.netToOwner);
assert("net after expenses is information only", st.netAfterExpenses === 1472 - 420.5);
assert("fee line reads 'x% of collected rent'", /^8% of collected rent 1600\.00/.test(st.lineItems.find(c => c.category === "Management Fee").items[0].description));
assert("Rent Summary section, readable back by statementRentSummary", JSON.stringify(R.statementRentSummary(st.lineItems)) === JSON.stringify({ billed: 1500, collected: 1600, unpaid: 0 }));
assert("distributions paid = payouts only", st.distributionsPaid === 1000);
assert("categories: Rent Summary, Income, Expenses, Management Fee, Distributions Paid", st.lineItems.map(c => c.category).join(",") === "Rent Summary,Income,Expenses,Management Fee,Distributions Paid");
const stU = R.buildOwnerStatement({ lines: glC, accounts: accts, feeRule: R.resolveMgmtFeePct({ management_fee_pct: 8 }), accruals: [accr[0]], payouts: [], startDate: "2026-09-01", endDate: "2026-09-30" });
assert("partly paid: unpaid 800", stU.rentUnpaid === 800 && stU.rentCollected === 700);
const st0 = R.buildOwnerStatement({ lines: glC, accounts: accts, feeRule: R.resolveMgmtFeePct({ management_fee_pct: 0 }), accruals: [{ kind: "accrual", rent_amount: 1500, amount: 1500, date: "2026-09-05", charge_je_id: "C1" }], payouts: [], startDate: "2026-09-01", endDate: "2026-09-30" });
assert("0% owner is charged 0", st0.managementFee === 0 && st0.netToOwner === 1500);
const stN = R.buildOwnerStatement({ lines: glC, accounts: accts, feeRule: R.resolveMgmtFeePct({ management_fee_pct: null }), accruals: [], payouts: [], startDate: "2026-09-01", endDate: "2026-09-30" });
assert("unset fee -> 0, and the statement says 'Fee not set'", stN.managementFee === 0 && /Fee not set/.test(stN.lineItems.find(c => c.category === "Management Fee").items[0].description));
assert("older statements (no Rent Summary) -> null", R.statementRentSummary([{ category: "Income", items: [] }]) === null);

console.log("\n🧮 RENT ACCOUNT");
assert("rent account: code 4000 / 4000-xx / named Rental Income",
  R.isRentIncomeAccount({ code: "4000" }) && R.isRentIncomeAccount({ code: "4000-01" }) && R.isRentIncomeAccount({ code: "4050", name: "Rental Income - Unit B" }) &&
  !R.isRentIncomeAccount({ code: "4010", name: "Late Fee Income" }) && !R.isRentIncomeAccount({ code: "4100", name: "Other Income" }) && !R.isRentIncomeAccount({ code: "40001" }));

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
const MIG2 = read("supabase/migrations/20260928170000_owner_accrual_rpc.sql");
const MIG3 = read("supabase/migrations/20260929040000_owner_accrual_followups.sql");
assert("no `|| 10` fee default left in Owners.js", !/management_fee_pct\s*\|\|\s*10/.test(owners) && !/feePct\s*=\s*owner\.management_fee_pct\s*\|\|/.test(owners));
assert("Owners.js resolves the fee with resolveMgmtFeePct", owners.includes("resolveMgmtFeePct(owner)"));
assert("statement from the ledger for the owner AT THE TIME (loadOwnerStatementData + buildOwnerStatement with accruals)",
  owners.includes("loadOwnerStatementData(companyId, owner.id, startDate, endDate)") && owners.includes("accruals: gl.accruals") && !owners.includes('from("payments")'));
assert("statement reads property_owner_history, paged, no .limit(500)", ownUtil.includes('from("property_owner_history")') && ownUtil.includes('fetchAllPaged(() => base().eq("class_id", prop.class_id)') && !owners.includes(".limit(500)"));
assert("print + Excel show billed / collected / unpaid; net = collected less fee", owners.includes("statementRentSummary(cats)") && owners.includes("Net Distribution to Owner (collected rent less fee)") && owners.includes("rentRows.collected"));
assert("YTD stat counts payouts only", owners.includes("sumPayouts(distributions, { year:"));
assert("Pay Owner: kind payout + generated reference, user text kept as memo",
  owners.includes('kind: "payout"') && owners.includes("payoutReference({ ownerId: owner.id") && !owners.includes("distForm.reference || \"DIST-\""));
assert("accruals are written only by SQL (owner_accrual_sync), kind 'accrual'", /INSERT INTO owner_distributions[\s\S]{0,600}'accrual'/.test(MIG2) && !read("src/utils/ownerRules.js").includes('kind: "accrual"'));
assert("autoOwnerDistribution calls the SQL function", acct.includes("syncOwnerAccruals(supabase, companyId, tenantId)") && read("src/utils/ownerRules.js").includes('sb.rpc("owner_accrual_sync"'));
assert("Stripe webhook calls the same SQL function", api.includes('require("../src/utils/ownerRules")') && api.includes("syncOwnerAccruals(sb, companyId, tenantId)") && !api.includes("postJournalEntryWithCodes"));
assert("migration: advisory lock per tenant; tenant_id + receipt + charge reference; rent by rent-income credit, not prefix",
  MIG2.includes("pg_advisory_xact_lock(hashtext('owner_accrual:' || p_company_id), p_tenant_id)") && MIG2.includes("v_base_ref := 'ODIST-' || p_tenant_id || '-' || d_rc[x] || '-' || d_ch[x]") && MIG2.includes("owner_is_rent_income_account(a.code, a.name)") && !/RECUR-/.test(MIG2.replace(/^--.*$/mg, "")));
assert("migration: statement-level triggers enqueue each tenant once per transaction; one deferred runner, fixed order, lock_timeout",
  /CREATE TRIGGER trg_owner_accrual_enqueue_ins AFTER INSERT ON public\.acct_journal_lines\s+REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT/.test(MIG2) &&
  /CREATE TRIGGER trg_owner_accrual_enqueue_je AFTER UPDATE ON public\.acct_journal_entries\s+REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT/.test(MIG2) &&
  /CREATE CONSTRAINT TRIGGER trg_owner_accrual_queue_run AFTER INSERT ON public\.owner_accrual_queue\s+DEFERRABLE INITIALLY DEFERRED/.test(MIG2) &&
  MIG2.includes("WHERE txid = NEW.txid AND NOT needs_sync ORDER BY company_id, tenant_id") && MIG2.includes("set_config('lock_timeout', '3s', true)") &&
  !/CREATE CONSTRAINT TRIGGER trg_owner_accrual_after_line/.test(MIG2));
assert("migration: every new SECURITY DEFINER function is revoked from PUBLIC, anon", (() => {
  const body = MIG2.replace(/^--.*$/mg, "");
  const defs = [...body.matchAll(/FUNCTION public\.(\w+)\(([^)]*)\)\s*RETURNS [\s\S]{0,120}?SECURITY DEFINER/g)].map(m => m[1]);
  return defs.length >= 7 && defs.every(n => new RegExp("REVOKE ALL ON FUNCTION public\\." + n + "\\([^)]*\\) FROM PUBLIC, anon").test(body));
})());
assert("migration: sync checks company staff; fee CHECK 0..100; kind immutable; gate on UPDATE / DELETE",
  MIG2.includes("PERFORM public._assert_company_staff(p_company_id)") && MIG2.includes("CHECK (management_fee_pct IS NULL OR (management_fee_pct >= 0 AND management_fee_pct <= 100))") &&
  MIG2.includes("trg_owner_distribution_kind_immutable") && MIG2.includes("CREATE TRIGGER trg_mgmt_gate_upd BEFORE UPDATE ON public.owner_distributions") && MIG2.includes("CREATE TRIGGER trg_mgmt_gate_del BEFORE DELETE ON public.owner_distributions"));
assert("migration: ownership history (NY dates, first row at link time); charge keyed to the property on its own entry; no re-stamp outside correct_property_owner",
  MIG2.includes("CREATE TABLE IF NOT EXISTS public.property_owner_history") && MIG2.includes("AFTER INSERT OR UPDATE OF owner_id ON public.properties") &&
  MIG2.includes("(now() AT TIME ZONE 'America/New_York')::date") && MIG2.includes("VALUES (NEW.company_id, NEW.id, NEW.owner_id, v_today, NULL)") &&
  MIG2.includes("public.owner_for_charge(v_prop, r.date, r.created_at)") && MIG2.includes("class_id = r.ar_class") &&
  MIG2.includes("v_restamp <> '' AND v_restamp = coalesce(d_prop[x]::text, '')") && MIG2.includes("CREATE OR REPLACE FUNCTION public.correct_property_owner("));
assert("migration: no FK on receipt/charge entry links (no key lock on the receipt -> no deadlock with undo)",
  MIG2.includes("DROP CONSTRAINT IF EXISTS owner_distributions_receipt_je_id_fkey") && /ADD COLUMN IF NOT EXISTS receipt_je_id text,/.test(MIG2));
assert("migration: locked accruals count as covering their charge; mismatches reversed after the lock",
  MIG2.includes("'ODIST-' || p_tenant_id || '-R-' || e_id[k]::text") && MIG2.includes("p_date := p_date || (v_lock + 1)"));
assert("migration: owner_accrual_since writable only by its trigger or the management tier; gate covers every distribution column but notes",
  MIG2.includes("NOT public.is_management_tier(NEW.company_id)") && MIG2.includes("(to_jsonb(NEW) - 'notes') IS DISTINCT FROM (to_jsonb(OLD) - 'notes')"));
assert("migration: commit time budget -- a bulk write past 4s defers the rest as NEEDS_SYNC (no statement timeout)", MIG2.includes("IF clock_timestamp() - transaction_timestamp() > interval '4 seconds' THEN") && MIG2.includes("'deferred: commit time budget (bulk write)'"));
assert("migration: NEEDS_SYNC markers + error_log; pending drain RPC", MIG2.includes("_owner_accrual_mark_pending") && MIG2.includes("INSERT INTO error_log") && MIG2.includes("CREATE OR REPLACE FUNCTION public.owner_accrual_sync_pending("));
assert("follow-ups: deleting journal lines queues the tenant (AFTER DELETE, transition table)", MIG3.includes("CREATE TRIGGER trg_owner_accrual_enqueue_del AFTER DELETE ON public.acct_journal_lines") && MIG3.includes("REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT") && MIG3.includes("ELSIF TG_OP = 'DELETE' THEN"));
assert("follow-ups: post_je_and_ledger and the owner sync claim JE numbers (per-number try-lock held to commit)", MIG3.includes("v_je_number := public._je_number_claim(p_company_id);") && MIG3.includes("v_num := public._je_number_claim(p_company_id, v_prev);") && MIG3.includes("pg_try_advisory_xact_lock(v_key,"));
assert("follow-ups: bounded drain returns remaining; callers loop", MIG3.includes("p_max integer DEFAULT 50") && MIG3.includes("'remaining', v_remaining") && ownUtil.includes("return drainOwnerAccruals(supabase, companyId);") && read("api/integrity-check.js").includes("await drainOwnerAccruals(supabase, null)"));
assert("follow-ups: no markers / sync for tenants no owner is involved with", MIG3.includes("IF NOT public._owner_accrual_tenant_relevant(p_company_id, p_tenant_id) THEN RETURN; END IF;") && MIG3.includes("CONTINUE WHEN NOT v_rel;"));
assert("follow-ups: every new SECURITY DEFINER function is revoked from PUBLIC and anon", ["_owner_accrual_tenant_relevant(text, integer)", "_je_number_claim(text, bigint)", "owner_accrual_sync_pending(text, integer)", "_owner_accrual_mark_pending(text, integer, text, boolean)", "_owner_accrual_queue_run()", "_owner_accrual_enqueue_lines()", "_owner_accrual_sync_core(text, integer)"].every(f => MIG3.includes("REVOKE ALL ON FUNCTION public." + f + " FROM PUBLIC, anon")) && /REVOKE ALL ON FUNCTION public\.post_je_and_ledger\([^)]*\) FROM PUBLIC, anon;/.test(MIG3));
{
  const ownersPage = read("src/components/Owners.js");
  const cron = read("api/integrity-check.js");
  const vercel = JSON.parse(read("vercel.json"));
  assert("Owners page renders without waiting for the drain (fired, not awaited; distributions re-read when it synced)",
    !/await syncPendingOwnerAccruals/.test(ownersPage) && /syncPendingOwnerAccruals\(cid\)\.then\(/.test(ownersPage) && ownersPage.includes("run !== drainRun.current"));
  assert("nightly cron drains owner accruals AFTER the integrity checks, with the plan's 300s maxDuration",
    cron.indexOf("await drainOwnerAccruals(supabase, null)") > cron.indexOf("checkTenantBalanceVsLedger(supabase, companyId)") &&
    vercel.functions && vercel.functions["api/integrity-check.js"] && vercel.functions["api/integrity-check.js"].maxDuration === 300);
  assert("wizard AR numbering reads numeric 1100-NNN codes only (1100-W8ea9 no longer breaks the wizard)",
    MIG3.includes("CREATE OR REPLACE FUNCTION public._wizard_get_tenant_ar(") && MIG3.includes("WHERE company_id = p_company_id AND code ~ '^1100-\\d+$';") && MIG3.includes("substring(code FROM '^1100-(\\d+)$')"));
}
assert("manual ledger payment accrues the owner's share", /newCharge\.type === "payment" && arLegIsPerTenant\)[\s\S]{0,80}autoOwnerDistribution\(companyId, selectedTenant\.property, Math\.abs\(amount\), today, selectedTenant\.name, selectedTenant\.id\)/.test(ten));
assert("Banking: add + split deposits run the owner accrual after a successful post",
  (read("src/components/Banking.js").match(/if \(isInflow\) await accrueOwnerShareForBankDeposit\(companyId, \{ date: txn\.posted_date/g) || []).length === 2);
assert("autopay Run Now still accrues", /autoOwnerDistribution\(companyId, s\.property, amt, today/.test(pay));
assert("wizard writes owner_id via assignPropertyOwner after commit", props.includes("assignPropertyOwner(companyId, resPropertyId, propForm.owner_id || null)") && props.includes("<OwnerPicker"));
assert("property page has the picker", props.includes("ownerSlot={") && read("src/components/PropertyPage.js").includes("ownerSlot ||"));
assert("Properties list reads the linked owner (propertyOwnerName / _ownerKey)", props.includes("propertyOwnerName(p, ownersById)") && props.includes("p._ownerKey !== filterOwner") && !props.includes("p.owner_name !== filterOwner"));
assert("import links owner records (creates when missing)", imp.includes("findOrCreateOwnerByName(companyId, name, ownerList)") && imp.includes("patch.owner_id =") && !imp.includes('owner_name: r.owner_name || ""'));
// The prefill moved out of Documents.js into docService.js (phase 0, 2026-10-02).
assert("Documents merge fields look the owner up by owner_id first", read("src/utils/docService.js").includes('.eq("id", property.owner_id)'));
assert("assignPropertyOwner derives owner_name from the record", /update\(\{ owner_id: owner \? owner\.id : null, owner_name: owner \? owner\.name : "" \}\)/.test(ownUtil));
assert("portal shows payouts only", owners.includes("setDistributions((d.data || []).filter(isLivePayout))"));
assert("migration: kind check + NOT NULL + backfill from reference", /CHECK \(kind IN \('accrual','payout'\)\)/.test(MIG) && /SET kind = CASE WHEN reference LIKE 'ODIST-%'/.test(MIG) && /ALTER COLUMN kind SET NOT NULL/.test(MIG));
assert("migration: void follows the journal entry", /AFTER UPDATE OF status ON public\.acct_journal_entries/.test(MIG));
assert("migration 100000: gate on payouts only; no SECURITY DEFINER added", /= 'payout' THEN\s+v_destructive := true; v_action := 'record an owner payout'/.test(MIG) && !/SECURITY DEFINER/.test(MIG.replace(/^--.*$/mg, "")));
assert("migration: new functions revoked from PUBLIC, anon", (MIG.match(/REVOKE ALL ON FUNCTION public\.owner_distribution_\w+\(\) FROM PUBLIC, anon;/g) || []).length === 2);

// ─── 3. TEST DB ───────────────────────────────────────────────────────────
console.log("\n🌐 TEST DB (throwaway company QA-OWN)");
require("./sandbox-env");
const { createClient } = require("@supabase/supabase-js");
const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_SERVICE_KEY, ANON = process.env.TEST_SUPABASE_ANON_KEY;
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

async function cleanupCompany(CO, userIds = []) {
  // accruals and ownership history first: deleting journal lines queues their
  // tenants (AFTER DELETE trigger) -- with no owner left there is nothing to sync
  await sb.from("accounting_period_lock").delete().eq("company_id", CO);
  await sb.from("owner_distributions").delete().eq("company_id", CO);
  await sb.from("property_owner_history").delete().eq("company_id", CO);
  // guard_last_admin refuses to remove a live company's last admin: archive first
  await sb.from("companies").update({ archived_at: new Date().toISOString() }).eq("id", CO);
  const { data: jes } = await sb.from("acct_journal_entries").select("id").eq("company_id", CO);
  const ids = (jes || []).map(j => j.id);
  for (let i = 0; i < ids.length; i += 100) await sb.from("acct_journal_lines").delete().in("journal_entry_id", ids.slice(i, i + 100));
  await sb.from("accounting_period_lock").delete().eq("company_id", CO);
  await sb.from("owner_distributions").delete().eq("company_id", CO);
  for (const tb of ["bank_feed_transaction_link", "bank_posting_decision_line", "bank_posting_decision", "bank_feed_transaction", "bank_import_batch", "bank_account_feed",
                    "acct_journal_lines", "acct_journal_entries", "owner_distributions", "owner_statements", "payments", "ledger_entries",
                    "notification_queue", "notifications", "tenants", "property_owner_history", "properties", "owners", "acct_accounts", "acct_classes",
                    "company_members", "audit_trail", "error_log", "owner_accrual_queue"]) {
    await sb.from(tb).delete().eq("company_id", CO);
  }
  await sb.from("companies").delete().eq("id", CO);
  for (const u of userIds) { try { await sb.auth.admin.deleteUser(u); } catch (_) { /* gone */ } }
}
async function leftovers(CO) {
  const out = {};
  for (const tb of ["bank_feed_transaction", "bank_account_feed", "acct_journal_entries", "acct_journal_lines", "owner_distributions", "owner_statements", "payments", "tenants", "property_owner_history", "properties", "owners", "acct_accounts", "acct_classes", "company_members", "owner_accrual_queue", "error_log"]) {
    const { count } = await sb.from(tb).select("*", { count: "exact", head: true }).eq("company_id", CO);
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
  for (const [k, n] of [["P1", 101], ["P2", 102], ["P3", 103], ["P4", 104], ["P5", 105], ["P6", 106], ["P7", 107], ["P8", 108]]) {
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
  for (const [k, o] of [["P1", O8], ["P2", O8], ["P3", O0], ["P4", ON], ["P6", O8], ["P7", O8], ["P8", O8]]) {
    const r = await OU.assignPropertyOwner(CO, P[k].id, o.id);
    assert(`${k} linked to ${o.name}`, r.ok, r.error);
  }
  const { data: linked } = await sb.from("properties").select("id, owner_id, owner_name").eq("company_id", CO).order("id");
  assert("owner_id written and owner_name derived from the record", linked.filter(p => p.owner_id).length === 7 && linked.every(p => !p.owner_id || p.owner_name === [O8, O0, ON].find(o => o.id === p.owner_id).name));
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
  const tenantsSpec = [["T1", "P1", 1500], ["T2", "P2", 1200], ["T3", "P3", 1000], ["T4", "P4", 900], ["T5", "P7", 300], ["T6", "P6", 600], ["T7", "P8", 500]];
  let seq = 0;
  for (const [k, pk, rent] of tenantsSpec) {
    const t = ok(await sb.from("tenants").insert([{ company_id: CO, name: `${TAG} Tenant ${k}`, property: P[pk].address, lease_status: "active", balance: 0, rent, email: `${CO}-${k.toLowerCase()}@example.com` }]).select("*").single(), "tenant " + k);
    const ar = await mkAcct("1100-" + (++seq).toString().padStart(3, "0"), "AR - " + t.name, "Asset", { tenant_id: t.id, parent_id: acc["1100"].id });
    const jeId = await A.autoPostJournalEntry({ companyId: CO, date: startDate, reference: `RECUR-${crypto.randomBytes(4).toString("hex")}-${month}`, description: "Rent " + t.name, property: P[pk].address,
      lines: [{ account_id: ar.id, account_name: ar.name, debit: rent, credit: 0, class_id: P[pk].class_id, memo: "rent" }, { account_id: acc["4000"].id, account_name: "Rental Income", debit: 0, credit: rent, class_id: P[pk].class_id, memo: "rent" }] });
    assert(`rent charge posted for ${k}`, !!jeId);
    T[k] = { ...t, ar, rent, pk, chargeJe: jeId };
  }

  // ── receipts, one per path ──
  // The accrual itself is the SQL function owner_accrual_sync, run by a
  // deferred trigger when each receipt commits and again (idempotently) by
  // the app's own call. So the checks read the accrual ROWS, not the call.
  const live = async (tid) => (await sb.from("owner_distributions").select("*").eq("company_id", CO).eq("tenant_id", tid).eq("kind", "accrual").is("voided_at", null)).data || [];
  const sumOf = (rows, f) => Math.round(rows.reduce((s, r) => s + Number(r[f] || 0), 0) * 100) / 100;
  const tot = async (tid) => { const rows = await live(tid); const rent = sumOf(rows, "rent_amount"), net = sumOf(rows, "amount"); return { rows, rent, net, fee: Math.round((rent - net) * 100) / 100 }; };
  // (a) Manual ledger payment -- Tenants.js addLedgerEntry, type "payment".
  const manualJE = async (k, amt, date = today) => {
    const t = T[k];
    const res = await A.atomicPostJEAndLedger({ companyId: CO, date, description: "Manual payment — " + t.name, reference: "MANUAL-" + crypto.randomBytes(4).toString("hex"), property: t.property,
      lines: [{ account_id: acc["1000"].id, account_name: "Checking Account", debit: amt, credit: 0, class_id: P[t.pk].class_id, memo: t.name }, { account_id: t.ar.id, account_name: t.ar.name, debit: 0, credit: amt, class_id: P[t.pk].class_id, memo: "payment" }],
      ledgerEntry: { tenant: t.name, tenant_id: t.id, property: t.property, date, description: "payment", amount: -amt, type: "payment", balance: 0 }, balanceUpdate: null });
    assert(`manual receipt posted (${k} ${amt})`, !!res.jeId, res.error);
    const call = await A.autoOwnerDistribution(CO, t.property, amt, date, t.name, t.id);
    return { jeId: res.jeId, call };
  };
  const m1 = await manualJE("T1", 700);
  const a1 = await tot(T.T1.id);
  assert("manual ledger payment accrues 8% of the rent: rent 700, fee 56, net 644", a1.rent === 700 && a1.fee === 56 && a1.net === 644, JSON.stringify(a1));
  const r1 = a1.rows[0] || {};
  assert("accrual row carries tenant_id, receipt / charge entry, charge month and the owner then",
    r1.tenant_id === T.T1.id && r1.receipt_je_id === m1.jeId && r1.charge_je_id === T.T1.chargeJe && r1.charge_month === startDate && r1.owner_id === O8.id, JSON.stringify(r1));
  assert("reference = ODIST-<tenant id>-<receipt entry>-<charge entry> (no names)", r1.reference === `ODIST-${T.T1.id}-${m1.jeId}-${T.T1.chargeJe}`, r1.reference);
  assert("the app's own call after the trigger is a no-op that reports the total", m1.call && !m1.call.error && Number(m1.call.accrued_rent) === 700, JSON.stringify(m1.call));
  // (b) Autopay Run Now -- Payments.js runNow. A MIXED receipt: T2 also owes
  // a $100 other charge (4100) and pays $1,300: $1,200 is rent (fee 96); the
  // $100 is other income -- no fee, not accrued.
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
    await A.autoOwnerDistribution(CO, t.property, amt, today, t.name, t.id);
    const a2 = await tot(t.id);
    assert("mixed autopay receipt $1,300: rent 1200, fee 96, net 1104", a2.rent === 1200 && a2.fee === 96 && a2.net === 1104, JSON.stringify(a2));
    const { data: a2Je } = await sb.from("acct_journal_entries").select("id, acct_journal_lines(debit)").eq("company_id", CO).eq("reference", a2.rows[0]?.reference).neq("status", "voided");
    const drs = (a2Je?.[0]?.acct_journal_lines || []).filter(l => Number(l.debit) > 0);
    assert("…and only the rent ($1,200) is reclassified out of Rental Income", drs.length === 1 && Number(drs[0].debit) === 1200);
    const again = await A.autoOwnerDistribution(CO, t.property, amt, today, t.name, t.id);
    assert("calling again posts nothing (idempotent)", again.posted === 0 && (await live(t.id)).length === 1, JSON.stringify(again));
  }
  // (c) Stripe webhook -- the real handler, only Stripe itself faked.
  {
    const t = T.T1, rentCents = 80000, pi = "pi_" + CO.replace(/-/g, "_") + "_1";
    const event = { type: "payment_intent.succeeded", data: { object: { id: pi, metadata: { company_id: CO, tenant_id: String(t.id), rent_cents: String(rentCents), tenant_name: t.name + " (stale name)", property: t.property } } } };
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
    const a = await tot(t.id);
    assert("Stripe receipt accrues server side, keyed on tenant_id (stale metadata name irrelevant): T1 rent 700 + 800 = 1500, fee 120", a.rent === 1500 && a.fee === 120 && a.rows.length === 2, JSON.stringify(a));
    const r2 = await call();
    assert("a replayed webhook is idempotent (no second accrual)", r2.status === 200 && r2.body?.idempotent === true && (await live(t.id)).length === 2);
  }
  // T1: late fee charged, then a $50 receipt. Rent is fully collected, so the
  // $50 is not rent -- nothing accrues, no fee.
  {
    const t = T.T1;
    const id = await A.autoPostJournalEntry({ companyId: CO, date: today, reference: "LATEFEE-" + t.id + "-" + month.replace("-", ""), description: "Late fee", property: t.property,
      lines: [{ account_id: t.ar.id, account_name: t.ar.name, debit: 50, credit: 0, class_id: P.P1.class_id, memo: "late" }, { account_id: acc["4010"].id, account_name: "Late Fee Income", debit: 0, credit: 50, class_id: P.P1.class_id, memo: "late" }] });
    assert("late fee posted", !!id);
    await manualJE("T1", 50);
    const a = await tot(t.id);
    assert("a receipt beyond the rent (pays the late fee) accrues nothing: T1 rent still 1500", a.rent === 1500 && a.rows.length === 2, JSON.stringify(a));
  }
  // (d) 0% owner and (e) unset-fee owner.
  await manualJE("T3", 1000);
  const a3 = await tot(T.T3.id);
  assert("0% owner: charged 0, full rent to the owner", a3.rent === 1000 && a3.fee === 0 && a3.net === 1000, JSON.stringify(a3));
  const { data: a3Je } = await sb.from("acct_journal_entries").select("acct_journal_lines(account_id)").eq("company_id", CO).eq("reference", a3.rows[0]?.reference).neq("status", "voided");
  assert("0% owner: the accrual has no management-fee line", (a3Je?.[0]?.acct_journal_lines || []).length === 2 && !(a3Je[0].acct_journal_lines).some(l => l.account_id === acc["4200"].id));
  await manualJE("T4", 900);
  const a4 = await tot(T.T4.id);
  assert("unset-fee owner: 0 charged, row flagged '(not set)'", a4.rent === 900 && a4.fee === 0 && /\(not set\)/.test(a4.rows[0]?.notes || ""), JSON.stringify(a4));
  // (f) Banking page: a deposit categorised to a tenant's AR through the real
  // post_bank_transaction RPC, then the post-success hook Banking.js runs.
  {
    const feed = ok(await sb.from("bank_account_feed").insert([{ company_id: CO, gl_account_id: acc["1000"].id, account_name: TAG + " feed", masked_number: "***0000", account_type: "checking", institution_name: "QA Bank", connection_type: "csv", status: "active" }]).select("id").single(), "feed");
    const mkTxn = async (n, amt) => ok(await sb.from("bank_feed_transaction").insert([{ company_id: CO, bank_account_feed_id: feed.id, source_type: "csv", provider_transaction_id: CO + "-" + n,
      posted_date: today, amount: amt, direction: "inflow", bank_description_raw: "DEPOSIT " + n, bank_description_clean: "DEPOSIT " + n, payee_normalized: "Tenant", fingerprint_hash: CO + "-fp-" + n, status: "for_review" }]).select("*").single(), "bank txn " + n);
    const t6 = T.T6, x1 = await mkTxn(1, 650);
    const { data: b1r, error: e1 } = await sb.rpc("post_bank_transaction", { p_company_id: CO, p_txn_id: x1.id, p_kind: "add", p_description: "DEPOSIT 1", p_property: P.P6.address,
      p_lines: [{ account_id: acc["1000"].id, account_name: "Checking Account", debit: 650, credit: 0, class_id: P.P6.class_id, memo: "dep", entity_type: "customer", entity_id: String(t6.id), entity_name: t6.name },
                { account_id: t6.ar.id, account_name: t6.ar.name, debit: 0, credit: 650, class_id: P.P6.class_id, memo: "dep", entity_type: "customer", entity_id: String(t6.id), entity_name: t6.name }],
      p_decision: { payee: "Tenant", memo: "", header_class_id: P.P6.class_id }, p_decision_lines: [{ gl_account_id: t6.ar.id, gl_account_name: t6.ar.name, amount: 650, entry_side: "credit", memo: "" }] });
    assert("bank 'add' deposit posted by post_bank_transaction", !e1 && b1r?.je_id, e1?.message);
    await OU.accrueOwnerShareForBankDeposit(CO, { date: today, lines: [{ accountId: t6.ar.id, amount: 650 }] });
    const b6 = await tot(t6.id);
    assert("bank 'add' $650 against $600 rent: rent 600, fee 48, net 552 (the $50 waits for the next charge)", b6.rent === 600 && b6.fee === 48 && b6.net === 552, JSON.stringify(b6));
    await OU.accrueOwnerShareForBankDeposit(CO, { date: today, lines: [{ accountId: t6.ar.id, amount: 650 }] });
    assert("bank hook re-run is idempotent", (await live(t6.id)).length === 1);
    const t5 = T.T5, x2 = await mkTxn(2, 325);
    const { data: b2r, error: e2 } = await sb.rpc("post_bank_transaction", { p_company_id: CO, p_txn_id: x2.id, p_kind: "split", p_description: "Split — DEPOSIT 2", p_property: P.P7.address,
      p_lines: [{ account_id: acc["1000"].id, account_name: "Checking Account", debit: 325, credit: 0, class_id: null, memo: "Split transaction" },
                { account_id: t5.ar.id, account_name: t5.ar.name, debit: 0, credit: 300, class_id: P.P7.class_id, memo: "rent" },
                { account_id: acc["4100"].id, account_name: "Other Income", debit: 0, credit: 25, class_id: P.P7.class_id, memo: "laundry" }],
      p_decision: { memo: "Split into 2 lines" }, p_decision_lines: [
        { line_no: 1, gl_account_id: t5.ar.id, gl_account_name: t5.ar.name, amount: 300, entry_side: "credit", memo: "rent", class_id: P.P7.class_id },
        { line_no: 2, gl_account_id: acc["4100"].id, gl_account_name: "Other Income", amount: 25, entry_side: "credit", memo: "laundry", class_id: P.P7.class_id }] });
    assert("bank 'split' deposit posted by post_bank_transaction", !e2 && b2r?.je_id, e2?.message);
    await OU.accrueOwnerShareForBankDeposit(CO, { date: today, lines: [{ accountId: t5.ar.id, amount: 300 }, { accountId: acc["4100"].id, amount: 25 }] });
    const b5 = await tot(t5.id);
    assert("bank 'split': only the tenant-AR leg accrues (rent 300, fee 24, net 276)", b5.rent === 300 && b5.fee === 24 && b5.net === 276, JSON.stringify(b5));
    // Rent charged onto an existing credit balance: T6 prepaid $50; next
    // month's charge accrues that $50 when it posts (trigger).
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const nm = `${nextMonth.getFullYear()}-${pad(nextMonth.getMonth() + 1)}-01`;
    const c2 = await A.autoPostJournalEntry({ companyId: CO, date: nm, reference: `RECUR-${crypto.randomBytes(4).toString("hex")}-${nm.slice(0, 7)}`, description: "Rent " + t6.name, property: P.P6.address,
      lines: [{ account_id: t6.ar.id, account_name: t6.ar.name, debit: 600, credit: 0, class_id: P.P6.class_id, memo: "rent" }, { account_id: acc["4000"].id, account_name: "Rental Income", debit: 0, credit: 600, class_id: P.P6.class_id, memo: "rent" }] });
    const b6b = await tot(t6.id);
    assert("rent charged onto a credit balance accrues when the charge posts ($50 of next month's rent)", !!c2 && b6b.rent === 650 && b6b.rows.some(r => r.charge_je_id === c2 && Number(r.rent_amount) === 50 && r.charge_month === nm), JSON.stringify(b6b.rows.map(r => [r.charge_month, r.rent_amount])));
  }
  // T7: billed 500, paid 200 -> 300 unpaid on the statement.
  await manualJE("T7", 200);
  const noOwner = await A.autoOwnerDistribution(CO, P.P5.address, 100, today, "x", null);
  assert("no tenant id -> nothing to do", !!noOwner.skipped);

  // ── expenses of several kinds (and noise that must not count) ──
  const exp = async (code, amt, pk, { classless = false, date = today, voided = false } = {}) => {
    const cls = classless ? null : P[pk].class_id;
    const id = await A.autoPostJournalEntry({ companyId: CO, date, reference: "QAEXP-" + crypto.randomBytes(4).toString("hex"), description: acc[code].name + " bill", property: P[pk].address, status: voided ? "voided" : "posted",
      lines: [{ account_id: acc[code].id, account_name: acc[code].name, debit: amt, credit: 0, class_id: cls, memo: "bill" }, { account_id: acc["1000"].id, account_name: "Checking", debit: 0, credit: amt, class_id: cls, memo: "bill" }] });
    assert(`expense posted (${acc[code].name} ${amt}${classless ? ", no class" : ""}${voided ? ", voided" : ""})`, !!id);
  };
  await exp("5300", 300, "P1");                       // repairs
  await exp("5400", 120.5, "P2", { date: startDate }); // utilities
  await exp("5500", 200, "P2", { classless: true, date: startDate });  // HOA -- no class, entry property text only
  await exp("5600", 400, "P1");                       // property tax
  await exp("5700", 250.25, "P2", { date: startDate }); // mortgage interest
  await exp("5300", 999, "P1", { voided: true });     // voided: excluded
  await exp("5300", 55, "P1", { date: prevDate });    // last month: excluded
  await exp("5300", 777, "P5");                       // not this owner's: excluded

  // ── payout: Owners.js payOwner, with a user reference that already exists ──
  const collide = await A.autoPostJournalEntry({ companyId: CO, date: today, reference: "1001", description: "unrelated entry referenced 1001", property: "",
    lines: [{ account_id: acc["1000"].id, account_name: "Checking", debit: 1, credit: 0 }, { account_id: acc["1000"].id, account_name: "Checking", debit: 0, credit: 1 }] });
  assert("an unrelated entry already uses reference 1001", !!collide);
  const payAmt = 1000, userRef = "1001";
  const distRef = R.payoutReference({ ownerId: O8.id, date: today, cents: R.toCents(payAmt), userRef });
  const distRow = ok(await sb.from("owner_distributions").insert([{ company_id: CO, owner_id: O8.id, kind: "payout", amount: payAmt, method: "check", reference: distRef, date: today, notes: "Ref #" + userRef }]).select("id").maybeSingle(), "payout row");
  const payRes = await A.atomicPostJEAndLedger({ companyId: CO, date: today, description: `Owner distribution — ${O8.name} (ref ${userRef})`, reference: distRef, property: "",
    lines: [{ account_id: "2200", account_name: "Owner Distributions Payable", debit: payAmt, credit: 0, class_id: P.P1.class_id, memo: "Distribution (ref 1001)" }, { account_id: "1000", account_name: "Checking Account", debit: 0, credit: payAmt, class_id: P.P1.class_id, memo: "Paid (ref 1001)" }], requireJE: false });
  assert("payout posted despite the user's '1001' (generated reference)", !!payRes.jeId && distRef !== "1001" && !!distRow?.id, JSON.stringify(payRes));

  // ── statement ("billed, but show collected") vs a direct GL query ──
  const stmtFor = async (owner) => {
    const d = await OU.loadOwnerStatementData(CO, owner.id, startDate, endDate);
    return { d, st: R.buildOwnerStatement({ lines: d.lines, accounts: d.accounts, feeRule: R.resolveMgmtFeePct(owner), accruals: d.accruals, payouts: d.payouts, startDate, endDate }) };
  };
  const directFor = async (props, ownerId) => {
    const { data: raw } = await sb.from("acct_journal_lines").select("id, account_id, debit, credit, class_id, acct_journal_entries!inner(date, reference, status, property)").eq("company_id", CO);
    const byAcct = new Map((await sb.from("acct_accounts").select("id, code, type").eq("company_id", CO)).data.map(a => [a.id, a]));
    const cls = new Set(props.map(p => p.class_id)), addrs = new Set(props.map(p => p.address));
    const { data: accr } = await sb.from("owner_distributions").select("reference, date").eq("company_id", CO).eq("owner_id", ownerId).eq("kind", "accrual").is("voided_at", null).gte("date", startDate).lte("date", endDate);
    const refs = new Set((accr || []).map(a => a.reference));
    let inc = 0, ex = 0, rent = 0, fee4200 = 0, net2200 = 0, rent4000dr = 0;
    for (const l of raw) {
      const j = l.acct_journal_entries;
      if (j.status !== "posted" || j.date < startDate || j.date > endDate) continue;
      const a = byAcct.get(l.account_id);
      if (refs.has(j.reference)) {
        if (a.code === "4200") fee4200 += Math.round((l.credit - l.debit) * 100);
        if (a.code === "2200") net2200 += Math.round((l.credit - l.debit) * 100);
        if (a.code === "4000") rent4000dr += Math.round((l.debit - l.credit) * 100);
        continue;
      }
      if (!(cls.has(l.class_id) || (l.class_id === null && addrs.has(j.property)))) continue;
      if (/^O?DIST-/.test(j.reference) || a.code === "4200") continue;
      if (a.type === "Revenue") inc += Math.round((l.credit - l.debit) * 100);
      if (a.type === "Revenue" && a.code === "4000") rent += Math.round((l.credit - l.debit) * 100);
      if (a.type === "Expense") ex += Math.round((l.debit - l.credit) * 100);
    }
    return { inc: inc / 100, ex: ex / 100, rent: rent / 100, fee: fee4200 / 100, net: net2200 / 100, collected: rent4000dr / 100 };
  };
  const o8Props = [P.P1, P.P2, P.P6, P.P7, P.P8];
  const { d: gl, st: stmt } = await stmtFor(O8);
  const dir = await directFor(o8Props, O8.id);
  console.log(`     statement: billed ${stmt.rentBilled} · collected ${stmt.rentCollected} · unpaid ${stmt.rentUnpaid} · income ${stmt.totalIncome} · expenses ${stmt.totalExpenses} · fee ${stmt.managementFee} · net ${stmt.netToOwner} · paid ${stmt.distributionsPaid}`);
  console.log(`     direct GL: rent ${dir.rent} · income ${dir.inc} · expenses ${dir.ex} · ODIST DR 4000 ${dir.collected} · CR 4200 ${dir.fee} · CR 2200 ${dir.net}`);
  assert("statement: billed rent / income / expenses = direct GL", !gl.failed && stmt.rentBilled === dir.rent && stmt.totalIncome === dir.inc && stmt.totalExpenses === dir.ex);
  assert("statement fee = 4200 booked for the period; net distribution = 2200 booked; collected = rent reclassified", stmt.managementFee === dir.fee && stmt.netToOwner === dir.net && stmt.rentCollected === dir.collected);
  assert("expected: billed 4100 (1500+1200+600+300+500), collected 3800, unpaid 300", stmt.rentBilled === 4100 && stmt.rentCollected === 3800 && stmt.rentUnpaid === 300, JSON.stringify([stmt.rentBilled, stmt.rentCollected, stmt.rentUnpaid]));
  assert("expected: fee 8% of COLLECTED 3800 = 304, net distribution 3496, expenses 1270.75", stmt.managementFee === 304 && stmt.netToOwner === 3496 && stmt.totalExpenses === 1270.75, stmt.managementFee + " / " + stmt.netToOwner + " / " + stmt.totalExpenses);
  assert("statement shows Rent Summary + fee line on collected rent", R.statementRentSummary(stmt.lineItems)?.unpaid === 300 && /^8% of collected rent 3800\.00/.test(stmt.lineItems.find(c => c.category === "Management Fee").items[0].description));
  assert("distributions paid in period = the payout only (1000)", stmt.distributionsPaid === 1000);
  const st0db = (await stmtFor(O0)).st;
  assert("0% owner's statement: billed 1000, collected 1000, fee 0", st0db.rentBilled === 1000 && st0db.rentCollected === 1000 && st0db.managementFee === 0);
  const stNdb = (await stmtFor(ON)).st;
  assert("unset-fee owner's statement: fee 0, marked 'Fee not set'", stNdb.managementFee === 0 && stNdb.feeIsSet === false);
  const ins = await sb.from("owner_statements").insert([{ company_id: CO, owner_id: O8.id, owner_name: O8.name, period: month, start_date: startDate, end_date: endDate,
    total_income: stmt.totalIncome, total_expenses: stmt.totalExpenses, management_fee: stmt.managementFee, net_to_owner: stmt.netToOwner, line_items: JSON.stringify(stmt.lineItems), notes: "x", status: "draft" }]);
  assert("owner_statements insert accepted", !ins.error, ins.error?.message);

  // ── YTD counts payouts once ──
  const { data: allDists } = await sb.from("owner_distributions").select("*").eq("company_id", CO);
  const o8d = allDists.filter(d => d.owner_id === O8.id && !d.voided_at);
  const naive = o8d.reduce((s, d) => s + Number(d.amount), 0);
  const ytd = R.sumPayouts(allDists, { year: today.slice(0, 4) });
  console.log(`     owner_distributions for the 8% owner: ${o8d.length} rows (${o8d.filter(d => d.kind === "accrual").length} accruals); old YTD sum ${naive}, new ${ytd}`);
  assert("YTD = payouts only (1000), not accruals + payouts", ytd === 1000 && naive > 1000, `naive ${naive}`);
  // Voiding the payout's journal entry voids the distribution.
  if (!KEEP) {
    ok(await sb.from("acct_journal_entries").update({ status: "voided" }).eq("id", payRes.jeId), "void payout JE");
    const { data: vd } = await sb.from("owner_distributions").select("voided_at").eq("id", distRow.id).single();
    const { data: after } = await sb.from("owner_distributions").select("*").eq("company_id", CO);
    assert("voiding the DIST- entry marks the distribution void; YTD drops it", !!vd.voided_at && R.sumPayouts(after, { year: today.slice(0, 4) }) === 0);
    ok(await sb.from("acct_journal_entries").update({ status: "posted" }).eq("id", payRes.jeId), "un-void payout JE");
    const { data: uv } = await sb.from("owner_distributions").select("voided_at").eq("id", distRow.id).single();
    assert("un-voiding clears it", uv.voided_at === null);
  }

  // ── reassignment: whoever owned it then (decision 8) ──
  const OB = (await OU.createOwner(CO, { name: TAG + " Buyer", management_fee_pct: 10 })).owner;
  if (today > startDate) {
    const o8Before = await tot(T.T2.id);
    ok(await sb.from("properties").update({ owner_id: OB.id, owner_name: OB.name }).eq("id", P.P2.id), "reassign P2");
    const { data: hist } = await sb.from("property_owner_history").select("owner_id, from_date, to_date").eq("property_id", P.P2.id).order("id");
    assert("ownership history: old owner closed today, new owner from today", hist.length === 2 && hist[0].owner_id === O8.id && hist[0].to_date && hist[1].owner_id === OB.id && hist[1].from_date === hist[0].to_date && !hist[1].to_date, JSON.stringify(hist));
    const c3 = await A.autoPostJournalEntry({ companyId: CO, date: hist[1].from_date, reference: `RECUR-${crypto.randomBytes(4).toString("hex")}-new`, description: "Rent after sale", property: P.P2.address,
      lines: [{ account_id: T.T2.ar.id, account_name: T.T2.ar.name, debit: 1200, credit: 0, class_id: P.P2.class_id, memo: "rent" }, { account_id: acc["4000"].id, account_name: "Rental Income", debit: 0, credit: 1200, class_id: P.P2.class_id, memo: "rent" }] });
    await manualJE("T2", 1200, hist[1].from_date);
    const rows = await live(T.T2.id);
    assert("after the sale: the old owner's accrual is untouched, the new rent accrues to the new owner (stamped)",
      rows.some(r => r.owner_id === O8.id && Number(r.rent_amount) === 1200 && r.id === o8Before.rows[0].id) && rows.some(r => r.owner_id === OB.id && r.charge_je_id === c3 && Number(r.rent_amount) === 1200 && Number(r.amount) === 1080), JSON.stringify(rows.map(r => [r.owner_id === O8.id ? "O8" : "OB", r.rent_amount, r.amount])));
    const stA = (await stmtFor(O8)).st, stB = (await stmtFor(OB)).st;
    assert("old owner's statement keeps the rent billed before the sale (billed still 4100, collected 3800)", stA.rentBilled === 4100 && stA.rentCollected === 3800, JSON.stringify([stA.rentBilled, stA.rentCollected]));
    assert("new owner's statement starts at the change date (billed 1200, collected 1200, fee 10% = 120)", stB.rentBilled === 1200 && stB.rentCollected === 1200 && stB.managementFee === 120, JSON.stringify([stB.rentBilled, stB.rentCollected, stB.managementFee]));
  } else {
    console.log("     (first of the month: reassignment check skipped -- needs a day between charge and sale)");
  }

  // ── voiding a receipt re-allocates (any path) ──
  {
    ok(await sb.from("acct_journal_entries").update({ status: "voided" }).eq("id", m1.jeId), "void T1 receipt");
    const a = await tot(T.T1.id);
    const { data: old } = await sb.from("owner_distributions").select("voided_at, reference").eq("company_id", CO).eq("receipt_je_id", m1.jeId);
    const { data: oldJe } = await sb.from("acct_journal_entries").select("status").eq("company_id", CO).eq("reference", old?.[0]?.reference || "none");
    assert("voiding the $700 receipt voids its accrual (row and ODIST entry)", !!old?.[0]?.voided_at && oldJe?.every(j => j.status === "voided"), JSON.stringify([old, oldJe]));
    assert("…and re-allocates: the $800 Stripe + $50 receipt now pay rent -> T1 rent accrued 850", a.rent === 850 && a.rows.length === 2, JSON.stringify(a.rows.map(r => r.rent_amount)));
  }

  // ── archived owner: stops accruing ──
  {
    ok(await sb.from("owners").update({ archived_at: new Date().toISOString() }).eq("id", ON.id), "archive owner");
    const c4 = await A.autoPostJournalEntry({ companyId: CO, date: today, reference: `RECUR-${crypto.randomBytes(4).toString("hex")}-arch`, description: "Rent", property: P.P4.address,
      lines: [{ account_id: T.T4.ar.id, account_name: T.T4.ar.name, debit: 900, credit: 0, class_id: P.P4.class_id, memo: "rent" }, { account_id: acc["4000"].id, account_name: "Rental Income", debit: 0, credit: 900, class_id: P.P4.class_id, memo: "rent" }] });
    await manualJE("T4", 900);
    const a = await tot(T.T4.id);
    assert("archived owner: a new rent receipt accrues nothing (earlier accrual kept)", !!c4 && a.rent === 900 && a.rows.length === 1, JSON.stringify(a));
  }
  // ── fee CHECK 0..100 ──
  {
    const bad150 = await sb.from("owners").insert([{ company_id: CO, name: TAG + " Bad fee", management_fee_pct: 150 }]);
    const badNeg = await sb.from("owners").insert([{ company_id: CO, name: TAG + " Neg fee", management_fee_pct: -1 }]);
    assert("DB refuses a fee above 100 or below 0", !!bad150.error && !!badNeg.error, (bad150.error?.message || "150 accepted") + " / " + (badNeg.error?.message || "-1 accepted"));
  }

  // ── round 4: tenant move, period lock, archived property, NEEDS_SYNC ──
  const mkProp = async (k, owner) => {
    const n = 200 + Object.keys(P).length;
    const row = ok(await sb.from("properties").insert([{ company_id: CO, address_line_1: `${n} ${TAG} Way`, city: "Testville", state: "MD", zip: "20001", address: `${n} ${TAG} Way, Testville, MD 20001`, type: "Single Family", status: "occupied" }]).select("*").single(), "property " + k);
    const cls = ok(await sb.from("acct_classes").insert([{ id: crypto.randomUUID(), company_id: CO, name: row.address, is_active: true }]).select("id").single(), "class " + k);
    ok(await sb.from("properties").update({ class_id: cls.id }).eq("id", row.id), "class link " + k);
    P[k] = { ...row, class_id: cls.id };
    if (owner) { const r = await OU.assignPropertyOwner(CO, row.id, owner.id); if (!r.ok) throw new Error(r.error); }
    return P[k];
  };
  const mkTen = async (k, pk, rent) => {
    const t = ok(await sb.from("tenants").insert([{ company_id: CO, name: `${TAG} Tenant ${k}`, property: P[pk].address, lease_status: "active", balance: 0, rent }]).select("*").single(), "tenant " + k);
    const ar = await mkAcct("1100-" + (++seq).toString().padStart(3, "0"), "AR - " + t.name, "Asset", { tenant_id: t.id, parent_id: acc["1100"].id });
    T[k] = { ...t, ar, rent, pk };
    return T[k];
  };
  const chargeOn = (t, pk, date, amt) => A.autoPostJournalEntry({ companyId: CO, date, reference: `RECUR-${crypto.randomBytes(4).toString("hex")}-${date.slice(0, 7)}`, description: "Rent", property: P[pk].address,
    lines: [{ account_id: t.ar.id, account_name: t.ar.name, debit: amt, credit: 0, class_id: P[pk].class_id, memo: "rent" }, { account_id: acc["4000"].id, account_name: "Rental Income", debit: 0, credit: amt, class_id: P[pk].class_id, memo: "rent" }] });
  const cashOn = (t, pk, date, amt) => A.autoPostJournalEntry({ companyId: CO, date, reference: "MANUAL-" + crypto.randomBytes(4).toString("hex"), description: amt > 0 ? "receipt" : "refund", property: P[pk].address,
    lines: amt > 0 ? [{ account_id: acc["1000"].id, account_name: "Checking", debit: amt, credit: 0, class_id: P[pk].class_id }, { account_id: t.ar.id, account_name: t.ar.name, debit: 0, credit: amt, class_id: P[pk].class_id }]
                   : [{ account_id: t.ar.id, account_name: t.ar.name, debit: -amt, credit: 0, class_id: P[pk].class_id }, { account_id: acc["1000"].id, account_name: "Checking", debit: 0, credit: -amt, class_id: P[pk].class_id }] });
  const pm1 = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonth = `${pm1.getFullYear()}-${pad(pm1.getMonth() + 1)}`;
  {
    // tenant who moves to another owner's property keeps past accruals with the old owner (H5)
    const OM1 = (await OU.createOwner(CO, { name: TAG + " Move One", management_fee_pct: 10 })).owner;
    const OM2 = (await OU.createOwner(CO, { name: TAG + " Move Two", management_fee_pct: 10 })).owner;
    await mkProp("PM1", OM1); await mkProp("PM2", OM2);
    const tm = await mkTen("TM", "PM1", 1000);
    await chargeOn(tm, "PM1", prevMonth + "-01", 1000); await chargeOn(tm, "PM1", startDate, 1000); await cashOn(tm, "PM1", today, 2000);
    ok(await sb.from("tenants").update({ property: P.PM2.address }).eq("id", tm.id), "move tenant");
    const nm = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    await chargeOn(tm, "PM2", `${nm.getFullYear()}-${pad(nm.getMonth() + 1)}-01`, 1000); await cashOn(tm, "PM2", today, 1000);
    const rows = await live(tm.id);
    const by = (o) => rows.filter(r => r.owner_id === o.id).reduce((x, r) => x + Number(r.rent_amount), 0);
    assert("tenant who moves: charges keep the property on their own entry (old owner 2000, new owner 1000)", by(OM1) === 2000 && by(OM2) === 1000, JSON.stringify([by(OM1), by(OM2)]));
  }
  {
    // period lock: an NSF after the lock, then re-payment -> the locked accrual counts, is reversed after the lock, rent accrued once (L2)
    await mkProp("PL", O8); const tl = await mkTen("TL", "PL", 1000);
    await chargeOn(tl, "PL", prevMonth + "-01", 1000); await cashOn(tl, "PL", prevMonth + "-05", 1000);
    const lockDate = prevDate;
    ok(await sb.from("accounting_period_lock").insert([{ company_id: CO, lock_date: lockDate }]), "lock");
    await cashOn(tl, "PL", today, -1000);   // NSF / refund of the locked receipt
    const afterNsf = await live(tl.id);
    await cashOn(tl, "PL", today, 1000);    // re-paid
    const rows = await live(tl.id);
    ok(await sb.from("accounting_period_lock").delete().eq("company_id", CO), "unlock");
    const net = rows.reduce((x, r) => x + Number(r.rent_amount), 0);
    const locked = rows.filter(r => r.date <= lockDate), after = rows.filter(r => r.date > lockDate);
    assert("period lock: NSF after the lock reverses the frozen accrual after the lock (net 0)", afterNsf.reduce((x, r) => x + Number(r.rent_amount), 0) === 0 && afterNsf.some(r => Number(r.rent_amount) < 0 && r.reverses_id), JSON.stringify(afterNsf.map(r => [r.date, r.rent_amount])));
    assert("period lock: re-payment accrues the rent once (locked +1000, reversal -1000, new +1000 after the lock)", net === 1000 && locked.length === 1 && Number(locked[0].rent_amount) === 1000 && after.length === 2, JSON.stringify(rows.map(r => [r.date, r.rent_amount])));
  }
  {
    // archived property: a void still reverses its accrual (H6)
    await mkProp("PA", O8); const ta = await mkTen("TA", "PA", 700);
    await chargeOn(ta, "PA", startDate, 700); const rc = await cashOn(ta, "PA", today, 700);
    const before = (await live(ta.id)).reduce((x, r) => x + Number(r.rent_amount), 0);
    ok(await sb.from("properties").update({ archived_at: new Date().toISOString() }).eq("id", P.PA.id), "archive property");
    ok(await sb.from("acct_journal_entries").update({ status: "voided" }).eq("id", rc), "void receipt");
    const after = (await live(ta.id)).reduce((x, r) => x + Number(r.rent_amount), 0);
    assert("archived property: voiding the receipt still reverses the accrual", before === 700 && after === 0, JSON.stringify([before, after]));
  }
  {
    // NEEDS_SYNC marker (what a lock-wait timeout leaves) is drained by owner_accrual_sync_pending
    ok(await sb.from("owner_accrual_queue").insert([{ company_id: CO, tenant_id: T.T3.id, txid: 1, needs_sync: true, last_error: "test marker" }]), "marker");
    const pend = await sb.rpc("owner_accrual_sync_pending", { p_company_id: CO });
    const { data: left } = await sb.from("owner_accrual_queue").select("tenant_id").eq("company_id", CO).eq("needs_sync", true);
    assert("NEEDS_SYNC markers are drained by owner_accrual_sync_pending", !pend.error && pend.data?.synced >= 1 && !(left || []).length, JSON.stringify(pend.data || pend.error));
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
  const { data: nowProps } = await sb.from("properties").select("id").eq("company_id", CO).eq("owner_id", O8.id);
  const { data: seen, error: seenErr } = await ownerClient.from("properties").select("id").eq("company_id", CO);
  const seenIds = (seen || []).map(p => p.id).sort((a, b) => a - b);
  assert("owner portal: the owner sees exactly the properties they own now", !seenErr && seenIds.length > 0 && JSON.stringify(seenIds) === JSON.stringify(nowProps.map(p => p.id).sort((a, b) => a - b)), JSON.stringify(seenIds) + " " + (seenErr?.message || ""));
  const { data: od } = await ownerClient.from("owner_distributions").select("owner_id, kind").eq("company_id", CO);
  assert("owner portal: only their own distributions", (od || []).length > 0 && od.every(d => d.owner_id === O8.id));
  const { data: os } = await ownerClient.from("owner_statements").select("owner_id").eq("company_id", CO);
  assert("owner portal: sees their statement", (os || []).length === 1 && os[0].owner_id === O8.id);
  const { data: oh } = await ownerClient.from("property_owner_history").select("owner_id").eq("company_id", CO);
  assert("owner portal: sees only their own ownership history", (oh || []).length > 0 && oh.every(h => h.owner_id === O8.id));
  const { data: others } = await ownerClient.from("properties").select("id").in("id", [P.P3.id, P.P4.id, P.P5.id]);
  assert("owner portal: cannot see other owners' / company properties", (others || []).length === 0);

  const oa = await mkUser(CO + "-oa@example.com", "office_assistant");
  const accIns = await oa.from("owner_distributions").insert([{ company_id: CO, owner_id: O8.id, kind: "accrual", amount: 1, reference: "ODIST-oa-" + CO, date: today }]);
  assert("office assistant: cannot hand-enter an accrual", !!accIns.error && /recorded automatically/.test(accIns.error.message), accIns.error?.message);
  const payIns = await oa.from("owner_distributions").insert([{ company_id: CO, owner_id: O8.id, kind: "payout", amount: 1, reference: "DIST-oa-" + CO, date: today }]);
  assert("office assistant: cannot record a payout", !!payIns.error && /manager, owner, or admin/.test(payIns.error.message), payIns.error?.message);
  const anAccrual = (await live(T.T3.id))[0];
  const kindUpd = await oa.from("owner_distributions").update({ kind: "payout" }).eq("id", anAccrual.id).select("id");
  assert("office assistant: cannot turn an accrual into a payout (kind immutable / gated)", !!kindUpd.error, kindUpd.error?.message || JSON.stringify(kindUpd.data));
  const hide = await oa.from("owner_distributions").update({ voided_at: new Date().toISOString() }).eq("id", distRow.id).select("id");
  const del = await oa.from("owner_distributions").delete().eq("id", distRow.id).select("id");
  assert("office assistant: cannot void or delete a payout", !!hide.error && !!del.error, (hide.error?.message || "void ALLOWED") + " / " + (del.error?.message || "delete ALLOWED"));
  const kindSvc = await sb.from("owner_distributions").update({ kind: "payout" }).eq("id", anAccrual.id).select("id");
  assert("kind is immutable for everyone (service role too)", !!kindSvc.error, kindSvc.error?.message);
  const oaSync = await oa.rpc("owner_accrual_sync", { p_company_id: CO, p_tenant_id: T.T3.id });
  assert("office assistant's own client can run the accrual RPC", !oaSync.error && Number(oaSync.data?.accrued_rent) === 1000, oaSync.error?.message || JSON.stringify(oaSync.data));

  // ── round 5 (20260929040000) ──
  const adm = await mkUser(CO + "-adm@example.com", "admin");
  {
    // QA E-edit-b: update_journal_entry deletes the receipt's AR line and adds an Other Income line -> accrual reversed
    await mkProp("PE", O8); const te = await mkTen("TE", "PE", 800);
    await chargeOn(te, "PE", startDate, 800); const rid = await cashOn(te, "PE", today, 800);
    const before = (await live(te.id)).reduce((x, r) => x + Number(r.rent_amount), 0);
    const { data: je } = await sb.from("acct_journal_entries").select("*").eq("id", rid).single();
    const { data: ls } = await sb.from("acct_journal_lines").select("*").eq("journal_entry_id", rid).order("id");
    const expected = { header: { date: je.date, description: je.description || "", reference: je.reference || "", status: je.status, property: je.property || "" },
      lines: ls.map(l => ({ id: String(l.id), account_id: l.account_id, debit: l.debit, credit: l.credit, class_id: l.class_id || "", memo: l.memo || "" })) };
    const cash = ls.find(l => Number(l.debit) > 0);
    const ed = await adm.rpc("update_journal_entry", { p_company_id: CO, p_je_id: rid, p_header: {},
      p_lines: [{ id: String(cash.id), account_id: cash.account_id, debit: cash.debit, credit: 0, class_id: cash.class_id, memo: cash.memo },
                { account_id: acc["4100"].id, debit: 0, credit: 800, class_id: P.PE.class_id, memo: "new line" }],
      p_expected_line_ids: ls.map(l => l.id), p_expected: expected });
    const after = (await live(te.id)).reduce((x, r) => x + Number(r.rent_amount), 0);
    assert("edit that DELETES the receipt's AR line (new Other Income line) reverses the accrual (AFTER DELETE queue trigger)", !ed.error && before === 800 && after === 0, (ed.error?.message || "ok") + " " + JSON.stringify([before, after]));
  }
  {
    // owner-less tenant in an owner company: no NEEDS_SYNC marker, no sync work
    await mkProp("PN", null); const tn = await mkTen("TN", "PN", 500);
    await chargeOn(tn, "PN", startDate, 500); await cashOn(tn, "PN", today, 500);
    const { data: qn } = await sb.from("owner_accrual_queue").select("tenant_id").eq("company_id", CO).eq("tenant_id", tn.id);
    assert("an owner-less tenant's receipt leaves no queue row or NEEDS_SYNC marker behind", !(qn || []).length, JSON.stringify(qn));
    ok(await sb.from("owner_accrual_queue").insert([{ company_id: CO, tenant_id: tn.id, txid: 2, needs_sync: true, last_error: "stray marker" }]), "stray marker");
    const pd = await sb.rpc("owner_accrual_sync_pending", { p_company_id: CO });
    const { data: q2 } = await sb.from("owner_accrual_queue").select("tenant_id").eq("company_id", CO).eq("needs_sync", true);
    assert("the drain drops a stray marker for an owner-less tenant without syncing it", !pd.error && pd.data?.skipped === 1 && pd.data?.synced === 0 && pd.data?.remaining === 0 && !(q2 || []).length, JSON.stringify(pd.data || pd.error));
  }
  {
    // bounded drain: p_max tenants per call, `remaining` reported; drainOwnerAccruals loops to zero
    const tids = [T.T3.id, T.TM.id, T.TL.id, T.TA.id, T.TE.id];
    ok(await sb.from("owner_accrual_queue").insert(tids.map(tenant_id => ({ company_id: CO, tenant_id, txid: 3, needs_sync: true, last_error: "test marker" }))), "markers");
    const one = await adm.rpc("owner_accrual_sync_pending", { p_company_id: CO, p_max: 2 });
    assert("owner_accrual_sync_pending processes a bounded batch and returns how many remain", !one.error && one.data?.synced === 2 && one.data?.remaining === 3, JSON.stringify(one.data || one.error));
    const all = await R.drainOwnerAccruals(adm, CO, { batch: 1 });
    const { data: q3 } = await sb.from("owner_accrual_queue").select("tenant_id").eq("company_id", CO).eq("needs_sync", true);
    assert("drainOwnerAccruals (Owners page / nightly cron) loops batches until none remain", !all.error && all.synced === 3 && all.remaining === 0 && all.rounds === 3 && !(q3 || []).length, JSON.stringify(all));
    const again = (await Promise.all(tids.map(id => live(id)))).map(rs => rs.reduce((x, r) => x + Number(r.rent_amount), 0));
    assert("draining changes no settled accrual", JSON.stringify(again) === JSON.stringify([1000, 3000, 1000, 0, 0]), JSON.stringify(again));
  }
  {
    // JE numbers: 12 parallel receipts through post_je_and_ledger all post, distinct numbers
    const tt = T.T3;
    const refs = Array.from({ length: 12 }, (_, i) => "PAR-" + i + "-" + crypto.randomBytes(3).toString("hex"));
    const res = await Promise.all(refs.map(ref => adm.rpc("post_je_and_ledger", { p_company_id: CO, p_date: today, p_description: "par", p_reference: ref, p_property: P[tt.pk].address, p_status: "posted",
      p_lines: [{ account_id: acc["1000"].id, account_name: "Checking", debit: 1, credit: 0, class_id: P[tt.pk].class_id, memo: "" }, { account_id: acc["4100"].id, account_name: "Other Income", debit: 0, credit: 1, class_id: P[tt.pk].class_id, memo: "" }] })));
    const { data: nums } = await sb.from("acct_journal_entries").select("number").eq("company_id", CO);
    const errs = res.filter(r => r.error).map(r => r.error.message);
    assert("12 parallel post_je_and_ledger calls all post with distinct JE numbers (claimed, not raced)", !errs.length && nums.length === new Set(nums.map(n => n.number)).size, errs.join(" | "));
    const dupRef = await adm.rpc("post_je_and_ledger", { p_company_id: CO, p_date: today, p_description: "dup", p_reference: refs[0], p_property: "", p_status: "posted", p_lines: [] });
    assert("a duplicate reference is reported as the unique violation it is (not 'Could not generate unique JE number')", !!dupRef.error && dupRef.error.code === "23505", JSON.stringify(dupRef.error));
  }
  {
    // QA round 5: a tenant AR code with a non-numeric suffix no longer breaks the wizard's AR numbering
    await mkAcct("1100-W8ea9", "AR - odd suffix", "Asset", { parent_id: acc["1100"].id });
    const w = await sb.rpc("_wizard_get_tenant_ar", { p_company_id: CO, p_tenant_name: TAG + " Wizard AR", p_tenant_id: null });
    const { data: wa } = w.data ? await sb.from("acct_accounts").select("code").eq("id", w.data).single() : { data: null };
    assert("wizard AR numbering skips a 1100-W8ea9 code and takes the next numeric 1100-NNN", !w.error && /^1100-\d{3,}$/.test(wa?.code || ""), (w.error?.message || "") + " " + JSON.stringify(wa));
  }
  // round 4 gates: every money / link column; owner_accrual_since; owner correction
  {
    const tries = {};
    for (const [k, v] of [["receipt_je_id", "x"], ["charge_je_id", "x"], ["tenant_id", null], ["date", "2019-01-01"], ["reference", "moved"], ["owner_id", O8.id]]) {
      const r = await oa.from("owner_distributions").update({ [k]: v }).eq("id", anAccrual.id).select("id");
      tries[k] = r.error ? "refused" : ((r.data || []).length ? "ALLOWED" : "0 rows");
    }
    assert("office assistant: cannot change a distribution's date / reference / links / owner", Object.values(tries).every(v => v === "refused"), JSON.stringify(tries));
    const since = await oa.from("properties").update({ owner_accrual_since: "2000-01-01T00:00:00Z" }).eq("id", P.P3.id).select("id");
    assert("office assistant: cannot move properties.owner_accrual_since (retroactive accruals)", !!since.error, since.error?.message || "ALLOWED");
    const mgr = await mkUser(CO + "-mgr@example.com", "manager");
    const deny = await oa.rpc("correct_property_owner", { p_company_id: CO, p_property_id: P.P3.id, p_owner_id: O8.id, p_from: null });
    const fix = await mgr.rpc("correct_property_owner", { p_company_id: CO, p_property_id: P.P3.id, p_owner_id: O8.id, p_from: null });
    const rows = await live(T.T3.id);
    assert("correct_property_owner: office assistant refused; manager re-stamps the property's accruals (0% owner -> 8% owner: rent 1000, net 920)",
      !!deny.error && !fix.error && rows.length === 1 && rows[0].owner_id === O8.id && Number(rows[0].amount) === 920,
      (deny.error?.message || "OA ALLOWED") + " / " + (fix.error?.message || JSON.stringify(rows.map(r => [r.owner_id === O8.id ? "O8" : "other", r.rent_amount, r.amount]))));
  }
  const anon = createClient(SB_URL, ANON, { auth: { persistSession: false } });
  const anonSync = await anon.rpc("owner_accrual_sync", { p_company_id: CO, p_tenant_id: T.T3.id });
  assert("anon cannot call the accrual RPC", !!anonSync.error, JSON.stringify(anonSync.data));
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
