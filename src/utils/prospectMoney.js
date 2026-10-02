// Money a prospect pays before they are a tenant (see migration
// 20261003030000_prospect_money_held.sql for why it is a liability, and why
// each prospect has an account of their own).
//
// What is held is always READ OFF THE LEDGER -- the balance of the
// prospect's own account -- never stored as a number on the prospect. So it
// cannot disagree with the books, and money categorised to the prospect on
// the Banking page counts exactly like money recorded here.
import { supabase } from "../supabase";
import { formatLocalDate, shortId } from "./helpers";
import { pmError } from "./errors";
import { autoPostJournalEntry, resolveAccountId, checkPeriodLock } from "./accounting";

const cents = (n) => Math.round(Number(n) * 100) / 100;

/**
 * What a list of journal lines on a held-money account adds up to. PURE.
 * The account is a liability: money in is a credit, money out (a refund, or
 * the move to the tenant's ledger) is a debit. Voided entries do not count.
 * @returns {{ balance: number, entries: Array<{id,date,description,reference,amount:number}> }}  amount > 0 = received
 */
export function summarizeHeld(lines) {
  const entries = [];
  let balance = 0;
  for (const l of lines || []) {
    const je = Array.isArray(l.acct_journal_entries) ? l.acct_journal_entries[0] : l.acct_journal_entries;
    if (!je || String(je.status || "") === "voided") continue;
    const amount = cents((Number(l.credit) || 0) - (Number(l.debit) || 0));
    if (!amount) continue;
    balance = cents(balance + amount);
    entries.push({ id: l.id, date: String(je.date || "").slice(0, 10), description: je.description || l.memo || "", reference: je.reference || "", amount });
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return { balance, entries };
}

/** The prospect's held-money account, if one has been made. Does not create one. */
export async function findHeldAccount(companyId, prospectId) {
  const { data, error } = await supabase.from("acct_accounts").select("id, code, name, is_active")
    .eq("company_id", companyId).eq("prospect_id", prospectId).maybeSingle();
  if (error) return { error: error.message };
  return { account: data || null };
}

/**
 * What is held for a prospect right now.
 * @returns {Promise<{ ok: boolean, error?: string, account: null|{id,code,name,is_active}, balance: number, entries: Array }>}
 */
export async function heldForProspect(companyId, prospectId) {
  const found = await findHeldAccount(companyId, prospectId);
  if (found.error) return { ok: false, error: found.error, account: null, balance: 0, entries: [] };
  if (!found.account) return { ok: true, account: null, balance: 0, entries: [] };
  const { data, error } = await supabase.from("acct_journal_lines")
    .select("id, debit, credit, memo, acct_journal_entries!inner(date, description, reference, status)")
    .eq("company_id", companyId).eq("account_id", found.account.id).limit(1000);
  if (error) return { ok: false, error: error.message, account: found.account, balance: 0, entries: [] };
  return { ok: true, account: found.account, ...summarizeHeld(data) };
}

async function ensureHeldAccount(prospectId) {
  const { data, error } = await supabase.rpc("prospect_held_account", { p_prospect_id: prospectId });
  if (error || !data) return { error: error?.message || "the prospect's account could not be created" };
  return { id: data };
}

/**
 * Money received from a prospect: DR Checking / CR the prospect's held account.
 * Use this for money that is NOT going to be categorised from the bank feed
 * (that would count it twice); a bank deposit is categorised to the
 * prospect's account on the Banking page instead.
 */
export async function recordProspectMoney({ companyId, prospect, amount, date = formatLocalDate(new Date()), memo = "" }) {
  const amt = cents(amount);
  if (!(amt > 0)) return { ok: false, error: "Enter an amount more than zero." };
  if (await checkPeriodLock(companyId, date)) return { ok: false, error: "The books are closed for " + date + "." };
  const acct = await ensureHeldAccount(prospect.id);
  if (acct.error) return { ok: false, error: acct.error };
  const cash = await resolveAccountId("1000", companyId);
  if (!cash) return { ok: false, error: "The Checking account (1000) was not found in the chart of accounts." };
  const what = "Money received from prospect — " + prospect.name + (memo ? " — " + memo : "");
  const jeId = await autoPostJournalEntry({
    companyId, date, description: what, reference: "HELD-P" + String(prospect.id).slice(0, 8) + "-" + shortId(), property: prospect.property || "",
    lines: [
      { account_id: cash, account_name: "Checking Account", debit: amt, credit: 0, memo: what },
      { account_id: acct.id, account_name: "Held - " + prospect.name, debit: 0, credit: amt, memo: memo || "Received before move-in" },
    ],
  });
  return jeId ? { ok: true, jeId } : { ok: false, error: "The entry was not posted." };
}

/** Money returned to a prospect: DR their held account / CR Checking. Never more than is held. */
export async function refundProspectMoney({ companyId, prospect, amount, date = formatLocalDate(new Date()), memo = "" }) {
  const amt = cents(amount);
  if (!(amt > 0)) return { ok: false, error: "Enter an amount more than zero." };
  if (await checkPeriodLock(companyId, date)) return { ok: false, error: "The books are closed for " + date + "." };
  const held = await heldForProspect(companyId, prospect.id);
  if (!held.ok) return { ok: false, error: held.error };
  if (!held.account || amt > held.balance + 0.001) return { ok: false, error: "Only " + held.balance.toFixed(2) + " is held for " + prospect.name + "." };
  const cash = await resolveAccountId("1000", companyId);
  if (!cash) return { ok: false, error: "The Checking account (1000) was not found in the chart of accounts." };
  const what = "Refund to prospect — " + prospect.name + (memo ? " — " + memo : "");
  const jeId = await autoPostJournalEntry({
    companyId, date, description: what, reference: "HELDREF-P" + String(prospect.id).slice(0, 8) + "-" + shortId(), property: prospect.property || "",
    lines: [
      { account_id: held.account.id, account_name: held.account.name, debit: amt, credit: 0, memo: memo || "Refunded" },
      { account_id: cash, account_name: "Checking Account", debit: 0, credit: amt, memo: what },
    ],
  });
  return jeId ? { ok: true, jeId } : { ok: false, error: "The entry was not posted." };
}

/**
 * On conversion: whatever is held for the prospect becomes a payment on the
 * tenant's own ledger (DR held / CR the tenant's receivable), and the held
 * account is closed. Can be run again: the entry has one reference per
 * tenant, and once the balance is zero there is nothing left to move.
 * @returns {Promise<{ status: "done"|"already"|"skipped"|"failed"|"locked", detail?: string, amount?: number }>}
 */
export async function applyHeldToTenant({ companyId, prospectId, tenantId, tenantName, property = "", arAccountId, classId = null, date = formatLocalDate(new Date()) }) {
  try {
    const held = await heldForProspect(companyId, prospectId);
    if (!held.ok) return { status: "failed", detail: "could not read what is held: " + held.error };
    if (!held.account) return { status: "skipped", detail: "nothing was received before move-in" };
    const ref = "HELD-T" + tenantId;
    if (held.balance > 0.004) {
      const { data: have, error: haveErr } = await supabase.from("acct_journal_entries").select("id")
        .eq("company_id", companyId).eq("reference", ref).neq("status", "voided").limit(1);
      if (haveErr) return { status: "failed", detail: "could not check whether it was already moved" };
      // Moved once already and money has come in since: that later money is
      // a person's job to place, not something to sweep in silently.
      if ((have || []).length) return { status: "failed", detail: held.balance.toFixed(2) + " arrived after the first move and is still held: post it to the tenant's ledger by journal entry" };
      if (await checkPeriodLock(companyId, date)) return { status: "locked", detail: "the books are closed for " + date };
      const what = "Money received before move-in applied — " + tenantName;
      const jeId = await autoPostJournalEntry({
        companyId, date, description: what, reference: ref, property,
        lines: [
          { account_id: held.account.id, account_name: held.account.name, debit: held.balance, credit: 0, class_id: classId, memo: what },
          { account_id: arAccountId, account_name: "AR - " + tenantName, debit: 0, credit: held.balance, class_id: classId, memo: "Payment received before move-in" },
        ],
      });
      if (!jeId) return { status: "failed", detail: "entry was not posted" };
    } else if (held.balance < -0.004) {
      return { status: "failed", detail: "the prospect's account shows more refunded than received; correct it in Accounting" };
    }
    // Nothing held any more: close the account so nothing else is posted to it.
    if (held.account.is_active !== false) {
      const { error } = await supabase.from("acct_accounts").update({ is_active: false }).eq("company_id", companyId).eq("id", held.account.id);
      if (error) pmError("PM-4006", { raw: error, context: "close prospect held account", silent: true });
    }
    return held.balance > 0.004 ? { status: "done", amount: held.balance } : { status: "already" };
  } catch (e) {
    pmError("PM-4002", { raw: e, context: "tenancy books: money held", silent: true });
    return { status: "failed", detail: e?.message || "" };
  }
}
