// A real browser window for a person to sign into, which then keeps going
// in the SAME context.
//
// Washington Gas issues ASP.NET_SessionId -- a server-side session the
// server drops after a short idle timeout -- and now challenges automated
// logins with a captcha ("Invalid Captcha", three visible elements). So
// the two halves have to happen in one window: a person passes the
// captcha, and the script continues immediately without ever saving and
// reloading a session that would already be dead.
//
// The script types nothing and reads no password. It waits for the login
// form to disappear, then drives the rest.
//
// It presses Next ONCE and checks first whether that click PAID, because
// that is the outcome nobody wants to discover later. It clicks nothing
// else.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const b = await chromium.launch({ headless: false, slowMo: 40 });
const ctx = await b.newContext({ viewport: { width: 1300, height: 1000 }, locale: "en-US", timezoneId: "America/New_York" });
const p = await ctx.newPage();

console.log("\nOpening Washington Gas. Sign in in the window that appears.");
console.log("Nothing is typed for you — including the captcha.\n");

await p.goto("https://my.washingtongas.com/portal/", { waitUntil: "domcontentloaded", timeout: 60000 });

// Wait for the login form to go away. Two clean polls apart, because a
// page mid-navigation briefly has no fields and acting then would race the
// redirect.
const DEADLINE = Date.now() + 8 * 60 * 1000;
let signedIn = false;
process.stdout.write("  waiting for you to sign in");
while (Date.now() < DEADLINE) {
  await p.waitForTimeout(2500);
  process.stdout.write(".");
  const onLogin = await p.getByRole("textbox", { name: /UserName/i }).count().catch(() => 1);
  if (!onLogin) {
    await p.waitForTimeout(2500);
    const still = await p.getByRole("textbox", { name: /UserName/i }).count().catch(() => 1);
    if (!still) { signedIn = true; break; }
  }
}
console.log("");

if (!signedIn) {
  console.error("Timed out on the sign-in page — nothing done.");
  await b.close(); process.exit(2);
}
console.log("signed in:", p.url());

// Save the session too, so the sweep can use whatever life it has left.
const state = await ctx.storageState();
mkdirSync(`${process.env.HOME}/.housy-sessions`, { recursive: true, mode: 0o700 });
writeFileSync(`${process.env.HOME}/.housy-sessions/washington_gas.json`, JSON.stringify(state), { mode: 0o600 });
console.log(`session saved (${state.cookies.length} cookies)`);

try {
  const payLink = p.getByRole("link", { name: /^Make Payment$/i }).first();
  if (!(await payLink.count())) { console.log("no Make Payment link on this page"); await b.close(); process.exit(3); }
  await payLink.click();
  await p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  console.log("payment form:", p.url());

  const before = (await p.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
  console.log("  amount on form :", (before.match(/Total to Pay:\s*\$[\d,.]+/i) || ["?"])[0]);
  console.log("  account on form:", (before.match(/My (?:Business|Home)[^|]{0,46}?\d{9,12}/i) || ["?"])[0]);

  const next = p.getByRole("button", { name: /^(Next|Continue)$/i }).first();
  if (!(await next.count())) { console.log("no Next button found"); await b.close(); process.exit(4); }

  console.log("\npressing Next once...");
  await next.click();
  await p.waitForLoadState("networkidle", { timeout: 40000 }).catch(() => {});
  await p.waitForTimeout(5000);
  console.log("landed:", p.url());

  const body = (await p.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
  const paid = /thank you|payment (has been )?(received|submitted|scheduled|posted|processed)|confirmation number/i.test(body);
  console.log("DID IT PAY?", paid ? "YES" : "no — this is a review step");
  if (paid) console.log("  >>>", (body.match(/.{0,70}(thank you|confirmation number|submitted|scheduled).{0,70}/i) || [""])[0]);

  const yaml = await p.locator("body").ariaSnapshot({ timeout: 20000 }).catch(() => "");
  const rows = [...new Set(yaml.split("\n").map(l => l.trim().replace(/^-\s*/, "").replace(/^['"]/, ""))
    .filter(l => /^(button|heading|checkbox|text)/.test(l)))];
  console.log("\ncontrols on this page:");
  rows.slice(0, 20).forEach(r => console.log("   ", r.slice(0, 72)));

  mkdirSync("/tmp/housy-shots", { recursive: true });
  const shot = `/tmp/housy-shots/wgl-review-${Date.now()}.png`;
  await p.screenshot({ path: shot, fullPage: true });
  console.log("\nscreenshot:", shot);
  console.log("\nLeaving the browser open for 60s so you can see where it got to.");
  await p.waitForTimeout(60000);
} catch (e) {
  console.log("error:", String(e.message).split("\n")[0].slice(0, 120));
} finally {
  await b.close();
}
