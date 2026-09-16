#!/usr/bin/env node
/**
 * Sign in and read the bills, back to back, in one run.
 *
 *   node scripts/utilities/enrol-and-sweep.js pepco
 *   node scripts/utilities/enrol-and-sweep.js pepco smeco wssc
 *   node scripts/utilities/enrol-and-sweep.js --all
 *
 * WHY THIS EXISTS, which is also why it is not a cron on the box.
 *
 * Exelon's portals -- BGE and Pepco, 39 of the 78 utility accounts -- keep
 * their auth in ASP.NET_SessionId and the chunked .AspNet.cookie/C1/C2, none
 * of which carry an expiry. They ride a SERVER-side session that Exelon drops
 * after roughly half an hour idle. A session minted at 12:43 was already dead
 * at 13:08. Ticking the portal's own "Remember Me" does not change it; that
 * was tried and measured.
 *
 * So "enrol today, sweep at 4am" cannot work for those two. The window has to
 * be minutes, which means the two steps belong in one run.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *
 * It does not teach the sweep to log itself back in. sweep.js refuses that on
 * purpose -- "a sweep that logged itself back in would keep degrading the
 * portal's trust score, which is exactly how Washington Gas started refusing
 * us" -- and today produced the evidence: Washington Gas now answers Invalid
 * Captcha to a headless browser while signing in normally from a real one.
 * Automated re-login pushes Pepco and BGE toward the same place.
 *
 * It also does not put credentials on the box. The box is an appliance that
 * holds no database access (tests/ai-never-posts.test.js enforces it), and an
 * unattended cron there would need the app to hand utility passwords to
 * anything carrying the worker token. Instead this runs on a machine where
 * the operator is already authenticated: it decrypts through their own
 * session, pipes the credentials into the remote process over ssh, and never
 * writes them anywhere.
 *
 * Environment:
 *   HOUSIFY_EMAIL, HOUSIFY_PASSWORD   the operator's own app login
 *   HOUSIFY_COMPANY_ID                defaults to Sigma Housing LLC
 *   HOUSY_SSH_KEY, HOUSY_HOST         defaults to the llm-box
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const REPO = path.join(__dirname, "..", "..");
const { PLAYBOOKS } = require(path.join(REPO, "worker", "portals", "playbooks.js"));

const APP = (process.env.HOUSIFY_APP_URL || "https://housify365.com").replace(/\/$/, "");
const COMPANY = process.env.HOUSIFY_COMPANY_ID || "f985cc7a-0d6b-4905-aea9-4b6eb9fd1dec";
const SSH_KEY = process.env.HOUSY_SSH_KEY || path.join(os.homedir(), "oracle-llm-setup", "id_llm");
const HOST = process.env.HOUSY_HOST || "ubuntu@150.136.226.115";
const REMOTE = "~/housify-worker";

function die(msg) { console.error("\n" + msg + "\n"); process.exit(1); }

// ---- the operator's own session, not a service key -----------------------
function envFile() {
  for (const f of [".env.local", ".env"]) {
    const p = path.join(REPO, f);
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  }
  return "";
}
async function signIn() {
  const env = envFile();
  const url = (env.match(/REACT_APP_SUPABASE_URL=(\S+)/) || [])[1];
  const anon = (env.match(/REACT_APP_SUPABASE_ANON_KEY=(\S+)/) || [])[1];
  if (!url || !anon) die("No Supabase URL/anon key in .env.local — run this from a checkout that has one.");
  const email = process.env.HOUSIFY_EMAIL, password = process.env.HOUSIFY_PASSWORD;
  if (!email || !password) die("Set HOUSIFY_EMAIL and HOUSIFY_PASSWORD. This signs in as YOU;\nthe box is never given database access, which is the point.");
  const r = await fetch(url + "/auth/v1/token?grant_type=password", {
    method: "POST", headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  if (!j.access_token) die("Sign-in failed: " + JSON.stringify(j).slice(0, 160));
  return { token: j.access_token, url, anon };
}

// ---- credentials, read from the record and decrypted by the app ----------
// The ciphertexts are NOT hardcoded here: they are read per run, so a rotated
// password takes effect without anybody editing a script.
async function loadCredentials({ token, url, anon }) {
  const r = await fetch(
    `${url}/rest/v1/utilities?select=provider,username_encrypted,password_encrypted,encryption_iv,encryption_salt,encryption_iv_username`
    + `&company_id=eq.${COMPANY}&archived_at=is.null&username_encrypted=not.is.null`,
    { headers: { apikey: anon, Authorization: "Bearer " + token } });
  if (!r.ok) die("Could not read utilities: HTTP " + r.status);
  const rows = await r.json();

  // One login per provider family. Rows repeat it per property.
  const byPortal = new Map();
  for (const row of rows) {
    const book = Object.entries(PLAYBOOKS).find(([, b]) =>
      (b.aliases || []).includes(String(row.provider || "").trim().toLowerCase()));
    if (!book) continue;
    if (!byPortal.has(book[0])) byPortal.set(book[0], row);
  }
  return byPortal;
}

async function decrypt(token, ciphertext, iv, salt) {
  const r = await fetch(APP + "/api/encrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ action: "decrypt", companyId: COMPANY, ciphertext, iv, salt }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("decrypt HTTP " + r.status);
  const out = j.plaintext ?? j.decrypted ?? j.text;
  // Be explicit about which key carries the answer. Reading the wrong one
  // yields undefined, which would then be typed into a real login form and
  // burn a real attempt against a real account.
  if (typeof out !== "string") throw new Error("no plaintext in decrypt response");
  return out;
}

// ---- remote steps --------------------------------------------------------
// Credentials travel over the ssh channel into the child's environment. Never
// a file on the box, never a command-line argument (which `ps` would show).
function ssh(remoteCmd, stdin) {
  return new Promise(resolve => {
    const p = spawn("ssh", ["-i", SSH_KEY, "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=20", HOST, remoteCmd], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", d => { out += d; process.stdout.write(d); });
    p.stderr.on("data", d => { err += d; });
    if (stdin) { p.stdin.write(stdin); }
    p.stdin.end();
    p.on("close", code => resolve({ code, out, err }));
  });
}

const LOAD_ENV = `cd ${REMOTE} && set -a && . ./.env && set +a`;

async function enrol(portal, user, pass) {
  const cmd = `read -r u; read -r p; ${LOAD_ENV} && `
    + `HOUSY_SHOT_DIR=${REMOTE}/shots HEADLESS=1 PORTAL_USER="$u" PORTAL_PASS="$p" `
    + `timeout 240 node portals/verify-login.mjs ${portal} 2>&1 | grep -viE '^landed'`;
  const { out } = await ssh(cmd, user + "\n" + pass + "\n");

  // Did we get THROUGH? Ask that before asking whether anything blocked us,
  // because the answer makes the second question moot -- and because a loose
  // refusal test reads its own diagnostics as a refusal. The first version of
  // this matched /captcha/i against output containing the line
  // "login form present: true | captcha elements: 0", and reported a
  // successful Pepco enrolment, session saved and $513.99 read, as "the
  // portal refused automation". Exactly the bug this script was written to
  // stop happening to WSSC.
  if (/SIGNED IN: YES/.test(out)) return { ok: true, saved: /session saved/.test(out) };

  if (/THIS PORTAL WANTS A VERIFICATION CODE/.test(out)) {
    return { ok: false, needsHuman: true, why: "asked for a verification code" };
  }
  // Anchored on what a refusal actually SAYS, not on the word appearing
  // anywhere in the log. A refusal is a finding; nothing here works around one.
  if (/page says:[^\n]*(invalid captcha|not a robot|are you human|verify you)/i.test(out)) {
    return { ok: false, needsHuman: true, why: "the portal refused automation (captcha)" };
  }
  const said = (out.match(/page says:\s*([^\n]{0,90})/i) || [])[1];
  return { ok: false, why: said ? "sign-in did not complete — " + said.trim() : "sign-in did not complete" };
}

async function sweep(portal) {
  const { out } = await ssh(`${LOAD_ENV} && timeout 900 node portals/sweep.js ${portal} 2>&1 | grep -viE '^landed'`);
  const read = (out.match(/"read":\s*(\d+)/) || [])[1];
  const failed = (out.match(/"failed":\s*(\d+)/) || [])[1];
  const needs = (out.match(/"needsSignin":\s*(\d+)/) || [])[1];
  return { read: Number(read || 0), failed: Number(failed || 0), needsSignin: Number(needs || 0) };
}

// ---- main ----------------------------------------------------------------
(async () => {
  const args = process.argv.slice(2);
  const wantAll = args.includes("--all");
  const asked = args.filter(a => !a.startsWith("--"));

  const session = await signIn();
  const creds = await loadCredentials(session);

  let portals = wantAll ? [...creds.keys()] : asked;
  if (!portals.length) {
    die(`usage: enrol-and-sweep.js <portal…> | --all\n\nwith credentials on file: ${[...creds.keys()].join(", ") || "(none)"}`);
  }
  const unknown = portals.filter(p => !PLAYBOOKS[p]);
  if (unknown.length) die("unknown portal(s): " + unknown.join(", "));

  const summary = [];
  for (const portal of portals) {
    const row = creds.get(portal);
    console.log(`\n${"─".repeat(64)}\n${portal}\n${"─".repeat(64)}`);
    if (!row) { summary.push({ portal, note: "no credentials on file" }); continue; }

    // BGE demands a code every time, and the code goes to the account holder.
    // Say so up front rather than opening a browser that will sit waiting.
    if (PLAYBOOKS[portal].mfa) {
      console.log("  needs a verification code — a person has to be here.");
      console.log("  run it on its own and read the code back when prompted.");
      summary.push({ portal, note: "needs a human (MFA)" });
      continue;
    }

    let user, pass;
    try {
      user = await decrypt(session.token, row.username_encrypted, row.encryption_iv_username, row.encryption_salt);
      pass = await decrypt(session.token, row.password_encrypted, row.encryption_iv, row.encryption_salt);
    } catch (e) { summary.push({ portal, note: "could not decrypt: " + e.message }); continue; }

    const signedIn = await enrol(portal, user, pass);
    user = pass = null;                       // done with them
    if (!signedIn.ok) { summary.push({ portal, note: signedIn.why }); continue; }

    // Straight into the sweep, while the session is minutes old. This is the
    // entire point of the script.
    const s = await sweep(portal);
    summary.push({ portal, ...s });
  }

  console.log(`\n${"═".repeat(64)}`);
  for (const r of summary) {
    if (r.note) console.log(`  ${r.portal.padEnd(16)} ${r.note}`);
    else console.log(`  ${r.portal.padEnd(16)} read ${r.read}, failed ${r.failed}, needs sign-in ${r.needsSignin}`);
  }
  console.log("");
})().catch(e => die(String(e && e.stack || e)));
