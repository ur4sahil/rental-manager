// The AI pipeline's non-model parts, which are where the real bugs live.
//
// Deliberately NOT mocking a model: the interesting failures here are a
// plausible-looking answer becoming a database error, a chunker cutting a
// clause in half so neither half ranks, and a failed extraction leaving
// no trace to debug.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chunkText } = require("../api/_ai-chunk.js");
const { normalisers } = require("../api/_ai-extract.js");
const { aiConfigured, askJson } = require("../api/_ai.js");

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`); }
};

// ---- dates -------------------------------------------------------------
// The licence Sahil sent prints 6/23/2026. A model told to return ISO will
// still sometimes echo the document's format, and a US date written into a
// `date` column fails at the database, where the extraction is already lost.
check("ISO passes through", normalisers.iso("2026-06-23") === "2026-06-23");
check("US format is converted", normalisers.iso("6/23/2026") === "2026-06-23");
check("zero-padded US converts", normalisers.iso("06/23/2026") === "2026-06-23");
check("a prose date is refused, not mangled", normalisers.iso("23 June 2026") === null);
check("nonsense is null", normalisers.iso("not a date") === null);
for (const v of ["", null, undefined]) check(`empty (${JSON.stringify(v)}) is null`, normalisers.iso(v) === null);

// ---- money -------------------------------------------------------------
// "none" strips to "" and Number("") is 0, so a fee the document does not
// state was being recorded as a fee of ZERO -- a wrong number that looks
// like a real one. Caught by testing, not by reading.
check("currency parses", normalisers.num("$1,200.50") === 1200.5);
check('"none" is null, NOT zero', normalisers.num("none") === null);
check('"n/a" is null, NOT zero', normalisers.num("n/a") === null);
check("a lone dot is null", normalisers.num(".") === null);
check("a real zero survives", normalisers.num("0") === 0);

// ---- chunking ----------------------------------------------------------
// A clause is the unit someone asks about. Slicing every N characters cuts
// clauses in half so that neither half ranks for the question.
const clauses = ["LATE FEES. " + "a ".repeat(200), "DEPOSIT. " + "b ".repeat(200)].join("\n\n");
const cs = chunkText(clauses);
check("paragraphs are kept together", cs.length >= 1);
check("no chunk exceeds the cap", cs.every(c => c.length <= 1200), cs.map(c => c.length).join(","));
check("a clause heading stays with its text",
  cs.some(c => c.includes("LATE FEES.")) && cs.some(c => c.includes("DEPOSIT.")));
const huge = chunkText("word ".repeat(2000));
check("one oversized paragraph is split, not dropped", huge.length > 1);
check("...and nothing is lost", huge.join(" ").replace(/\s+/g, " ").trim().split(" ").length >= 1900,
  `${huge.join(" ").split(/\s+/).length} words survived of 2000`);
check("empty input yields no chunks", chunkText("").length === 0);
check("a stray short line is not a chunk", chunkText("hi").length === 0);

// ---- the client fails safely -------------------------------------------
// A model-side problem must be RECORDED, never thrown: the caller writes an
// ai_jobs row and an exception loses the context that makes it debuggable.
check("aiConfigured is false with no endpoint", aiConfigured() === false);
const r = await askJson({ system: "s", prompt: "p" });
check("askJson returns a failure rather than throwing", r.ok === false && typeof r.error === "string");
check("...and names the missing configuration", /AI_BASE_URL/.test(r.error), r.error);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
