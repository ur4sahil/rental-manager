import { supabase } from "../supabase";
import { safeNum, parseLocalDate, formatLocalDate, shortId, pickColor, escapeFilterValue } from "./helpers";
import { pmError } from "./errors";
import { logAudit } from "./audit";
import { queueNotification } from "./notifications";

// Safely insert a ledger entry. The running balance is computed
// server-side inside the same DB transaction as the insert via
// insert_ledger_entry_with_balance — this replaces the previous
// client-side read-then-insert pattern that (a) raced under concurrent
// writes and (b) silently set balance=0 on every fallback row because
// the lookup query filtered on ledger_entries.archived_at (a column
// that doesn't exist in this schema — the query always errored and the
// catch block swallowed it). An explicit non-zero balance passed by
// the caller is honored as before; otherwise the RPC computes it.
export async function safeLedgerInsert(entry) {
  const useRpc = !(entry.balance && entry.balance !== 0);
  if (useRpc) {
    const { data, error } = await supabase.rpc("insert_ledger_entry_with_balance", {
      p_company_id: entry.company_id,
      p_tenant: entry.tenant || null,
      p_tenant_id: entry.tenant_id || null,
      p_property: entry.property || null,
      p_date: entry.date || null,
      p_description: entry.description || null,
      p_amount: safeNum(entry.amount),
      p_type: entry.type || null,
    });
    if (error) {
      // If the RPC isn't deployed yet, fall through to the direct insert
      // with balance=0 so we don't drop the audit row. Otherwise surface.
      const notDeployed = error.message?.includes("insert_ledger_entry_with_balance") && error.message?.includes("Could not find the function");
      if (!notDeployed) {
        pmError("PM-6005", { raw: error, context: "ledger entry insert via RPC", silent: true, meta: { type: entry.type, tenant_id: entry.tenant_id } });
        return false;
      }
      pmError("PM-6005", { raw: error, context: "ledger RPC missing — direct insert with balance=0", silent: true });
    } else {
      return !!data;
    }
  }
  const { error } = await supabase.from("ledger_entries").insert([{ ...entry, balance: safeNum(entry.balance) }]);
  if (error) {
    pmError("PM-6005", { raw: error, context: "ledger entry insert", silent: true, meta: { type: entry.type, tenant_id: entry.tenant_id } });
  }
  return !error;
}

// Atomic JE + ledger + balance in a single DB transaction via RPC
// Falls back to non-atomic postAccountingTransaction if RPC unavailable
export async function atomicPostJEAndLedger({ date, description, reference, property, lines, status, ledgerEntry, balanceUpdate, companyId }) {
  const result = { jeId: null, ledgerOk: false, balanceOk: false, error: null };
  try {
    const rpcLines = (lines || []).map(l => ({
      account_id: l.account_id, account_name: l.account_name || "",
      debit: safeNum(l.debit), credit: safeNum(l.credit),
      class_id: l.class_id || null, memo: l.memo || ""
    }));
    const { data: jeId, error: rpcErr } = await supabase.rpc("post_je_and_ledger", {
      p_company_id: companyId,
      p_date: date,
      p_description: description,
      p_reference: reference || "",
      p_property: property || "",
      p_status: status || "posted",
      p_lines: rpcLines,
      p_ledger_tenant: ledgerEntry?.tenant || null,
      p_ledger_tenant_id: ledgerEntry?.tenant_id || null,
      p_ledger_property: ledgerEntry?.property || property || null,
      p_ledger_amount: safeNum(ledgerEntry?.amount),
      p_ledger_type: ledgerEntry?.type || null,
      p_ledger_description: ledgerEntry?.description || null,
      p_balance_change: safeNum(balanceUpdate?.amount)
    });
    if (rpcErr) throw rpcErr;
    result.jeId = jeId;
    result.ledgerOk = !!ledgerEntry;
    result.balanceOk = !!balanceUpdate;
    return result;
  } catch (e) {
    pmError("PM-4002", { raw: e, context: "atomic JE+ledger RPC, falling back to sequential", silent: true });
    return postAccountingTransaction({ date, description, reference, property, lines, status, ledgerEntry, balanceUpdate, requireJE: true, companyId });
  }
}

// Unified accounting transaction: JE → ledger → balance (non-atomic fallback)
export async function postAccountingTransaction({ date, description, reference, property, lines, status, ledgerEntry, balanceUpdate, requireJE = true, silent = false, companyId }) {
  const result = { jeId: null, ledgerOk: false, balanceOk: false, error: null };
  result.jeId = await autoPostJournalEntry({ date, description, reference, property, lines, status, companyId });
  if (!result.jeId && requireJE) {
  result.error = "Journal entry failed";
  return result;
  }
  if (ledgerEntry) {
  const enrichedEntry = { ...ledgerEntry };
  if (!enrichedEntry.tenant_id && balanceUpdate?.tenantId) enrichedEntry.tenant_id = balanceUpdate.tenantId;
  if (balanceUpdate?.tenantId && enrichedEntry.balance === 0) {
  try {
  const { data: tRow } = await supabase.from("tenants").select("balance").eq("id", balanceUpdate.tenantId).eq("company_id", companyId).maybeSingle();
  enrichedEntry.balance = safeNum(tRow?.balance) + safeNum(balanceUpdate.amount);
  } catch (_e) { pmError("PM-6002", { raw: _e, context: "tenant balance lookup for ledger enrichment", silent: true }); }
  }
  result.ledgerOk = await safeLedgerInsert({ company_id: companyId, ...enrichedEntry });
  }
  if (balanceUpdate?.tenantId) {
  try {
  const { error: balErr } = await supabase.rpc("update_tenant_balance", { p_tenant_id: balanceUpdate.tenantId, p_amount_change: balanceUpdate.amount });
  result.balanceOk = !balErr;
  if (balErr) {
    result.error = balErr.message;
    pmError("PM-6002", { raw: balErr, context: "balance update for tenant " + balanceUpdate.tenantId, silent: true, meta: { tenantId: balanceUpdate.tenantId } });
  }
  } catch (e) { result.error = e.message; pmError("PM-6002", { raw: e, context: "balance RPC exception", silent: true }); }
  }
  return result;
}

// ============ UNIFIED AUTO-POSTING TO ACCOUNTING ============
// Direct insert approach — no RPC. Posts JE header + lines in two steps.
// All bare account codes (e.g., "1000") are resolved to UUIDs via resolveAccountId().
export async function checkPeriodLock(companyId, date) {
  if (!date || !companyId) return false;
  const { data } = await supabase.from("accounting_period_lock").select("lock_date").eq("company_id", companyId).maybeSingle();
  return data?.lock_date && date < data.lock_date;
}

export async function autoPostJournalEntry({ date, description, reference, property, lines, status = "posted", companyId }) {
  try {
  if (!companyId) { pmError("PM-4002", { raw: { message: "missing companyId" }, context: "autoPostJournalEntry", silent: true }); return null; }
  // DR=CR balance guard. Interactive JE creation validates via validateJE(),
  // but every programmatic caller (autopay, recurring rent, owner dist,
  // late fees) used to bypass that check — letting unbalanced JEs post and
  // corrupt the GL silently. Reject at the gate so callers fail fast and
  // the nightly integrity sweep has less to clean up.
  if (lines?.length > 0) {
    const trDebit = lines.reduce((s, l) => s + safeNum(l.debit), 0);
    const trCredit = lines.reduce((s, l) => s + safeNum(l.credit), 0);
    if (Math.abs(trDebit - trCredit) > 0.005) {
      pmError("PM-4001", {
        raw: { message: `JE out of balance: DR $${trDebit.toFixed(2)} vs CR $${trCredit.toFixed(2)}` },
        context: `autoPostJournalEntry ref=${reference || "(none)"} desc=${description || "(none)"}`,
        meta: { trDebit, trCredit, diff: trDebit - trCredit, lineCount: lines.length },
      });
      return null;
    }
  }
  // Period lock check
  if (await checkPeriodLock(companyId, date)) { pmError("PM-4004", { raw: { message: "blocked by period lock" }, context: "autoPostJournalEntry, date: " + date, silent: true }); return null; }
  const cid = companyId;
  // Resolve bare account codes to UUIDs — work on a COPY to avoid mutating caller's data
  const resolvedLines = lines?.length > 0 ? lines.map(l => ({ ...l })) : [];
  for (let i = 0; i < resolvedLines.length; i++) {
  if (resolvedLines[i].account_id && /^\d{4}$/.test(resolvedLines[i].account_id)) {
  resolvedLines[i].account_id = await resolveAccountId(resolvedLines[i].account_id, cid);
  }
  }
  // Step 1: Insert journal entry header (collision-safe sequential number).
  // Two unique indexes can trip 23505 here:
  //   - acct_journal_entries.number (per-company running number)
  //   - idx_je_company_reference_unique (company_id, reference)
  // Retrying an insert only helps the first — incrementing `attempt`
  // rolls the number forward. A reference collision means the dedup
  // guard did its job: caller asked to post the same deterministic
  // reference twice, which is a no-op, not an error worth retrying.
  let jeRow = null, jeErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
  const { data: lastJE } = await supabase.from("acct_journal_entries").select("number").eq("company_id", cid).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const lastNum = lastJE?.number ? parseInt(lastJE.number.replace(/\D/g, "")) || 0 : 0;
  const jeNumber = "JE-" + String(lastNum + 1 + attempt).padStart(4, "0");
  ({ data: jeRow, error: jeErr } = await supabase.from("acct_journal_entries").insert([{
  company_id: cid, number: jeNumber, date, description, reference: reference || "", property: property || "", status
  }]).select("id").maybeSingle());
  if (!jeErr && jeRow) break; // success
  // Classify the unique-violation by constraint name / detail rather
  // than retrying blindly. Supabase returns the Postgres error with
  // .code='23505' and .details mentioning the column; .message also
  // leaks the constraint name on most setups.
  const msg = (jeErr?.message || "") + " " + (jeErr?.details || "");
  const isNumberCollision = /\b(number)\b|acct_journal_entries_number/i.test(msg);
  const isReferenceCollision = /\b(reference)\b|idx_je_company_reference_unique/i.test(msg);
  if (isReferenceCollision) {
    // Dedup fired — the caller's deterministic ref already exists. Not
    // retryable. Treat as the idempotent no-op it represents.
    pmError("PM-4002", { raw: jeErr, context: "JE reference already posted (dedup) — reference=" + (reference || "(none)"), silent: true, meta: { reference, dedup: true } });
    return null;
  }
  if (!isNumberCollision) break; // some other failure — don't loop
  }
  if (jeErr || !jeRow) { pmError("PM-4002", { raw: jeErr, context: "journal entry insert" }); return null; }
  // Step 2: Insert journal entry lines (with company_id for RLS)
  if (resolvedLines.length > 0) {
  const { error: lineErr } = await supabase.from("acct_journal_lines").insert(resolvedLines.map(l => ({
  journal_entry_id: jeRow.id, company_id: cid,
  account_id: l.account_id, account_name: l.account_name || "",
  debit: safeNum(l.debit), credit: safeNum(l.credit),
  class_id: l.class_id || null, memo: l.memo || ""
  })));
  if (lineErr) {
  pmError("PM-4003", { raw: lineErr, context: "journal lines insert" });
  // Clean up orphan header — if cleanup fails, void it instead so it's visible but harmless
  { const { error: _delErr } = await supabase.from("acct_journal_entries").delete().eq("id", jeRow.id).eq("company_id", companyId);
    if (_delErr) {
      // Delete failed (RLS, network) — void the orphan so it doesn't affect reports
      await supabase.from("acct_journal_entries").update({ status: "voided", description: "[ORPHANED — lines failed] " + (description || "") }).eq("id", jeRow.id).eq("company_id", companyId);
      pmError("PM-4012", { raw: _delErr, context: "ORPHANED JE HEADER: delete failed, voided instead. JE ID: " + jeRow.id, silent: false });
    }
  }
  return null;
  }
  }
  return jeRow.id;
  } catch (e) { pmError("PM-4002", { raw: e, context: "auto-post journal entry" }); return null; }
}

// Check if an AR accrual (rent charge) exists for a tenant in a given month
// Used by smart AR settlement: if accrual exists, payment settles AR; else posts direct revenue
export async function checkAccrualExists(companyId, month, tenantName) {
  // Look for RENT-AUTO entries for this month that mention the tenant
  const { data: rentJEs } = await supabase.from("acct_journal_entries")
  .select("id, reference").eq("company_id", companyId)
  .or(`reference.like.RENT-AUTO-%${escapeFilterValue(month)}%,reference.like.ACCR-${escapeFilterValue(month)}%`)
  .neq("status", "voided");
  if (!rentJEs || rentJEs.length === 0) return false;
  const jeIds = rentJEs.map(je => je.id);
  const { data: lines } = await supabase.from("acct_journal_lines")
  .select("journal_entry_id, memo").in("journal_entry_id", jeIds);
  if (!lines) return false;
  return lines.some(l => l.memo && l.memo.toLowerCase().includes(tenantName.toLowerCase()));
}

// ============ OWNER DISTRIBUTION AUTOMATION ============
// Auto-calculates management fee + owner net when rent is received.
// Posts GL entry: DR Rental Income / CR Mgmt Fee Income + CR Owner Dist Payable
export async function autoOwnerDistribution(companyId, propertyAddress, paymentAmount, paymentDate, tenantName) {
  try {
  const { data: prop } = await supabase.from("properties")
  .select("owner_id").eq("company_id", companyId).eq("address", propertyAddress).maybeSingle();
  if (!prop?.owner_id) return; // No owner assigned — skip silently
  const { data: owner } = await supabase.from("owners")
  .select("id, name, email, management_fee_pct").eq("company_id", companyId).eq("id", prop.owner_id).maybeSingle();
  if (!owner) return;
  // Guard: only post distribution if a rent accrual (AR charge) exists for this period.
  // If payment was posted as direct revenue (no accrual), the DR 4000 reversal would create
  // a negative revenue balance — effectively double-counting income.
  const month = paymentDate.slice(0, 7);
  const hasAccrual = await checkAccrualExists(companyId, month, tenantName);
  if (!hasAccrual) return; // No accrual to reclassify — distribution handled when payment was direct revenue
  // Null/missing management_fee_pct means self-managed — 0% fee, 100%
  // passthrough to owner. Previous code silently substituted 10%, which
  // charged opt-out owners a fee they never agreed to.
  const feePct = safeNum(owner.management_fee_pct);
  // Integer cents avoids fp precision loss, and the DR must match the sum
  // of CR cents exactly — not the caller's (possibly un-rounded) paymentAmount.
  // Without this, DR/CR could drift by fractional cents on float inputs and
  // trip the new PM-4001 balance guard in autoPostJournalEntry.
  const paymentCents = Math.round(paymentAmount * 100);
  const mgmtFeeCents = Math.round(paymentCents * feePct / 100);
  const mgmtFee = mgmtFeeCents / 100;
  const ownerNet = (paymentCents - mgmtFeeCents) / 100;
  const paymentRounded = paymentCents / 100;
  const classId = await getPropertyClassId(propertyAddress, companyId);
  // Deterministic reference so a retry can't double-distribute. Scope to
  // owner + tenant + date + amount so legitimate split payments differ but
  // identical replays collide on the unique (company_id, reference) index.
  const tenantSlug = (tenantName || "anon").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 32);
  const refDate = paymentDate.replace(/-/g, "");
  const ref = `ODIST-${owner.id}-${tenantSlug}-${refDate}-${paymentCents}`;
  // Insert the owner_distributions record FIRST. Previously the order was
  // JE→dist, so a failed dist insert left an orphan JE that drifted the
  // GL silently. Inserting dist first means the worst case is a dist row
  // without its JE — detectable by missing `reference` match and trivially
  // retried. Column mapping uses the real schema: amount=net-to-owner,
  // reference=JE ref, notes carries gross/fee breakdown for statements.
  const { data: distRow, error: distErr } = await supabase.from("owner_distributions").insert([{
    company_id: companyId,
    owner_id: owner.id,
    amount: ownerNet,
    date: paymentDate,
    reference: ref,
    notes: `Rent accrual from ${tenantName} at ${propertyAddress} — gross ${paymentRounded.toFixed(2)} · mgmt fee ${feePct}% (${mgmtFee.toFixed(2)}) · net ${ownerNet.toFixed(2)}`,
  }]).select("id").maybeSingle();
  if (distErr) {
    pmError("PM-6004", { raw: distErr, context: "owner distribution insert", silent: true });
    return;
  }
  // Drop the mgmt fee line when fee=0 (self-managed owner). An explicit
  // zero-credit line trips no guard but adds cosmetic noise on the JE.
  const jeLines = [
  { account_id: "4000", account_name: "Rental Income", debit: paymentRounded, credit: 0, class_id: classId, memo: `Reclassify to owner dist — ${tenantName}` },
  ];
  if (mgmtFee > 0) jeLines.push({ account_id: "4200", account_name: "Management Fee Income", debit: 0, credit: mgmtFee, class_id: classId, memo: `Mgmt fee ${feePct}% — ${owner.name}` });
  jeLines.push({ account_id: "2200", account_name: "Owner Distributions Payable", debit: 0, credit: ownerNet, class_id: classId, memo: `Net to ${owner.name}` });
  const jeId = await autoPostJournalEntry({
  companyId, date: paymentDate,
  description: `Owner distribution accrual — ${owner.name} — ${tenantName}`,
  reference: ref, property: propertyAddress,
  lines: jeLines,
  });
  if (!jeId && distRow?.id) {
    await supabase.from("owner_distributions").delete().eq("id", distRow.id).eq("company_id", companyId);
    pmError("PM-6004", { raw: { message: "JE failed — dist row rolled back" }, context: "owner distribution", silent: true });
  }
  } catch (e) { pmError("PM-6004", { raw: e, context: "auto owner distribution", silent: true }); }
}

// Resolve property address to cost-center class ID (with caching)
// Strategy: properties.class_id is the source of truth. If null, create the class and store it.
export const _classIdCache = {};
export async function getPropertyClassId(propertyAddress, companyId) {
  if (!propertyAddress || !companyId) return null;
  const cacheKey = `${companyId}::${propertyAddress}`;
  if (_classIdCache[cacheKey] !== undefined) return _classIdCache[cacheKey];
  // 1. Look up property's stored class_id (authoritative)
  const { data: prop } = await supabase.from("properties").select("id, class_id").eq("company_id", companyId).eq("address", propertyAddress).maybeSingle();
  if (prop?.class_id) {
  // Verify the class still exists
  const { data: cls } = await supabase.from("acct_classes").select("id").eq("id", prop.class_id).eq("company_id", companyId).maybeSingle();
  if (cls?.id) { _classIdCache[cacheKey] = cls.id; return cls.id; }
  }
  // 2. class_id is null or stale — find or create the class by exact name match
  const { data: exactMatch } = await supabase.from("acct_classes").select("id").eq("name", propertyAddress).eq("company_id", companyId).maybeSingle();
  if (exactMatch?.id) {
  // Update property to store this class_id for future lookups
  if (prop?.id) await supabase.from("properties").update({ class_id: exactMatch.id }).eq("id", prop.id).eq("company_id", companyId);
  _classIdCache[cacheKey] = exactMatch.id;
  return exactMatch.id;
  }
  // 3. No class exists — create one and store on property
  const { data: newClass } = await supabase.from("acct_classes").insert([{
  id: crypto.randomUUID(), name: propertyAddress, description: "Auto-created for " + propertyAddress.split(",")[0],
  color: pickColor(propertyAddress), is_active: true, company_id: companyId,
  }]).select("id").maybeSingle();
  if (newClass?.id) {
  if (prop?.id) await supabase.from("properties").update({ class_id: newClass.id }).eq("id", prop.id).eq("company_id", companyId);
  _classIdCache[cacheKey] = newClass.id;
  return newClass.id;
  }
  _classIdCache[cacheKey] = null;
  return null;
}

// ============ ACCOUNT CODE RESOLUTION ============
// Maps bare account codes ("1000") to UUID primary keys in acct_accounts.
// Uses the `code` column. Falls back to name matching. Auto-creates missing accounts.
export const _acctIdCache = {};
export const _acctCodeToName = { "1000": "Checking Account", "1100": "Accounts Receivable", "2100": "Security Deposits Held", "2110": "Accounts Payable", "2200": "Owner Distributions Payable", "4000": "Rental Income", "4010": "Late Fee Income", "4100": "Other Income", "4200": "Management Fee Income", "5300": "Repairs & Maintenance", "5400": "Utilities Expense", "5500": "Bad Debt Expense", "5600": "Mortgage/Loan Payment", "5610": "Legal & Eviction Costs", "5710": "Property Taxes" };
export async function resolveAccountId(bareCode, companyId) {
  if (!companyId) return null;
  const cid = companyId;
  if (!_acctIdCache[cid]) _acctIdCache[cid] = {};
  if (_acctIdCache[cid][bareCode]) return _acctIdCache[cid][bareCode];
  // Bulk-fetch all accounts and cache by code, name, and old suffix patterns
  const { data: allAccts } = await supabase.from("acct_accounts").select("id, code, name").eq("company_id", cid);
  if (allAccts && allAccts.length > 0) {
  for (const a of allAccts) {
  // Cache by code column (primary lookup)
  if (a.code) _acctIdCache[cid][a.code] = a.id;
  // Cache by name → standard code (fallback for migrated accounts)
  for (const [code, name] of Object.entries(_acctCodeToName)) {
  if (a.name === name && !_acctIdCache[cid][code]) _acctIdCache[cid][code] = a.id;
  }
  // Cache by old compound suffix (e.g., "co-abc-1000" → cache under "1000")
  if (a.code) {
  const suffix = a.code.match(/(\d{4,})$/);
  if (suffix && !_acctIdCache[cid][suffix[1]]) _acctIdCache[cid][suffix[1]] = a.id;
  }
  }
  }
  if (_acctIdCache[cid][bareCode]) return _acctIdCache[cid][bareCode];
  // Auto-create missing account with UUID PK + bare code
  const acctName = _acctCodeToName[bareCode] || "Account " + bareCode;
  const acctType = bareCode[0] === "1" ? "Asset" : bareCode[0] === "2" ? "Liability" : bareCode[0] === "3" ? "Equity" : bareCode[0] === "4" ? "Revenue" : "Expense";
  const { data: created, error: createErr } = await supabase.from("acct_accounts").insert([{
  company_id: cid, code: bareCode, name: acctName, type: acctType, is_active: true, old_text_id: cid + "-" + bareCode
  }]).select("id").maybeSingle();
  if (createErr) pmError("PM-4006", { raw: createErr, context: "resolveAccountId auto-create for " + bareCode, silent: true });
  const resolvedId = created?.id || null;
  if (resolvedId) _acctIdCache[cid][bareCode] = resolvedId;
  return resolvedId;
}

// ============ TENANT AR SUB-ACCOUNT ============
// Creates or retrieves a per-tenant AR sub-account (e.g., "1100-001 AR - Alice Johnson")
// linked to the parent 1100 Accounts Receivable account.
export const _tenantArCache = {};
export async function getOrCreateTenantAR(companyId, tenantName, tenantId) {
  try {
  if (!companyId || !tenantName) return await resolveAccountId("1100", companyId);
  const cacheKey = `${companyId}::${tenantName}`;
  if (_tenantArCache[cacheKey]) return _tenantArCache[cacheKey];
  // Check if tenant AR sub-account already exists
  const { data: existing } = await supabase.from("acct_accounts").select("id, code").eq("company_id", companyId).eq("type", "Asset").eq("name", "AR - " + tenantName).maybeSingle();
  if (existing?.id) {
  _tenantArCache[cacheKey] = existing.id;
  return existing.id;
  }
  // Get parent AR account UUID
  const parentArId = await resolveAccountId("1100", companyId);
  // Generate next sub-account code: 1100-001, 1100-002, etc.
  const { data: subAccts } = await supabase.from("acct_accounts").select("code").eq("company_id", companyId).like("code", "1100-%").order("code", { ascending: false }).limit(1);
  const lastSeq = subAccts?.[0]?.code ? parseInt(subAccts[0].code.split("-")[1]) || 0 : 0;
  const newCode = "1100-" + String(lastSeq + 1).padStart(3, "0");
  // Insert with old_text_id (required NOT NULL column)
  const oldTextId = companyId + "-" + newCode;
  let newAcct = null;
  let createErr = null;
  // Attempt 1: full payload
  ({ data: newAcct, error: createErr } = await supabase.from("acct_accounts").insert([{
  company_id: companyId, code: newCode, name: "AR - " + tenantName,
  type: "Asset", is_active: true, old_text_id: oldTextId,
  parent_id: parentArId || null, tenant_id: tenantId || null,
  }]).select("id").maybeSingle());
  // Attempt 2: without optional columns
  if (createErr) {
  ({ data: newAcct, error: createErr } = await supabase.from("acct_accounts").insert([{
  company_id: companyId, code: newCode, name: "AR - " + tenantName,
  type: "Asset", is_active: true, old_text_id: oldTextId,
  }]).select("id").maybeSingle());
  }
  if (createErr || !newAcct?.id) {
  pmError("PM-4006", { raw: createErr, context: "AR sub-account creation after 3 attempts", silent: true });
  _tenantArCache[cacheKey] = parentArId;
  return parentArId;
  }
  _tenantArCache[cacheKey] = newAcct.id;
  return newAcct.id;
  } catch (e) {
  pmError("PM-4006", { raw: e, context: "get or create tenant AR sub-account", silent: true });
  return await resolveAccountId("1100", companyId);
  }
}

// INTENTIONAL NO-OP: Rent is handled exclusively by autoPostRecurringEntries via recurring_journal_entries table.
// This stub exists for backward compatibility — called in handleSelectCompany and wizard completion.
export async function autoPostRentCharges() { return { posted: 0, failed: 0 }; }

// ============ AUTO-POST RECURRING JOURNAL ENTRIES ============
// Posts recurring JEs for each missed period (catches up if app was down).
// Respects frequency: monthly, quarterly, semi-annual.
export async function autoPostRecurringEntries(companyId) {
  try {
  if (!companyId) return { posted: 0 };
  const cid = companyId;
  const today = new Date();
  const todayStr = formatLocalDate(today);
  const thisMonth = todayStr.slice(0, 7);
  const { data: entries } = await supabase.from("recurring_journal_entries").select("*").eq("company_id", cid).eq("status", "active").is("archived_at", null);
  if (!entries || entries.length === 0) return { posted: 0 };
  let posted = 0;
  const MAX = 50;
  for (const entry of entries) {
  if (posted >= MAX) break;
  // Determine frequency interval in months
  const freqMonths = entry.frequency === "quarterly" ? 3
    : entry.frequency === "semi-annual" ? 6
    : entry.frequency === "annual" ? 12
    : 1;
  // Calculate which months need posting (catch up missed periods)
  const lastPosted = entry.last_posted_date ? parseLocalDate(entry.last_posted_date) : null;
  let cursor = lastPosted ? new Date(lastPosted.getFullYear(), lastPosted.getMonth() + freqMonths, 1) : new Date(today.getFullYear(), today.getMonth(), 1);
  const classId = entry.property ? await getPropertyClassId(entry.property, cid) : null;
  while (cursor <= today && posted < MAX) {
  const monthStr = formatLocalDate(cursor).slice(0, 7);
  const postDate = cursor <= today ? formatLocalDate(new Date(Math.min(cursor.getTime(), today.getTime()))) : todayStr;
  const ref = "RECUR-" + (entry.id || shortId()).toString().slice(0, 8) + "-" + monthStr;
  // Skip if posting date falls in locked period
  if (await checkPeriodLock(cid, postDate)) { cursor.setMonth(cursor.getMonth() + freqMonths); continue; }
  // Skip if this RECUR ref was already posted (idempotent)
  const { data: existingRecur } = await supabase.from("acct_journal_entries").select("id").eq("company_id", cid).eq("reference", ref).neq("status", "voided").limit(1);
  if (existingRecur && existingRecur.length > 0) { cursor.setMonth(cursor.getMonth() + freqMonths); continue; }

  // Prorate on both edges of the lease. Previously we only prorated on
  // end_date, so a lease that started mid-month (e.g. Jan 15) got billed
  // the full month's rent for January — an overcharge on the tenant's
  // first bill.
  let postAmount = safeNum(entry.amount);
  let postDesc = entry.description || "Recurring entry";
  if (entry.tenant_name && entry.property) {
    // Scope by tenant_id (then tenant_name) in addition to property —
    // .maybeSingle() throws on multi-unit properties with more than one
    // active lease, and even when a single lease is returned it could
    // belong to a different tenant whose dates would then misprorate
    // the one we're actually billing.
    let leaseQ = supabase.from("leases").select("start_date, end_date").eq("company_id", cid).eq("property", entry.property).eq("status", "active");
    leaseQ = entry.tenant_id ? leaseQ.eq("tenant_id", entry.tenant_id) : leaseQ.eq("tenant_name", entry.tenant_name);
    const { data: leaseRows } = await leaseQ.order("start_date", { ascending: false }).limit(1);
    const lease = leaseRows?.[0] || null;
    const yr = parseInt(monthStr.split("-")[0], 10) || 2026;
    const mo = parseInt(monthStr.split("-")[1], 10) || 1;
    const daysInMonth = new Date(yr, mo, 0).getDate();
    const startsMidMonth = lease?.start_date && lease.start_date.slice(0, 7) === monthStr;
    const endsMidMonth   = lease?.end_date   && lease.end_date.slice(0, 7)   === monthStr;
    if (startsMidMonth && endsMidMonth) {
      // Lease starts and ends in the same month — bill only the overlap.
      const startDay = parseInt(lease.start_date.split("-")[2], 10) || 1;
      const endDay   = parseInt(lease.end_date.split("-")[2], 10)   || daysInMonth;
      const days = Math.max(1, endDay - startDay + 1);
      if (days < daysInMonth) {
        postAmount = Math.round(safeNum(entry.amount) * days / daysInMonth * 100) / 100;
        postDesc = (entry.description || "Recurring entry") + ` (prorated ${days}/${daysInMonth} days — lease ${lease.start_date} → ${lease.end_date})`;
      }
    } else if (startsMidMonth) {
      const startDay = parseInt(lease.start_date.split("-")[2], 10) || 1;
      const days = Math.max(1, daysInMonth - startDay + 1);
      if (days < daysInMonth) {
        postAmount = Math.round(safeNum(entry.amount) * days / daysInMonth * 100) / 100;
        postDesc = (entry.description || "Recurring entry") + ` (prorated ${days}/${daysInMonth} days — lease starts ${lease.start_date})`;
      }
    } else if (endsMidMonth) {
      const endDay = parseInt(lease.end_date.split("-")[2], 10) || 0;
      if (endDay > 0 && endDay < daysInMonth) {
        postAmount = Math.round(safeNum(entry.amount) * endDay / daysInMonth * 100) / 100;
        postDesc = (entry.description || "Recurring entry") + ` (prorated ${endDay}/${daysInMonth} days — lease ends ${lease.end_date})`;
      }
    }
  }

  const jeId = await autoPostJournalEntry({
  companyId: cid, date: postDate,
  description: postDesc,
  reference: ref,
  property: entry.property || "",
  lines: [
  { account_id: entry.debit_account_id, account_name: entry.debit_account_name || "", debit: postAmount, credit: 0, class_id: classId, memo: postDesc },
  { account_id: entry.credit_account_id, account_name: entry.credit_account_name || "", debit: 0, credit: postAmount, class_id: classId, memo: postDesc },
  ]
  });
  if (jeId) {
  await supabase.from("recurring_journal_entries").update({ last_posted_date: postDate, next_post_date: null }).eq("id", entry.id).eq("company_id", cid);
  // Update tenant balance when the debit hits an AR account. Resolving by
  // account_id + type is reliable; the old check used a fuzzy
  // `.includes("ar")` on `debit_account_name`, which silently skipped
  // balance updates whenever the name didn't literally contain "ar" (e.g.
  // the column was blank, or named "Accounts Receivable - Tenant X").
  if (entry.tenant_id && entry.debit_account_id) {
    const debitId = /^\d{4}$/.test(entry.debit_account_id)
      ? await resolveAccountId(entry.debit_account_id, cid)
      : entry.debit_account_id;
    if (debitId) {
      const { data: acct } = await supabase.from("acct_accounts").select("type, code").eq("company_id", cid).eq("id", debitId).maybeSingle();
      const isAR = acct && (acct.code === "1100" || ((acct.type || "").toLowerCase() === "asset" && (acct.code || "").startsWith("11")));
      if (isAR) {
        const { error: balErr } = await supabase.rpc("update_tenant_balance", { p_tenant_id: entry.tenant_id, p_amount_change: postAmount });
        if (balErr) pmError("PM-6002", { raw: balErr, context: "recurring balance update", silent: true });
      }
    }
  }
  posted++;
  }
  cursor.setMonth(cursor.getMonth() + freqMonths);
  }
  }
  if (posted > 0) logAudit("create", "accounting", "Auto-posted " + posted + " recurring entries", "", "system", "system", cid);
  return { posted };
  } catch (e) { pmError("PM-4008", { raw: e, context: "auto recurring entries", silent: true }); return { posted: 0 }; }
}

// ZIP → City/State lookup (Zippopotam.us — free, no API key)
export const _zipCache = {};
export async function lookupZip(zip) {
  if (!/^\d{5}$/.test(zip)) return null;
  if (_zipCache[zip]) return _zipCache[zip];
  try {
  const r = await fetch("https://api.zippopotam.us/us/" + zip);
  if (!r.ok) return null;
  const data = await r.json();
  const place = data.places?.[0];
  if (!place) return null;
  const result = { city: place["place name"], state: place["state abbreviation"] };
  _zipCache[zip] = result;
  return result;
  } catch (_e) { pmError("PM-8006", { raw: _e, context: "ZIP code lookup", silent: true }); return null; }
}
