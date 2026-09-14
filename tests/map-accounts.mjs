// What accounts are behind the switcher? Read-only: opens the selector and
// lists what it offers. Clicks nothing else.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const b = await chromium.launch();
const ctx = await b.newContext({
  storageState: JSON.parse(readFileSync(`${process.env.HOME}/.housy-sessions/washington_gas.json`, "utf8")),
  viewport: { width: 1280, height: 950 },
});
const p = await ctx.newPage();
await p.goto("https://my.washingtongas.com/portal/", { waitUntil: "domcontentloaded", timeout: 45000 });
await p.waitForTimeout(6000);

// The switcher appears as a button naming the CURRENT account.
const sw = p.getByRole("button", { name: /\d{6,}|expand_more/ }).filter({ hasNotText: /^close$/i });
const n = await sw.count();
console.log(`switcher-shaped buttons: ${n}`);
for (let i = 0; i < Math.min(n, 4); i++) {
  console.log(`  [${i}] ${(await sw.nth(i).innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 70)}`);
}
if (!n) { console.log("none found"); await b.close(); process.exit(0); }

// Open it and see the list.
const target = sw.filter({ hasText: /\d{6,}/ }).first();
const which = (await target.count()) ? target : sw.first();
console.log(`\nopening: "${(await which.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 60)}"`);
await which.click();
await p.waitForTimeout(4000);

const yaml = await p.locator("body").ariaSnapshot({ timeout: 15000 }).catch(() => "");
const rows = yaml.split("\n").map(l => l.trim().replace(/^-\s*/, ""))
  .filter(l => /\d{8,}|DR|ST |AVE|CT |LN |PL |RD |TER/i.test(l))
  .filter(l => /^(option|link|button|listitem|radio|cell|text)/.test(l) || /\d{8,}/.test(l));
console.log(`\naccounts offered (${rows.length}):`);
[...new Set(rows)].slice(0, 15).forEach(r => console.log("   ", r.slice(0, 76)));
await b.close();
