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
const { PLAYBOOKS, playbookFor } = require("./playbooks");

const API = (process.env.HOUSY_API_BASE || "").replace(/\/$/, "");
const TOKEN = process.env.AI_WORKER_TOKEN || "";
const COMPANY = process.env.HOUSY_COMPANY_ID;
const BYPASS = process.env.VERCEL_BYPASS_TOKEN || "";

if (!API || !TOKEN || !COMPANY) {
  console.error("HOUSY_API_BASE, AI_WORKER_TOKEN and HOUSY_COMPANY_ID are required");
  process.exit(1);
}

// Portals come from the playbook file, not a second hard-coded list here.
// The old map named two of them, so the five playbooks added alongside
// would have been ignored -- and "no playbook" and "no bill due" look
// identical in the output, which is the quiet failure worth avoiding.
//
// A utility row is matched to a playbook through its ALIASES, because
// utilities.provider is free text someone typed: production holds
// "Wash Gas" and "Washington Gas", "BGE" and "bge". Exact matching skips
// the variants silently -- which is exactly what the server-side provider
// filter used to do to every row. Matching happens in ONE place now,
// playbookFor(), and it lowercases before it compares.

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
  // First non-flag arg is the portal filter; flags (--force) may follow it.
  const only = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
  const force = process.argv.includes("--force");
  const SKIP_DAYS = Number(process.env.HOUSY_SWEEP_SKIP_DAYS || 25);
  // Accounts the utility OWES money to. Collected across every portal and
  // printed together at the end, because a credit sitting quietly on one
  // account among forty is exactly the thing nobody notices -- and it is
  // refundable by cheque if someone asks.
  const inCredit = [];
  const portals = Object.keys(PLAYBOOKS).filter(p => !only || p === only);
  const summary = [];

  // Ask for the company's utility rows and nothing else. Sending the alias
  // list looked like a helpful pre-filter and was the reason this never read
  // a single bill: api/ai.js applies it as .in("provider", aliases), which is
  // exact and case-sensitive, while the aliases are lowercase and production
  // holds "BGE", "Pepco", "WSSC". All 78 rows were dropped server-side and
  // the sweep reported "no utility rows for this company" for every portal.
  //
  // Filtering here was never load-bearing anyway -- the line below resolves
  // every row through playbookFor(), which IS case-insensitive and is the
  // authoritative answer. One filter that works beats two that disagree.
  const { targets } = await api("sweep-targets", { companyId: COMPANY });

  for (const portal of portals) {
    const book = PLAYBOOKS[portal];
    const provider = book.provider;
    // Resolve each row through the alias table rather than comparing
    // strings: that is what lets one playbook serve "Wash Gas" and
    // "Washington Gas" both.
    const mine = (targets || []).filter(t => playbookFor(t.provider)?.key === portal);
    if (mine.length && !book.verified) {
      // An unverified playbook is a hypothesis, and saying so is the
      // difference between "Housy read your bill" and "Housy read
      // something off a page nobody has checked".
      console.log(`${provider}: playbook is UNVERIFIED — treat the reading as unconfirmed until a signed-in run proves it`);
    }
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
    // Each pass carries its target, so an account whose current statement is
    // already on file can be skipped without a portal round-trip. WSSC-style
    // portals that expose no account number fall back to a single self-
    // identifying pass.
    const passes = withAccounts.length
      ? withAccounts.map(t => ({ account: t.account_number, last_bill_at: t.last_bill_at, property: t.property }))
      : [{ account: null, last_bill_at: null, property: null }];

    let read = 0, failed = 0, unmatched = 0, needsSignin = 0, skipped = 0;
    for (const pass of passes) {
      const account = pass.account;

      // Utility bills are monthly. If this account's most recent bill is newer
      // than SKIP_DAYS, the current statement is already stored -- reading and
      // re-downloading it daily is wasted portal load. `--force` overrides, for
      // a deliberate backfill.
      if (!force && pass.last_bill_at) {
        const ageDays = (Date.now() - new Date(pass.last_bill_at).getTime()) / 86400000;
        if (ageDays < SKIP_DAYS) {
          skipped++;
          console.log(`  ${provider.padEnd(15)} ${String(pass.property || account).slice(0, 30).padEnd(32)}   current bill on file (${String(pass.last_bill_at).slice(0, 10)}) — skipped`);
          continue;
        }
      }

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
        // Signed. A credit arrives negative and is stored negative, so the
        // in-credit report is a plain amount < 0 and nothing downstream has
        // to remember a separate flag to avoid paying money that is owed TO
        // this company.
        amount: r.amount_due ?? null, due: r.due_date ?? null, error: r.error ?? null,
      }).catch(e => ({ reason: e.message }));

      // File the statement against the bill the reading landed on. Best
      // effort: the reading is already recorded and a bill without its PDF
      // is still a bill, so nothing here can turn a good read into a failure.
      if (r.outcome === "ok" && rec?.billId && r.statement_pdf) {
        try {
          const fsx = require("fs");
          if (fsx.existsSync(r.statement_pdf)) {
            await api("attach-bill-document", {
              companyId: COMPANY, billId: rec.billId,
              pdfBase64: fsx.readFileSync(r.statement_pdf).toString("base64"),
              filename: `${provider}-${account || r.property || "statement"}`,
            });
            fsx.unlinkSync(r.statement_pdf);
          }
        } catch (e) { /* the figure is the job; the document is evidence */ }
      }

      const who = r.property || account || "?";
      if (r.outcome === "ok") {
        read++;
        if (!rec?.updated) unmatched++;
        if (r.credit_balance != null) inCredit.push({ provider, who, credit: r.credit_balance });
        const figure = r.credit_balance != null
          ? `CREDIT $${Number(r.credit_balance).toFixed(2)}`.padStart(11)
          : `$${Number(r.amount_due).toFixed(2)}`.padStart(11);
        console.log(`  ${provider.padEnd(15)} ${String(who).slice(0, 30).padEnd(32)} ${figure}  due ${r.due_date || "?"}   ${rec?.reason || ""}`);
      } else {
        failed++;
        console.log(`  ${provider.padEnd(15)} ${String(who).slice(0, 30).padEnd(32)} ${r.outcome}: ${String(r.error || "").slice(0, 46)}`);
      }
    }

    summary.push({ provider, read, skipped, failed, unmatched, needsSignin });
  }

  if (inCredit.length) {
    console.log("\n=== ACCOUNTS IN CREDIT — these utilities owe money back ===");
    for (const c of inCredit) {
      console.log(`  ${c.provider.padEnd(15)} ${String(c.who).slice(0, 34).padEnd(36)} owes you $${Number(c.credit).toFixed(2)}`);
    }
    console.log("  (request a refund cheque from the utility for these)");
  }

  console.log("\n" + JSON.stringify({ swept: summary, inCredit, at: new Date().toISOString() }, null, 2));
  // Non-zero when a session needs a person, so the timer surfaces it as a
  // unit failure instead of it scrolling past in a log nobody opens.
  process.exit(summary.some(s => s.needsSignin) ? 2 : 0);
})().catch(e => { console.error(String(e.message)); process.exit(1); });
