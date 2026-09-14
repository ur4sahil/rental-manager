// Map the payment flow WITHOUT paying.
//
// Clicks ONLY the named navigation link and then observes. It never clicks
// anything matching a submit verb -- there is no code path here that could
// send a payment, deliberately, because a mapping run that accidentally
// pays is the worst possible outcome of trying to be careful.
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";

const key = process.argv[2];
const ENTRY = { wssc: "https://my.wsscwater.com/", washington_gas: "https://my.washingtongas.com/portal/" }[key];
const NAV = { wssc: /^(Make a Payment|Pay Bill|Make Payment)$/i, washington_gas: /^Make Payment$/i }[key];

// Anything resembling a final action. Present so the intent is explicit and
// checkable, not because the script tries and then filters.
const NEVER_CLICK = /^(submit|pay now|confirm|authorize|complete payment|process)/i;

const b = await chromium.launch();
const ctx = await b.newContext({
  storageState: JSON.parse(readFileSync(`${process.env.HOME}/.housy-sessions/${key}.json`, "utf8")),
  viewport: { width: 1280, height: 950 },
});
const p = await ctx.newPage();
mkdirSync("/tmp/housy-shots", { recursive: true });

const tree = async () => (await p.locator("body").ariaSnapshot({ timeout: 15000 }).catch(() => ""))
  .split("\n").map(l => l.trim().replace(/^-\s*/, ""))
  .filter(l => /^(textbox|button|link|combobox|radio|checkbox|heading|option)/.test(l));

await p.goto(ENTRY, { waitUntil: "domcontentloaded", timeout: 45000 });
await p.waitForTimeout(6000);
console.log(`landed: ${p.url()}`);

const link = p.getByRole("link", { name: NAV }).first();
const asBtn = p.getByRole("button", { name: NAV }).first();
const target = (await link.count()) ? link : (await asBtn.count()) ? asBtn : null;
if (!target) { console.log(`no "${NAV}" control found on the landing page`); await b.close(); process.exit(1); }

const label = (await target.innerText().catch(() => "")).trim();
if (NEVER_CLICK.test(label)) { console.log(`refusing to click "${label}" — looks like a final action`); await b.close(); process.exit(2); }

console.log(`clicking: "${label}"`);
await target.click();
await p.waitForTimeout(9000);
console.log(`now at: ${p.url()}`);

const shot = `/tmp/housy-shots/${key}-payment-map.png`;
await p.screenshot({ path: shot, fullPage: true });
console.log(`screenshot: ${shot}\n`);

const rows = await tree();
console.log("PAYMENT PAGE CONTROLS:");
for (const r of rows.slice(0, 34)) console.log("   ", r.slice(0, 74));

const body = (await p.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
console.log("\namounts visible here:");
[...body.matchAll(/.{0,40}\$\s?[\d,]+\.\d{2}.{0,14}/g)].map(m => m[0].trim()).slice(0, 5).forEach(m => console.log("   ", m));

await b.close();
