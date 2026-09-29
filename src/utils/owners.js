// Linking properties to owner records.
//
// properties.owner_id is what everything that matters keys on -- owner
// statements, the owner portal (RLS policy properties_owner), the fee accrual
// on each rent receipt -- but the app only ever wrote properties.owner_name,
// free text, so no property was ever linked. Every write of a property's
// owner goes through assignPropertyOwner: it writes owner_id and DERIVES
// owner_name from the owner record (a display copy, kept for readers that
// still show text).
import { supabase } from "../supabase";
import { findOwnerByName, drainOwnerAccruals } from "./ownerRules";
import { fetchAllPaged, autoOwnerDistribution } from "./accounting";

// Set (ownerId) or clear (null) a property's owner. Returns { ok, error, owner }.
export async function assignPropertyOwner(companyId, propertyId, ownerId) {
  if (!companyId || propertyId === null || propertyId === undefined || propertyId === "") return { ok: false, error: "missing company or property" };
  let owner = null;
  if (ownerId) {
    const { data, error } = await supabase.from("owners").select("id, name")
      .eq("company_id", companyId).eq("id", ownerId).is("archived_at", null).maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: "owner not found in this company" };
    owner = data;
  }
  const { error: upErr } = await supabase.from("properties")
    .update({ owner_id: owner ? owner.id : null, owner_name: owner ? owner.name : "" })
    .eq("company_id", companyId).eq("id", propertyId);
  if (upErr) return { ok: false, error: upErr.message };
  return { ok: true, owner };
}

// A new owner record from a name. Email is null (owners.email is UNIQUE, and
// an empty string would collide); the fee is null = "not set" until staff set
// it on the Owners page.
export async function createOwner(companyId, { name, management_fee_pct = null, email = null } = {}) {
  const n = String(name || "").trim().replace(/\s+/g, " ");
  if (!companyId || !n) return { error: "owner name is required" };
  const { data, error } = await supabase.from("owners").insert([{
    company_id: companyId, name: n, email: email ? String(email).trim().toLowerCase() : null,
    management_fee_pct, status: "active",
  }]).select("*").maybeSingle();
  if (error) return { error: error.message };
  return { owner: data };
}

// For the bulk import: the owner record a typed name refers to, created when
// none exists. `owners` is the caller's list and is appended to, so one run
// creates each new owner once. An ambiguous name (two active owners with it)
// is an error, never a guess.
export async function findOrCreateOwnerByName(companyId, name, owners) {
  const n = String(name || "").trim();
  if (!n) return { owner: null };
  const hit = findOwnerByName(owners, n);
  if (hit) return { owner: hit };
  const lower = n.toLowerCase().replace(/\s+/g, " ");
  if ((owners || []).some(o => !o.archived_at && String(o.name || "").trim().toLowerCase().replace(/\s+/g, " ") === lower)) {
    return { error: `more than one owner is named "${n}" — pick one on the property page` };
  }
  const { owner, error } = await createOwner(companyId, { name: n });
  if (error) return { error };
  owners.push(owner);
  return { owner, created: true };
}

// Everything an owner statement needs, for the owner AT THE TIME (owner
// decision 8): the properties the owner owned during [startDate, endDate]
// come from property_owner_history, each clipped to the owner's own dates, so
// a property reassigned mid-month gives the old owner the rent billed before
// the change and the new owner the rent billed after. For each such property
// and date range: posted GL lines matched by the property's class, or -- only
// for lines with no class -- by the entry's property text. Plus the chart of
// accounts, and the owner's own accrual and payout rows (stamped owner_id).
// Every query is paged (fetchAllPaged): no 1000-row ceiling.
export async function loadOwnerStatementData(companyId, ownerId, startDate, endDate) {
  const SEL = "id, journal_entry_id, account_id, debit, credit, memo, class_id, acct_journal_entries!inner(date, created_at, reference, description, status, property)";
  const h = await fetchAllPaged(() => supabase.from("property_owner_history")
    .select("id, property_id, from_date, to_date, created_at, closed_at, properties(id, address, class_id, short_name)")
    .eq("company_id", companyId).eq("owner_id", ownerId).order("id"), "owner history");
  if (h.failed) return { failed: true };
  // Same rule as the SQL allocation (owner_for_charge): an entry dated on a
  // day the owner held the property is theirs; an entry dated BEFORE the
  // property's first link is theirs if it was POSTED while their link was
  // current (created_at .. closed_at).
  const propIds = [...new Set(h.rows.map(r => r.property_id))];
  const firstFrom = new Map();   // property -> earliest from_date ("" = from the start)
  for (let i = 0; i < propIds.length; i += 100) {
    const f = await fetchAllPaged(() => supabase.from("property_owner_history").select("id, property_id, from_date")
      .in("property_id", propIds.slice(i, i + 100)).order("id"), "owner history (first link)");
    if (f.failed) return { failed: true };
    for (const r of f.rows) {
      const key = r.from_date === null ? "" : r.from_date;
      if (!firstFrom.has(r.property_id) || key < firstFrom.get(r.property_id)) firstFrom.set(r.property_id, key);
    }
  }
  const dayBefore = (d) => { const x = new Date(d + "T12:00:00"); x.setDate(x.getDate() - 1); return x.toISOString().slice(0, 10); };
  const ranges = [];
  for (const r of h.rows) {
    const p = Array.isArray(r.properties) ? r.properties[0] : r.properties;
    if (!p) continue;
    // the owner's own dates
    const from = r.from_date && r.from_date > startDate ? r.from_date : startDate;
    const to = r.to_date ? (dayBefore(r.to_date) < endDate ? dayBefore(r.to_date) : endDate) : endDate;
    if (from <= to && (!r.to_date || r.from_date === null || r.from_date < r.to_date)) ranges.push({ prop: p, from, to, postedFrom: null, postedTo: null });
    // entries dated before the property's first link, posted while this link was current
    const ff = firstFrom.get(r.property_id);
    if (ff) {
      const pto = dayBefore(ff) < endDate ? dayBefore(ff) : endDate;
      if (startDate <= pto) ranges.push({ prop: p, from: startDate, to: pto, postedFrom: r.created_at, postedTo: r.closed_at || null });
    }
  }
  const lines = [];
  const seenLine = new Set();
  for (const { prop, from, to, postedFrom, postedTo } of ranges) {
    // A builder, only ever read through fetchAllPaged below (no row cap).
    const base = () => supabase.from("acct_journal_lines").select(SEL).eq("company_id", companyId)
      .eq("acct_journal_entries.status", "posted")
      .gte("acct_journal_entries.date", from).lte("acct_journal_entries.date", to);
    const keep = (l) => {
      if (seenLine.has(l.id)) return false;
      if (postedFrom) {
        const je = Array.isArray(l.acct_journal_entries) ? l.acct_journal_entries[0] : l.acct_journal_entries;
        const at = new Date(je?.created_at || 0).getTime();
        if (!(at >= new Date(postedFrom).getTime() && (!postedTo || at < new Date(postedTo).getTime()))) return false;
      }
      seenLine.add(l.id);
      return true;
    };
    if (prop.class_id) {
      const r = await fetchAllPaged(() => base().eq("class_id", prop.class_id).order("id"), "owner statement lines (class)");
      if (r.failed) return { failed: true };
      lines.push(...r.rows.filter(keep));
    }
    const r2 = await fetchAllPaged(() => base().is("class_id", null).eq("acct_journal_entries.property", prop.address).order("id"), "owner statement lines (property text)");
    if (r2.failed) return { failed: true };
    lines.push(...r2.rows.filter(keep));
  }
  const a = await fetchAllPaged(() => supabase.from("acct_accounts").select("id, code, name, type").eq("company_id", companyId).order("id"), "owner statement accounts");
  if (a.failed) return { failed: true };
  const d = await fetchAllPaged(() => supabase.from("owner_distributions")
    .select("id, kind, amount, rent_amount, date, charge_je_id, charge_month, voided_at, method, notes, reference, property_id, reverses_id")
    .eq("company_id", companyId).eq("owner_id", ownerId).order("id"), "owner distributions");
  if (d.failed) return { failed: true };
  const props = [...new Map(ranges.map(x => [x.prop.id, x.prop])).values()];
  return {
    failed: false, props, ranges, lines, accounts: a.rows,
    accruals: d.rows.filter(x => x.kind === "accrual"),
    payouts: d.rows.filter(x => x.kind === "payout"),
  };
}

// Correct the owner of a property FROM a date (management tier only; the
// database enforces it). For a wrong owner pick: rewrites the ownership
// history from `fromDate` (null = from the start) and re-stamps that
// property's owner accruals -- voided and re-posted, or reversed after a
// period lock. Returns { ok, error, result }.
export async function correctPropertyOwner(companyId, propertyId, ownerId, fromDate) {
  const { data, error } = await supabase.rpc("correct_property_owner", {
    p_company_id: companyId, p_property_id: Number(propertyId), p_owner_id: ownerId, p_from: fromDate || null,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, result: data };
}

// Bring owner accruals that could not be synced at the time (a lock-wait
// timeout, an error, a bulk write past its commit budget -- recorded as
// NEEDS_SYNC markers) up to date, batch by batch until none remain.
export async function syncPendingOwnerAccruals(companyId) {
  if (!companyId) return { error: "missing company" };
  return drainOwnerAccruals(supabase, companyId);
}

// A bank deposit categorised on the Banking page (post_bank_transaction
// 'add' / 'split') to a tenant's own AR account is a rent receipt too: bring
// that tenant's owner accruals up to date (owner_accrual_sync, the same SQL
// as every other receipt path; a trigger also runs it on commit). `lines` are
// the deposit's credit legs, [{ accountId, amount }].
export async function accrueOwnerShareForBankDeposit(companyId, { date, lines }) {
  const legs = (lines || []).filter(l => l && l.accountId && Number(l.amount) > 0);
  if (!companyId || !legs.length) return [];
  const ids = [...new Set(legs.map(l => String(l.accountId)))].slice(0, 100);
  const { data: accts, error } = await supabase.from("acct_accounts").select("id, tenant_id")
    .eq("company_id", companyId).in("id", ids).not("tenant_id", "is", null);
  if (error || !accts || !accts.length) return [];
  const tenants = [...new Set(accts.map(a => String(a.tenant_id)))];
  const out = [];
  for (const tid of tenants) out.push(await autoOwnerDistribution(companyId, null, null, date, null, tid));
  return out;
}
