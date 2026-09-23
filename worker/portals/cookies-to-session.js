#!/usr/bin/env node
// Convert a Cookie-Editor "Export" JSON (an array of cookies) into a Playwright
// storageState file the portal sweep can reuse.
//
//   node cookies-to-session.js <cookie-editor.json> <out/washington_gas.json>
//
// Cookies captured on a RESIDENTIAL browser after a real human login carry the
// session that reCAPTCHA v3 already blessed; the box reuses it to READ bills
// (no re-login, so no reCAPTCHA at read time). httpOnly cookies ARE included in
// the export, which is why this path works where a JS bookmarklet cannot.
const fs = require("fs");
const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) { console.error("usage: cookies-to-session.js <cookie-editor.json> <out.json>"); process.exit(1); }

const raw = JSON.parse(fs.readFileSync(inPath, "utf8"));
const arr = Array.isArray(raw) ? raw : (raw.cookies || []);
const sameSiteMap = { no_restriction: "None", none: "None", lax: "Lax", strict: "Strict", unspecified: "Lax" };

const cookies = arr.map(c => {
  let domain = c.domain || "";
  // Cookie-Editor sometimes stores a host-only cookie without the leading dot;
  // Playwright is fine either way as long as it matches the visited host.
  const expires = c.session ? -1 : (Number.isFinite(c.expirationDate) ? Math.floor(c.expirationDate) : -1);
  return {
    name: c.name,
    value: c.value,
    domain,
    path: c.path || "/",
    expires,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: sameSiteMap[String(c.sameSite || "lax").toLowerCase()] || "Lax",
  };
}).filter(c => c.name && c.domain);

const state = { cookies, origins: [] };
fs.writeFileSync(outPath, JSON.stringify(state), { mode: 0o600 });
const domains = [...new Set(cookies.map(c => c.domain))];
console.log(JSON.stringify({ ok: true, wrote: outPath, cookieCount: cookies.length, domains }, null, 2));
