// Required-document checklist: classification must be able to clear a
// requirement.
//
// The original check read:
//     if (types.includes(t) && nameRe.test(name)) return true;
//     return nameRe.test(name);
// Both branches came down to the filename, so the `types` field did nothing
// and setting a document's type correctly could never satisfy a requirement.
// The only escapes were renaming the file or an admin waiver — which is why
// tenants with a renter's insurance certificate on file still showed
// "Renters Insurance" outstanding.

const REQUIRED_TENANT_DOCS = [
  { label: "Signed Lease Agreement", types: ["Lease"], nameRe: /\blease\b/i },
  { label: "Government-Issued ID", types: ["ID"], nameRe: /\b(id|license|passport|government[-_\s]?issued)\b/i },
  { label: "Renters Insurance", types: ["Insurance"], nameRe: /\b(renters?[-_\s]?insurance|rental[-_\s]?insurance)\b/i },
  { label: "Proof of Utility Transfer", types: ["Utility Transfer"], nameRe: /\b(utility|utilities)\b/i },
];
function satisfied(docs, req) {
  return (docs || []).some(d => {
    const t = (d?.type || "").trim();
    if (req.types.includes(t)) return true;
    return req.nameRe.test(d?.name || "");
  });
}
const OLD = (docs, req) => (docs || []).some(d => {
  const t = (d?.type || "").trim();
  if (req.types.includes(t) && req.nameRe.test(d?.name || "")) return true;
  return req.nameRe.test(d?.name || "");
});

let passed = 0, failed = 0;
const assert = (name, cond, detail) => {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (detail ? "\n       " + detail : "")); }
};
const req = (label) => REQUIRED_TENANT_DOCS.find(r => r.label === label);

console.log("\n=== Classification clears a requirement ===");
{
  // The regression, in the exact shape it appeared: a scanner filename.
  const docs = [{ name: "Epson_11082024113258.pdf", type: "Insurance" }];
  assert("a file classified as Insurance satisfies Renters Insurance",
    satisfied(docs, req("Renters Insurance")) === true,
    "classifying a document is the only way to clear this when the filename says nothing");
  assert("...and the OLD logic could not — this is the bug",
    OLD(docs, req("Renters Insurance")) === false,
    "if this fails, the old logic already worked and the fix was unnecessary");
}
{
  const docs = [{ name: "Utility transfer confirmation.pdf", type: "Other" }];
  assert("an unclassified file still counts when its NAME is unambiguous",
    satisfied(docs, req("Proof of Utility Transfer")) === true);
}
{
  // Documented limitation, not a defect to fix blindly: \b sits between a
  // word and a non-word character, and "_" is a word character -- so
  // "utility_transfer.pdf" does NOT match /\butility\b/. Loosening the
  // pattern would start matching things like "futility". Classifying the
  // document is the reliable route, which is exactly why the control exists.
  const docs = [{ name: "utility_transfer_confirmation.pdf", type: "Other" }];
  assert("an underscore-joined filename does NOT match by name (known limit)",
    satisfied(docs, req("Proof of Utility Transfer")) === false);
  const classified = [{ name: "utility_transfer_confirmation.pdf", type: "Utility Transfer" }];
  assert("...but classifying that same file clears the requirement",
    satisfied(classified, req("Proof of Utility Transfer")) === true);
}
{
  // "Other" is the import default; 200 documents carry it. Accepting it would
  // mark the requirement met for any tenant with a stray upload.
  const docs = [{ name: "random_scan.pdf", type: "Other" }];
  assert("a plain 'Other' document does NOT satisfy Proof of Utility Transfer",
    satisfied(docs, req("Proof of Utility Transfer")) === false,
    "'Other' is the default for anything unclassified — it must not clear a requirement");
  assert("...nor does it satisfy Renters Insurance",
    satisfied(docs, req("Renters Insurance")) === false);
}
{
  const docs = [{ name: "life_insurance_policy.pdf", type: "Other" }];
  assert("'life_insurance' does not pass as renters insurance by name",
    satisfied(docs, req("Renters Insurance")) === false);
}
{
  const docs = [{ name: "Complete_with_Docusign_Residential_Lease_Ama.pdf", type: "Lease" }];
  assert("a lease satisfies the lease requirement", satisfied(docs, req("Signed Lease Agreement")) === true);
  assert("...but not the ID requirement", satisfied(docs, req("Government-Issued ID")) === false);
}
{
  const docs = [{ name: "drivers license.pdf", type: "ID" }];
  assert("an ID satisfies Government-Issued ID", satisfied(docs, req("Government-Issued ID")) === true);
}

console.log("\n=== Every requirement's type is offerable in the UI ===");
{
  const DOC_TYPES = ["Lease", "ID", "Insurance", "Utility Transfer", "Inspection", "Maintenance", "Financial", "Notice", "Other"];
  for (const r of REQUIRED_TENANT_DOCS) {
    assert(`"${r.label}" can be selected (${r.types.join("/")})`,
      r.types.some(t => DOC_TYPES.includes(t)),
      "a requirement whose type is not in the dropdown can never be cleared by classifying");
  }
}

console.log(`\n${failed ? "❌" : "✅"} Passed: ${passed}   Failed: ${failed}\n`);
process.exit(failed ? 1 : 0);
