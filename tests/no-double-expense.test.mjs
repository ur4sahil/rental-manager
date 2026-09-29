// One real-world expense, booked once (audit theme K).
//
//   REPAIRS   completing a work order accrued DR Repairs / CR AP, and paying
//             the vendor invoice for it expensed Repairs AGAIN. Now: the
//             invoice links to the work order, paying it clears the accrual,
//             an under-billed work order is closed out (WO-ADJ-), and the
//             read-decide-post runs in Postgres RPCs serialised per work order
//             (migration 20260928151000) so concurrent requests cannot
//             double-post. Booked work orders cannot be hard-deleted.
//   MORTGAGE  the wizard's recurring mortgage entry and the Loans page's
//             "Record payment" both booked the same month. Owner decision:
//             cash basis -- neither books anything; the bank feed does.
//   ESCROW    escrowed properties got tax bills; escrow_covers is now parsed
//             conservatively (unclear/negated -> NOT escrowed).
//
// Part 1 tests the pure rules (src/utils/expenseRules.js).
// Part 2 holds every path to them statically.
// Part 3 drives the REAL client code + RPCs against the TEST project in a
//        throwaway company "QA-EXP", prints journal lines as evidence, and
//        deletes everything it made.
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

const R = await import("data:text/javascript," + encodeURIComponent(src("utils/expenseRules.js")));
assert("expenseRules.js imports nothing", !/^\s*import\s/m.test(src("utils/expenseRules.js")));

// ─── 1. PURE RULES ────────────────────────────────────────────────────────
console.log("\n🧮 REFERENCES");
assert("WO-<id>, WO-ADJ-<id>, VPAY-<id>", R.workOrderAccrualReference(12) === "WO-12" && R.workOrderCloseoutReference(12) === "WO-ADJ-12" && R.invoicePaymentReference("abc") === "VPAY-abc");
assert("empty ids give no reference", R.workOrderAccrualReference(null) === null && R.workOrderCloseoutReference(undefined) === null && R.invoicePaymentReference("") === null);
assert("no mortgage machinery left in the rules", !/Mortgage|loanPayment|recurringReference|MORTGAGE_CODE/.test(Object.keys(R).join(",")));

console.log("\n🧮 ESCROW — conservative parsing");
const esc = R.escrowCoversTaxes;
// Shared with the cron: tests/fixtures/escrow-covers.json is the contract.
const ESC_FIXTURES = JSON.parse(read("tests/fixtures/escrow-covers.json"));
for (const f of ESC_FIXTURES) assert((f.escrowed ? "escrowed: " : "NOT escrowed: ") + JSON.stringify(f.value), esc(f.value) === f.escrowed);
assert("tax record flag escrows (strictly true)", R.taxesEscrowed({ taxRecord: { escrow_paid_by_lender: true }, loans: [] }) && !R.taxesEscrowed({ taxRecord: { escrow_paid_by_lender: "yes" }, loans: [] }));
assert("active loan with tax escrow escrows", R.taxesEscrowed({ taxRecord: null, loans: [{ escrow_included: true, escrow_covers: { taxes: true } }] }));
assert("archived / paid-off / escrow-off loans do not", !R.taxesEscrowed({ taxRecord: { escrow_paid_by_lender: false }, loans: [
  { escrow_included: true, escrow_covers: { taxes: true }, archived_at: "2026-01-01" },
  { escrow_included: true, escrow_covers: { taxes: true }, status: "paid_off" },
  { escrow_included: false, escrow_covers: { taxes: true } }] }));

const cron = require(path.join(root, "api", "_tax-bill-reminders-impl.js"));
assert("cron escrowCoversTaxes matches every shared fixture (" + ESC_FIXTURES.length + ")",
  ESC_FIXTURES.every(f => cron._escrow.escrowCoversTaxes(f.value) === f.escrowed), JSON.stringify(ESC_FIXTURES.filter(f => cron._escrow.escrowCoversTaxes(f.value) !== f.escrowed)));

// ─── 2. STATIC ────────────────────────────────────────────────────────────
console.log("\n🔎 PATHS");
const maint = src("components/Maintenance.js");
const upd = maint.slice(maint.indexOf("async function updateStatus("), maint.indexOf("function startEdit("));
const payInv = maint.slice(maint.indexOf("async function payInvoice("), maint.indexOf("async function withdrawInvoice("));
const saveWO = maint.slice(maint.indexOf("async function saveWorkOrder("), maint.indexOf("async function billTenantForWO("));
assert("status button completes via the shared helper", /postCompletionAccounting\(wo\)/.test(upd) && !/autoPostJournalEntry|"5300"/.test(upd));
assert("EDIT FORM completion takes the same path", /payload\.status === "completed" && \(!editingWO \|\| editingWO\.status !== "completed"\)/.test(saveWO) && /postCompletionAccounting\(\{ \.\.\.payload, id: woId \}\)/.test(saveWO));
assert("invoice payment = ONE rpc (post + mark paid + totals + close-out)", /postVendorInvoicePayment\(/.test(payInv) && !/autoPostJournalEntry|"5300"|VINV-|increment_vendor_totals|status: "paid"|closeOutWorkOrder/.test(payInv));
assert("unpaid/disputed invoices can be withdrawn (archived), paid ones cannot", /async function withdrawInvoice\(inv\)/.test(maint) && /\.neq\("status", "paid"\)/.test(maint) && /is\("archived_at", null\)\.order\("created_at"/.test(maint));
assert("no component debits Repairs directly for a WO/invoice", !/account_id: "5300"/.test(maint));
const post = src("utils/expensePosting.js");
assert("client wrappers call the three RPCs", /"repair_complete_work_order"/.test(post) && /"repair_pay_invoice"/.test(post) && /"repair_close_out_work_order"/.test(post) && !/acct_journal_entries|autoPostJournalEntry/.test(post));

const admin = src("components/Admin.js");
assert("Admin › Archived › Delete explains a booked work order instead of a raw error", /function bookedDeleteMessage\(table, error\)/.test(admin) && (admin.match(/bookedDeleteMessage\(/g) || []).length === 3);
const tp = src("components/TenantPortal.js");
const sub = tp.slice(tp.indexOf("async function submitMaintenanceRequest("), tp.indexOf("// ---- MESSAGING ----"));
assert("tenant portal reports photos that failed to attach", /const \{ error: photoErr \}/.test(sub) && /failedPhotos\.length > 0\) showToast\(/.test(sub));

const loans = src("components/Loans.js");
const rec = loans.slice(loans.indexOf("async function recordPayment("), loans.indexOf("async function fetchPortfolioLoans("));
assert("Record payment posts NO journal entry", !/autoPostJournalEntry|atomicPost|rpc\(|"5600"|acct_journal/.test(rec) && /current_balance: newBalance/.test(rec));
assert("no last_payment_month machinery", !/last_payment_month/.test(loans + post + src("utils/expenseRules.js")));
assert("wizard never asks for a recurring mortgage", /setup_recurring: false,/.test(src("components/Properties.js")) && !/Set up recurring mortgage payment/.test(src("components/Properties.js")));
const acctU = src("utils/accounting.js");
assert("recurring engine has no mortgage special case", !/mortgage/i.test(acctU.slice(acctU.indexOf("export async function autoPostRecurringEntries("), acctU.indexOf("export const _zipCache"))));

const taxes = src("utils/taxes.js");
const gen = taxes.slice(taxes.indexOf("export async function generateBillsForProperty("), taxes.indexOf("export async function markBillPaid("));
assert("bill generation checks escrow before writing anything", gen.indexOf("propertyTaxesEscrowed(") > 0 && gen.indexOf("propertyTaxesEscrowed(") < gen.indexOf('.from("property_tax_bills")'));
const cronSrc = read("api/_tax-bill-reminders-impl.js");
assert("cron: escrow set loaded first; failure aborts", cronSrc.indexOf("loadEscrowedProperties(supabase)") < cronSrc.indexOf("rollforwardNextYear(supabase, todayIso, escrowedSet)") && /if \(!escrowedSet\)/.test(cronSrc));
assert("cron: reminders skip escrowed properties", /escrowedSet\.has\(b\.company_id \+ "\|" \+ b\.property\)\) \{ skippedEscrowed\+\+; continue; \}/.test(cronSrc));
assert("dashboard hides escrowed bills", /escrowedTaxProperties\(companyId\)/.test(src("components/Dashboard.js")));

const acctC = src("components/Accounting.js");
const unpaidBlock = acctC.slice(acctC.indexOf("const [openVendorBills, setOpenVendorBills]"), acctC.indexOf("function getVendorBalanceSummary("));
assert("Unpaid Bills: as-of by paid_date, includes disputed, excludes withdrawn, never VINV- entries",
  /\.is\("archived_at", null\)\.lte\("invoice_date", asOf\)/.test(unpaidBlock) && /\.or\(`status\.neq\.paid,paid_date\.gt\.\$\{asOf\}`\)/.test(unpaidBlock) && /\[companyId, asOfDate\]/.test(unpaidBlock) && !/VINV-|journalEntries/.test(unpaidBlock));
assert("reference label for VPAY-", /\["VPAY-", "Vendor Payment"\]/.test(acctC));

const mig1 = read("supabase/migrations/20260928150000_double_expense_links.sql");
const mig2 = read("supabase/migrations/20260928151000_repair_postings_atomic.sql");
const code2 = mig2.replace(/^\s*--.*$/gm, "");
assert("150000 retypes both work_order_id columns only when empty, re-creating policies from their own definitions", /ARRAY\['vendor_invoices', 'work_order_photos'\]/.test(mig1) && /RAISE EXCEPTION/.test(mig1) && /jsonb_to_recordset\(saved\)/.test(mig1));
assert("invoice FK is ON DELETE RESTRICT (both migrations)", /ON DELETE RESTRICT/.test(mig1) && /ON DELETE RESTRICT/.test(code2));
assert("booked work orders cannot be deleted; purge skips them", /BEFORE DELETE ON public\.work_orders/.test(code2) && /AND NOT public\._work_order_is_booked\(w\.company_id, w\.id\)/.test(code2));
assert("RPCs take the per-work-order advisory lock (and per invoice)", /pg_advisory_xact_lock\(hashtext\(p_company_id \|\| ':WO:' \|\| p_wo_id\)\)/.test(code2) && /pg_advisory_xact_lock\(hashtext\(p_company_id \|\| ':VINV:' \|\| p_invoice_id\)\)/.test(code2));
assert("RPCs are SECURITY INVOKER + staff check, no anon", (code2.match(/SECURITY INVOKER/g) || []).length === 3 && (code2.match(/_assert_company_staff\(p_company_id\)/g) || []).length === 3 && /REVOKE ALL ON FUNCTION ' \|\| f \|\| ' FROM PUBLIC, anon/.test(code2));
assert("voided entries are ignored by every guard", (code2.match(/status <> 'voided'/g) || []).length >= 6 && !/reference = 'WO-' \|\| p_wo_id\)\s*(THEN|LIMIT)/.test(code2));
assert("same-company trigger on invoices AND photos; paid invoice cannot be re-pointed", /ON public\.vendor_invoices\s+FOR EACH ROW EXECUTE FUNCTION public\._guard_work_order_link/.test(code2) && /ON public\.work_order_photos\s+FOR EACH ROW EXECUTE FUNCTION public\._guard_work_order_link/.test(code2) && /paid_invoice_relink/.test(code2));
assert("tenant INSERT policy scoped to the tenant's own work order", /CREATE POLICY wo_photos_tenant_insert[\s\S]{0,400}wo\.tenant_id = get_tenant_id\(wo\.company_id\)/.test(code2));
assert("vendor totals counted on the paid transition, not per post", /IF v_inv\.status IS DISTINCT FROM 'paid' THEN[\s\S]{0,300}UPDATE vendors SET total_paid/.test(code2));
const mig3 = read("supabase/migrations/20260928152000_repair_postings_qa3.sql");
const code3 = mig3.replace(/^\s*--.*$/gm, "");
assert("no migration touches existing journal entries", !/(UPDATE|DELETE FROM)\s+(public\.)?acct_journal/i.test(mig1 + code2 + code3));
assert("R3: vendor FK is RESTRICT and a vendor with invoices cannot be deleted", /REFERENCES public\.vendors\(id\) ON DELETE RESTRICT/.test(code3) && /BEFORE DELETE ON public\.vendors/.test(code3) && /vendor_has_invoices/.test(admin));
assert("R3: withdraw re-runs the close-out", /async function withdrawInvoice[\s\S]{0,1400}closeOutWorkOrder\(\{ companyId, woId: inv\.work_order_id/.test(maint));
assert("R3: the pay RPC refuses withdrawn and disputed invoices", /archived_at IS NOT NULL THEN RETURN jsonb_build_object\('reason', 'withdrawn'\)/.test(code3) && /status = 'disputed' THEN RETURN jsonb_build_object\('reason', 'disputed'\)/.test(code3));
assert("R3: voiding a VPAY- un-pays the invoice and its vendor totals (and un-voiding re-pays)", /AFTER UPDATE OF status ON public\.acct_journal_entries/.test(code3) && /SET status = 'pending', paid_date = NULL/.test(code3) && /total_paid = greatest\(0/.test(code3));
assert("R3: account creation is race-safe", /ON CONFLICT \(company_id, code\) DO NOTHING/.test(code3));
assert("R3: purge deletes row by row and skips what it cannot delete", /EXCEPTION WHEN OTHERS THEN\s+v_skipped := v_skipped \+ 1/.test(code3) && /'skipped', v_skipped/.test(code3));
assert("R3: VPAY is a system reference; link error names no id", /\|VPAY\|/.test(code3) && /'Work order not found in this company'/.test(code3));

// ─── 3. LIVE on TEST ─────────────────────────────────────────────────────
require("./sandbox-env");
const url = process.env.TEST_SUPABASE_URL, key = process.env.TEST_SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.log("\n  (live part skipped: no TEST_SUPABASE_URL / TEST_SUPABASE_SERVICE_KEY)");
} else {
  console.log("\n🧪 LIVE (TEST project, throwaway company QA-EXP)");
  const { createClient } = require("@supabase/supabase-js");
  const svc = createClient(url, key, { auth: { persistSession: false } });
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

  async function ledger(refs) {
    const jes = must(await svc.from("acct_journal_entries").select("id, reference, status, acct_journal_lines(account_id, debit, credit)").eq("company_id", CO).in("reference", refs), "ledger");
    const accts = must(await svc.from("acct_accounts").select("id, code").eq("company_id", CO), "accts");
    const code = Object.fromEntries(accts.map(a => [a.id, a.code]));
    const sum = {}; const rows = [];
    for (const je of jes) for (const l of je.acct_journal_lines || []) {
      rows.push(`${je.reference}${je.status === "voided" ? " (voided)" : ""}  ${code[l.account_id]}  DR ${Number(l.debit).toFixed(2)}  CR ${Number(l.credit).toFixed(2)}`);
      if (je.status === "voided") continue;
      const c = code[l.account_id]; sum[c] = (sum[c] || 0) + Number(l.debit) - Number(l.credit);
    }
    for (const k in sum) sum[k] = Math.round(sum[k] * 100) / 100;
    return { sum, rows, count: jes.filter(j => j.status !== "voided").length };
  }
  const show = (label, l) => { console.log("     " + label); l.rows.forEach(r => console.log("       " + r)); };
  const bal = (l, c) => l.sum[c] || 0;
  const refs = (w, invs) => ["WO-" + w.id, "WO-ADJ-" + w.id, ...invs.map(i => "VPAY-" + i.id)];

  let n = 0;
  const mkWO = async (cost, status = "completed") => must(await svc.from("work_orders").insert([{ company_id: CO, property: PROP("R" + (++n)), issue: "QA-EXP repair " + n, cost, status, assigned: "QA-EXP Vendor" }]).select("*").single(), "wo");
  const mkInv = async (amount, woId, extra = {}) => must(await svc.from("vendor_invoices").insert([{ company_id: CO, vendor_name: "QA-EXP Vendor", amount, work_order_id: woId || null, property: PROP("INV"), description: "QA-EXP invoice", status: "pending", ...extra }]).select("*").single(), "inv");
  const voidJE = async (ref) => must(await svc.from("acct_journal_entries").update({ status: "voided" }).eq("company_id", CO).eq("reference", ref), "void");
  const complete = (w) => P.postWorkOrderCompletion({ companyId: CO, wo: w, date: TODAY });
  const pay = (inv) => P.postVendorInvoicePayment({ companyId: CO, inv, date: TODAY });
  const closeOut = (w) => P.closeOutWorkOrder({ companyId: CO, woId: w.id, date: TODAY });

  try {
    must(await svc.from("companies").insert([{ id: CO, name: "QA-EXP throwaway" }]), "company");

    // R1 WO only, completed twice
    { const w = await mkWO(500); const r1 = await complete(w); const r2 = await complete(w);
      const l = await ledger(refs(w, [])); show("R1 WO only, completed twice:", l);
      assert("R1 WO only: one accrual 5300 500 / 2110 500; 2nd run no-op", r1.reason === "accrue" && r2.reason === "already_posted" && l.count === 1 && bal(l, "5300") === 500 && bal(l, "2110") === -500); }

    // R2 invoice only, paid twice
    { const inv = await mkInv(300, null); const r1 = await pay(inv); const r2 = await pay(inv);
      const l = await ledger(["VPAY-" + inv.id]); show("R2 invoice only, paid twice:", l);
      assert("R2 invoice only: 5300 300 once; 2nd call finds it", r1.reason === "posted" && r1.marked_paid && r2.reason === "already_posted" && !r2.marked_paid && l.count === 1 && bal(l, "5300") === 300); }

    // R3 WO then linked invoice
    { const w = await mkWO(400); await complete(w); const inv = await mkInv(400, w.id); await pay(inv);
      const l = await ledger(refs(w, [inv])); show("R3 WO completed, then its invoice paid:", l);
      assert("R3 WO then invoice: 5300 400 once, AP 0", bal(l, "5300") === 400 && bal(l, "2110") === 0 && bal(l, "1000") === -400); }

    // R4 linked invoice paid, then WO completed
    { const w = await mkWO(250); const inv = await mkInv(250, w.id); await pay(inv); const r = await complete(w);
      const l = await ledger(refs(w, [inv])); show("R4 invoice paid, then WO completed:", l);
      assert("R4 invoice then WO: 5300 250 once, WO posts nothing", r.reason === "already_expensed_by_invoice" && bal(l, "5300") === 250 && bal(l, "2110") === 0); }

    // R5 two invoices (split + overrun)
    { const w = await mkWO(600); await complete(w); const a = await mkInv(200, w.id), b = await mkInv(450, w.id);
      await pay(a); await pay(b);
      const l = await ledger(refs(w, [a, b])); show("R5 WO 600, invoices 200 + 450:", l);
      assert("R5 split billing: 5300 650 (600 + 50 overrun), AP 0", bal(l, "5300") === 650 && bal(l, "2110") === 0); }

    // R6 accrual voided, invoice paid, re-complete
    { const w = await mkWO(300); await complete(w); await voidJE("WO-" + w.id);
      const inv = await mkInv(300, w.id); await pay(inv); const r = await complete(w);
      const l = await ledger(refs(w, [inv])); show("R6 WO accrual voided, invoice paid, WO re-completed:", l);
      assert("R6 voided accrual: invoice expenses 300 once; re-complete sees it and posts nothing", bal(l, "5300") === 300 && bal(l, "2110") === 0 && r.reason === "already_expensed_by_invoice"); }

    // R7 VOIDED accrual, cost fixed, re-completed (no invoice) -> re-posted
    { const w = await mkWO(400); await complete(w); await voidJE("WO-" + w.id);
      must(await svc.from("work_orders").update({ cost: 450 }).eq("id", w.id), "cost");
      const r = await complete(w);
      const l = await ledger(refs(w, [])); show("R7 accrual voided, cost fixed to 450, re-completed:", l);
      assert("R7 a voided accrual is re-posted on re-completion (450)", r.reason === "accrue" && bal(l, "5300") === 450); }

    // R8 under-billed close-out, idempotent, voided close-out re-runs, late invoice
    { const w = await mkWO(600); await complete(w); const inv = await mkInv(400, w.id);
      const p = await pay(inv); const c2 = await closeOut(w); const c3 = await complete(w);
      const l = await ledger(refs(w, [inv])); show("R8 WO 600, invoice 400 paid (close-out attempted 3 times):", l);
      assert("R8 under-billed: 200 reversed exactly once by the payment; re-runs no-op", p.closeout?.reversed === 200 && c2.reason === "already_posted" && c3.closeout?.reason === "already_posted" && bal(l, "5300") === 400 && bal(l, "2110") === 0 && l.count === 3);
      await voidJE("WO-ADJ-" + w.id); const c4 = await closeOut(w);
      const l2 = await ledger(refs(w, [inv]));
      assert("R8b a voided close-out is posted again on the next run", c4.reversed === 200 && bal(l2, "5300") === 400 && bal(l2, "2110") === 0);
      const late = await mkInv(50, w.id); await pay(late);
      const l3 = await ledger(refs(w, [inv, late]));
      assert("R8c invoice after close-out: new expense 50, AP never negative", bal(l3, "5300") === 450 && bal(l3, "2110") === 0); }

    // R9 close-out waits for completion and every invoice
    { const w = await mkWO(500, "open"); await complete(w);
      const a = await mkInv(200, w.id), b = await mkInv(100, w.id);
      const pa = await pay(a); const pb = await pay(b);
      must(await svc.from("work_orders").update({ status: "completed" }).eq("id", w.id), "complete");
      const done = await closeOut(w);
      const l = await ledger(refs(w, [a, b])); show("R9 WO 500 open while invoices 200 + 100 paid, then completed:", l);
      assert("R9 waits while open, then reverses 200 once: 5300 300, AP 0", pa.closeout?.reason === "work_order_open" && pb.closeout?.reason === "work_order_open" && done.reversed === 200 && bal(l, "5300") === 300 && bal(l, "2110") === 0); }

    // R10 disputed sibling blocks; withdrawing (archiving) it releases the close-out
    { const w = await mkWO(600); await complete(w); const a = await mkInv(400, w.id); const d = await mkInv(50, w.id, { status: "disputed" });
      const p = await pay(a);
      must(await svc.from("vendor_invoices").update({ archived_at: new Date().toISOString() }).eq("id", d.id), "withdraw");
      const c = await closeOut(w);
      assert("R10 disputed invoice holds the close-out; once withdrawn it proceeds (200)", p.closeout?.reason === "invoices_unpaid" && c.reversed === 200); }

    // R11 VPAY voided while invoice still says paid -> close-out waits
    { const w = await mkWO(300); await complete(w); const a = await mkInv(100, w.id);
      await pay(a); await voidJE("VPAY-" + a.id); await voidJE("WO-ADJ-" + w.id);
      const c = await closeOut(w);
      assert("R11 a voided invoice payment is not 'paid' for the close-out", c.reason === "invoices_unpaid");
      const rp = await pay(a); // re-pay after the void
      const l = await ledger(refs(w, [a]));
      assert("R11b re-paying after a void posts again (AP 100) and then closes out 200", rp.reason === "posted" && rp.ap === 100 && rp.closeout?.reversed === 200 && bal(l, "5300") === 100 && bal(l, "2110") === 0); }

    // C1 two linked invoices paid concurrently; C2 completion racing payment
    { const w = await mkWO(1000); await complete(w); const a = await mkInv(600, w.id), b = await mkInv(600, w.id);
      await Promise.all([pay(a), pay(b)]);
      const l = await ledger(refs(w, [a, b])); show("C1 concurrent invoices 600 + 600 vs WO 1000:", l);
      assert("C1 concurrent linked invoices: 5300 1200, AP 0 (never over-cleared)", bal(l, "5300") === 1200 && bal(l, "2110") === 0);
      const w2 = await mkWO(500); const i2 = await mkInv(500, w2.id);
      await Promise.all([complete(w2), pay(i2)]);
      const l2 = await ledger(refs(w2, [i2]));
      assert("C2 completion racing its invoice payment: 5300 500, AP 0", bal(l2, "5300") === 500 && bal(l2, "2110") === 0);
      const i3 = await mkInv(75, null);
      await Promise.all([pay(i3), pay(i3), pay(i3)]);
      const l3 = await ledger(["VPAY-" + i3.id]);
      assert("C3 same invoice paid 3x at once: one entry", l3.count === 1 && bal(l3, "5300") === 75); }

    // D1 hard delete of a booked work order refused; unbooked one allowed
    { const w = await mkWO(800); await complete(w); const inv = await mkInv(800, w.id);
      const del = await svc.from("work_orders").delete().eq("id", w.id);
      const still = must(await svc.from("vendor_invoices").select("work_order_id").eq("id", inv.id).single(), "inv");
      assert("D1 booked work order cannot be hard-deleted; invoice stays linked", !!del.error && /cannot be permanently deleted/.test(del.error.message) && still.work_order_id === w.id, del.error?.message);
      const w2 = await mkWO(0, "open"); const del2 = await svc.from("work_orders").delete().eq("id", w2.id);
      assert("D2 an unbooked work order can still be deleted", !del2.error, del2.error?.message);
      const rl = await svc.from("vendor_invoices").update({ work_order_id: null }).eq("id", inv.id);
      assert("D3 an unpaid invoice can still be unlinked", !rl.error, rl.error?.message);
      const inv2 = await mkInv(10, w.id); await pay(inv2);
      const rl2 = await svc.from("vendor_invoices").update({ work_order_id: null }).eq("id", inv2.id);
      assert("D4 a PAID invoice cannot be re-pointed", !!rl2.error && /can no longer be changed/.test(rl2.error.message), rl2.error?.message); }

    // X1 cross-company links refused
    { const CO2 = CO + "-b"; must(await svc.from("companies").insert([{ id: CO2, name: "QA-EXP other" }]), "co2");
      const wB = must(await svc.from("work_orders").insert([{ company_id: CO2, property: "QA-EXP B", issue: "QA-EXP B", cost: 1 }]).select("id").single(), "woB");
      const x1 = await svc.from("vendor_invoices").insert([{ company_id: CO, vendor_name: "QA-EXP", amount: 1, work_order_id: wB.id }]);
      const x2 = await svc.from("work_order_photos").insert([{ company_id: CO, work_order_id: wB.id, url: "qa-exp" }]);
      assert("X1 invoice cannot link another company's work order", !!x1.error && /not found in this company/.test(x1.error.message), x1.error?.message);
      assert("X2 photo cannot point at another company's work order", !!x2.error && /not found in this company/.test(x2.error.message), x2.error?.message);
      await svc.from("work_orders").delete().eq("id", wB.id); await svc.from("companies").delete().eq("id", CO2); }

    // V1 vendor totals counted once (incl. legacy "posted but not marked paid")
    { const v = must(await svc.from("vendors").insert([{ company_id: CO, name: "QA-EXP Vendor Co", total_paid: 0, total_jobs: 0 }]).select("id").single(), "vendor");
      const inv = await mkInv(120, null, { vendor_id: v.id });
      await pay(inv); await pay(inv);
      const inv2 = await mkInv(80, null, { vendor_id: v.id });
      await pay(inv2); must(await svc.from("vendor_invoices").update({ status: "pending", paid_date: null }).eq("id", inv2.id), "simulate half-finished");
      const retry = await pay(inv2);
      const vv = must(await svc.from("vendors").select("total_paid, total_jobs").eq("id", v.id).single(), "vv");
      const l = await ledger(["VPAY-" + inv.id, "VPAY-" + inv2.id]);
      assert("V1 vendor totals 280 / 3 jobs (a 2nd pay of the same invoice counts nothing); retry of a posted-but-unmarked payment marks it paid without re-posting",
        Number(vv.total_paid) === 280 && vv.total_jobs === 3 && retry.reason === "already_posted" && retry.marked_paid === true && l.count === 2,
        JSON.stringify({ vv, retry: retry.reason }));
      // (280/3: the simulated reset is what a legacy half-finished attempt looks like -- the payment was never counted, so the retry counts it)
    }

    // U1 Unpaid Bills as-of filter (same query the report runs)
    { const early = await mkInv(10, null, { invoice_date: "2026-08-01", status: "paid", paid_date: "2026-09-15" });
      const disp = await mkInv(20, null, { invoice_date: "2026-08-05", status: "disputed" });
      const gone = await mkInv(30, null, { invoice_date: "2026-08-06", archived_at: new Date().toISOString() });
      const paidEarly = await mkInv(40, null, { invoice_date: "2026-08-02", status: "paid", paid_date: "2026-08-20" });
      const asOf = "2026-08-31";
      const rows = must(await svc.from("vendor_invoices").select("id").eq("company_id", CO).is("archived_at", null).lte("invoice_date", asOf).or(`status.neq.paid,paid_date.gt.${asOf}`), "unpaid");
      const ids = new Set(rows.map(r => r.id));
      assert("U1 as of Aug 31: paid-in-Sept shows unpaid, disputed shows, withdrawn and paid-in-Aug do not",
        ids.has(early.id) && ids.has(disp.id) && !ids.has(gone.id) && !ids.has(paidEarly.id)); }

    // Round 3 --------------------------------------------------------------
    // V2 a vendor with invoices cannot be hard-deleted (used to cascade them away)
    { const v = must(await svc.from("vendors").insert([{ company_id: CO, name: "QA-EXP Del Vendor" }]).select("id").single(), "v");
      const w = await mkWO(800); await complete(w);
      const inv = await mkInv(800, w.id, { vendor_id: v.id }); await pay(inv);
      const del = await svc.from("vendors").delete().eq("id", v.id);
      const left = must(await svc.from("vendor_invoices").select("id").eq("id", inv.id), "inv left");
      const r = await complete(w);
      const l = await ledger(refs(w, [inv]));
      assert("V2 vendor delete refused; invoice kept; repair still booked once (800)", !!del.error && /cannot be permanently deleted/.test(del.error.message) && left.length === 1 && r.reason === "already_posted" && bal(l, "5300") === 800 && bal(l, "2110") === 0, del.error?.message); }

    // W1 withdraw re-runs the close-out (the UI calls repair_close_out_work_order after archiving)
    { const w = await mkWO(600); await complete(w); const a = await mkInv(400, w.id); const d = await mkInv(50, w.id, { status: "disputed" });
      const p = await pay(a);
      must(await svc.from("vendor_invoices").update({ archived_at: new Date().toISOString() }).eq("id", d.id), "withdraw");
      const c = await closeOut(w);
      const l = await ledger(refs(w, [a, d]));
      assert("W1 disputed sibling withdrawn -> close-out reverses 200; 5300 400, AP 0", p.closeout?.reason === "invoices_unpaid" && c.reversed === 200 && bal(l, "5300") === 400 && bal(l, "2110") === 0); }

    // W2 withdrawn / disputed invoices are refused by the pay RPC
    { const wi = await mkInv(75, null, { archived_at: new Date().toISOString() });
      const di = await mkInv(60, null, { status: "disputed" });
      const r1 = await pay(wi), r2 = await pay(di);
      const l = await ledger(["VPAY-" + wi.id, "VPAY-" + di.id]);
      assert("W2 pay RPC refuses withdrawn and disputed invoices; nothing posted", r1.reason === "withdrawn" && r2.reason === "disputed" && l.count === 0); }

    // P1 voiding a VPAY- entry un-pays the invoice + vendor totals; re-pay works; un-void blocked
    { const v = must(await svc.from("vendors").insert([{ company_id: CO, name: "QA-EXP Void Vendor", total_paid: 0, total_jobs: 0 }]).select("id").single(), "v");
      const w = await mkWO(600); await complete(w);
      const inv = await mkInv(400, w.id, { vendor_id: v.id }); await pay(inv);
      await voidJE("VPAY-" + inv.id); await voidJE("WO-ADJ-" + w.id);
      const after = must(await svc.from("vendor_invoices").select("status, paid_date").eq("id", inv.id).single(), "after");
      const vv1 = must(await svc.from("vendors").select("total_paid, total_jobs").eq("id", v.id).single(), "vv1");
      const rp = await pay({ ...inv, status: after.status });
      const vv2 = must(await svc.from("vendors").select("total_paid, total_jobs").eq("id", v.id).single(), "vv2");
      const l = await ledger(refs(w, [inv]));
      assert("P1 void of VPAY -> invoice pending, vendor totals back to 0", after.status === "pending" && after.paid_date === null && Number(vv1.total_paid) === 0 && vv1.total_jobs === 0, JSON.stringify({ after, vv1 }));
      assert("P1b re-pay after void: posted, totals 400/1, close-out 200, 5300 400, AP 0", rp.reason === "posted" && rp.marked_paid && Number(vv2.total_paid) === 400 && vv2.total_jobs === 1 && rp.closeout?.reversed === 200 && bal(l, "5300") === 400 && bal(l, "2110") === 0, JSON.stringify({ rp: rp.reason, vv2 })); }

    // F1 first use in a brand-new company: 10 postings at once must all succeed
    { const CO3 = CO + "-c"; must(await svc.from("companies").insert([{ id: CO3, name: "QA-EXP fresh" }]), "co3");
      const ws = [];
      for (let i = 0; i < 10; i++) ws.push(must(await svc.from("work_orders").insert([{ company_id: CO3, property: "QA-EXP F" + i, issue: "QA-EXP fresh " + i, cost: 100 + i, status: "completed" }]).select("*").single(), "wo3"));
      const rs = await Promise.all(ws.map(w => P.postWorkOrderCompletion({ companyId: CO3, wo: w, date: TODAY })));
      const accts = must(await svc.from("acct_accounts").select("code").eq("company_id", CO3), "a3");
      assert("F1 10 concurrent first postings in a fresh company all post; one 2110 and one 5300", rs.every(r => r.reason === "accrue") && accts.filter(a => a.code === "2110").length === 1 && accts.filter(a => a.code === "5300").length === 1, JSON.stringify(rs.map(r => r.reason + (r.error ? ":" + r.error.message : "")))); }

    // S1 VPAY- is a system reference; link error does not name the id
    { const { data: sys } = await svc.rpc("je_reference_is_system", { p_reference: "VPAY-" + "00000000-0000-0000-0000-000000000000" });
      const x = await svc.from("vendor_invoices").insert([{ company_id: CO, vendor_name: "QA-EXP", amount: 1, work_order_id: 2147480000 }]);
      assert("S1 VPAY- counts as a system reference", sys === true);
      assert("S1b link error for a missing / foreign work order names no id", !!x.error && x.error.message === "Work order not found in this company", x.error?.message); }

    // Escrowed taxes
    { must(await svc.from("property_taxes").insert([
        { company_id: CO, property: PROP("T1"), annual_tax_amount: 3000, escrow_paid_by_lender: true },
        { company_id: CO, property: PROP("T3"), annual_tax_amount: 3000, escrow_paid_by_lender: false }]), "taxes");
      must(await svc.from("property_loans").insert([
        { company_id: CO, property: PROP("T2"), lender_name: "QA-EXP Bank", monthly_payment: 900, status: "active", escrow_included: true, escrow_covers: "Taxes, Insurance" },
        { company_id: CO, property: PROP("T4"), lender_name: "QA-EXP Bank", monthly_payment: 900, status: "active", escrow_included: true, escrow_covers: "Insurance only (owner pays taxes)" }]), "loans");
      const gen = (x) => T.generateBillsForProperty({ companyId: CO, propertyAddress: PROP(x), county: "Prince George's", state: "MD", taxYear: today.getFullYear(), expectedAnnualAmount: 3000 });
      const g1 = await gen("T1"), g2 = await gen("T2"), g3 = await gen("T3"), g4 = await gen("T4");
      assert("T1/T2 escrowed (tax flag / loan text): no bill", g1.reason === "escrowed" && g2.reason === "escrowed");
      assert("T3 not escrowed / T4 negated text: bills generated", g3.created >= 1 && g4.created >= 1, JSON.stringify({ g3, g4 }));
      const set = await cron._escrow.loadEscrowedProperties(svc);
      const cl = await P.escrowedTaxProperties(CO);
      assert("cron and client escrow sets agree", [1, 2, 3, 4].every(i => set.has(CO + "|" + PROP("T" + i)) === cl.has(PROP("T" + i))) && cl.has(PROP("T1")) && cl.has(PROP("T2")) && !cl.has(PROP("T4"))); }
  } catch (e) {
    fail++; console.log("  ❌ live run threw: " + (e.stack || e.message));
  } finally {
    // Clean up. Journal entries first (the work-order delete guard checks them),
    // then invoices, then everything else.
    const jeIds = (await svc.from("acct_journal_entries").select("id").like("company_id", CO + "%")).data?.map(j => j.id) || [];
    for (let i = 0; i < jeIds.length; i += 100) await svc.from("acct_journal_lines").delete().in("journal_entry_id", jeIds.slice(i, i + 100));
    for (const t of ["acct_journal_lines", "acct_journal_entries", "vendor_invoices", "work_order_photos", "work_orders", "vendors", "recurring_journal_entries", "property_loans", "property_tax_bills", "property_taxes", "acct_classes", "acct_accounts", "audit_trail", "error_log"]) {
      await svc.from(t).delete().like("company_id", CO + "%");  // CO and the "-b" company of X1
    }
    await svc.from("companies").delete().like("id", CO + "%");
    let left = 0;
    for (const t of ["acct_journal_lines", "acct_journal_entries", "vendor_invoices", "work_order_photos", "work_orders", "vendors", "property_loans", "property_tax_bills", "property_taxes", "acct_classes", "acct_accounts", "audit_trail"]) {
      const { count } = await svc.from(t).select("*", { count: "exact", head: true }).like("company_id", CO + "%");
      left += count || 0;
    }
    const { count: coLeft } = await svc.from("companies").select("*", { count: "exact", head: true }).like("id", CO + "%");
    assert("QA-EXP cleanup: zero leftovers (" + CO + ")", left === 0 && !coLeft, "left=" + left + " company=" + coLeft);
    supabase.from = realFrom; supabase.rpc = realRpc;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
