// Who signs a document, from the template's signer roles and the people
// on the tenancy. Pure: no Supabase, no DOM, so the tests load it.
// docService.js re-exports these.

/** The default name/email for a signer role, from the document's context. */
export function signerDefaultFor(role, context) {
  const r = String(role || "").toLowerCase();
  // A witness is whoever is in the room: never prefilled from the tenancy
  // (the role name carries the witnessed role, "witness_tenant").
  if (isWitnessRole(r)) return { name: "", email: "" };
  const tenants = context?.signers?.tenants || [];
  // "tenant", "tenant_1" -> first; "tenant_2", "co_tenant" -> second; and so on.
  if (/tenant|renter|lessee|resident|occupant/.test(r) && !/landlord/.test(r)) {
    const n = (r.match(/(\d+)_*\s*$/) || [])[1];
    const index = n ? Number(n) - 1 : /co[_\s-]?tenant|second|joint/.test(r) ? 1 : 0;
    return tenants[index] || { name: "", email: "" };
  }
  if (/landlord|owner|manager|agent|lessor|company/.test(r)) return context?.signers?.landlord || { name: "", email: "" };
  return { name: "", email: "" };
}

// ── Signature slots follow the people on the tenancy ───────────────────
// A template names its signers once ("Tenant", "Co-tenant 2", "Co-tenant
// 3", "Landlord"). A tenancy can have more adults than the template has
// tenant slots -- a prospect may carry four co-applicants -- and the extra
// ones used to be left off the envelope without a word. This adds a slot
// for each of them, at the same signing step as the other tenants, so
// everyone named on the lease is asked to sign. Fewer adults than slots
// needs nothing: an optional slot left empty is skipped at send time.
export const WITNESS_PREFIX = "witness_";
export const isWitnessRole = (role) => String(role || "").toLowerCase().startsWith(WITNESS_PREFIX);
/** "witness_tenant_2" -> "tenant_2": the role this witness signs beside. */
export const witnessedRole = (role) => (isWitnessRole(role) ? String(role).slice(WITNESS_PREFIX.length) : "");
const isTenantRole = (role) => { const r = String(role || "").toLowerCase(); return !isWitnessRole(r) && /tenant|renter|lessee|resident|occupant/.test(r) && !/landlord/.test(r); };
/**
 * @param {Array} roles  the template's signer_roles
 * @param {number} tenantCount  adults on the tenancy
 * @param {{ witnesses?: boolean }} o  witnesses: each signature is witnessed --
 *   every signer gets a witness slot (optional: left blank, no witness is
 *   asked), at the same signing step as the person they witness, so both
 *   can sign together in the room or each by their own link.
 */
export function effectiveSignerRoles(roles, tenantCount = 0, { witnesses = false } = {}) {
  const list = (Array.isArray(roles) ? roles : []).map(r => ({ ...r })).filter(r => !isWitnessRole(r.role));
  const tenantRoles = list.filter(r => isTenantRole(r.role));
  if (tenantRoles.length && tenantCount > tenantRoles.length) {
    const order = tenantRoles[0].order || 1;
    const taken = new Set(list.map(r => r.role));
    for (let n = tenantRoles.length + 1; n <= tenantCount; n++) {
      let role = "tenant_" + n;
      while (taken.has(role)) role += "_";
      taken.add(role);
      list.push({ role, label: "Co-tenant " + n, order, required: false });
    }
  }
  if (!witnesses) return list;
  const out = [];
  for (const r of list) {
    out.push(r);
    out.push({ role: WITNESS_PREFIX + r.role, label: "Witness for " + (r.label || r.role), order: r.order || 1, required: false, witness_of: r.role });
  }
  return out;
}

