// Security deposit RELEASE: one reference scheme and one "already released?"
// rule for every path that takes a deposit off 2100 Security Deposits Held.
// No imports, and the only I/O goes through a client passed in
// (depositReleaseStateWith), so tests load this file in plain node.
//
// Two paths release a held deposit:
//   * the Move-Out wizard (Lifecycle.js)       DR 2100 / CR tenant's own AR
//   * the Leases page "Process Deposit Return"  DR 2100 / CR 1000 Checking
//     (or, when the tenant still owes money and the user chooses it,
//     DR 2100 / CR tenant's own AR -- "apply to balance")
//     and/or DR 2100 / CR 4150 for deductions
// Deleting a property does nothing with deposits (owner decision): voiding the
// property's entries already removes the deposit booking.
//
// REFERENCE SCHEME
//   One key per deposit, derived from the LEASE so every path agrees:
//     T<tenant id>   the first tenant_id found on the lease or up its
//                    renewed_from chain (mirrors the deposit's DEP-T<id>);
//     L<lease id>    otherwise, the ROOT lease of the renewal chain, so a
//                    renewal (a new lease row) cannot release it again.
//   The release claim is DEPRET-<key>; a second leg of the same release
//   (deduction beside a cash return) is DEPDED-<key>. Whichever leg posts
//   first holds DEPRET-<key>, so idx_je_company_reference_unique -- UNIQUE
//   (company_id, reference) WHERE status <> 'voided' AND reference <> '' --
//   refuses any second release from any path. Voiding frees a reference.
//
// PER LEG
//   A release may be two entries. If only one is voided, the other still
//   counts: the state reports what is still held (remaining) and which of the
//   two references is free, so only the voided part can be released again.
//
// LEGACY
//   Releases posted before this scheme carry random references
//   (DEP-TFR-/DEPRET-/DEPDED-/DEPFORF- + 12 hex). They are recognised by
//   prefix on entries at the lease's property dated on/after the lease
//   started: definite when the description names the tenant, otherwise
//   AMBIGUOUS -- treated as released (fail closed) with the reason shown.

export const RELEASED_DEPOSIT_STATUSES = ["returned", "partial_return", "forfeited"];

const hasId = (v) => v !== null && v !== undefined && String(v).trim() !== "" && String(v) !== "undefined" && String(v) !== "null";
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round(num(n) * 100) / 100;

// "T<tid>" | "L<lid>" | null. Tenant wins; never "Tundefined".
export function depositReleaseKey(tenantId, leaseId) {
  if (hasId(tenantId)) return "T" + String(tenantId).trim();
  if (hasId(leaseId)) return "L" + String(leaseId).trim();
  return null;
}
export function depositReleaseReference(tenantId, leaseId) {
  const k = depositReleaseKey(tenantId, leaseId);
  return k ? "DEPRET-" + k : null;
}
export function depositDeductionReference(tenantId, leaseId) {
  const k = depositReleaseKey(tenantId, leaseId);
  return k ? "DEPDED-" + k : null;
}

// Keyed (current-scheme) release reference? T + digits, or L + a lowercase
// uuid. Legacy random suffixes are lowercase hex, so they never match.
const KEYED_RE = /^DEP(?:RET|DED)-(?:T\d+|L[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const isKeyedReleaseRef = (ref) => KEYED_RE.test(String(ref || ""));
const LEGACY_RE = /^(?:DEP-TFR-|DEPRET-|DEPDED-|DEPFORF-)/;
export const isLegacyReleaseRef = (ref) => LEGACY_RE.test(String(ref || "")) && !isKeyedReleaseRef(ref);

// Every keyed reference that means "this deposit was (partly) released": the
// claim and the deduction under each tenant key and each lease key given.
export function depositReleaseReferences(tenantIds, leaseIds) {
  const keys = [];
  for (const t of [].concat(tenantIds ?? [])) if (hasId(t)) keys.push("T" + String(t).trim());
  for (const l of [].concat(leaseIds ?? [])) if (hasId(l)) keys.push("L" + String(l).trim());
  const refs = [];
  for (const k of keys) refs.push("DEPRET-" + k, "DEPDED-" + k);
  return [...new Set(refs)];
}

// The canonical key for a lease, given its renewal chain ordered from this
// lease back to the root: first tenant_id on the way, else the root's id.
export function chainReleaseKey(chainToRoot) {
  const chain = (chainToRoot || []).filter(Boolean);
  if (!chain.length) return { tenantId: null, leaseId: null };
  const withTenant = chain.find(l => hasId(l.tenant_id));
  if (withTenant) return { tenantId: withTenant.tenant_id, leaseId: null };
  return { tenantId: null, leaseId: chain[chain.length - 1].id };
}

// Legacy release entries (random refs) at the lease's property: which are
// this tenancy's. entries: { reference, date, description }.
export function classifyLegacyReleases(entries, { names = [], since = null } = {}) {
  const lower = names.filter(n => n && String(n).trim().length >= 2).map(n => String(n).trim().toLowerCase());
  const definite = [], ambiguous = [];
  for (const e of entries || []) {
    if (!e || !isLegacyReleaseRef(e.reference)) continue;
    if (since && e.date && String(e.date) < String(since)) continue; // an earlier tenancy
    const d = String(e.description || "").toLowerCase();
    if (lower.some(n => d.includes(n))) definite.push(e); else ambiguous.push(e);
  }
  return { definite, ambiguous };
}

// The rule. Returns { released, partial, remaining, liveAmount,
// freeReferences, reason, reference }.
//   deposit:            the lease's security_deposit
//   entries:            keyed release entries found ({ reference, status, amount })
//   claimReference / deductionReference: this deposit's canonical references
//   legacyDefinite / legacyAmbiguous: from classifyLegacyReleases
//   legacyMoveOutCredit: live "Deposit credit" line on the tenant's own AR
//   depositStatuses:    deposit_status of the lease and its renewal chain
// Order:
//   1. legacy evidence (definite, move-out credit, or ambiguous) -> released
//   1b. the deposit's own DEP-T booking exists only voided -> released
//       (nothing is held)
//   2. live keyed entries: released if they cover the deposit, or if no
//      canonical reference is free; else PARTIAL with the remainder
//   3. only voided keyed entries -> not released (a released-looking status
//      was left by the voided release) -- legacy was already ruled out in 1
//   4. a released deposit_status -> released (older release we can't see)
//   5. otherwise not released
export function decideDepositRelease({ deposit = 0, entries = [], claimReference = null, deductionReference = null,
  legacyDefinite = [], legacyAmbiguous = [], legacyMoveOutCredit = false, depositStatuses = [], depositStatus = null, depositBookings = [] } = {}) {
  const dep = round2(deposit);
  const both = [claimReference, deductionReference].filter(Boolean);
  const out = (o) => ({ released: false, partial: false, remaining: dep, liveAmount: 0, freeReferences: both, reason: null, reference: null, ...o });
  const statuses = [...(depositStatuses || []), depositStatus].filter(Boolean);
  if (legacyDefinite.length) {
    const e = legacyDefinite[0];
    return out({ released: true, remaining: 0, freeReferences: [], reference: e.reference, reason: "an earlier release is on the books (" + e.reference + (e.date ? ", " + e.date : "") + ")" });
  }
  if (legacyMoveOutCredit) return out({ released: true, remaining: 0, freeReferences: [], reason: "the deposit was already credited to the tenant's ledger at move-out" });
  if (legacyAmbiguous.length) {
    const e = legacyAmbiguous[0];
    return out({ released: true, remaining: 0, freeReferences: [], reference: e.reference, reason: "an older deposit release at this property (" + e.reference + (e.date ? ", " + e.date : "") + ") may be this tenant's and cannot be told apart, so it is treated as released -- void it or release manually if it belongs to someone else" });
  }
  // The deposit's own booking (DEP-T<tenant id>) exists but every copy is
  // voided -- e.g. the property was deleted, which voids its entries. There
  // is nothing in 2100 to release; releasing anyway drives 2100 negative.
  const bookings = (depositBookings || []).filter(Boolean);
  if (bookings.length && bookings.every(b => b.status === "voided")) {
    return out({ released: true, remaining: 0, freeReferences: [], reference: bookings[0].reference, reason: "the deposit's own booking (" + bookings[0].reference + ") was voided, so nothing is held to release" });
  }
  const live = (entries || []).filter(e => e && e.status !== "voided");
  if (live.length) {
    const liveAmount = round2(live.reduce((s, e) => s + num(e.amount), 0));
    const remaining = round2(dep - liveAmount);
    const refs = live.map(e => e.reference).join(", ");
    if (remaining <= 0.005) return out({ released: true, remaining: 0, liveAmount, freeReferences: [], reference: live[0].reference, reason: "a release is already on the books (" + refs + ")" });
    const free = both.filter(r => !live.some(e => e.reference === r));
    if (!free.length) return out({ released: true, remaining, liveAmount, freeReferences: [], reference: live[0].reference, reason: "$" + liveAmount.toFixed(2) + " was already released (" + refs + ") and both release references are in use; post the remaining $" + remaining.toFixed(2) + " manually" });
    return out({ partial: true, remaining, liveAmount, freeReferences: free, reference: live[0].reference, reason: "$" + liveAmount.toFixed(2) + " of $" + dep.toFixed(2) + " was already released (" + refs + "); $" + remaining.toFixed(2) + " is still held" });
  }
  if ((entries || []).some(e => e && e.status === "voided")) return out({});
  const st = statuses.find(s => RELEASED_DEPOSIT_STATUSES.includes(s));
  if (st) return out({ released: true, remaining: 0, freeReferences: [], reason: "the lease's deposit is already marked " + String(st).replace("_", " ") });
  return out({});
}

// A deduction/forfeiture leg (DR 2100 / CR 4150), as opposed to money going
// back to the tenant (cash, or credit on their ledger).
export const isDeductionEntry = (e) => /^Deposit (deduction|forfeit)/i.test(String(e?.description || ""));

// Should the Leases page offer "Return Deposit" for this lease? entries are
// the company's keyed release entries ({ reference, status, amount }),
// fetched once for the list. Chain-level and legacy checks happen on click.
export function depositReturnOfferable(lease, entries = []) {
  if (!lease) return false;
  const refs = new Set(depositReleaseReferences([lease.tenant_id], [lease.id, lease.renewed_from]));
  const mine = (entries || []).filter(e => e && refs.has(e.reference));
  const live = mine.filter(e => e.status !== "voided");
  if (live.length) {
    const liveAmount = live.reduce((s, e) => s + num(e.amount), 0);
    const claim = depositReleaseReference(lease.tenant_id, lease.id), ded = depositDeductionReference(lease.tenant_id, lease.id);
    const someFree = [claim, ded].some(r => !live.some(e => e.reference === r));
    return liveAmount < num(lease.security_deposit) - 0.005 && someFree;
  }
  if (lease.deposit_status === "held") return true;
  return mine.length > 0 && RELEASED_DEPOSIT_STATUSES.includes(lease.deposit_status);
}

// Plan the entries for a Leases-page release of `returned` (to the tenant,
// cash or applied to their balance) and `deducted` (forfeiture) against the
// free references. Returns { legs: [{ kind, amount, reference }] } or
// { error }. The first leg always takes the claim when it is free.
export function planReleaseLegs({ returned = 0, deducted = 0, freeReferences = [] } = {}) {
  const legs = [];
  if (num(returned) > 0) legs.push({ kind: "return", amount: round2(returned) });
  if (num(deducted) > 0) legs.push({ kind: "deduction", amount: round2(deducted) });
  if (!legs.length) return { error: "nothing to release" };
  const free = (freeReferences || []).filter(Boolean);
  if (legs.length > free.length) return { error: "only one part of this deposit can be released now (one release reference is still in use) -- release the remainder as a single return or a single deduction" };
  legs.forEach((l, i) => { l.reference = free[i]; });
  return { legs };
}

// Final deposit_status once a release completes. priorReturned: amount that
// earlier (still live) legs returned to the tenant; returnedNow likewise.
export function releasedDepositStatus({ deposit, priorReturned = 0, returnedNow = 0 }) {
  const toTenant = num(priorReturned) + num(returnedNow);
  if (toTenant >= num(deposit) - 0.005) return "returned";
  return toTenant > 0 ? "partial_return" : "forfeited";
}

// Read-only check against the database. Returns the decideDepositRelease
// result plus { claimReference, deductionReference, keyTenantId, keyLeaseId,
// chainLeaseIds, error }. Fails CLOSED: any lookup error comes back as
// released with the error, so a network blip can never let a second release
// through -- callers refuse and show it.
export async function depositReleaseStateWith(client, companyId, { tenantId = null, leaseId = null, deposit = null } = {}) {
  const closed = (msg) => ({ released: true, partial: false, remaining: 0, liveAmount: 0, liveReturned: 0, freeReferences: [], reference: null,
    reason: "could not check whether the deposit was already released (" + msg + ")", error: msg,
    claimReference: null, deductionReference: null, keyTenantId: null, keyLeaseId: null, chainLeaseIds: [] });
  if (!client || !companyId) return closed("missing company");
  try {
    const cols = "id, tenant_id, tenant_name, property, start_date, security_deposit, deposit_status, renewed_from";
    // Renewal chain, both directions (capped).
    const byId = new Map(), expanded = new Set(), tried = new Set();
    const add = (rows) => { for (const r of rows || []) if (!byId.has(String(r.id))) byId.set(String(r.id), r); };
    let need = hasId(leaseId) ? [String(leaseId)] : [];
    for (let i = 0; i < 20; i++) {
      if (need.length) {
        need.forEach(id => tried.add(id));
        const { data: rows, error } = await client.from("leases").select(cols).eq("company_id", companyId).in("id", need);
        if (error) return closed(error.message || "lease lookup failed");
        add(rows);
      }
      const expand = [...byId.keys()].filter(id => !expanded.has(id));
      if (expand.length) {
        const { data: kids, error: kErr } = await client.from("leases").select(cols).eq("company_id", companyId).in("renewed_from", expand);
        if (kErr) return closed(kErr.message || "renewal lookup failed");
        expand.forEach(id => expanded.add(id));
        add(kids);
      }
      need = [...new Set([...byId.values()].map(r => r.renewed_from).filter(hasId).map(String).filter(id => !byId.has(id) && !tried.has(id)))];
      if (!need.length && [...byId.keys()].every(id => expanded.has(id))) break;
    }
    const lease = hasId(leaseId) ? byId.get(String(leaseId)) : null;
    const toRoot = [];
    for (let cur = lease, i = 0; cur && i < 50; i++) { toRoot.push(cur); cur = hasId(cur.renewed_from) ? byId.get(String(cur.renewed_from)) : null; }
    const chain = [...byId.values()];
    const key = lease ? chainReleaseKey(toRoot) : { tenantId: hasId(tenantId) ? tenantId : null, leaseId: null };
    const claimReference = depositReleaseReference(key.tenantId, key.leaseId);
    const deductionReference = depositDeductionReference(key.tenantId, key.leaseId);
    const tenantIds = [...new Set([tenantId, ...chain.map(l => l.tenant_id)].filter(hasId).map(String))];
    const refs = depositReleaseReferences(tenantIds, chain.map(l => l.id));

    let entries = [];
    if (refs.length) {
      const { data, error } = await client.from("acct_journal_entries").select("reference, status, description, acct_journal_lines(debit)")
        .eq("company_id", companyId).in("reference", refs);
      if (error) return closed(error.message || "journal lookup failed");
      entries = (data || []).map(e => ({ reference: e.reference, status: e.status, description: e.description,
        amount: (e.acct_journal_lines || []).reduce((s, l) => s + num(l.debit), 0) }));
    }

    // Legacy random-reference releases at the lease's property.
    let legacy = { definite: [], ambiguous: [] };
    const props = [...new Set(chain.map(l => l.property).filter(Boolean))];
    if (props.length) {
      const { data, error } = await client.from("acct_journal_entries").select("reference, status, date, description")
        .eq("company_id", companyId).in("property", props).neq("status", "voided")
        .or("reference.like.DEP-TFR-%,reference.like.DEPRET-%,reference.like.DEPDED-%,reference.like.DEPFORF-%");
      if (error) return closed(error.message || "legacy release lookup failed");
      const starts = chain.map(l => l.start_date).filter(Boolean).sort();
      legacy = classifyLegacyReleases(data || [], { names: chain.map(l => l.tenant_name), since: starts[0] || null });
    }

    // The deposit's own booking under the tenant key(s): DEP-T<id> and the
    // wizard's older DEP-T<id>-<date>.
    let depositBookings = [];
    if (tenantIds.length) {
      const ors = tenantIds.flatMap(t => ["reference.eq.DEP-T" + t, "reference.like.DEP-T" + t + "-%"]).join(",");
      const { data, error } = await client.from("acct_journal_entries").select("reference, status")
        .eq("company_id", companyId).or(ors);
      if (error) return closed(error.message || "deposit booking lookup failed");
      depositBookings = data || [];
    }

    let legacyMoveOutCredit = false;
    if (tenantIds.length) {
      const { data: accts, error: aErr } = await client.from("acct_accounts").select("id")
        .eq("company_id", companyId).eq("type", "Asset").in("tenant_id", tenantIds);
      if (aErr) return closed(aErr.message || "AR lookup failed");
      const ids = (accts || []).map(a => a.id);
      if (ids.length) {
        const { data: lines, error: lErr } = await client.from("acct_journal_lines")
          .select("id, acct_journal_entries!inner(status, reference)")
          .eq("company_id", companyId).in("account_id", ids).gt("credit", 0)
          .ilike("memo", "Deposit credit%").neq("acct_journal_entries.status", "voided").limit(50);
        if (lErr) return closed(lErr.message || "AR line lookup failed");
        // Only credits under a LEGACY reference; keyed ones are in `entries`.
        legacyMoveOutCredit = (lines || []).some(l => !isKeyedReleaseRef(l.acct_journal_entries?.reference));
      }
    }

    const dep = deposit !== null && deposit !== undefined ? num(deposit) : num(lease?.security_deposit);
    return {
      ...decideDepositRelease({ deposit: dep, entries, claimReference, deductionReference,
        legacyDefinite: legacy.definite, legacyAmbiguous: legacy.ambiguous, legacyMoveOutCredit,
        depositStatuses: chain.map(l => l.deposit_status), depositBookings }),
      // What the live legs gave back to the tenant (cash or credit), as opposed
      // to deductions -- lets a re-release of a voided leg set the status right.
      liveReturned: round2(entries.filter(e => e.status !== "voided" && !isDeductionEntry(e)).reduce((s, e) => s + num(e.amount), 0)),
      claimReference, deductionReference, keyTenantId: key.tenantId, keyLeaseId: key.leaseId,
      chainLeaseIds: chain.map(l => l.id), error: null,
    };
  } catch (e) {
    return closed(e?.message || String(e));
  }
}
