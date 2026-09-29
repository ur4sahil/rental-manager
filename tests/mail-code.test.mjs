// worker/portals/mail-code.js -- reading a one-time sign-in code from Mail.
// 2026-09-29: BGE was sent a WRONG code because the old reader took the first
// six-digit run in the raw .emlx (a header number) and picked messages by file
// mtime. These tests pin the fix: decode the body, take only the labelled
// code, and find messages through Mail's index by arrival time.
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
const require = createRequire(import.meta.url);
const mc = require("../worker/portals/mail-code.js");

let passed = 0, failed = 0;
const assert = (name, ok, detail = "") => {
  if (ok) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (detail ? "  — " + detail : "")); }
};
const emlx = msg => `${Buffer.byteLength(msg, "latin1")}\n${msg}<?xml version="1.0"?><plist><dict/></plist>`;

// A BGE-shaped message: headers full of six-digit runs, QP HTML body, the code
// split across a soft line break.
const HEADERS = [
  "Received: by 2002:a05:6400:98dd with SMTP id m12csp461234eja;",
  "X-Received: by 2002:a05:6808:c6f2 with SMTP id 563412812f47-4e;",
  "ARC-Seal: i=1; a=rsa-sha256; t=1790686577; cv=none; d=google.com; s=arc-20240605;",
  "From: BGE <no-reply@bge.com>",
  "Subject: Here is your six-digit verification code",
  "Content-Type: text/html; charset=us-ascii",
  "Content-Transfer-Encoding: quoted-printable",
].join("\r\n");
const BODY = '<html><style>td{color:#123456}</style><body><!-- enter the code below. -->'
  + '<p>Here=E2=80=99s your six-digit verification code:</p><p style=3D"font-size:24px">48=\r\n2917</p>'
  + '<p>This code will only be active for 20 minutes. Ref 000123</p></body></html>';
const BGE = `${HEADERS}\r\n\r\n${BODY}`;

console.log("\n📨 BODY DECODING");
const text = mc.messageText(emlx(BGE));
assert("headers are not part of the text", !/SMTP id|arc-20240605/.test(text), text.slice(0, 80));
assert("quoted-printable soft break joined", /482917/.test(text));
assert("HTML and CSS stripped", !/<p|color:#/.test(text));
assert("BGE-shaped message -> the labelled code, not a header number", mc.extractCode(text) === "482917", mc.extractCode(text));

const OLD_REGEX_WOULD = (() => { // what the pre-fix reader returned on the same file
  const raw = emlx(BGE);
  const near = raw.match(/code[^0-9]{0,40}(\d{6})/i) || raw.match(/(\d{6})[^0-9]{0,40}code/i);
  const any = raw.match(/\b\d{6}\b/);
  return near ? near[1] : (any ? any[0] : null);
})();
assert("(regression) the old raw-file regex got this wrong", OLD_REGEX_WOULD !== "482917", String(OLD_REGEX_WOULD));

console.log("\n🧩 MIME SHAPES");
const b64html = Buffer.from("<div>Your security code is <b>731055</b>. Do not share it.</div>").toString("base64");
const MULTI = [
  "From: Some Portal <codes@example.com>",
  'Content-Type: multipart/mixed; boundary="OUT"',
  "", "--OUT",
  'Content-Type: multipart/alternative; boundary="IN"',
  "", "--IN",
  "Content-Type: text/plain; charset=utf-8", "", "Your security code is 731055.",
  "--IN",
  "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64html,
  "--IN--",
  "--OUT",
  "Content-Type: image/png", "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo123456AAAA",
  "--OUT--", "",
].join("\r\n");
const mt = mc.messageText(emlx(MULTI));
assert("nested multipart: text + base64 html decoded", /731055/.test(mt) && !/<b>/.test(mt));
assert("nested multipart: image part ignored", !/iVBOR/.test(mt));
assert("nested multipart -> code", mc.extractCode(mt) === "731055");
assert("unlabelled single six-digit run -> that run", mc.extractCode("Use 905511 to finish signing in.") === "905511");
assert("several unlabelled runs -> null (never guess)", mc.extractCode("Order 123456 shipped to 20774, ref 654321") === null);
assert("no digits -> null", mc.extractCode("Welcome back") === null);
assert("labelled code wins over other runs", mc.extractCode("Account 555555. Your verification code: 246810. Ref 999999") === "246810");

console.log("\n🗂️  MAIL INDEX + FILE LOOKUP (fake ~/Library/Mail)");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mailcode-"));
try {
  const vdir = path.join(root, "V10");
  const acct = "7A03AD30-A24E-4167-830A-47EAF1D6834C";
  const mboxData = path.join(vdir, acct, "[Gmail].mbox", "All Mail.mbox", "D15C00CB-UUID", "Data");
  const put = (rowid, msg) => {
    const k = Math.floor(rowid / 1000);
    const dir = path.join(mboxData, ...(k > 0 ? String(k).split("").reverse() : []), "Messages");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${rowid}.emlx`), emlx(msg), "latin1");
  };
  fs.mkdirSync(path.join(vdir, "MailData"), { recursive: true });
  const db = path.join(vdir, "MailData", "Envelope Index");
  const now = Math.floor(Date.now() / 1000);
  const url = `imap://${acct}/%5BGmail%5D/All%20Mail`;
  execFileSync("/usr/bin/sqlite3", [db,
    "CREATE TABLE addresses(ROWID INTEGER PRIMARY KEY, address TEXT);"
    + "CREATE TABLE mailboxes(ROWID INTEGER PRIMARY KEY, url TEXT);"
    + "CREATE TABLE messages(ROWID INTEGER PRIMARY KEY, sender INTEGER, mailbox INTEGER, date_received INTEGER);"
    + "INSERT INTO addresses VALUES (1,'no-reply@bge.com'),(2,'someone@else.com');"
    + `INSERT INTO mailboxes VALUES (1,'${url}');`
    + `INSERT INTO messages VALUES (252175,1,1,${now - 86400}),(281140,1,1,${now - 5}),(281141,2,1,${now});`]);
  put(252175, BGE.replace("48=\r\n2917", "111=\r\n111"));   // yesterday's code: must NOT be used
  put(281141, "From: someone@else.com\r\nContent-Type: text/plain\r\n\r\nYour verification code: 999999");

  process.env.HOUSY_CODE_MAILDIR = root;
  const since = (now - 60) * 1000;
  assert("emlxPathFor maps ROWID 281140 -> Data/1/8/2/Messages",
    mc.emlxPathFor(vdir, url, 281140) === null); // not written yet
  assert("indexed but body not on disk yet -> null (poll again)", mc.readCodeFromMail(since) === null);
  put(281140, BGE);
  assert("emlxPathFor finds the file once written", /Data\/1\/8\/2\/Messages\/281140\.emlx$/.test(mc.emlxPathFor(vdir, url, 281140) || ""));
  assert("reads today's code, not yesterday's, not another sender's", mc.readCodeFromMail(since) === "482917", String(mc.readCodeFromMail(since)));
  assert("only messages that ARRIVED after the trigger count", mc.readCodeFromMail((now + 120) * 1000) === null);
  // An old message whose FILE is rewritten now (Mail re-index) must still be ignored.
  const oldFile = mc.emlxPathFor(vdir, url, 252175);
  fs.utimesSync(oldFile, new Date(), new Date());
  assert("a re-touched old file is not mistaken for a new message", mc.readCodeFromMail(since) === "482917");
  assert("other sender needs its own sender argument", mc.readCodeFromMail(since, "someone@else.com") === "999999");
  assert("missing Mail dir -> null, no throw", (() => { process.env.HOUSY_CODE_MAILDIR = path.join(root, "nope"); return mc.readCodeFromMail(since) === null; })());
} finally {
  delete process.env.HOUSY_CODE_MAILDIR;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("\n🔌 WIRING");
const es = fs.readFileSync(new URL("../worker/portals/ensure-session.js", import.meta.url), "utf8");
assert("ensure-session uses mail-code.js", /require\("\.\/mail-code"\)/.test(es));
assert("the old raw-file reader is gone", !/function readCodeFromMail/.test(es) && !/mtimeMs < sinceMs/.test(es));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
