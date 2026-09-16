#!/usr/bin/env node
/**
 * Rewrites stored utility provider names to their canonical spelling.
 *
 * 29 spellings across 121 rows meant a per-provider total split across
 * capitalisations: "Washington GAS" (12 rows, all with logins) and
 * "Washington Gas" (7 rows, none) are one account that the property import
 * and the credential setup spelled differently.
 *
 * Entity suffixes are preserved -- "BGE Sigma" and "BGE Utopia" are separate
 * logins for separate LLCs and must not merge.
 *
 * Renaming can collide with the unique index on
 * (company_id, provider, account_number): if two rows for one company hold
 * the same account number under two spellings, canonicalising makes them
 * identical. Those are reported, not forced.
 *
 *   node normalise-providers.js [--company <uuid>] [--dry-run|--commit]
 */
const { createClient } = require("@supabase/supabase-js");
const path = require("path");
const { pathToFileURL } = require("url");

const args = process.argv.slice(2);
const argv = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const COMPANY = argv("--company");
const COMMIT = args.includes("--commit");

(async () => {
  // src/utils/providers.js is the ESM module the app itself uses. Imported
  // rather than duplicated, so the canonical list cannot drift between what
  // the UI shows and what this script writes.
  const { canonicalProvider } = await import(
    pathToFileURL(path.join(__dirname, "../../src/utils/providers.js")).href);

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  let q = sb.from("utilities").select("id, company_id, provider, account_number, property, username_encrypted");
  if (COMPANY) q = q.eq("company_id", COMPANY);
  const rows = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await q.range(f, f + 999);
    if (error) throw error;
    rows.push(...data); if (data.length < 1000) break;
  }

  const changes = rows
    .map(r => ({ r, to: canonicalProvider(r.provider) }))
    .filter(x => x.to && x.to !== x.r.provider);

  // would any rename create a duplicate (company, provider, account_number)?
  const after = new Map();
  rows.forEach(r => {
    const prov = canonicalProvider(r.provider) || r.provider;
    const k = `${r.company_id}|${prov}|${r.account_number || ""}`;
    if (!after.has(k)) after.set(k, []);
    after.get(k).push(r);
  });
  const collisions = [...after.entries()].filter(([k, v]) => v.length > 1 && k.split("|")[2]);

  const summary = {};
  changes.forEach(c => { const k = `${c.r.provider} -> ${c.to}`; summary[k] = (summary[k] || 0) + 1; });
  console.log(`${rows.length} utility rows${COMPANY ? " in this company" : " across all companies"}`);
  console.log(`rows whose provider name changes: ${changes.length}\n`);
  Object.entries(summary).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}  ${k}`));

  if (collisions.length) {
    console.log(`\nWOULD COLLIDE on (company, provider, account) — skipped:`);
    collisions.forEach(([k, v]) => {
      const [, prov, acct] = k.split("|");
      console.log(`  ${prov} / ${acct}`);
      v.forEach(r => console.log(`      ${r.provider.padEnd(18)} ${String(r.property).slice(0, 44)}`));
    });
  }

  if (!COMMIT) { console.log(`\nDRY RUN — nothing written.`); return; }

  const skip = new Set(collisions.flatMap(([, v]) => v.map(r => r.id)));
  let done = 0, failed = 0, skipped = 0;
  for (const c of changes) {
    if (skip.has(c.r.id)) { skipped++; continue; }
    const { error } = await sb.from("utilities").update({ provider: c.to }).eq("id", c.r.id);
    if (error) { console.error(`  ${c.r.id}: ${error.message}`); failed++; } else done++;
  }
  console.log(`\nrenamed ${done}, skipped ${skipped} (would collide), failed ${failed}`);
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
