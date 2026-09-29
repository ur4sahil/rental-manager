// Security deposit RELEASE: one reference scheme and one "already released?"
// rule for every path that takes a deposit off 2100 Security Deposits Held.
// No imports, and the only I/O goes through a client passed in
// (depositReleaseStateWith), so tests load this file in plain node.
//
// Three paths release a held deposit:
//   * the Move-Out wizard (Lifecycle.js)      DR 2100 / CR tenant's own AR
//   * the Leases page "Process Deposit Return" DR 2100 / CR 1000 Checking
//                                              and/or DR 2100 / CR 4150
//   * deleting a property (Properties.js)     DR 2100 / CR 4150
// Each used a RANDOM reference (DEP-TFR-/DEPRET-/DEPDED-/DEPFORF- + shortId)
// and only the Leases page looked at leases.deposit_status -- which move-out
// never set. Move a tenant out, then press "Process Deposit Return", and the
// same deposit left 2100 twice.
//
// REFERENCE SCHEME
//   The release "claim" is DEPRET-T<tenant id> -- the mirror of the deposit's
//   own DEP-T<tenant id> (depositReference in accounting.js): one deposit per
//   tenant is ever auto-posted, so one release per tenant. Keyed on the
//   tenant rather than the lease because a renewal copies security_deposit
//   onto a NEW lease row; a per-lease key would let each row of a renewal
//   chain release the same money once more. DEPRET-L<lease id> is used only
//   when the lease row carries no tenant id (legacy leases).
//
//   Whichever journal entry a release posts FIRST carries the claim, so
//   idx_je_company_reference_unique -- UNIQUE (company_id, reference) WHERE
//   status <> 'voided' AND reference <> '' -- refuses any second release from
//   any path, including ones written later. The Leases page's second entry
//   of a split return (the deduction, when some cash was also returned) is
//   DEPDED-<same key>. Voiding the claim frees it, so a genuine re-release
//   after a void is allowed.

export const RELEASED_DEPOSIT_STATUSES = ["returned", "partial_return", "forfeited"];

const hasId = (v) => v !== null && v !== undefined && String(v).trim() !== "" && String(v) !== "undefined" && String(v) !== "null";

// "T<tid>" | "L<lid>" | null. Tenant wins; never "Tundefined".
export function depositReleaseKey(tenantId, leaseId) {
  if (hasId(tenantId)) return "T" + String(tenantId).trim();
  if (hasId(leaseId)) return "L" + String(leaseId).trim();
  return null;
}

// The claim reference every release path posts its first entry under.
export function depositReleaseReference(tenantId, leaseId) {
  const k = depositReleaseKey(tenantId, leaseId);
  return k ? "DEPRET-" + k : null;
}

// The Leases page's deduction entry when a return entry already holds the claim.
export function depositDeductionReference(tenantId, leaseId) {
  const k = depositReleaseKey(tenantId, leaseId);
  return k ? "DEPDED-" + k : null;
}

// Every reference that means "this deposit was released": the claim and the
// deduction under the tenant key(s) and under the lease key. Checked all
// together so a release keyed one way is seen from a path keyed the other.
export function depositReleaseReferences(tenantIds, leaseId) {
  const keys = [];
  for (const t of [].concat(tenantIds ?? [])) if (hasId(t)) keys.push("T" + String(t).trim());
  if (hasId(leaseId)) keys.push("L" + String(leaseId).trim());
  const refs = [];
  for (const k of keys) refs.push("DEPRET-" + k, "DEPDED-" + k);
  return [...new Set(refs)];
}

// The rule. entries: journal entries found under depositReleaseReferences
// ({ reference, status }). legacyMoveOutCredit: a non-voided "Deposit credit"
// line on the tenant's own AR (how move-outs before this change released,
// under a random DEP-TFR- reference nothing else can recognise).
//   1. a live (non-voided) release entry          -> released
//   2. a live legacy move-out credit              -> released
//   3. only VOIDED release entries                -> NOT released: the release
//      was reversed, so a deposit_status left at returned/forfeited is stale
//   4. deposit_status returned/partial/forfeited  -> released (legacy Leases
//      page returns, whose random references cannot be recognised)
//   5. otherwise                                  -> not released
export function decideDepositRelease({ entries = [], legacyMoveOutCredit = false, depositStatus = null } = {}) {
  const live = (entries || []).find(e => e && e.status !== "voided");
  if (live) return { released: true, reason: "a release is already on the books (" + live.reference + ")", reference: live.reference };
  if (legacyMoveOutCredit) return { released: true, reason: "the deposit was already credited to the tenant's ledger at move-out", reference: null };
  const voided = (entries || []).some(e => e && e.status === "voided");
  if (voided) return { released: false, reason: null, reference: null };
  if (RELEASED_DEPOSIT_STATUSES.includes(depositStatus)) {
    return { released: true, reason: "the lease's deposit is already marked " + String(depositStatus).replace("_", " "), reference: null };
  }
  return { released: false, reason: null, reference: null };
}

// Should the Leases page offer "Return Deposit" for this lease? entries are
// the company's release journal entries ({ reference, status }), fetched once
// for the list. Not offered when a live release exists under this lease's
// tenant or lease key (e.g. released at move-out). Offered when the deposit is
// "held", or when its only release was voided (the status left behind by a
// voided release is stale). The click re-checks with depositReleaseStateWith.
export function depositReturnOfferable(lease, entries = []) {
  if (!lease) return false;
  const refs = new Set(depositReleaseReferences([lease.tenant_id], lease.id));
  const mine = (entries || []).filter(e => e && refs.has(e.reference));
  if (mine.some(e => e.status !== "voided")) return false;
  if (lease.deposit_status === "held") return true;
  return mine.length > 0 && RELEASED_DEPOSIT_STATUSES.includes(lease.deposit_status);
}

// Read-only check against the database. Returns { released, reason,
// reference, error }. Fails CLOSED: any lookup error comes back as
// { released: true, error } so a network blip can never let a second
// release through -- callers refuse and show the error.
export async function depositReleaseStateWith(client, companyId, { tenantId = null, leaseId = null } = {}) {
  const closed = (msg) => ({ released: true, reason: "could not check whether the deposit was already released (" + msg + ")", reference: null, error: msg });
  if (!client || !companyId) return closed("missing company");
  try {
    let depositStatus = null;
    const tenantIds = [];
    if (hasId(tenantId)) tenantIds.push(tenantId);
    if (hasId(leaseId)) {
      const { data: lease, error } = await client.from("leases").select("deposit_status, tenant_id")
        .eq("company_id", companyId).eq("id", leaseId).maybeSingle();
      if (error) return closed(error.message || "lease lookup failed");
      depositStatus = lease?.deposit_status ?? null;
      if (hasId(lease?.tenant_id) && !tenantIds.map(String).includes(String(lease.tenant_id))) tenantIds.push(lease.tenant_id);
    }
    const refs = depositReleaseReferences(tenantIds, leaseId);
    let entries = [];
    if (refs.length) {
      const { data, error } = await client.from("acct_journal_entries").select("reference, status")
        .eq("company_id", companyId).in("reference", refs);
      if (error) return closed(error.message || "journal lookup failed");
      entries = data || [];
    }
    let legacyMoveOutCredit = false;
    if (tenantIds.length && !entries.some(e => e.status !== "voided")) {
      const { data: accts, error: aErr } = await client.from("acct_accounts").select("id")
        .eq("company_id", companyId).eq("type", "Asset").in("tenant_id", tenantIds);
      if (aErr) return closed(aErr.message || "AR lookup failed");
      const ids = (accts || []).map(a => a.id);
      if (ids.length) {
        const { data: lines, error: lErr } = await client.from("acct_journal_lines")
          .select("id, acct_journal_entries!inner(status)")
          .eq("company_id", companyId).in("account_id", ids).gt("credit", 0)
          .ilike("memo", "Deposit credit%").neq("acct_journal_entries.status", "voided").limit(1);
        if (lErr) return closed(lErr.message || "AR line lookup failed");
        legacyMoveOutCredit = (lines || []).length > 0;
      }
    }
    return { ...decideDepositRelease({ entries, legacyMoveOutCredit, depositStatus }), error: null };
  } catch (e) {
    return closed(e?.message || String(e));
  }
}
