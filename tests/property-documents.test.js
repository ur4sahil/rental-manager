// The property documents module.
//
// The property panel used to show ONE flat list, capped at .limit(100) with
// no paging, drawn from the documents table alone. So: a property with more
// than 100 files silently lost the oldest ones; a lease sat interleaved with
// twelve gas statements by upload date; and signed paperwork in doc_generated
// plus maintenance photos in work_order_photos never appeared at all.
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}
const read = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const mod   = read("src/components/PropertyDocuments.js");
const props = read("src/components/Properties.js");
const help  = read("src/utils/helpers.js");

console.log("\n=== PROPERTY DOCUMENTS MODULE ===\n");

// ---- 1. the cap is gone, everywhere -----------------------------------
assert("the module pages every source instead of capping",
  (mod.match(/fetchAllPaged\(/g) || []).length === 3,
  "documents, doc_generated and work_order_photos each need paging");

// The documents TAB is what had the cap. Two other capped document queries
// remain and are meant to: the activity timeline (payments + work orders +
// documents merged, bounded on purpose with a comment saying why) and a past
// tenant's own panel. Neither is this module, so the assertion is scoped to
// the tab rather than to the file.
const tabStart = props.indexOf('propertyDetailTab === "documents" && (');
const tabBlock = props.slice(tabStart, props.indexOf('propertyDetailTab === "', tabStart + 40));
assert("the documents tab is rendered by the module, not an inline list",
  /<PropertyDocuments/.test(tabBlock)
  && !/from\("documents"\)\s*\.select/.test(tabBlock),
  "an inline query here is how the cap got reintroduced last time");

assert("nothing feeding the documents tab is capped",
  !/\.limit\(\d+\)/.test(tabBlock),
  "that cap dropped the OLDEST files with nothing on screen to say so");

assert("the caps that remain elsewhere are deliberate and say so",
  /Deliberately capped, like the payments query/.test(props),
  "a bound without a reason reads as an oversight");

assert("the old flat list state is gone, not just unused",
  !/propertyDocs/.test(props),
  "leaving it behind invites a second list that disagrees with the first");

assert("upload and orphan-attach refresh the module",
  /setDocsRefreshKey\(k => k \+ 1\)/.test(props)
  && (props.match(/setDocsRefreshKey/g) || []).length >= 3,
  "declared, bumped on attach, and bumped on upload");

// ---- 2. all three sources are read ------------------------------------
for (const [what, needle] of [
  ["documents",         'from("documents")'],
  ["doc_generated",     'from("doc_generated")'],
  ["work_order_photos", 'from("work_order_photos")'],
]) {
  assert(`reads ${what}`, mod.includes(needle),
    "a property's files are not all in one table");
}

assert("scoped to the company AND the property on every source",
  (mod.match(/\.eq\("company_id", companyId\)/g) || []).length >= 3
  && /\.eq\("property", address\)/.test(mod)
  && /\.eq\("property_address", address\)/.test(mod),
  "doc_generated names the column property_address, not property");

assert("prefers the SIGNED pdf over the unsigned render",
  /g\.signed_pdf_path \|\| g\.pdf_output_path \|\| g\.file_path/.test(mod),
  "once a document is signed, the render is a draft and opening it is wrong");

// ---- 3. folders, and tenants inside them -----------------------------
assert("folders are ordered deliberately, not alphabetically",
  /Deliberately not alphabetical/.test(mod)
  && /const FOLDER_ORDER = \[/.test(mod));

assert("tenant paperwork is split per person",
  /put\("Tenant Documents", d, d\.tenant\)/.test(mod),
  '"the tenant\'s documents" is a different set of files for each person who lived there');

assert("utility bills and receipts are their own folders",
  /"Utility Bill", "Utility Receipt"/.test(mod));

// Behavioural, not a grep: lift the real resolver out of the module and run
// it against the type values that are ACTUALLY in the database. Real data
// holds "Insurance" and "insurance" as separate values, "inspection" in lower
// case, and "Receipt", which is not in DOC_TYPES at all.
const folderForType = (() => {
  const from = mod.indexOf("const FOLDER_ORDER = [");
  const to = mod.indexOf("\n}", mod.indexOf("function folderForType")) + 2;
  if (from < 0 || to < 2) throw new Error("PropertyDocuments.js no longer declares folderForType");
  // eslint-disable-next-line no-new-func
  return new Function(mod.slice(from, to) + "\nreturn folderForType;")();
})();

assert("case variants land in ONE folder",
  folderForType("insurance") === "Insurance" && folderForType("Insurance") === "Insurance",
  `got ${folderForType("insurance")} and ${folderForType("Insurance")} — real data holds both spellings`);

assert("lower-case inspection reaches the Inspection folder",
  folderForType("inspection") === "Inspection");

assert("a type nobody planned for keeps its OWN folder",
  folderForType("Receipt") === "Receipt",
  '"Other" is where things go to be lost');

assert("an empty or missing type is Unfiled",
  folderForType("") === "Unfiled" && folderForType(null) === "Unfiled"
  && folderForType(undefined) === "Unfiled");

assert("surrounding whitespace does not create a second folder",
  folderForType("  Lease  ") === "Lease");

// Every DOC_TYPES value must have a folder, or documents of that type
// vanish from the property view.
const docTypeValues = [...help.matchAll(/\{ value: "([^"]+)", label:/g)].map(m => m[1]);
const folderOrder = mod.slice(mod.indexOf("const FOLDER_ORDER = ["), mod.indexOf("];", mod.indexOf("const FOLDER_ORDER = [")));
const missing = docTypeValues.filter(t => !folderOrder.includes(`"${t}"`));
assert("every document type has a folder to land in",
  missing.length === 0,
  `types with no folder: ${JSON.stringify(missing)}`);

// ---- 4. failures are visible, not empty folders ----------------------
assert("a failed page is reported rather than shown as an empty folder",
  /const failed = \[docsRes, genRes, photoRes\]\.some\(r => r\.failed\)/.test(mod)
  && /could not be loaded/.test(mod),
  '"my documents are gone" gets misdiagnosed as a deletion otherwise');

assert("a slow fetch cannot overwrite a newer one",
  /if \(run !== runRef\.current\) return;/.test(mod),
  "switching property twice quickly is enough to do it");

// ---- 5. deletion is only offered where it is possible ----------------
assert("only documents rows are deletable",
  /deletable: true,/.test(mod)
  && (mod.match(/deletable: false,/g) || []).length === 2,
  "doc_generated and work_order_photos have no archive path here");

assert("deleting archives rather than destroys",
  /archived_at: new Date\(\)\.toISOString\(\)/.test(mod)
  && !/\.delete\(\)/.test(mod),
  "soft delete, recoverable for 180 days");

assert("a read-only user is offered neither upload nor delete",
  /!isReadOnly && \(/.test(mod) && /\{!isReadOnly &&/.test(mod));

// ---- 6. tenant-visibility is on the row -----------------------------
assert("a tenant-visible file says so on its row",
  /function VisibilityChip/.test(mod) && /tenant can see/.test(mod),
  "a statement carries an account number; whether the tenant sees it should not need a click");

// ---- 7. search --------------------------------------------------------
assert("search covers name, tenant and type",
  /d\.name\.toLowerCase\(\)\.includes\(needle\)/.test(mod)
  && /\(d\.tenant \|\| ""\)\.toLowerCase\(\)\.includes\(needle\)/.test(mod)
  && /d\.type\.toLowerCase\(\)\.includes\(needle\)/.test(mod));

assert("searching opens the folders so hits are visible",
  /const isOpen = q\.trim\(\) \? true : open\.has\(f\.name\)/.test(mod),
  "otherwise a match hides inside a closed folder");

// The address needs no escaping here BECAUSE every query uses .eq(), which
// sends a plain parameter. What matters is that none of them uses a form that
// parses the value as filter syntax.
assert("the address never reaches a filter that parses it",
  !/\.or\(`?[^)]*\$\{address\}/.test(mod)
  && !/\.i?like\([^)]*address/.test(mod),
  ".or()/.ilike() would need escapeFilterValue; .eq() does not");

console.log(`\n${failed === 0 ? "✅" : "❌"} Passed: ${passed}   ❌ Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
