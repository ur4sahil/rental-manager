// Money a prospect pays before they are a tenant (src/utils/prospectMoney.js,
// migration 20261003030000). Held as a liability in an account of the
// prospect's own; read off the ledger; moved to the tenant's ledger on
// conversion; refundable down to zero and never below.
import fs from "fs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (detail ? "\n      " + detail : "")); } };
const read = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");
const src = read("src/utils/prospectMoney.js"), engine = read("src/utils/tenantOnboarding.js"), page = read("src/components/Prospects.js"),
  mig = read("supabase/migrations/20261003030000_prospect_money_held.sql");

// The module imports the Supabase client; lift the pure part out.
const a = src.indexOf("const cents"), b = src.indexOf("/** The prospect's held-money account");
const { summarizeHeld } = new Function(src.slice(a, b).replace(/export /g, "") + "\nreturn { summarizeHeld };")();
const line = (credit, debit, date, status = "posted", extra = {}) => ({ id: Math.random().toString(36).slice(2), credit, debit, acct_journal_entries: { date, status, description: "x", reference: "r", ...extra } });

let s = summarizeHeld([line(1500, 0, "2026-10-02"), line(0, 300, "2026-10-05")]);
ok("received 1,500, refunded 300: 1,200 is held", s.balance === 1200 && s.entries.length === 2);
ok("money in reads as positive, money out as negative", s.entries.find(e => e.date === "2026-10-02").amount === 1500 && s.entries.find(e => e.date === "2026-10-05").amount === -300);
ok("newest first", s.entries[0].date === "2026-10-05");
ok("a voided entry does not count", summarizeHeld([line(1500, 0, "2026-10-02"), line(900, 0, "2026-10-03", "voided")]).balance === 1500);
ok("nothing on the account: nothing held", summarizeHeld([]).balance === 0 && summarizeHeld(null).entries.length === 0);
ok("fully moved to the tenant: zero", summarizeHeld([line(1200, 0, "2026-10-02"), line(0, 1200, "2026-11-01")]).balance === 0);
ok("cents do not drift", summarizeHeld([line(0.1, 0, "2026-10-01"), line(0.2, 0, "2026-10-02"), line(0, 0.3, "2026-10-03")]).balance === 0);
ok("a join returned as an array is read the same way", summarizeHeld([{ id: "1", credit: 50, debit: 0, acct_journal_entries: [{ date: "2026-10-02", status: "posted" }] }]).balance === 50);
ok("a line with no entry behind it is ignored", summarizeHeld([{ id: "1", credit: 50, debit: 0, acct_journal_entries: null }]).balance === 0);

// ── the postings
ok("received: DR Checking / CR the prospect's own account", /\{ account_id: cash, account_name: "Checking Account", debit: amt, credit: 0/.test(src) && /\{ account_id: acct\.id, account_name: "Held - " \+ prospect\.name, debit: 0, credit: amt/.test(src));
ok("refund: DR the held account / CR Checking, and never more than is held", /amt > held\.balance \+ 0\.001\) return \{ ok: false/.test(src) && /\{ account_id: held\.account\.id, account_name: held\.account\.name, debit: amt, credit: 0/.test(src));
ok("a closed period is refused before anything is created", (src.match(/if \(await checkPeriodLock\(companyId, date\)\) return \{ ok: false/g) || []).length === 2);
ok("zero or negative amounts are refused", (src.match(/if \(!\(amt > 0\)\) return \{ ok: false, error: "Enter an amount more than zero\." \}/g) || []).length === 2);
ok("on conversion: DR held / CR the tenant's own receivable, for exactly what is held", /debit: held\.balance, credit: 0/.test(src) && /account_id: arAccountId, account_name: "AR - " \+ tenantName, debit: 0, credit: held\.balance/.test(src));
ok("the move has one reference per tenant, checked before posting", /const ref = "HELD-T" \+ tenantId;/.test(src) && /\.eq\("reference", ref\)\.neq\("status", "voided"\)/.test(src));
ok("money that arrives after the move is flagged, not swept in silently", /arrived after the first move and is still held/.test(src));
ok("the account is closed once nothing is held", /update\(\{ is_active: false \}\)\.eq\("company_id", companyId\)\.eq\("id", held\.account\.id\)/.test(src));
ok("a failed read never reads as 'nothing held'", /if \(!held\.ok\) return \{ status: "failed", detail: "could not read what is held/.test(src));
ok("the engine applies held money for a converted prospect, after the charges", /if \(prospectId\) \{\s*const held = await applyHeldToTenant\(/.test(engine) && engine.indexOf("applyHeldToTenant({") > engine.indexOf("// ── 5. whole months that passed"));
ok("Prospects passes the prospect to the engine on convert and on Finish setup", /prospectId: p\.id,/.test(page));

// ── the page
ok("a prospect with money held cannot be removed", /is still held for " \+ p\.name \+ "\. Refund it before removing them\./.test(page));
ok("a failed check blocks the removal rather than allowing it", /if \(!h\.ok\) \{ showToast\("Could not check whether money is held/.test(page));
ok("conversion waits until what is held has been read", /disabled=\{!!busy \|\| !!blocked \|\| !cHeld \|\| !cHeld\.ok \|\|/.test(page));
ok("the dialog warns about counting a bank deposit twice", /categorise the bank deposit to this prospect on the Banking page, or it is counted twice/.test(page));

// ── the database
ok("the account is tied to the prospect by a real link, one per prospect", /ADD COLUMN IF NOT EXISTS prospect_id uuid REFERENCES public\.prospects\(id\) ON DELETE SET NULL/.test(mig) && /CREATE UNIQUE INDEX IF NOT EXISTS idx_acct_accounts_one_per_prospect/.test(mig));
ok("making the account is staff-only and not callable without a login", /NOT public\.is_company_staff\(v_p\.company_id\)/.test(mig) && /REVOKE ALL ON FUNCTION public\.prospect_held_account\(uuid\) FROM PUBLIC, anon;/.test(mig));
ok("two people at once cannot mint two accounts", /pg_advisory_xact_lock\(hashtext\('prospect_held:' \|\| v_p\.company_id\)\)/.test(mig));
ok("the parent is found by what it is, and a free number is chosen if 2150 is taken", /name = 'Prospect Money Held' AND prospect_id IS NULL/.test(mig) && /generate_series\(2150, 2199\)/.test(mig));
ok("it is a liability", (mig.match(/'Liability', 'Other Current Liability'/g) || []).length === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
