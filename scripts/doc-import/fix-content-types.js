#!/usr/bin/env node
/**
 * Repairs the content type on documents already in Supabase Storage.
 *
 * The first import uploaded raw Buffers without declaring a type, so Supabase
 * stored every one as "text/plain;charset=UTF-8" -- including 671 PDFs, which
 * browsers then refuse to render. Updating storage.objects.metadata fixes the
 * database row but NOT what the storage API serves (verified against a cache
 * MISS), so each object has to be written again with the right type.
 *
 * Re-downloads each object and re-uploads it in place, so it does not depend
 * on the Dropbox source still being present or unchanged. Verifies the served
 * Content-Type afterwards rather than assuming.
 *
 *   node fix-content-types.js --company <uuid> [--dry-run] [--limit N]
 */
const { createClient } = require("@supabase/supabase-js");

const args = process.argv.slice(2);
const argv = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const COMPANY = argv("--company");
const DRY = args.includes("--dry-run");
const LIMIT = Number(argv("--limit", 0)) || 0;
if (!COMPANY) { console.error("--company <uuid> required"); process.exit(1); }

const MIME = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  csv: "text/csv",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
};
const mimeFor = (n) => MIME[String(n).split(".").pop().toLowerCase()] || null;

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // The storage schema is not exposed through PostgREST, so the object list
  // comes from the documents table instead -- every imported file has a row
  // there, and file_name IS the storage path.
  const wrong = [];
  const seen = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("documents")
      .select("file_name")
      .eq("company_id", COMPANY)
      .range(from, from + 999);
    if (error) throw error;
    for (const d of data) {
      const name = d.file_name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const want = mimeFor(name);
      if (want) wrong.push({ name, want });
    }
    if (data.length < 1000) break;
  }

  const work = LIMIT ? wrong.slice(0, LIMIT) : wrong;
  const byType = work.reduce((m, w) => { m[w.want] = (m[w.want] || 0) + 1; return m; }, {});
  console.log(`documents to check: ${wrong.length}`);
  Object.entries(byType).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(`  ${String(n).padStart(4)}  -> ${t}`));
  if (DRY) { console.log("\nDRY RUN — nothing rewritten."); return; }

  let fixed = 0, failed = 0, alreadyOk = 0;
  for (const [i, w] of work.entries()) {
    const { data: blob, error: dErr } = await sb.storage.from("documents").download(w.name);
    if (!dErr && blob && blob.type === w.want) { alreadyOk++; continue; }
    if (dErr) { console.error(`  download failed: ${w.name}: ${dErr.message}`); failed++; continue; }
    const buf = Buffer.from(await blob.arrayBuffer());
    const { error: uErr } = await sb.storage.from("documents")
      .upload(w.name, buf, { upsert: true, contentType: w.want });
    if (uErr) { console.error(`  upload failed: ${w.name}: ${uErr.message}`); failed++; continue; }
    fixed++;
    if (fixed % 50 === 0) console.log(`  ${i + 1}/${work.length}  rewritten ${fixed}, failed ${failed}`);
  }

  // Verify by actually fetching one and reading the header back.
  if (work.length) {
    const probe = work[0];
    const { data: signed } = await sb.storage.from("documents").createSignedUrl(probe.name, 60);
    const r = await fetch(signed.signedUrl + "&cb=" + Date.now(), { cache: "no-store" });
    console.log(`\nverify: ${probe.name.split("/").pop().slice(0, 50)}`);
    console.log(`  served as: ${r.headers.get("content-type")}  (wanted ${probe.want})`);
  }
  console.log(`\nrewritten ${fixed}, already correct ${alreadyOk}, failed ${failed}`);
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
