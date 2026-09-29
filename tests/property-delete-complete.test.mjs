// Deleting a property stops everything that acts in the future; restoring it
// brings back exactly what the delete took.
//
// Audit theme L ("deleting is incomplete"). Deleting a property left its
// utility accounts + unpaid utility bills, property taxes + pending tax bills,
// licences and portfolio-loan links live, so the portal sweep and the
// tax-bill cron kept running for a property the app reports as gone.
// archive_property_cascade (migration 20260929010000) now archives all of it
// in one transaction, stamping every row with the property's own archived_at;
// restore_property_cascade brings back only rows carrying that stamp.
// Round 2 (20260929050000): journal entries are voided server-side in chunks
// and recorded, so restore re-posts exactly those; a locked period refuses the
// delete; rename no longer drags a deleted property's rows along; vendor/owner
// follow-triggers stand still during the cascade; restore skips (and names) a
// utility whose account is live elsewhere; management tier is one row.
//
// Part 1: static checks on the migration, Properties.js, Loans.js and the
//         three unattended jobs (tax-bill cron, licence reminders, sweep).
// Part 2: the cron/sweep "property archived?" helper, against a fake client.
// Part 3: LIVE on the TEST project: a throwaway company tagged QA-DEL gets a
//         fully populated property, which is deleted, checked table by table,
//         restored, checked again, and then removed without leftovers.
import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
require("./sandbox-env");   // TEST project only -- never production
const root = path.join(import.meta.dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     " + detail : "")); }
}
function fnBody(text, signature) {
  const i = text.indexOf(signature);
  if (i < 0) return "";
  const rest = text.slice(i + signature.length);
  const next = rest.search(/\n\s*(?:export\s+)?async function |\n\s*function /);
  return next < 0 ? rest : rest.slice(0, next);
}
const stripComments = (s) => s.replace(/^\s*--.*$/gm, "").replace(/\/\/.*$/gm, "");

// ─── 1. STATIC ────────────────────────────────────────────────────────────
console.log("\n📜 MIGRATION");
const mig = read("supabase/migrations/20260929100000_property_delete_complete.sql");
const sqlFn = (name) => {
  const i = mig.indexOf("FUNCTION public." + name + "(");
  const j = mig.indexOf("$function$;", i);
  return i < 0 ? "" : stripComments(mig.slice(i, j));
};
const arc = sqlFn("archive_property_cascade"), rst = sqlFn("restore_property_cascade");
assert("archive_property_cascade defined", arc.length > 0);
assert("restore_property_cascade defined", rst.length > 0);
for (const [n, f] of [["archive", arc], ["restore", rst]]) {
  assert(`${n}: SECURITY DEFINER with pinned search_path`, /SECURITY DEFINER\s+SET search_path TO 'public', 'pg_temp'/.test(f));
  assert(`${n}: company-staff check`, /_assert_company_staff\(p_company_id\)/.test(f));
  assert(`${n}: management-tier check (the gate trigger cannot see the caller in a definer)`, /is_management_tier\(p_company_id\)/.test(f));
}
assert("REVOKE ALL ... FROM PUBLIC, anon on both",
  /REVOKE ALL ON FUNCTION public\.archive_property_cascade\(text, bigint, text\) FROM PUBLIC, anon/.test(mig)
  && /REVOKE ALL ON FUNCTION public\.restore_property_cascade\(text, bigint, boolean\) FROM PUBLIC, anon/.test(mig));
const MUST_ARCHIVE = ["properties", "tenants", "leases", "autopay_schedules", "recurring_journal_entries", "work_orders",
  "vendor_invoices", "documents", "inspections", "payments", "hoa_payments", "property_loans", "property_insurance",
  "property_licenses", "property_taxes", "property_tax_bills", "utility_accounts", "utilities", "utility_bills",
  "portfolio_loan_properties", "property_setup_wizard"];
for (const t of MUST_ARCHIVE) {
  assert(`archive covers ${t}`, new RegExp("UPDATE " + t + "\\b").test(arc));
}
assert("every archive uses the one transaction stamp v_ts",
  !/archived_at = now\(\)/.test(arc) && (arc.match(/archived_at = v_ts/g) || []).length >= 19);
assert("utility bills: unpaid only (paid_at null, nothing paid, not paid/partial)",
  /UPDATE utility_bills[\s\S]*?paid_at IS NULL AND COALESCE\(b\.amount_paid, 0\) = 0[\s\S]*?NOT IN \('paid', 'partial', 'settled'\)/.test(arc));
assert("tax bills: pending only", /UPDATE property_tax_bills[^;]*status = 'pending' AND paid_date IS NULL/.test(arc));
assert("utility_accounts tagged archived_reason = 'property_deleted'", /UPDATE utility_accounts SET archived_at = v_ts, archived_reason = 'property_deleted'/.test(arc));
assert("utility_accounts archived BEFORE utilities (bridge trigger would stamp them reasonless)",
  arc.indexOf("UPDATE utility_accounts") < arc.indexOf("UPDATE utilities "));
assert("autopay disabled", /UPDATE autopay_schedules SET enabled = false/.test(arc));
assert("recurring entries inactivated", /UPDATE recurring_journal_entries SET status = 'inactive'/.test(arc));
assert("archive never touches the books or deposits",
  !/acct_journal|journal_lines|ledger_entries|deposit|forfeit|2100|4150/i.test(arc));
assert("address match falls back to id when another LIVE property shares the address",
  /v_use_addr := NOT EXISTS/.test(arc));
assert("restore only brings back rows stamped with the property's archived_at",
  (rst.match(/archived_at = v_ts/g) || []).length >= 18 && !/archived_at IS NOT NULL/.test(rst));
assert("restore of utility accounts requires archived_reason = 'property_deleted'",
  /UPDATE utility_accounts SET archived_at = NULL, archived_reason = NULL[\s\S]*?archived_reason = 'property_deleted'/.test(rst));
assert("restore never re-enables autopay or recurring charges",
  !/enabled = true/.test(rst) && !/status = 'active'[^;]*recurring/.test(rst) && !/UPDATE recurring_journal_entries SET[^;]*status/.test(rst));
assert("restore reactivates only leases of tenants it restored", /tenant_id = ANY \(v_tenant_ids\)/.test(rst));
assert("restore refuses when a live property already has the address", /A live property already has the address/.test(rst));
assert("portfolio_loan_properties gains archived_at", /ALTER TABLE public\.portfolio_loan_properties\s+ADD COLUMN IF NOT EXISTS archived_at timestamptz/.test(mig));

console.log("\n📜 ROUND 2 MIGRATION");
const mig2 = read("supabase/migrations/20260929110000_property_delete_round2.sql");
const fn2 = (name) => { const i = mig2.indexOf("FUNCTION public." + name + "("); const j = mig2.indexOf("$function$;", i); return i < 0 ? "" : stripComments(mig2.slice(i, j)); };
for (const f of ["property_delete_begin", "property_delete_void_chunk", "property_delete_unvoid_chunk", "archive_property_cascade", "property_restore_preview", "restore_property_cascade"]) {
  assert(`${f}: definer, pinned search_path, staff + tier check`, /SECURITY DEFINER\s+SET search_path TO 'public', 'pg_temp'/.test(fn2(f)) && /_assert_property_manager\(/.test(fn2(f)));
  assert(`${f}: EXECUTE revoked from PUBLIC, anon`, new RegExp("REVOKE ALL ON FUNCTION public\\." + f + "\\([^)]*\\) FROM PUBLIC, anon").test(mig2));
}
assert("_assert_property_manager = staff check AND management tier", /_assert_company_staff\(p_company_id\)[\s\S]*is_management_tier\(p_company_id\)/.test(fn2("_assert_property_manager")));
assert("archived_by is the caller's JWT email, not a parameter", !/p_user_email/.test(fn2("archive_property_cascade")) && /v_by := public\._assert_property_manager/.test(fn2("archive_property_cascade")));
assert("is_management_tier: one row, portal roles excluded, auth_user_id first",
  /cm\.role IN \('admin', 'pm', 'manager'\)/.test(fn2("is_management_tier")) && /cm\.auth_user_id = auth\.uid\(\)/.test(fn2("is_management_tier")));
assert("case-insensitive unique membership + live address indexes (created only when no duplicates)",
  /company_members_company_lower_email_unique[\s\S]*lower\(user_email\)/.test(mig2) && /idx_properties_unique_address_ci[\s\S]*lower\(btrim\(address\)\)/.test(mig2));
assert("begin refuses when an entry is in a locked period, and lists them", /locked accounting period[\s\S]*DETAIL = v_locked/.test(fn2("property_delete_begin")));
assert("void chunk records each voided entry before voiding it",
  fn2("property_delete_void_chunk").indexOf("INSERT INTO property_deletion_voids") < fn2("property_delete_void_chunk").indexOf("UPDATE acct_journal_entries SET status = 'voided'"));
assert("cascade flag set in void / un-void / archive / restore", ["property_delete_void_chunk", "property_delete_unvoid_chunk", "archive_property_cascade", "restore_property_cascade"].every(f => /set_config\('app\.property_cascade', 'on', true\)/.test(fn2(f))));
assert("VPAY, owner-accrual, balance and tenant-occupancy triggers honour the flag",
  ["_vpay_follow_void", "_owner_accrual_enqueue_entries", "trg_sync_balance_from_je_status", "trg_tenants_sync_property"].every(f => mig2.includes("to_regprocedure('public." + f + "()')")));
assert("each trigger patch is skipped when the function is not installed (production has no owner-accrual queue)",
  (mig2.match(/IF src IS NULL THEN\s+RAISE NOTICE/g) || []).length === 4 && !/::regprocedure;/.test(mig2.replace(/^\s*--.*$/gm, "")));
assert("migration does not recreate the old role gates", !/CREATE TRIGGER trg_mgmt_gate/.test(mig2) && !/trg_mgmt_gate_del/.test(mig2));
assert("void chunk follows the property's CURRENT address and locks the row (rename mid-delete)",
  /SELECT address INTO v_addr FROM properties[\s\S]*?FOR UPDATE[\s\S]*?UPDATE property_deletions SET address = v_addr/.test(fn2("property_delete_void_chunk")));
assert("cancelling a delete keeps locked-period entries pending instead of giving up on them",
  /IF v_del\.status = 'voiding' AND v_lock IS NOT NULL THEN[\s\S]*?v_blocked/.test(fn2("property_delete_unvoid_chunk")) && /'blocked_by_lock', v_blocked/.test(fn2("property_delete_unvoid_chunk")));
assert("restore does the property atomically and re-posts a large backlog afterwards (never raises on >300)",
  !/call property_delete_unvoid_chunk first/.test(fn2("restore_property_cascade")) && /'journal_entries_pending', v_left/.test(fn2("restore_property_cascade")));
assert("a tenant AR ledger with a posted balance stays active and is reported (never blocks the delete)",
  /ar_accounts_left_active/.test(fn2("archive_property_cascade")) && /<= 0\.005;/.test(fn2("archive_property_cascade")));
assert("un-void: no self-join of the voids table; the reference check carries the partial index's predicate (10-14s -> ms)",
  !/FROM property_deletion_voids v2/.test(fn2("property_delete_unvoid_chunk"))
  && /o\.status <> 'voided' AND o\.reference <> ''/.test(fn2("property_delete_unvoid_chunk")));
assert("owner-portal role gets no bookkeeping tier either (is_accounting_tier without 'owner')",
  /FUNCTION public\.is_accounting_tier[\s\S]*cm\.role IN \('admin','pm','manager','office_assistant','accountant'\)/.test(mig2));
assert("unfinished deletes/restores are listed by property_deletions_pending", /FUNCTION public\.property_deletions_pending\(/.test(mig2) && /REVOKE ALL ON FUNCTION public\.property_deletions_pending\(text\) FROM PUBLIC, anon/.test(mig2));
assert("un-void skips (and reports) locked / reference-clashing entries", /'locked period'/.test(fn2("property_delete_unvoid_chunk")) && /'reference now used by another live entry'/.test(fn2("property_delete_unvoid_chunk")));
assert("rename cascade skips rows stamped by a deletion at the old address", /archived_at <> ALL \(s\)/.test(fn2("_cascade_property_rename")) && /property_deletion_voids/.test(fn2("_cascade_property_rename")));
assert("auto_fill_property_id ignores archived properties", /AND archived_at IS NULL LIMIT 1/.test(fn2("auto_fill_property_id")));
assert("utility accounts matched by id, address OR legacy link", /a\.legacy_utility_id IN \(SELECT u\.id FROM utilities u/.test(fn2("archive_property_cascade")));
assert("second delete re-stamps rows left archived by an earlier restore", /v_prior := ARRAY\(SELECT stamp FROM property_deletions/.test(fn2("archive_property_cascade")));
assert("restore recomputes restored tenants' balances", /recompute_tenant_balance\(n\)/.test(fn2("restore_property_cascade")));
assert("restore leaves a clashing utility archived and names it", /utilities_left_archived/.test(fn2("restore_property_cascade")) && /NOT \(id = ANY \(v_skip_utils\)\)/.test(fn2("restore_property_cascade")));
assert("restore address refusal is case/space-insensitive", /lower\(btrim\(address\)\) = lower\(btrim\(v_addr\)\)/.test(fn2("restore_property_cascade")));
assert("(company_id, property) indexes on the child tables", (mig2.match(/_company_property\s+ON public\.\w+ \(company_id, property\)/g) || []).length >= 15);

console.log("\n🏠 Properties.js / Loans.js");
const props = read("src/components/Properties.js");
const del = fnBody(props, "async function deleteProperty(id, address) {");
assert("deleteProperty calls archive_property_cascade", /rpc\("archive_property_cascade"/.test(del));
assert("deleteProperty: begin (locked-period refusal) -> chunked server void -> archive, in that order",
  del.indexOf('rpc("property_delete_begin"') > 0
  && del.indexOf('rpc("property_delete_begin"') < del.indexOf('voidDeletion(deletionId)')
  && del.indexOf('voidDeletion(deletionId)') < del.indexOf('rpc("archive_property_cascade"'));
assert("deleteProperty never voids entries from the browser, never touches the ledger_entries view",
  !/update\(\{ status: "voided" \}\)/.test(del) && !/ledger_entries/.test(stripComments(del)));
assert("deleteProperty re-posts the voided entries when a later step fails",
  /if \(vres\.error\) \{[\s\S]*?unvoidDeletion\(deletionId\)[\s\S]*?return;/.test(del) && /if \(cascadeErr\) \{[\s\S]*?unvoidDeletion\(deletionId\)[\s\S]*?return;/.test(del));
assert("the chunk helpers stop when a locked period blocks progress (no spin)", /if \(!u\.unvoided\) return \{ error: null, remaining: u\.remaining, blocked:/.test(props));
assert("first chunk is small (50), then 200; a timeout halves the chunk and retries",
  /CHUNK_FIRST = 50, CHUNK_NEXT = 200/.test(props) && /isTimeout\(error\) && size > CHUNK_MIN/.test(props) && !/p_limit: 200/.test(props));
assert("banner counts the entries still voided (pending), not voided minus pending", /\$\{pd\.pending\} journal entr/.test(props) && !/pd\.voided - pd\.pending/.test(props));
const helpers = read("src/utils/helpers.js");
assert("owner-portal role hidden from destructive and bookkeeping buttons",
  /MANAGEMENT_ROLES = \["admin", "pm", "manager"\]/.test(helpers) && /ACCOUNTING_ROLES = \["admin", "pm", "manager", "office_assistant", "accountant"\]/.test(helpers));
assert("Properties page lists unfinished deletes/restores with Finish / Cancel", /rpc\("property_deletions_pending"/.test(props) && /"finish_delete"/.test(props) && /"cancel_delete"/.test(props) && /"finish_restore"/.test(props));
assert("deleteProperty shows the locked entries the server listed", /beginErr\.details/.test(del));
assert("archived_by is not sent by the client any more", !/p_user_email/.test(props));
assert("deleteProperty no longer archives operational tables row-by-row from the browser",
  !/from\("(utilities|work_orders|hoa_payments|property_loans|property_insurance|documents|inspections|payments|autopay_schedules|recurring_journal_entries|leases|tenants)"\)\.update\(/.test(stripComments(del)));
assert("deleteProperty posts nothing for deposits (owner decision)",
  !/atomicPostJEAndLedger|autoPostJournalEntry|4150|deposit_status/.test(stripComments(del)));
const res = fnBody(props, "async function restoreProperty(prop) {");
assert("restoreProperty calls restore_property_cascade", /rpc\("restore_property_cascade"/.test(res));
assert("restoreProperty asks the server what it will restore (preview) first", res.indexOf('rpc("property_restore_preview"') >= 0 && res.indexOf('rpc("property_restore_preview"') < res.indexOf('rpc("restore_property_cascade"'));
assert("restoreProperty restores FIRST, then re-posts any backlog (a failed restore never leaves live books on a deleted property)",
  res.indexOf('rpc("restore_property_cascade"') >= 0 && res.indexOf('rpc("restore_property_cascade"') < res.indexOf("unvoidDeletion(pv.deletion_id)"));
assert("old 'every archived tenant at the address' prompt only for legacy deletes", /if \(res\?\.legacy\) \{/.test(res));
assert("wizard's portfolio-link lookup ignores archived links",
  /from\("portfolio_loan_properties"\)\.select\("portfolio_loan_id"\)\s*\.eq\("company_id", companyId\)\.eq\("property", savedAddress\)\.is\("archived_at", null\)/.test(props));
const loans = read("src/components/Loans.js");
assert("Loans page lists only live portfolio links",
  /from\("portfolio_loan_properties"\)\.select\("\*"\)\.eq\("company_id", companyId\)\.is\("archived_at", null\)/.test(loans));
assert("Loans save replaces only LIVE links and revives on re-select",
  /portfolio_loan_properties"\)\.delete\(\)\.eq\("portfolio_loan_id", loanId\)\.eq\("company_id", companyId\)\.is\("archived_at", null\)/.test(loans)
  && /upsert\(links, \{ onConflict: "portfolio_loan_id,property" \}\)/.test(loans));

console.log("\n⏰ UNATTENDED JOBS skip archived properties");
const tax = read("api/_tax-bill-reminders-impl.js");
assert("tax cron loads the archive index", /require\("\.\/_archived-properties"\)/.test(tax) && /loadPropertyArchiveIndex\(supabase, bills\.map/.test(tax));
assert("tax cron skips a bill whose property is archived, first thing in the loop",
  /for \(const b of bills\) \{\s*if \(propIndex\.isArchived\(b\)\) \{ skippedPropertyArchived\+\+; continue; \}/.test(tax));
assert("tax rollforward still only generates for live properties",
  /from\("properties"\)[\s\S]{0,80}\.is\("archived_at", null\)/.test(tax));
const lic = read("api/_license-expiry-reminders-impl.js");
assert("licence reminders skip an archived property",
  /select\("address, archived_at"\)/.test(lic) && /if \(propertyAddress === null\) \{ skippedPropertyArchived\+\+; continue; \}/.test(lic));
const ai = read("api/ai.js");
const seg = (a, b) => ai.slice(ai.indexOf(a), ai.indexOf(b, ai.indexOf(a) + 1));
const st = seg('if (action === "sweep-targets")', 'if (action === "portal-credentials")');
const pc = seg('if (action === "portal-credentials")', 'if (action === "claim")');
assert("sweep-targets filters archived properties", /loadPropertyArchiveIndex\(sb, \[cid\]\)/.test(st) && /filter\(t => !propIndex\.isArchived\(t, cid\)\)/.test(st));
assert("portal-credentials filters archived properties", /loadPropertyArchiveIndex\(sb, \[cid\]\)/.test(pc) && /filter\(c => !propIndex\.isArchived\(c, cid\)\)/.test(pc));
assert("ai.js imports the helper", /const \{ loadPropertyArchiveIndex \} = require\("\.\/_archived-properties"\)/.test(ai));

// ─── 2. HELPER ────────────────────────────────────────────────────────────
console.log("\n🧮 loadPropertyArchiveIndex");
const { loadPropertyArchiveIndex, normAddress } = require("../api/_archived-properties.js");
assert("normAddress: case, spaces and commas do not matter",
  normAddress(" 1 Gone St,  Testville, MD ") === normAddress("1 gone st testville md") && normAddress(null) === "");
function fakeSb(rows, { error = null } = {}) {
  return { from() {
    const q = { _cids: null,
      select() { return q; }, order() { return q; },
      in(_c, v) { q._cids = v; return q; },
      range(a, b) {
        if (error) return Promise.resolve({ data: null, error });
        const d = rows.filter(r => q._cids.includes(r.company_id)).slice(a, b + 1);
        return Promise.resolve({ data: d, error: null });
      } };
    return q;
  } };
}
{
  const rows = [
    { id: 1, company_id: "A", address: "1 Gone St", archived_at: "2026-01-01" },
    { id: 2, company_id: "A", address: "2 Live St", archived_at: null },
    { id: 3, company_id: "A", address: "3 Reused St", archived_at: "2026-01-01" },
    { id: 4, company_id: "A", address: "3 Reused St", archived_at: null },
    { id: 5, company_id: "B", address: "1 Gone St", archived_at: null },
  ];
  const ix = await loadPropertyArchiveIndex(fakeSb(rows), ["A", "B"]);
  assert("ok on a good read", ix.ok === true);
  assert("record at an archived address -> archived", ix.isArchived({ company_id: "A", property: "1 Gone St" }));
  for (const v of ["1 gone st", "1 GONE ST", " 1 Gone St", "1 Gone St ", "1  Gone St"]) {
    assert(`address variant "${v}" -> archived`, ix.isArchived({ company_id: "A", property: v }));
  }
  assert("record at a live address -> live", !ix.isArchived({ company_id: "A", property: "2 Live St" }));
  assert("address re-used by a live property -> live (the re-added property keeps its reminders)",
    !ix.isArchived({ company_id: "A", property: "3 Reused St" }));
  assert("same address in ANOTHER company is not confused", !ix.isArchived({ company_id: "B", property: "1 Gone St" }));
  assert("property_id of an archived property, no address -> archived", ix.isArchived({ company_id: "A", property_id: 1 }));
  assert("companyId argument used when the record has none", ix.isArchived({ property: "1 Gone St" }, "A"));
  assert("unknown property -> not filtered", !ix.isArchived({ company_id: "A", property: "9 Nowhere" }));
  const many = Array.from({ length: 2500 }, (_, i) => ({ id: i + 10, company_id: "A", address: "p" + i, archived_at: i === 2400 ? "x" : null }));
  const ix2 = await loadPropertyArchiveIndex(fakeSb(many), ["A"]);
  assert("pages past 1000 rows", ix2.isArchived({ company_id: "A", property: "p2400" }) && !ix2.isArchived({ company_id: "A", property: "p5" }));
  const ix3 = await loadPropertyArchiveIndex(fakeSb(rows, { error: { message: "boom" } }), ["A"]);
  assert("read error -> filters nothing (second net must not silence the run)", ix3.ok === false && !ix3.isArchived({ company_id: "A", property: "1 Gone St" }));
}

// ─── 3. LIVE (TEST project) ───────────────────────────────────────────────
console.log("\n🧪 LIVE on TEST — throwaway company QA-DEL");
const url = process.env.TEST_SUPABASE_URL, key = process.env.TEST_SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.log("  (skipped: no TEST_SUPABASE_URL / TEST_SUPABASE_SERVICE_KEY)");
} else {
  const { createClient } = require("@supabase/supabase-js");
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const CID = "qa-del-" + Date.now().toString(36);
  // properties.address is DERIVED from its components by a trigger.
  const comp = (line1) => ({ address_line_1: line1, city: "Testville", state: "MD", zip: "20000" });
  let ADDR, OTHER;
  const must = async (label, p) => { const r = await p; if (r.error) throw new Error(label + ": " + r.error.message); return r.data; };
  const ids = {};
  try {
    await must("company", sb.from("companies").insert({ id: CID, name: "QA-DEL throwaway " + CID }));
    const [prop] = await must("property", sb.from("properties").insert([{ company_id: CID, ...comp("QA-DEL 1 Test St"), type: "Single Family", status: "occupied", county: "Montgomery" }]).select("id, address"));
    const [ctrl] = await must("control property", sb.from("properties").insert([{ company_id: CID, ...comp("QA-DEL 2 Control Ave"), type: "Single Family", status: "occupied" }]).select("id, address"));
    ADDR = prop.address; OTHER = ctrl.address;
    ids.prop = prop.id; ids.ctrl = ctrl.id;
    const P = { company_id: CID, property: ADDR };
    // A tenant who has moved out (live row, lease terminated earlier) and a current one.
    const [tMoved] = await must("moved-out tenant", sb.from("tenants").insert([{ ...P, name: "QA-DEL Moved Out", lease_status: "past", move_out: "2026-06-30" }]).select("id"));
    const [tCur] = await must("current tenant", sb.from("tenants").insert([{ ...P, name: "QA-DEL Current", lease_status: "active", balance: 100 }]).select("id"));
    await must("old lease", sb.from("leases").insert([{ ...P, tenant_id: tMoved.id, tenant_name: "QA-DEL Moved Out", status: "terminated", start_date: "2025-07-01", end_date: "2026-06-30", rent_amount: 1000 }]));
    await must("current lease", sb.from("leases").insert([{ ...P, tenant_id: tCur.id, tenant_name: "QA-DEL Current", status: "active", start_date: "2026-07-01", end_date: "2027-06-30", rent_amount: 1200 }]));
    await must("autopay", sb.from("autopay_schedules").insert([{ ...P, tenant: "QA-DEL Current", tenant_id: tCur.id, amount: 1200, enabled: true }]));
    await must("recurring", sb.from("recurring_journal_entries").insert([{ ...P, description: "Monthly rent QA-DEL", tenant_name: "QA-DEL Current", tenant_id: tCur.id, amount: 1200, status: "active" }]));
    const [util] = await must("utility", sb.from("utilities").insert([{ ...P, provider: "QA-DEL Power", amount: 80, status: "pending", account_number: "QA1" }]).select("id"));
    await must("standalone utility account", sb.from("utility_accounts").insert([{ ...P, provider: "QA-DEL Water", provider_display: "QA-DEL Water", account_number: "QA2" }]));
    const accts = await must("accounts", sb.from("utility_accounts").select("id, provider, legacy_utility_id").eq("company_id", CID));
    const acctId = accts[0].id;
    await must("bills", sb.from("utility_bills").insert([
      { ...P, utility_account_id: acctId, provider: "QA-DEL Power", amount: 80, status: "pending_review" },
      { ...P, utility_account_id: acctId, provider: "QA-DEL Power", amount: 75, status: "paid", paid_at: new Date().toISOString(), amount_paid: 75 },
    ]));
    await must("taxes", sb.from("property_taxes").insert([{ ...P, property_id: prop.id, county: "Montgomery", annual_tax_amount: 5000 }]));
    const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    await must("tax bills", sb.from("property_tax_bills").insert([
      { ...P, property_id: prop.id, tax_year: 2026, installment_label: "Annual (MD)", due_date: soon, status: "pending" },
      { ...P, property_id: prop.id, tax_year: 2025, installment_label: "Annual (MD)", due_date: "2025-09-30", status: "paid", paid_date: "2025-09-15", paid_amount: 5000 },
    ]));
    await must("hoa", sb.from("hoa_payments").insert([{ ...P, hoa_name: "QA-DEL HOA", amount: 50, status: "pending" }]));
    await must("insurance", sb.from("property_insurance").insert([{ ...P, property_id: String(prop.id), provider: "QA-DEL Ins" }]));
    await must("loan", sb.from("property_loans").insert([{ ...P, property_id: String(prop.id), lender_name: "QA-DEL Bank" }]));
    const [pl] = await must("portfolio loan", sb.from("portfolio_loans").insert([{ company_id: CID, lender_name: "QA-DEL Blanket" }]).select("id"));
    ids.pl = pl.id;
    await must("portfolio links", sb.from("portfolio_loan_properties").insert([
      { company_id: CID, portfolio_loan_id: pl.id, property: ADDR, property_id: prop.id },
      { company_id: CID, portfolio_loan_id: pl.id, property: OTHER, property_id: ctrl.id }]));
    await must("licence", sb.from("property_licenses").insert([{ company_id: CID, property_id: prop.id, license_type: "rental", expiry_date: soon }]));
    await must("work orders", sb.from("work_orders").insert([{ ...P, issue: "QA-DEL leak", status: "open" }]));
    // Archived SEPARATELY by the user, earlier: restore must NOT bring it back.
    await must("user-archived WO", sb.from("work_orders").insert([{ ...P, issue: "QA-DEL old user-archived", status: "closed", archived_at: "2026-01-01T00:00:00Z", archived_by: "user" }]));
    await must("control utility", sb.from("utilities").insert([{ company_id: CID, property: OTHER, provider: "QA-DEL Power", amount: 10, status: "pending" }]));

    const TABLES = [
      ["tenants", "property"], ["leases", "property"], ["autopay_schedules", "property"], ["recurring_journal_entries", "property"],
      ["utilities", "property"], ["utility_accounts", "property"], ["utility_bills", "property"], ["property_taxes", "property"],
      ["property_tax_bills", "property"], ["hoa_payments", "property"], ["property_insurance", "property"], ["property_loans", "property"],
      ["portfolio_loan_properties", "property"], ["work_orders", "property"],
    ];
    const snapshot = async () => {
      const out = {};
      for (const [t, col] of TABLES) {
        const rows = await must(t, sb.from(t).select("*").eq("company_id", CID).eq(col, ADDR));
        out[t] = { live: rows.filter(r => !r.archived_at).length, archived: rows.filter(r => r.archived_at).length, rows };
      }
      const lics = await must("lic", sb.from("property_licenses").select("*").eq("company_id", CID).eq("property_id", ids.prop));
      out.property_licenses = { live: lics.filter(r => !r.archived_at).length, archived: lics.filter(r => r.archived_at).length, rows: lics };
      return out;
    };
    const before = await snapshot();
    assert("setup: bridge created an account for the utility", before.utility_accounts.live === 2, JSON.stringify(before.utility_accounts.live));

    // anon cannot call it at all
    const anonKey = process.env.TEST_SUPABASE_ANON_KEY;
    if (anonKey) {
      const anon = createClient(url, anonKey, { auth: { persistSession: false } });
      const { error: aErr } = await anon.rpc("archive_property_cascade", { p_company_id: CID, p_property_id: ids.prop });
      assert("anon cannot execute archive_property_cascade", !!aErr, "no error");
      const { error: rErr } = await anon.rpc("restore_property_cascade", { p_company_id: CID, p_property_id: ids.prop, p_restore_tenants: true });
      assert("anon cannot execute restore_property_cascade", !!rErr, "no error");
    }

    // Books: a tenant AR account, rent entries, and a VPAY entry for a PAID vendor invoice.
    const [arAcct] = await must("ar acct", sb.from("acct_accounts").insert({ company_id: CID, code: "1100-QD", name: "AR - QA-DEL Current", type: "Asset", is_active: true, tenant_id: tCur.id, old_text_id: CID + "-1100-QD" }).select("id"));
    const [incAcct] = await must("income acct", sb.from("acct_accounts").insert({ company_id: CID, code: "4000", name: "Rental Income", type: "Revenue", is_active: true, old_text_id: CID + "-4000" }).select("id"));
    const [vendor] = await must("vendor", sb.from("vendors").insert({ company_id: CID, name: "QA-DEL Vendor", total_paid: 500, total_jobs: 1 }).select("id"));
    const [inv] = await must("invoice", sb.from("vendor_invoices").insert({ company_id: CID, vendor_id: vendor.id, vendor_name: "QA-DEL Vendor", property: ADDR, amount: 500, status: "paid", paid_date: "2026-02-15" }).select("id"));
    const jeRow = (n, ref, date) => ({ company_id: CID, number: CID + "-" + n, date, description: "qa-del " + n, reference: ref, property: ADDR, status: "posted" });
    const jes = await must("entries", sb.from("acct_journal_entries").insert([jeRow(1, "RENT-" + CID, "2026-02-01"), jeRow(2, "VPAY-" + inv.id, "2026-02-15"), jeRow(3, null, "2026-09-01")]).select("id"));
    await must("rent lines", sb.from("acct_journal_lines").insert([
      { journal_entry_id: jes[0].id, company_id: CID, account_id: arAcct.id, account_name: "AR - QA-DEL Current", debit: 1200, credit: 0 },
      { journal_entry_id: jes[0].id, company_id: CID, account_id: incAcct.id, account_name: "Rental Income", debit: 0, credit: 1200 }]));

    // ── LOCKED PERIOD: the delete is refused whole, and names the entries ──
    await must("lock", sb.from("accounting_period_lock").insert({ company_id: CID, lock_date: "2026-03-31", locked_by: "qa-del" }));
    const { error: lockErr } = await sb.rpc("archive_property_cascade", { p_company_id: CID, p_property_id: ids.prop });
    const [pLocked] = await must("prop", sb.from("properties").select("archived_at").eq("id", ids.prop));
    const stillPosted = await must("posted", sb.from("acct_journal_entries").select("id").eq("company_id", CID).eq("status", "posted"));
    assert("locked period: delete refused, property live, every entry still posted",
      !!lockErr && /locked accounting period/.test(lockErr.message) && !pLocked.archived_at && stillPosted.length === 3, lockErr?.message);
    assert("locked period: the refusal lists the locked entries", /qa-del 1/.test(lockErr?.details || "") && /qa-del 2/.test(lockErr?.details || ""), lockErr?.details);
    await must("unlock", sb.from("accounting_period_lock").delete().eq("company_id", CID));
    await sb.from("property_deletions").delete().eq("company_id", CID);

    // ── DELETE ──
    const out = await must("archive_property_cascade", sb.rpc("archive_property_cascade", { p_company_id: CID, p_property_id: ids.prop }));
    const after = await snapshot();
    console.log("     table                      live before → after   archived after");
    for (const k of Object.keys(after)) console.log("     " + k.padEnd(27) + String(before[k].live).padStart(4) + " → " + String(after[k].live).padEnd(8) + String(after[k].archived).padStart(6));
    const [pAfter] = await must("prop", sb.from("properties").select("archived_at").eq("id", ids.prop));
    const TS = pAfter.archived_at;
    assert("property archived", !!TS);
    const liveNow = (t) => after[t].live;
    for (const t of ["tenants", "leases", "autopay_schedules", "recurring_journal_entries", "utilities", "utility_accounts", "property_taxes",
                     "hoa_payments", "property_insurance", "property_loans", "portfolio_loan_properties", "work_orders", "property_licenses"]) {
      assert(`${t}: nothing live after delete`, liveNow(t) === 0, "live=" + liveNow(t));
    }
    assert("utility_bills: the PAID bill stays live (history), the unpaid one is archived",
      after.utility_bills.rows.find(b => b.status === "paid" && !b.archived_at) && after.utility_bills.rows.find(b => b.status === "pending_review" && b.archived_at));
    assert("tax bills: the PAID bill stays live (history), the pending one is archived",
      after.property_tax_bills.rows.find(b => b.status === "paid" && !b.archived_at) && after.property_tax_bills.rows.find(b => b.status === "pending" && b.archived_at));
    assert("utility accounts tagged property_deleted", after.utility_accounts.rows.every(a => a.archived_reason === "property_deleted"));
    assert("autopay disabled", after.autopay_schedules.rows.every(a => a.enabled === false));
    assert("recurring rent inactive", after.recurring_journal_entries.rows.every(r => r.status === "inactive"));
    assert("current lease terminated, moved-out lease untouched in status",
      after.leases.rows.find(l => l.tenant_id === tCur.id).status === "terminated" && after.leases.rows.find(l => l.tenant_id === tMoved.id).status === "terminated");
    const stamped = Object.values(after).flatMap(v => v.rows).filter(r => r.archived_at && r.issue !== "QA-DEL old user-archived");
    assert("every archived row carries the property's own archived_at", stamped.every(r => new Date(r.archived_at).getTime() === new Date(TS).getTime()),
      stamped.filter(r => new Date(r.archived_at).getTime() !== new Date(TS).getTime()).map(r => r.id).join(","));
    const ctrlUtil = await must("ctrl", sb.from("utilities").select("archived_at").eq("company_id", CID).eq("property", OTHER));
    const ctrlLink = await must("ctrl link", sb.from("portfolio_loan_properties").select("archived_at").eq("company_id", CID).eq("property", OTHER));
    assert("control property's utility + portfolio link untouched", ctrlUtil.every(u => !u.archived_at) && ctrlLink.every(u => !u.archived_at));
    assert("function reported counts", out?.archived?.utility_bills_pending === 1 && out?.archived?.property_tax_bills_pending === 1, JSON.stringify(out?.archived));
    const jeAfter = await must("je after", sb.from("acct_journal_entries").select("id, status").eq("company_id", CID));
    const voids = await must("voids", sb.from("property_deletion_voids").select("je_id").eq("deletion_id", out.deletion_id));
    assert("books: every entry of the property voided, and each one recorded", jeAfter.every(j => j.status === "voided") && voids.length === 3, JSON.stringify({ jeAfter, voids: voids.length }));
    const [invA] = await must("inv a", sb.from("vendor_invoices").select("status, archived_at").eq("id", inv.id));
    const [venA] = await must("ven a", sb.from("vendors").select("total_paid, total_jobs").eq("id", vendor.id));
    assert("VPAY void during the delete does NOT reopen the paid invoice or drop vendor totals",
      invA.status === "paid" && !!invA.archived_at && Number(venA.total_paid) === 500 && venA.total_jobs === 1, JSON.stringify({ invA, venA }));
    const [arA] = await must("ar a", sb.from("acct_accounts").select("is_active").eq("id", arAcct.id));
    assert("tenant AR account deactivated by the delete", arA.is_active === false);
    const [delRow] = await must("deletion row", sb.from("property_deletions").select("status, stamp, created_by").eq("id", out.deletion_id));
    assert("deletion logged with the property's stamp", delRow.status === "archived" && new Date(delRow.stamp).getTime() === new Date(TS).getTime());

    // What the unattended jobs see now:
    const lookback = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const lookahead = new Date(Date.now() + 31 * 86400000).toISOString().slice(0, 10);
    const cronBills = await must("cron query", sb.from("property_tax_bills").select("id").eq("company_id", CID).is("archived_at", null).eq("status", "pending").gte("due_date", lookback).lte("due_date", lookahead));
    assert("tax cron query finds nothing for the deleted property", cronBills.length === 0, cronBills.length + " rows");
    const lics = await must("licence query", sb.from("property_licenses").select("id").eq("company_id", CID).is("archived_at", null));
    assert("licence cron query finds nothing", lics.length === 0);
    const targets = await must("sweep-targets query", sb.from("utilities").select("id, property").eq("company_id", CID).is("archived_at", null).eq("property", ADDR));
    assert("sweep-targets query finds nothing for the deleted property", targets.length === 0);
    // Second net: a row written AFTER the delete is still filtered by the jobs.
    await must("stray bill", sb.from("property_tax_bills").insert([{ ...P, property_id: ids.prop, tax_year: 2027, installment_label: "stray", due_date: soon, status: "pending" }]));
    const ix = await loadPropertyArchiveIndex(sb, [CID]);
    const stray = await must("stray", sb.from("property_tax_bills").select("id, company_id, property, property_id").eq("company_id", CID).eq("installment_label", "stray"));
    assert("second net: a live bill under the deleted property is skipped by the cron filter", ix.ok && stray.length === 1 && ix.isArchived(stray[0]));
    assert("second net: the control property is not filtered", !ix.isArchived({ company_id: CID, property: OTHER }));
    await must("drop stray", sb.from("property_tax_bills").delete().eq("company_id", CID).eq("installment_label", "stray"));

    // ── round 3: rename mid-delete, lock mid-delete + cancel, AR with a stray balance ──
    {
      const [p3] = await must("p3", sb.from("properties").insert([{ company_id: CID, ...comp("QA-DEL 4 Midway Ln"), type: "Single Family" }]).select("id, address"));
      ids.p3 = p3.id;
      const [t3] = await must("t3", sb.from("tenants").insert([{ company_id: CID, property: p3.address, name: "QA-DEL Midway", lease_status: "active" }]).select("id"));
      const [ar3] = await must("ar3", sb.from("acct_accounts").insert({ company_id: CID, code: "1100-QM", name: "AR - QA-DEL Midway", type: "Asset", is_active: true, tenant_id: t3.id, old_text_id: CID + "-1100-QM" }).select("id"));
      const e3 = await must("e3", sb.from("acct_journal_entries").insert([
        { company_id: CID, number: CID + "-m1", date: "2026-02-01", description: "mid 1", property: p3.address, status: "posted" },
        { company_id: CID, number: CID + "-m2", date: "2026-09-01", description: "mid 2", property: p3.address, status: "posted" },
        // NOT tagged to the property: its AR balance survives the property's voids
        { company_id: CID, number: CID + "-m3", date: "2026-09-02", description: "untagged", property: null, status: "posted" }]).select("id"));
      await must("e3 lines", sb.from("acct_journal_lines").insert([
        { journal_entry_id: e3[2].id, company_id: CID, account_id: ar3.id, account_name: "AR - QA-DEL Midway", debit: 40, credit: 0 },
        { journal_entry_id: e3[2].id, company_id: CID, account_id: incAcct.id, account_name: "Rental Income", debit: 0, credit: 40 }]));
      // lock mid-delete, then cancel
      const b3 = await must("begin3", sb.rpc("property_delete_begin", { p_company_id: CID, p_property_id: p3.id }));
      await must("void3", sb.rpc("property_delete_void_chunk", { p_deletion_id: b3.deletion_id, p_limit: 200 }));
      await must("lock3", sb.from("accounting_period_lock").insert({ company_id: CID, lock_date: "2026-03-31", locked_by: "qa-del" }));
      const u1 = await must("cancel3", sb.rpc("property_delete_unvoid_chunk", { p_deletion_id: b3.deletion_id, p_limit: 200 }));
      const [d3a] = await must("d3a", sb.from("property_deletions").select("status").eq("id", b3.deletion_id));
      const pend = await must("pending", sb.rpc("property_deletions_pending", { p_company_id: CID }));
      assert("lock set mid-delete: cancel re-posts what it can, keeps the locked entry pending, reports it",
        u1.unvoided === 1 && u1.remaining === 1 && (u1.blocked_by_lock || []).length === 1 && d3a.status === "voiding", JSON.stringify(u1));
      assert("…and the unfinished delete is listed for the Properties banner",
        pend.some(x => x.deletion_id === b3.deletion_id && x.kind === "delete" && x.pending === 1), JSON.stringify(pend));
      await must("unlock3", sb.from("accounting_period_lock").delete().eq("company_id", CID));
      const u2 = await must("cancel3b", sb.rpc("property_delete_unvoid_chunk", { p_deletion_id: b3.deletion_id, p_limit: 200 }));
      const [d3b] = await must("d3b", sb.from("property_deletions").select("status").eq("id", b3.deletion_id));
      const posted3 = await must("posted3", sb.from("acct_journal_entries").select("id").eq("company_id", CID).eq("property", p3.address).eq("status", "posted"));
      assert("after unlocking, cancel finishes: every entry posted again, delete marked aborted", u2.remaining === 0 && d3b.status === "aborted" && posted3.length === 2, JSON.stringify(u2));
      // rename mid-delete: begin, rename, void, archive
      const b4 = await must("begin4", sb.rpc("property_delete_begin", { p_company_id: CID, p_property_id: p3.id }));
      await must("rename4", sb.from("properties").update({ address_line_1: "QA-DEL 5 Moved Ln" }).eq("id", p3.id));
      const [p3n] = await must("p3n", sb.from("properties").select("address").eq("id", p3.id));
      await must("cascade4", sb.rpc("_cascade_property_rename", { p_company_id: CID, p_old: p3.address, p_new: p3n.address }));
      await must("void4", sb.rpc("property_delete_void_chunk", { p_deletion_id: b4.deletion_id, p_limit: 200 }));
      const a4 = await must("arch4", sb.rpc("archive_property_cascade", { p_company_id: CID, p_property_id: p3.id, p_deletion_id: b4.deletion_id }));
      const [d4] = await must("d4", sb.from("property_deletions").select("status, address").eq("id", b4.deletion_id));
      const live4 = await must("live4", sb.from("acct_journal_entries").select("id").eq("company_id", CID).eq("property", p3n.address).neq("status", "voided"));
      assert("rename mid-delete: the void follows the new address, the archive completes, nothing left posted",
        d4.status === "archived" && d4.address === p3n.address && live4.length === 0 && a4.archived.journal_entries_voided === 2, JSON.stringify({ d4, live: live4.length, a: a4.archived.journal_entries_voided }));
      const [ar3a] = await must("ar3a", sb.from("acct_accounts").select("is_active").eq("id", ar3.id));
      assert("a tenant AR ledger holding an untagged balance does not block the delete: it stays active and is reported",
        ar3a.is_active === true && (a4.archived.ar_accounts_left_active || []).length === 1, JSON.stringify(a4.archived.ar_accounts_left_active));
    }

    // ── RESTORE ──
    const rOut = await must("restore_property_cascade", sb.rpc("restore_property_cascade", { p_company_id: CID, p_property_id: ids.prop, p_restore_tenants: true }));
    const back = await snapshot();
    console.log("     table                      live after restore");
    for (const k of Object.keys(back)) console.log("     " + k.padEnd(27) + String(back[k].live).padStart(4));
    for (const t of ["utilities", "utility_accounts", "property_taxes", "hoa_payments", "property_insurance", "property_loans",
                     "portfolio_loan_properties", "property_licenses", "leases", "autopay_schedules", "recurring_journal_entries"]) {
      assert(`${t}: back to its live count`, back[t].live === before[t].live, `${back[t].live} vs ${before[t].live}`);
    }
    assert("utility bills + tax bills all live again", back.utility_bills.live === 2 && back.property_tax_bills.live === 2);
    assert("utility accounts' archived_reason cleared", back.utility_accounts.rows.every(a => a.archived_reason == null));
    assert("user-archived work order stays archived; the other comes back",
      back.work_orders.rows.find(w => w.issue === "QA-DEL old user-archived").archived_at && !back.work_orders.rows.find(w => w.issue === "QA-DEL leak").archived_at);
    assert("both tenants back", back.tenants.live === 2);
    assert("current tenant active again; moved-out tenant stays past",
      back.tenants.rows.find(t => t.id === tCur.id).lease_status === "active" && back.tenants.rows.find(t => t.id === tMoved.id).lease_status === "past");
    assert("current lease active again; the old terminated lease stays terminated",
      back.leases.rows.find(l => l.tenant_id === tCur.id).status === "active" && back.leases.rows.find(l => l.tenant_id === tMoved.id).status === "terminated");
    assert("autopay comes back PAUSED", back.autopay_schedules.rows.every(a => a.enabled === false));
    assert("recurring rent comes back PAUSED", back.recurring_journal_entries.rows.every(r => r.status === "inactive"));
    const [pBack] = await must("prop", sb.from("properties").select("archived_at").eq("id", ids.prop));
    assert("property live again", pBack.archived_at === null, JSON.stringify(rOut));
    const jeBack = await must("je back", sb.from("acct_journal_entries").select("status").eq("company_id", CID).in("id", jes.map(j => j.id)));
    assert("restore re-posts exactly the entries the delete voided", jeBack.length === 3 && jeBack.every(j => j.status === "posted"));
    const [invB] = await must("inv b", sb.from("vendor_invoices").select("status, archived_at").eq("id", inv.id));
    assert("invoice back, still paid (consistent with its re-posted VPAY entry)", invB.status === "paid" && !invB.archived_at);
    const [tBal] = await must("bal", sb.from("tenants").select("balance").eq("id", tCur.id));
    const [arB] = await must("ar b", sb.from("acct_accounts").select("is_active").eq("id", arAcct.id));
    assert("restored tenant's balance recomputed from the ledger (not left NULL)", Number(tBal.balance) === 1200, JSON.stringify(tBal));
    assert("restored tenant's AR account active again", arB.is_active === true);

    // ── restore WITHOUT tenants, delete again, restore WITH tenants ──
    await must("del2", sb.rpc("archive_property_cascade", { p_company_id: CID, p_property_id: ids.prop }));
    await must("restore no tenants", sb.rpc("restore_property_cascade", { p_company_id: CID, p_property_id: ids.prop, p_restore_tenants: false }));
    await must("del3", sb.rpc("archive_property_cascade", { p_company_id: CID, p_property_id: ids.prop }));
    const pv = await must("preview", sb.rpc("property_restore_preview", { p_company_id: CID, p_property_id: ids.prop }));
    assert("second delete re-stamps the tenants a restore left behind (preview offers them)", (pv.tenants || []).length === 2, JSON.stringify(pv.tenants));
    await must("restore tenants", sb.rpc("restore_property_cascade", { p_company_id: CID, p_property_id: ids.prop, p_restore_tenants: true }));
    const tLive = await must("tlive", sb.from("tenants").select("id").eq("company_id", CID).eq("property", ADDR).is("archived_at", null));
    assert("…and the tenants come back", tLive.length === 2);

    // Restore refuses when the address has been re-used by a live property.
    await must("re-delete", sb.rpc("archive_property_cascade", { p_company_id: CID, p_property_id: ids.prop }));
    const [dup] = await must("dup", sb.from("properties").insert([{ company_id: CID, ...comp("QA-DEL 1 Test St"), type: "Single Family" }]).select("id, address"));
    ids.dup = dup.id;
    const { error: dupErr } = await sb.rpc("restore_property_cascade", { p_company_id: CID, p_property_id: ids.prop, p_restore_tenants: false });
    assert("restore refuses while a live property has the same address", !!dupErr && /already has the address/.test(dupErr.message), dupErr?.message);

    // ── rename of the re-added property must not take the deleted one's rows ──
    // rename_property_from_components needs a signed-in admin, so as the
    // service key run its two steps: re-address the property, then the cascade.
    await must("rename prop", sb.from("properties").update({ address_line_1: "QA-DEL 3 Renamed Rd" }).eq("id", dup.id));
    const [renamed] = await must("renamed", sb.from("properties").select("address").eq("id", dup.id));
    await must("cascade", sb.rpc("_cascade_property_rename", { p_company_id: CID, p_old: ADDR, p_new: renamed.address }));
    const [uAfterRename] = await must("u rename", sb.from("utilities").select("property").eq("id", util.id));
    const tRename = await must("t rename", sb.from("tenants").select("property").eq("company_id", CID).eq("id", tCur.id));
    const jeRename = await must("je rename", sb.from("acct_journal_entries").select("property").eq("company_id", CID).in("id", jes.map(j => j.id)));
    assert("rename leaves the deleted property's utility, tenant and voided entries at its own address",
      renamed.address !== ADDR && uAfterRename.property === ADDR && tRename[0].property === ADDR && jeRename.every(j => j.property === ADDR),
      JSON.stringify({ renamed: renamed.address, u: uAfterRename, t: tRename, je: jeRename }));

    // ── utility re-added at another property: restore skips it and names it ──
    await must("move dup away", sb.from("properties").update({ archived_at: new Date().toISOString() }).eq("id", dup.id));
    await must("clash utility", sb.from("utilities").insert([{ company_id: CID, property: OTHER, provider: "QA-DEL Power", amount: 80, status: "pending", account_number: "QA1" }]));
    const pv2 = await must("preview2", sb.rpc("property_restore_preview", { p_company_id: CID, p_property_id: ids.prop }));
    assert("preview names the utility that will stay archived", (pv2.utility_clashes || []).length === 1, JSON.stringify(pv2.utility_clashes));
    const { data: r3, error: r3Err } = await sb.rpc("restore_property_cascade", { p_company_id: CID, p_property_id: ids.prop, p_restore_tenants: true });
    const [u3] = await must("u3", sb.from("utilities").select("archived_at").eq("id", util.id));
    assert("restore succeeds, leaving the clashing utility archived and reported",
      !r3Err && (r3?.restored?.utilities_left_archived || []).length === 1 && !!u3.archived_at, r3Err?.message || JSON.stringify(r3?.restored?.utilities_left_archived));
  } catch (e) {
    fail++; console.log("  ❌ live run aborted: " + e.message);
  } finally {
    // Zero leftovers. Throwaway TEST rows only, all scoped to CID.
    await sb.from("companies").update({ archived_at: new Date().toISOString() }).eq("id", CID);
    const T = ["property_deletions", "tenant_invite_codes", "utility_bills", "utility_payments", "utility_accounts", "utilities", "property_tax_bills", "property_taxes", "hoa_payments",
      "property_insurance", "property_loans", "portfolio_loan_properties", "portfolio_loans", "property_licenses", "work_orders",
      "recurring_journal_entries", "autopay_schedules", "leases", "acct_journal_lines", "acct_journal_entries", "owner_accrual_queue",
      "vendor_invoices", "vendors", "accounting_period_lock", "acct_accounts", "acct_classes",
      "tenants", "documents", "payments", "property_setup_wizard",
      "property_owner_history", "notification_queue", "properties", "companies",
      // LAST: the audit triggers write a row for every delete above.
      "audit_trail"];
    const left = [];
    for (const t of T) {
      const col = t === "companies" ? "id" : "company_id";
      const { error } = await sb.from(t).delete().eq(col, CID);
      if (error && !/does not exist|column/.test(error.message)) left.push(t + ": " + error.message);
      const { count } = await sb.from(t).select("*", { count: "exact", head: true }).eq(col, CID);
      if (count) left.push(t + ": " + count + " left");
    }
    assert("cleanup: zero QA-DEL rows left", left.length === 0, left.join("; "));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
