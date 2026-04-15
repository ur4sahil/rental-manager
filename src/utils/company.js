import { supabase } from "../supabase";
import { pmError } from "./errors";
import { safeNum } from "./helpers";

// ============ COMPANY-SCOPED SUPABASE HELPERS ============
// Use these instead of raw supabase.from() to automatically filter by company_id
export function companyQuery(table, companyId) {
  if (!companyId) throw new Error("companyQuery: companyId is required");
  return supabase.from(table).select("*").eq("company_id", companyId);
}
export function companyInsert(table, rows, companyId) {
  if (!companyId) throw new Error("companyInsert: companyId is required");
  const cid = companyId;
  const withCompany = (Array.isArray(rows) ? rows : [rows]).map(r => ({ ...r, company_id: cid }));
  return supabase.from(table).insert(withCompany);
}
export function companyUpsert(table, rows, companyId, onConflict) {
  if (!companyId) throw new Error("companyUpsert: companyId is required");
  const cid = companyId;
  const withCompany = (Array.isArray(rows) ? rows : [rows]).map(r => ({ ...r, company_id: cid }));
  return supabase.from(table).upsert(withCompany, onConflict ? { onConflict } : undefined);
}

// RPC Health Check — validates critical database dependencies on app load
export async function checkRPCHealth(companyId) {
  try {
  const requiredRPCs = [
  "create_company_atomic",
  "archive_property",
  "update_tenant_balance",
  "sign_lease",
  ];
  const missing = [];
  for (const rpc of requiredRPCs) {
  try {
  const { error } = await supabase.rpc(rpc, {});
  if (error?.message?.includes("does not exist") || error?.message?.includes("could not find")) {
  missing.push(rpc);
  }
  } catch (e) {
  if (e.message?.includes("does not exist") || e.message?.includes("could not find")) {
  missing.push(rpc);
  }
  // Other errors (network, etc.) — skip silently
  }
  }
  if (missing.length > 0) {
  pmError("PM-8003", { raw: { message: "Missing RPCs: " + missing.join(", ") }, context: "RPC health check", silent: true });
  }
  return missing;
  } catch (e) {
  pmError("PM-8006", { raw: e, context: "RPC health check", silent: true });
  return []; // Never crash the app over a health check
  }
}

// ============ DATA INTEGRITY GUARDS (PM-9xxx) ============
export async function runDataIntegrityChecks(companyId, { deep = false } = {}) {
  const violations = [];
  try {
    // PM-9001: Unbalanced journal entries
    const { data: unbalancedJEs } = await supabase.rpc("find_unbalanced_jes", { p_company_id: companyId });
    if (unbalancedJEs?.length > 0) {
      for (const je of unbalancedJEs) {
        violations.push({ code: "PM-9001", details: `JE ${je.number} is out of balance by $${je.difference}`, meta: { jeId: je.id, jeNumber: je.number, difference: je.difference } });
      }
    }

    // PM-9002: Active tenants with no lease (deep only)
    if (deep) {
      const { data: activeTenants } = await supabase.from("tenants").select("id, name, property").eq("company_id", companyId).is("archived_at", null).eq("lease_status", "active");
      for (const t of (activeTenants || [])) {
        const { data: lease } = await supabase.from("leases").select("id").eq("company_id", companyId).eq("tenant_name", t.name).eq("status", "active").limit(1).maybeSingle();
        if (!lease) {
          violations.push({ code: "PM-9002", details: `Tenant "${t.name}" at ${t.property} has no active lease`, meta: { tenantId: t.id, tenantName: t.name } });
        }
      }
    }

    // PM-9006: Tenant balance vs ledger mismatch (deep only)
    if (deep) {
      const { data: tenants } = await supabase.from("tenants").select("id, name, balance").eq("company_id", companyId).is("archived_at", null);
      for (const t of (tenants || [])) {
        const { data: entries } = await supabase.from("ledger_entries").select("amount").eq("company_id", companyId).eq("tenant_id", t.id);
        const ledgerTotal = (entries || []).reduce((s, e) => s + safeNum(e.amount), 0);
        if (Math.abs(safeNum(t.balance) - ledgerTotal) > 0.01) {
          violations.push({ code: "PM-9006", details: `Tenant "${t.name}" balance ($${t.balance}) doesn't match ledger ($${ledgerTotal.toFixed(2)})`, meta: { tenantId: t.id, storedBalance: t.balance, ledgerTotal } });
        }
      }
    }

    // PM-9007: Recurring entries referencing inactive accounts
    const { data: recurEntries } = await supabase.from("recurring_journal_entries").select("id, description, template_lines_json").eq("company_id", companyId).eq("status", "active");
    const { data: activeAccounts } = await supabase.from("acct_accounts").select("id").eq("company_id", companyId).eq("is_active", true);
    const activeAccountIds = new Set((activeAccounts || []).map(a => a.id));
    for (const re of (recurEntries || [])) {
      const lines = re.template_lines_json || [];
      for (const line of lines) {
        if (line.account_id && !activeAccountIds.has(line.account_id)) {
          violations.push({ code: "PM-9007", details: `Recurring entry "${re.description}" references inactive account`, meta: { recurId: re.id, accountId: line.account_id } });
          break;
        }
      }
    }

    // PM-9008: Active leases referencing archived properties (deep only)
    if (deep) {
      const { data: activeLeases } = await supabase.from("leases").select("id, tenant_name, property_address").eq("company_id", companyId).eq("status", "active");
      for (const lease of (activeLeases || [])) {
        const { data: prop } = await supabase.from("properties").select("id").eq("company_id", companyId).eq("address", lease.property_address).is("archived_at", null).maybeSingle();
        if (!prop) {
          violations.push({ code: "PM-9008", details: `Lease for "${lease.tenant_name}" references archived/missing property "${lease.property_address}"`, meta: { leaseId: lease.id } });
        }
      }
    }

    // Log all violations silently
    for (const v of violations) {
      pmError(v.code, { context: v.details, meta: v.meta, silent: true });
    }
  } catch (e) {
    pmError("PM-8006", { raw: e, context: "data integrity checks", silent: true });
  }
  return violations;
}
