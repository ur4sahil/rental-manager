// Bank reconciliation stress test — 225 transactions across 2025,
// year-end cluster, 12 month-by-month reconciliations.
//
// Targets Smith Properties LLC. Every artifact is tagged via a
// dedicated bank_account_feed (TEST_FEED_NAME) so cleanup is one
// DELETE per related table. Run with:
//   cd tests && node bank-recon-stress.test.js
// Cleanup with:
//   cd tests && node bank-recon-stress.test.js --cleanup

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const COMPANY_ID = "dce4974d-afa9-4e65-afdf-1189b815195d"; // Smith Properties LLC
const TEST_FEED_NAME = "TEST 2025 Operating (Auto-test)";
const CHECKING_ACCT = "0cc99dd8-8ae8-4aed-830a-43e2ddc11386"; // 1000 Checking
const REPAIRS_ACCT = "1264efcf-7191-4ec9-abd3-8f7399341e4e";  // 5300
const UTIL_ACCT    = "614e6d23-d245-4144-8e9e-435af4a746f7";  // 5400
const RENT_INCOME_CODE = "4000"; // resolve at runtime

const errors = [];
function logErr(phase, msg, raw) {
  errors.push({ phase, msg, raw: raw?.message || raw });
  console.log(`  ❌ [${phase}] ${msg}${raw ? " — " + (raw.message || raw) : ""}`);
}
function logOk(msg) { console.log(`  ✓ ${msg}`); }

// --- Cleanup -----------------------------------------------------
async function cleanup() {
  console.log("\nCleaning up test data…");
  const { data: feed } = await sb.from("bank_account_feed").select("id")
    .eq("company_id", COMPANY_ID).eq("account_name", TEST_FEED_NAME).maybeSingle();
  if (!feed) { console.log("  no test feed found, nothing to clean"); return; }
  const feedId = feed.id;
  // Get all txn IDs first
  const { data: txns } = await sb.from("bank_feed_transaction").select("id")
    .eq("company_id", COMPANY_ID).eq("bank_account_feed_id", feedId);
  const txnIds = (txns || []).map(t => t.id);
  console.log(`  feed ${feedId}, ${txnIds.length} txns to clean`);
  // JE refs follow BANK-<txnId>
  const refs = txnIds.map(id => "BANK-" + id);
  if (refs.length > 0) {
    // chunk to avoid URL length limit
    const chunks = [];
    for (let i = 0; i < refs.length; i += 100) chunks.push(refs.slice(i, i + 100));
    for (const chunk of chunks) {
      const { data: jes } = await sb.from("acct_journal_entries").select("id")
        .eq("company_id", COMPANY_ID).in("reference", chunk);
      const jeIds = (jes || []).map(j => j.id);
      if (jeIds.length > 0) {
        await sb.from("acct_journal_lines").delete().in("journal_entry_id", jeIds);
        await sb.from("acct_journal_entries").delete().in("id", jeIds);
      }
    }
    logOk(`removed JEs for ${refs.length} txns`);
  }
  // Bank posting decisions
  if (txnIds.length > 0) {
    const { data: decisions } = await sb.from("bank_posting_decision").select("id")
      .in("bank_feed_transaction_id", txnIds);
    const decIds = (decisions || []).map(d => d.id);
    if (decIds.length > 0) {
      await sb.from("bank_posting_decision_line").delete().in("bank_posting_decision_id", decIds);
      await sb.from("bank_posting_decision").delete().in("id", decIds);
    }
    await sb.from("bank_feed_transaction_link").delete().in("bank_feed_transaction_id", txnIds);
    await sb.from("bank_feed_transaction").delete().in("id", txnIds);
    logOk(`removed ${txnIds.length} bank txns + decisions + links`);
  }
  // Reconciliations tagged via notes
  await sb.from("bank_reconciliations").delete().eq("company_id", COMPANY_ID).like("notes", "TEST2025%");
  logOk("removed test reconciliations");
  // Feed itself
  await sb.from("bank_account_feed").delete().eq("id", feedId);
  logOk("removed test bank feed");
}

if (process.argv.includes("--cleanup")) {
  cleanup().then(() => process.exit(0));
  return;
}

// --- Generate transactions ---------------------------------------
const TENANTS = [
  { name: "Sahil Agarwal",    rent: 1500 },
  { name: "Anish Gupta",      rent: 1800 },
  { name: "Sheeba Soin",      rent: 1700 },
  { name: "Shruti gupta",     rent: 3500 },
  { name: "Falana Dhimkana",  rent: 2300 },
  { name: "Andrea Wilson",    rent: 1700 },
];
const VENDORS = ["ACME Plumbing", "City Electric", "Roof Pro Inc", "GreenLawn LLC", "Allstate Insurance", "BGE", "WSSC Water", "Comcast Business", "PM Mortgage Co", "Home Depot", "Lowes"];

function fingerprint(t) {
  return crypto.createHash("sha256").update([t.posted_date, t.amount, t.bank_description_raw, t.provider_transaction_id].join("|")).digest("hex");
}

function genTransactions() {
  const txns = [];
  let seq = 0;
  for (let m = 0; m < 12; m++) {
    const yyyy = 2025;
    const mm = m + 1;
    // Rent inflows — each tenant's rent posted on the 3rd–7th of the month.
    for (const t of TENANTS) {
      const day = 3 + Math.floor(Math.random() * 5);
      const date = `${yyyy}-${String(mm).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      txns.push({
        provider_transaction_id: `TEST2025-${++seq}`,
        posted_date: date,
        amount: t.rent,
        direction: "inflow",
        bank_description_raw: `ACH DEPOSIT RENT - ${t.name.toUpperCase()}`,
        payee_normalized: t.name,
        category: "rent",
      });
    }
    // Mortgage outflow on the 1st
    txns.push({
      provider_transaction_id: `TEST2025-${++seq}`,
      posted_date: `${yyyy}-${String(mm).padStart(2,"0")}-01`,
      amount: 5200, direction: "outflow",
      bank_description_raw: "PM MORTGAGE CO - PROPERTY MORTGAGE",
      payee_normalized: "PM Mortgage Co",
      category: "mortgage",
    });
    // Utilities — 2 outflows mid-month
    for (const u of ["BGE", "WSSC Water"]) {
      const day = 12 + Math.floor(Math.random() * 6);
      txns.push({
        provider_transaction_id: `TEST2025-${++seq}`,
        posted_date: `${yyyy}-${String(mm).padStart(2,"0")}-${String(day).padStart(2,"0")}`,
        amount: 60 + Math.floor(Math.random() * 240),
        direction: "outflow",
        bank_description_raw: `${u} UTILITY BILL`,
        payee_normalized: u, category: "utility",
      });
    }
    // 5-8 repairs/vendor outflows per month
    const repairs = 5 + Math.floor(Math.random() * 4);
    for (let r = 0; r < repairs; r++) {
      const v = VENDORS[Math.floor(Math.random() * VENDORS.length)];
      const day = 8 + Math.floor(Math.random() * 18);
      txns.push({
        provider_transaction_id: `TEST2025-${++seq}`,
        posted_date: `${yyyy}-${String(mm).padStart(2,"0")}-${String(day).padStart(2,"0")}`,
        amount: 120 + Math.floor(Math.random() * 1500),
        direction: "outflow",
        bank_description_raw: `${v.toUpperCase()} - INVOICE`,
        payee_normalized: v, category: "repair",
      });
    }
    // 1 misc late-fee inflow for some months
    if (Math.random() < 0.4) {
      txns.push({
        provider_transaction_id: `TEST2025-${++seq}`,
        posted_date: `${yyyy}-${String(mm).padStart(2,"0")}-${String(20 + Math.floor(Math.random() * 8)).padStart(2,"0")}`,
        amount: 50 + Math.floor(Math.random() * 100),
        direction: "inflow",
        bank_description_raw: `LATE FEE PAYMENT`,
        payee_normalized: "Late Fee", category: "rent",
      });
    }
    // Quarterly insurance (Mar, Jun, Sep, Dec)
    if ([2, 5, 8, 11].includes(m)) {
      txns.push({
        provider_transaction_id: `TEST2025-${++seq}`,
        posted_date: `${yyyy}-${String(mm).padStart(2,"0")}-15`,
        amount: 1850, direction: "outflow",
        bank_description_raw: "ALLSTATE INSURANCE QTR PREMIUM",
        payee_normalized: "Allstate Insurance", category: "insurance",
      });
    }
  }
  // Year-end stress: Dec 28-31 cluster (prepaid Jan rents + last-minute items)
  for (const t of TENANTS) {
    txns.push({
      provider_transaction_id: `TEST2025-${++seq}`,
      posted_date: `2025-12-30`, amount: t.rent, direction: "inflow",
      bank_description_raw: `ACH PREPAY JAN RENT - ${t.name.toUpperCase()}`,
      payee_normalized: t.name, category: "rent",
    });
  }
  // Year-end vendor flush
  for (let i = 0; i < 4; i++) {
    txns.push({
      provider_transaction_id: `TEST2025-${++seq}`,
      posted_date: `2025-12-${28 + i}`,
      amount: 200 + Math.floor(Math.random() * 800), direction: "outflow",
      bank_description_raw: `YEAR-END ${VENDORS[i].toUpperCase()} INVOICE`,
      payee_normalized: VENDORS[i], category: "repair",
    });
  }
  // Year-end fee charge on Dec 31
  txns.push({
    provider_transaction_id: `TEST2025-${++seq}`,
    posted_date: `2025-12-31`, amount: 35, direction: "outflow",
    bank_description_raw: "BANK YEAR-END SERVICE CHARGE",
    payee_normalized: "Bank Fees", category: "utility",
  });
  return txns;
}

// --- Setup feed --------------------------------------------------
async function setupFeed() {
  // Idempotent — return existing if found
  const { data: existing } = await sb.from("bank_account_feed").select("id")
    .eq("company_id", COMPANY_ID).eq("account_name", TEST_FEED_NAME).maybeSingle();
  if (existing) { logOk(`reusing existing test feed ${existing.id}`); return existing.id; }
  const { data: feed, error } = await sb.from("bank_account_feed").insert([{
    company_id: COMPANY_ID,
    gl_account_id: CHECKING_ACCT,
    account_name: TEST_FEED_NAME,
    masked_number: "***0000",
    account_type: "checking",
    institution_name: "Test Bank",
    connection_type: "csv",
    status: "active",
  }]).select("id").maybeSingle();
  if (error || !feed) throw new Error("feed insert failed: " + (error?.message || "no id"));
  logOk(`created test feed ${feed.id}`);
  return feed.id;
}

// --- Insert bank txns --------------------------------------------
async function insertTxns(feedId, txns) {
  console.log(`\nInserting ${txns.length} bank txns…`);
  const { data: batch, error: batchErr } = await sb.from("bank_import_batch").insert([{
    company_id: COMPANY_ID,
    bank_account_feed_id: feedId,
    source_type: "csv",
    original_filename: "test-2025-stress.csv",
    row_count: txns.length,
  }]).select("id").maybeSingle();
  if (batchErr) { logErr("setup", "batch insert failed", batchErr); return null; }
  const rows = txns.map(t => ({
    company_id: COMPANY_ID,
    bank_account_feed_id: feedId,
    bank_import_batch_id: batch.id,
    source_type: "csv",
    provider_transaction_id: t.provider_transaction_id,
    posted_date: t.posted_date,
    amount: t.direction === "inflow" ? t.amount : -t.amount,
    direction: t.direction,
    bank_description_raw: t.bank_description_raw,
    bank_description_clean: t.bank_description_raw,
    payee_normalized: t.payee_normalized,
    fingerprint_hash: fingerprint(t),
    status: "for_review",
  }));
  // Chunk inserts to avoid payload size limits
  const inserted = [];
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    const { data, error } = await sb.from("bank_feed_transaction").insert(chunk).select("id, provider_transaction_id, amount, direction, posted_date, bank_description_raw, payee_normalized");
    if (error) { logErr("insertTxns", `chunk ${i} insert failed`, error); continue; }
    inserted.push(...(data || []));
  }
  logOk(`inserted ${inserted.length}/${rows.length} txns`);
  // Stitch category back onto inserted rows by provider_transaction_id
  const catBy = Object.fromEntries(txns.map(t => [t.provider_transaction_id, t.category]));
  inserted.forEach(r => { r.category = catBy[r.provider_transaction_id]; });
  return inserted;
}

// --- Resolve account by code -------------------------------------
async function resolveAccount(code) {
  const { data } = await sb.from("acct_accounts").select("id, name").eq("company_id", COMPANY_ID).eq("code", code).maybeSingle();
  return data;
}

// --- Accept (post JE) for each txn -------------------------------
async function acceptAll(txns, feedId) {
  console.log(`\nPosting JEs for ${txns.length} txns…`);
  const rentIncome = await resolveAccount(RENT_INCOME_CODE);
  if (!rentIncome) { logErr("accept", "could not resolve 4000 Rental Income"); return; }
  // Pre-compute next JE number once and increment locally — chunked
  // queries against acct_journal_entries.number get slow at 200+ rows
  // and racy if we re-read each loop.
  const { data: maxJE } = await sb.from("acct_journal_entries").select("number")
    .eq("company_id", COMPANY_ID).order("number", { ascending: false }).limit(1).maybeSingle();
  let nextNum = 1;
  if (maxJE?.number) {
    const parsed = parseInt(maxJE.number.replace("JE-",""), 10);
    if (!isNaN(parsed)) nextNum = parsed + 1;
  }
  let posted = 0, failed = 0;
  for (const t of txns) {
    const isInflow = t.direction === "inflow";
    const abs = Math.abs(t.amount);
    let categoryAcct;
    if (t.category === "rent") categoryAcct = rentIncome;
    else if (t.category === "repair") categoryAcct = { id: REPAIRS_ACCT, name: "Repairs & Maintenance" };
    else if (t.category === "utility") categoryAcct = { id: UTIL_ACCT, name: "Utilities Expense" };
    else if (t.category === "mortgage") categoryAcct = { id: REPAIRS_ACCT, name: "Repairs & Maintenance" }; // proxy
    else if (t.category === "insurance") categoryAcct = { id: UTIL_ACCT, name: "Utilities Expense" }; // proxy
    else { logErr("accept", `unknown category ${t.category} for txn ${t.id}`); failed++; continue; }
    const lines = isInflow
      ? [{ account_id: CHECKING_ACCT, account_name: "Checking Account", debit: abs, credit: 0, memo: t.bank_description_raw },
         { account_id: categoryAcct.id, account_name: categoryAcct.name, debit: 0, credit: abs, memo: t.bank_description_raw }]
      : [{ account_id: categoryAcct.id, account_name: categoryAcct.name, debit: abs, credit: 0, memo: t.bank_description_raw },
         { account_id: CHECKING_ACCT, account_name: "Checking Account", debit: 0, credit: abs, memo: t.bank_description_raw }];
    const jeNumber = `JE-${String(nextNum).padStart(4,"0")}`;
    nextNum++;
    const { data: jeRow, error: jeErr } = await sb.from("acct_journal_entries").insert([{
      company_id: COMPANY_ID, number: jeNumber, date: t.posted_date,
      description: `${t.payee_normalized || ""} — ${t.bank_description_raw}`,
      reference: `BANK-${t.id}`, property: "", status: "posted",
    }]).select("id").maybeSingle();
    if (jeErr || !jeRow) { logErr("accept", `JE insert failed for txn ${t.id}`, jeErr); failed++; continue; }
    const { error: linesErr } = await sb.from("acct_journal_lines").insert(lines.map(l => ({
      journal_entry_id: jeRow.id, company_id: COMPANY_ID,
      account_id: l.account_id, account_name: l.account_name,
      debit: l.debit, credit: l.credit, class_id: null, memo: l.memo,
      bank_feed_transaction_id: t.id,
    })));
    if (linesErr) {
      await sb.from("acct_journal_entries").delete().eq("id", jeRow.id);
      logErr("accept", `JE lines insert failed for txn ${t.id}`, linesErr);
      failed++;
      continue;
    }
    // Update bank_feed_transaction status
    const { error: updErr } = await sb.from("bank_feed_transaction").update({ status: "posted" }).eq("id", t.id);
    if (updErr) logErr("accept", `status update failed for txn ${t.id}`, updErr);
    posted++;
  }
  logOk(`posted ${posted}/${txns.length} (${failed} failures)`);
  return posted;
}

// --- Run reconciliations month by month --------------------------
async function reconcileMonths(feedId) {
  console.log(`\nReconciling 12 months…`);
  let runningBal = 0;
  for (let m = 1; m <= 12; m++) {
    const start = `2025-${String(m).padStart(2,"0")}-01`;
    const lastDay = new Date(2025, m, 0).getDate();
    const end = `2025-${String(m).padStart(2,"0")}-${String(lastDay).padStart(2,"0")}`;
    // Sum bank txns in window
    const { data: txns, error } = await sb.from("bank_feed_transaction")
      .select("amount, id")
      .eq("company_id", COMPANY_ID)
      .eq("bank_account_feed_id", feedId)
      .gte("posted_date", start).lte("posted_date", end);
    if (error) { logErr("recon", `txn fetch ${m} failed`, error); continue; }
    const monthChange = (txns || []).reduce((s, t) => s + Number(t.amount || 0), 0);
    const endingBalance = runningBal + monthChange;
    // Pull GL lines for the same window on Checking
    const { data: glLines, error: glErr } = await sb.from("acct_journal_lines")
      .select("debit, credit, acct_journal_entries!inner(date, status, reference)")
      .eq("company_id", COMPANY_ID)
      .eq("account_id", CHECKING_ACCT)
      .neq("acct_journal_entries.status", "voided")
      .like("acct_journal_entries.reference", "BANK-%")
      .gte("acct_journal_entries.date", start)
      .lte("acct_journal_entries.date", end);
    if (glErr) { logErr("recon", `GL fetch ${m} failed`, glErr); continue; }
    const glChange = (glLines || []).reduce((s, l) => s + Number(l.debit || 0) - Number(l.credit || 0), 0);
    const diff = Math.round((monthChange - glChange) * 100) / 100;
    const status = diff === 0 ? "✓" : "❌";
    console.log(`  ${status} ${start.slice(0,7)} — ${(txns || []).length} txns, bank Δ ${monthChange.toFixed(2)}, GL Δ ${glChange.toFixed(2)}, diff ${diff}`);
    if (diff !== 0) logErr("recon", `${start.slice(0,7)} bank vs GL mismatch ${diff}`);
    // Save reconciliation row
    const { error: recErr } = await sb.from("bank_reconciliations").insert([{
      company_id: COMPANY_ID,
      period: start.slice(0,7),
      bank_ending_balance: endingBalance,
      book_balance: runningBal + glChange,
      difference: diff,
      status: diff === 0 ? "reconciled" : "discrepancy",
      reconciled_items: { count: (txns || []).length },
      unreconciled_items: { count: 0 },
      notes: "TEST2025 month " + m,
      reconciled_by: "test-script",
      reconciled_at: new Date().toISOString(),
    }]);
    if (recErr) logErr("recon", `bank_reconciliations insert ${m} failed`, recErr);
    runningBal = endingBalance;
  }
  console.log(`\nFinal ending balance after Dec: $${runningBal.toFixed(2)}`);
}

(async () => {
  console.log("Bank Reconciliation Stress Test — 2025 (Smith Properties LLC)");
  console.log("================================================================");
  // Always start clean to make the test rerunnable
  await cleanup();
  const feedId = await setupFeed();
  const txnsData = genTransactions();
  console.log(`\nGenerated ${txnsData.length} synthetic transactions`);
  const inserted = await insertTxns(feedId, txnsData);
  if (!inserted || inserted.length === 0) { console.log("aborting — no txns inserted"); return; }
  await acceptAll(inserted, feedId);
  await reconcileMonths(feedId);
  console.log("\n================================================================");
  if (errors.length === 0) {
    console.log("✓ NO ERRORS — full pipeline succeeded.");
  } else {
    console.log(`❌ ${errors.length} ERRORS:`);
    for (const e of errors.slice(0, 30)) console.log(`  [${e.phase}] ${e.msg}${e.raw ? " — " + e.raw : ""}`);
    if (errors.length > 30) console.log(`  …and ${errors.length - 30} more`);
  }
})();
