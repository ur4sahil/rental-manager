#!/usr/bin/env node
// Read every utility bill Housy can reach, and write each onto its record.
//
//   node worker/portals/sweep.js              every portal with a session
//   node worker/portals/sweep.js wssc         just one
//
// This is what turns reading a bill into a feature: without it, Housy
// prints $106.39 to a terminal nobody is watching.
//
// HOLDS NO DATABASE CREDENTIALS. It asks the app what to read and posts
// back what it found, using the same worker token the job worker uses. The
// service key bypasses RLS entirely and this box is a second Always Free
// tenancy that can be reclaimed with little warning -- it stays an
// appliance. tests/ai-never-posts.test.js enforces that.
//
// Deliberately NOT a payable. Utilities are not booked into accounting:
// the bill is written on the utility record the way a person would note
// it, and nothing touches the ledger.
//
// Written for a timer, so every decision assumes nobody is watching:
//
//   * An expired session is reported, never worked around. A sweep that
//     logged itself back in would keep degrading the portal's trust score
//     -- which is exactly how Washington Gas started refusing us.
//   * A failed read leaves the previous figures alone. Overwriting a known
//     balance with a null because the site was down is worse than showing
//     yesterday's number.
//   * Every attempt is recorded. "It didn't run" and "it ran and found
//     nothing" are otherwise indistinguishable.
const { spawn } = require("child_process");
const path = require("path");

const API = (process.env.HOUSY_API_BASE || "").replace(/\/$/, "");
const TOKEN = process.env.AI_WORKER_TOKEN || "";
const COMPANY = process.env.HOUSY_COMPANY_ID;
const BYPASS = process.env.VERCEL_BYPASS_TOKEN || "";

if (!API || !TOKEN || !COMPANY) {
  console.error("HOUSY_API_BASE, AI_WORKER_TOKEN and HOUSY_COMPANY_ID are required");
  process.exit(1);
}

const PROVIDER = { wssc: "WSSC", washington_gas: "Washington GAS" };

async function api(action, body) {
  const h = { "Content-Type": "application/json", "x-worker-token": TOKEN };
  if (BYPASS) h["x-vercel-protection-bypass"] = BYPASS;
  const res = await fetch(`${API}/api/ai?action=${action}`, {
    method: "POST", headers: h, body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${action} -> HTTP ${res.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

function runFetch(portal, account) {
  return new Promise(resolve => {
    const args = [path.join(__dirname, "fetch-bill.js"), portal];
    if (account) args.push("--account", account);
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let out = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", () => {});
    child.on("close", () => {
      try { resolve(JSON.parse(out.slice(out.lastIndexOf("{"), out.lastIndexOf("}") + 1))); }
      catch { resolve({ outcome: "error", error: "could not parse the fetch result" }); }
    });
  });
}

(async () => {
  const only = process.argv[2];
  const portals = Object.keys(PROVIDER).filter(p => !only || p === only);
  const summary = [];

  const { targets } = await api("sweep-targets", {
    companyId: COMPANY, providers: portals.map(p => PROVIDER[p]),
  });

  for (const portal of portals) {
    const provider = PROVIDER[portal];
    const mine = (targets || []).filter(t => (t.provider || "").toLowerCase() === provider.toLowerCase());
    if (!mine.length) {
      console.log(`${provider}: no utility rows for this company`);
      summary.push({ provider, read: 0, note: "no rows" });
      continue;
    }

    // Two linking models, because the portals differ. Washington Gas
    // switches between numbered accounts, so each is read in turn. WSSC has
    // no account number anywhere and names the property beside the balance,
    // so it is read ONCE and the reading identifies itself.
    const withAccounts = mine.filter(t => t.account_number);
    const passes = withAccounts.length
      ? withAccounts.map(t => t.account_number)
      : [null];

    let read = 0, failed = 0, unmatched = 0, needsSignin = 0;
    for (const account of passes) {
      const r = await runFetch(portal, account);

      // An expired session ends this PORTAL immediately. Carrying on would
      // mean one failed fetch per account, each another automated hit on a
      // site that has already refused us.
      if (r.outcome === "needs_signin") {
        needsSignin++;
        console.log(`${provider}: session expired — stopping this portal`);
        await api("record-reading", {
          companyId: COMPANY, provider, account, outcome: "needs_signin",
          error: "the saved session has expired",
        }).catch(() => {});
        break;
      }

      const rec = await api("record-reading", {
        companyId: COMPANY, provider, account,
        property: r.property ?? null, outcome: r.outcome,
        amount: r.amount_due ?? null, due: r.due_date ?? null, error: r.error ?? null,
      }).catch(e => ({ reason: e.message }));

      const who = r.property || account || "?";
      if (r.outcome === "ok") {
        read++;
        if (!rec?.updated) unmatched++;
        console.log(`  ${provider.padEnd(15)} ${String(who).slice(0, 30).padEnd(32)} $${Number(r.amount_due).toFixed(2).padStart(9)}  due ${r.due_date || "?"}   ${rec?.reason || ""}`);
      } else {
        failed++;
        console.log(`  ${provider.padEnd(15)} ${String(who).slice(0, 30).padEnd(32)} ${r.outcome}: ${String(r.error || "").slice(0, 46)}`);
      }
    }

    summary.push({ provider, read, failed, unmatched, needsSignin });
  }

  console.log("\n" + JSON.stringify({ swept: summary, at: new Date().toISOString() }, null, 2));
  // Non-zero when a session needs a person, so the timer surfaces it as a
  // unit failure instead of it scrolling past in a log nobody opens.
  process.exit(summary.some(s => s.needsSignin) ? 2 : 0);
})().catch(e => { console.error(String(e.message)); process.exit(1); });
