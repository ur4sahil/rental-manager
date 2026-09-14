// ONE automated login attempt per provider, using stored credentials.
//
// Credentials are decrypted IN MEMORY through the app's own role-gated
// decrypt route -- the same path a user clicking "Show login" takes -- and
// are never written to disk.
//
// ONE attempt each. Not seventeen: a failed automated login is exactly what
// triggers a lockout, and one attempt tells us as much as ten would. There
// is no retry anywhere in this file, deliberately.
//
// Run from the laptop rather than the Oracle box: reCAPTCHA v3 scores
// behaviour and origin, and a residential IP is a far better signal than a
// datacentre one. Washington Gas runs v3 (invisible, scored) so this may
// simply pass. WSSC presents a visible challenge and probably will not --
// that is the expected outcome, not a failure of the attempt.
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync("./.env", "utf8").split("\n")
    .filter(l => l.includes("=") && !l.startsWith("#"))
    .map(l => [l.slice(0, l.indexOf("=")).trim(),
               l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));

const COMPANY = "f56be35c-c80d-4f47-8624-cbb317f85461";
const token = readFileSync("/tmp/sbtoken.txt", "utf8").trim();
const admin = createClient(env.TEST_SUPABASE_URL, env.TEST_SUPABASE_SERVICE_KEY,
                           { auth: { persistSession: false } });

// NOT env.APP_URL: it points at rental-manager-one.vercel.app, which
// 308-redirects to housify365.com -- and fetch STRIPS the Authorization
// header on a cross-origin redirect. The token silently vanished in
// transit and the route answered "Missing bearer token", which looks
// exactly like a token that was never sent.
// STAGING, not production. The credentials live in the test database, the
// session token was issued by the TEST Supabase project, and production
// validates tokens against its own project -- so production answered
// "Invalid session" for a perfectly valid token from the other environment.
// ENCRYPTION_KEY is shared across Development/Preview/Production, so the
// same ciphertext decrypts either side.
const API_BASE = process.env.HOUSY_API_BASE || "https://test.housify365.com";
const BYPASS = process.env.VERCEL_BYPASS_TOKEN || "";

async function decrypt(ciphertext, iv, salt) {
  const r = await fetch(API_BASE.replace(/\/$/, "") + "/api/encrypt", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
      // Staging sits behind Vercel SSO; this is the documented way past it
      // for automation.
      ...(BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {}),
    },
    body: JSON.stringify({ action: "decrypt", companyId: COMPANY, ciphertext, iv, salt }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.status === 200 && !!j.plaintext, value: j.plaintext, status: r.status, err: j.error };
}

const PORTALS = {
  "WSSC": {
    key: "wssc", url: "https://my.wsscwater.com/",
    user: /User ID/i, pass: /Password/i, submit: /^Log In$/i,
  },
  "Washington GAS": {
    key: "washington_gas", url: "https://my.washingtongas.com/portal/",
    user: /UserName/i, pass: /Password/i, submit: /^Log In$/i,
  },
};

const { data: rows, error } = await admin.from("utilities")
  .select("provider, property, username_encrypted, password_encrypted, encryption_iv, encryption_iv_username, encryption_salt")
  .eq("company_id", COMPANY).in("provider", Object.keys(PORTALS));
if (error) { console.error("could not read utilities:", error.message); process.exit(1); }

// First row per provider only.
const first = {};
for (const r of rows || []) if (!first[r.provider]) first[r.provider] = r;

const browser = await chromium.launch({ headless: true });
for (const [provider, row] of Object.entries(first)) {
  const cfg = PORTALS[provider];
  console.log(`\n=== ${provider} — ${String(row.property).slice(0, 42)}`);

  const u = await decrypt(row.username_encrypted, row.encryption_iv_username || row.encryption_iv, row.encryption_salt);
  const p = await decrypt(row.password_encrypted, row.encryption_iv, row.encryption_salt);
  if (!u.ok || !p.ok) {
    console.log(`  decrypt failed (HTTP ${u.status}) ${u.err || p.err || ""}`);
    continue;
  }
  console.log(`  credentials decrypted in memory (username ${u.value.length} chars)`);

  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "America/New_York",
  });
  const page = await ctx.newPage();
  try {
    await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});

    const userBox = page.getByRole("textbox", { name: cfg.user }).first();
    const passBox = page.getByRole("textbox", { name: cfg.pass }).first();
    if (!(await userBox.count())) {
      console.log("  no username field — already signed in, or the page changed");
      await ctx.close(); continue;
    }

    // Typed with a delay rather than set directly: v3 scores behaviour, and
    // an instantaneous fill is the clearest bot signal available.
    await userBox.click();
    await userBox.type(u.value, { delay: 95 });
    await passBox.click();
    await passBox.type(p.value, { delay: 95 });
    console.log("  credentials entered");

    const btn = page.getByRole("button", { name: cfg.submit }).first();
    if (!(await btn.count())) { console.log("  no submit button found"); await ctx.close(); continue; }
    await btn.click();
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(6000);

    const stillLogin = await page.getByRole("textbox", { name: cfg.user }).count().catch(() => 0);
    const captcha = await page.locator('iframe[title*="recaptcha" i], [class*="captcha" i]').count().catch(() => 0);
    const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");

    console.log(`  landed: ${page.url().slice(0, 68)}`);
    console.log(`  still on the login form: ${stillLogin > 0}`);
    console.log(`  captcha elements present: ${captcha}`);
    const msg = body.match(/(incorrect|invalid|locked|unable|verify|robot|captcha|try again)[^.]{0,70}/i);
    if (msg) console.log(`  page says: ${msg[0].slice(0, 95)}`);

    if (stillLogin === 0) {
      const state = await ctx.storageState();
      const dir = `${process.env.HOME}/.housy-sessions`;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(`${dir}/${cfg.key}.json`, JSON.stringify(state), { mode: 0o600 });
      console.log(`  SIGNED IN — ${state.cookies.length} cookies, session saved`);
    } else {
      console.log("  NOT signed in. Not retrying — a second attempt is what causes a lockout.");
    }
  } catch (e) {
    console.log(`  error: ${String(e.message).split("\n")[0].slice(0, 95)}`);
  }
  await ctx.close();
}
await browser.close();
