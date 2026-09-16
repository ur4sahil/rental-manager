#!/usr/bin/env node
/**
 * Fills utility ACCOUNT NUMBERS on Housify records from the "Utilities NEW"
 * workbook's Master Sheet, which carries provider + account number per
 * address for electricity, water and gas.
 *
 * Why this matters: account_number is null on all 78 utility rows, and a
 * portal cannot look up a bill without one. This is the missing half of
 * making the utilities page show real amounts.
 *
 * Credentials are deliberately NOT handled here -- see the note at the
 * bottom of this file.
 *
 *   node import-from-workbook.js --company <uuid> [--dry-run|--commit]
 */
const ExcelJS = require("exceljs");
const { createClient } = require("@supabase/supabase-js");

const WB = process.env.UTIL_WORKBOOK ||
  "/Users/aggar/Library/CloudStorage/Dropbox/Utilities NEW.xlsx";
const args = process.argv.slice(2);
const argv = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const COMPANY = argv("--company");
const COMMIT = args.includes("--commit");
if (!COMPANY) { console.error("--company <uuid> required"); process.exit(1); }

const txt = c => { const v = c && c.value; if (v == null) return "";
  if (typeof v === "object") return String(v.richText ? v.richText.map(t => t.text).join("") : (v.text || v.result || "")).trim();
  return String(v).trim(); };

// House number anchors the match; street name must then be close. Stripping
// suffixes alone let "10204 Prince Pl" sit two edits from "10206 Prince
// Place" -- a different building on the same street.
const parseAddr = (s) => {
  const t = String(s || "").toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
  const num = (t.match(/^\s*(\d+)/) || [])[1] || "";
  let unit = (t.match(/(?:unit|apt|ste|suite|#)\s*([\w-]+)/) || [])[1] || "";
  if (!unit) { const m = t.match(/\b(\d+-\d+)\b/); if (m && m[1] !== num) unit = m[1]; }
  const street = t.replace(/^\s*\d+\s*/, "")
    .replace(/(?:unit|apt|ste|suite|#)\s*[\w-]+/g, " ")
    .replace(/\b(md|va|dc|maryland|virginia)\b/g, " ")
    .replace(/\b\d{5}(-\d{4})?\b/g, " ")
    .replace(/\b(street|st|road|rd|drive|dr|court|ct|lane|ln|place|pl|avenue|ave|circle|cir|terrace|ter|way|boulevard|blvd|park)\b/g, " ")
    .replace(/[^a-z0-9]/g, "");
  return { num, unit: unit.replace(/[^a-z0-9]/g, ""), street };
};
const lev = (a, b) => { const m = a.length, n = b.length; if (!m || !n) return Math.max(m, n);
  let p = [...Array(n + 1).keys()], c = [];
  for (let i = 1; i <= m; i++) { c = [i]; for (let j = 1; j <= n; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = c; }
  return p[n]; };
const addrMatch = (a, b) => {
  const A = parseAddr(a), B = parseAddr(b);
  if (!A.num || A.num !== B.num) return false;
  const tol = Math.max(2, Math.floor(Math.min(A.street.length, B.street.length) * 0.25));
  if (lev(A.street, B.street) > tol) return false;
  if (A.unit && B.unit && A.unit !== B.unit) return false;
  return true;
};

// The workbook spells providers freely -- "pepco", "Pepco", "wssC",
// "wash Gas", "BGE (Sigma)". Housify's own rows are inconsistent too
// ("Washington GAS" and "Washington Gas" both exist). Both sides are
// normalised to one key so a match is not lost to capitalisation.
const normProvider = (s) => {
  const t = String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!t) return "";
  if (t.includes("pepco")) return "pepco";
  if (t.includes("wssc")) return "wssc";
  if (t.includes("washgas") || t.includes("washingtongas")) return "washingtongas";
  if (t.includes("bge")) return "bge";
  if (t.includes("dominion")) return "dominion";
  if (t.includes("fairfaxwater")) return "fairfaxwater";
  if (t.includes("potomacedison")) return "potomacedison";
  if (t.includes("smeco")) return "smeco";
  if (t.includes("novec")) return "novec";
  if (t.includes("columbiagas")) return "columbiagas";
  if (t.includes("dcwater")) return "dcwater";
  if (t.includes("charlescounty")) return "charlescounty";
  return t;
};

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(WB);
  const ws = wb.getWorksheet("Master Sheet");

  // Master Sheet: col 1 address, then provider/account pairs at 10-11
  // (electricity), 12-13 (water), 14-15 (gas).
  const fromBook = [];
  for (let r = 3; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const addr = txt(row.getCell(1));
    if (!addr || /^address$/i.test(addr)) continue;
    for (const [pc, ac] of [[10, 11], [12, 13], [14, 15]]) {
      const provider = txt(row.getCell(pc)), account = txt(row.getCell(ac));
      if (!account) continue;                      // an account number is the point
      fromBook.push({ addr, provider, account, key: normProvider(provider) });
    }
  }
  console.log(`workbook: ${fromBook.length} provider/account pairs across ${new Set(fromBook.map(x => x.addr)).size} addresses`);

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: utils, error } = await sb.from("utilities")
    .select("id, property, provider, account_number, property_id")
    .eq("company_id", COMPANY).is("archived_at", null);
  if (error) throw error;
  console.log(`housify: ${utils.length} utility rows, ${utils.filter(u => !u.account_number).length} with no account number\n`);

  const plan = [], ambiguous = [], noMatch = [];
  for (const u of utils) {
    if (u.account_number) continue;
    const cands = fromBook.filter(b => normProvider(u.provider) === b.key && addrMatch(u.property, b.addr));
    const distinct = [...new Set(cands.map(c => c.account))];
    if (distinct.length === 1) plan.push({ u, account: distinct[0], via: cands[0] });
    else if (distinct.length > 1) ambiguous.push({ u, options: distinct });
    else noMatch.push(u);
  }

  console.log(`WILL FILL: ${plan.length}`);
  plan.slice(0, 14).forEach(p => console.log(`  ${String(p.u.provider).padEnd(15)} ${String(p.u.property).slice(0, 42).padEnd(42)} -> ${p.account}`));
  if (plan.length > 14) console.log(`  ... and ${plan.length - 14} more`);
  if (ambiguous.length) {
    console.log(`\nAMBIGUOUS (${ambiguous.length}) — more than one account number for the same property+provider:`);
    ambiguous.forEach(a => console.log(`  ${a.u.provider} @ ${String(a.u.property).slice(0, 40)}  ->  ${a.options.join(" | ")}`));
  }
  console.log(`\nNO MATCH IN THE WORKBOOK: ${noMatch.length}`);
  const byProv = noMatch.reduce((m, u) => { m[u.provider] = (m[u.provider] || 0) + 1; return m; }, {});
  Object.entries(byProv).sort((a, b) => b[1] - a[1]).forEach(([p, n]) => console.log(`  ${String(n).padStart(3)}  ${p}`));

  if (!COMMIT) { console.log(`\nDRY RUN — nothing written. Re-run with --commit.`); return; }

  let filled = 0, failed = 0;
  for (const p of plan) {
    const { error: e } = await sb.from("utilities")
      .update({ account_number: p.account }).eq("id", p.u.id).eq("company_id", COMPANY);
    if (e) { console.error(`  ${p.u.id}: ${e.message}`); failed++; } else filled++;
  }
  console.log(`\nfilled ${filled} account numbers, ${failed} failed`);
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });

/* CREDENTIALS ARE NOT IMPORTED HERE, deliberately.
 *
 * The workbook's "Usernames & Passwords" sheet holds portal logins, and
 * Housify stores those AES-256-GCM encrypted under a server-side key it
 * reaches through /api/encrypt -- this script has no business holding that
 * key, and a plaintext password should not pass through a local file on its
 * way in.
 *
 * Two things also need a human before any of it moves:
 *
 *   * Rows 41-48 of that sheet are not utility logins at all. They are bank
 *     account numbers and a credit card with its CVV. Those must not enter
 *     the utility credential store, and arguably should not be in a
 *     spreadsheet.
 *
 *   * Row 20 reads "anish.m.gupta@gail.com" -- gmail with the m missing.
 *     That is the Fairfax Water login, and it is why signing in there
 *     failed. Importing it would carry the typo into Housify.
 */
