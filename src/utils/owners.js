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
import { findOwnerByName } from "./ownerRules";
import { fetchAllPaged } from "./accounting";

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

// The owner's slice of the GENERAL LEDGER for a statement period: posted
// lines on the owner's properties -- matched by the property's accounting
// class, and, only for lines that carry no class, by the entry's property
// text -- plus the chart of accounts to classify them. Every query is paged
// (fetchAllPaged), so a busy portfolio is never cut off at 1000 rows.
// buildOwnerStatement (utils/ownerRules.js) turns this into the statement.
export async function loadOwnerLedger(companyId, ownerProps, startDate, endDate) {
  const SEL = "id, account_id, debit, credit, memo, class_id, acct_journal_entries!inner(date, reference, description, status, property)";
  const classIds = [...new Set((ownerProps || []).map(p => p.class_id).filter(Boolean))];
  const addrs = [...new Set((ownerProps || []).map(p => p.address).filter(Boolean))];
  const base = () => supabase.from("acct_journal_lines").select(SEL).eq("company_id", companyId)
    .eq("acct_journal_entries.status", "posted")
    .gte("acct_journal_entries.date", startDate).lte("acct_journal_entries.date", endDate);
  const lines = [];
  for (let i = 0; i < classIds.length; i += 100) {
    const chunk = classIds.slice(i, i + 100);
    const r = await fetchAllPaged(() => base().in("class_id", chunk).order("id"), "owner statement lines (class)");
    if (r.failed) return { failed: true };
    lines.push(...r.rows);
  }
  for (let i = 0; i < addrs.length; i += 50) {
    const chunk = addrs.slice(i, i + 50);
    const r = await fetchAllPaged(() => base().is("class_id", null).in("acct_journal_entries.property", chunk).order("id"), "owner statement lines (property text)");
    if (r.failed) return { failed: true };
    lines.push(...r.rows);
  }
  const a = await fetchAllPaged(() => supabase.from("acct_accounts").select("id, code, name, type").eq("company_id", companyId).order("id"), "owner statement accounts");
  if (a.failed) return { failed: true };
  return { failed: false, lines, accounts: a.rows };
}

