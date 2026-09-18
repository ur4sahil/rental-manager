#!/usr/bin/env node
// Watch for payments a PERSON approved in the app, and carry them out.
//
//   node worker/portals/pay-watch.js            (dry run — submits nothing)
//   node worker/portals/pay-watch.js --live     (pays what was approved)
//
// WHAT THIS IS, AND IS NOT
//
// This is NOT payments on a schedule. Nothing here decides that a bill should
// be paid, or when, or how much. A person opens the Utilities page, types the
// amount they want to pay, and presses the button; that writes one approved
// row. This process notices that row and does the clicking.
//
// The distinction matters because it is the difference between "the software
// pays my bills" and "the software does what I just told it to". Only the
// second one is on offer here, and every guard downstream assumes it: the
// claim refuses a payment with nobody's name against it, refuses one over
// the per-payment cap, refuses one that would take a bill past its total,
// and refuses a bill the tenant is responsible for.
//
// It also keeps the session alive on its own, so pressing the button works
// on a Tuesday afternoon without anyone having signed into the gas company
// first. That is ensure-session.js, and it signs in honestly or not at all.
//
// WHY A LOCAL PROCESS
//
// Paying means driving a real browser. Vercel functions cannot, and a cron on
// a server would be the thing this deliberately is not. So it runs on the
// machine a person is already using, polls for their own approvals, and does
// nothing when there are none.
const path = require("path");
const { spawn } = require("child_process");
const { createRequire } = require("module");

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const COMPANY = process.env.HOUSY_COMPANY_ID;
const EVERY_MS = Math.max(5000, Number(process.env.HOUSY_POLL_MS) || 15000);

function die(msg) { console.error(msg); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_KEY) die("SUPABASE_URL and a service key are required");
if (!COMPANY) die("HOUSY_COMPANY_ID is required");

const live = process.argv.includes("--live");
const { createClient } = createRequire(path.join(__dirname, "..", "..", "package.json"))("@supabase/supabase-js");
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const run = (args, label) => new Promise(resolve => {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let out = "";
  child.stdout.on("data", d => { out += d; process.stdout.write(d); });
  child.stderr.on("data", d => { out += d; process.stderr.write(d); });
  child.on("close", code => resolve({ code, out, label }));
});

// Which portals are waiting. Asked before signing into anything, so a tick
// with nothing approved opens no browser at all.
async function waitingPortals() {
  const { data, error } = await sb.from("utility_payments")
    .select("provider")
    .eq("company_id", COMPANY).eq("status", "approved");
  if (error) { console.error(`  could not read the queue: ${error.message}`); return []; }
  return [...new Set((data || []).map(r => r.provider).filter(Boolean))];
}

let working = false;

async function tick() {
  // One at a time. These are irreversible, and a browser session that two
  // ticks are both driving is a session that gets confused about which
  // account is selected.
  if (working) return;
  working = true;
  try {
    const portals = await waitingPortals();
    if (!portals.length) return;

    console.log(`\n[${new Date().toISOString()}] ${portals.length} portal(s) with approved payments: ${portals.join(", ")}`);

    for (const portal of portals) {
      // Sign in if needed. A failure here is reported and the drain is
      // skipped for that portal -- pay-bill would only reach the same wall
      // and report it less clearly.
      const s = await run([path.join(__dirname, "ensure-session.js"), portal], "session");
      if (s.code !== 0) {
        console.error(`  ${portal}: could not establish a session — leaving its payments approved and untouched`);
        continue;
      }
    }

    const args = [path.join(__dirname, "pay-runner.js"), "--queue"];
    if (live) args.push("--live");
    await run(args, "drain");
  } catch (e) {
    console.error(`  tick failed: ${String(e?.message || e)}`);
  } finally {
    working = false;
  }
}

console.log(
  `\nWatching for payments you approve in the app`
  + `\n  company   ${COMPANY}`
  + `\n  every     ${Math.round(EVERY_MS / 1000)}s`
  + `\n  mode      ${live ? "LIVE — approved payments will be submitted" : "DRY RUN — nothing will be submitted"}`
  + `\n\nNothing here decides to pay anything. Press the button in the app and this`
  + `\ncarries it out. Ctrl-C to stop.\n`
);

tick();
const timer = setInterval(tick, EVERY_MS);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    clearInterval(timer);
    console.log("\nstopped watching.");
    process.exit(0);
  });
}
