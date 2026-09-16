#!/usr/bin/env node
/**
 * Fills tenants.security_deposit from the "Lease Information" workbook.
 *
 * The workbook's Lease sheet carries a Security column for 98 of 115
 * tenancies. None of it reached Housify: the QuickBooks import brought
 * customers and transactions, which is all QuickBooks holds, and the column
 * did not exist until today.
 *
 * Matched on tenant NAME within the matching PROPERTY, never on name alone.
 * Five same-name groups exist in this database, and a deposit posted against
 * the wrong tenancy is money attributed to the wrong person.
 *
 *   node import-deposits.js --company <uuid> [--dry-run|--commit]
 */
const ExcelJS = require("exceljs");
const { createClient } = require("@supabase/supabase-js");

const WB = process.env.LEASE_WORKBOOK || "/Users/aggar/Dropbox/Lease Information.xlsx";
const args = process.argv.slice(2);
const argv = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const COMPANY = argv("--company");
const COMMIT = args.includes("--commit");
if (!COMPANY) { console.error("--company <uuid> required"); process.exit(1); }

const txt = c => { const v = c && c.value; if (v == null) return "";
  if (typeof v === "object") return String(v.richText ? v.richText.map(t => t.text).join("") : (v.text || v.result || "")).trim();
  return String(v).trim(); };
const money = s => { const n = Number(String(s).replace(/[$,\s]/g, "")); return Number.isFinite(n) ? n : null; };

// people compared as token SETS: "Smith, John" and "John Smith" are one
// person, a middle name does not break a match, and a joint lease is split
const toks = s => String(s || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(w => w.length > 1);
const people = s => String(s || "").split(/\s*(?:&|\band\b|,)\s*/i).map(toks).filter(t => t.length);
const nameMatch = (a, b) => {
  const B = toks(b); if (!B.length) return false;
  for (const A of people(a)) {
    const sA = new Set(A), sB = new Set(B);
    const inter = B.filter(w => sA.has(w));
    if (inter.length === B.length || A.every(w => sB.has(w))) return true;
    if (inter.length >= 2) return true;
  }
  return false;
};
const parseAddr = s => {
  const t = String(s || "").toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
  const num = (t.match(/^\s*(\d+)/) || [])[1] || "";
  const street = t.replace(/^\s*\d+\s*/, "")
    .replace(/(?:unit|apt|ste|suite|#)\s*[\w-]+/g, " ")
    .replace(/\b(md|va|dc)\b/g, " ").replace(/\b\d{5}(-\d{4})?\b/g, " ")
    .replace(/\b(street|st|road|rd|drive|dr|court|ct|lane|ln|place|pl|avenue|ave|circle|cir|terrace|ter|way|boulevard|blvd)\b/g, " ")
    .replace(/[^a-z0-9]/g, "");
  return { num, street };
};
const lev = (a, b) => { const m = a.length, n = b.length; if (!m || !n) return Math.max(m, n);
  let p = [...Array(n + 1).keys()], c = [];
  for (let i = 1; i <= m; i++) { c = [i]; for (let j = 1; j <= n; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = c; }
  return p[n]; };
const addrMatch = (a, b) => {
  const A = parseAddr(a), B = parseAddr(b);
  if (!A.num || A.num !== B.num) return false;
  return lev(A.street, B.street) <= Math.max(2, Math.floor(Math.min(A.street.length, B.street.length) * 0.25));
};

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(WB);
  const ws = wb.getWorksheet("Lease");
  let hdr = 0;
  for (let r = 1; r <= 8 && !hdr; r++)
    for (let c = 1; c <= ws.columnCount; c++)
      if (/tenant name/i.test(txt(ws.getRow(r).getCell(c)))) { hdr = r; break; }
  const cols = []; for (let c = 1; c <= ws.columnCount; c++) cols.push(txt(ws.getRow(hdr).getCell(c)));
  const idx = n => { const i = cols.findIndex(c => c.toLowerCase().includes(n)); return i < 0 ? 0 : i + 1; };
  const cAddr = idx("address"), cName = idx("tenant name"), cSec = idx("security");

  const sheet = [];
  for (let r = hdr + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name = txt(row.getCell(cName)), addr = txt(row.getCell(cAddr)), dep = money(txt(row.getCell(cSec)));
    if (!name || dep === null) continue;
    sheet.push({ name, addr, dep });
  }
  console.log(`workbook: ${sheet.length} tenancies with a deposit figure`);

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: tenants, error } = await sb.from("tenants")
    .select("id, name, property, security_deposit, lease_status")
    .eq("company_id", COMPANY).is("archived_at", null);
  if (error) throw error;

  const plan = [], ambiguous = [], noMatch = [];
  for (const row of sheet) {
    const hits = tenants.filter(t => nameMatch(row.name, t.name) && addrMatch(row.addr, t.property));
    if (hits.length === 1) plan.push({ t: hits[0], dep: row.dep, from: row.name });
    else if (hits.length > 1) ambiguous.push({ row, hits });
    else noMatch.push(row);
  }
  const changing = plan.filter(p => Number(p.t.security_deposit ?? NaN) !== p.dep);

  console.log(`\nWILL SET a deposit on ${changing.length} tenants:`);
  changing.slice(0, 12).forEach(p =>
    console.log(`  $${String(p.dep).padStart(7)}  ${p.t.name.padEnd(30)} ${String(p.t.property).slice(0, 40)}`));
  if (changing.length > 12) console.log(`  ... and ${changing.length - 12} more`);
  console.log(`\n  already correct: ${plan.length - changing.length}`);
  if (ambiguous.length) {
    console.log(`\n  AMBIGUOUS (${ambiguous.length}) — more than one tenant matched, left alone:`);
    ambiguous.forEach(a => console.log(`    ${a.row.name} @ ${a.row.addr.slice(0, 38)} -> ${a.hits.map(h => h.name).join(" | ")}`));
  }
  console.log(`  no tenant matched in Housify: ${noMatch.length}`);
  const total = changing.reduce((s, p) => s + p.dep, 0);
  console.log(`\n  total deposits to record: $${total.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);

  if (!COMMIT) { console.log(`\nDRY RUN — nothing written.`); return; }
  let done = 0, failed = 0;
  for (const p of changing) {
    const { error: e } = await sb.from("tenants")
      .update({ security_deposit: p.dep }).eq("id", p.t.id).eq("company_id", COMPANY);
    if (e) { console.error(`  ${p.t.name}: ${e.message}`); failed++; } else done++;
  }
  console.log(`\nset ${done}, failed ${failed}`);
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
