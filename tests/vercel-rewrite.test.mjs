// The SPA rewrite must send app paths to index.html WITHOUT swallowing
// the things that are not the app.
//
// Real paths need a rewrite or a hard refresh on /accounting/reports
// returns 404. But a naive `/(.*) -> /index.html` also captures:
//
//   /api/*      the Vercel serverless functions -- Teller mTLS, Plaid,
//               Stripe webhooks, the notification worker and the crons.
//               Swallowing these breaks bank sync and every cron job.
//   /sign/*     the public signing route, which App.js handles before any
//               auth bootstrapping so anonymous signers can reach it.
//
// `npx serve -s build` fakes an SPA fallback for everything, so serving
// the build locally proves NOTHING about this file. It has to be asserted
// against the config itself.
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
let pass = 0, fail = 0;
const assert = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`); }
};

const cfg = JSON.parse(readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
const rewrites = cfg.rewrites || [];

// Only meaningful once the path router lands; until then this file
// documents the contract rather than failing the suite.
if (rewrites.length === 0) {
  console.log("SKIP  no rewrites yet — hash routing still in use");
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
}

assert("a rewrite sends app paths to the SPA shell",
  rewrites.some(r => /index\.html|\/$/.test(r.destination)));

// Simulate Vercel's matching: a source is either a path pattern with
// :params / * or a regex-ish string. Check the dangerous paths do not
// match any rewrite whose destination is the shell.
const shellRules = rewrites.filter(r => /index\.html/.test(r.destination));
const toRegExp = (src) => new RegExp("^" + src
  .replace(/\((?!\?)/g, "(?:")            // keep groups non-capturing
  .replace(/:\w+\*/g, ".*")
  .replace(/:\w+/g, "[^/]+")
  .replace(/(?<!\.)\*/g, ".*") + "$");

for (const danger of ["/api/teller-sync-transactions", "/api/notifications", "/sign/abc123token"]) {
  const caught = shellRules.filter(r => { try { return toRegExp(r.source).test(danger); } catch { return false; } });
  assert(`${danger} is NOT rewritten to the SPA shell`, caught.length === 0,
    `matched by: ${caught.map(r => r.source).join(", ")}`);
}

for (const appPath of ["/dashboard", "/accounting/reports", "/accounting/chart-of-accounts", "/tenants"]) {
  const caught = shellRules.filter(r => { try { return toRegExp(r.source).test(appPath); } catch { return false; } });
  assert(`${appPath} IS rewritten to the SPA shell`, caught.length > 0,
    "a hard refresh on this path would 404");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
