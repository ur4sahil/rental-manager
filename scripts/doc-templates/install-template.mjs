// Install (or refresh) a document template into one company on the TEST
// database:  node scripts/doc-templates/install-template.mjs <template.json> <company_id>
//
// Reads TEST_SUPABASE_URL / TEST_SUPABASE_SERVICE_KEY from tests/.env and
// refuses to run against production. Installing into production is a
// deliberate, separate step.
import fs from "fs";
import path from "path";
const env = Object.fromEntries(fs.readFileSync(path.join(import.meta.dirname, "../../tests/.env"), "utf8").split("\n")
  .filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }));
const url = env.TEST_SUPABASE_URL, key = env.TEST_SUPABASE_SERVICE_KEY;
if (!url || !key) throw new Error("TEST_SUPABASE_URL / TEST_SUPABASE_SERVICE_KEY missing from tests/.env");
if (url.includes("hoymytpyaudjvsgiiibn") || !url.includes("vpeewlplgxthckpidhxo")) throw new Error("refusing: not the TEST project");
const [file, companyId] = process.argv.slice(2);
if (!file || !companyId) throw new Error("usage: install-template.mjs <template.json> <company_id>");
const t = JSON.parse(fs.readFileSync(file, "utf8"));
const h = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation" };
const q = `company_id=eq.${encodeURIComponent(companyId)}&name=eq.${encodeURIComponent(t.name)}&is_active=eq.true`;
const existing = await (await fetch(`${url}/rest/v1/doc_templates?${q}&select=id`, { headers: h })).json();
const row = { ...t, company_id: companyId, is_active: true, updated_at: new Date().toISOString() };
let res;
if (existing.length) res = await fetch(`${url}/rest/v1/doc_templates?id=eq.${existing[0].id}`, { method: "PATCH", headers: h, body: JSON.stringify(row) });
else res = await fetch(`${url}/rest/v1/doc_templates`, { method: "POST", headers: h, body: JSON.stringify({ ...row, created_by: "template-install" }) });
const out = await res.json();
if (!res.ok) throw new Error("install failed: " + JSON.stringify(out).slice(0, 300));
console.log((existing.length ? "updated" : "created"), `"${t.name}" in ${companyId}:`, out[0]?.id);
