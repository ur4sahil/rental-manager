#!/usr/bin/env node
// The payment path with its guards actually connected.
//
//   node worker/portals/pay-runner.js --queue                  (dry run the queue)
//   node worker/portals/pay-runner.js --queue --live           (pay what was approved)
//   node worker/portals/pay-runner.js washington_gas 210005444463 27.66            (dry run)
//   node worker/portals/pay-runner.js washington_gas 210005444463 27.66 --live
//
// pay-bill.js checks the PAGE. This checks the RECORD, and the two are
// different jobs. Everything below exists because the page cannot tell you
// whether you already paid this bill ten minutes ago.
//
// The sequence, and why it is this order:
//
//   1. Record the intent FIRST, with a unique key on
//      (company, utility, statement, amount). The unique index -- not
//      application logic -- is what makes a second attempt impossible;
//      two runners racing is exactly when application logic loses.
//
//   2. A person approves that specific amount. Nothing reaches step 3
//      without a name against it.
//
//   3. claim_utility_payment() flips it to 'submitting' INSIDE the
//      transaction that selects it, checking the kill switch, the
//      per-payment cap and the daily cap in SQL. So the row says a payment
//      is in flight BEFORE the browser is even opened -- if this process
//      dies mid-click, the evidence already exists.
//
//   4. Only then does the browser run.
//
//   5. The outcome is recorded. 'unknown' is terminal: a payment whose
//      result nobody could read is NOT retried, because retrying an
//      unknown is how one payment becomes two.
const { createClient } = require("@supabase/supabase-js");
const { spawn } = require("child_process");
const path = require("path");

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const COMPANY = process.env.HOUSY_COMPANY_ID;

function die(msg) { console.error(msg); process.exit(1); }

if (!SUPABASE_URL || !SUPABASE_KEY) die("SUPABASE_URL and a service key are required");
if (!COMPANY) die("HOUSY_COMPANY_ID is required");

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// The statement this payment settles. Included in the key so next month's
// identical amount is a DIFFERENT payment, while a retry of this one is the
// same payment and is refused.
function idemKey({ provider, account, amount, statement }) {
  return `${provider}:${account}:${statement}:${Number(amount).toFixed(2)}`;
}

// POST A CONFIRMED PAYMENT BACK TO THE APP.
//
// Marks the bill paid and files the receipt as a document against the
// property. Deliberately posts no journal entry: the debit arrives through
// the bank feed, and booking it here as well would show the same payment
// twice.
async function recordPayment({ paymentId, billId, amount, confirmation, receiptPath }) {
  const AI = process.env.AI_BASE_URL || "https://housy.housify365.com";
  const token = process.env.AI_TOKEN || "";
  let receiptBase64 = null;
  if (receiptPath) {
    try {
      const fs2 = require("fs");
      if (fs2.existsSync(receiptPath)) receiptBase64 = fs2.readFileSync(receiptPath).toString("base64");
    } catch { /* the payment stands whether or not the receipt survives */ }
  }
  const r = await fetch(`${AI}/api/ai`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      action: "record-utility-payment",
      companyId: COMPANY, paymentId, billId, amount,
      confirmation: confirmation || null,
      paidOn: new Date().toISOString().slice(0, 10),
      receiptBase64, receiptFilename: receiptPath ? require("path").basename(receiptPath) : null,
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) console.error(`  could not record the payment in the app: ${body.error || r.status}`);
  else if (body.receipt_error) console.error(`  payment recorded; the receipt did not file: ${body.receipt_error}`);
  else console.log(`  recorded in the app${body.receipt_document_id ? " and the receipt filed against the property" : ""}`);
  return body;
}

// Run one approved payment end to end. Returns its outcome.
async function runOne(pay, live) {
  const label = `${pay.provider} · bill ${pay.bill_id} · $${Number(pay.approved_amount).toFixed(2)}`;
  console.log(`\n${live ? "LIVE" : "DRY RUN"} · ${label}`);

  // The account number comes from the BILL, not the payment: the portal is
  // asserted against it before anything is filled.
  const { data: bill } = await sb.from("utility_bills")
    .select("id, account_number, utility_account_id, property")
    .eq("id", pay.bill_id).eq("company_id", COMPANY).maybeSingle();
  let account = bill?.account_number || null;
  if (!account && bill?.utility_account_id) {
    const { data: acct } = await sb.from("utility_accounts")
      .select("account_number").eq("id", bill.utility_account_id).eq("company_id", COMPANY).maybeSingle();
    account = acct?.account_number || null;
  }
  if (!account) {
    await sb.from("utility_payments").update({ status: "failed",
      error: "no account number on the bill or its utility account — the portal cannot be checked against it",
    }).eq("id", pay.id).eq("company_id", COMPANY);
    console.error("  refused: no account number to assert the portal against");
    return "failed";
  }

  if (live) {
    const { data: claim, error: cErr } = await sb.rpc("claim_utility_payment", {
      p_company_id: COMPANY, p_id: pay.id, p_worker: process.env.HOUSY_WORKER_NAME || "pay-runner",
    });
    const c = Array.isArray(claim) ? claim[0] : claim;
    if (cErr || !c?.ok) {
      console.error(`  refused: ${c?.reason || cErr?.message}`);
      return "refused";
    }
    console.log("  claimed — the record now says a payment is in flight");
  }

  const args = [path.join(__dirname, "pay-bill.js"), pay.provider, account, String(pay.approved_amount)];
  if (live) args.push("--live");
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let out = "";
  child.stdout.on("data", d => { out += d; process.stdout.write(d); });
  child.stderr.on("data", d => process.stderr.write(d));
  await new Promise(r => child.on("close", r));
  let result = {};
  try { result = JSON.parse(out.slice(out.lastIndexOf("{"), out.lastIndexOf("}") + 1)); } catch {}

  if (!live) return result.outcome || "dry_run";

  const status = ({ ok: "paid", unknown: "unknown" })[result.outcome] || "failed";
  await sb.from("utility_payments").update({
    status,
    confirmation_ref: result.confirmation || null,
    screenshot_path: result.screenshot || null,
    error: status === "paid" ? null : (result.error || `run ended as ${result.outcome}`),
    settled_at: status === "paid" ? new Date().toISOString() : null,
  }).eq("id", pay.id).eq("company_id", COMPANY);

  // Only a CONFIRMED payment touches the bill. 'unknown' leaves the bill
  // alone and leaves a person to check the portal -- marking it paid on a
  // guess is how a bill gets paid twice next month.
  if (status === "paid") {
    await recordPayment({
      paymentId: pay.id, billId: pay.bill_id, amount: Number(pay.approved_amount),
      confirmation: result.confirmation, receiptPath: result.receipt,
    });
  } else if (status === "unknown") {
    console.error("  UNKNOWN — submitted but unconfirmed. Check the portal; this will not be retried.");
  }
  return status;
}

// Drain every approved payment. This is what the app's Pay button feeds.
async function drainQueue(live) {
  const { data: queue, error } = await sb.from("utility_payments")
    .select("id, provider, bill_id, approved_amount, approved_by, property, status")
    .eq("company_id", COMPANY).eq("status", "approved")
    .order("approved_at", { ascending: true }).limit(25);
  if (error) die(`could not read the queue: ${error.message}`);
  if (!queue || !queue.length) { console.log("nothing approved and waiting"); return; }

  console.log(`${queue.length} approved payment(s) waiting${live ? "" : " — DRY RUN, nothing will be submitted"}`);
  const tally = {};
  for (const pay of queue) {
    // One at a time, on purpose. These are irreversible and a shared browser
    // session is the thing that gets confused about which account is selected.
    const outcome = await runOne(pay, live);
    tally[outcome] = (tally[outcome] || 0) + 1;
  }
  console.log(`\n${JSON.stringify(tally)}`);
}

(async () => {
  if (process.argv.includes("--queue")) {
    await drainQueue(process.argv.includes("--live"));
    return;
  }
  const [portal, account, amountRaw] = process.argv.slice(2);
  const live = process.argv.includes("--live");
  const amount = Number(amountRaw);
  if (!portal || !account || !Number.isFinite(amount) || amount <= 0) {
    die("usage: pay-runner.js <portal> <account> <amount> [--live] [--statement YYYY-MM]");
  }
  const sIdx = process.argv.indexOf("--statement");
  const statement = sIdx > -1 ? process.argv[sIdx + 1] : new Date().toISOString().slice(0, 7);
  const key = idemKey({ provider: portal, account, amount, statement });

  console.log(`\n${live ? "LIVE" : "DRY RUN"} · ${portal} · account ${account} · $${amount.toFixed(2)} · statement ${statement}`);
  console.log(`idempotency key: ${key}\n`);

  // ---- 1. has this already been paid? ---------------------------------
  const { data: existing } = await sb.from("utility_payments")
    .select("id, status, confirmation_ref, submitted_at")
    .eq("company_id", COMPANY).eq("idem_key", key).maybeSingle();

  if (existing) {
    // 'unknown' is the important one: it means a previous run clicked
    // submit and could not read the result. Paying again could double it.
    if (["paid", "submitting", "unknown"].includes(existing.status)) {
      console.log(JSON.stringify({
        outcome: "already_handled", status: existing.status,
        confirmation: existing.confirmation_ref, submitted_at: existing.submitted_at,
        note: existing.status === "unknown"
          ? "a previous run submitted this and could not confirm it — CHECK THE PORTAL, do not rerun"
          : "this statement has already been paid or is in flight",
      }, null, 2));
      process.exit(0);
    }
    console.log(`  an earlier attempt exists in status "${existing.status}" — continuing`);
  }

  // ---- 2. the record, written BEFORE anything else --------------------
  let paymentId = existing?.id;
  if (!paymentId) {
    const { data: made, error } = await sb.from("utility_payments").insert([{
      company_id: COMPANY, provider: portal, idem_key: key,
      approved_amount: amount, observed_amount: amount, statement_ref: statement,
      status: live ? "pending_approval" : "pending_approval",
    }]).select("id").single();
    // A duplicate here means another runner got there first, which is the
    // unique index doing its job.
    if (error) {
      console.log(JSON.stringify({ outcome: "refused", error: error.message,
        note: "a payment with this key already exists — that is the double-payment guard" }, null, 2));
      process.exit(0);
    }
    paymentId = made.id;
    console.log(`  recorded as ${paymentId} (pending_approval)`);
  }

  if (!live) {
    // Dry run stops here on the record side and hands off to the page
    // checks, which prove the form would be filled correctly.
    console.log("  dry run: not approving, not claiming, not paying\n");
  } else {
    // ---- 3. approval, then the atomic claim ---------------------------
    const approver = process.env.HOUSY_APPROVED_BY;
    if (!approver) die("HOUSY_APPROVED_BY is required for --live: a payment needs a name against it");

    await sb.from("utility_payments").update({
      status: "approved", approved_at: new Date().toISOString(), approved_by: approver,
    }).eq("id", paymentId).eq("company_id", COMPANY).eq("status", "pending_approval");

    const { data: claim, error: cErr } = await sb.rpc("claim_utility_payment", {
      p_company_id: COMPANY, p_id: paymentId, p_worker: process.env.HOUSY_WORKER_NAME || "pay-runner",
    });
    const c = Array.isArray(claim) ? claim[0] : claim;
    if (cErr || !c?.ok) {
      console.log(JSON.stringify({ outcome: "refused", reason: c?.reason || cErr?.message,
        note: "the caps, the kill switch or the approval check stopped this" }, null, 2));
      process.exit(0);
    }
    console.log(`  claimed and marked submitting — the record now says a payment is in flight`);
  }

  // ---- 4. the browser -------------------------------------------------
  const args = [path.join(__dirname, "pay-bill.js"), portal, account, String(amount)];
  if (live) args.push("--live");
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let out = "";
  child.stdout.on("data", d => { out += d; process.stdout.write(d); });
  child.stderr.on("data", d => process.stderr.write(d));
  const code = await new Promise(r => child.on("close", r));

  let result = {};
  try { result = JSON.parse(out.slice(out.lastIndexOf("{"), out.lastIndexOf("}") + 1)); } catch {}

  // ---- 5. record what happened ----------------------------------------
  if (live) {
    const map = { ok: "paid", unknown: "unknown" };
    const status = map[result.outcome] || "failed";
    await sb.from("utility_payments").update({
      status,
      confirmation_ref: result.confirmation || null,
      screenshot_path: result.screenshot || null,
      error: status === "paid" ? null : (result.error || `run ended as ${result.outcome}`),
      settled_at: status === "paid" ? new Date().toISOString() : null,
    }).eq("id", paymentId).eq("company_id", COMPANY);
    console.log(`\n  recorded as ${status}${status === "unknown" ? " — this will NOT be retried automatically" : ""}`);
  }

  process.exit(code);
})().catch(e => die(String(e.message)));
