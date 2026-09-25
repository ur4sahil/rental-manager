// Static UI-regression guards for the behavior bugs that reached production in
// Sep 2026 precisely because the suite had no render/interaction layer:
//   1. Lender/insurer PORTAL credential inputs had no autoComplete, so Chrome
//      autofilled them with the user's Google login (showed the wrong creds and
//      clobbered saves).
//   2. Two divergent hardcoded loan-type <option> lists (wizard had ARM, Loans
//      page did not) -> an ARM loan rendered as "Conventional".
//   3. Money amounts as <input type="number"> can't show accounting format
//      (1361250 instead of 1,361,250.00). They must use <MoneyInput>.
// These are cheap greps over source; they can't prove behavior, but they lock
// the specific shapes that broke.
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "  — " + detail : ""}`); }
}

const srcDir = path.join(__dirname, "..", "src");
const compDir = path.join(srcDir, "components");
const files = fs.readdirSync(compDir).filter(f => f.endsWith(".js")).map(f => path.join(compDir, f));
files.push(path.join(srcDir, "ui.js"));
const srcs = files.map(f => ({ file: path.relative(srcDir, f), text: fs.readFileSync(f, "utf8") }));

console.log("==============================================");
console.log("UI regression guards (autofill / loan-type / money format)");
console.log("==============================================");

// ---- 1. Every password Input declares autoComplete ------------------------
{
  const offenders = [];
  for (const { file, text } of srcs) {
    // Match the whole self-closing tag up to `/>`. Using `[^>]*>` would stop at
    // the `>` inside an `onChange={e => ...}` arrow and miss attributes after it.
    const re = /<Input\b[\s\S]*?\/>/g;
    let m;
    while ((m = re.exec(text))) {
      if (/\btype=["']password["']/.test(m[0]) && !/\bautoComplete=/.test(m[0])) {
        offenders.push(`${file}: ${m[0].replace(/\s+/g, " ").slice(0, 90)}`);
      }
    }
  }
  assert("every <Input type=password> sets autoComplete (anti-autofill)",
    offenders.length === 0, offenders.join("  |  ") || "none");
}

// ---- 2. Loan types come from a single source, never hardcoded -------------
// LOAN_TYPES/loanTypeOptions render <option value={t}>; a re-hardcoded list
// would reintroduce literal <option value="FHA"> / value="Conventional">.
{
  const offenders = [];
  for (const { file, text } of srcs) {
    if (/<option value=["'](FHA|Conventional|DSCR|ARM|USDA)["']/.test(text)) {
      offenders.push(file);
    }
  }
  assert("no hardcoded loan-type <option> lists (use loanTypeOptions)",
    offenders.length === 0, offenders.join(", ") || "none");
}

// ---- 3. Money amount fields use MoneyInput, not <Input type=number> --------
// These bindings are dollar amounts; a raw number input can't show accounting
// format. Percentages/days/rates are intentionally excluded.
{
  const MONEY = [
    "original_amount", "current_balance", "monthly_payment", "escrow_amount",
    "premium_amount", "coverage_amount", "annual_tax_amount", "assessed_value",
    "rent_amount", "security_deposit", "amount_returned", "new_amount",
    "paidAmount", "expected_amount", "fee_amount", "management_fee",
    "tenantForm.rent", "recurring.amount", "distForm.amount", "payForm.amount",
    "invoiceForm.amount", "form.amount", "h.amount", "markPaidBill.paidAmount",
    "paymentAmount",
  ];
  const offenders = [];
  for (const { file, text } of srcs) {
    const re = /<Input\b[\s\S]*?\/>/g;
    let m;
    while ((m = re.exec(text))) {
      const tag = m[0];
      if (!/\btype=["']number["']/.test(tag)) continue;
      const vm = tag.match(/value=\{([^}]+)\}/);
      if (!vm) continue;
      const binding = vm[1];
      // skip explicit non-money: percentages / days / rates / years / counts
      if (/pct|percent|_rate\b|rate\b|_day\b|day_of|grace|year|count|qty|beds|baths|sqft/i.test(binding)) continue;
      if (MONEY.some(tok => binding.includes(tok))) {
        offenders.push(`${file}: value={${binding}}`);
      }
    }
  }
  assert("money amount fields use <MoneyInput>, not <Input type=number>",
    offenders.length === 0, offenders.join("  |  ") || "none");
}

console.log("\n----------------------------------------------");
console.log(`✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);
if (failed > 0) process.exit(1);
