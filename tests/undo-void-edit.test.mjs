// Undo / match / exclude / journal-entry edit -- audit theme G.
//
//  G1  Undo on a MATCHED bank txn voided the pre-existing entry it was
//      matched to (a tenant payment). Now it only unlinks.
//  G2  Undo carried on after a failed void (period lock, trg_mgmt_gate).
//      Now one transaction: undo_bank_transaction. Client period-lock check
//      matched to the DB (<= lock_date, inclusive).
//  G3  (not changed -- owner decision: voiding leaves payments / bills /
//      distributions / deposits as they are.)
//  G4a Editing a JE was header-update + delete-lines + insert-lines, not
//      atomic. Now update_journal_entry.
//  G4b The edit wiped bank_feed_transaction_id / reconciled /
//      reconciled_date. Now kept lines are updated in place; a reconciled
//      line can't change or go; system-generated entries warn first.
//  G5a confirmMatch was 3 writes, no for_review lock, no period lock, and
//      accepted any entry whose debits summed to the amount. Now
//      match_bank_transaction.
//  G5b bulkAmend rewrote the category leg of MATCHED entries (someone
//      else's record). Now skipped.
//  G6  excludeTransaction: for_review check, error check, decision id.
//      Now exclude_bank_transaction.
//
// QA follow-ups (20260928160000 + 110000 revised in place):
//  QA1 a stale matched_to link made Undo skip the void of a later BANK-
//      posting. Undo now tests "created by Banking" first (reference ==
//      BANK-/XFER-/SPLIT-<this txn>); Void goes through void_journal_entry,
//      which deletes the link and undoes the decision.
//  QA2 a bank-stamped line can't change account/amount; posted -> draft
//      refused with stamped or reconciled lines.
//  QA3 a reference can't be changed INTO a system one.
//  QA4 trg_jl_scope_guard: a line's account/class/entry are its company's.
//  QA5 the editor sends the line ids it loaded; the server refuses a mismatch.
//  QA6 exact cents, no negatives, no all-zero entry; undo drops the
//      created_from link of the entry it voided.
//
// Part 1: static checks on the client and the migration.
// Part 2: live checks against the TEST project with tagged throwaway rows
//         (service key), deleted at the end. Role / period-lock /
//         management-gate behaviour needs `SET ROLE authenticated` and was
//         verified with rolled-back SQL blocks (see the commit message);
//         the service role skips the staff and management checks by design.
import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
require("./sandbox-env.js");
const { createClient } = require("@supabase/supabase-js");

const root = path.join(import.meta.dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     " + detail : "")); }
}
function fnBody(src, name) {
  const i = src.indexOf(`async function ${name}(`);
  if (i < 0) return "";
  const j = src.indexOf("\n  async function ", i + 10);
  return src.slice(i, j < 0 ? undefined : j);
}
const sqlFn = (sql, name) => {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$([\\s\\S]*?)\\$function\\$`).exec(sql);
  return m ? m[1] : "";
};

// ─── Part 1: static ─────────────────────────────────────────────────────
console.log("\n🧾 STATIC");
const banking = read("src/components/Banking.js");
const acct = read("src/components/Accounting.js");
const acctUtil = read("src/utils/accounting.js");
const SQL = read("supabase/migrations/20260928110000_bank_undo_match_edit_atomic.sql");

const undo = fnBody(banking, "undoTransaction");
assert("G1/G2 undo goes through undo_bank_transaction", /supabase\.rpc\("undo_bank_transaction"/.test(undo));
assert("G1 undo no longer voids from the client", !/update\(\{ status: "voided" \}\)/.test(undo) && !/from\("acct_journal_entries"\)/.test(undo));
assert("G2 undo stops on an RPC error", /if \(error\) \{ reportBankRpcError\(error, "undo_bank_transaction"\); return; \}/.test(undo));
assert("G1 matched undo is described as an unmatch, not a void", /stays posted/.test(undo));

const undoSql = sqlFn(SQL, "undo_bank_transaction");
assert("G1 SQL: matched -> 'unmatched' branch", /v_mode := 'unmatched'/.test(undoSql));
assert("G1 SQL: only an entry referenced exactly BANK-/XFER-/SPLIT-<THIS txn id> is voided",
  /v_je\.reference IN \('BANK-' \|\| p_txn_id::text, 'XFER-' \|\| p_txn_id::text, 'SPLIT-' \|\| p_txn_id::text\)/.test(undoSql) && /v_mode := 'voided'/.test(undoSql)
  && !/v_je\.reference ~ '\^\(BANK/.test(undoSql));
{
  // QA #1: "created by Banking" is decided BEFORE "matched", and a
  // matched_to link only counts when it names the txn's own entry.
  const iVoid = undoSql.indexOf("v_mode := 'voided'"), iUnm = undoSql.indexOf("v_mode := 'unmatched'");
  assert("QA1 SQL: the created-by-Banking test comes before the matched test", iVoid > 0 && iUnm > iVoid);
  const matchedCond = undoSql.slice(undoSql.lastIndexOf("ELSIF", iUnm), iUnm);
  assert("QA1 SQL: matched = status 'matched' or a matched_to link to THIS entry (matched_target_id alone no longer counts)",
    /v_txn\.status = 'matched'/.test(matchedCond) && /linked_object_id::text = v_je_id/.test(matchedCond) && !/matched_target_id/.test(matchedCond));
  assert("QA1/6 SQL: undo deletes every matched_to link and created_from links to voided entries",
    /k\.link_role = 'matched_to'[\s\S]*k\.link_role = 'created_from'[\s\S]*e\.status <> 'voided'/.test(undoSql));
}
assert("G1 SQL: the void happens only in the 'voided' branch",
  (undoSql.match(/SET status = 'voided'/g) || []).length === 1 && /IF v_mode = 'voided' THEN[\s\S]*SET status = 'voided'/.test(undoSql));
assert("G1 SQL: unmatch deletes the matched_to link", /DELETE FROM bank_feed_transaction_link[\s\S]*link_role = 'matched_to'/.test(undoSql));
assert("G1 SQL: releases only THIS txn's stamps", /bank_feed_transaction_id = p_txn_id/.test(undoSql));
assert("G2 SQL: locks the txn row", /FOR UPDATE/.test(undoSql));
assert("G2 SQL: period lock is inclusive", /v_txn\.posted_date <= v_lock/.test(undoSql));
assert("G2 SQL: void row count checked", /could not void entry/.test(undoSql));
assert("G2 SQL: refuses to void an entry with reconciled lines", /HINT = 'reconciled'/.test(undoSql));
assert("G2 client checkPeriodLock is inclusive like the DB trigger",
  /String\(date\)\.slice\(0, 10\) <= String\(data\.lock_date\)\.slice\(0, 10\)/.test(acctUtil) && !/date < data\.lock_date/.test(acctUtil));

for (const fn of ["undo_bank_transaction", "exclude_bank_transaction", "match_bank_transaction", "update_journal_entry"]) {
  const body = sqlFn(SQL, fn);
  const decl = new RegExp(`FUNCTION public\\.${fn}\\([\\s\\S]*?AS \\$function\\$`).exec(SQL)?.[0] || "";
  assert(`${fn}: SECURITY INVOKER`, /SECURITY INVOKER/.test(decl) && !/SECURITY DEFINER/.test(decl));
  assert(`${fn}: requires staff`, /PERFORM public\._bank_require_staff\(p_company_id\)/.test(body));
  assert(`${fn}: not executable by anon`, new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon`).test(SQL));
  assert(`${fn}: granted to authenticated`, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO authenticated, service_role`).test(SQL));
}
assert("G3 untouched: migration does not write payments / bills / distributions / deposits",
  !/UPDATE (payments|vendor_invoices|owner_distributions|security_deposits)/i.test(SQL));

const upd = fnBody(acct, "updateJournalEntry");
assert("G4a edit goes through update_journal_entry", /supabase\.rpc\("update_journal_entry"/.test(upd));
assert("G4a edit no longer deletes/re-inserts lines from the client",
  !/from\("acct_journal_lines"\)\.delete/.test(upd) && !/from\("acct_journal_lines"\)\.insert/.test(upd) && !/from\("acct_journal_entries"\)\.update/.test(upd));
assert("G4b edit sends each line's id", /id: l\.id != null/.test(upd));
assert("G4b edit never sends stamps", !/bank_feed_transaction_id:|reconciled:/.test(upd));
assert("G4b system-generated entries require confirmation", /isRecordLinkedReference\(ref\)/.test(upd) && /confirmText: "Edit anyway"/.test(upd));
assert("G4b edit refuses when the entry has lines the editor never saw", /didn't fully load/.test(upd));
assert("G4b Ctrl+D copy drops the source line's id and stamps",
  /delete coding\.id; delete coding\.bank_feed_transaction_id; delete coding\.reconciled; delete coding\.reconciled_date;/.test(acct));
const updSql = sqlFn(SQL, "update_journal_entry");
assert("QA6 SQL: amounts rounded to cents, then DR = CR exactly (no tolerance)",
  /round\(COALESCE\(NULLIF\(l ->> 'debit', ''\)::numeric, 0\), 2\)/.test(updSql) && /IF v_dr <> v_cr THEN/.test(updSql) && !/0\.005/.test(updSql));
assert("QA6 SQL: negative amounts and all-zero entries refused", /HINT = 'negative_amount'/.test(updSql) && /HINT = 'zero_entry'/.test(updSql));
assert("QA5 SQL: expected line ids required and compared both ways", /p_expected_line_ids IS NULL/.test(updSql)
  && /EXCEPT SELECT unnest\(p_expected_line_ids\)/.test(updSql) && /SELECT unnest\(p_expected_line_ids\)\s+EXCEPT SELECT id/.test(updSql) && /HINT = 'stale_lines'/.test(updSql));
assert("QA5 SQL: the 4-argument update_journal_entry (no line check) is dropped", /DROP FUNCTION IF EXISTS public\.update_journal_entry\(text, text, jsonb, jsonb\);/.test(SQL));
assert("QA2 SQL: a bank-stamped kept line can't change account or amount", /IF v_old\.bank_feed_transaction_id IS NOT NULL THEN[\s\S]{0,300}account and amount cannot change/.test(updSql));
assert("QA2 SQL: posted -> draft refused with stamped or reconciled lines", /v_je\.status = 'posted' AND v_status = 'draft'/.test(updSql) && /HINT = 'posted_to_draft'/.test(updSql));
assert("QA3 SQL: an ordinary reference can't be changed INTO a system one", /je_reference_is_system\(v_new_ref\)/.test(updSql));
assert("QA5 client: sends the ids the editor loaded", /p_expected_line_ids: expectedLineIds/.test(upd));
assert("QA5 client: the pre-check pages past 1000 lines", /\.range\(from, from \+ 999\)/.test(upd));
assert("QA6 client: rounds changed amounts to cents, keeps unchanged kept amounts as stored", /const toCents = /.test(upd) && /const amountsOf = /.test(upd) && /debit: amounts\[i\]\.debit, credit: amounts\[i\]\.credit/.test(upd));
assert("R2-4 client: sends the entry as loaded (p_expected) and explains stale_entry", /p_expected: \{/.test(upd) && /error\.hint === "stale_entry"/.test(upd) && /changed since you opened it/.test(upd));
assert("R2-4 SQL: optimistic concurrency on header + lines (stale_entry)", /p_expected IS NULL/.test(updSql) && /HINT = 'stale_entry'/.test(updSql) && /COALESCE\(e ->> 'memo', ''\)/.test(updSql));
assert("R2-1 SQL: non-finite amounts and two-sided lines refused", /je_amount_is_finite/.test(updSql) && /HINT = 'bad_amount'/.test(updSql) && /HINT = 'both_sides'/.test(updSql));
assert("R2-5 SQL: an unchanged kept line keeps its stored (legacy) amount", /CASE WHEN o\.id IS NOT NULL THEN COALESCE\(o\.debit, 0\)/.test(updSql));
assert("client shows the new refusals as plain messages", ["stale_lines", "negative_amount", "zero_entry", "posted_to_draft", "cross_company"].every(h => upd.includes(`"${h}"`)));

// QA1: Void in Accounting goes through one RPC that also drops links/decisions.
const QA = read("supabase/migrations/20260928160000_bank_undo_qa_fixes.sql");
const voidSql = sqlFn(QA, "void_journal_entry");
const voidJs = fnBody(acct, "voidJournalEntry");
assert("QA1 client: void goes through void_journal_entry", /supabase\.rpc\("void_journal_entry"/.test(voidJs)
  && !/from\("acct_journal_entries"\)\.update\(\{ status: "voided" \}\)/.test(voidJs) && !/from\("bank_feed_transaction"\)\.update/.test(voidJs));
assert("QA1 SQL: void deletes the links, marks decisions undone, returns txns to For Review",
  /DELETE FROM bank_feed_transaction_link/.test(voidSql) && /SET status = 'undone'/.test(voidSql) && /SET status = 'for_review'/.test(voidSql) && /FOR UPDATE/.test(voidSql));
{
  const decl = /FUNCTION public\.void_journal_entry\([\s\S]*?AS \$function\$/.exec(QA)?.[0] || "";
  assert("QA1 SQL: void_journal_entry is SECURITY INVOKER, staff-only, not anon",
    /SECURITY INVOKER/.test(decl) && /PERFORM public\._bank_require_staff\(p_company_id\)/.test(voidSql)
    && /REVOKE ALL ON FUNCTION public\.void_journal_entry\(text, text\) FROM PUBLIC, anon/.test(QA));
}
assert("QA1 migration: one-time stale matched_to cleanup is scoped to links whose txn no longer points at them",
  /DELETE FROM bank_feed_transaction_link k[\s\S]*link_role = 'matched_to'[\s\S]*NOT \(t\.status IN \('matched', 'locked'\) AND t\.journal_entry_id IS NOT DISTINCT FROM k\.linked_object_id\)/.test(QA));
{
  const pbt = sqlFn(QA, "post_bank_transaction");
  assert("R2-1 SQL: post_bank_transaction refuses non-finite and two-sided lines", /je_amount_is_finite/.test(pbt) && /HINT = 'bad_amount'/.test(pbt) && /HINT = 'both_sides'/.test(pbt));
  assert("R2-1 migration: CHECK chk_jl_amounts_finite added NOT VALID, then validated",
    /ADD CONSTRAINT chk_jl_amounts_finite\s+CHECK \(public\.je_amount_is_finite\(debit\) AND public\.je_amount_is_finite\(credit\)\) NOT VALID/.test(QA) && /VALIDATE CONSTRAINT chk_jl_amounts_finite/.test(QA));
  assert("R2-2 SQL: post_bank_transaction sets app.bank_posting around its header insert only",
    /set_config\('app\.bank_posting', 'on', true\);\s+LOOP/.test(pbt) && /END LOOP;\s+PERFORM set_config\('app\.bank_posting', 'off', true\);/.test(pbt));
  const g = sqlFn(QA, "trg_je_bank_reference_guard");
  assert("R2-2 SQL: bank references refused without the flag (trimmed, case-insensitive, insert or reference change)",
    /~\* '\^\\s\*\(BANK\|XFER\|SPLIT\)-'/.test(g) && /TG_OP = 'INSERT' OR NEW\.reference IS DISTINCT FROM OLD\.reference/.test(g) && /current_setting\('app\.bank_posting', true\)/.test(g)
    && /BEFORE INSERT OR UPDATE OF reference ON public\.acct_journal_entries/.test(QA));
  assert("R2-3 SQL: void refuses a locked claiming txn and reconciled lines",
    /HINT = 'locked'/.test(voidSql) && /HINT = 'reconciled'/.test(voidSql) && !/SET reconciled = false/.test(voidSql));
  // No client or API code writes a BANK-/XFER-/SPLIT- reference itself.
  const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const writers = [...walk("src"), ...walk("api")].filter(p => /\.(js|mjs|ts)$/.test(p))
    .filter(p => /reference:\s*[`"'](BANK|XFER|SPLIT)-/.test(read(p)));
  assert("R2-2 no client/API code builds a BANK-/XFER-/SPLIT- reference", writers.length === 0, writers.join(", "));
}
assert("QA4 migration: journal-line company guard trigger (insert + update)",
  /CREATE TRIGGER trg_jl_scope_guard\s+BEFORE INSERT OR UPDATE ON public\.acct_journal_lines/.test(QA) && (QA.match(/HINT = 'cross_company'/g) || []).length === 3);
assert("G4a SQL: locks the header", /FROM acct_journal_entries[\s\S]*?FOR UPDATE/.test(updSql));
assert("G4b SQL: kept lines are updated in place (no stamp columns in the SET)",
  /UPDATE acct_journal_lines\s+SET account_id/.test(updSql) && !/SET[^;]*bank_feed_transaction_id\s*=/.test(updSql) && !/SET[^;]*reconciled\s*=/.test(updSql));
assert("G4b SQL: reconciled line change/removal refused", (updSql.match(/HINT = 'reconciled_line'/g) || []).length >= 3);
assert("G4b SQL: removing a bank-stamped line refused", /HINT = 'bank_line'/.test(updSql));
assert("G4b SQL: system reference can't be changed", /je_reference_is_system\(v_je\.reference\)/.test(updSql));
const warnSet = /const RECORD_LINKED_REF = \/\^\(([A-Z0-9|]+)\)-\//.exec(acct)?.[1]?.split("|") || [];
assert("G4b warn list covers BANK XFER SPLIT STRIPE UTIL DIST ODIST LATEFEE DEP DEPRET RECUR",
  ["BANK", "XFER", "SPLIT", "STRIPE", "UTIL", "DIST", "ODIST", "LATEFEE", "DEP", "DEPRET", "RECUR"].every(p => warnSet.includes(p)));

const match = fnBody(banking, "confirmMatch");
assert("G5a match goes through match_bank_transaction", /supabase\.rpc\("match_bank_transaction"/.test(match));
assert("G5a match no longer writes link/decision/txn from the client",
  !/from\("bank_feed_transaction_link"\)\.insert/.test(match) && !/from\("bank_posting_decision"\)\.insert/.test(match) && !/from\("bank_feed_transaction"\)\.update/.test(match));
const find = fnBody(banking, "findMatches");
assert("G5a candidates must pass the same rule (bank line on the feed GL, exact cents)",
  /matchableBankLine\(je, txn, feed\.gl_account_id\)/.test(find) && /l\.account_id === feedGl/.test(banking));
assert("G5a candidate total is no longer 'sum of all debits'", !/reduce\(\(s, l\) => s \+ safeNum\(l\.debit\), 0\)/.test(find));
const matchSql = sqlFn(SQL, "match_bank_transaction");
assert("G5a SQL: requires for_review", /v_txn\.status <> 'for_review'/.test(matchSql));
assert("G5a SQL: respects the period lock (txn and entry dates)", /v_txn\.posted_date <= v_lock OR v_je\.date <= v_lock/.test(matchSql));
assert("G5a SQL: entry must have the bank line on the feed GL, to the cent, on the bank side",
  /account_id = v_gl/.test(matchSql) && /round\(COALESCE\(debit, 0\), 2\) = v_abs/.test(matchSql) && /round\(COALESCE\(credit, 0\), 2\) = v_abs/.test(matchSql));
assert("G5a SQL: entry row lock serialises two txns claiming it", /FROM acct_journal_entries[\s\S]*?FOR UPDATE[\s\S]*already_linked/.test(matchSql));
assert("G5a SQL: stamps the matched line", /UPDATE acct_journal_lines SET bank_feed_transaction_id = p_txn_id/.test(matchSql));

const amend = fnBody(banking, "bulkAmend");
assert("G5b bulk amend skips matched transactions", /txn\.status === "matched" \|\| txn\.matched_target_id/.test(amend) && /matched to an existing entry/.test(amend));
assert("G5b bulk amend only touches bank-created entries", /isBankCreatedEntry\(txn\.journal_entry_id\)/.test(amend) && /\^\(BANK\|XFER\|SPLIT\)-/.test(fnBody(banking, "isBankCreatedEntry")));
assert("G5b the matched skip comes before any line is rewritten",
  amend.indexOf("matched to an existing entry") < amend.indexOf('from("acct_journal_lines").update'));

const excl = fnBody(banking, "excludeTransaction");
assert("G6 exclude goes through exclude_bank_transaction", /supabase\.rpc\("exclude_bank_transaction"/.test(excl) && /if \(error\)/.test(excl));
const exclSql = sqlFn(SQL, "exclude_bank_transaction");
assert("G6 SQL: for_review check + decision id recorded", /v_txn\.status <> 'for_review'/.test(exclSql) && /posting_decision_id = v_decision_id/.test(exclSql));
assert("G6 undo marks a legacy decision (no id) undone too", /OR status = 'posted'/.test(undoSql));

const accept = fnBody(banking, "acceptTransaction");
assert("accept surfaces relinked / already_posted", /postedOutcomeMessage\(posted,/.test(accept) && /"relinked"/.test(banking) && /"already_posted"/.test(banking));
assert("accept returns a boolean bulkApply can count", /return true;/.test(accept) && /if \(!posted\) return false;/.test(accept));
assert("bulkApply counts a false return as a failure", /if \(await acceptTransaction\(txn, accountId/.test(fnBody(banking, "bulkApply")));

// ─── Part 2: live against TEST ─────────────────────────────────────────
console.log("\n🧪 LIVE (TEST project)");
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const RUN = `uve-live-${Date.now()}`;
const created = { txns: [], jes: [] };

async function pickFixture() {
  // A company with a GL-mapped feed and no period lock (so the test never
  // has to add a company-wide lock others could see).
  const { data: feeds } = await sb.from("bank_account_feed").select("id, company_id, gl_account_id").not("gl_account_id", "is", null).limit(20);
  for (const f of feeds || []) {
    const { data: lock } = await sb.from("accounting_period_lock").select("lock_date").eq("company_id", f.company_id).maybeSingle();
    if (lock?.lock_date && lock.lock_date >= "2026-09-20") continue;
    const { data: accts } = await sb.from("acct_accounts").select("id, name").eq("company_id", f.company_id)
      .is("tenant_id", null).neq("id", f.gl_account_id).eq("type", "Expense").limit(2);
    if ((accts || []).length >= 2) return { c: f.company_id, feed: f.id, g: f.gl_account_id, ex: accts[0].id, ex2: accts[1].id };
  }
  return null;
}
async function mkTxn(fx, i, amount, direction = "inflow") {
  const { data, error } = await sb.from("bank_feed_transaction").insert({
    company_id: fx.c, bank_account_feed_id: fx.feed, posted_date: "2026-09-20", amount, direction,
    fingerprint_hash: `${RUN}-${i}`, status: "for_review", bank_description_clean: `UVE LIVE ${i}`
  }).select("id").single();
  if (error) throw error;
  created.txns.push(data.id);
  return data.id;
}
async function mkJE(fx, tag, lines, extra = {}) {
  const { data: num } = await sb.rpc("next_je_number", { p_company_id: fx.c });
  const { data: je, error } = await sb.from("acct_journal_entries").insert({
    company_id: fx.c, number: num, date: "2026-09-20", description: `UVE LIVE ${tag}`, reference: `${extra.refPrefix || "MANUALX"}-${RUN}-${tag}`, status: "posted"
  }).select("id").single();
  if (error) throw error;
  created.jes.push(je.id);
  const { data: ls, error: lErr } = await sb.from("acct_journal_lines").insert(lines.map(l => ({ journal_entry_id: je.id, company_id: fx.c, account_name: "x", debit: 0, credit: 0, ...l }))).select("id, account_id, debit, credit");
  if (lErr) throw lErr;
  return { id: je.id, lines: ls };
}
const txnRow = async (id) => (await sb.from("bank_feed_transaction").select("*").eq("id", id).single()).data;
const jeRow = async (id) => (await sb.from("acct_journal_entries").select("*").eq("id", id).single()).data;
const linesOf = async (jeId) => (await sb.from("acct_journal_lines").select("*").eq("journal_entry_id", jeId).order("id")).data || [];

async function cleanup() {
  if (created.txns.length) {
    await sb.from("bank_feed_transaction_link").delete().in("bank_feed_transaction_id", created.txns);
    await sb.from("bank_posting_decision").delete().in("bank_feed_transaction_id", created.txns);
    // Entries the bank flow created for these txns.
    const { data: bankJes } = await sb.from("acct_journal_lines").select("journal_entry_id").in("bank_feed_transaction_id", created.txns);
    for (const r of bankJes || []) if (!created.jes.includes(r.journal_entry_id)) created.jes.push(r.journal_entry_id);
    for (const t of created.txns) {
      for (const p of ["BANK", "XFER", "SPLIT"]) {
        const { data: j } = await sb.from("acct_journal_entries").select("id").eq("reference", `${p}-${t}`);
        for (const r of j || []) if (!created.jes.includes(r.id)) created.jes.push(r.id);
      }
    }
  }
  if (created.jes.length) {
    await sb.from("acct_journal_lines").delete().in("journal_entry_id", created.jes);
    await sb.from("acct_journal_entries").delete().in("id", created.jes);
  }
  if (created.txns.length) await sb.from("bank_feed_transaction").delete().in("id", created.txns);
  const { count: t } = await sb.from("bank_feed_transaction").select("id", { count: "exact", head: true }).like("fingerprint_hash", `${RUN}-%`);
  const { count: j } = await sb.from("acct_journal_entries").select("id", { count: "exact", head: true }).like("description", "UVE LIVE %");
  assert("cleanup: no tagged rows left behind", t === 0 && j === 0, `txns=${t} jes=${j}`);
}

async function live() {
  const fx = await pickFixture();
  if (!fx) { assert("TEST fixture company with a mapped feed", false); return; }

  // G1: match then undo keeps the matched entry posted
  const p = await mkJE(fx, "P", [{ account_id: fx.g, debit: 77.77 }, { account_id: fx.ex, credit: 77.77 }], { refPrefix: "PAY" });
  const t1 = await mkTxn(fx, 1, 77.77);
  let r = await sb.rpc("match_bank_transaction", { p_company_id: fx.c, p_txn_id: t1, p_je_id: p.id });
  assert("G5a match: outcome matched", !r.error && r.data?.outcome === "matched", r.error?.message);
  const bankLine = (await linesOf(p.id)).find(l => l.account_id === fx.g);
  assert("G5a match stamps the entry's bank line", bankLine?.bank_feed_transaction_id === t1);
  const t1m = await txnRow(t1);
  assert("G5a match sets status, journal_entry_id and posting_decision_id", t1m.status === "matched" && t1m.journal_entry_id === p.id && !!t1m.posting_decision_id);
  r = await sb.rpc("match_bank_transaction", { p_company_id: fx.c, p_txn_id: t1, p_je_id: p.id });
  assert("G5a match retry is idempotent", r.data?.outcome === "already_matched", r.error?.message);
  r = await sb.rpc("undo_bank_transaction", { p_company_id: fx.c, p_txn_id: t1 });
  assert("G1 undo of a matched txn: outcome unmatched", r.data?.outcome === "unmatched", r.error?.message);
  assert("G1 matched entry is STILL POSTED after undo", (await jeRow(p.id)).status === "posted");
  const { count: links } = await sb.from("bank_feed_transaction_link").select("id", { count: "exact", head: true }).eq("bank_feed_transaction_id", t1);
  assert("G1 unmatch removed the link", links === 0);
  assert("G1 unmatch released the line stamp", !(await linesOf(p.id)).some(l => l.bank_feed_transaction_id === t1));
  const t1u = await txnRow(t1);
  assert("G1 txn back in For Review, cleared", t1u.status === "for_review" && !t1u.journal_entry_id && !t1u.matched_target_id && !t1u.posting_decision_id);
  const { data: d1 } = await sb.from("bank_posting_decision").select("status").eq("bank_feed_transaction_id", t1);
  assert("G1 match decision marked undone", (d1 || []).length === 1 && d1[0].status === "undone");

  // G5a: concurrent double match of one entry by two txns -> exactly one wins
  const p2 = await mkJE(fx, "P2", [{ account_id: fx.g, debit: 55.5 }, { account_id: fx.ex, credit: 55.5 }], { refPrefix: "PAY" });
  const t2 = await mkTxn(fx, 2, 55.5), t3 = await mkTxn(fx, 3, 55.5);
  const [a, b] = await Promise.all([
    sb.rpc("match_bank_transaction", { p_company_id: fx.c, p_txn_id: t2, p_je_id: p2.id }),
    sb.rpc("match_bank_transaction", { p_company_id: fx.c, p_txn_id: t3, p_je_id: p2.id }),
  ]);
  const wins = [a, b].filter(x => !x.error).length;
  const loser = [a, b].find(x => x.error);
  assert("G5a concurrent double match: exactly one succeeds", wins === 1, JSON.stringify([a.error?.message, b.error?.message]));
  assert("G5a …the other is refused as already linked", loser?.error?.hint === "already_linked", loser?.error?.message);
  const { count: p2links } = await sb.from("bank_feed_transaction_link").select("id", { count: "exact", head: true }).eq("linked_object_id", p2.id);
  assert("G5a …and only one link exists", p2links === 1);

  // G5a: wrong amount / wrong account / wrong side
  const t4 = await mkTxn(fx, 4, 77.78);
  r = await sb.rpc("match_bank_transaction", { p_company_id: fx.c, p_txn_id: t4, p_je_id: p.id });
  assert("G5a refuses a candidate one cent off", r.error?.hint === "no_matching_line", r.error?.message);
  const q = await mkJE(fx, "Q", [{ account_id: fx.ex2, debit: 77.78 }, { account_id: fx.ex, credit: 77.78 }]);
  r = await sb.rpc("match_bank_transaction", { p_company_id: fx.c, p_txn_id: t4, p_je_id: q.id });
  assert("G5a refuses an entry that never touches the bank account", r.error?.hint === "no_matching_line", r.error?.message);
  const t5o = await mkTxn(fx, 5, 77.77, "outflow");
  r = await sb.rpc("match_bank_transaction", { p_company_id: fx.c, p_txn_id: t5o, p_je_id: p.id });
  assert("G5a refuses the wrong side (money out vs a bank debit)", r.error?.hint === "no_matching_line", r.error?.message);
  assert("G5a refused matches changed nothing", (await txnRow(t4)).status === "for_review" && (await txnRow(t5o)).status === "for_review");

  // G6: exclude, re-exclude, restore
  const t6 = await mkTxn(fx, 6, 12.34);
  r = await sb.rpc("exclude_bank_transaction", { p_company_id: fx.c, p_txn_id: t6, p_reason: "duplicate" });
  const t6x = await txnRow(t6);
  assert("G6 exclude records the decision id on the txn", r.data?.outcome === "excluded" && t6x.status === "excluded" && t6x.posting_decision_id === r.data?.decision_id);
  r = await sb.rpc("exclude_bank_transaction", { p_company_id: fx.c, p_txn_id: t6, p_reason: "personal" });
  assert("G6 exclude refuses a txn that is no longer For Review", r.error?.hint === "already_processed", r.error?.message);
  r = await sb.rpc("match_bank_transaction", { p_company_id: fx.c, p_txn_id: t6, p_je_id: q.id });
  assert("G5a match refuses a txn that is not For Review", r.error?.hint === "already_processed", r.error?.message);
  r = await sb.rpc("undo_bank_transaction", { p_company_id: fx.c, p_txn_id: t6 });
  const { data: d6 } = await sb.from("bank_posting_decision").select("status").eq("bank_feed_transaction_id", t6);
  assert("G6 restore: outcome restored, decision undone", r.data?.outcome === "restored" && d6?.[0]?.status === "undone", r.error?.message);

  // G1: a bank-CREATED entry is voided by undo
  const t7 = await mkTxn(fx, 7, 20);
  r = await sb.rpc("post_bank_transaction", { p_company_id: fx.c, p_txn_id: t7, p_kind: "add", p_description: "UVE LIVE created", p_property: "",
    p_lines: [{ account_id: fx.g, debit: 20, credit: 0 }, { account_id: fx.ex, debit: 0, credit: 20 }], p_decision: {}, p_decision_lines: [] });
  const createdJe = r.data?.je_id;
  if (createdJe) created.jes.push(createdJe);
  r = await sb.rpc("undo_bank_transaction", { p_company_id: fx.c, p_txn_id: t7 });
  assert("G1 undo of a bank-created entry voids it", r.data?.outcome === "voided" && (await jeRow(createdJe)).status === "voided", r.error?.message);
  assert("G1 …and releases its stamps", !(await linesOf(createdJe)).some(l => l.bank_feed_transaction_id === t7));
  r = await sb.rpc("undo_bank_transaction", { p_company_id: fx.c, p_txn_id: t7 });
  assert("G2 undo retry after a lost response is a no-op", r.data?.outcome === "already_for_review", r.error?.message);

  // G4: edit keeps stamps, refuses reconciled changes, all-or-nothing
  const t8 = await mkTxn(fx, 8, 50);
  const e = await mkJE(fx, "E", [
    { account_id: fx.g, debit: 50, reconciled: true, reconciled_date: "2026-09-22" },
    { account_id: fx.ex, credit: 30, bank_feed_transaction_id: t8 },
    { account_id: fx.ex2, credit: 20 },
  ], { refPrefix: "PAY" });
  const [l1, l2, l3] = e.lines;
  const idsOf = async (jeId) => (await linesOf(jeId)).map(l => l.id);
  // The snapshot an editor would have loaded (what the client sends as p_expected).
  const snapOf = async (jeId) => {
    const h = await jeRow(jeId), ls = await linesOf(jeId);
    return { header: { date: h.date, description: h.description || "", reference: h.reference || "", status: h.status, property: h.property || "" },
      lines: ls.map(l => ({ id: l.id, account_id: l.account_id, debit: l.debit, credit: l.credit, class_id: l.class_id || "", memo: l.memo || "" })) };
  };
  const upd = async (jeId, header, lines, expected, snap) => sb.rpc("update_journal_entry", { p_company_id: fx.c, p_je_id: jeId, p_header: header, p_lines: lines,
    p_expected_line_ids: expected === undefined ? await idsOf(jeId) : expected,
    p_expected: snap === undefined ? await snapOf(jeId) : snap });
  r = await upd(e.id, { description: "UVE LIVE E edited" }, [
      { id: l1.id, account_id: fx.g, debit: 50, credit: 0, memo: "memo edit" },
      { id: l2.id, account_id: fx.ex, debit: 0, credit: 30, memo: "stamped memo edit" },
      { id: l3.id, account_id: fx.ex2, debit: 0, credit: 15 },
      { account_id: fx.ex, debit: 0, credit: 5 },
    ]);
  const after = await linesOf(e.id);
  const byId = Object.fromEntries(after.map(l => [l.id, l]));
  assert("G4a edit succeeds (3 kept, 1 inserted)", r.data?.kept === 3 && r.data?.inserted === 1, r.error?.message);
  assert("G4b kept lines keep their ids", !!byId[l1.id] && !!byId[l2.id] && !!byId[l3.id]);
  assert("G4b reconciled + reconciled_date survive the edit", byId[l1.id]?.reconciled === true && byId[l1.id]?.reconciled_date === "2026-09-22" && byId[l1.id]?.memo === "memo edit");
  assert("G4b bank_feed_transaction_id survives a memo edit of the stamped line", byId[l2.id]?.bank_feed_transaction_id === t8 && byId[l2.id]?.account_id === fx.ex && byId[l2.id]?.memo === "stamped memo edit");
  assert("G4b new line is inserted clean", after.filter(l => ![l1.id, l2.id, l3.id].includes(l.id)).every(l => !l.reconciled && !l.bank_feed_transaction_id));
  const l4 = after.find(l => ![l1.id, l2.id, l3.id].includes(l.id));

  // QA2: the stamp no longer follows the line id onto another account/amount.
  r = await upd(e.id, {}, [{ id: l1.id, account_id: fx.g, debit: 50 }, { id: l2.id, account_id: fx.ex2, credit: 30 }, { id: l3.id, account_id: fx.ex2, credit: 15 }, { id: l4.id, account_id: fx.ex, credit: 5 }]);
  assert("QA2 moving a bank-stamped line to another account is refused", r.error?.hint === "bank_line", r.error?.message);
  r = await upd(e.id, {}, [{ id: l1.id, account_id: fx.g, debit: 50 }, { id: l2.id, account_id: fx.ex, credit: 25 }, { id: l3.id, account_id: fx.ex2, credit: 20 }, { id: l4.id, account_id: fx.ex, credit: 5 }]);
  assert("QA2 changing a bank-stamped line's amount is refused", r.error?.hint === "bank_line", r.error?.message);
  r = await upd(e.id, { status: "draft" }, after.map(l => ({ id: l.id, account_id: l.account_id, debit: l.debit, credit: l.credit })));
  assert("QA2 posted -> draft refused while lines are stamped / reconciled", r.error?.hint === "posted_to_draft", r.error?.message);
  const l2now = (await linesOf(e.id)).find(l => l.id === l2.id);
  assert("QA2 …the stamped line is unchanged", l2now?.account_id === fx.ex && Number(l2now?.credit) === 30 && l2now?.bank_feed_transaction_id === t8);

  r = await upd(e.id, {}, [{ id: l1.id, account_id: fx.g, debit: 60 }, { id: l2.id, account_id: fx.ex, credit: 30 }, { id: l3.id, account_id: fx.ex2, credit: 30 }]);
  assert("G4b changing a reconciled line's amount is refused", r.error?.hint === "reconciled_line", r.error?.message);
  r = await upd(e.id, {}, [{ id: l2.id, account_id: fx.ex, credit: 30 }, { account_id: fx.ex2, debit: 30 }]);
  assert("G4b removing a reconciled line is refused", r.error?.hint === "reconciled_line", r.error?.message);
  r = await upd(e.id, {}, [{ id: l1.id, account_id: fx.g, debit: 50 }, { id: l3.id, account_id: fx.ex2, credit: 50 }]);
  assert("G4b removing a bank-stamped line is refused", r.error?.hint === "bank_line", r.error?.message);
  r = await upd(e.id, { reference: "MINE" }, after.map(l => ({ id: l.id, account_id: l.account_id, debit: l.debit, credit: l.credit })));
  assert("G4b a system reference can't be changed", r.error?.hint === "system_reference", r.error?.message);
  r = await upd(e.id, { description: "SHOULD NOT SAVE" }, [{ id: l1.id, account_id: fx.g, debit: 50 }, { id: l2.id, account_id: fx.ex, credit: 30 }, { id: l3.id, account_id: fx.ex2, credit: 19 }]);
  assert("G4a unbalanced edit is refused", r.error?.hint === "unbalanced", r.error?.message);
  r = await upd(e.id, { description: "SHOULD NOT SAVE" }, [
      { id: l1.id, account_id: fx.g, debit: 50 },
      { id: l2.id, account_id: fx.ex, credit: 30 },
      { id: l3.id, account_id: fx.ex2, credit: 5 },
      { account_id: "00000000-0000-0000-0000-00000000dead", credit: 15 },
    ]);
  const afterFail = await linesOf(e.id);
  assert("G4a a failing line rolls the whole edit back", !!r.error
    && (await jeRow(e.id)).description === "UVE LIVE E edited"
    && afterFail.length === after.length
    && afterFail.find(l => l.id === l3.id)?.credit == 15, r.error?.message);

  // QA5: the editor must have loaded exactly the entry's lines.
  const allE = after.map(l => ({ id: l.id, account_id: l.account_id, debit: l.debit, credit: l.credit }));
  r = await upd(e.id, {}, allE.filter(l => l.id !== l4.id).concat([{ account_id: fx.ex, credit: 5 }]), after.filter(l => l.id !== l4.id).map(l => l.id));
  assert("QA5 an editor that didn't load a line is refused (stale_lines)", r.error?.hint === "stale_lines", r.error?.message);
  r = await upd(e.id, {}, allE, null);
  assert("QA5 no expected ids -> refused", r.error?.hint === "stale_lines", r.error?.message);
  r = await upd(e.id, {}, allE, after.map(l => l.id).concat([2147483000]));
  assert("QA5 an expected id that isn't one of the lines -> refused", r.error?.hint === "stale_lines", r.error?.message);
  assert("QA5 …nothing changed", (await linesOf(e.id)).length === after.length);

  // QA6: cents, negatives, all-zero (on an ordinary entry)
  const z = await mkJE(fx, "Z", [{ account_id: fx.ex2, debit: 40 }, { account_id: fx.ex, credit: 40 }]);
  const [z1, z2] = z.lines;
  r = await upd(z.id, {}, [{ id: z1.id, account_id: fx.ex2, debit: 40.005 }, { id: z2.id, account_id: fx.ex, credit: 40.001 }]);
  assert("QA6 40.005 vs 40.001 (40.01 vs 40.00 in cents) is unbalanced", r.error?.hint === "unbalanced", r.error?.message);
  r = await upd(z.id, {}, [{ id: z1.id, account_id: fx.ex2, debit: -5 }, { id: z2.id, account_id: fx.ex, credit: -5 }]);
  assert("QA6 negative amounts are refused", r.error?.hint === "negative_amount", r.error?.message);
  r = await upd(z.id, {}, [{ id: z1.id, account_id: fx.ex2, debit: 0 }, { id: z2.id, account_id: fx.ex, credit: 0 }]);
  assert("QA6 an all-zero entry is refused", r.error?.hint === "zero_entry", r.error?.message);
  r = await upd(z.id, {}, [{ id: z1.id, account_id: fx.ex2, debit: 40.004 }, { id: z2.id, account_id: fx.ex, credit: 40 }]);
  const zl = await linesOf(z.id);
  assert("QA6 amounts are stored rounded to cents", !r.error && zl.every(l => Number(l.debit) === 40 || Number(l.credit) === 40), r.error?.message);

  // QA3: an ordinary reference can't become a system one, and Undo only
  // voids an entry whose reference names THIS txn.
  const t10 = await mkTxn(fx, 10, 40);
  r = await upd(z.id, { reference: `BANK-${t10}` }, zl.map(l => ({ id: l.id, account_id: l.account_id, debit: l.debit, credit: l.credit })));
  assert("QA3 changing a reference INTO BANK-<txn id> is refused", r.error?.hint === "system_reference", r.error?.message);
  // A BANK- entry that belongs to ANOTHER txn (only post_bank_transaction
  // can write that reference now), pointed at by t10.
  const t10b = await mkTxn(fx, "10b", 40);
  r = await sb.rpc("post_bank_transaction", { p_company_id: fx.c, p_txn_id: t10b, p_kind: "add", p_description: "UVE LIVE other txn", p_property: "",
    p_lines: [{ account_id: fx.g, debit: 40, credit: 0 }, { account_id: fx.ex, debit: 0, credit: 40 }], p_decision: {}, p_decision_lines: [] });
  const other = r.data?.je_id; if (other) created.jes.push(other);
  await sb.from("bank_feed_transaction").update({ status: "categorized", journal_entry_id: other }).eq("id", t10);
  r = await sb.rpc("undo_bank_transaction", { p_company_id: fx.c, p_txn_id: t10 });
  assert("QA3 undo of an entry whose BANK- reference names another txn: unlinked, left posted",
    r.data?.outcome === "unlinked" && (await jeRow(other)).status === "posted", r.error?.message || JSON.stringify(r.data));

  // R2-2: BANK-/XFER-/SPLIT- references come only from post_bank_transaction.
  for (const pfx of ["BANK-", " bank-", "Xfer-", "SPLIT-"]) {
    const { error: e2 } = await sb.from("acct_journal_entries").insert({ company_id: fx.c, number: `UVE-${RUN}-m`, date: "2026-09-20", description: "UVE LIVE manual", reference: `${pfx}${t10}`, status: "posted" });
    assert(`R2-2 a manual entry with reference ${JSON.stringify(pfx)}<txn> is refused`, e2?.hint === "system_reference", e2?.message);
  }
  const { error: eRef } = await sb.from("acct_journal_entries").update({ reference: `BANK-${t10}` }).eq("id", z.id);
  assert("R2-2 a direct update of a reference to BANK-<txn> is refused", eRef?.hint === "system_reference", eRef?.message);
  const { error: eDesc } = await sb.from("acct_journal_entries").update({ description: "UVE LIVE other txn (renamed)" }).eq("id", other);
  assert("R2-2 …but a bank entry's other fields still update", !eDesc, eDesc?.message);

  // QA4: lines stay inside their company (the trigger, for every path)
  const { data: foreign } = await sb.from("acct_accounts").select("id, company_id").neq("company_id", fx.c).limit(1).single();
  const { data: foreignCls } = await sb.from("acct_classes").select("id").neq("company_id", fx.c).limit(1).maybeSingle();
  r = await upd(z.id, {}, [{ id: z1.id, account_id: fx.ex2, debit: 40 }, { id: z2.id, account_id: foreign.id, credit: 40 }]);
  assert("QA4 update_journal_entry onto another company's account is refused", r.error?.hint === "cross_company", r.error?.message);
  if (foreignCls) {
    r = await upd(z.id, {}, [{ id: z1.id, account_id: fx.ex2, debit: 40, class_id: foreignCls.id }, { id: z2.id, account_id: fx.ex, credit: 40 }]);
    assert("QA4 …or another company's class", r.error?.hint === "cross_company", r.error?.message);
  }
  const t11 = await mkTxn(fx, 11, 41);
  r = await sb.rpc("post_bank_transaction", { p_company_id: fx.c, p_txn_id: t11, p_kind: "add", p_description: "UVE LIVE foreign", p_property: "",
    p_lines: [{ account_id: fx.g, debit: 41, credit: 0 }, { account_id: foreign.id, debit: 0, credit: 41 }], p_decision: {}, p_decision_lines: [] });
  assert("QA4 post_bank_transaction onto another company's account is refused", r.error?.hint === "cross_company" && (await txnRow(t11)).status === "for_review", r.error?.message);
  let ins = await sb.from("acct_journal_lines").insert({ journal_entry_id: z.id, company_id: fx.c, account_id: foreign.id, account_name: "x", debit: 0, credit: 0 });
  assert("QA4 a direct line insert with another company's account is refused", /another company/.test(ins.error?.message || ""), ins.error?.message);
  ins = await sb.from("acct_journal_lines").insert({ journal_entry_id: z.id, company_id: foreign.company_id, account_id: foreign.id, account_name: "x", debit: 0, credit: 0 });
  assert("QA4 a line whose company differs from its entry's is refused", /same company as its entry/.test(ins.error?.message || ""), ins.error?.message);

  // QA1: a stale matched_to link no longer makes Undo skip the void.
  // (a) the tester's repro with the OLD client-side void (leaves link + decision)
  const p12 = await mkJE(fx, "P12", [{ account_id: fx.g, debit: 42.42 }, { account_id: fx.ex, credit: 42.42 }], { refPrefix: "PAY" });
  const t12 = await mkTxn(fx, 12, 42.42);
  r = await sb.rpc("match_bank_transaction", { p_company_id: fx.c, p_txn_id: t12, p_je_id: p12.id });
  await sb.from("acct_journal_entries").update({ status: "voided" }).eq("id", p12.id);
  await sb.from("bank_feed_transaction").update({ status: "for_review", journal_entry_id: null, posting_decision_id: null, matched_target_type: null, matched_target_id: null }).eq("id", t12);
  await sb.from("acct_journal_lines").update({ bank_feed_transaction_id: null }).eq("journal_entry_id", p12.id);
  r = await sb.rpc("post_bank_transaction", { p_company_id: fx.c, p_txn_id: t12, p_kind: "add", p_description: "UVE LIVE after stale", p_property: "",
    p_lines: [{ account_id: fx.g, debit: 42.42, credit: 0 }, { account_id: fx.ex, debit: 0, credit: 42.42 }], p_decision: {}, p_decision_lines: [] });
  const bank12 = r.data?.je_id; if (bank12) created.jes.push(bank12);
  r = await sb.rpc("undo_bank_transaction", { p_company_id: fx.c, p_txn_id: t12 });
  const { count: links12 } = await sb.from("bank_feed_transaction_link").select("id", { count: "exact", head: true }).eq("bank_feed_transaction_id", t12);
  const { data: dec12 } = await sb.from("bank_posting_decision").select("status").eq("bank_feed_transaction_id", t12);
  assert("QA1 stale link: undo of the BANK- posting VOIDS it", r.data?.outcome === "voided" && (await jeRow(bank12)).status === "voided", r.error?.message || JSON.stringify(r.data));
  assert("QA1 …and leaves no link (stale matched_to and created_from both gone) and no 'posted' decision",
    links12 === 0 && (dec12 || []).every(d => d.status === "undone"), `links=${links12} dec=${JSON.stringify(dec12)}`);

  // (b) with the new void_journal_entry
  const p13 = await mkJE(fx, "P13", [{ account_id: fx.g, debit: 43.43 }, { account_id: fx.ex, credit: 43.43 }], { refPrefix: "PAY" });
  const t13 = await mkTxn(fx, 13, 43.43);
  await sb.rpc("match_bank_transaction", { p_company_id: fx.c, p_txn_id: t13, p_je_id: p13.id });
  r = await sb.rpc("void_journal_entry", { p_company_id: fx.c, p_je_id: p13.id });
  const { count: links13 } = await sb.from("bank_feed_transaction_link").select("id", { count: "exact", head: true }).eq("bank_feed_transaction_id", t13);
  const { data: dec13 } = await sb.from("bank_posting_decision").select("status").eq("bank_feed_transaction_id", t13);
  const t13v = await txnRow(t13);
  assert("QA1 void_journal_entry: entry voided, txn back in For Review", r.data?.outcome === "voided" && (r.data?.txn_ids || []).includes(t13)
    && (await jeRow(p13.id)).status === "voided" && t13v.status === "for_review" && !t13v.journal_entry_id, r.error?.message || JSON.stringify(r.data));
  assert("QA1 …its matched_to link deleted and its match decision undone", links13 === 0 && (dec13 || []).length === 1 && dec13[0].status === "undone", `links=${links13} dec=${JSON.stringify(dec13)}`);
  assert("QA1 …and no stamps left on the voided entry", !(await linesOf(p13.id)).some(l => l.bank_feed_transaction_id));
  r = await sb.rpc("void_journal_entry", { p_company_id: fx.c, p_je_id: p13.id });
  assert("QA1 void retry is a no-op", r.data?.outcome === "already_voided", r.error?.message);

  // R2-1: non-finite amounts and two-sided lines, every path
  const n = await mkJE(fx, "N", [{ account_id: fx.ex2, debit: 70 }, { account_id: fx.ex, credit: 70 }]);
  const [n1, n2] = n.lines;
  for (const bad of ["NaN", "Infinity", "-Infinity"]) {
    r = await upd(n.id, {}, [{ id: n1.id, account_id: fx.ex2, debit: bad }, { id: n2.id, account_id: fx.ex, credit: bad }]);
    assert(`R2-1 update_journal_entry refuses ${bad}`, r.error?.hint === "bad_amount", r.error?.message);
  }
  r = await upd(n.id, {}, [{ id: n1.id, account_id: fx.ex2, debit: 75, credit: 5 }, { id: n2.id, account_id: fx.ex, credit: 70 }]);
  assert("R2-1 update_journal_entry refuses a line with both a debit and a credit", r.error?.hint === "both_sides", r.error?.message);
  assert("R2-1 …the entry is unchanged", (await linesOf(n.id)).every(l => Number(l.debit) === 70 || Number(l.credit) === 70));
  const t14 = await mkTxn(fx, 14, 70);
  r = await sb.rpc("post_bank_transaction", { p_company_id: fx.c, p_txn_id: t14, p_kind: "add", p_description: "UVE LIVE nan", p_property: "",
    p_lines: [{ account_id: fx.g, debit: "NaN", credit: 0 }, { account_id: fx.ex, debit: 0, credit: "NaN" }], p_decision: {}, p_decision_lines: [] });
  assert("R2-1 post_bank_transaction refuses NaN", r.error?.hint === "bad_amount", r.error?.message);
  r = await sb.rpc("post_bank_transaction", { p_company_id: fx.c, p_txn_id: t14, p_kind: "add", p_description: "UVE LIVE both", p_property: "",
    p_lines: [{ account_id: fx.g, debit: 75, credit: 5 }, { account_id: fx.ex, debit: 0, credit: 70 }], p_decision: {}, p_decision_lines: [] });
  assert("R2-1 post_bank_transaction refuses a two-sided line", r.error?.hint === "both_sides" && (await txnRow(t14)).status === "for_review", r.error?.message);
  const { error: eNaN } = await sb.from("acct_journal_lines").insert({ journal_entry_id: n.id, company_id: fx.c, account_id: fx.ex, account_name: "x", debit: "NaN", credit: 0 });
  assert("R2-1 a direct NaN line insert is refused by chk_jl_amounts_finite", /chk_jl_amounts_finite/.test(eNaN?.message || ""), eNaN?.message);

  // R2-4: a second editor's save in between is not overwritten
  const before = await snapOf(n.id);
  const r1 = await upd(n.id, {}, [{ id: n1.id, account_id: fx.ex2, debit: 70, memo: "editor A" }, { id: n2.id, account_id: fx.ex, credit: 70 }], undefined, before);
  const r2 = await upd(n.id, {}, [{ id: n1.id, account_id: fx.ex2, debit: 70, memo: "editor B" }, { id: n2.id, account_id: fx.ex, credit: 70 }], undefined, before);
  assert("R2-4 first editor saves; the second (same loaded snapshot) is refused as stale_entry", !r1.error && r2.error?.hint === "stale_entry", (r1.error?.message || "") + " / " + (r2.error?.message || ""));
  assert("R2-4 …editor A's memo is what stays", (await linesOf(n.id)).find(l => l.id === n1.id)?.memo === "editor A");
  r = await upd(n.id, {}, [{ id: n1.id, account_id: fx.ex2, debit: 70 }, { id: n2.id, account_id: fx.ex, credit: 70 }], undefined, null);
  assert("R2-4 no snapshot -> refused", r.error?.hint === "stale_entry", r.error?.message);

  // R2-5: a balanced legacy entry with 3-decimal amounts stays re-savable
  const lg = await mkJE(fx, "LEG", [{ account_id: fx.ex2, debit: 33.335 }, { account_id: fx.ex2, debit: 33.335 }, { account_id: fx.ex2, debit: 33.33 }, { account_id: fx.ex, credit: 100 }]);
  r = await upd(lg.id, { description: "UVE LIVE LEG memo" }, lg.lines.map(l => ({ id: l.id, account_id: l.account_id, debit: l.debit, credit: l.credit, memo: "m" })));
  const lgAfter = await linesOf(lg.id);
  assert("R2-5 memo-only edit of a legacy 33.335 + 33.335 + 33.33 = 100 entry saves, amounts untouched",
    !r.error && lgAfter.filter(l => Number(l.debit) === 33.335).length === 2, r.error?.message);
  r = await upd(lg.id, {}, lgAfter.map((l, i) => ({ id: l.id, account_id: l.account_id, debit: i === 0 ? 33.336 : l.debit, credit: l.credit })));
  assert("R2-5 …but a CHANGED amount is rounded to cents and must balance exactly", r.error?.hint === "unbalanced", r.error?.message);

  // R2-3: void refuses an entry claimed by a locked txn, or with reconciled lines
  const t15 = await mkTxn(fx, 15, 15);
  r = await sb.rpc("post_bank_transaction", { p_company_id: fx.c, p_txn_id: t15, p_kind: "add", p_description: "UVE LIVE locked", p_property: "",
    p_lines: [{ account_id: fx.g, debit: 15, credit: 0 }, { account_id: fx.ex, debit: 0, credit: 15 }], p_decision: {}, p_decision_lines: [] });
  const je15 = r.data?.je_id; if (je15) created.jes.push(je15);
  await sb.from("bank_feed_transaction").update({ status: "locked" }).eq("id", t15);
  r = await sb.rpc("void_journal_entry", { p_company_id: fx.c, p_je_id: je15 });
  assert("R2-3 void of an entry claimed by a LOCKED txn is refused", r.error?.hint === "locked" && (await jeRow(je15)).status === "posted" && (await txnRow(t15)).journal_entry_id === je15, r.error?.message);
  const rec = await mkJE(fx, "REC", [{ account_id: fx.g, debit: 16, reconciled: true, reconciled_date: "2026-09-22" }, { account_id: fx.ex, credit: 16 }]);
  r = await sb.rpc("void_journal_entry", { p_company_id: fx.c, p_je_id: rec.id });
  assert("R2-3 void of an entry with reconciled lines is refused", r.error?.hint === "reconciled" && (await jeRow(rec.id)).status === "posted", r.error?.message);
  await sb.from("bank_feed_transaction").update({ status: "categorized" }).eq("id", t15);

  // G2: nothing voided while a txn stays linked -- a void refused mid-undo
  // changes nothing (reconciled line on a bank-created entry).
  const t9 = await mkTxn(fx, 9, 9);
  r = await sb.rpc("post_bank_transaction", { p_company_id: fx.c, p_txn_id: t9, p_kind: "add", p_description: "UVE LIVE created 2", p_property: "",
    p_lines: [{ account_id: fx.g, debit: 9, credit: 0 }, { account_id: fx.ex, debit: 0, credit: 9 }], p_decision: {}, p_decision_lines: [] });
  const je9 = r.data?.je_id; if (je9) created.jes.push(je9);
  await sb.from("acct_journal_lines").update({ reconciled: true, reconciled_date: "2026-09-22" }).eq("journal_entry_id", je9).eq("account_id", fx.g);
  r = await sb.rpc("undo_bank_transaction", { p_company_id: fx.c, p_txn_id: t9 });
  assert("G2 undo refused (reconciled) leaves entry posted and txn categorised",
    r.error?.hint === "reconciled" && (await jeRow(je9)).status === "posted" && (await txnRow(t9)).status === "categorized", r.error?.message);
}

try { await live(); }
catch (e) { assert("live section ran without throwing", false, e?.message || String(e)); }
finally { await cleanup(); }

console.log(`\n✅ Passed: ${pass}\n❌ Failed: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
