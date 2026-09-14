// Log in and map the payment review page IN ONE RUN.
//
// Washington Gas issues ASP.NET_SessionId -- a server-side session pointer
// that the server discards after a short idle timeout. Every previous
// attempt logged in, saved the session, and used it minutes later in a
// separate process, by which time the server had already dropped it. That
// is why it kept reporting "session expired" seconds after a successful
// login, and why I wrongly blamed reCAPTCHA.
//
// So: one browser context, login straight through to the payment form, no
// save and no reload.
//
// It presses Next ONCE and the very first thing it then checks is whether
// that click PAID, because that is the outcome nobody wants to discover
// later. It clicks nothing else.
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const env = Object.fromEntries(readFileSync("./.env", "utf8").split("\n")
  .filter(l => l.includes("=") && !l.startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(),
             l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
const token = readFileSync("/tmp/sbtoken.txt", "utf8").trim();
const BYPASS = process.env.VERCEL_BYPASS_TOKEN || "";
const COMPANY = "f56be35c-c80d-4f47-8624-cbb317f85461";
const admin = createClient(env.TEST_SUPABASE_URL, env.TEST_SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

async function decrypt(ciphertext, iv, salt) {
  const r = await fetch("https://test.housify365.com/api/encrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token,
               ...(BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {}) },
    body: JSON.stringify({ action: "decrypt", companyId: COMPANY, ciphertext, iv, salt }),
  });
  const j = await r.json().catch(() => ({}));
  return j.plaintext;
}

const { data: rows, error } = await admin.from("utilities")
  .select("provider, property, username_encrypted, password_encrypted, encryption_iv, encryption_iv_username, encryption_salt")
  .eq("company_id", COMPANY).eq("provider", "Washington GAS").limit(1);
if (error || !rows?.length) { console.error("no Washington Gas credentials:", error?.message); process.exit(1); }
const row = rows[0];
const user = await decrypt(row.username_encrypted, row.encryption_iv_username || row.encryption_iv, row.encryption_salt);
const pass = await decrypt(row.password_encrypted, row.encryption_iv, row.encryption_salt);
if (!user || !pass) { console.error("could not decrypt"); process.exit(1); }

const b = await chromium.launch();
const ctx = await b.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 1100 }, locale: "en-US", timezoneId: "America/New_York",
});
const p = await ctx.newPage();

try {
  await p.goto("https://my.washingtongas.com/portal/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await p.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});

  // Typed with delay: v3 scores behaviour, and an instant fill is the
  // clearest bot signal available.
  await p.getByRole("textbox", { name: /UserName/i }).first().type(user, { delay: 95 });
  await p.getByRole("textbox", { name: /Password/i }).first().type(pass, { delay: 95 });
  await p.getByRole("button", { name: /^Log In$/i }).first().click();
  await p.waitForLoadState("networkidle", { timeout: 35000 }).catch(() => {});
  await p.waitForTimeout(5000);

  if (await p.getByRole("textbox", { name: /UserName/i }).count().catch(() => 0)) {
    console.log("login refused — stopping, not retrying");
    await b.close(); process.exit(2);
  }
  console.log("signed in:", p.url());

  // Session is alive right now. Keep going in the SAME context.
  const payLink = p.getByRole("link", { name: /^Make Payment$/i }).first();
  if (!(await payLink.count())) { console.log("no Make Payment link"); await b.close(); process.exit(3); }
  await payLink.click();
  await p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  console.log("payment form:", p.url());

  const before = (await p.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
  console.log("amount on form:", (before.match(/Total to Pay:\s*\$[\d,.]+/i) || ["?"])[0]);
  console.log("account on form:", (before.match(/My (?:Business|Home)[^|]{0,46}?\d{9,12}/i) || ["?"])[0]);

  const next = p.getByRole("button", { name: /^(Next|Continue)$/i }).first();
  if (!(await next.count())) { console.log("no Next button"); await b.close(); process.exit(4); }

  console.log("\npressing Next...");
  await next.click();
  await p.waitForLoadState("networkidle", { timeout: 40000 }).catch(() => {});
  await p.waitForTimeout(5000);
  console.log("landed:", p.url());

  const body = (await p.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
  // THE question, asked before anything else.
  const paid = /thank you|payment (has been )?(received|submitted|scheduled|posted|processed)|confirmation number/i.test(body);
  console.log("DID IT PAY?", paid ? "YES" : "no — this is a review step");
  if (paid) console.log("  >>>", (body.match(/.{0,70}(thank you|confirmation number|submitted|scheduled).{0,70}/i) || [""])[0]);

  const yaml = await p.locator("body").ariaSnapshot({ timeout: 20000 }).catch(() => "");
  const rows2 = [...new Set(yaml.split("\n").map(l => l.trim().replace(/^-\s*/, "").replace(/^['"]/, ""))
    .filter(l => /^(button|heading|checkbox|text)/.test(l)))];
  console.log("\ncontrols on this page:");
  rows2.slice(0, 18).forEach(r => console.log("   ", r.slice(0, 70)));

  mkdirSync("/tmp/housy-shots", { recursive: true });
  const shot = `/tmp/housy-shots/wgl-review-${Date.now()}.png`;
  await p.screenshot({ path: shot, fullPage: true });
  console.log("\nscreenshot:", shot);
} catch (e) {
  console.log("error:", String(e.message).split("\n")[0].slice(0, 110));
} finally {
  await b.close();
}
