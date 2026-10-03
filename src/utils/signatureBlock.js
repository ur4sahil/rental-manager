// The signature block: one signature line per signer on the document,
// however many tenants the lease has. A template carries one token,
// {{signature_block}}; when a document is generated the token becomes a
// block with a row for each signer (every tenant on the lease, then the
// landlord), each row carrying a signature slot and a date slot. The
// slots are where the real signatures land on the signed PDF
// (signatureStamp.js), so they are marked up to survive every pass the
// body goes through: the sanitizer (data-* attributes are allowed), the
// editor schema (docKit's SignatureSlot node parses them back), and the
// PDF layout (pagedPdf reports each slot's position as an anchor).
//
// Pure: no DOM, no editor. The HTML is built by hand, with every value
// escaped, so the same block renders in the fill preview, the stored
// document, the signing page and the PDF.
export const SIGNATURE_BLOCK_TOKEN = "{{signature_block}}";
export const SIGNATURE_BLOCK_KEY = "signature_block";
const TOKEN_RE = /\{\{\s*signature_block\s*\}\}/g;

export const hasSignatureBlock = (html) => TOKEN_RE.test(String(html || "")) && !(TOKEN_RE.lastIndex = 0);

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Line lengths that fit half a 6.5in text column at 12pt with room for
// " (SEAL)" after the signature line (an underscore is about 6pt wide).
const SIGN_LINE = "_".repeat(26);
const DATE_LINE = "_".repeat(12);
const WITNESS_LINE = "_".repeat(22);

/** A role's printed heading: "TENANT:", "CO-TENANT 2:", "LANDLORD:". */
export function signerHeading(signer) {
  const label = String(signer?.label || signer?.role || "Signer").trim();
  return label.toUpperCase().replace(/\s+/g, " ") + ":";
}

const WITNESS_PREFIX = "witness_";
const isWitness = (role) => String(role || "").startsWith(WITNESS_PREFIX);

/**
 * The rows a block shows, in signing order: every tenant row first (the
 * template's slots plus the extra adults effectiveSignerRoles adds), then
 * the rest. A witness role ("witness_tenant") is not a row of its own: it
 * becomes the witness line beside the row it witnesses. Rows with no name
 * are kept -- a lease with an optional co-tenant slot left empty would
 * otherwise lose the line -- unless `dropUnnamedOptional` says to drop
 * them, which is what a generated document does (an empty optional slot
 * is skipped at send time too).
 * @param {Array<{role,label,order,required}>} roles  effectiveSignerRoles(...)
 * @param {Object<string,string>} names  role -> signer name
 * @returns {Array<{ role, label, name, required, witness: null|{ role, name } }>}
 */
export function signatureRows(roles, names = {}, { dropUnnamedOptional = true } = {}) {
  const list = (Array.isArray(roles) ? roles : []).map((r, i) => ({ ...r, _i: i }));
  list.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || a._i - b._i);
  const witnesses = new Map(list.filter(r => isWitness(r.role)).map(r => [String(r.role).slice(WITNESS_PREFIX.length), r]));
  return list
    .filter(r => !isWitness(r.role))
    .map(r => {
      const w = witnesses.get(String(r.role || ""));
      return {
        role: String(r.role || ""), label: r.label || r.role || "", name: String(names?.[r.role] || "").trim(), required: r.required !== false,
        witness: w ? { role: String(w.role), name: String(names?.[w.role] || "").trim() } : null,
      };
    })
    .filter(r => r.role && (r.name || r.required || !dropUnnamedOptional));
}

/**
 * The block's HTML. `rows` from signatureRows(). Each signer is one row
 * of a borderless two-column table: the witness on the left (a signature
 * slot of its own when the template asks for witnesses; a plain line
 * otherwise, for a witness who signs on paper), the signer on the right,
 * as the Maryland lease lays it out. A row stays on one page.
 * `witness` false drops the witness column altogether.
 */
export function signatureBlockHtml(rows, { witness = true } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return "";
  const cell = (inner) => `<td style="vertical-align:top;padding:0 12px 18px 0">${inner}</td>`;
  const trs = list.map(r => {
    const role = esc(r.role);
    const right =
      `<p data-keep-next="1">${esc(signerHeading(r))}</p>` +
      `<p data-keep-next="1"><span data-sig-role="${role}">${SIGN_LINE}</span> (SEAL)</p>` +
      `<p data-keep-next="1">Print Name: ${esc(r.name)}</p>` +
      `<p>Date: <span data-sig-date="${role}">${DATE_LINE}</span></p>`;
    let left = "";
    if (witness && r.witness) {
      const wr = esc(r.witness.role);
      left = `<p data-keep-next="1">WITNESS:</p>` +
        `<p data-keep-next="1"><span data-sig-role="${wr}">${WITNESS_LINE}</span></p>` +
        `<p data-keep-next="1">Print Name: ${esc(r.witness.name)}</p>` +
        `<p>Date: <span data-sig-date="${wr}">${DATE_LINE}</span></p>`;
    } else if (witness) {
      left = `<p data-keep-next="1">WITNESS:</p><p data-keep-next="1">&nbsp;</p><p data-keep-next="1">${WITNESS_LINE}</p><p>&nbsp;</p>`;
    }
    return `<tr>${witness ? cell(left) : ""}${cell(right)}</tr>`;
  }).join("");
  return `<table class="hx-sig-block" data-borders="none"><tbody>${trs}</tbody></table>`;
}

/** Replace the token in a body with the block (or nothing when there are no signers). */
export function expandSignatureBlock(body, rows, opts) {
  const html = signatureBlockHtml(rows, opts);
  return String(body || "").replace(TOKEN_RE, html);
}

/** Every signature/date slot in a rendered body: [{ kind: "sign"|"date", role }]. */
export function slotsIn(html) {
  const out = [];
  const re = /data-sig-(role|date)="([^"]*)"/g;
  let m;
  while ((m = re.exec(String(html || "")))) out.push({ kind: m[1] === "role" ? "sign" : "date", role: m[2] });
  return out;
}
