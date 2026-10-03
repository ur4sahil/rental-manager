// Utility logins and automation (audit theme I).
//
// A portal login lives on TWO rows -- `utilities` (what the bill sweep and the
// portal worker read) and `utility_accounts` (the Utilities "Accounts" tab),
// bridged by the bridge_utility_account trigger. These tests hold the fixes:
//
//   Part 1  pure crypto + worker selection rules, with a DUMMY key only
//   Part 2  static checks on each writer / reader
//   Part 3  the database behaviour, on the TEST project, with throwaway rows
//           tagged QA-UTIL (removed at the end; zero leftovers is asserted)
//
// Never uses a real ENCRYPTION_KEY, never decrypts a real credential, never
// talks to a utility portal.
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(import.meta.dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}

// ─── helpers: the v3 scheme exactly as api/encrypt.js writes it ───────────
const DUMMY_KEY = "qa-util-dummy-master-key-not-real\n";   // trailing newline on purpose
function v3Encrypt(master, plaintext, saltHex = crypto.randomBytes(16).toString("hex")) {
  const key = crypto.pbkdf2Sync(master, Buffer.from(saltHex, "hex"), 100000, 32, "sha256");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { encrypted: Buffer.concat([ct, c.getAuthTag()]).toString("base64"), iv: iv.toString("hex"), salt: saltHex };
}
const sel = require(path.join(root, "worker", "portals", "credential-select.js"));
function loginRow(master, user, pass, extra = {}) {
  const u = v3Encrypt(master, user);
  const p = v3Encrypt(master, pass, u.salt);
  return {
    username_encrypted: u.encrypted, password_encrypted: p.encrypted,
    encryption_iv_username: u.iv, encryption_iv: p.iv, encryption_salt: u.salt,
    credential_key_fp: sel.keyFingerprint(master), ...extra,
  };
}
function open(master, r) {
  return {
    u: sel.decryptValue(master, r.username_encrypted, r.encryption_iv_username || r.encryption_iv, r.encryption_salt),
    p: sel.decryptValue(master, r.password_encrypted, r.encryption_iv, r.encryption_salt),
  };
}

console.log("\n=== UTILITY LOGINS · part 1: crypto + worker rules (dummy key) ===\n");

// Item 10: one fingerprint rule on both sides -- the hash of the EXACT key
// bytes. Not normalised: "K\n" and "K" are different keys and must show
// different fingerprints, or a real mismatch hides behind a matching fp.
{
  const saved = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = DUMMY_KEY;
  delete require.cache[require.resolve(path.join(root, "api", "encrypt.js"))];
  const api = require(path.join(root, "api", "encrypt.js"));
  if (saved === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = saved;
  const fp = api.keyFingerprints;
  assert("api and worker compute the SAME fingerprint for the same key",
    fp.current === sel.keyFingerprint(DUMMY_KEY), `${fp.current} vs ${sel.keyFingerprint(DUMMY_KEY)}`);
  const rawFp = crypto.createHash("sha256").update(DUMMY_KEY).digest("hex").slice(0, 12);
  assert("the fingerprint is the hash of the exact key bytes (so stored fps still match)",
    fp.current === rawFp && sel.keyFingerprint(DUMMY_KEY) === rawFp && fp.accepted.length === 1);
  assert("a key that lost its trailing newline is a DIFFERENT fingerprint (mismatch stays visible)",
    sel.keyFingerprint(DUMMY_KEY) !== sel.keyFingerprint(DUMMY_KEY.replace(/\n$/, ""))
    && !sel.acceptedFingerprints(DUMMY_KEY.replace(/\n$/, "")).has(rawFp));
  {
    // "K\n" app wrote the row; a "K" worker must report a key mismatch, not
    // a silent decrypt failure.
    const row = loginRow(DUMMY_KEY, "u@example.test", "pw", { provider: "QA Power" });
    const r2 = sel.pickCredential([row], DUMMY_KEY.replace(/\n$/, ""), { aliases: ["qa power"] });
    assert("a worker holding K (app used K\\n) reports a key mismatch", r2.error && r2.sawForeignKey === true, JSON.stringify(r2));
  }
  assert("a different key is still a different fingerprint",
    sel.keyFingerprint("another-key\n") !== sel.keyFingerprint(DUMMY_KEY));

  // Key bytes: the newline is PART of the key. Ciphertext written under
  // KEY+"\n" opens with KEY+"\n" and not with KEY -- which is why the key
  // file (verbatim) must win over a shell-exported env var.
  const r = loginRow(DUMMY_KEY, "owner@example.test", "pw-1");
  assert("v3 ciphertext round-trips under the verbatim key", open(DUMMY_KEY, r).u === "owner@example.test");
  let stripped = null; try { stripped = open(DUMMY_KEY.trimEnd(), r).u; } catch { stripped = "THREW"; }
  assert("the key bytes are not normalised (a stripped key does not open it)", stripped === "THREW");

  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qa-util-")), "key");
  fs.writeFileSync(tmp, DUMMY_KEY);
  assert("the worker reads ENCRYPTION_KEY_FILE before ENCRYPTION_KEY",
    sel.readMasterKey({ ENCRYPTION_KEY_FILE: tmp, ENCRYPTION_KEY: DUMMY_KEY.trimEnd() }) === DUMMY_KEY);
  assert("… and falls back to ENCRYPTION_KEY when there is no file",
    sel.readMasterKey({ ENCRYPTION_KEY: "env-key" }) === "env-key"
    && sel.readMasterKey({ ENCRYPTION_KEY_FILE: tmp + ".missing", ENCRYPTION_KEY: "env-key" }) === "env-key");
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
}

// Item 7: archived / closeout rows never outvote the rotated login.
{
  const aliases = ["qa power"];
  const stale = () => loginRow(DUMMY_KEY, "old@example.test", "old-pw", { provider: "QA Power", archived_at: "2026-01-01T00:00:00Z" });
  const rows = [
    stale(), stale(), stale(),
    loginRow(DUMMY_KEY, "old@example.test", "old-pw", { provider: "QA Power", is_final_bill: true }),
    loginRow(DUMMY_KEY, "new@example.test", "new-pw", { provider: "QA Power" }),
  ];
  const picked = sel.pickCredential(rows, DUMMY_KEY, { aliases });
  assert("the rotated login wins even when archived/closeout rows are the majority",
    picked.username === "new@example.test" && picked.password === "new-pw", JSON.stringify(picked));
  const legacyFp = loginRow(DUMMY_KEY, "legacy@example.test", "pw", {
    provider: "QA Power", credential_key_fp: crypto.createHash("sha256").update(DUMMY_KEY).digest("hex").slice(0, 12) });
  assert("a row stamped with the verbatim-key fingerprint is used",
    sel.pickCredential([legacyFp], DUMMY_KEY, { aliases }).username === "legacy@example.test");
  const foreign = loginRow("some-other-key", "x@example.test", "pw", { provider: "QA Power" });
  const res = sel.pickCredential([foreign], DUMMY_KEY, { aliases });
  assert("a row under a different key is reported as a key mismatch, not used",
    res.error === "none_decrypted" && res.sawForeignKey === true);
}

// Item 6: three HOA logins share one row salt.
{
  const rowSalt = crypto.randomBytes(16).toString("hex");
  const mg = v3Encrypt(DUMMY_KEY, "mgmt-user", rowSalt);
  const pay = v3Encrypt(DUMMY_KEY, "pay-user", rowSalt);
  const newMainReused = v3Encrypt(DUMMY_KEY, "main-user-2", rowSalt);           // the fix
  const newMainFresh = v3Encrypt(DUMMY_KEY, "main-user-2");                     // the old bug
  const openWith = (c, salt) => { try { return sel.decryptValue(DUMMY_KEY, c.encrypted, c.iv, salt); } catch { return null; } };
  assert("changing the association login with the row salt keeps the other two logins readable",
    openWith(newMainReused, newMainReused.salt) === "main-user-2"
    && openWith(mg, newMainReused.salt) === "mgmt-user" && openWith(pay, newMainReused.salt) === "pay-user");
  assert("(the old fresh-salt behaviour broke them — this is what the fix prevents)",
    openWith(mg, newMainFresh.salt) === null && openWith(pay, newMainFresh.salt) === null);
}

// Item 1: legacy Accounts-tab ciphertext (browser key, shared IV) still opens.
{
  const companyId = "qa-util-company";
  const rawKey = Buffer.from((companyId + "_propmanager_cred_key").slice(0, 32).padEnd(32, "0"), "utf8");
  const iv = crypto.randomBytes(12);
  const enc = (pt) => { const c = crypto.createCipheriv("aes-256-gcm", rawKey, iv); return Buffer.concat([c.update(pt, "utf8"), c.final(), c.getAuthTag()]).toString("base64"); };
  const u = enc("legacy-user");
  const apiSrc = read("api/encrypt.js");
  assert("the old Accounts-tab browser key is exactly api/encrypt.js's 'teller' legacy key",
    /\(companyId \+ "_propmanager_cred_key"\)\.slice\(0, 32\)\.padEnd\(32, "0"\)/.test(apiSrc));
  const b = Buffer.from(u, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", rawKey, iv); d.setAuthTag(b.slice(-16));
  assert("… so a legacy row decrypts under that scheme",
    Buffer.concat([d.update(b.slice(0, -16)), d.final()]).toString("utf8") === "legacy-user");
}

console.log("\n=== UTILITY LOGINS · part 2: writers and readers (static) ===\n");
const util = read("src/components/Utilities.js");
const saveAcct = util.slice(util.indexOf("async function saveAccount()"), util.indexOf("async function deleteAccount("));
const delAcct = util.slice(util.indexOf("async function deleteAccount("), util.indexOf("async function loadPortalLogin("));
assert("Accounts-tab save uses the standard server encryption, not a browser key",
  /encryptCredential\(String\(accountForm\.username \|\| ""\)\.trim\(\), companyId\)/.test(saveAcct)
  && /encryptCredential\(accountForm\.password, companyId, u\.salt\)/.test(saveAcct)
  && !/crypto\.subtle/.test(saveAcct) && !/_propmanager_cred_key/.test(saveAcct));
assert("… persists the key fingerprint and all six credential columns",
  /credential_key_fp: u\.keyFp \|\| p\.keyFp/.test(saveAcct)
  && ["username_encrypted", "password_encrypted", "encryption_iv_username", "encryption_iv", "encryption_salt"].every(k => new RegExp(k + ":").test(saveAcct)));
assert("… writes the SAME ciphertext to the linked utilities row (or creates one)",
  /\.\.\.\(creds \|\| \{\}\)/.test(saveAcct)
  && /from\("utilities"\)\.update\(utilPatch\)/.test(saveAcct)
  && /rpc\("save_utility_line_for_account", \{[\s\S]{0,120}p_account_id: editingAccount\?\.id \|\| null/.test(saveAcct));
assert("… never re-points links itself (the bridge links the NAMED account)",
  !/legacy_utility_id: null/.test(saveAcct) && !/\.update\(\{ \.\.\.payload, legacy_utility_id/.test(saveAcct));
assert("… moving property clears property_id so the fill trigger recomputes it",
  /editingAccount\.property !== payload\.property\) utilPatch\.property_id = null/.test(saveAcct));
assert("… refuses half a login on edit",
  /isHalfLogin\(accountForm\.username, accountForm\.password\)/.test(saveAcct));
assert("… syncs property, provider, account number and responsibility to the utilities row",
  /property: payload\.property,\s*provider: providerName,\s*account_number: accountForm\.account_number \|\| null,\s*responsibility: payload\.responsibility/.test(saveAcct));
assert("… stores the provider NAME, not the utility_providers id",
  /payload\.provider = providerInfo\.display_name;/.test(saveAcct) && !/payload\.provider = accountForm\.provider/.test(saveAcct));
assert("Delete archives the linked utilities row too, marked as a person's decision",
  /archived_reason: "user_deleted"/.test(delAcct) && /from\("utilities"\)\.update\(\{ archived_at: archivedAt/.test(delAcct));
assert("legacy Accounts-tab logins still open (teller-scheme fallback for saltless rows)",
  /!u\.encryption_salt\)[\s\S]{0,200}"teller"/.test(util) && (util.match(/await loadPortalLogin\(u\)/g) || []).length === 3);
assert("addUtility persists credential_key_fp",
  /row\.credential_key_fp = resU\.keyFp \|\| resP\.keyFp/.test(util));
const loans = read("src/components/Loans.js");
assert("Loans persists credential_key_fp on update and insert",
  /credential_key_fp: resU\.keyFp \|\| resP\.keyFp/.test(loans)
  && /credential_key_fp: creds \? creds\.credential_key_fp : \(editingLoan\.credential_key_fp \|\| null\)/.test(loans)
  && /credential_key_fp: creds \? creds\.credential_key_fp : null/.test(loans));
const props = read("src/components/Properties.js");
assert("the wizard payload carries credential_key_fp for each credential set",
  /credential_key_fp: u\.keyFp \|\| p\.keyFp \|\| null/.test(props));
assert("the wizard reuses the stored HOA row salt for every login set, keyed by row id",
  /storedHoaSaltById\[String\(h\.id\)\]/.test(props)
  && /encryptRow\(!!\(h\.username && h\.password\), h\.username, h\.password, keptSalt\)/.test(props));
const hoa = read("src/components/HOA.js");
assert("the HOA page reuses the row salt when the association login changes",
  /encryptCredential\(String\(form\.username \|\| ""\)\.trim\(\), companyId, \(editingHoa && editingHoa\.encryption_salt\) \|\| null\)/.test(hoa));
const imp = read("src/components/PropertyImport.js");
assert("re-import leaves stored logins/websites alone when the sheet cell is blank",
  /update\(keepStoredLoginOnBlank\((row|patch)\)\)/.test(imp) && /function keepStoredLoginOnBlank/.test(imp));
const ai = read("api/ai.js");
const pc = ai.slice(ai.indexOf('if (action === "portal-credentials")'), ai.indexOf('if (action === "claim")'));
assert("portal-credentials returns only live, non-closeout rows",
  /\.is\("archived_at", null\)/.test(pc) && /\.neq\("is_final_bill", true\)/.test(pc));
const ens = read("worker/portals/ensure-session.js");
assert("ensure-session: same filter on the direct query, file-first key, shared selection rules",
  /\.is\("archived_at", null\)\s*\.neq\("is_final_bill", true\)/.test(ens)
  && /readMasterKey\(\)/.test(ens) && /pickCredential\(rows, master/.test(ens)
  && !/let master = process\.env\.ENCRYPTION_KEY;/.test(ens));
const runner = read("worker/portals/pay-runner.js");
const enc = read("api/encrypt.js");
assert("one responsibility rule: the account first, the bill snapshot as fallback (runner, stream gate)",
  /if \(!responsibility\) responsibility = bill\?\.responsibility/.test(runner)
  && /if \(gateAcct && gateAcct\.responsibility\) responsibility = gateAcct\.responsibility/.test(enc)
  && /responsibility: a\.responsibility \|\| b\?\.responsibility/.test(util));
const mig = read("supabase/migrations/20260928130000_utility_login_sync.sql");
assert("migration: claim RPC reads COALESCE(account, bill)",
  /SELECT COALESCE\(a\.responsibility, b\.responsibility\), b\.amount/.test(mig));
assert("migration: every definer function it defines is revoked from PUBLIC/anon",
  (mig.match(/SECURITY DEFINER/g) || []).length
    === (mig.match(/REVOKE ALL ON FUNCTION public\.[a-z_]+\([^)]*\) FROM PUBLIC, anon/g) || []).length);

// Round 2 (adversarial pass).
{
  const lm = read("src/utils/loginMissing.js");
  assert("half a login never clears a to-do (username AND password)",
    /hasPair\(r\.username_encrypted, r\.password_encrypted\)/.test(lm) && !/hasLogin: \(r\) => hasValue\(r\.username_encrypted\)/.test(lm));
  for (const [f, re] of [["src/components/Utilities.js", /isHalfLogin\(form\.username, form\.password\)/],
                         ["src/components/Insurance.js", /isHalfLogin\(form\.username, form\.password\)/],
                         ["src/components/HOA.js", /isHalfLogin\(form\.pay_username, form\.pay_password\)/],
                         ["src/components/Loans.js", /isHalfLogin\(portfolioForm\.username, portfolioForm\.password\)/]]) {
    assert(`${path.basename(f)} refuses half a login`, re.test(read(f)));
  }
  const adm = read("src/components/Admin.js");
  assert("login-missing to-dos are limited to pages the viewer can open",
    /buildLoginMissingTasks\(loginRows, propIdByAddr, \{ allowedPages \}\)/.test(adm) && /TasksAndApprovals\(\{[^}]*allowedPages \}\)/.test(adm));
  for (const f of ["Insurance.js", "HOA.js", "Loans.js", "Utilities.js"]) {
    assert(`${f}: a deep link to an unavailable record says so`, /That record was archived or isn't available/.test(read("src/components/" + f)));
  }
  assert("Fetched Bills decides Pay from the ACCOUNT's responsibility",
    /responsibility: respByAcct\.get\(b\.utility_account_id\) \|\| b\.responsibility/.test(util));
  assert("pay-runner refuses condo_fee and compares case-insensitively",
    /responsibility === "condo_fee"/.test(runner) && /toLowerCase\(\)/.test(runner));
  assert("portfolio loan insert writes NULL, not '', when there is no login",
    /noLogin = base\.username_encrypted \? \{\} : \{ username_encrypted: null/.test(read("src/components/Loans.js")));
}

// Round 3.
{
  const enc3 = read("api/encrypt.js");
  const streamBlock = enc3.slice(enc3.indexOf("if (isStream) {"), enc3.indexOf("const b64 = Buffer.from(JSON.stringify(payload))"));
  // Accountants may open the pay stream (20260929090000 bookkeeping roles); the
  // stream pre-fills the login on the VPS, so STREAM_ROLES = CRED_ROLES + accountant.
  assert("stream-session requires a staff role (CRED_ROLES + accountant, never owner/tenant/maintenance)",
    /if \(!STREAM_ROLES\.has\(membership\.role\)\) \{\s*return res\.status\(403\)/.test(streamBlock)
    && /const STREAM_ROLES = new Set\(\[\.\.\.CRED_ROLES, "accountant"\]\)/.test(enc3));
  assert("an enroll stream never creates a payment row",
    /if \(body\.billId && svcKey && body\.enroll !== true\)/.test(streamBlock));
  assert("owner is not a credential role",
    /const CRED_ROLES = new Set\(\["admin", "pm", "manager", "office_assistant"\]\)/.test(enc3) && !/CRED_ROLES = new Set\([^)]*"owner"/.test(enc3));
  const loans3 = read("src/components/Loans.js");
  assert("owners read loans through owner_loans_readonly, with no login / edit controls",
    /const readOnly = userRole === "owner"/.test(loans3) && /rpc\("owner_loans_readonly"/.test(loans3)
    && /!readOnly && l\.username_encrypted/.test(loans3) && /\{!readOnly && <Btn variant="success-fill" onClick=\{\(\) => \{ setEditingLoan\(null\)/.test(loans3));
  assert("Utilities deep link waits for fetchAutomationData (acctsLoaded), not the list spinner",
    /handledAction\.current === initialAction \|\| !acctsLoaded\) return;/.test(util) && /setAcctsLoaded\(true\)/.test(util));
  assert("the Accounts-tab save is single-flight (guardSubmit)",
    /if \(!guardSubmit\("saveUtilityAccount"\)\) return;/.test(util));
  const lm3 = read("src/utils/loginMissing.js");
  const M3 = await import("data:text/javascript," + encodeURIComponent(lm3));
  assert("a whitespace-only username or password is not a login",
    M3.formLogin("   ", "pw") === null && M3.formLogin("u", "   ") === null && M3.formLogin(" u ", "p w").username === "u"
    && M3.formLogin(" u ", " p ").password === " p " && M3.isHalfLogin("  ", "pw") && !M3.isHalfLogin("  ", "  "));
  for (const f of ["Utilities.js", "Insurance.js", "HOA.js", "Loans.js"]) {
    assert(`${f}: saves only a whole, non-blank login`, /formLogin\(/.test(read("src/components/" + f)));
  }
  assert("the wizard ignores a whitespace-only login", /const lg = hasCreds \? formLogin\(username, password\) : null;/.test(read("src/components/Properties.js")));
  assert("the import names the row of a half login", /the \$\{hasU \? "password" : "username"\} is missing/.test(read("src/components/PropertyImport.js")));
  const app3 = read("src/App.js");
  assert("the sidebar Tasks badge counts login-missing to-dos with the same loader",
    /loadLoginMissingRows\(supabase, cid, \{ allowedPages: badgePages, pageAll: fetchAllPaged \}\)/.test(app3)
    && /wizardSteps \+ loginMissing;/.test(app3) && /loadLoginMissingRows\(supabase, companyId/.test(read("src/components/Admin.js")) && /export async function loadLoginMissingRows/.test(lm3));
}

// ─── part 3: the database, on TEST ───────────────────────────────────────
let sb = null;
try {
  require(path.join(import.meta.dirname, "sandbox-env.js"));
  const { createClient } = require("@supabase/supabase-js");
  sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
} catch (e) { console.log("\n(no TEST credentials — skipping the database part)", e.message); }

if (sb) {
  console.log("\n=== UTILITY LOGINS · part 3: database (TEST, QA-UTIL rows) ===\n");
  const CO = "QA-UTIL-" + crypto.randomBytes(4).toString("hex");
  const PROP = "QA-UTIL 1 Test St, Nowhere, MD 00000";
  const PROV = "QA-UTIL Power";
  const CRED_COLS = ["username_encrypted", "password_encrypted", "encryption_iv", "encryption_iv_username", "encryption_salt", "credential_key_fp"];
  const same = (a, b) => CRED_COLS.every(k => (a[k] ?? null) === (b[k] ?? null));
  const one = async (q) => { const { data, error } = await q; if (error) throw new Error(error.message); return data; };
  const acctFor = async (uid) => (await one(sb.from("utility_accounts").select("*").eq("company_id", CO).eq("legacy_utility_id", uid)))[0];
  // The sweep's and the worker's own queries (api/ai.js).
  const sweepTargets = () => one(sb.from("utilities").select("id").eq("company_id", CO).is("archived_at", null)
    .or("responsibility.is.null,responsibility.neq.condo_fee").neq("is_final_bill", true));
  const portalCreds = () => one(sb.from("utilities").select("id, provider, username_encrypted, password_encrypted, encryption_iv_username, encryption_iv, encryption_salt, credential_key_fp")
    .eq("company_id", CO).is("archived_at", null).neq("is_final_bill", true)
    .not("username_encrypted", "is", null).not("password_encrypted", "is", null));

  try {
    // 1. Accounts-tab ADD: utilities row first (the app's order), bridge makes the account.
    const loginA = loginRow(DUMMY_KEY, "first@example.test", "pw-A");
    const u1 = (await one(sb.from("utilities").insert([{ company_id: CO, property: PROP, provider: PROV, type: "Electric",
      account_number: "QA-100", responsibility: "owner", amount: 0, status: "pending", ...loginA }]).select("*")))[0];
    let a1 = await acctFor(u1.id);
    assert("add: the bridge creates the account with the identical v3 login + fingerprint",
      a1 && same(a1, u1) && a1.credential_key_fp === sel.keyFingerprint(DUMMY_KEY));
    // the app then writes its extra account fields
    await one(sb.from("utility_accounts").update({ provider: PROV, provider_display: PROV, account_type: "electric", legacy_utility_id: u1.id }).eq("id", a1.id));

    // 2. Accounts-tab EDIT of the login: utilities first, then the account with the same payload.
    const loginB = loginRow(DUMMY_KEY, "rotated@example.test", "pw-B");
    const before = await acctFor(u1.id);
    await one(sb.from("utilities").update({ property: PROP, provider: PROV, account_number: "QA-100", responsibility: "owner", ...loginB }).eq("id", u1.id));
    a1 = await acctFor(u1.id);
    const u1b = (await one(sb.from("utilities").select("*").eq("id", u1.id)))[0];
    assert("edit: the utilities row and the account carry the SAME new ciphertext + fingerprint",
      same(a1, u1b) && same(a1, loginB));
    const o = open(DUMMY_KEY, a1), o2 = open(DUMMY_KEY, u1b);
    assert("edit: both rows decrypt to the new login with the test key",
      o.u === "rotated@example.test" && o.p === "pw-B" && o2.u === o.u && o2.p === o.p);
    assert("edit: no stale salt / username IV survived", a1.encryption_salt === loginB.encryption_salt
      && a1.encryption_iv_username === loginB.encryption_iv_username && a1.encryption_salt !== before.encryption_salt);
    const stamp = a1.updated_at;
    await one(sb.from("utility_accounts").update({ ...loginB }).eq("id", a1.id));   // the app's second write
    await one(sb.from("utilities").update({ ...loginB }).eq("id", u1.id));           // identical write again
    const a1c = await acctFor(u1.id);
    assert("no ping-pong: an identical write back does not touch the account again", a1c.updated_at === stamp && same(a1c, loginB));

    // 3. provider / account number / property sync utilities -> account
    await one(sb.from("utilities").update({ account_number: "QA-101" }).eq("id", u1.id));
    assert("account number syncs from utilities to the account", (await acctFor(u1.id)).account_number === "QA-101");

    // 4. responsibility: open bills follow the account; paid/part-paid do not; the claim uses the account
    const bills = await one(sb.from("utility_bills").insert([
      { company_id: CO, utility_account_id: a1.id, property: PROP, provider: PROV, amount: 10, statement_period: "2026-07", responsibility: "owner", status: "pending_review" },
      { company_id: CO, utility_account_id: a1.id, property: PROP, provider: PROV, amount: 20, statement_period: "2026-06", responsibility: "owner", status: "paid" },
      { company_id: CO, utility_account_id: a1.id, property: PROP, provider: PROV, amount: 30, statement_period: "2026-05", responsibility: "owner", status: "partial" },
    ]).select("id, status"));
    await one(sb.from("utilities").update({ responsibility: "tenant" }).eq("id", u1.id));   // Accounts-tab owner->tenant
    const aT = await acctFor(u1.id);
    const bNow = await one(sb.from("utility_bills").select("id, status, responsibility").in("id", bills.map(b => b.id)));
    const byStatus = Object.fromEntries(bNow.map(b => [b.status, b.responsibility]));
    assert("owner->tenant: the account follows the utilities row", aT.responsibility === "tenant");
    assert("owner->tenant: the OPEN bill's snapshot follows; paid and part-paid bills are untouched",
      byStatus.pending_review === "tenant" && byStatus.paid === "owner" && byStatus.partial === "owner", JSON.stringify(byStatus));
    await one(sb.from("utility_payment_settings").insert([{ company_id: CO, enabled: true, max_payment_amount: 500, max_daily_total: 2000, require_per_payment_approval: true }]));
    const partialBill = bills.find(b => b.status === "partial");
    const pay = (await one(sb.from("utility_payments").insert([{ company_id: CO, provider: "qa", approved_amount: 5, approved_by: "qa@example.test",
      approved_at: new Date().toISOString(), status: "approved", bill_id: partialBill.id, idem_key: "QA-UTIL-" + CO }]).select("id")))[0];
    const { data: claim, error: cErr } = await sb.rpc("claim_utility_payment", { p_company_id: CO, p_id: pay.id, p_worker: "qa" });
    const c = Array.isArray(claim) ? claim[0] : claim;
    assert("the claim RPC refuses a bill whose snapshot says owner but whose ACCOUNT says tenant",
      !cErr && c && c.ok === false && /tenant/.test(c.reason || ""), JSON.stringify(c || cErr));

    // 5. the closeout line: created on the flip, never a reading's target, never a login source
    const closeout = (await one(sb.from("utilities").select("*").eq("company_id", CO).eq("is_final_bill", true)))[0];
    assert("the flip created the owner closeout line", !!closeout && closeout.account_number === "QA-101");
    const { data: rd } = await sb.rpc("record_utility_reading", { p_company_id: CO, p_provider: PROV, p_account: "QA-101", p_outcome: "ok", p_amount: 42.5, p_due: "2026-10-15" });
    const r0 = Array.isArray(rd) ? rd[0] : rd;
    assert("record_utility_reading by account number lands on the ONGOING line, not the closeout",
      r0 && r0.updated === true && r0.utility_id === u1.id, JSON.stringify(r0));
    const { data: rd2 } = await sb.rpc("record_utility_reading", { p_company_id: CO, p_provider: PROV, p_account: null, p_outcome: "ok", p_amount: 1, p_due: "2026-11-15", p_property: "QA-UTIL 1 Test St" });
    const r1 = Array.isArray(rd2) ? rd2[0] : rd2;
    assert("… and the property fallback is no longer 'ambiguous' because of the closeout",
      r1 && r1.utility_id === u1.id && r1.updated === true, JSON.stringify(r1));
    const creds1 = await portalCreds();
    assert("portal-credentials query excludes the closeout line", creds1.length === 1 && creds1[0].id === u1.id);

    // 6. stale archived logins cannot outvote the rotated one
    for (let i = 0; i < 3; i++) {
      await one(sb.from("utilities").insert([{ company_id: CO, property: PROP, provider: PROV, type: "Electric", account_number: "QA-OLD-" + i,
        responsibility: "owner", amount: 0, status: "pending", archived_at: new Date().toISOString(), ...loginRow(DUMMY_KEY, "stale@example.test", "stale") }]));
    }
    const all = await one(sb.from("utilities").select("*").eq("company_id", CO));
    const unfiltered = sel.pickCredential(all.map(r => ({ ...r, archived_at: null, is_final_bill: false })), DUMMY_KEY, { aliases: ["qa-util power"] });
    const filtered = sel.pickCredential(await portalCreds(), DUMMY_KEY, { aliases: ["qa-util power"] });
    assert("(without the filter the 3 archived stale logins would win the majority vote)", unfiltered.username === "stale@example.test");
    assert("with the filter the worker picks the rotated login", filtered.username === "rotated@example.test", JSON.stringify(filtered));

    // 7. re-import with blank login/website cells keeps the stored login
    const impSrc = read("src/components/PropertyImport.js");
    const fnSrc = impSrc.slice(impSrc.indexOf("const LOGIN_KEYS"), impSrc.indexOf("\n  }\n", impSrc.indexOf("function keepStoredLoginOnBlank")) + 4);
    const keepStoredLoginOnBlank = new Function(fnSrc + "\nreturn keepStoredLoginOnBlank;")();
    await one(sb.from("utilities").update({ website: "https://qa-util.example.test" }).eq("id", u1.id));
    const sheetRow = { amount: 55, responsibility: "tenant", status: "pending", website: null,
      username_encrypted: null, password_encrypted: null, encryption_iv: null, encryption_iv_username: null, encryption_salt: null };
    await one(sb.from("utilities").update(keepStoredLoginOnBlank(sheetRow)).eq("id", u1.id));
    const u1r = (await one(sb.from("utilities").select("*").eq("id", u1.id)))[0];
    assert("re-import with blank login/website cells keeps the stored login and website",
      same(u1r, loginB) && u1r.website === "https://qa-util.example.test" && Number(u1r.amount) === 55);

    // 8. delete: both rows archived, sweep + worker stop, relink skips it
    const aDel = await acctFor(u1.id);
    const at = new Date().toISOString();
    await one(sb.from("utility_accounts").update({ archived_at: at, archived_reason: "user_deleted" }).eq("id", aDel.id));
    await one(sb.from("utilities").update({ archived_at: at, archived_by: "qa@example.test" }).eq("id", u1.id).is("archived_at", null));
    const uDel = (await one(sb.from("utilities").select("archived_at").eq("id", u1.id)))[0];
    const aDel2 = (await one(sb.from("utility_accounts").select("archived_at, archived_reason").eq("id", aDel.id)))[0];
    assert("delete archives BOTH rows", !!uDel.archived_at && !!aDel2.archived_at && aDel2.archived_reason === "user_deleted");
    const targets = await sweepTargets();
    assert("the sweep no longer targets the deleted account", !targets.some(t => t.id === u1.id));
    assert("the worker no longer sees its login", !(await portalCreds()).some(r => r.id === u1.id));
    // wizard save re-adds the same provider at the same property
    const u2 = (await one(sb.from("utilities").insert([{ company_id: CO, property: PROP, provider: PROV, type: "Electric",
      account_number: "QA-101", responsibility: "tenant", amount: 0, status: "pending" }]).select("id")))[0];
    const a2 = await acctFor(u2.id);
    const aDel3 = (await one(sb.from("utility_accounts").select("archived_at, legacy_utility_id").eq("id", aDel.id)))[0];
    assert("the bridge does NOT re-link (un-archive) a user-deleted account",
      !!aDel3.archived_at && aDel3.legacy_utility_id === u1.id && a2 && a2.id !== aDel.id);

    // 9. ...but a bridge-archived account (wizard archive + re-insert) IS re-linked
    await one(sb.from("utilities").update({ archived_at: new Date().toISOString() }).eq("id", u2.id));
    const a2arch = (await one(sb.from("utility_accounts").select("archived_at, archived_reason").eq("id", a2.id)))[0];
    const u3 = (await one(sb.from("utilities").insert([{ company_id: CO, property: PROP, provider: PROV, type: "Electric",
      account_number: "QA-101", responsibility: "tenant", amount: 0, status: "pending", ...loginB }]).select("id")))[0];
    const a3 = await acctFor(u3.id);
    assert("a wizard-archived account is re-linked (not duplicated) and gets the login",
      !!a2arch.archived_at && a2arch.archived_reason == null && a3 && a3.id === a2.id && !a3.archived_at && same(a3, loginB));

    // 10. relink never steals an account still linked to a different LIVE row
    const u4 = (await one(sb.from("utilities").insert([{ company_id: CO, property: PROP, provider: PROV, type: "Electric",
      account_number: "QA-200", responsibility: "owner", amount: 0, status: "pending" }]).select("id")))[0];
    const a4 = await acctFor(u4.id);
    const a3again = await acctFor(u3.id);
    assert("a second live line for the same provider gets its OWN account", a4 && a4.id !== a3.id && a3again && a3again.id === a3.id);

    // 11. Accounts-tab save NAMES its account (round 2): no hijack.
    const P2 = "QA-UTIL 2 Hijack Ave";
    const mkAcct = async (extra) => (await one(sb.from("utility_accounts").insert([{ company_id: CO, property: P2, provider: PROV,
      provider_display: PROV, account_type: "electric", ...extra }]).select("*")))[0];
    const bOld = await mkAcct({ account_number: "B-OLD-111", responsibility: "owner" });
    const cTen = await mkAcct({ account_number: "C-222", responsibility: "tenant" });
    // ADD: a brand-new account at the same property + provider
    const { data: addId, error: addErr } = await sb.rpc("save_utility_line_for_account", { p_company_id: CO, p_account_id: null,
      p_row: { property: P2, provider: PROV, account_number: "A-NEW-333", responsibility: "owner", ...loginRow(DUMMY_KEY, "new@example.test", "pw") } });
    const aNew = addErr ? null : await acctFor(addId);
    const bAfter = (await one(sb.from("utility_accounts").select("*").eq("id", bOld.id)))[0];
    assert("add: a NEW account is created for the new line; the unlinked B-OLD-111 is untouched",
      !addErr && aNew && aNew.id !== bOld.id && aNew.id !== cTen.id && aNew.account_number === "A-NEW-333"
      && bAfter.legacy_utility_id == null && bAfter.account_number === "B-OLD-111" && bAfter.username_encrypted == null,
      addErr ? addErr.message : JSON.stringify({ aNew: aNew && aNew.id, b: bAfter.legacy_utility_id }));
    // EDIT: the unlinked tenant account C gets its line; nothing else moves
    const { data: cLine, error: cErr2 } = await sb.rpc("save_utility_line_for_account", { p_company_id: CO, p_account_id: cTen.id,
      p_row: { property: P2, provider: PROV, account_number: "C-222", responsibility: "tenant" } });
    const cAfter = (await one(sb.from("utility_accounts").select("*").eq("id", cTen.id)))[0];
    const aNewAfter = await acctFor(addId);
    assert("edit: the NAMED account C is linked, stays tenant; the other accounts keep their links",
      !cErr2 && cAfter.legacy_utility_id === cLine && cAfter.responsibility === "tenant" && cAfter.account_number === "C-222"
      && aNewAfter && aNewAfter.id === aNew.id,
      cErr2 ? cErr2.message : JSON.stringify(cAfter));
    const { error: againErr } = await sb.rpc("save_utility_line_for_account", { p_company_id: CO, p_account_id: cTen.id,
      p_row: { property: P2, provider: PROV, account_number: "C-222b", responsibility: "tenant" } });
    assert("a second line for an account that already has a live one is refused (no silent relink)", !!againErr, "no error");
    const { error: otherCoErr } = await sb.rpc("save_utility_line_for_account", { p_company_id: CO + "-other", p_account_id: bOld.id,
      p_row: { property: P2, provider: PROV, account_number: "X", responsibility: "owner" } });
    assert("naming an account from another company is refused", !!otherCoErr, "no error");
    const { count: strayLines } = await sb.from("utilities").select("*", { count: "exact", head: true }).eq("company_id", CO + "-other");
    assert("… and leaves nothing behind", strayLines === 0);
    const { data: wiz } = await sb.from("utilities").insert([{ company_id: CO, property: P2, provider: PROV, type: "Electric",
      account_number: "B-OLD-111", responsibility: "owner", amount: 0, status: "pending" }]).select("id").single();
    assert("an UNNAMED insert (wizard) still re-links the matching unlinked account",
      (await acctFor(wiz.id))?.id === bOld.id);

    // 12. property moved: property_id recomputed, not stale
    const anyProp = (await one(sb.from("properties").select("id").limit(1)))[0];
    if (anyProp) {
      await one(sb.from("utilities").update({ property_id: anyProp.id }).eq("id", addId));
      await one(sb.from("utilities").update({ property: "QA-UTIL 3 Moved Rd", property_id: null }).eq("id", addId));
      const moved = (await one(sb.from("utilities").select("property_id").eq("id", addId)))[0];
      assert("moving a line to another property does not keep the old property_id", moved.property_id !== anyProp.id, JSON.stringify(moved));
    }

    // 13. condo fee: the claim RPC refuses it (account wins, any case)
    const condoBill = (await one(sb.from("utility_bills").insert([{ company_id: CO, utility_account_id: bOld.id, property: P2, provider: PROV,
      amount: 9, statement_period: "2026-08", responsibility: "owner", status: "pending_review" }]).select("id")))[0];
    await one(sb.from("utility_accounts").update({ responsibility: "condo_fee" }).eq("id", bOld.id));
    const cp = (await one(sb.from("utility_payments").insert([{ company_id: CO, provider: "qa", approved_amount: 5, approved_by: "qa@example.test",
      approved_at: new Date().toISOString(), status: "approved", bill_id: condoBill.id, idem_key: "QA-UTIL-condo-" + CO }]).select("id")))[0];
    const { data: cc } = await sb.rpc("claim_utility_payment", { p_company_id: CO, p_id: cp.id, p_worker: "qa" });
    const c2 = Array.isArray(cc) ? cc[0] : cc;
    assert("claim_utility_payment refuses a condo-fee utility", c2 && c2.ok === false && /condo/.test(c2.reason || ""), JSON.stringify(c2));

    // 14. round 3: an archived / user-deleted account is never revived
    const dead = await mkAcct({ account_number: "D-DEL-444", responsibility: "owner", archived_at: new Date().toISOString(), archived_reason: "user_deleted" });
    const { error: deadErr } = await sb.rpc("save_utility_line_for_account", { p_company_id: CO, p_account_id: dead.id,
      p_row: { property: P2, provider: PROV, account_number: "D-DEL-444", responsibility: "owner" } });
    const deadAfter = (await one(sb.from("utility_accounts").select("archived_at, legacy_utility_id").eq("id", dead.id)))[0];
    assert("save_utility_line_for_account refuses an archived / user-deleted account", !!deadErr && !!deadAfter.archived_at && deadAfter.legacy_utility_id == null, deadErr ? deadErr.message : "no error");

    // 15. round 3: concurrent saves for one account leave exactly ONE live line
    for (const acctNo of [null, "R-RACE-555"]) {
      const racer = await mkAcct({ account_number: acctNo || "", responsibility: "owner" });
      const rs = await Promise.all([0, 1, 2].map(() => sb.rpc("save_utility_line_for_account", { p_company_id: CO, p_account_id: racer.id,
        p_row: { property: P2 + " race", provider: PROV, account_number: acctNo } })));
      const okIds = rs.map(r => r.data).filter(Boolean);
      const linked = (await one(sb.from("utility_accounts").select("legacy_utility_id").eq("id", racer.id)))[0].legacy_utility_id;
      const { count: live } = await sb.from("utilities").select("*", { count: "exact", head: true }).eq("company_id", CO).eq("property", P2 + " race").is("archived_at", null).eq("provider", PROV);
      assert(`race (account number ${acctNo ? "set" : "null"}): one save wins, the others are refused, no orphan line`,
        okIds.length === 1 && okIds[0] === linked && live === 1 && rs.filter(r => r.error).length === 2, JSON.stringify(rs.map(r => r.error ? r.error.message.slice(0, 60) : r.data)));
      await one(sb.from("utilities").update({ archived_at: new Date().toISOString() }).eq("company_id", CO).eq("property", P2 + " race").is("archived_at", null));
    }

    // 16. round 3: responsibility is constrained
    const { error: badResp } = await sb.from("utility_accounts").update({ responsibility: "Tenant Pays" }).eq("id", bOld.id);
    assert("a responsibility outside owner/tenant/condo_fee/shared is rejected", !!badResp && /chk_utility_accounts_responsibility/.test(badResp.message), badResp ? badResp.message : "accepted");
    const { data: norm } = await sb.rpc("normalize_utility_responsibility", { p: " Condo Fee " }).then(r => r, () => ({ data: null }));
    if (norm !== null) assert("the normaliser maps 'Condo Fee' -> condo_fee", norm === "condo_fee", String(norm));
  } catch (e) {
    assert("database part ran without error", false, e.stack || e.message);
  } finally {
    // Cleanup: every QA-UTIL row, children first. Throwaway rows on TEST only.
    const { data: accts } = await sb.from("utility_accounts").select("id").eq("company_id", CO);
    const { data: bl } = await sb.from("utility_bills").select("id").eq("company_id", CO);
    await sb.from("utility_payments").delete().eq("company_id", CO);
    if (bl?.length) await sb.from("utility_bills").delete().eq("company_id", CO);
    await sb.from("utility_accounts").update({ legacy_utility_id: null }).eq("company_id", CO);
    if (accts?.length) await sb.from("utility_accounts").delete().eq("company_id", CO);
    await sb.from("utilities").delete().eq("company_id", CO);
    await sb.from("utility_payment_settings").delete().eq("company_id", CO);
    await sb.from("audit_trail").delete().eq("company_id", CO);
    const left = {};
    for (const t of ["utilities", "utility_accounts", "utility_bills", "utility_payments", "utility_payment_settings", "audit_trail"]) {
      const { count } = await sb.from(t).select("*", { count: "exact", head: true }).eq("company_id", CO);
      left[t] = count;
    }
    assert("cleanup: zero QA-UTIL rows left behind", Object.values(left).every(n => n === 0), JSON.stringify(left));
  }
}

// RLS (round 2): a real tenant JWT on TEST cannot read or change utility
// accounts / bills. utility-rls-exploit.mjs creates and removes its own
// throwaway user and QA-UTIL rows.
if (sb) {
  const { runTenantExploit } = await import("./utility-rls-exploit.mjs");
  for (const role of ["tenant", "maintenance"]) {
    const r = await runTenantExploit(role);
    assert(`a ${role} cannot read, flip or read ciphertext of utility accounts/bills`, !r.error && r.exploitable === false, JSON.stringify(r));
    assert(`the ${role} exploit run left nothing behind`, r.leftovers === 0, JSON.stringify(r));
  }
  const { runLoanExploit } = await import("./loans-rls-exploit.mjs");
  for (const role of ["tenant", "owner"]) {
    const r = await runLoanExploit(role);
    assert(`a ${role} cannot read or change loans / portfolio loans / insurance (or their ciphertext)`, !r.error && r.exploitable === false, JSON.stringify(r));
    if (role === "owner") assert("an owner reads THEIR OWN loans read-only, without login columns",
      JSON.stringify(r.steps.rpc.loans) === JSON.stringify(["QA-UTIL Own Bank"]) && JSON.stringify(r.steps.rpc.portfolio) === JSON.stringify(["QA-UTIL Blanket"]) && r.steps.rpc.leaksCredentialColumns === false, JSON.stringify(r.steps.rpc));
    if (role === "tenant") assert("a tenant gets nothing from owner_loans_readonly", r.steps.rpc && r.steps.rpc.loans && r.steps.rpc.loans.length === 0, JSON.stringify(r.steps.rpc));
    assert(`the ${role} loans exploit run left nothing behind`, r.leftovers === 0, JSON.stringify(r));
  }
}


// ── every login, not just the majority one (2026-10-03) ──────────────
{
  const rows = [
    loginRow(DUMMY_KEY, "sigma@example.test", "pw1", { provider: "Pepco" }),
    loginRow(DUMMY_KEY, "sigma@example.test", "pw1", { provider: "Pepco" }),
    loginRow(DUMMY_KEY, "SGS@example.test", "pw2", { provider: "pepco" }),
    loginRow(DUMMY_KEY, "sigma@example.test", "old-typo", { provider: "Pepco" }),
    loginRow(DUMMY_KEY, "gas@example.test", "pw3", { provider: "Washington Gas" }),
  ];
  rows.forEach((r, i) => { r.id = 100 + i; });
  const logins = sel.listLogins(rows, DUMMY_KEY, { aliases: ["pepco"] });
  assert("listLogins finds every distinct Pepco login, most-used first",
    logins.length === 2 && logins[0].username === "sigma@example.test" && logins[0].count === 3 && logins[1].username === "sgs@example.test" && logins[1].count === 1, JSON.stringify(logins));
  assert("each login carries the utility rows stored under it (a mistyped password still belongs to its username)",
    logins[0].utilityIds.join() === "100,101,103" && logins[1].utilityIds.join() === "102");
  assert("another provider's login is not listed", !logins.some(l => l.username === "gas@example.test"));
  assert("the slug is short, stable and case-insensitive", sel.loginSlug("SGS@example.test") === sel.loginSlug("sgs@example.test ") && /^[0-9a-f]{8}$/.test(sel.loginSlug("sgs@example.test")));
  const sweep = fs.readFileSync(path.join(root, "worker", "portals", "sweep.js"), "utf8");
  assert("the sweep reads every account every day (no 25-day skip)", !/SKIP_DAYS/.test(sweep) && /HOUSY_LOGIN_UTILITY_IDS/.test(sweep));
  assert("the sweep re-downloads a statement only when the figures changed or none is on file", /\(!unchanged \|\| !pass\.has_statement \|\| force\)/.test(sweep));
  const runner = fs.readFileSync(path.join(root, "worker", "portals", "run-portal.js"), "utf8");
  assert("run-portal signs in to each login with its own session and sweeps only its rows", /HOUSY_SESSION_SUFFIX: suffix/.test(runner) && /HOUSY_LOGIN_UTILITY_IDS: login\.utilityIds\.join/.test(runner));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
