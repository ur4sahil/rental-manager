// Try to break the Plaid sync (2026-09-30).
//
// Runs the REAL route (api/plaid-sync-transactions.js) against the TEST
// database with a fake Plaid, and attacks it: a first import with a start
// date, old lines slipped into later syncs, a blanked bookmark, deleted lines,
// a new account joining the login, double-clicked syncs, a stale lock, a
// crash mid-sync, an empty sync, and a user asking for 730 days back.
//
// Everything lives under a throwaway company id and is deleted at the end.
//
//   cd tests && node plaid-sync-break.test.js
require("dotenv").config();
require("./sandbox-env");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

// The route reads these names; point them at TEST.
process.env.REACT_APP_SUPABASE_URL = process.env.SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY;
process.env.CRON_SECRET = "break-test-" + crypto.randomBytes(8).toString("hex");
process.env.ENCRYPTION_KEY = "break-test-key-" + crypto.randomBytes(16).toString("hex");
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

// ── fake Plaid ────────────────────────────────────────────────────────────
const plaidPath = require.resolve(path.join(__dirname, "..", "api", "_plaid"));
const realPlaid = require(plaidPath);
const bank = {
  accounts: [],            // [{account_id, mask}]
  history: [],             // every transaction the "bank" holds
  seen: new Set(),         // transaction ids delivered since the last cursor
  cursorSerial: 0,
  delayMs: 0,
  failNext: null,          // error code to throw on the next sync call
  notReady: 0,             // PRODUCT_NOT_READY answers still to give
  calls: 0,
};
function fakeClient() {
  return {
    async transactionsSync({ cursor }) {
      bank.calls++;
      if (bank.delayMs) await new Promise(r => setTimeout(r, bank.delayMs));
      if (bank.notReady > 0) {
        bank.notReady--;
        const e = new Error("PRODUCT_NOT_READY"); e.response = { data: { error_code: "PRODUCT_NOT_READY" } }; throw e;
      }
      if (bank.failNext) {
        const code = bank.failNext; bank.failNext = null;
        const e = new Error(code); e.response = { data: { error_code: code } }; throw e;
      }
      // No cursor: the whole history of EVERY account on the login.
      // A cursor: only what the bank got since that cursor was issued.
      const added = cursor
        ? bank.history.filter(t => t._serial > Number(String(cursor).split(":")[1] || 0))
        : bank.history.slice();
      bank.cursorSerial = Math.max(0, ...bank.history.map(t => t._serial));
      return { data: { added: added.map(({ _serial, ...t }) => t), modified: [], removed: [],
                       next_cursor: "c:" + bank.cursorSerial, has_more: false } };
    },
    async accountsBalanceGet() {
      return { data: { accounts: bank.accounts.map(a => ({ account_id: a.account_id, balances: { current: 1000, available: 1000 } })) } };
    },
  };
}
require.cache[plaidPath].exports = { ...realPlaid, getPlaidClient: fakeClient };
const handler = require(path.join(__dirname, "..", "api", "plaid-sync-transactions.js"));

let serial = 0;
function txn(account_id, date, amount, name) {
  return { transaction_id: "tx-" + crypto.randomBytes(6).toString("hex"), account_id, date, amount, name, pending: false, _serial: ++serial };
}

// ── harness ───────────────────────────────────────────────────────────────
const CID = "sync-breaktest-" + crypto.randomBytes(4).toString("hex");
const ITEM = "item-" + CID;
let connId, feedA, feedB, feedC;
let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (detail ? "\n       " + detail : "")); }
}
async function runSync(extra = {}) {
  const body = { cron_secret: process.env.CRON_SECRET, item_id: ITEM, ...extra };
  return new Promise((resolve) => {
    const res = { _code: 200, headers: {}, setHeader() {}, status(c) { this._code = c; return this; },
      json(p) { resolve({ code: this._code, body: p }); }, end() { resolve({ code: this._code }); } };
    handler({ method: "POST", headers: {}, body, query: {} }, res);
  });
}
async function rows(feed, where = {}) {
  let q = sb.from("bank_feed_transaction").select("id, posted_date, provider_transaction_id, status").eq("company_id", CID);
  if (feed) q = q.eq("bank_account_feed_id", feed);
  const { data } = await q; return data || [];
}
async function conn() {
  const { data } = await sb.from("bank_connection").select("plaid_sync_cursor, sync_from_date, sync_lock_until").eq("id", connId).single();
  return data;
}

async function setup() {
  const { encrypted, iv, salt } = realPlaid.encrypt("access-sandbox-fake");
  const { data: c, error } = await sb.from("bank_connection").insert({
    company_id: CID, source_type: "plaid", institution_name: "Break Test Bank", plaid_item_id: ITEM,
    access_token_encrypted: encrypted, encryption_iv: iv, encryption_salt: salt, connection_status: "active",
  }).select("id").single();
  if (error) throw new Error("setup connection: " + error.message);
  connId = c.id;
  bank.accounts = [{ account_id: "acc-A", mask: "0001" }, { account_id: "acc-B", mask: "0002" }];
  const mk = async (acct, name) => {
    const { data, error: e } = await sb.from("bank_account_feed").insert({
      company_id: CID, bank_connection_id: connId, plaid_account_id: acct, account_name: name,
      account_type: "checking", connection_type: "plaid", status: "active",
    }).select("id").single();
    if (e) throw new Error("setup feed: " + e.message);
    return data.id;
  };
  feedA = await mk("acc-A", "Break A");
  feedB = await mk("acc-B", "Break B");
}
async function cleanup() {
  await sb.from("bank_feed_transaction").delete().eq("company_id", CID);
  await sb.from("plaid_sync_event").delete().eq("company_id", CID);
  await sb.from("bank_balance_snapshot").delete().eq("company_id", CID);
  await sb.from("bank_account_feed").delete().eq("company_id", CID);
  await sb.from("bank_connection").delete().eq("company_id", CID);
}

(async () => {
  console.log("\n=== TRY TO BREAK THE PLAID SYNC (TEST database, fake bank) ===\n");
  try {
    await setup();

    // 18 months of history on two accounts: 2025 and 2026.
    for (const [a, d] of [["acc-A","2025-03-18"],["acc-A","2025-11-02"],["acc-A","2026-02-10"],["acc-A","2026-06-01"],
                          ["acc-B","2025-06-30"],["acc-B","2026-01-15"],["acc-B","2026-08-20"]])
      bank.history.push(txn(a, d, 100, "hist " + a + " " + d));

    // 1. First import with a start date.
    let r = await runSync({ from_date: "2026-01-01" });
    let all = await rows();
    assert("first import takes only lines on/after the chosen start date",
      all.length === 4 && all.every(x => x.posted_date >= "2026-01-01"), `got ${all.length}: ${all.map(x => x.posted_date).join(",")}`);
    assert("the start date is remembered on the connection", (await conn()).sync_from_date === "2026-01-01");
    assert("a cursor is stored after a real import", !!(await conn()).plaid_sync_cursor);

    // 2. The bank later slips an OLD line into an ordinary sync (no from_date).
    bank.history.push(txn("acc-A", "2025-12-30", 55, "late-arriving 2025 line"));
    bank.history.push(txn("acc-A", "2026-09-28", 77, "new deposit"));
    r = await runSync();
    all = await rows();
    assert("an ordinary sync imports the new line", all.some(x => x.posted_date === "2026-09-28"));
    assert("an ordinary sync never imports a line older than the start date", !all.some(x => x.posted_date < "2026-01-01"));

    // 3. Empty sync (nothing new): the bookmark must survive.
    const before3 = (await conn()).plaid_sync_cursor;
    r = await runSync();
    assert("a sync that finds nothing keeps the bookmark", (await conn()).plaid_sync_cursor === before3, `before ${before3} after ${(await conn()).plaid_sync_cursor}`);

    // 4. THE 9/29 FAILURE: bookmark blank, full history re-sent, and the
    //    user had deleted two already-recorded 2026 lines on account A.
    const aRows = (await rows(feedA)).filter(x => x.posted_date < "2026-09-01");
    await sb.from("bank_feed_transaction").delete().in("id", aRows.map(x => x.id));
    await sb.from("bank_connection").update({ plaid_sync_cursor: null }).eq("id", connId);
    bank.history.push(txn("acc-B", "2026-09-29", 12, "genuinely new after the blank"));
    const countBefore4 = (await rows()).length;
    r = await runSync();
    all = await rows();
    const restored = all.filter(x => aRows.some(d => d.provider_transaction_id === x.provider_transaction_id));
    assert("blank bookmark + full history: deleted lines do NOT come back", restored.length === 0, `restored ${restored.length}`);
    assert("blank bookmark + full history: nothing older than the start date", !all.some(x => x.posted_date < "2026-01-01"));
    assert("blank bookmark + full history: the genuinely new line still arrives", all.some(x => x.posted_date === "2026-09-29"));
    assert("blank bookmark: only the new line was added", all.length === countBefore4 + 1, `before ${countBefore4} after ${all.length}`);

    // 5. A new account joins the login (empty feed) and the bookmark rewinds.
    bank.accounts.push({ account_id: "acc-C", mask: "0003" });
    for (const d of ["2025-05-05", "2026-03-03", "2026-07-07"]) bank.history.push(txn("acc-C", d, 40, "C history " + d));
    const { data: fc } = await sb.from("bank_account_feed").insert({ company_id: CID, bank_connection_id: connId, plaid_account_id: "acc-C",
      account_name: "Break C", account_type: "savings", connection_type: "plaid", status: "active" }).select("id").single();
    feedC = fc.id;
    await sb.from("bank_connection").update({ plaid_sync_cursor: null }).eq("id", connId); // what plaid-link now does on join
    const aBefore5 = (await rows(feedA)).length, bBefore5 = (await rows(feedB)).length;
    r = await runSync();
    const cRows = await rows(feedC);
    assert("new account gets its history (from the start date)", cRows.length === 2 && cRows.every(x => x.posted_date >= "2026-01-01"), `C got ${cRows.map(x => x.posted_date).join(",")}`);
    assert("new account joining does not refill the other accounts",
      (await rows(feedA)).length === aBefore5 && (await rows(feedB)).length === bBefore5);

    // 6. Double-click: two syncs at the same moment.
    bank.history.push(txn("acc-A", "2026-09-30", 9, "double-click line"));
    bank.delayMs = 1500;
    const [s1, s2] = await Promise.all([runSync(), runSync()]);
    bank.delayMs = 0;
    const dup = (await rows(feedA)).filter(x => x.posted_date === "2026-09-30");
    const skipped = [s1, s2].filter(x => (x.body.skipped || []).length).length;
    assert("double-click: exactly one of the two syncs runs, the other steps aside", skipped === 1, JSON.stringify([s1.body, s2.body]));
    assert("double-click: the line is imported once", dup.length === 1, `got ${dup.length}`);
    assert("double-click: the lock is released afterwards", !(await conn()).sync_lock_until);

    // 7. A lock left by a crashed run: fresh lock blocks, expired lock does not.
    await sb.from("bank_connection").update({ sync_lock_until: new Date(Date.now() + 60000).toISOString() }).eq("id", connId);
    r = await runSync();
    assert("a live lock makes a new sync step aside", (r.body.skipped || []).length === 1);
    await sb.from("bank_connection").update({ sync_lock_until: new Date(Date.now() - 1000).toISOString() }).eq("id", connId);
    r = await runSync();
    assert("an expired lock does not block forever", !(r.body.skipped || []).length && r.code === 200, JSON.stringify(r.body));

    // 8. The bank errors mid-sync: bookmark unchanged, lock released.
    const cur8 = (await conn()).plaid_sync_cursor;
    bank.failNext = "INTERNAL_SERVER_ERROR";
    r = await runSync();
    const c8 = await conn();
    assert("a crash mid-sync leaves the bookmark as it was", c8.plaid_sync_cursor === cur8);
    assert("a crash mid-sync releases the lock", !c8.sync_lock_until);
    await sb.from("bank_connection").update({ connection_status: "active" }).eq("id", connId);

    // 9. A user asks for 730 days back on the Sync screen.
    await sb.from("bank_connection").update({ plaid_sync_cursor: null }).eq("id", connId);
    r = await runSync({ from_date: "2024-10-01" });
    all = await rows();
    assert("asking for an older date cannot go past the start date", !all.some(x => x.posted_date < "2026-01-01"));
    assert("…and does not overwrite the start date", (await conn()).sync_from_date === "2026-01-01");

    // 10. Bank still loading history on a first connect.
    await sb.from("bank_feed_transaction").delete().eq("company_id", CID);
    await sb.from("bank_connection").update({ plaid_sync_cursor: null }).eq("id", connId);
    bank.notReady = 20; // longer than the route's retry budget
    r = await runSync();
    assert("bank still loading: sync reports history pending", r.body.history_pending === true, JSON.stringify(r.body));
    assert("bank still loading: no bookmark is stored (history not stranded)", !(await conn()).plaid_sync_cursor);
  } catch (e) {
    failed++; console.log("  ❌ harness error: " + e.message);
  } finally {
    await cleanup();
    const { count } = await sb.from("bank_connection").select("id", { count: "exact", head: true }).eq("company_id", CID);
    console.log(`\n  cleanup: ${count === 0 ? "all test rows removed" : "LEFTOVER ROWS for " + CID}`);
  }
  console.log(`\n${failed ? "❌" : "✅"} Passed: ${passed}   Failed: ${failed}\n`);
  process.exit(failed ? 1 : 0);
})();
