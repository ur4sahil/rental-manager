// Read a one-time sign-in code (e.g. BGE's six-digit code) from the local
// macOS Mail store -- no IMAP, no mail credentials.
//
// Two things went wrong with the first version (2026-09-29, BGE entered a
// wrong code):
//   1. It ran a regex over the RAW .emlx file. The headers (Received / ARC /
//      DKIM / SMTP ids, timestamps) are full of six-digit runs, and the body is
//      quoted-printable HTML, so "the first six digits in the file" was a
//      header number, not the code.
//   2. It picked messages by file mtime. Mail writes a message body to disk
//      minutes after it arrives and rewrites old files when it re-indexes, so
//      mtime says nothing about when a message ARRIVED.
// Now: Mail's own index ("Envelope Index", SQLite) says which messages came
// from the sender and when they were received; the body is decoded (headers
// skipped, quoted-printable / base64 undone, HTML stripped) and only the digit
// run labelled as the code is taken.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

// The RFC822 message inside an .emlx: line 1 is its byte length, then the
// message, then an Apple plist.
function emlxMessage(raw) {
  const nl = raw.indexOf("\n");
  const len = parseInt(raw.slice(0, nl), 10);
  return Number.isFinite(len) && len > 0 ? raw.slice(nl + 1, nl + 1 + len) : raw;
}

function decodeQP(s) {
  return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Readable text of every text part: headers dropped, transfer encodings
// undone, HTML reduced to text.
// One MIME entity -> the decoded text of its text/* leaves (multipart recursed).
function entityTexts(entity, depth = 0) {
  const split = entity.search(/\r?\n\r?\n/);
  if (split < 0 || depth > 6) return [];
  const head = entity.slice(0, split).replace(/\r?\n[ \t]+/g, " "); // unfold headers
  const body = entity.slice(split).replace(/^\s+/, "");
  const type = ((head.match(/^content-type:\s*([^;\s]+)/im) || [])[1] || "text/plain").toLowerCase();
  if (type.startsWith("multipart/")) {
    const boundary = (head.match(/boundary="?([^";\r\n]+)"?/i) || [])[1];
    if (!boundary) return [];
    return body.split("--" + boundary).slice(1)
      .filter(p => !p.startsWith("--"))
      .flatMap(p => entityTexts(p.replace(/^\r?\n/, ""), depth + 1));
  }
  if (!type.startsWith("text/")) return [];
  const enc = ((head.match(/^content-transfer-encoding:\s*(\S+)/im) || [])[1] || "").toLowerCase();
  if (enc === "quoted-printable") return [decodeQP(body)];
  if (enc === "base64") {
    try { return [Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8")]; } catch { return []; }
  }
  return [body];
}

function messageText(raw) {
  return entityTexts(emlxMessage(raw)).join(" ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&#?[a-z0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The code in a message's text: the six digits the text labels as the code;
// failing that, the ONLY six-digit run in the body. Never a guess among several.
function extractCode(text) {
  const t = String(text || "");
  const labelled = t.match(/(?:verification|security|one[- ]time|sign[- ]in|login|passcode)?\s*code\b[^0-9]{0,60}\b(\d{6})\b/i);
  if (labelled) return labelled[1];
  const runs = t.match(/\b\d{6}\b/g) || [];
  return runs.length === 1 ? runs[0] : null;
}

function mailRoot() {
  return process.env.HOUSY_CODE_MAILDIR || path.join(os.homedir(), "Library", "Mail");
}

// The newest V<n> directory (V10 on macOS 14-26).
function mailVersionDir(root = mailRoot()) {
  let best = null, bestN = -1;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const m = e.isDirectory() && e.name.match(/^V(\d+)$/);
    if (m && Number(m[1]) > bestN) { bestN = Number(m[1]); best = path.join(root, e.name); }
  }
  return best;
}

// Messages FROM `sender` received at or after `sinceMs`, newest first, with
// their mailbox URL -- straight from Mail's index.
function indexedMessages(sender, sinceMs, vdir) {
  const db = path.join(vdir, "MailData", "Envelope Index");
  if (!fs.existsSync(db)) return null;
  const who = String(sender).toLowerCase().replace(/[^a-z0-9@._+-]/g, "");
  const since = Math.floor(sinceMs / 1000) - 30; // clock skew between Mail and us
  const sql = "SELECT m.ROWID, m.date_received, mb.url FROM messages m "
    + "JOIN addresses a ON a.ROWID = m.sender JOIN mailboxes mb ON mb.ROWID = m.mailbox "
    + `WHERE lower(a.address) = '${who}' AND m.date_received >= ${since} `
    + "ORDER BY m.date_received DESC LIMIT 5;";
  let out;
  try {
    out = execFileSync("/usr/bin/sqlite3", ["-readonly", "-separator", "\t", db, sql], { encoding: "utf8", timeout: 10000 });
  } catch { return null; }
  return out.split("\n").filter(Boolean).map(l => {
    const [rowid, received, url] = l.split("\t");
    return { rowid: Number(rowid), receivedMs: Number(received) * 1000, url };
  });
}

// imap://<account>/%5BGmail%5D/All%20Mail  ->  <V>/<account>/[Gmail].mbox/All Mail.mbox
// Messages live under <mbox>/<uuid>/Data/<digits of rowid/1000, reversed>/Messages/<rowid>.emlx
function emlxPathFor(vdir, url, rowid) {
  const m = String(url || "").match(/^[a-z]+:\/\/([^/]+)\/(.+)$/i);
  if (!m) return null;
  const mbox = path.join(vdir, m[1], ...m[2].split("/").map(s => decodeURIComponent(s) + ".mbox"));
  let uuids;
  try { uuids = fs.readdirSync(mbox, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return null; }
  const k = Math.floor(rowid / 1000);
  const bucket = k > 0 ? String(k).split("").reverse() : [];
  for (const u of uuids) {
    for (const name of [`${rowid}.emlx`, `${rowid}.partial.emlx`]) {
      const p = path.join(mbox, u, "Data", ...bucket, "Messages", name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// The newest code from `sender` that ARRIVED after `sinceMs`, or null until one
// has synced down (the caller polls).
function readCodeFromMail(sinceMs, sender = process.env.HOUSY_CODE_SENDER || "no-reply@bge.com") {
  let vdir;
  try { vdir = mailVersionDir(); } catch { return null; }
  if (!vdir) return null;
  const msgs = indexedMessages(sender, sinceMs, vdir);
  if (!msgs) return null;
  for (const msg of msgs) {
    const file = emlxPathFor(vdir, msg.url, msg.rowid);
    if (!file) continue; // indexed, body not on disk yet -- try again next poll
    let raw;
    try { raw = fs.readFileSync(file, "latin1"); } catch { continue; }
    const code = extractCode(messageText(raw));
    if (code) return code;
  }
  return null;
}

module.exports = { emlxMessage, messageText, extractCode, emlxPathFor, readCodeFromMail };
