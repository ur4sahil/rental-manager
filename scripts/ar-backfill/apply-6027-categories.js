#!/usr/bin/env node
/**
 * Applies the categorisations already done on account 6027 in the company
 * "Sigma Housing" (0b74ce45) to the same transactions in "Sigma Housing LLC"
 * (f985cc7a), which is the company being carried forward.
 *
 * The same Plaid data was pulled into both companies. The old one has 106 of
 * 6027's transactions coded to tenant AR; the new one has the 112 Sahil
 * actually needs, uncategorised. The AR account CODES differ between the two
 * companies (Stanley Ibe is 1100-002 there and 1100-065 here), so nothing is
 * copied by code -- every account is resolved to a TENANT, and each ambiguous
 * or missing tenant was ruled on by Sahil individually. Those rulings are the
 * RESOLUTION table below; none of them is a guess.
 *
 *   node apply-6027-categories.js [--dry-run] [--commit]
 */
const { createClient } = require("@supabase/supabase-js");

const NEW = "f985cc7a-0d6b-4905-aea9-4b6eb9fd1dec";
const OLD = "0b74ce45-561b-41ea-9c63-adf1456fdf2a";
const COMMIT = process.argv.includes("--commit");

// Sahil's rulings, 2026-09-15. `tenant` is matched by exact name + property
// in the new company; `create` means the person is a real former tenant who
// was never brought over (the QuickBooks import only carried current ones),
// with the property taken from his Dropbox lease folders.
const RESOLUTION = {
  "AR - Michelle Moore":        { tenant: "Michelle Moore" },
  "AR - Tanesha Chaunte":       { tenant: "Tanesha Chaunte" },
  "AR - Geanine Reaves":        { tenant: "Geanine Reaves" },
  "AR - Derrick Robinson":      { tenant: "Derrick Robinson-El" },
  "AR - Khalid Hussain":        { tenant: "Khalid Hussain" },
  "AR - Abayomi Asokeji":       { tenant: "Abayomi Asokeji" },
  "AR - Delisa Davis":          { tenant: "Delisa Davis" },
  "AR - Kimella Rodgers":       { tenant: "Kimella Rodgers" },
  "AR - Razelle Collins":       { tenant: "Razelle Collins" },
  // "she is a tenant at 6956", not the 1 Barberry record
  "AR - Essence Q. Ford":       { tenant: "Essence Quianna Ford", property: "6956 Hawthorne St, Landover, MD 20785" },
  // the 2026 bank items go to 2504; the 24 entries rebuilt this morning stay on 2502
  "AR - Stanley Ibe":           { tenantId: 1418 },
  // merged pair -- post to the surviving record
  "AR - Jamesha":               { tenant: "Jamesha Montia Chante Vail-Pardlow" },
  "AR - Amanda Mathews":        { tenant: "Amanda Mathews", property: "6980 Hawthorne St, Landover, MD 20785" },
  // "she moved from 6950 to 2521 in May" -- so the destination depends on the date
  "AR - Beatriz Alegria Vera":  { split: { before: "2026-05-01", beforeTenant: "Beatriz Argria Vera", afterTenant: "Beatriz Alegria Vera and Mario Esteban" } },
  // former tenants to create, properties from the Dropbox lease folders
  "AR - Patricia Harris":       { create: { name: "Patricia Harris", property: "6980 Hawthorne St, Landover, MD 20785", note: "Joint lease with Tyran Harris" } },
  "AR - Dave Ferebee":          { create: { name: "Dave Ferebee", property: "2521 Kent Town Pl, Landover, MD 20785" } },
  "AR - Tavon Singletary":      { create: { name: "Tavon Singletary", property: "6974 Hawthorne St, Landover, MD 20785" } },
  "AR - Janai Lane":            { create: { name: "Janai Lane", property: "6932 Hawthorne St, Landover, MD 20785" } },
  "AR - Emmanuel M. Yondo":     { create: { name: "Emmanuel Mbella Yondo", property: "6870 Hawthorne St, Landover, MD 20785" } },
  "AR - Roseline Obadimu":      { create: { name: "Roseline Obadimu", property: "2501 B Kent Town Pl, Landover, MD 20785" } },
};

const page = async (q) => { const out = []; for (let f = 0; ; f += 1000) { const { data, error } = await q().range(f, f + 999); if (error) throw error; out.push(...data); if (data.length < 1000) break; } return out; };

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const feedId = async (co) => (await sb.from("bank_account_feed").select("id, gl_account_id").eq("company_id", co).eq("masked_number", "6027").single()).data;
  const fNew = await feedId(NEW), fOld = await feedId(OLD);

  const mine  = await page(() => sb.from("bank_feed_transaction")
    .select("id, posted_date, amount, direction, bank_description_raw, payee_normalized, status, journal_entry_id")
    .eq("company_id", NEW).eq("bank_account_feed_id", fNew.id));
  const theirs = await page(() => sb.from("bank_feed_transaction")
    .select("id, posted_date, amount, journal_entry_id").eq("company_id", OLD).eq("bank_account_feed_id", fOld.id));

  // the AR account each of theirs was coded to
  const jeIds = theirs.filter(t => t.journal_entry_id).map(t => String(t.journal_entry_id));
  const oldLines = [];
  for (let i = 0; i < jeIds.length; i += 50) {
    const { data } = await sb.from("acct_journal_lines").select("journal_entry_id, account_id")
      .in("journal_entry_id", jeIds.slice(i, i + 50)).eq("company_id", OLD);
    oldLines.push(...(data || []));
  }
  const { data: oldAccts } = await sb.from("acct_accounts").select("id, code, name").eq("company_id", OLD);
  const oldById = new Map(oldAccts.map(a => [a.id, a]));
  const catByJe = new Map();
  for (const l of oldLines) {
    const a = oldById.get(l.account_id);
    if (a && a.code !== "1130") catByJe.set(String(l.journal_entry_id), a.name);
  }

  const { data: tenants } = await sb.from("tenants").select("id, name, property, lease_status").eq("company_id", NEW).is("archived_at", null);
  const { data: accts }  = await sb.from("acct_accounts").select("id, code, name, tenant_id").eq("company_id", NEW);
  const { data: props }  = await sb.from("properties").select("id, address, class_id").eq("company_id", NEW).is("archived_at", null);

  const findTenant = (spec, date) => {
    if (spec.tenantId) return tenants.find(t => t.id === spec.tenantId) || null;
    if (spec.split) {
      const name = date < spec.split.before ? spec.split.beforeTenant : spec.split.afterTenant;
      return tenants.find(t => t.name === name) || null;
    }
    const byName = tenants.filter(t => t.name === spec.tenant);
    if (spec.property) return byName.find(t => t.property === spec.property) || null;
    return byName.length === 1 ? byName[0] : null;
  };

  // pair each of mine to one of theirs on date + absolute cents
  const key = (d, a) => `${d}|${Math.round(Math.abs(Number(a)) * 100)}`;
  const byKey = new Map();
  theirs.forEach(t => { const k = key(t.posted_date, t.amount); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(t); });

  const plan = [], unresolved = [], noCategory = [];
  const used = new Set();
  for (const m of mine) {
    if (m.journal_entry_id) continue;                       // already posted here
    const cands = (byKey.get(key(m.posted_date, m.amount)) || []).filter(t => !used.has(t.id));
    const pick = cands.find(t => t.journal_entry_id && catByJe.get(String(t.journal_entry_id))) || cands[0];
    if (!pick) { noCategory.push({ m, why: "no counterpart in the other company" }); continue; }
    used.add(pick.id);
    const arName = pick.journal_entry_id ? catByJe.get(String(pick.journal_entry_id)) : null;
    if (!arName) { noCategory.push({ m, why: "counterpart is uncategorised there too" }); continue; }
    const spec = RESOLUTION[arName];
    if (!spec) { unresolved.push({ m, arName, why: "no ruling for this AR account" }); continue; }
    if (spec.create) { plan.push({ m, arName, spec, create: spec.create }); continue; }
    const tenant = findTenant(spec, m.posted_date);
    if (!tenant) { unresolved.push({ m, arName, why: `ruling names a tenant that was not found: ${JSON.stringify(spec)}` }); continue; }
    plan.push({ m, arName, spec, tenant });
  }

  const creates = {};
  plan.filter(p => p.create).forEach(p => { creates[p.create.name] = p.create; });
  const byArName = plan.reduce((a, p) => { a[p.arName] = (a[p.arName] || 0) + 1; return a; }, {});

  console.log(`6027 in the new company: ${mine.length} transactions, ${mine.filter(m => m.journal_entry_id).length} already posted\n`);
  console.log(`WILL POST: ${plan.length}`);
  Object.entries(byArName).sort((a,b)=>b[1]-a[1]).forEach(([n,c]) => console.log(`  ${String(c).padStart(3)}  ${n}`));
  console.log(`\nTENANTS TO CREATE: ${Object.keys(creates).length}`);
  Object.values(creates).forEach(c => console.log(`  ${c.name.padEnd(24)} @ ${c.property}${c.note ? "  (" + c.note + ")" : ""}`));
  console.log(`\nLEFT UNCATEGORISED: ${noCategory.length}`);
  const whyCount = noCategory.reduce((a,n)=>{a[n.why]=(a[n.why]||0)+1;return a;},{});
  Object.entries(whyCount).forEach(([w,c]) => console.log(`  ${String(c).padStart(3)}  ${w}`));
  if (unresolved.length) {
    console.log(`\nNEEDS A RULING (${unresolved.length}):`);
    unresolved.slice(0,10).forEach(u => console.log(`  ${u.m.posted_date}  ${u.m.amount}  ${u.arName} — ${u.why}`));
  }

  // Beatriz split, shown explicitly because it is date-dependent
  const bz = plan.filter(p => p.arName === "AR - Beatriz Alegria Vera");
  if (bz.length) {
    console.log(`\nBeatriz, split at 2026-05-01 (she moved 6950 -> 2521 in May):`);
    bz.forEach(p => console.log(`  ${p.m.posted_date}  ${String(p.m.amount).padStart(9)}  -> ${p.tenant.name} @ ${p.tenant.property.slice(0,34)}`));
  }

  if (!COMMIT) { console.log(`\nDRY RUN — nothing written. Re-run with --commit.`); return; }

  // ---------------------------------------------------------------- commit

  // 1. the six former tenants the QuickBooks import never brought over
  const propByAddr = new Map(props.map(p => [p.address, p]));
  const createdTenants = {};
  for (const c of Object.values(creates)) {
    const prop = propByAddr.get(c.property);
    if (!prop) { console.error(`  no property row for ${c.property} — skipping ${c.name}`); continue; }
    const existing = tenants.find(t => t.name === c.name && t.property === c.property);
    if (existing) { createdTenants[c.name] = existing; continue; }
    const { data, error } = await sb.from("tenants").insert([{
      company_id: NEW, name: c.name, property: c.property, property_id: prop.id,
      lease_status: "past", rent: 0, balance: 0,
    }]).select("id, name, property").single();
    if (error) { console.error(`  create ${c.name} failed: ${error.message}`); continue; }
    createdTenants[c.name] = data;
    tenants.push({ ...data, lease_status: "past" });
    console.log(`  created tenant ${data.name} (${data.id}) @ ${c.property}`);
  }

  // 2. an AR account per tenant that needs one.
  //    acct_accounts.old_text_id is NOT NULL and legacy-formatted as
  //    "<company_id>-<code>"; the id column supplies its own default.
  let nextSuffix = Math.max(0, ...accts.filter(a => /^1100-\d+$/.test(a.code))
    .map(a => parseInt(a.code.split("-")[1], 10)).filter(n => !isNaN(n)));
  const arFor = async (tenant) => {
    const hit = accts.find(a => a.tenant_id === tenant.id && a.code.startsWith("1100-"));
    if (hit) return hit;
    const code = `1100-${String(++nextSuffix).padStart(3, "0")}`;
    const { data, error } = await sb.from("acct_accounts").insert([{
      company_id: NEW, code, name: `AR - ${tenant.name}`,
      type: "Asset", subtype: "Accounts Receivable",
      tenant_id: tenant.id, old_text_id: `${NEW}-${code}`,
      description: "Created 2026-09-15 to carry 6027 bank receipts categorised in the previous Sigma Housing company.",
    }]).select("id, code, name, tenant_id").single();
    if (error) { console.error(`  AR for ${tenant.name} failed: ${error.message}`); return null; }
    accts.push(data);
    console.log(`  created ${data.code} ${data.name}`);
    return data;
  };

  // 3. the Jamesha merge Sahil asked for: keep the full-name record, retire
  //    the QuickBooks duplicate, and carry its journal history across.
  {
    const keep = tenants.find(t => t.name === "Jamesha Montia Chante Vail-Pardlow");
    const drop = tenants.find(t => t.name === "jamesha vail");
    if (keep && drop) {
      const { error: e1 } = await sb.from("acct_journal_lines")
        .update({ entity_name: keep.name, entity_id: String(keep.id) })
        .eq("company_id", NEW).ilike("entity_name", "jamesha vail");
      const { error: e2 } = await sb.from("tenants")
        .update({ archived_at: new Date().toISOString(), archived_by: "merge into tenant " + keep.id })
        .eq("id", drop.id).eq("company_id", NEW);
      console.log(`  merged "jamesha vail" (${drop.id}) into "${keep.name}" (${keep.id})` +
        (e1 || e2 ? ` — WARNING lines:${e1?.message || "ok"} tenant:${e2?.message || "ok"}` : ""));
    }
  }

  // 4. post the 101, in the same shape the app's own accept flow produces:
  //    reference BANK-<txn id>, two lines, both carrying the property class.
  const bankGl = fNew.gl_account_id;
  // acct_journal_lines.account_name is NOT NULL with no default -- the app
  // denormalises the account's name onto every line.
  const bankAcct = accts.find(a => a.id === bankGl);
  const bankAcctName = bankAcct ? bankAcct.name : "Bank";

  // acct_journal_entries.number is NOT NULL with no default -- the app supplies
  // it. Format is "JE-<n>"; continue the company's own sequence rather than
  // starting a parallel one.
  // PAGED. A plain select returns 1000 rows silently, and this company has
  // 7,706 entries -- the unpaged version computed a max of ~999 and every
  // insert collided with unique_je_number_per_company. The cap does not
  // error; it just hands back a truncated answer.
  const numRows = await page(() => sb.from("acct_journal_entries")
    .select("number").eq("company_id", NEW).like("number", "JE-%"));
  let nextNum = Math.max(0, ...numRows
    .map(r => parseInt(String(r.number).replace(/\D/g, ""), 10)).filter(n => !isNaN(n)));
  console.log(`  read ${numRows.length} existing journal numbers`);
  console.log(`  journal numbers continue from JE-${nextNum + 1}`);

  let posted = 0, failed = 0;
  for (const p of plan) {
    const tenant = p.tenant || createdTenants[p.create?.name];
    if (!tenant) { failed++; continue; }
    const ar = await arFor(tenant);
    if (!ar) { failed++; continue; }
    const prop = propByAddr.get(tenant.property);
    const amt = Math.abs(Number(p.m.amount));
    const inflow = p.m.direction === "inflow" || Number(p.m.amount) > 0;
    const raw = (p.m.bank_description_raw || "").replace(/\s+/g, " ").slice(0, 300);

    const { data: je, error: jeErr } = await sb.from("acct_journal_entries").insert([{
      company_id: NEW,
      number: `JE-${++nextNum}`,
      reference: `BANK-${p.m.id}`,
      date: p.m.posted_date,
      description: raw,
      property: tenant.property,
      status: "posted",
    }]).select("id").single();
    if (jeErr) { console.error(`  JE failed ${p.m.id}: ${jeErr.message}`); failed++; continue; }

    const lines = [
      { company_id: NEW, journal_entry_id: je.id, account_id: bankGl, account_name: bankAcctName,
        debit: inflow ? amt : 0, credit: inflow ? 0 : amt,
        class_id: prop?.class_id || null, entity_type: "customer", entity_name: tenant.name, entity_id: String(tenant.id) },
      { company_id: NEW, journal_entry_id: je.id, account_id: ar.id, account_name: ar.name,
        debit: inflow ? 0 : amt, credit: inflow ? amt : 0,
        class_id: prop?.class_id || null, entity_type: "customer", entity_name: tenant.name, entity_id: String(tenant.id) },
    ];
    const { error: lErr } = await sb.from("acct_journal_lines").insert(lines);
    if (lErr) {
      console.error(`  lines failed ${p.m.id}: ${lErr.message}`);
      await sb.from("acct_journal_entries").delete().eq("id", je.id).eq("company_id", NEW);
      failed++; continue;
    }
    const { error: tErr } = await sb.from("bank_feed_transaction").update({
      status: "categorized", journal_entry_id: je.id, accepted_at: new Date().toISOString(),
    }).eq("id", p.m.id).eq("company_id", NEW);
    if (tErr) console.error(`  link failed ${p.m.id}: ${tErr.message}`);
    posted++;
    if (posted % 25 === 0) console.log(`  posted ${posted}/${plan.length}`);
  }
  console.log(`\nposted ${posted}, failed ${failed}, left uncategorised ${noCategory.length}`);
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
