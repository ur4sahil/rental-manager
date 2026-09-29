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
assert("G1 SQL: only BANK-/XFER-/SPLIT- or created_from entries are voided",
  /v_je\.reference ~ '\^\(BANK\|XFER\|SPLIT\)-'/.test(undoSql) && /link_role = 'created_from'/.test(undoSql) && /v_mode := 'voided'/.test(undoSql));
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
assert("G4a SQL: DR=CR with 0.005 tolerance", /abs\(v_dr - v_cr\) > 0\.005/.test(updSql));
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
assert("G6 undo marks a legacy decision (no id) undone too", /AND status = 'posted'/.test(undoSql));

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
  ], { refPrefix: "BANK" });
  const [l1, l2, l3] = e.lines;
  r = await sb.rpc("update_journal_entry", { p_company_id: fx.c, p_je_id: e.id,
    p_header: { description: "UVE LIVE E edited" },
    p_lines: [
      { id: l1.id, account_id: fx.g, debit: 50, credit: 0, memo: "memo edit" },
      { id: l2.id, account_id: fx.ex2, debit: 0, credit: 25 },
      { id: l3.id, account_id: fx.ex2, debit: 0, credit: 15 },
      { account_id: fx.ex, debit: 0, credit: 10 },
    ] });
  const after = await linesOf(e.id);
  const byId = Object.fromEntries(after.map(l => [l.id, l]));
  assert("G4a edit succeeds (3 kept, 1 inserted)", r.data?.kept === 3 && r.data?.inserted === 1, r.error?.message);
  assert("G4b kept lines keep their ids", !!byId[l1.id] && !!byId[l2.id] && !!byId[l3.id]);
  assert("G4b reconciled + reconciled_date survive the edit", byId[l1.id]?.reconciled === true && byId[l1.id]?.reconciled_date === "2026-09-22" && byId[l1.id]?.memo === "memo edit");
  assert("G4b bank_feed_transaction_id survives the edit (even with a new account)", byId[l2.id]?.bank_feed_transaction_id === t8 && byId[l2.id]?.account_id === fx.ex2);
  assert("G4b new line is inserted clean", after.filter(l => ![l1.id, l2.id, l3.id].includes(l.id)).every(l => !l.reconciled && !l.bank_feed_transaction_id));

  r = await sb.rpc("update_journal_entry", { p_company_id: fx.c, p_je_id: e.id, p_header: {},
    p_lines: [{ id: l1.id, account_id: fx.g, debit: 60 }, { id: l2.id, account_id: fx.ex2, credit: 60 }] });
  assert("G4b changing a reconciled line's amount is refused", r.error?.hint === "reconciled_line", r.error?.message);
  r = await sb.rpc("update_journal_entry", { p_company_id: fx.c, p_je_id: e.id, p_header: {},
    p_lines: [{ id: l2.id, account_id: fx.ex2, credit: 50 }, { account_id: fx.ex, debit: 50 }] });
  assert("G4b removing a reconciled line is refused", r.error?.hint === "reconciled_line", r.error?.message);
  r = await sb.rpc("update_journal_entry", { p_company_id: fx.c, p_je_id: e.id, p_header: {},
    p_lines: [{ id: l1.id, account_id: fx.g, debit: 50 }, { id: l3.id, account_id: fx.ex2, credit: 50 }] });
  assert("G4b removing a bank-stamped line is refused", r.error?.hint === "bank_line", r.error?.message);
  r = await sb.rpc("update_journal_entry", { p_company_id: fx.c, p_je_id: e.id, p_header: { reference: "MINE" },
    p_lines: after.map(l => ({ id: l.id, account_id: l.account_id, debit: l.debit, credit: l.credit })) });
  assert("G4b a system reference can't be changed", r.error?.hint === "system_reference", r.error?.message);
  r = await sb.rpc("update_journal_entry", { p_company_id: fx.c, p_je_id: e.id, p_header: { description: "SHOULD NOT SAVE" },
    p_lines: [{ id: l1.id, account_id: fx.g, debit: 50 }, { id: l2.id, account_id: fx.ex2, credit: 49 }] });
  assert("G4a unbalanced edit is refused", r.error?.hint === "unbalanced", r.error?.message);
  r = await sb.rpc("update_journal_entry", { p_company_id: fx.c, p_je_id: e.id, p_header: { description: "SHOULD NOT SAVE" },
    p_lines: [
      { id: l1.id, account_id: fx.g, debit: 50 },
      { id: l2.id, account_id: fx.ex2, credit: 25 },
      { id: l3.id, account_id: fx.ex2, credit: 5 },
      { account_id: "00000000-0000-0000-0000-00000000dead", credit: 20 },
    ] });
  const afterFail = await linesOf(e.id);
  assert("G4a a failing line rolls the whole edit back", !!r.error
    && (await jeRow(e.id)).description === "UVE LIVE E edited"
    && afterFail.length === after.length
    && afterFail.find(l => l.id === l3.id)?.credit == 15, r.error?.message);

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
