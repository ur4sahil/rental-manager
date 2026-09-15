// Guards the Plaid cursor rule.
//
// On 2026-09-15 a Bank of America connection synced 5.7 seconds after the
// Item was created, while Plaid was still fetching history. Plaid returned an
// empty page plus a cursor; the app stored that cursor. Six syncs reported
// success with added_count 0 and no error, and the account showed "0 of 0
// transactions" indefinitely. Clearing the cursor by hand and re-syncing
// returned 1,895 transactions that had been at Plaid the whole time.
//
// These tests exercise the decision the route makes, transcribed rather than
// imported (the route is a Vercel handler that needs Plaid + Supabase). If
// the rule in api/plaid-sync-transactions.js changes, change it here too --
// deliberately, which is the point.

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (detail ? "\n       " + detail : "")); }
}

// The rule, as implemented in the route. `feedTxnCounts` is per ACCOUNT on
// the Item -- asking per CONNECTION was the first version, and it shipped
// wrong: see the "account added to an existing Item" case below.
function cursorToPersist({ addedCount, feedTxnCounts, cursorFromPlaid }) {
  const everyFeedHasImported = (feedTxnCounts || []).length > 0
    && feedTxnCounts.every(n => n > 0);
  const historyPending = addedCount === 0 && !everyFeedHasImported;
  return { stored: historyPending ? null : cursorFromPlaid, historyPending };
}
// The superseded version, kept so the regression stays visible.
function cursorToPersist_v1({ addedCount, feedTxnCounts, cursorFromPlaid }) {
  const connectionHasImported = (feedTxnCounts || []).some(n => n > 0);
  const historyPending = addedCount === 0 && !connectionHasImported;
  return { stored: historyPending ? null : cursorFromPlaid, historyPending };
}

console.log("\n=== Plaid cursor: never strand an Item's history ===");

{
  // THE REGRESSION. Fresh connect, Plaid not ready, nothing imported.
  const r = cursorToPersist({ addedCount: 0, feedTxnCounts: [0, 0], cursorFromPlaid: "CURSOR_FROM_EMPTY_PAGE" });
  assert("fresh connection importing nothing does NOT store a cursor",
    r.stored === null,
    `stored ${JSON.stringify(r.stored)} — this is the exact bug: the next sync would ask "what changed since?" and lose the backfill`);
  assert("...and reports history_pending so the UI can say 'still loading'", r.historyPending === true);
}

{
  // Steady state: an established connection with genuinely nothing new.
  const r = cursorToPersist({ addedCount: 0, feedTxnCounts: [743, 202], cursorFromPlaid: "CURSOR_B" });
  assert("established connection with no new activity DOES store the cursor",
    r.stored === "CURSOR_B",
    "otherwise every routine sync re-pulls the full window forever");
  assert("...and does not claim history is pending", r.historyPending === false);
}

{
  const r = cursorToPersist({ addedCount: 1895, feedTxnCounts: [0, 0], cursorFromPlaid: "CURSOR_C" });
  assert("first successful import stores its cursor", r.stored === "CURSOR_C");
  assert("...and does not claim history is pending", r.historyPending === false);
}

{
  const r = cursorToPersist({ addedCount: 12, feedTxnCounts: [743, 202], cursorFromPlaid: "CURSOR_D" });
  assert("normal incremental sync stores its cursor", r.stored === "CURSOR_D");
}

{
  // THE SECOND REGRESSION, 2026-09-15. Account 6027 was added to the Item
  // that already held 0822 (743 txns) and 1402 (202). The connection looked
  // fully imported, so v1 kept the cursor -- and 6027's history stayed behind
  // a marker claiming it had already been read. The card showed 0 forever.
  const shape = { addedCount: 0, feedTxnCounts: [743, 202, 0], cursorFromPlaid: "CURSOR_PAST_6027" };
  const v1 = cursorToPersist_v1(shape);
  assert("v1 kept the cursor when a NEW account joined an imported Item — the bug",
    v1.stored === "CURSOR_PAST_6027",
    "if this fails, v1 was already correct and the second fix was unnecessary");
  const now = cursorToPersist(shape);
  assert("one never-imported account on the Item is enough to withhold the cursor",
    now.stored === null,
    `stored ${JSON.stringify(now.stored)} — 6027 can only be reached by rewinding`);
  assert("...and it reports history_pending", now.historyPending === true);
}

console.log("\n=== PRODUCT_NOT_READY retries must terminate ===");
{
  // The old code did pages++ then pages-- on PRODUCT_NOT_READY, so `pages`
  // never advanced and the MAX_SYNC_PAGES cap was unreachable — it retried
  // until the serverless function timed out.
  const MAX_SYNC_PAGES = 50, MAX_NOT_READY_RETRIES = 6;
  function runLoop({ alwaysNotReady, boundedRetries }) {
    let pages = 0, notReady = 0, iterations = 0;
    while (pages < MAX_SYNC_PAGES) {
      if (++iterations > 10000) return { terminated: false, iterations };
      pages++;
      if (alwaysNotReady) {
        if (boundedRetries) { if (++notReady > MAX_NOT_READY_RETRIES) return { terminated: true, iterations }; }
        pages--; continue;
      }
      break;
    }
    return { terminated: true, iterations };
  }
  assert("OLD behaviour spins forever when Plaid keeps saying NOT_READY",
    runLoop({ alwaysNotReady: true, boundedRetries: false }).terminated === false,
    "if this passes, the old loop was fine and this test is wrong");
  const fixed = runLoop({ alwaysNotReady: true, boundedRetries: true });
  assert("FIXED behaviour gives up after a bounded number of retries",
    fixed.terminated === true && fixed.iterations <= MAX_NOT_READY_RETRIES + 2,
    `terminated=${fixed.terminated} after ${fixed.iterations} iterations`);
}

console.log("\n=== An empty first sync must not read as success ===");
{
  function toastTone({ total_added, total_removed, history_pending }) {
    if (history_pending || (total_added === 0 && total_removed === 0)) return "info";
    return "success";
  }
  assert("zero imported on a fresh connect is informational, not success",
    toastTone({ total_added: 0, total_removed: 0, history_pending: true }) === "info");
  assert("a real import still reads as success",
    toastTone({ total_added: 945, total_removed: 0, history_pending: false }) === "success");
}

console.log(`\n${failed ? "❌" : "✅"} Passed: ${passed}   Failed: ${failed}\n`);
process.exit(failed ? 1 : 0);
