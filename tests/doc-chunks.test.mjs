// Adversarial tests for the chunker. These look for the failures that
// make retrieval quietly useless rather than confirming it runs.
import fs from "fs"; import path from "path";
const src = fs.readFileSync(path.join(import.meta.dirname, "../src/utils/docChunks.js"), "utf8");
// docChunks imports dompurify; load it with that import stripped and no
// DOM present, which also exercises the no-DOM fallback path.
const mod = await import("data:text/javascript," + encodeURIComponent(
  src.replace(/^import DOMPurify.*$/m, "const DOMPurify = { sanitize: (s) => s };")));
const { htmlToText, chunkText, buildChunkRows, CHUNK_CHARS } = mod;

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log("  ❌", m)); };

// --- htmlToText -----------------------------------------------------
// The failure that matters: gluing the last word of one block to the
// first of the next, which yields passages that read as nonsense.
const glued = htmlToText("<p>rent is due</p><p>Tenant shall pay</p>");
ok(!/duetenant/i.test(glued.replace(/\s/g, "")) || /due\s+tenant/i.test(glued),
   `block boundary glued words: ${JSON.stringify(glued)}`);
ok(/due/.test(glued) && /Tenant/.test(glued), "both paragraphs survive");
ok(htmlToText("<li>a</li><li>b</li>").split(/\s+/).length >= 2, "list items separate");
ok(htmlToText("a<br>b").includes("a") && htmlToText("a<br>b").includes("b"), "br separates");
ok(htmlToText("") === "", "empty html");
ok(htmlToText(null) === "", "null html");
ok(htmlToText(undefined) === "", "undefined html");
ok(!/&nbsp;/.test(htmlToText("<p>a&nbsp;b</p>")), "entities decoded");
ok(!/</.test(htmlToText("<p>hi</p>")), "no tags remain");
// Script content must not become a "passage" that ends up in a prompt.
ok(!/alert/.test(htmlToText("<p>ok</p><script>alert(1)</script>")), "script body excluded");

// --- chunkText ------------------------------------------------------
ok(chunkText("").length === 0, "empty text yields no chunks");
ok(chunkText("   \n\n  ").length === 0, "whitespace-only yields no chunks");
ok(chunkText(null).length === 0, "null yields no chunks");
ok(chunkText("short").length === 1, "short text is one chunk");
const long = Array.from({ length: 40 }, (_, i) => `Clause ${i}. ` + "word ".repeat(60)).join("\n\n");
const cs = chunkText(long);
ok(cs.length > 1, "long text splits");
ok(cs.every(c => c.length <= CHUNK_CHARS * 1.6), `no chunk wildly over target (max ${Math.max(...cs.map(c => c.length))})`);
ok(cs.every(c => c.trim().length > 0), "no empty chunks");
// Nothing may be silently dropped: every clause marker must survive
// somewhere, or retrieval simply cannot find that clause.
const joined = cs.join(" ");
const missing = Array.from({ length: 40 }, (_, i) => `Clause ${i}.`).filter(m => !joined.includes(m));
ok(missing.length === 0, `clauses lost entirely: ${missing.slice(0, 4).join(", ")}`);
// One paragraph longer than the target must still be divided.
const onePara = "Sentence one. " .repeat(400);
ok(chunkText(onePara).length > 1, "a single over-long paragraph still splits");

// --- buildChunkRows -------------------------------------------------
const rows = buildChunkRows({ companyId: "c1", sourceTable: "doc_generated", sourceId: "7",
                              sourceName: "Lease", html: "<p>" + "word ".repeat(800) + "</p>" });
ok(rows.length > 1, "rows produced");
ok(rows.every(r => r.company_id === "c1"), "company_id on every row");
ok(rows.every(r => r.source_id === "7"), "source_id stringified");
ok(rows.map(r => r.chunk_index).join() === rows.map((_, i) => i).join(), "chunk_index is dense and ordered");
let threw = false;
try { buildChunkRows({ companyId: "c1", sourceTable: "nope", sourceId: "1", html: "x" }); } catch { threw = true; }
ok(threw, "unknown sourceTable throws rather than storing unsearchable rows");
threw = false;
try { buildChunkRows({ sourceTable: "doc_generated", sourceId: "1", html: "x" }); } catch { threw = true; }
ok(threw, "missing companyId throws (a chunk with no company escapes RLS scoping)");
threw = false;
try { buildChunkRows({ companyId: "c1", sourceTable: "doc_generated", html: "x" }); } catch { threw = true; }
ok(threw, "missing sourceId throws");
ok(buildChunkRows({ companyId: "c1", sourceTable: "doc_generated", sourceId: "1", html: "" }).length === 0,
   "an empty document yields no rows rather than one empty chunk");

console.log(`\n✅ Passed: ${pass}\n❌ Failed: ${fail}`);
process.exit(fail ? 1 : 0);
