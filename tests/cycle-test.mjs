// Cycle every Washington Gas account and read each balance.
//
// Read-only. Proves two things that payment depends on: that the switch
// can be driven, and that it can be VERIFIED -- a switch that silently
// failed would report the previous property's balance under the new
// property's name.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { listAccounts, selectAccount, currentAccount } = req("../worker/portals/accounts.js");

const MONTHS = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
const isoDate = s => {
  const w = String(s).match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
  if (w && MONTHS[w[1].toLowerCase()]) return `${w[3]}-${String(MONTHS[w[1].toLowerCase()]).padStart(2,"0")}-${String(w[2]).padStart(2,"0")}`;
  const m = String(s).match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  return m ? `${m[3].length===2?"20"+m[3]:m[3]}-${String(m[1]).padStart(2,"0")}-${String(m[2]).padStart(2,"0")}` : null;
};

const b = await chromium.launch();
const ctx = await b.newContext({
  storageState: JSON.parse(readFileSync(`${process.env.HOME}/.housy-sessions/washington_gas.json`, "utf8")),
  viewport: { width: 1280, height: 950 },
});
const p = await ctx.newPage();
await p.goto("https://my.washingtongas.com/portal/", { waitUntil: "domcontentloaded", timeout: 45000 });
await p.getByRole("heading", { name: /current balance/i }).first().waitFor({ state: "visible", timeout: 25000 }).catch(() => {});

const { ok, accounts, reason } = await listAccounts(p);
if (!ok) { console.log("could not list accounts:", reason); await b.close(); process.exit(1); }
console.log(`${accounts.length} accounts\n`);

let total = 0, read = 0;
for (const a of accounts) {
  const sel = await selectAccount(p, a.number);
  if (!sel.ok) { console.log(`  ${a.number}  ${a.address.slice(0,28).padEnd(28)}  SWITCH FAILED: ${sel.reason}`); continue; }

  // Confirmed on the right account before reading a single number.
  const on = await currentAccount(p);
  const heading = p.getByRole("heading", { name: /current balance/i }).first();
  let amt = null, due = null;
  if (await heading.count().catch(() => 0)) {
    for (const scope of [heading.locator("xpath=.."), heading.locator("xpath=../..")]) {
      const t = (await scope.innerText().catch(() => "")).replace(/\s+/g, " ");
      const m = t.match(/\$\s?([\d,]+\.\d{2})/);
      if (m) { amt = Number(m[1].replace(/,/g, "")); const d = t.match(/due\s+on\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i); if (d) due = isoDate(d[1]); break; }
    }
  }
  if (amt != null) { total += amt; read++; }
  console.log(`  ${on === a.number ? "ok " : "!! "} ${a.number}  ${a.address.slice(0,26).padEnd(26)}  ${amt == null ? "     —" : ("$" + amt.toFixed(2)).padStart(9)}  ${due || ""}`);
}
console.log(`\nread ${read}/${accounts.length} · total outstanding $${total.toFixed(2)}`);
await b.close();
