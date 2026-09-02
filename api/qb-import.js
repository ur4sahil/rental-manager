// ============ QUICKBOOKS LEDGER IMPORT — SERVER ROUTE ============
//
// Bulk-writes a parsed QuickBooks general ledger into a company. The
// browser does all parsing and mapping (src/utils/qbImport.js + the
// QuickBooksImport wizard); this route only writes what it is given.
//
// Why server-side rather than straight from the client:
//   • ~6,650 journal entries and ~14,200 lines. The RLS policies on
//     acct_* are permissive-OR'd and include a VOLATILE has_write_access()
//     plus a per-row correlated subquery (je_lines_access), so a direct
//     client insert pays that cost on every one of 14,200 rows.
//   • autoPostJournalEntry() costs 3 round-trips per entry (~20,000
//     requests) and silently returns null on a duplicate reference, which
//     would drop entries with no error.
//
// The service-role client bypasses RLS, so this route does its own
// authorization: bearer token -> user -> active company_members row with
// a write-capable role. Nothing here trusts companyId from the body
// without that check.
//
// The per-row tenant-balance trigger (sync_tenant_balance_lines) is left
// ENABLED deliberately. Measured on the real dataset: 3,020 of 14,238
// lines hit a tenant AR account, costing ~125k indexed aggregate scans —
// seconds, not minutes. Disabling it would need a privileged function
// able to switch off a data-integrity trigger, which is not worth it.
// recompute_tenant_balances_bulk() is called at finalize as a
// verification sweep that also repairs any pre-existing drift.

const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");

// Roles allowed to import a ledger. Mirrors has_write_access() in the DB.
const IMPORT_ROLES = new Set(["admin", "owner", "pm", "manager", "accountant", "office_assistant"]);

const REF_PREFIX = "QB-";
const HEADER_BATCH = 500;   // rows per insert statement
const LINE_BATCH = 500;
const IN_CHUNK = 100;       // Supabase .in() tops out around 100 values
const MAX_ENTRIES_PER_CALL = 400;

const MAX_COMPANYID_LEN = 64;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function bad(res, code, error, extra) {
  return res.status(code).json({ error, ...(extra || {}) });
}

// Every insert sets company_id explicitly. acct_journal_entries,
// acct_journal_lines' parent, acct_accounts and acct_classes all DEFAULT
// company_id to 'sandbox-llc' — omitting it silently files the whole
// import under the sandbox company with no error at all.
function requireCompanyId(cid) {
  if (typeof cid !== "string" || !cid || cid.length > MAX_COMPANYID_LEN) return null;
  return cid;
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end("ok");
  if (req.method !== "POST") return bad(res, 405, "POST only");

  // Cheap local validation before any Supabase call.
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ") || authHeader.length < 20 || authHeader.length > 4096) {
    return bad(res, 401, "Missing bearer token");
  }

  const body = req.body || {};
  const action = body.action;
  const companyId = requireCompanyId(body.companyId);
  if (!companyId) return bad(res, 400, "Invalid companyId");
  if (!["resolve", "entries", "finalize", "rollback", "status"].includes(action)) {
    return bad(res, 400, "Invalid action");
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return bad(res, 500, "Server not configured for import");
  }

  // ── authorize the caller ──────────────────────────────────────────
  const token = authHeader.slice(7);
  const userClient = createClient(
    process.env.REACT_APP_SUPABASE_URL,
    process.env.REACT_APP_SUPABASE_ANON_KEY,
    {
      global: { headers: { Authorization: "Bearer " + token } },
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return bad(res, 401, "Invalid session");
  const userEmail = userData.user.email;

  const { data: membership } = await userClient
    .from("company_members")
    .select("role, status")
    .eq("company_id", companyId)
    .eq("user_email", userEmail)
    .eq("status", "active")
    .maybeSingle();
  if (!membership) return bad(res, 403, "Not a member of this company");
  if (!IMPORT_ROLES.has(membership.role)) {
    return bad(res, 403, "Insufficient role to import a ledger");
  }

  const db = createClient(process.env.REACT_APP_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    if (action === "status") return await handleStatus(db, companyId, res);
    if (action === "rollback") return await handleRollback(db, companyId, userEmail, res);
    if (action === "resolve") return await handleResolve(db, companyId, body, res);
    if (action === "entries") return await handleEntries(db, companyId, body, res);
    if (action === "finalize") return await handleFinalize(db, companyId, userEmail, res);
  } catch (e) {
    console.error("[qb-import]", action, e);
    return bad(res, 500, "Import failed", { detail: String(e?.message || e).slice(0, 400) });
  }
};

// ── status ──────────────────────────────────────────────────────────

async function handleStatus(db, companyId, res) {
  const { count: entries } = await db
    .from("acct_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .like("reference", REF_PREFIX + "%");
  return res.status(200).json({ ok: true, importedEntries: entries || 0 });
}

// ── rollback ────────────────────────────────────────────────────────
// acct_journal_lines_journal_entry_id_fkey is ON DELETE CASCADE, so
// deleting the headers removes their lines. Only ever touches entries
// this importer created (reference LIKE 'QB-%'); accounts, classes,
// properties, tenants and vendors are intentionally left in place —
// they may already be referenced by other work.
async function handleRollback(db, companyId, userEmail, res) {
  const { data: doomed, error: selErr } = await db
    .from("acct_journal_entries")
    .select("id")
    .eq("company_id", companyId)
    .like("reference", REF_PREFIX + "%");
  if (selErr) throw selErr;

  let deleted = 0;
  for (const batch of chunk((doomed || []).map(d => d.id), IN_CHUNK)) {
    const { error } = await db
      .from("acct_journal_entries")
      .delete()
      .eq("company_id", companyId)
      .in("id", batch);
    if (error) throw error;
    deleted += batch.length;
  }

  await db.from("audit_trail").insert([{
    action: "delete", module: "accounting", company_id: companyId,
    details: `QuickBooks import rolled back — ${deleted} journal entries deleted`,
    user_email: userEmail, user_role: "admin",
  }]);

  return res.status(200).json({ ok: true, deleted });
}

// ── resolve: create/lookup every dimension the lines reference ──────
//
// Runs before any journal entry is written, in dependency order:
//   accounts -> classes -> properties -> tenants (+AR accounts) -> vendors
// Returns id maps the client sends back with each entries chunk.
//
// Every table here has a unique index the upsert targets, so resolve is
// idempotent and safe to re-run:
//   acct_accounts(company_id, code)   acct_classes(company_id, name)
//   properties(company_id, address)   tenants(company_id, name, property)
// vendors has no unique on name, so it is deduped explicitly by name.
async function handleResolve(db, companyId, body, res) {
  const accounts = Array.isArray(body.accounts) ? body.accounts : [];
  const classes = Array.isArray(body.classes) ? body.classes : [];
  const properties = Array.isArray(body.properties) ? body.properties : [];
  const tenants = Array.isArray(body.tenants) ? body.tenants : [];
  const vendors = Array.isArray(body.vendors) ? body.vendors : [];

  const created = { accounts: 0, classes: 0, properties: 0, tenants: 0, vendors: 0 };

  // --- classes (per property address) -------------------------------
  const classMap = {};
  if (classes.length) {
    const rows = classes.map(c => ({
      id: c.id || cryptoRandomId(),
      company_id: companyId,
      name: c.name,
      description: c.description || "",
      is_active: true,
    }));
    for (const batch of chunk(rows, HEADER_BATCH)) {
      const { error } = await db.from("acct_classes")
        .upsert(batch, { onConflict: "company_id,name", ignoreDuplicates: true });
      if (error) throw error;
    }
    // Re-read so we map to whatever id actually won (ours or a pre-existing).
    for (const batch of chunk(classes.map(c => c.name), IN_CHUNK)) {
      const { data, error } = await db.from("acct_classes")
        .select("id, name").eq("company_id", companyId).in("name", batch);
      if (error) throw error;
      (data || []).forEach(r => { classMap[r.name] = r.id; });
    }
    created.classes = Object.keys(classMap).length;
  }

  // --- properties ---------------------------------------------------
  const propertyMap = {};
  if (properties.length) {
    const rows = properties.map(p => ({
      company_id: companyId,
      address: p.address,
      type: p.type || "Residential",
      class_id: classMap[p.address] || null,
    }));
    for (const batch of chunk(rows, HEADER_BATCH)) {
      const { error } = await db.from("properties")
        .upsert(batch, { onConflict: "company_id,address", ignoreDuplicates: true });
      if (error) throw error;
    }
    for (const batch of chunk(properties.map(p => p.address), IN_CHUNK)) {
      const { data, error } = await db.from("properties")
        .select("id, address, class_id").eq("company_id", companyId)
        .is("archived_at", null).in("address", batch);
      if (error) throw error;
      (data || []).forEach(r => {
        propertyMap[r.address] = r.id;
        // Backfill class_id on a property that already existed without one.
        if (!r.class_id && classMap[r.address]) {
          db.from("properties").update({ class_id: classMap[r.address] })
            .eq("id", r.id).eq("company_id", companyId).then(() => {}, () => {});
        }
      });
    }
    created.properties = Object.keys(propertyMap).length;
  }

  // --- tenants ------------------------------------------------------
  const tenantMap = {};
  if (tenants.length) {
    const rows = tenants.map(t => ({
      company_id: companyId,
      name: t.name,
      property: t.property || "",
      lease_status: t.leaseStatus || "past",
      rent: 0,
    }));
    for (const batch of chunk(rows, HEADER_BATCH)) {
      const { error } = await db.from("tenants")
        .upsert(batch, { onConflict: "company_id,name,property", ignoreDuplicates: true });
      if (error) throw error;
    }
    for (const batch of chunk(tenants.map(t => t.name), IN_CHUNK)) {
      const { data, error } = await db.from("tenants")
        .select("id, name").eq("company_id", companyId).is("archived_at", null).in("name", batch);
      if (error) throw error;
      (data || []).forEach(r => { if (!tenantMap[r.name]) tenantMap[r.name] = r.id; });
    }
    created.tenants = Object.keys(tenantMap).length;
  }

  // --- vendors (no unique index — dedupe by name explicitly) --------
  const vendorMap = {};
  if (vendors.length) {
    for (const batch of chunk(vendors.map(v => v.name), IN_CHUNK)) {
      const { data, error } = await db.from("vendors")
        .select("id, name").eq("company_id", companyId).is("archived_at", null).in("name", batch);
      if (error) throw error;
      (data || []).forEach(r => { if (!vendorMap[r.name]) vendorMap[r.name] = r.id; });
    }
    const missing = vendors.filter(v => !vendorMap[v.name]);
    if (missing.length) {
      for (const batch of chunk(missing, HEADER_BATCH)) {
        const { data, error } = await db.from("vendors")
          .insert(batch.map(v => ({ company_id: companyId, name: v.name })))
          .select("id, name");
        if (error) throw error;
        (data || []).forEach(r => { vendorMap[r.name] = r.id; });
      }
    }
    created.vendors = Object.keys(vendorMap).length;
  }

  // --- accounts (last: tenant AR accounts need tenant ids) ----------
  const accountMap = {};
  if (accounts.length) {
    const rows = accounts.map(a => ({
      company_id: companyId,
      code: a.code,
      name: a.name,
      type: a.type,
      subtype: a.subtype || null,
      is_active: true,
      // NOT NULL with no default — must be supplied.
      old_text_id: companyId + "-" + a.code,
      // bigint column; only set for per-tenant AR accounts.
      tenant_id: a.tenantName && tenantMap[a.tenantName] ? tenantMap[a.tenantName] : null,
      description: a.description || "",
    }));
    for (const batch of chunk(rows, HEADER_BATCH)) {
      const { error } = await db.from("acct_accounts")
        .upsert(batch, { onConflict: "company_id,code", ignoreDuplicates: true });
      if (error) throw error;
    }
    for (const batch of chunk(accounts.map(a => a.code), IN_CHUNK)) {
      const { data, error } = await db.from("acct_accounts")
        .select("id, code").eq("company_id", companyId).in("code", batch);
      if (error) throw error;
      (data || []).forEach(r => { accountMap[r.code] = r.id; });
    }
    created.accounts = Object.keys(accountMap).length;
  }

  return res.status(200).json({ ok: true, created, accountMap, classMap, propertyMap, tenantMap, vendorMap });
}

// ── entries: write one chunk of journal entries + their lines ───────
async function handleEntries(db, companyId, body, res) {
  const entries = Array.isArray(body.entries) ? body.entries : [];
  if (!entries.length) return res.status(200).json({ ok: true, inserted: 0, skipped: 0, lines: 0 });
  if (entries.length > MAX_ENTRIES_PER_CALL) {
    return bad(res, 400, `Too many entries in one call (max ${MAX_ENTRIES_PER_CALL})`);
  }
  const status = body.status === "draft" ? "draft" : "posted";

  // 1. Skip anything already imported. The unique index on
  //    (company_id, reference) is partial, so ON CONFLICT can't reliably
  //    infer it — an explicit pre-filter is simpler and provably right,
  //    and makes a re-run after a partial failure a no-op.
  const refs = entries.map(e => e.reference);
  const existing = new Set();
  for (const batch of chunk(refs, IN_CHUNK)) {
    const { data, error } = await db.from("acct_journal_entries")
      .select("reference").eq("company_id", companyId).in("reference", batch);
    if (error) throw error;
    (data || []).forEach(r => existing.add(r.reference));
  }
  const todo = entries.filter(e => !existing.has(e.reference));
  const skipped = entries.length - todo.length;
  if (!todo.length) return res.status(200).json({ ok: true, inserted: 0, skipped, lines: 0 });

  // 2. One JE-number base for the whole chunk. next_je_number is
  //    MAX-based and O(n) per call — calling it per entry would be
  //    ~6,650 round trips and quadratic work. Chunks are sent
  //    sequentially by the client, so a single base per chunk is safe;
  //    unique_je_number_per_company is the backstop if it ever isn't.
  const { data: baseNum, error: numErr } = await db.rpc("next_je_number", { p_company_id: companyId });
  if (numErr) throw numErr;
  const base = parseInt(String(baseNum || "JE-0001").replace(/\D/g, ""), 10) || 1;

  const headers = todo.map((e, i) => ({
    company_id: companyId,
    number: "JE-" + String(base + i).padStart(4, "0"),
    date: e.date,
    description: (e.description || "QuickBooks import").slice(0, 300),
    reference: e.reference,
    property: e.property || "",
    status,
    // Deliberately NULL, not QuickBooks' own type string.
    //
    // The ledger_entries view derives a tenant's running balance from
    // this column against a lowercase vocabulary — 'charge', 'payment',
    // 'late_fee', 'deposit', 'credit', 'void' … QuickBooks emits
    // 'Journal Entry', 'Deposit', 'Payment', 'Check', which match none
    // of them and fall through the view's CASE to the += branch. A
    // tenant payment would then ADD to their balance instead of
    // subtracting.
    //
    // Left NULL, the view applies its own per-line fallback
    // (debit > 0 ? 'charge' : 'payment'), which is both correct and
    // finer-grained than any header-level type could be for a
    // multi-line entry. The QuickBooks type is preserved at the front
    // of the description ("Journal Entry #113 …").
    transaction_type: null,
  }));

  const idByRef = {};
  for (const batch of chunk(headers, HEADER_BATCH)) {
    const { data, error } = await db.from("acct_journal_entries").insert(batch).select("id, reference");
    if (error) throw error;
    (data || []).forEach(r => { idByRef[r.reference] = r.id; });
  }

  // 3. Lines. company_id is set explicitly, which also short-circuits
  //    the trg_jl_company_id BEFORE trigger's lookup.
  const lineRows = [];
  for (const e of todo) {
    const jeId = idByRef[e.reference];
    if (!jeId) continue;
    for (const l of e.lines) {
      lineRows.push({
        journal_entry_id: jeId,
        company_id: companyId,
        account_id: l.accountId,
        account_name: (l.accountName || "").slice(0, 200),
        debit: l.debit || 0,
        credit: l.credit || 0,
        class_id: l.classId || null,
        memo: (l.memo || "").slice(0, 500),
        // chk_entity_type permits only 'customer' or 'vendor' — anything
        // else aborts the insert. entity_id is a uuid column, so a vendor
        // id fits but a tenant id (integer) does not: a customer line
        // carries the name only, and the real tenant linkage lives on the
        // AR account's tenant_id, set during resolve.
        entity_type: l.vendorId ? "vendor" : (l.customerName ? "customer" : null),
        entity_id: l.vendorId || null,
        entity_name: l.entityName || l.customerName || null,
      });
    }
  }
  for (const batch of chunk(lineRows, LINE_BATCH)) {
    const { error } = await db.from("acct_journal_lines").insert(batch);
    if (error) throw error;
  }

  return res.status(200).json({
    ok: true,
    inserted: Object.keys(idByRef).length,
    skipped,
    lines: lineRows.length,
    firstNumber: headers.length ? headers[0].number : null,
    lastNumber: headers.length ? headers[headers.length - 1].number : null,
  });
}

// ── finalize: verify balances, record the import ────────────────────
async function handleFinalize(db, companyId, userEmail, res) {
  // Sweeps every tenant in the company. The per-row trigger already kept
  // these current during the load; this both proves it and repairs any
  // pre-existing drift.
  let balancesUpdated = null;
  const { data, error } = await db.rpc("recompute_tenant_balances_bulk", { p_company_id: companyId });
  if (!error) balancesUpdated = data;

  const { count: entries } = await db
    .from("acct_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId).like("reference", REF_PREFIX + "%");

  await db.from("audit_trail").insert([{
    action: "create", module: "accounting", company_id: companyId,
    details: `QuickBooks ledger import finalized — ${entries || 0} journal entries, ${balancesUpdated ?? "?"} tenant balances corrected`,
    user_email: userEmail, user_role: "admin",
  }]);

  return res.status(200).json({ ok: true, importedEntries: entries || 0, balancesUpdated });
}

function cryptoRandomId() {
  return require("crypto").randomUUID();
}
