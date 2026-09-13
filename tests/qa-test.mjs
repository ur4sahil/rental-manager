// Does retrieval-grounded Q&A actually answer from the document, and does
// it REFUSE when the document does not contain the answer?
//
// The second half is the point. A fluent answer drawn from general
// knowledge of leases -- rather than from this lease -- is the failure
// that makes the whole feature untrustworthy, and it surfaces exactly
// when retrieval finds nothing useful.
import { readFileSync } from "node:fs";
const API = "https://test.housify365.com";
const H = { "Content-Type": "application/json", "x-vercel-protection-bypass": process.env.VERCEL_BYPASS_TOKEN };
const COMPANY = "sandbox-llc";
const lease = readFileSync("/tmp/lease-30k.txt", "utf8");

console.log("ingesting the 12-page lease...");
const ing = await (await fetch(`${API}/api/ai?action=ingest`, { method: "POST", headers: H,
  body: JSON.stringify({ companyId: COMPANY, sourceTable: "leases", sourceId: "qa-test-lease",
    sourceName: "100 Oak Street lease", text: lease }) })).json();
console.log(" ", JSON.stringify(ing), "\n");

const QUESTIONS = [
  { q: "What is the monthly rent?",                 want: "2,450" },
  { q: "Who is the landlord?",                      want: "Sigma Housing" },
  { q: "When does the lease end?",                  want: "2027" },
  { q: "How much is the late charge?",              want: "122.50" },
  { q: "Are pets allowed?",                         want: "permission" },
  // Not in the lease at all. Must refuse.
  { q: "What is the wifi password?",                want: "__REFUSE__" },
  { q: "How many parking spaces are included?",     want: "__REFUSE__" },
];

for (const { q, want } of QUESTIONS) {
  const t0 = Date.now();
  const r = await (await fetch(`${API}/api/ai?action=ask`, { method: "POST", headers: H,
    body: JSON.stringify({ companyId: COMPANY, question: q }) })).json();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const ans = (r.answer || "").replace(/\s+/g, " ").trim();
  const refused = r.found === false || !r.answer;
  const ok = want === "__REFUSE__" ? refused
           : (!refused && (ans.includes(want) || (r.quote || "").includes(want)));
  console.log(`${ok ? "PASS" : "FAIL"}  ${q}  (${secs}s)`);
  console.log(`      answer: ${ans.slice(0, 130) || "(none)"}`);
  if (r.quote) console.log(`      quote:  "${r.quote.replace(/\s+/g, " ").slice(0, 110)}"`);
  if (!ok) console.log(`      wanted: ${want}`);
  console.log();
}
