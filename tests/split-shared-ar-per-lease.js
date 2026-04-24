// Per-lease AR sub-account split. For tenants sharing one
// AR sub-account by name (e.g. "AR - Sahil Agarwal" used by 3
// tenant rows), create per-tenant-id sub-accounts and re-attribute
// existing JE lines.
//
// Scope (this run): Smith Properties LLC + active leases only.
// Archived tenant rows keep their lines on the existing
// consolidated account.
//
// Attribution rules for each acct_journal_lines row hitting the
// shared AR:
//   1. JE.reference like "RECUR-<id>-..."
//      → recurring_journal_entries.tenant_id
//   2. JE.reference like "RENT1-T<id>-..." or "DEP-T<id>-..."
//      → parse tenant_id from reference
//   3. JE.reference like "BANK-<txn>" or anything else
//      → match JE.property → tenant.property within the same name
//      → if exactly one match, attribute; otherwise leave on parent
//   4. JE.bank_feed_transaction_id present? Same property-match.
//
// Run dry-first: node split-shared-ar-per-lease.js
// Apply: node split-shared-ar-per-lease.js --apply

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const COMPANY_ID = "dce4974d-afa9-4e65-afdf-1189b815195d";
const APPLY = process.argv.includes("--apply");

function shortProp(p) { return (p || "").split(",")[0].trim(); }

(async () => {
  console.log(`Per-lease AR split — Smith Properties LLC (${APPLY ? "APPLY" : "DRY-RUN"})`);
  console.log("================================================================\n");

  // 1. Find every name with >1 active tenant row at Smith
  const { data: tenants } = await sb.from("tenants")
    .select("id, name, property, balance, lease_status, archived_at")
    .eq("company_id", COMPANY_ID);
  const byName = {};
  (tenants || []).forEach(t => (byName[t.name] ||= []).push(t));
  const sharedNames = Object.entries(byName).filter(([_, rows]) => rows.filter(r => !r.archived_at).length > 1);
  if (sharedNames.length === 0) { console.log("No shared-AR names. Nothing to do."); return; }

  for (const [name, rows] of sharedNames) {
    console.log(`\nName: ${name}`);
    const activeRows = rows.filter(r => !r.archived_at);
    const archivedRows = rows.filter(r => !!r.archived_at);
    console.log(`  ${activeRows.length} active rows, ${archivedRows.length} archived`);

    // 2. Find the existing shared AR account
    const { data: sharedAR } = await sb.from("acct_accounts")
      .select("id, code, name")
      .eq("company_id", COMPANY_ID).eq("type", "Asset").eq("name", "AR - " + name)
      .maybeSingle();
    if (!sharedAR) { console.log(`  ⚠️  no shared AR sub-account "AR - ${name}" found, skipping`); continue; }
    console.log(`  Shared AR: ${sharedAR.code} ${sharedAR.name} (id ${sharedAR.id})`);

    // 3. For each active tenant row, ensure a per-lease AR sub-account exists.
    //    Naming: "AR - <name> (<short property>)" — short = first
    //    comma-segment of address. Code: next 1100-XXX in sequence.
    const { data: subAccts } = await sb.from("acct_accounts")
      .select("code").eq("company_id", COMPANY_ID).like("code", "1100-%").order("code", { ascending: false }).limit(1);
    let lastSeq = subAccts?.[0]?.code ? parseInt(subAccts[0].code.split("-")[1], 10) || 0 : 0;
    const perLeaseAccts = {}; // tenant_id → account_id
    for (const row of activeRows) {
      const acctName = "AR - " + name + " (" + shortProp(row.property) + ")";
      // Idempotent: if an account already exists with this name, reuse
      const { data: existing } = await sb.from("acct_accounts")
        .select("id, code").eq("company_id", COMPANY_ID).eq("type", "Asset").eq("name", acctName).maybeSingle();
      if (existing) {
        console.log(`  ✓ existing per-lease AR ${existing.code} for tenant ${row.id} (${shortProp(row.property)})`);
        perLeaseAccts[row.id] = existing.id;
        continue;
      }
      lastSeq += 1;
      const newCode = "1100-" + String(lastSeq).padStart(3, "0");
      console.log(`  + create ${newCode} ${acctName} (tenant_id=${row.id})`);
      if (APPLY) {
        const { data: ins, error } = await sb.from("acct_accounts").insert([{
          company_id: COMPANY_ID, code: newCode, name: acctName,
          type: "Asset", is_active: true,
          old_text_id: COMPANY_ID + "-" + newCode,
          parent_id: null, tenant_id: row.id,
        }]).select("id").maybeSingle();
        if (error || !ins) { console.log(`    ❌ create failed: ${error?.message}`); continue; }
        perLeaseAccts[row.id] = ins.id;
      } else {
        perLeaseAccts[row.id] = "DRYRUN-" + newCode;
      }
    }

    // 4. Walk every line on the shared AR and attribute.
    const { data: lines } = await sb.from("acct_journal_lines")
      .select("id, debit, credit, journal_entry_id, bank_feed_transaction_id, acct_journal_entries!inner(id, reference, property, status, description, date)")
      .eq("company_id", COMPANY_ID).eq("account_id", sharedAR.id)
      .neq("acct_journal_entries.status", "voided");
    console.log(`  ${lines?.length || 0} JE lines on shared AR (non-voided)`);

    const attribution = {}; // tenant_id → [lineIds]
    let unattributed = 0, unattributedDR = 0, unattributedCR = 0;
    const sumByTenant = {};
    for (const ln of (lines || [])) {
      const je = ln.acct_journal_entries;
      const ref = je.reference || "";
      let tenantId = null;
      // Rule 1: RECUR-<id>-...
      const recurMatch = ref.match(/^RECUR-([0-9a-f-]+)-/i);
      if (recurMatch) {
        const recurId = recurMatch[1];
        // Recur ids are short (8 hex). Use prefix match against the full id.
        const { data: recurs } = await sb.from("recurring_journal_entries").select("id, tenant_id").eq("company_id", COMPANY_ID);
        const found = (recurs || []).find(r => r.id.toLowerCase().startsWith(recurId.toLowerCase()));
        if (found?.tenant_id) tenantId = found.tenant_id;
      }
      // Rule 2: RENT1-T<id> or DEP-T<id>
      if (!tenantId) {
        const tMatch = ref.match(/-T(\d+)-/);
        if (tMatch) {
          const cand = parseInt(tMatch[1], 10);
          if (activeRows.some(r => r.id === cand)) tenantId = cand;
        }
      }
      // Rule 3: property match
      if (!tenantId && je.property) {
        const matches = activeRows.filter(r => (r.property || "").trim() === (je.property || "").trim());
        if (matches.length === 1) tenantId = matches[0].id;
      }
      if (tenantId && perLeaseAccts[tenantId]) {
        (attribution[tenantId] ||= []).push(ln.id);
        sumByTenant[tenantId] = (sumByTenant[tenantId] || 0) + Number(ln.debit || 0) - Number(ln.credit || 0);
      } else {
        unattributed++;
        unattributedDR += Number(ln.debit || 0);
        unattributedCR += Number(ln.credit || 0);
      }
    }
    console.log(`  Attribution summary:`);
    for (const [tid, lineIds] of Object.entries(attribution)) {
      const t = activeRows.find(r => String(r.id) === String(tid));
      console.log(`    tenant ${tid} (${shortProp(t?.property)}): ${lineIds.length} lines, net Δ ${(sumByTenant[tid]||0).toFixed(2)}`);
    }
    if (unattributed > 0) {
      console.log(`    ⚠️  ${unattributed} unattributed lines remain on parent (DR ${unattributedDR.toFixed(2)} / CR ${unattributedCR.toFixed(2)})`);
    }

    // 5. Re-attribute lines (chunked update)
    if (APPLY) {
      for (const [tid, lineIds] of Object.entries(attribution)) {
        const newAcctId = perLeaseAccts[tid];
        for (let i = 0; i < lineIds.length; i += 100) {
          const chunk = lineIds.slice(i, i + 100);
          const { error } = await sb.from("acct_journal_lines")
            .update({ account_id: newAcctId, account_name: "AR - " + name + " (" + shortProp(activeRows.find(r => String(r.id) === String(tid))?.property) + ")" })
            .in("id", chunk);
          if (error) console.log(`    ❌ line update tenant ${tid}: ${error.message}`);
        }
      }
      console.log(`  ✓ lines re-attributed`);
    }

    // 6. Update recurring_journal_entries.debit_account_id for active tenants
    for (const row of activeRows) {
      if (!perLeaseAccts[row.id]) continue;
      console.log(`  ${APPLY ? "→" : "(dry)"} switch recurring rows for tenant ${row.id} debit_account_id → per-lease`);
      if (APPLY) {
        const { error } = await sb.from("recurring_journal_entries")
          .update({ debit_account_id: perLeaseAccts[row.id], debit_account_name: "AR - " + name + " (" + shortProp(row.property) + ")" })
          .eq("company_id", COMPANY_ID).eq("tenant_id", row.id);
        if (error) console.log(`    ❌ recurring update tenant ${row.id}: ${error.message}`);
      }
    }

    // 7. Recompute tenants.balance per active tenant from the new per-lease AR
    if (APPLY) {
      for (const row of activeRows) {
        const acctId = perLeaseAccts[row.id];
        if (!acctId || acctId.startsWith?.("DRYRUN-")) continue;
        const { data: ls } = await sb.from("acct_journal_lines")
          .select("debit, credit, acct_journal_entries!inner(status)")
          .eq("company_id", COMPANY_ID).eq("account_id", acctId)
          .neq("acct_journal_entries.status", "voided");
        const bal = (ls || []).reduce((s, l) => s + Number(l.debit || 0) - Number(l.credit || 0), 0);
        const { error } = await sb.from("tenants").update({ balance: bal }).eq("id", row.id).eq("company_id", COMPANY_ID);
        if (error) console.log(`    ❌ tenants.balance update id=${row.id}: ${error.message}`);
        else console.log(`    ✓ tenant ${row.id} balance set to ${bal.toFixed(2)}`);
      }
    }
  }

  console.log("\n================================================================");
  console.log(APPLY ? "✓ APPLIED" : "(dry-run only — re-run with --apply)");
})();
