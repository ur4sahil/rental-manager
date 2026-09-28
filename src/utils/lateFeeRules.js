// Late fees: the reference and the one-per-month duplicate rule. No imports,
// and the only I/O goes through a client passed in (lateFeeAlreadyPostedWith),
// so tests load this file in plain node.
//
// Three paths charge late fees: the Late Fees page, the tenant "Late Fee"
// button (both via postTenantLateFee in lateFees.js) and the nightly
// batch_post_late_fees SQL job. They must agree on what "this tenant already
// has a late fee this month" means, or running two of them charges twice.
// The SQL twin of lateFeeAlreadyPostedInMonth is public.late_fee_already_posted
// (supabase/migrations/20260928050000_late_fees_one_rule_tenant_ar.sql).
// Change one, change the other.

export const LATE_FEE_INCOME_CODE = "4010";
export const LATE_FEE_INCOME_NAME = "Late Fee Income";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const hasId = (v) => v !== null && v !== undefined && String(v).trim() !== "";
const MONTH_RE = /^(\d{4})-(\d{2})$/;

// "YYYY-MM" for a Date (local calendar) or a "YYYY-MM-DD..." string.
export function lateFeeMonth(date) {
  if (typeof date === "string") {
    const m = /^(\d{4})-(\d{2})/.exec(date);
    return m ? m[1] + "-" + m[2] : null;
  }
  if (date instanceof Date && !isNaN(date)) {
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
  }
  return null;
}

// The one reference every path writes: LATEFEE-<tenant_id>-YYYYMM.
// null without a tenant id -- "LATEFEE-undefined-..." would be a single
// string the unique index then allows once per company per month.
export function lateFeeReference(tenantId, month) {
  if (!hasId(tenantId) || !MONTH_RE.test(String(month || ""))) return null;
  return "LATEFEE-" + String(tenantId).trim() + "-" + String(month).replace("-", "");
}

// Every reference that means "late fee for this tenant, this month":
// the canonical one, the nightly job's old hyphenated form and the Late
// Fees page's old LATE- form.
export function lateFeeReferences(tenantId, month) {
  const canonical = lateFeeReference(tenantId, month);
  if (!canonical) return [];
  const tid = String(tenantId).trim();
  return [canonical, "LATEFEE-" + tid + "-" + month, "LATE-" + tid + "-" + String(month).replace("-", "")];
}

// First and last day ("YYYY-MM-DD") of a "YYYY-MM" month.
export function lateFeeMonthBounds(month) {
  const m = MONTH_RE.exec(String(month || ""));
  if (!m) return null;
  const last = new Date(Number(m[1]), Number(m[2]), 0).getDate();
  return { start: month + "-01", end: month + "-" + String(last).padStart(2, "0") };
}

// Is this account the company's late-fee income account? Same test as SQL:
// code 4010 or name "Late Fee Income".
export function isLateFeeIncomeAccount(acct) {
  return !!acct && (String(acct.code || "") === LATE_FEE_INCOME_CODE || String(acct.name || "") === LATE_FEE_INCOME_NAME);
}

// THE RULE. A tenant already has a late fee for `month` if ANY non-voided
// journal entry dated in that month either
//   (a) carries one of lateFeeReferences(tenantId, month), or
//   (b) debits one of the tenant's own AR accounts (tenantArIds) and credits
//       a late-fee income account (incomeIds) -- a hand-entered late fee,
//       which has no reference.
// entries: [{ reference, date, status, lines: [{ account_id, debit, credit }] }]
export function lateFeeAlreadyPostedInMonth({ tenantId, month, entries, tenantArIds, incomeIds }) {
  const bounds = lateFeeMonthBounds(month);
  const refs = lateFeeReferences(tenantId, month);
  if (!bounds || refs.length === 0) return false;
  const ar = new Set((tenantArIds || []).filter(hasId).map(String));
  const inc = new Set((incomeIds || []).filter(hasId).map(String));
  return (entries || []).some(e => {
    if (!e) return false;
    if (String(e.status || "") === "voided") return false;
    const d = String(e.date || "").slice(0, 10);
    if (!(d >= bounds.start && d <= bounds.end)) return false;
    if (refs.includes(String(e.reference || ""))) return true;
    const lines = e.lines || [];
    const debitsAr = lines.some(l => l && ar.has(String(l.account_id)) && num(l.debit) > 0);
    const creditsIncome = lines.some(l => l && inc.has(String(l.account_id)) && num(l.credit) > 0);
    return debitsAr && creditsIncome;
  });
}

// ─── Gathering: run the rule against the database ───────────────────────
// Takes the Supabase client as an argument so this file keeps no imports and
// the test suite can run this exact code against the TEST project. The app
// calls it through lateFeeAlreadyPosted in lateFees.js.
//
// Fails CLOSED: any lookup error reports { already: true, error } so a
// network blip cannot let a second fee through.

const LINE_CAP = 1000;  // PostgREST's page size; a full page fails closed

export async function lateFeeAlreadyPostedWith(client, companyId, tenantId, month) {
  try {
    const bounds = lateFeeMonthBounds(month);
    const refs = lateFeeReferences(tenantId, month);
    if (!client || !companyId || !bounds || refs.length === 0) return { already: true, error: "missing company, tenant or month" };

    const [byRef, arAccts, incAccts] = await Promise.all([
      // (a) any of the three late-fee references, dated in the month
      client.from("acct_journal_entries").select("id, reference, date, status")
        .eq("company_id", companyId).in("reference", refs)
        .gte("date", bounds.start).lte("date", bounds.end).limit(20),
      // the tenant's own AR account(s)
      client.from("acct_accounts").select("id")
        .eq("company_id", companyId).eq("tenant_id", tenantId),
      // the company's late-fee income account(s)
      client.from("acct_accounts").select("id, code, name")
        .eq("company_id", companyId).or(`code.eq.${LATE_FEE_INCOME_CODE},name.eq."${LATE_FEE_INCOME_NAME}"`),
    ]);
    const firstErr = byRef.error || arAccts.error || incAccts.error;
    if (firstErr) return { already: true, error: firstErr.message };

    const tenantArIds = (arAccts.data || []).map(a => a.id);
    const incomeIds = (incAccts.data || []).filter(isLateFeeIncomeAccount).map(a => a.id);
    const entries = (byRef.data || []).map(e => ({ ...e, lines: [] }));

    // (b) entries in the month that debit the tenant's AR, with all their
    // lines so a credit to late-fee income can be seen. This is how a
    // hand-entered late fee (no reference) is recognised.
    if (tenantArIds.length > 0 && incomeIds.length > 0) {
      const { data: arLines, error: arErr } = await client.from("acct_journal_lines")
        .select("journal_entry_id, acct_journal_entries!inner(id, reference, date, status, company_id)")
        .in("account_id", tenantArIds).gt("debit", 0)
        .eq("acct_journal_entries.company_id", companyId)
        .gte("acct_journal_entries.date", bounds.start).lte("acct_journal_entries.date", bounds.end)
        .limit(LINE_CAP);
      if (arErr) return { already: true, error: arErr.message };
      // A full page might be a truncated one: refuse rather than guess.
      if ((arLines || []).length >= LINE_CAP) return { already: true, error: "too many receivable lines this month to check" };
      const heads = new Map();
      for (const l of arLines || []) {
        const je = Array.isArray(l.acct_journal_entries) ? l.acct_journal_entries[0] : l.acct_journal_entries;
        if (je && !heads.has(je.id)) heads.set(je.id, je);
      }
      const ids = [...heads.keys()];
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const { data: lines, error: lErr } = await client.from("acct_journal_lines")
          .select("journal_entry_id, account_id, debit, credit").in("journal_entry_id", chunk).limit(LINE_CAP);
        if (lErr) return { already: true, error: lErr.message };
        if ((lines || []).length >= LINE_CAP) return { already: true, error: "too many journal lines to check" };
        for (const id of chunk) {
          entries.push({ ...heads.get(id), lines: (lines || []).filter(l => l.journal_entry_id === id) });
        }
      }
    }
    return { already: lateFeeAlreadyPostedInMonth({ tenantId, month, entries, tenantArIds, incomeIds }), error: null };
  } catch (e) {
    return { already: true, error: e?.message || String(e) };
  }
}
