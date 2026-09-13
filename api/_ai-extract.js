// Extraction jobs: read a document, propose structured fields, never write.
//
// Everything here produces an ai_jobs row with status 'proposed'. A human
// approves before a single column changes. That is not caution for its
// own sake -- a confidently wrong licence number on a property you are
// renting out is a filing problem, not a UI bug.
const { askJson } = require("./_ai");

// The rental licence shape, matched to the fields property_licenses
// actually has. Asking for fields the table cannot store produces
// plausible output that then has nowhere to go.
const LICENSE_SCHEMA = `{
  "license_number": string|null,
  "jurisdiction": string|null,
  "issue_date": "YYYY-MM-DD"|null,
  "expiry_date": "YYYY-MM-DD"|null,
  "fee_amount": number|null,
  "license_type": "rental_license"|"rental_registration"|"lead_paint"|null,
  "property_address": string|null,
  "owner_name": string|null,
  "confidence": number
}`;

const LICENSE_SYSTEM = [
  "You read a rental licence or registration certificate and return its fields.",
  "Copy values EXACTLY as printed. Do not reformat a licence number, do not expand an abbreviation.",
  "Dates must be ISO (YYYY-MM-DD) whatever format the document uses.",
  "jurisdiction is the issuing authority, e.g. \"Prince George's County\".",
  "confidence is your own 0..1 estimate that every non-null field is correct.",
].join(" ");

// Exported so they can be tested without a model endpoint: this is where
// a plausible-looking answer turns into a database error.
const normalisers = {
  iso(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // A model told to return ISO will still sometimes return US format.
    // Converting here beats failing at the date column, where the
    // extraction is already lost.
    const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    return null;
  },
  num(v) {
    if (v === null || v === undefined || v === "") return null;
    // Strip first, THEN check for emptiness. "none" and "n/a" strip to ""
    // and Number("") is 0, so without this a fee the document does not
    // state was recorded as a fee of zero -- a wrong number that looks
    // like a real one.
    const digits = String(v).replace(/[^0-9.]/g, "");
    if (digits === "" || digits === ".") return null;
    const n = Number(digits);
    return Number.isFinite(n) ? n : null;
  },
};

/**
 * Propose licence fields from document text.
 *
 * Returns a shape ready to become an ai_jobs row. It does NOT touch the
 * database -- the caller owns that, so a failed extraction is still
 * recorded with its error rather than vanishing.
 */
async function extractLicense({ text, sourceName }) {
  const excerpt = String(text || "").slice(0, 6000);
  if (!excerpt.trim()) {
    return { ok: false, error: "no text to read — the document may be a scan with no text layer" };
  }
  const r = await askJson({
    system: LICENSE_SYSTEM,
    schemaHint: LICENSE_SCHEMA,
    prompt: `Document${sourceName ? ` (${sourceName})` : ""}:\n"""\n${excerpt}\n"""`,
  });
  if (!r.ok) return r;

  const d = r.data || {};
  const { iso, num } = normalisers;

  return {
    ok: true,
    model: r.model,
    durationMs: r.durationMs,
    confidence: typeof d.confidence === "number" ? Math.max(0, Math.min(1, d.confidence)) : null,
    output: {
      license_number: d.license_number ? String(d.license_number).trim() : null,
      jurisdiction: d.jurisdiction ? String(d.jurisdiction).trim() : null,
      issue_date: iso(d.issue_date),
      expiry_date: iso(d.expiry_date),
      fee_amount: num(d.fee_amount),
      license_type: ["rental_license", "rental_registration", "lead_paint"].includes(d.license_type)
        ? d.license_type : "rental_license",
      // Context for the reviewer, not columns: these are how a human
      // checks the extraction landed on the RIGHT property.
      _property_address: d.property_address ? String(d.property_address).trim() : null,
      _owner_name: d.owner_name ? String(d.owner_name).trim() : null,
    },
    raw: r.raw,
  };
}

module.exports = { extractLicense, normalisers };
