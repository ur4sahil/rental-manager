// One real-world expense, booked once (audit theme K).
//
//   REPAIRS   completing a work order accrued DR Repairs / CR AP, and paying
//             the vendor invoice for it expensed Repairs AGAIN (DR Repairs /
//             CR Checking). The invoice could not even be linked to the work
//             order: vendor_invoices.work_order_id was uuid, work_orders.id
//             is integer.
//   MORTGAGE  the wizard's monthly mortgage recurring entry and the Loans
//             page's "Record payment" both booked the same month. Owner
//             decision: cash basis -- neither books anything any more; the
//             payment is booked from the bank feed.
//   ESCROW    properties whose taxes the lender pays from escrow still got
//             tax bills generated (client), listed as due and reminded.
//
// Part 1 tests the pure rules (src/utils/expenseRules.js).
// Part 2 holds every path to them statically.
// Part 3 drives the REAL client code (expensePosting.js, autoPostJournalEntry,
//        generateBillsForProperty) against the TEST
//        project in a throwaway company "QA-EXP", prints the journal lines as
//        evidence, and deletes everything it made.
import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(import.meta.dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const src = (f) => read(path.join("src", f));

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     " + detail : "")); }
}

// expenseRules.js has no imports, so it loads as-is.
const R = await import("data:text/javascript," + encodeURIComponent(src("utils/expenseRules.js")));
assert("expenseRules.js imports nothing", !/^\s*import\s/m.test(src("utils/expenseRules.js")));

// ─── 1. PURE RULES ────────────────────────────────────────────────────────
console.log("\n🧮 REFERENCES");
assert("WO accrual reference is WO-<id>", R.workOrderAccrualReference(12) === "WO-12" && R.workOrderAccrualReference(null) === null);
assert("invoice payment reference is VPAY-<id> (deterministic)", R.invoicePaymentReference("abc") === "VPAY-abc" && R.invoicePaymentReference("") === null);
assert("close-out reference is WO-ADJ-<id>", R.workOrderCloseoutReference(12) === "WO-ADJ-12" && R.workOrderCloseoutReference(undefined) === null);
assert("no mortgage machinery left in the rules", !/Mortgage|loanPayment|recurringReference|MORTGAGE_CODE/.test(Object.keys(R).join(",")));

console.log("\n🧮 REPAIRS — every combination expenses once");
const wo = (cost, exp) => R.planWorkOrderAccrual({ cost, expensedByLinkedPayments: exp });
const pay = (amount, acc, others) => R.planInvoicePayment({ amount, woAccrued: acc, appliedByOthers: others });
assert("WO only: accrue full cost", wo(500, 0).accrue === 500);
assert("WO with no cost: nothing", wo(0, 0).accrue === 0 && wo(null, 0).accrue === 0);
assert("invoice only: all expense", JSON.stringify(pay(300, 0, 0)) === JSON.stringify({ ap: 300 - 300, expense: 300, cash: 300 }));
assert("WO then invoice: payment clears AP, no expense", JSON.stringify(pay(400, 400, 0)) === JSON.stringify({ ap: 400, expense: 0, cash: 400 }));
assert("invoice then WO: WO accrues nothing", wo(250, 250).accrue === 0 && wo(250, 250).reason === "already_expensed_by_invoice");
assert("invoice then WO, WO costs more: only the remainder", wo(500, 300).accrue === 200);
assert("two invoices vs one WO: 2nd uses what is left, overrun is expense", JSON.stringify(pay(450, 600, 200)) === JSON.stringify({ ap: 400, expense: 50, cash: 450 }));
assert("under-run invoice: AP only up to the invoice", JSON.stringify(pay(100, 600, 0)) === JSON.stringify({ ap: 100, expense: 0, cash: 100 }));
assert("voided WO accrual (woAccrued 0): invoice expenses", pay(300, 0, 0).expense === 300);
assert("cents are exact", JSON.stringify(pay(100.1, 0.2, 0.1)) === JSON.stringify({ ap: 0.1, expense: 100, cash: 100.1 }));
const lines = R.invoicePaymentLines(pay(450, 600, 200));
assert("payment lines balance and never debit Repairs for the covered part",
  lines.reduce((s, l) => s + l.debit, 0) === lines.reduce((s, l) => s + l.credit, 0) && lines.find(l => l.account_id === "5300").debit === 50 && lines.find(l => l.account_id === "2110").debit === 400);
assert("fully-covered payment has no Repairs line", !R.invoicePaymentLines(pay(400, 400, 0)).some(l => l.account_id === "5300"));

console.log("\n🧮 UNDER-BILLED WORK ORDER CLOSE-OUT");
const co = (o) => R.planWorkOrderCloseout(o);
assert("600 accrued, 400 applied, all paid, completed: reverse 200", co({ woCompleted: true, invoiceStatuses: ["paid"], woAccrued: 600, applied: 400 }).reverse === 200);
assert("an unpaid linked invoice: wait", co({ woCompleted: true, invoiceStatuses: ["paid", "pending"], woAccrued: 600, applied: 400 }).reverse === 0);
assert("a disputed linked invoice: wait", co({ woCompleted: true, invoiceStatuses: ["paid", "disputed"], woAccrued: 600, applied: 400 }).reason === "invoices_unpaid");
assert("no linked invoice: the accrual stands (paid via the bank)", co({ woCompleted: true, invoiceStatuses: [], woAccrued: 600, applied: 0 }).reason === "no_linked_invoice");
assert("work order not completed: wait", co({ woCompleted: false, invoiceStatuses: ["paid"], woAccrued: 600, applied: 400 }).reason === "work_order_open");
assert("fully used or over-billed: nothing", co({ woCompleted: true, invoiceStatuses: ["paid"], woAccrued: 600, applied: 600 }).reverse === 0 && co({ woCompleted: true, invoiceStatuses: ["paid"], woAccrued: 600, applied: 650 }).reverse === 0);
assert("already reversed (counted in applied): nothing", co({ woCompleted: true, invoiceStatuses: ["paid"], woAccrued: 600, applied: 400 + 200 }).reverse === 0);
assert("a payment after a close-out is expense, not AP", JSON.stringify(pay(100, 600, 600)) === JSON.stringify({ ap: 0, expense: 100, cash: 100 }));

console.log("\n🧮 ESCROW");
assert("escrow_covers object form", R.escrowCoversTaxes({ taxes: true }) && !R.escrowCoversTaxes({ taxes: false, insurance: true }));
assert("escrow_covers array form", R.escrowCoversTaxes(["taxes", "insurance"]) && !R.escrowCoversTaxes(["insurance"]) && !R.escrowCoversTaxes([]));
assert("escrow_covers free-text form (Loans page)", R.escrowCoversTaxes("Taxes, Insurance") && R.escrowCoversTaxes("tax") && !R.escrowCoversTaxes("Insurance only") && !R.escrowCoversTaxes("taxidermy"));
assert("tax record flag escrows", R.taxesEscrowed({ taxRecord: { escrow_paid_by_lender: true }, loans: [] }));
assert("active loan with tax escrow escrows", R.taxesEscrowed({ taxRecord: null, loans: [{ escrow_included: true, escrow_covers: { taxes: true } }] }));
assert("archived / paid-off / escrow-off loans do not", !R.taxesEscrowed({ taxRecord: { escrow_paid_by_lender: false }, loans: [
  { escrow_included: true, escrow_covers: { taxes: true }, archived_at: "2026-01-01" },
  { escrow_included: true, escrow_covers: { taxes: true }, status: "paid_off" },
  { escrow_included: false, escrow_covers: { taxes: true } }] }));

// cron twin must agree with the client rule
const cron = require(path.join(root, "api", "_tax-bill-reminders-impl.js"));
const fixtures = [null, "", "Taxes", "taxes, insurance", "Insurance", "taxidermy", [], ["taxes"], ["Insurance"], { taxes: true }, { taxes: "true" }, { taxes: false }, { insurance: true }];
assert("cron escrowCoversTaxes == expenseRules.escrowCoversTaxes on every shape",
  fixtures.every(f => cron._escrow.escrowCoversTaxes(f) === R.escrowCoversTaxes(f)), JSON.stringify(fixtures.map(f => [f, cron._escrow.escrowCoversTaxes(f), R.escrowCoversTaxes(f)])));

// ─── 2. STATIC — every path goes through the rule ─────────────────────────
console.log("\n🔎 PATHS");
const maint = src("components/Maintenance.js");
const upd = maint.slice(maint.indexOf("async function updateStatus("), maint.indexOf("function startEdit("));
const payInv = maint.slice(maint.indexOf("async function payInvoice("), maint.indexOf("async function rateVendor("));
assert("WO completion (status button) posts via the shared helper", /postCompletionAccounting\(wo\)/.test(upd) && !/autoPostJournalEntry|"5300"/.test(upd));
const saveWO = maint.slice(maint.indexOf("async function saveWorkOrder("), maint.indexOf("async function billTenantForWO("));
assert("completing through the EDIT FORM takes the same path", /payload\.status === "completed" && \(!editingWO \|\| editingWO\.status !== "completed"\)/.test(saveWO) && /postCompletionAccounting\(\{ \.\.\.payload, id: woId \}\)/.test(saveWO));
assert("shared helper calls postWorkOrderCompletion", /async function postCompletionAccounting\(wo\) \{[\s\S]{0,200}postWorkOrderCompletion\(/.test(maint));
assert("invoice payment posts via postVendorInvoicePayment, never a raw Repairs debit", /postVendorInvoicePayment\(/.test(payInv) && !/autoPostJournalEntry|"5300"|VINV-/.test(payInv));
assert("invoice payment posts BEFORE it marks the invoice paid", payInv.indexOf("postVendorInvoicePayment(") < payInv.indexOf('status: "paid"'));
assert("an invoice whose payment failed is not marked paid", /if \(!res\.jeId\)[^\n]*return;/.test(payInv));
assert("paying the last invoice closes out the work order, after it is marked paid", payInv.indexOf('status: "paid"') < payInv.indexOf("closeOutWorkOrder("));
assert("invoice form can link a work order (integer id)", /Work order \(if this invoice bills one\)/.test(maint) && /work_order_id = Number\(cleanForm\.work_order_id\)/.test(maint));
assert("no component still debits Repairs directly for a WO/invoice", !/account_id: "5300"/.test(maint));

const loans = src("components/Loans.js");
const rec = loans.slice(loans.indexOf("async function recordPayment("), loans.indexOf("async function fetchPortfolioLoans("));
assert("Record payment posts NO journal entry (cash basis, booked from the bank)", !/autoPostJournalEntry|atomicPost|rpc\(|"5600"|acct_journal/.test(rec) && /current_balance: newBalance/.test(rec));
assert("Loans.js posts no journal entries anywhere", !/autoPostJournalEntry|acct_journal_entries/.test(loans));
assert("no last_payment_month machinery", !/last_payment_month/.test(loans + src("utils/expensePosting.js") + src("utils/expenseRules.js")));
const props = src("components/Properties.js");
assert("wizard never asks commit_property_wizard for a recurring mortgage", /setup_recurring: false,/.test(props) && !/setup_recurring: !!loan\.setup_recurring/.test(props) && !/Set up recurring mortgage payment/.test(props));
const acctU = src("utils/accounting.js");
assert("recurring engine has no mortgage special case (no schedules are created)", !/mortgage/i.test(acctU.slice(acctU.indexOf("export async function autoPostRecurringEntries("), acctU.indexOf("export const _zipCache"))));

const post = src("utils/expensePosting.js");
assert("close-out is idempotent on WO-ADJ-<id> (any existing entry, voided included)", /reference", ref\)\.limit\(1\)/.test(post.slice(post.indexOf("export async function closeOutWorkOrder"))));
assert("close-out counts as applied, so a later payment is not AP", /e\.reference !== woRef && e\.reference !== invoicePaymentReference\(excludeInvoiceId\)/.test(post));
assert("completion runs the close-out", /closeOutWorkOrder\(\{ companyId, woId: wo\.id, date \}/.test(post));
assert("invoice payment is idempotent on VPAY-<id> (live-entry check first)", /const prior = await liveEntries\(d\.sb, companyId, \[ref\]\)/.test(post));
assert("voided entries count as absent in every ledger read", /neq\("status", "voided"\)/.test(post));

const taxes = src("utils/taxes.js");
const gen = taxes.slice(taxes.indexOf("export async function generateBillsForProperty("), taxes.indexOf("export async function markBillPaid("));
assert("bill generation checks escrow before writing anything", gen.indexOf("propertyTaxesEscrowed(") > 0 && gen.indexOf("propertyTaxesEscrowed(") < gen.indexOf('.from("property_tax_bills")'));
assert("escrow lookup failure generates nothing", /escrowed === null\) return \{[^}]*reason: "escrow_check_failed"/.test(gen));
const cronSrc = read("api/_tax-bill-reminders-impl.js");
assert("cron: escrow set loaded before rollforward and reminders; failure aborts", cronSrc.indexOf("loadEscrowedProperties(supabase)") < cronSrc.indexOf("rollforwardNextYear(supabase, todayIso, escrowedSet)") && /if \(!escrowedSet\)/.test(cronSrc));
assert("cron: reminders skip escrowed properties", /escrowedSet\.has\(b\.company_id \+ "\|" \+ b\.property\)\) \{ skippedEscrowed\+\+; continue; \}/.test(cronSrc));
assert("cron: rollforward honours loan escrow as well as the tax flag", /escrowedSet\.has\(p\.company_id \+ "\|" \+ p\.address\)/.test(cronSrc));
assert("cron: archived tax records are ignored", /escrow_paid_by_lender, annual_tax_amount, billing_frequency"\)\s*\.is\("archived_at", null\)/.test(cronSrc));
assert("dashboard hides escrowed bills", /escrowedTaxProperties\(companyId\)/.test(src("components/Dashboard.js")));
const tb = src("components/TaxBills.js");
assert("tax bills page: escrowed bills are not open/overdue", /const isOpen = \(b\) => b\.status === "pending" && !escrowed\.has\(b\.property\)/.test(tb) && !/filter === "overdue"\) return b\.status === "pending"/.test(tb));

const acctC = src("components/Accounting.js");
const unpaid = acctC.slice(acctC.indexOf("function getUnpaidBills("), acctC.indexOf("function getVendorBalanceSummary("));
assert("Unpaid Bills report reads open vendor invoices, not VINV- payment entries", !/VINV-|journalEntries/.test(unpaid) && /openVendorBills/.test(unpaid) && /\.in\("status", \["pending", "approved"\]\)/.test(acctC));
const mig = read("supabase/migrations/20260928150000_double_expense_links.sql");
assert("migration retypes BOTH work_order_id columns to integer only when empty", /ARRAY\['vendor_invoices', 'work_order_photos'\]/.test(mig) && /TYPE integer USING NULL/.test(mig) && /RAISE EXCEPTION/.test(mig));
assert("migration re-creates dependent policies from their own stored definitions", /FROM pg_policies/.test(mig) && /jsonb_to_recordset\(saved\)/.test(mig));
assert("migration adds both FKs and no loan column", /vendor_invoices_work_order_id_fkey/.test(mig) && /work_order_photos_work_order_id_fkey/.test(mig) && !/property_loans|last_payment_month|recurring_journal/i.test(mig.replace(/^--.*$/gm, "")));
assert("migration touches no journal entry", !/acct_journal/i.test(mig.replace(/^--.*$/gm, "")));
assert("reference label for VPAY-", /\["VPAY-", "Vendor Payment"\]/.test(src("components/Accounting.js")));

// ─── 3. LIVE on TEST ─────────────────────────────────────────────────────
require("./sandbox-env");
const url = process.env.TEST_SUPABASE_URL, key = process.env.TEST_SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.log("\n  (live part skipped: no TEST_SUPABASE_URL / TEST_SUPABASE_SERVICE_KEY)");
} else {
  console.log("\n🧪 LIVE (TEST project, throwaway company QA-EXP)");
  const { createClient } = require("@supabase/supabase-js");
  const svc = createClient(url, key, { auth: { persistSession: false } });
  // Real client modules, pointed at TEST with the service key.
  process.chdir(path.join(root, "tests"));
  if (typeof globalThis.window === "undefined") globalThis.window = { location: { href: "node-test" } };
  await import("./esm-extensionless.mjs");
  const { supabase } = await import("../src/supabase.js");
  const realFrom = supabase.from, realRpc = supabase.rpc;
  supabase.from = svc.from.bind(svc); supabase.rpc = svc.rpc.bind(svc);
  const P = await import("../src/utils/expensePosting.js");
  const T = await import("../src/utils/taxes.js");

  const CO = "qa-exp-" + Math.random().toString(36).slice(2, 10);
  const today = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const TODAY = today.getFullYear() + "-" + pad(today.getMonth() + 1) + "-" + pad(today.getDate());
  const PROP = (n) => "QA-EXP " + n + " Test St, Nowhere, MD 20000";
  const must = (r, what) => { if (r.error) throw new Error(what + ": " + r.error.message); return r.data; };

  // journal lines for a set of references: { code: {debit, credit} } over live entries
  async function ledger(refs) {
    const jes = must(await svc.from("acct_journal_entries").select("id, reference, status, acct_journal_lines(account_id, debit, credit)").eq("company_id", CO).in("reference", refs), "ledger");
    const accts = must(await svc.from("acct_accounts").select("id, code").eq("company_id", CO), "accts");
    const code = Object.fromEntries(accts.map(a => [a.id, a.code]));
    const out = {}; const rows = [];
    for (const je of jes) for (const l of je.acct_journal_lines || []) {
      rows.push(`${je.reference}${je.status === "voided" ? " (voided)" : ""}  ${code[l.account_id]}  DR ${Number(l.debit).toFixed(2)}  CR ${Number(l.credit).toFixed(2)}`);
      if (je.status === "voided") continue;
      const c = code[l.account_id]; out[c] = out[c] || { debit: 0, credit: 0 };
      out[c].debit += Number(l.debit); out[c].credit += Number(l.credit);
    }
    return { sum: out, rows, count: jes.filter(j => j.status !== "voided").length };
  }
  const show = (label, l) => { console.log("     " + label); l.rows.forEach(r => console.log("       " + r)); };
  const dr = (l, c) => Math.round(((l.sum[c]?.debit || 0) - (l.sum[c]?.credit || 0)) * 100) / 100;

  let woSeq = 0;
  async function mkWO(cost) {
    woSeq++;
    const d = must(await svc.from("work_orders").insert([{ company_id: CO, property: PROP("R" + woSeq), issue: "QA-EXP repair " + woSeq, cost, status: "completed", assigned: "QA-EXP Vendor" }]).select("*").single(), "wo");
    return d;
  }
  async function mkInv(amount, woId, property) {
    return must(await svc.from("vendor_invoices").insert([{ company_id: CO, vendor_name: "QA-EXP Vendor", amount, work_order_id: woId || null, property: property || PROP("INV"), description: "QA-EXP invoice", status: "pending" }]).select("*").single(), "inv");
  }
  const voidJE = async (ref) => must(await svc.from("acct_journal_entries").update({ status: "voided" }).eq("company_id", CO).eq("reference", ref), "void");

  try {
    must(await svc.from("companies").insert([{ id: CO, name: "QA-EXP throwaway" }]), "company");

    // R1 WO only (+ run twice)
    { const w = await mkWO(500);
      const r1 = await P.postWorkOrderCompletion({ companyId: CO, wo: w, date: TODAY });
      const r2 = await P.postWorkOrderCompletion({ companyId: CO, wo: w, date: TODAY });
      const l = await ledger(["WO-" + w.id]); show("R1 WO only, completed twice:", l);
      assert("R1 WO only: one entry, Repairs 500, AP 500 owed; 2nd run is a no-op", r1.jeId && r2.reason === "already_posted" && l.count === 1 && dr(l, "5300") === 500 && dr(l, "2110") === -500); }

    // R2 invoice only (+ run twice)
    { const inv = await mkInv(300, null);
      const r1 = await P.postVendorInvoicePayment({ companyId: CO, inv, date: TODAY });
      const r2 = await P.postVendorInvoicePayment({ companyId: CO, inv, date: TODAY });
      const l = await ledger(["VPAY-" + inv.id]); show("R2 invoice only, paid twice:", l);
      assert("R2 invoice only: one entry, Repairs 300, cash 300; 2nd run finds it", r1.jeId && r2.already && r2.jeId === r1.jeId && l.count === 1 && dr(l, "5300") === 300 && dr(l, "1000") === -300); }

    // R3 WO then linked invoice
    { const w = await mkWO(400); await P.postWorkOrderCompletion({ companyId: CO, wo: w, date: TODAY });
      const inv = await mkInv(400, w.id, w.property);
      await P.postVendorInvoicePayment({ companyId: CO, inv, date: TODAY });
      const l = await ledger(["WO-" + w.id, "VPAY-" + inv.id]); show("R3 WO completed, then its invoice paid:", l);
      assert("R3 WO then invoice: Repairs 400 once, AP cleared to 0, cash 400", dr(l, "5300") === 400 && dr(l, "2110") === 0 && dr(l, "1000") === -400); }

    // R4 linked invoice paid, then WO completed
    { const w = await mkWO(250);
      const inv = await mkInv(250, w.id, w.property);
      await P.postVendorInvoicePayment({ companyId: CO, inv, date: TODAY });
      const r = await P.postWorkOrderCompletion({ companyId: CO, wo: w, date: TODAY });
      const l = await ledger(["WO-" + w.id, "VPAY-" + inv.id]); show("R4 invoice paid, then WO completed:", l);
      assert("R4 invoice then WO: Repairs 250 once, WO posts nothing, no AP left", r.reason === "already_expensed_by_invoice" && dr(l, "5300") === 250 && dr(l, "2110") === 0 && l.count === 1); }

    // R5 two invoices against one WO (partial billing + overrun)
    { const w = await mkWO(600); await P.postWorkOrderCompletion({ companyId: CO, wo: w, date: TODAY });
      const a = await mkInv(200, w.id, w.property), b = await mkInv(450, w.id, w.property);
      await P.postVendorInvoicePayment({ companyId: CO, inv: a, date: TODAY });
      await P.postVendorInvoicePayment({ companyId: CO, inv: b, date: TODAY });
      const l = await ledger(["WO-" + w.id, "VPAY-" + a.id, "VPAY-" + b.id]); show("R5 WO 600, invoices 200 + 450:", l);
      assert("R5 split billing: Repairs 650 (600 accrued + 50 overrun), AP 0, cash 650", dr(l, "5300") === 650 && dr(l, "2110") === 0 && dr(l, "1000") === -650); }

    // R6 WO accrual voided, then linked invoice paid
    { const w = await mkWO(300); await P.postWorkOrderCompletion({ companyId: CO, wo: w, date: TODAY });
      await voidJE("WO-" + w.id);
      const inv = await mkInv(300, w.id, w.property);
      await P.postVendorInvoicePayment({ companyId: CO, inv, date: TODAY });
      const r = await P.postWorkOrderCompletion({ companyId: CO, wo: w, date: TODAY });
      const l = await ledger(["WO-" + w.id, "VPAY-" + inv.id]); show("R6 WO accrual voided, then invoice paid, then WO re-completed:", l);
      assert("R6 voided accrual: invoice expenses 300 once; re-completing does not revive the voided accrual", dr(l, "5300") === 300 && dr(l, "2110") === 0 && r.reason === "already_posted"); }

    // R7 linked payment voided, then WO completed
    { const w = await mkWO(200);
      const inv = await mkInv(200, w.id, w.property);
      await P.postVendorInvoicePayment({ companyId: CO, inv, date: TODAY });
      await voidJE("VPAY-" + inv.id);
      await P.postWorkOrderCompletion({ companyId: CO, wo: w, date: TODAY });
      const l = await ledger(["WO-" + w.id, "VPAY-" + inv.id]); show("R7 invoice payment voided, then WO completed:", l);
      assert("R7 voided payment: WO accrues 200 once", dr(l, "5300") === 200 && dr(l, "2110") === -200); }

    // R8 under-billed: WO 600, one linked invoice 400 -> 200 reversed exactly once
    { const w = await mkWO(600); await P.postWorkOrderCompletion({ companyId: CO, wo: w, date: TODAY });
      const inv = await mkInv(400, w.id, w.property);
      await P.postVendorInvoicePayment({ companyId: CO, inv, date: TODAY });
      must(await svc.from("vendor_invoices").update({ status: "paid" }).eq("id", inv.id), "mark paid");
      const c1 = await P.closeOutWorkOrder({ companyId: CO, woId: w.id, date: TODAY });
      const c2 = await P.closeOutWorkOrder({ companyId: CO, woId: w.id, date: TODAY });
      const c3 = await P.postWorkOrderCompletion({ companyId: CO, wo: w, date: TODAY });
      const l = await ledger(["WO-" + w.id, "VPAY-" + inv.id, "WO-ADJ-" + w.id]); show("R8 WO 600, invoice 400 paid, closed (close-out run 3 times):", l);
      assert("R8 under-billed: 200 reversed once; Repairs 400 net, AP 0, cash 400", c1.reversed === 200 && c2.reason === "already_posted" && c3.closeout?.reason === "already_posted" && dr(l, "5300") === 400 && dr(l, "2110") === 0 && dr(l, "1000") === -400 && l.count === 3);
      // a late extra invoice after close-out is new expense, AP stays 0
      const late = await mkInv(50, w.id, w.property);
      await P.postVendorInvoicePayment({ companyId: CO, inv: late, date: TODAY });
      const l2 = await ledger(["WO-" + w.id, "VPAY-" + inv.id, "WO-ADJ-" + w.id, "VPAY-" + late.id]);
      assert("R8b invoice arriving after close-out: expensed 50, AP not driven negative", dr(l2, "5300") === 450 && dr(l2, "2110") === 0); }

    // R9 close-out waits for every linked invoice; completion triggers it when they are already paid
    { const w = await mkWO(500);
      const a = await mkInv(200, w.id, w.property), b = await mkInv(100, w.id, w.property);
      must(await svc.from("work_orders").update({ status: "open" }).eq("id", w.id), "reopen");
      await P.postWorkOrderCompletion({ companyId: CO, wo: w, date: TODAY }); // accrues 500 (status irrelevant to accrual)
      await P.postVendorInvoicePayment({ companyId: CO, inv: a, date: TODAY });
      must(await svc.from("vendor_invoices").update({ status: "paid" }).eq("id", a.id), "paid a");
      const early = await P.closeOutWorkOrder({ companyId: CO, woId: w.id, date: TODAY });
      await P.postVendorInvoicePayment({ companyId: CO, inv: b, date: TODAY });
      must(await svc.from("vendor_invoices").update({ status: "paid" }).eq("id", b.id), "paid b");
      const stillOpen = await P.closeOutWorkOrder({ companyId: CO, woId: w.id, date: TODAY });
      must(await svc.from("work_orders").update({ status: "completed" }).eq("id", w.id), "complete");
      const done = await P.closeOutWorkOrder({ companyId: CO, woId: w.id, date: TODAY });
      const l = await ledger(["WO-" + w.id, "VPAY-" + a.id, "VPAY-" + b.id, "WO-ADJ-" + w.id]); show("R9 WO 500 with invoices 200 + 100, closed last:", l);
      assert("R9 waits while open/unpaid, then reverses 200 once: Repairs 300, AP 0", early.reason === "work_order_open" && stillOpen.reason === "work_order_open" && done.reversed === 200 && dr(l, "5300") === 300 && dr(l, "2110") === 0); }

    // Escrowed taxes
    { must(await svc.from("property_taxes").insert([
        { company_id: CO, property: PROP("T1"), annual_tax_amount: 3000, escrow_paid_by_lender: true },
        { company_id: CO, property: PROP("T3"), annual_tax_amount: 3000, escrow_paid_by_lender: false }]), "taxes");
      must(await svc.from("property_loans").insert([{ company_id: CO, property: PROP("T2"), lender_name: "QA-EXP Bank", monthly_payment: 900, status: "active", escrow_included: true, escrow_covers: "Taxes, Insurance" }]), "loan");
      const gen = (n) => T.generateBillsForProperty({ companyId: CO, propertyAddress: PROP(n), county: "Prince George's", state: "MD", taxYear: today.getFullYear(), expectedAnnualAmount: 3000 });
      const g1 = await gen("T1"), g2 = await gen("T2"), g3 = await gen("T3");
      const bills = must(await svc.from("property_tax_bills").select("property").eq("company_id", CO), "bills");
      console.log("     T generate: T1 " + JSON.stringify(g1) + " | T2 " + JSON.stringify(g2) + " | T3 " + JSON.stringify(g3));
      assert("T1 tax record escrowed: no bill generated", g1.reason === "escrowed" && !bills.some(b => b.property === PROP("T1")));
      assert("T2 loan escrow covers taxes: no bill generated", g2.reason === "escrowed" && !bills.some(b => b.property === PROP("T2")));
      assert("T3 not escrowed: bill generated as before", g3.created >= 1 && bills.some(b => b.property === PROP("T3")));
      // An escrowed property with a PRE-EXISTING pending bill: not reminded, not due.
      must(await svc.from("property_tax_bills").insert([{ company_id: CO, property: PROP("T1"), tax_year: today.getFullYear(), installment_label: "QA-EXP legacy", due_date: TODAY, status: "pending", auto_generated: true }]), "legacy bill");
      const set = await cron._escrow.loadEscrowedProperties(svc);
      assert("cron escrow set has T1 (tax flag) and T2 (loan escrow), not T3", set && set.has(CO + "|" + PROP("T1")) && set.has(CO + "|" + PROP("T2")) && !set.has(CO + "|" + PROP("T3")));
      const esc = await P.escrowedTaxProperties(CO);
      assert("client escrow set agrees", esc && esc.has(PROP("T1")) && esc.has(PROP("T2")) && !esc.has(PROP("T3"))); }
  } catch (e) {
    fail++; console.log("  ❌ live run threw: " + (e.stack || e.message));
  } finally {
    // Clean up everything in the throwaway company, children first.
    const jeIds = (await svc.from("acct_journal_entries").select("id").eq("company_id", CO)).data?.map(j => j.id) || [];
    for (let i = 0; i < jeIds.length; i += 100) await svc.from("acct_journal_lines").delete().in("journal_entry_id", jeIds.slice(i, i + 100));
    for (const t of ["acct_journal_lines", "acct_journal_entries", "vendor_invoices", "work_orders", "recurring_journal_entries", "property_loans", "property_tax_bills", "property_taxes", "acct_classes", "acct_accounts", "audit_trail", "error_log"]) {
      await svc.from(t).delete().eq("company_id", CO);
    }
    await svc.from("companies").delete().eq("id", CO);
    let left = 0;
    for (const t of ["acct_journal_lines", "acct_journal_entries", "vendor_invoices", "work_orders", "recurring_journal_entries", "property_loans", "property_tax_bills", "property_taxes", "acct_classes", "acct_accounts"]) {
      const { count } = await svc.from(t).select("*", { count: "exact", head: true }).eq("company_id", CO);
      left += count || 0;
    }
    const { count: coLeft } = await svc.from("companies").select("*", { count: "exact", head: true }).eq("id", CO);
    assert("QA-EXP cleanup: zero leftovers (" + CO + ")", left === 0 && !coLeft, "left=" + left + " company=" + coLeft);
    supabase.from = realFrom; supabase.rpc = realRpc;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
