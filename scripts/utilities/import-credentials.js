#!/usr/bin/env node
/**
 * Stores utility portal logins from the "Utilities NEW" workbook onto each
 * matching utilities row.
 *
 * ENCRYPTION HAPPENS SERVER-SIDE. Every password is sent to the live
 * /api/encrypt, which holds ENCRYPTION_KEY as a Vercel secret and returns
 * ciphertext + iv + salt + a fingerprint of the key that did it. This
 * script never holds the master key, and -- more importantly -- the
 * ciphertext is therefore guaranteed readable by the same deployment that
 * will later decrypt it.
 *
 * That guarantee is the whole point. ENCRYPTION_KEY was rotated at some
 * point with nothing migrating the existing rows, and every stored utility
 * credential silently became unreadable: the app showed a credential that
 * simply never opened. Encrypting locally with a key pulled from `vercel
 * env` would risk repeating exactly that -- the key that pull returns did
 * NOT decrypt production's own Plaid token when tested.
 *
 * Credentials are stored PER PROPERTY, which is how the utilities table is
 * shaped: one BGE Sigma login lands on all 17 BGE Sigma rows. A password
 * change therefore means re-running this, not editing one row.
 *
 *   SH_EMAIL=... SH_PASS=... node import-credentials.js --company <uuid> [--commit]
 */
const ExcelJS = require("exceljs");
const path = require("path");
const { pathToFileURL } = require("url");
const { createClient } = require("@supabase/supabase-js");

const WB = process.env.UTIL_WORKBOOK ||
  "/Users/aggar/Library/CloudStorage/Dropbox/Utilities NEW.xlsx";
const APP = process.env.APP_ORIGIN || "https://housify365.com";
const args = process.argv.slice(2);
const argv = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const COMPANY = argv("--company");
const COMMIT = args.includes("--commit");
if (!COMPANY) { console.error("--company <uuid> required"); process.exit(1); }

const txt = c => { const v = c && c.value; if (v == null) return "";
  if (typeof v === "object") return String(v.richText ? v.richText.map(t => t.text).join("") : (v.text || v.result || "")).trim();
  return String(v).trim(); };

// Not a credential: these portals take a payment without an account.
const NOT_A_LOGIN = /^(guest payment|guest|n\/a|none)$/i;

(async () => {
  const { canonicalProvider } = await import(
    pathToFileURL(path.join(__dirname, "../../src/utils/providers.js")).href);

  // ---- read the logins ------------------------------------------------
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(WB);
  const sheet = wb.getWorksheet("Usernames & Passwords");
  const logins = new Map();          // canonical provider -> {user, pass, url}
  for (let r = 1; r <= 40; r++) {
    const row = sheet.getRow(r);
    const provider = txt(row.getCell(1)), user = txt(row.getCell(2)),
          pass = txt(row.getCell(3)), url = txt(row.getCell(5));
    if (!provider || !user || !pass) continue;
    if (/^(username|gas|electricity|water)$/i.test(user)) continue;   // block headers
    if (NOT_A_LOGIN.test(user)) continue;
    const canon = canonicalProvider(provider);
    if (!logins.has(canon)) logins.set(canon, { user, pass, url, raw: provider });
  }
  console.log(`workbook: ${logins.size} usable provider logins`);
  console.log(`  ${[...logins.keys()].join(", ")}\n`);

  // ---- sign in as a real user; the endpoint requires a session ---------
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY);
  const { data: auth, error: authErr } = await sb.auth.signInWithPassword({
    email: process.env.SH_EMAIL, password: process.env.SH_PASS,
  });
  if (authErr || !auth?.session) { console.error("sign-in failed:", authErr?.message); process.exit(1); }
  const token = auth.session.access_token;
  console.log(`signed in as ${auth.user.email}\n`);

  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: utils, error } = await admin.from("utilities")
    .select("id, provider, property, username_encrypted, website")
    .eq("company_id", COMPANY).is("archived_at", null);
  if (error) throw error;

  // Per-company alias. A company's utility rows say "BGE" because that
  // company has exactly one BGE account; the workbook names the login by
  // the LLC that holds it ("BGE Sigma"). The suffix is a fact about the
  // credential, not about the property, so it is resolved here rather than
  // pushed back into the stored provider name.
  const COMPANY_ALIAS = {
    "f985cc7a-0d6b-4905-aea9-4b6eb9fd1dec": { "BGE": "BGE Sigma" },
  };
  const alias = COMPANY_ALIAS[COMPANY] || {};

  const plan = [], noLogin = [];
  const RESUME = !process.argv.includes("--overwrite");
  for (const u of utils) {
    // resumable: a row that already holds a credential is left alone unless
    // --overwrite is passed, so a partial run can simply be run again
    if (RESUME && u.username_encrypted) continue;
    const canon = canonicalProvider(u.provider);
    const hit = logins.get(canon) || logins.get(alias[canon] || "");
    if (hit) plan.push({ u, cred: hit }); else noLogin.push(u);
  }
  const byProv = plan.reduce((m, p) => { m[p.u.provider] = (m[p.u.provider] || 0) + 1; return m; }, {});
  console.log(`WILL STORE credentials on ${plan.length} of ${utils.length} rows:`);
  Object.entries(byProv).sort((a, b) => b[1] - a[1]).forEach(([p, n]) => console.log(`  ${String(n).padStart(3)}  ${p}`));
  const byNo = noLogin.reduce((m, u) => { m[u.provider] = (m[u.provider] || 0) + 1; return m; }, {});
  if (noLogin.length) {
    console.log(`\nNO LOGIN IN THE WORKBOOK (${noLogin.length}):`);
    Object.entries(byNo).forEach(([p, n]) => console.log(`  ${String(n).padStart(3)}  ${p}`));
  }
  if (!COMMIT) { console.log(`\nDRY RUN — nothing written. Re-run with --commit.`); return; }

  // ---- encrypt through the app, then write ----------------------------
  // Two encrypt calls per row, so a full run is hundreds of requests against
  // a one-hour access token. The first attempt expired 27 rows from the end
  // and reported "Invalid session" -- re-sign in and retry once rather than
  // leaving a partial write behind.
  let bearer = token;
  const encryptOnce = async (plaintext, salt) => {
    const r = await fetch(`${APP}/api/encrypt`, {
      method: "POST",
      headers: { "Authorization": "Bearer " + bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "encrypt", companyId: COMPANY, plaintext, ...(salt ? { salt } : {}) }),
    });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
  };
  const encrypt = async (plaintext, salt) => {
    let res = await encryptOnce(plaintext, salt);
    if (!res.ok && (res.status === 401 || /session/i.test(res.body.error || ""))) {
      const { data: again, error: e } = await sb.auth.signInWithPassword({
        email: process.env.SH_EMAIL, password: process.env.SH_PASS,
      });
      if (e || !again?.session) throw new Error("re-auth failed: " + (e?.message || "no session"));
      bearer = again.session.access_token;
      res = await encryptOnce(plaintext, salt);
    }
    if (!res.ok) throw new Error(res.body.error || `HTTP ${res.status}`);
    return res.body;                            // { ciphertext, iv, salt, keyFp }
  };

  let done = 0, failed = 0;
  for (const [i, p] of plan.entries()) {
    try {
      // ONE salt, TWO IVs -- which is what the schema says: there is a
      // single encryption_salt column beside encryption_iv_username and
      // encryption_iv. Encrypting each value in its own call mints a fresh
      // salt per call, and only one can be stored, so the username was
      // written under a salt that was then thrown away. It encrypted
      // without error and simply would not come back; the passwords, whose
      // salt happened to be the one kept, decrypted fine and hid it.
      const pEnc = await encrypt(p.cred.pass);
      const uEnc = await encrypt(p.cred.user, pEnc.salt);
      // The endpoint returns { encrypted, iv, salt, keyFp } -- NOT
      // "ciphertext". Reading j.ciphertext gave undefined, PostgREST drops
      // undefined keys from the payload, and 50 rows ended up with fresh
      // iv/salt/key_fp bolted onto their OLD ciphertext: silently
      // undecryptable, and no error anywhere. Assert rather than trust.
      if (!uEnc.encrypted || !pEnc.encrypted) {
        throw new Error("encrypt returned no ciphertext -- field names: " + Object.keys(pEnc).join(","));
      }
      const { error: e } = await admin.from("utilities").update({
        username_encrypted: uEnc.encrypted,
        encryption_iv_username: uEnc.iv,
        password_encrypted: pEnc.encrypted,
        encryption_iv: pEnc.iv,
        encryption_salt: pEnc.salt,
        credential_key_fp: pEnc.keyFp,
        website: p.u.website || p.cred.url || null,
      }).eq("id", p.u.id).eq("company_id", COMPANY);
      if (e) throw new Error(e.message);
      done++;
      if (done % 10 === 0) console.log(`  stored ${done}/${plan.length}`);
    } catch (err) {
      console.error(`  ${p.u.provider} @ ${String(p.u.property).slice(0, 36)}: ${err.message}`);
      failed++;
    }
  }
  console.log(`\nstored ${done}, failed ${failed}`);
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
