// The portal worker's failures must name themselves correctly.
//
// Every bug this file guards had the same shape: the code worked, and told
// us the wrong thing about what it did. That is worse than crashing, because
// a crash sends you to the right place.
//
//   * An expired BGE session reported as `wrong_account` on all 14 rows.
//     fetch-bill sent every signedOutSignal that was not a textbox to
//     getByRole("button"), so the { role: "link" } signal that six of the
//     eight playbooks declare could never match. BGE's logged-out homepage
//     has two "Sign In" LINKS and no such button. You would audit account
//     numbers for a login problem.
//
//   * WSSC demanded a verification code it had never sent. verify-login
//     treated any input whose id contained "code" as a one-time-code box --
//     a postcode field qualifies -- on a page it was already signed in to.
//     It waited six minutes, exited, and discarded a working session while
//     a person searched an inbox for a message no portal had sent.
//
//   * The sweep reported "no utility rows for this company" for every
//     portal while 78 rows sat in the table, because it pre-filtered
//     server-side with lowercase aliases against a case-sensitive .in().
//
// These are asserted against the SOURCE TEXT. The worker drives a browser
// and talks to a local model; none of it can be imported into a unit test.
// Source assertions are weaker than behavioural ones, so each is tied to a
// specific defect and fails loudly if the line that fixed it is reverted.
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}

const W = path.join(__dirname, "..", "worker", "portals");
const read = f => fs.readFileSync(path.join(W, f), "utf8");
const fetchBill = read("fetch-bill.js");
const verifyLogin = read("verify-login.mjs");
const sweep = read("sweep.js");
const playbooksSrc = read("playbooks.js");
const { PLAYBOOKS, playbookFor } = require(path.join(W, "playbooks.js"));

console.log("\n=== PORTAL WORKER ===\n");

// ---- an expired session must not read as a wrong account -----------------
assert(
  "signedOutSignals are looked up by the role they declare",
  /getByRole\(sig\.role \|\| "button"/.test(fetchBill),
  'coercing every non-textbox role to "button" makes the link signal dead code');

assert(
  "no signedOutSignal role is silently rewritten",
  !/sig\.role === "textbox"\s*\?/.test(fetchBill),
  "the ternary that only knew textbox-or-button is what hid the expired session");

// The signals only matter if the playbooks actually declare more than the
// two roles the old dispatch understood.
const roles = new Set();
for (const b of Object.values(PLAYBOOKS)) (b.signedOutSignals || []).forEach(s => roles.add(s.role));
assert(
  "playbooks declare a role the old dispatch could not match",
  roles.has("link"),
  `roles in use: ${[...roles].join(", ")} — if no link signal remains this guard is moot`);

assert(
  "every playbook can still say it is signed out",
  Object.entries(PLAYBOOKS).every(([, b]) => (b.signedOutSignals || []).length > 0),
  "a playbook with no signed-out signal can never report an expired session");

// ---- do not invent a verification code ------------------------------------
assert(
  "being signed in is checked before a code is demanded",
  /const alreadyIn = !\(await onLogin\(\)\)/.test(verifyLogin)
    && verifyLogin.indexOf("const alreadyIn") < verifyLogin.indexOf("const wantsCode"),
  "the code question is moot once we are through, so it must be asked second");

assert(
  "wantsCode cannot fire when already signed in",
  /const wantsCode = !alreadyIn &&/.test(verifyLogin),
  "WSSC was signed in and still told to wait six minutes for a code");

assert(
  'a bare id containing "code" no longer counts as a one-time-code box',
  !/input\[id\*="code" i\]/.test(verifyLogin),
  "postcode, zipcode, area code and promo code all match that selector");

assert(
  "the code step records where the code was sent",
  /destination shown/.test(verifyLogin) && /code-step\.png/.test(verifyLogin),
  '"read me the code" is useless without saying which inbox to open');

// ---- a code must actually have been requested -----------------------------
assert(
  "a delivery choice is pressed rather than waited on",
  /request.{0,12}code|send.{0,12}\(me\|it\)/.test(verifyLogin) && /no code box yet/.test(verifyLogin),
  "portals that ask HOW to send a code have sent nothing until something is clicked");

// ---- a session, once earned, is kept --------------------------------------
assert(
  "verify-login saves the session it earned",
  /storageState\(\)/.test(verifyLogin) && /session saved/.test(verifyLogin),
  "a code costs a person's attention; spending one and keeping nothing wastes it");

assert(
  "fetch-bill reads the session verify-login writes",
  /HOUSY_SESSION_DIR/.test(verifyLogin) && /HOUSY_SESSION_DIR/.test(fetchBill),
  "two different directories means the saved session is never found");

assert(
  "no absolute developer path is baked into the worker",
  !/\/Users\/|\/private\/tmp\/claude/.test(verifyLogin + fetchBill + sweep),
  "SHOT was hardcoded to one laptop and died with EACCES on the VPS");

// ---- the sweep must find the rows it was sent to read ---------------------
assert(
  "the sweep does not pre-filter targets by provider",
  !/providers: knownProviderAliases\(\)/.test(sweep),
  "the server applies it as a case-sensitive .in(); lowercase aliases dropped all 78 rows");

assert(
  "provider matching happens through playbookFor",
  /playbookFor\(t\.provider\)/.test(sweep),
  "one matcher that works beats two that disagree");

// playbookFor is the only matcher now, so it has to handle what is really
// stored: free text somebody typed, in whatever case they typed it.
const realSpellings = [
  ["BGE", "bge"], ["bge", "bge"], ["Washington Gas", "washington_gas"],
  ["Wash Gas", "washington_gas"], ["Pepco", "pepco"], ["WSSC", "wssc"], ["SMECO", "smeco"],
];
for (const [typed, expected] of realSpellings) {
  const got = playbookFor(typed);
  assert(`"${typed}" resolves to ${expected}`, got && got.key === expected,
    `got ${got ? got.key : "no playbook"} — this spelling is in production`);
}

assert(
  "a company name is not mistaken for a utility",
  !playbookFor("Conventus LLC") && !playbookFor("Charles County"),
  "matching these would send a login attempt at the wrong portal");

// ---- the vision fallback must stay a fallback -----------------------------
assert(
  "vision runs only after every selector has failed",
  /if \(amount == null\) \{[\s\S]{0,200}readWithVision/.test(fetchBill),
  "a model must never override a figure the page itself labelled");

assert(
  "a figure read from a picture is marked as such",
  /read_by: readByVision \? "vision" : "selectors"/.test(fetchBill),
  "vision-read money must never arrive indistinguishable from the page's own words");

assert(
  "an implausible vision reading is refused, not rounded",
  /Math\.abs\(n\) > 50000/.test(fetchBill),
  "a model that reads $513.99 as $51399 must not reach the books");

assert(
  "the vision call streams",
  /stream: true/.test(fetchBill.slice(fetchBill.indexOf("readWithVision"))),
  "undici abandons a request whose headers take over 300s, and a cold CPU model crosses that");

// ---- the appliance holds no database credentials --------------------------
assert(
  "the sweep talks to the app, not to the database",
  !/SUPABASE_SERVICE_ROLE_KEY|service_role/.test(sweep) && /AI_WORKER_TOKEN/.test(sweep),
  "the box is a second Always Free tenancy; a service key there bypasses RLS entirely");

assert(
  "no playbook is marked verified without having been signed in to",
  Object.entries(PLAYBOOKS).every(([, b]) => typeof b.verified === "boolean"),
  "an unverified playbook is a guess, and a guessed URL looks exactly like a blocked portal");

// ─────────────────────────────────────────────────────────────────────
// THE BALANCE READER MUST TOLERATE A DUE DATE BETWEEN LABEL AND FIGURE.
//
// Pepco/BGE (Opower) print "Total Amount Due by 09/23/2026 $345.00": the
// due date sits BETWEEN the label and the dollar amount. The strict
// "amount due: $" candidate matched nothing on this shape, and every owner
// account with a real balance was recorded as "no amount found" on a page
// whose balance was plainly on screen. Verified live 2026-09-22: 11411
// Abbottswood read $345.00 only after the tolerant candidate was added.
//
// A regex over the candidate list, not the browser: this is exactly the
// kind of parsing bug a unit test can hold, and the reason it went unseen
// is that none did.
{
  // Reproduce fetch-bill's own loop: first candidate whose `labelled`
  // pattern hits wins, in order.
  const readAmount = (text) => {
    for (const c of PLAYBOOKS.pepco.amount) {
      if (!c.labelled) continue;
      const m = text.match(c.labelled);
      if (m && m[1]) return Number(m[1].replace(/,/g, ""));
    }
    return null;
  };
  const OPOWER = "Billing Summary As of Today, 4:01 AM ET Total Amount Due by 09/23/2026 $345.00 Usage";
  assert("Opower 'Amount Due by <date> $X' is read (the live Pepco/BGE shape)",
    readAmount(OPOWER) === 345, `got ${readAmount(OPOWER)}`);
  assert("a strict 'Amount Due: $X' still reads",
    readAmount("Amount Due: $123.45") === 123.45);
  assert("a label with no date gap ('Total Amount Due $67.00') still reads",
    readAmount("Total Amount Due $67.00") === 67);
  // The tolerant candidate must not reach across a date-shaped gap to grab
  // an unrelated figure elsewhere on a page full of dollar amounts.
  assert("a bare label near a far-off figure is NOT misread as the balance",
    readAmount("Amount Due for your records; billing at a glance shows $9999.99 elsewhere") === null,
    `got ${readAmount("Amount Due for your records; billing at a glance shows $9999.99 elsewhere")}`);
  // BGE shares the candidate set, so it must parse the same shape.
  assert("BGE (same Opower shape) reads 'Total Amount Due by <date> $X'",
    (() => { for (const c of PLAYBOOKS.bge.amount) { if (c.labelled) { const m = "Total Amount Due by 10/01/2026 $88.20 Usage".match(c.labelled); if (m) return Number(m[1]); } } return null; })() === 88.20);
}

// ─────────────────────────────────────────────────────────────────────
// THE OFFICIAL PEPCO STATEMENT PDF, AND THE WRONG-ACCOUNT GUARD.
//
// Pepco's real bill is a download off Account History's accordion, a
// separate WebForms app from the dashboard the amount is read on. The
// danger of a separate app is that its "current account" could differ from
// the one just selected, so a download would file one property's statement
// under another. fetch-bill re-confirms the account on the page before
// downloading; these assertions fail loudly if either the config or that
// guard is removed.
assert("pepco declares a statementHistory download config",
  PLAYBOOKS.pepco.statementHistory && /AccountHistory/i.test(PLAYBOOKS.pepco.statementHistory.url)
  && PLAYBOOKS.pepco.statementHistory.viewBill instanceof RegExp);
assert("the newest bill's control ('View Bill') is what statementHistory matches",
  PLAYBOOKS.pepco.statementHistory.viewBill.test("View Bill")
  && !PLAYBOOKS.pepco.statementHistory.viewBill.test("View Sample Bills"),
  "must match the accordion control, not the 'View Sample Bills' nav link");
assert("fetch-bill re-confirms the account on Account History before downloading",
  /statementHistory[\s\S]{0,900}?onPage[\s\S]{0,200}?not downloading/.test(fetchBill),
  "the download must be gated on the wanted account appearing on the page");
// BGE shares Pepco's Exelon WebForms statement flow, on the bge.com host.
assert("bge declares a statementHistory download config on secure.bge.com",
  PLAYBOOKS.bge.statementHistory && /secure\.bge\.com.*AccountHistory/i.test(PLAYBOOKS.bge.statementHistory.url)
  && PLAYBOOKS.bge.statementHistory.viewBill.test("View Bill")
  && !PLAYBOOKS.bge.statementHistory.viewBill.test("View Sample Bills"));

// ─────────────────────────────────────────────────────────────────────
// WSSC READS TENANT ACCOUNTS; TENANT PAYMENT IS ADMIN-GATED (DB-ENFORCED).
//
// WSSC water stays in the owner's name even when the tenant pays, so the owner
// wants every unit's bill + statement on file -- but reading a tenant bill must
// never make it payable by a non-admin. The read opt-in is per playbook; the
// payment gate lives in api/encrypt.js (the pay-token minter), not just the UI.
const apiAi = fs.readFileSync(path.join(__dirname, "..", "api", "ai.js"), "utf8");
const apiEncrypt = fs.readFileSync(path.join(__dirname, "..", "api", "encrypt.js"), "utf8");
assert("WSSC opts into reading tenant accounts; Pepco and BGE do not",
  PLAYBOOKS.wssc.sweepTenant === true && !PLAYBOOKS.pepco.sweepTenant && !PLAYBOOKS.bge.sweepTenant);
assert("the sweep skips tenant rows unless the playbook opts in",
  /resp === "tenant" && !book\.sweepTenant/.test(read("sweep.js")));
assert("sweep-targets no longer excludes tenant server-side (only condo_fee)",
  /responsibility\.neq\.condo_fee/.test(apiAi) && !/not\.in\.\(tenant,condo_fee\)/.test(apiAi));
assert("sweep-targets excludes the owner->tenant final-bill closeout line",
  /\.neq\("is_final_bill", true\)/.test(apiAi));
assert("a tenant utility payment token is refused to a non-admin (DB-enforced, not just the button)",
  /responsibility === "tenant" && membership\.role !== "admin"/.test(apiEncrypt)
  && /status\(403\)/.test(apiEncrypt.slice(apiEncrypt.indexOf('responsibility === "tenant"'), apiEncrypt.indexOf('responsibility === "tenant"') + 300)));

// ─────────────────────────────────────────────────────────────────────
// WASHINGTON GAS: string signed-out signals, and its own PDF-download flow.
//
// WG's signedOutSignals are CSS-selector STRINGS ("#txtLogin"), not { role,
// name } objects. fetch-bill's signed-out loop only handled the object form,
// so a string fell through to getByRole("button", { name: undefined }) -- which
// matches every button -- and a valid imported WG session that landed on the
// dashboard was reported "signed out". And WG's statement is a click-to-
// download ("View your Detailed Bill PDF") on its billing dashboard, not
// Exelon's Account History accordion.
assert("fetch-bill handles a CSS-selector (string) signed-out signal, not just {role,name}",
  /typeof sig === "string"/.test(fetchBill) && /page\.locator\(sig\)\.first\(\)\.isVisible/.test(fetchBill));
assert("Washington Gas declares a statementClick PDF flow on its billing dashboard",
  PLAYBOOKS.washington_gas.statementClick
  && /BillDashboard/i.test(PLAYBOOKS.washington_gas.statementClick.url)
  && /viewpdfdetailspopup/.test(PLAYBOOKS.washington_gas.statementClick.selector));
assert("fetch-bill implements the statementClick download flow",
  /book\.statementClick && wantAccount/.test(fetchBill) && /waitForEvent\("download"/.test(fetchBill.slice(fetchBill.indexOf("statementClick && wantAccount"))));

console.log(`\n${failed === 0 ? "✅" : "❌"} Passed: ${passed}   ❌ Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
