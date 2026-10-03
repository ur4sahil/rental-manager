// One portal, every login: sign in to each distinct login stored for the
// provider (a company can hold two or three Pepco logins, one per landlord
// entity) and sweep the accounts under each. Until 2026-10-03 the agent
// signed in with the majority login only and reported every account under
// the others as "not in this portal login" -- three Pepco accounts were
// never read.
//
//   node portals/run-portal.js <portal>
//
// Per login: ensure-session.js (pinned to that username, with its own
// session file and browser profile: <portal>@<slug>.json), then sweep.js
// restricted to that login's utility rows. The FIRST login's session is also
// written to the plain <portal>.json, which the payment browser on the
// Oracle box is given (run-utilities.sh shares it). Exit code: non-zero when
// any login's sweep failed.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const portal = (process.argv[2] || "").toLowerCase();
if (!portal) { console.error("usage: run-portal.js <portal>"); process.exit(2); }
const SESSION_DIR = process.env.HOUSY_SESSION_DIR || path.join(require("os").homedir(), ".housy-sessions");
const here = (f) => path.join(__dirname, f);
const run = (args, env) => spawnSync(process.execPath, args, { stdio: "inherit", env: { ...process.env, ...env } }).status ?? 1;

// The logins (usernames + the utility rows under each). Printed as one JSON
// line by ensure-session --logins; anything else it prints goes to stderr.
const list = spawnSync(process.execPath, [here("ensure-session.js"), portal, "--logins"], { encoding: "utf8", env: process.env });
let logins = [];
try { logins = JSON.parse((list.stdout || "").trim().split("\n").pop() || "[]"); } catch { logins = []; }
if (list.status !== 0 || !Array.isArray(logins) || !logins.length) {
  if (list.stderr) process.stderr.write(list.stderr);
  console.log(`${portal}: could not list the stored logins — signing in with the majority login as before`);
  const rc = run([here("ensure-session.js"), portal], {});
  if (rc !== 0) console.log(`ensure-session ${portal} exited ${rc}`);
  process.exit(run([here("sweep.js"), portal], {}));
}

console.log(`${portal}: ${logins.length} login${logins.length === 1 ? "" : "s"} stored — ${logins.map(l => `${l.username} (${l.count} account${l.count === 1 ? "" : "s"})`).join(", ")}`);
let worst = 0;
logins.forEach((login, i) => {
  // The first (most-used) login keeps the plain session file the rest of the
  // agent and the payment browser know; later logins get their own.
  const suffix = i === 0 ? "" : login.slug;
  // Several logins share the portal's one warmed browser profile (a fresh
  // profile per login fails reCAPTCHA); ensure-session swaps the portal's
  // cookies to this login's own saved session.
  const env = { HOUSY_PREFER_USER: login.username, HOUSY_SESSION_SUFFIX: suffix, HOUSY_LOGIN_UTILITY_IDS: login.utilityIds.join(","),
    ...(logins.length > 1 ? { HOUSY_SHARED_PROFILE: "1" } : {}) };
  console.log(`----- ${portal} login ${i + 1}/${logins.length}: ${login.username} -----`);
  const rc = run([here("ensure-session.js"), portal], env);
  if (rc !== 0) { console.log(`ensure-session ${portal} (${login.username}) exited ${rc}`); worst = Math.max(worst, rc); }
  const sessionFile = path.join(SESSION_DIR, `${portal}${suffix ? "@" + suffix : ""}.json`);
  if (!fs.existsSync(sessionFile)) { console.log(`${portal}: no session for ${login.username} — its ${login.count} account(s) are not read today`); worst = Math.max(worst, 1); return; }
  const src = run([here("sweep.js"), portal], env);
  if (src !== 0) { console.log(`sweep ${portal} (${login.username}) exited ${src}`); worst = Math.max(worst, src); }
});
process.exit(worst);
