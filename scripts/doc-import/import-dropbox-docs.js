#!/usr/bin/env node
/**
 * One-time import of property documents from the local Dropbox folder into
 * Housify (Supabase Storage + the documents table).
 *
 * Dropbox is synced to ~/Dropbox on this Mac, so this is a filesystem walk --
 * no Dropbox API, no OAuth, no tokens to keep alive. That is the whole reason
 * a one-time import is cheap and an ongoing sync would not be.
 *
 * The folder layout already carries the filing information:
 *
 *   <Property Address>/                     -> the property
 *     Lease/<Tenant Name>[-OLD]/            -> the tenant, and whether they are current
 *     HOA Docs/ Loan Docs/ Receipts/ ...    -> the document category
 *     <loose files>                         -> property-level
 *
 * Safety properties, in order of how much they matter:
 *
 *  - Nothing is ever tenant_visible. These files include credit reports,
 *    background checks and a W-2; a tenant portal must not surface those by
 *    default, and the flag can be set per document later by a human.
 *  - A tenant is attached only on a confirmed match. An unmatched document
 *    still imports, filed to its property with no tenant, because a document
 *    on the right property with no tenant is recoverable and one on the wrong
 *    tenant is a privacy breach.
 *  - Every file is hashed (SHA-256) before upload and the hash is recorded in
 *    a local manifest, so a re-run resumes instead of duplicating. The run is
 *    interruptible by design -- this moves gigabytes.
 *  - --dry-run is the default. Uploading requires --commit.
 *
 * Usage:
 *   node import-dropbox-docs.js --company <uuid> [--dry-run|--commit]
 *                               [--limit N] [--report out.csv]
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const ROOT = process.env.DROPBOX_ROOT || path.join(process.env.HOME, "Dropbox");
const ALIASES = path.join(__dirname, "aliases.json");
const MANIFEST = path.join(__dirname, "manifest.json");

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const COMPANY = arg("--company");
const COMMIT = args.includes("--commit");
const LIMIT = Number(arg("--limit", 0)) || 0;
const REPORT = arg("--report");

if (!COMPANY) { console.error("--company <uuid> is required"); process.exit(1); }

// ---------------------------------------------------------------- matching

// House number is the anchor. Stripping street suffixes alone left
// "10204 Prince Pl" two edits from "10206 Prince Place" -- a different
// building on the same street, which is exactly the match you must not make.
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
const lev = (a, b) => {
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = [...Array(n + 1).keys()], cur = [];
  for (let i = 1; i <= m; i++) {
    cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
};
const addrMatch = (a, b) => {
  const A = parseAddr(a), B = parseAddr(b);
  if (!A.num || A.num !== B.num) return false;
  const tol = Math.max(2, Math.floor(Math.min(A.street.length, B.street.length) * 0.25));
  if (lev(A.street, B.street) > tol) return false;
  if (A.unit && B.unit && A.unit !== B.unit) return false;
  return true;
};

// Names are compared as TOKEN SETS. Comparing sorted strings made "first
// name" mean "alphabetically first word" (so "Tanesha Chaunte" had the first
// name "chaunte") and mashed joint leases into a string resembling neither
// tenant: "Martin Flores Pimentel & Alfonso Pimentel" scored as a miss
// against "MARTIN FLORES PIMENTEL".
const toks = (s) => String(s || "").toLowerCase().replace(/-old\s*$/, "")
  .replace(/[^a-z\s]/g, " ").split(/\s+/).filter(w => w.length > 1);
const people = (s) => String(s || "").replace(/-old\s*$/i, "").split(/\s*(?:&|\band\b|,)\s*/i)
  .map(toks).filter(t => t.length);

const nameMatch = (folderName, tenantName) => {
  const T = toks(tenantName);
  if (!T.length) return null;
  for (const P of people(folderName)) {
    const setP = new Set(P), setT = new Set(T);
    const inter = T.filter(w => setP.has(w));
    if (inter.length === T.length || P.every(w => setT.has(w))) return "high";
    if (inter.length >= 2) return "high";
    const ls = P[P.length - 1], lt = T[T.length - 1];
    if (ls && lt && lev(ls, lt) <= 2 && Math.min(ls.length, lt.length) >= 5) return "medium";
  }
  return null;
};

// ------------------------------------------------------------ classification

// Filenames are the only signal without opening the file. Anything uncertain
// lands in "Other" rather than being asserted into a category -- a misfiled
// document is worse than an unsorted one.
const classify = (name, folderCategory) => {
  const n = name.toLowerCase();
  const cat = String(folderCategory || "").toLowerCase();
  if (/credit.?report|applicant|background.?check|screening|rentspree|transunion|experian/.test(n))
    return { type: "Other", label: "Screening", sensitive: true };
  if (/\bw-?2\b|paystub|pay.?stub|\bssn\b|social.?security/.test(n))
    return { type: "Financial", label: "Income/ID", sensitive: true };
  if (/\bhap\b|voucher|housing.?assistance|\bhcv\b|section.?8|\brfta\b/.test(n))
    return { type: "Lease", label: "Voucher/HAP" };
  if (/addend|amend|renew|extension/.test(n)) return { type: "Lease", label: "Addendum" };
  if (/notice|violation|evict|breach|terminat|dccv|judgement|judgment|complaint/.test(n))
    return { type: "Notice", label: "Notice/Court" };
  if (/move.?in|move.?out|walk.?through|inspect|condition.?report/.test(n))
    return { type: "Inspection", label: "Move-in/Inspection" };
  if (/insur|policy|\beoi\b|liability/.test(n)) return { type: "Financial", label: "Insurance" };
  if (/lease|rental agreement|residential/.test(n)) return { type: "Lease", label: "Lease" };
  if (/lead|asbestos|mold|radon/.test(n)) return { type: "Inspection", label: "Disclosure" };
  if (/settlement|hud-?1|closing|deed|title|psa\b|purchase/.test(n)) return { type: "Financial", label: "Purchase/Settlement" };
  if (/loan|mortgage|note|refinanc|amortiz/.test(n)) return { type: "Financial", label: "Loan" };
  if (/hoa|condo|association|resale|bylaw/.test(n)) return { type: "Financial", label: "HOA" };
  if (/invoice|receipt|estimate|quote|bill\b/.test(n)) return { type: "Financial", label: "Invoice/Receipt" };
  if (/permit|license/.test(n)) return { type: "Inspection", label: "Permit/License" };
  if (/repair|maintenance|work.?order|plumb|hvac|roof|electric/.test(n)) return { type: "Maintenance", label: "Maintenance" };
  if (/\.(png|jpe?g|heic|gif|webp)$/.test(n)) return { type: "Other", label: "Photo" };
  // fall back to what the containing folder says, then to Other
  if (/lease/.test(cat)) return { type: "Lease", label: "Lease (by folder)" };
  if (/hoa/.test(cat)) return { type: "Financial", label: "HOA (by folder)" };
  if (/loan|refinanc/.test(cat)) return { type: "Financial", label: "Loan (by folder)" };
  if (/settlement|presale|prepurchase/.test(cat)) return { type: "Financial", label: "Purchase (by folder)" };
  if (/receipt|invoice/.test(cat)) return { type: "Financial", label: "Receipt (by folder)" };
  if (/licen[cs]e|permit|lead/.test(cat)) return { type: "Inspection", label: "Compliance (by folder)" };
  if (/picture/.test(cat)) return { type: "Other", label: "Photo (by folder)" };
  return { type: "Other", label: "Unclassified" };
};

// Documents only. 856 of the first plan's 2,029 files were photographs --
// property pictures, scans of a renter's insurance card, screenshots -- which
// are 2.4 GB of the 3.2 and are not what anyone opens Housify to find. They
// stay in Dropbox. Maintenance photos have their own bucket and their own
// workflow; this importer is not the route for them.
const IMPORTABLE = /\.(pdf|doc|docx|xls|xlsx|txt|csv)$/i;

// Supabase's JS client defaults an unadorned Buffer upload to
// "text/plain;charset=UTF-8". That is what the object is served as forever
// after -- browsers will not render a PDF sent as plain text, so all 719
// documents from the first run opened as nothing. The type must be declared
// at upload time: correcting storage.objects.metadata afterwards changes the
// database row but NOT what the storage API serves (verified: cache MISS,
// still text/plain), so the only repair is to re-upload.
const MIME = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  csv: "text/csv",
};
const mimeFor = (name) => MIME[String(name).split(".").pop().toLowerCase()] || "application/octet-stream";
const PHOTO = /\.(jpg|jpeg|png|gif|webp|heic)$/i;
const sanitize = (s) => String(s).replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_").slice(-120);
const shortId = () => crypto.randomBytes(6).toString("hex");

// ------------------------------------------------------------------- main

(async () => {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) { console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY not set"); process.exit(1); }
  const sb = createClient(url, key);

  const aliases = JSON.parse(fs.readFileSync(ALIASES, "utf8"));
  const aliasOf = (folderName) => (aliases.tenantAliases || [])
    .find(a => a.confirmed && a.folderName.toLowerCase() === folderName.replace(/-old\s*$/i, "").trim().toLowerCase());
  const overrideOf = (folderName) => (aliases.tenantFilingOverrides || [])
    .find(o => o.confirmed && o.folderName.toLowerCase() === folderName.replace(/-old\s*$/i, "").trim().toLowerCase());

  const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : { done: {} };

  const { data: props, error: pe } = await sb.from("properties")
    .select("id,address").eq("company_id", COMPANY).is("archived_at", null);
  if (pe) throw pe;
  const { data: tens, error: te } = await sb.from("tenants")
    .select("id,name,property_id,lease_status").eq("company_id", COMPANY).is("archived_at", null);
  if (te) throw te;

  // already-imported names, so a second run does not duplicate what the
  // manifest does not know about (a run from another machine, say)
  const existing = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("documents")
      .select("name,file_name").eq("company_id", COMPANY).range(from, from + 999);
    if (error) throw error;
    data.forEach(d => existing.add((d.name || "").toLowerCase()));
    if (data.length < 1000) break;
  }

  const folders = fs.readdirSync(ROOT).filter(f => {
    try { return fs.statSync(path.join(ROOT, f)).isDirectory() && !f.startsWith("."); } catch { return false; }
  });

  const plan = [];
  const propByAddr = new Map();
  for (const p of props) {
    const hit = folders.find(f => addrMatch(p.address, f));
    if (hit) propByAddr.set(hit, p);
  }

  const walk = (dir, onFile, rel = "") => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name.startsWith("~$")) continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp, onFile, rel ? rel + "/" + e.name : e.name);
      else onFile(fp, rel, e.name);
    }
  };

  for (const [folder, prop] of propByAddr) {
    const mine = tens.filter(t => t.property_id === prop.id);
    walk(path.join(ROOT, folder), (fp, rel, fname) => {
      if (!IMPORTABLE.test(fname)) return;
      const segs = rel ? rel.split("/") : [];
      const category = segs[0] || "";
      let tenant = null, tenantConf = null, fileToProp = prop;

      // a tenant folder is the second segment under Lease/
      if (/^lease$/i.test(category) && segs[1]) {
        const sub = segs[1];
        // A "-OLD" suffix is Sahil's own filing for a former tenant, and
        // former tenants are explicitly out of scope. The first version of
        // this READ the suffix (to label the match) but never acted on it,
        // so 137 former tenants' documents -- including court filings and
        // screening reports -- were imported before the run was stopped.
        if (/-old\s*$/i.test(sub)) return;
        const isOld = false;
        const alias = aliasOf(sub);
        const wanted = alias ? alias.tenantName : sub;
        let hit = null, conf = null;
        for (const t of mine) { const m = nameMatch(wanted, t.name); if (m) { hit = t; conf = m; if (m === "high") break; } }
        if (!hit && alias) { const t = tens.find(x => x.name.toLowerCase() === alias.tenantName.toLowerCase()); if (t) { hit = t; conf = "alias"; } }
        if (!hit) { for (const t of tens) { if (nameMatch(wanted, t.name) === "high") { hit = t; conf = "moved"; break; } } }
        const ov = overrideOf(sub);
        if (ov) {
          const target = props.find(p => addrMatch(p.address, ov.fileToProperty));
          if (target) fileToProp = target;
          if (!hit) { const t = tens.find(x => x.name.toLowerCase() === (aliasOf(sub)?.tenantName || sub).toLowerCase()); if (t) { hit = t; conf = "override"; } }
        }
        if (hit) { tenant = hit; tenantConf = (isOld ? "past:" : "") + conf; }
      }

      const cls = classify(fname, category);
      plan.push({
        src: fp,
        folder, category: category || "(root)",
        property: fileToProp.address, propertyId: fileToProp.id,
        tenant: tenant ? tenant.name : "", tenantId: tenant ? tenant.id : null, tenantConf: tenantConf || "",
        fileName: fname, type: cls.type, label: cls.label, sensitive: !!cls.sensitive,
        size: (() => { try { return fs.statSync(fp).size; } catch { return 0; } })(),
      });
    });
  }

  plan.sort((a, b) => a.property.localeCompare(b.property) || a.fileName.localeCompare(b.fileName));
  const work = LIMIT ? plan.slice(0, LIMIT) : plan;

  // ------------------------------------------------------------- reporting
  const by = (arr, k) => arr.reduce((m, x) => { m[x[k]] = (m[x[k]] || 0) + 1; return m; }, {});
  const totalMB = (arr) => (arr.reduce((s, x) => s + x.size, 0) / 1048576).toFixed(0);
  console.log(`Dropbox root:        ${ROOT}`);
  console.log(`properties matched:  ${propByAddr.size} of ${props.length}`);
  console.log(`files to import:     ${work.length}   (${totalMB(work)} MB)`);
  console.log(`  with a tenant:     ${work.filter(w => w.tenantId).length}`);
  console.log(`  property only:     ${work.filter(w => !w.tenantId).length}`);
  console.log(`  flagged sensitive: ${work.filter(w => w.sensitive).length}`);
  console.log(`\nby Housify type:`);
  Object.entries(by(work, "type")).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(`  ${String(n).padStart(5)}  ${t}`));
  console.log(`\nby detected kind:`);
  Object.entries(by(work, "label")).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(`  ${String(n).padStart(5)}  ${t}`));

  if (REPORT) {
    const esc = v => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [["property", "tenant", "match", "type", "kind", "sensitive", "category", "file", "MB"].join(",")]
      .concat(work.map(w => [w.property, w.tenant, w.tenantConf, w.type, w.label, w.sensitive ? "YES" : "",
        w.category, w.fileName, (w.size / 1048576).toFixed(2)].map(esc).join(",")));
    fs.writeFileSync(REPORT, rows.join("\n"));
    console.log(`\nwrote ${REPORT}`);
  }

  if (!COMMIT) {
    console.log(`\nDRY RUN -- nothing uploaded. Re-run with --commit to import.`);
    return;
  }

  // ---------------------------------------------------------------- upload
  let ok = 0, skip = 0, fail = 0;
  for (const [i, w] of work.entries()) {
    const buf = fs.readFileSync(w.src);
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    const docName = w.tenant ? `${w.tenant} — ${w.fileName}` : w.fileName;
    if (manifest.done[hash] || existing.has(docName.toLowerCase())) { skip++; continue; }

    const storagePath = `${COMPANY}/${shortId()}_${sanitize(w.fileName)}`;
    const { error: ue } = await sb.storage.from("documents")
      .upload(storagePath, buf, { upsert: false, contentType: mimeFor(w.fileName) });
    if (ue) { console.error(`  upload failed: ${w.fileName}: ${ue.message}`); fail++; continue; }

    const { error: ie } = await sb.from("documents").insert([{
      company_id: COMPANY,
      name: docName,
      file_name: storagePath,
      url: storagePath,
      property: w.property,
      tenant: w.tenant || "",
      type: w.type,
      tenant_visible: false,   // never, for any of these -- see header
      uploaded_at: new Date().toISOString(),
    }]);
    if (ie) {
      console.error(`  insert failed: ${w.fileName}: ${ie.message}`);
      await sb.storage.from("documents").remove([storagePath]);  // do not leave an orphan blob
      fail++; continue;
    }
    manifest.done[hash] = { name: docName, at: new Date().toISOString() };
    ok++;
    if (ok % 25 === 0) {
      fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
      console.log(`  ${i + 1}/${work.length}  imported ${ok}, skipped ${skip}, failed ${fail}`);
    }
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(`\nimported ${ok}, skipped ${skip} (already there), failed ${fail}`);
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
