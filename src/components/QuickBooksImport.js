// ============ QUICKBOOKS LEDGER IMPORT — WIZARD ============
//
// Walks a QuickBooks Online company's general ledger into PropManager.
// Parsing and mapping happen entirely in the browser (src/utils/qbImport.js);
// nothing is written until the user commits on the Preview step, and the
// commit goes to /api/qb-import, which does the bulk write server-side.
//
// Lives in its own file rather than inside Accounting.js: that file is
// already ~4,500 lines and imports Banking.js, so adding a component that
// needs both would risk a circular import.

import React, { useState, useMemo } from "react";
import { supabase } from "../supabase";
import { Btn, Checkbox, FileInput, Select, TextLink } from "../ui";
import { formatCurrency, safeNum } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { Spinner } from "./shared";
import {
  QB_FILE_GROUPS, parseWorkbook, parseAccountList, isAccountListShape, groupTransactions,
  buildImportPlan, buildEntriesPayload, buildTrialBalance,
} from "../utils/qbImport";

const STEPS = [
  { n: 1, label: "Files" },
  { n: 2, label: "Accounts" },
  { n: 3, label: "Entities" },
  { n: 4, label: "Review" },
  { n: 5, label: "Import" },
];

// One chunk per request. Sized down from 250 because on a slow or flaky
// connection the chunk is the unit of loss: a drop mid-chunk means
// re-sending all of it. 100 entries is roughly 90KB, so a failure costs
// seconds rather than a minute, and progress moves visibly.
const CHUNK = 100;

// Mirrors DEFAULT_ACCOUNT_TYPES / DEFAULT_ACCOUNT_SUBTYPES in
// Accounting.js. Duplicated rather than imported because Accounting.js
// imports this component, and a back-import would be circular.
const ACCOUNT_TYPE_OPTIONS = ["Asset","Liability","Equity","Revenue","Cost of Goods Sold","Expense","Other Income","Other Expense"];
const ACCOUNT_SUBTYPE_OPTIONS = {
  Asset: ["Bank","Accounts Receivable","Other Current Asset","Fixed Asset","Other Asset"],
  Liability: ["Accounts Payable","Credit Card","Other Current Liability","Long Term Liability"],
  Equity: ["Owners Equity","Retained Earnings","Common Stock"],
  Revenue: ["Rental Income","Other Primary Income","Service Income"],
  "Cost of Goods Sold": ["Cost of Goods Sold","Supplies & Materials"],
  Expense: ["Advertising & Marketing","Auto","Bank Charges","Depreciation","Insurance","Maintenance & Repairs","Meals & Entertainment","Office Supplies","Professional Fees","Property Tax","Rent & Lease","Utilities","Wages & Salaries","Other Expense"],
  "Other Income": ["Interest Earned","Late Fees","Other Miscellaneous Income"],
  "Other Expense": ["Depreciation","Other Miscellaneous Expense"],
};

// Guess which account group a file holds from its name, so the common
// case needs no clicks. Always overridable: a Transaction Report does
// not state its own type anywhere, so this is a hint, not a fact.
function guessGroup(filename) {
  const f = (filename || "").toLowerCase();
  if (/liab|loan|payable|equity/.test(f)) return "liability";
  if (/p&l|pl\b|profit|income|expense/.test(f)) return "pl";
  return "asset";
}

export function QuickBooksImport({ companyId, accounts = [], showToast, showConfirm, userProfile, onComplete }) {
  const [step, setStep] = useState(1);
  const [files, setFiles] = useState([]);        // { name, group, parsed, error }
  const [busy, setBusy] = useState("");
  const [plan, setPlan] = useState(null);
  const [options, setOptions] = useState({ status: "posted", includeUnbalanced: false });
  const [progress, setProgress] = useState(null); // { phase, done, total }
  const [result, setResult] = useState(null);
  const [pickerKey, setPickerKey] = useState(0);
  // QuickBooks' own Account List, when supplied. It states every
  // account's Type and Detail type, which removes all guessing about
  // how accounts are classified.
  const [accountList, setAccountList] = useState(null);

  // ---- derived ------------------------------------------------------
  const allRows = useMemo(
    () => files.filter(f => f.parsed && !f.isAccountList).flatMap(f => f.parsed.rows),
    [files]
  );
  const grouped = useMemo(
    () => (allRows.length ? groupTransactions(allRows) : null),
    [allRows]
  );
  const trialBalance = useMemo(
    () => (allRows.length ? buildTrialBalance(allRows) : null),
    [allRows]
  );

  // A QuickBooks transaction's legs live in DIFFERENT files — the
  // receivable side in the assets export, the income side in the P&L. If
  // any group is missing, the totals cannot balance and importing would
  // create one-sided journal entries. So the check is not cosmetic: a
  // material imbalance means a file is missing, and Import stays blocked.
  const groupsLoaded = useMemo(() => {
    const g = new Set(files.filter(f => f.parsed && !f.isAccountList).map(f => f.group));
    return { asset: g.has("asset"), liability: g.has("liability") || g.has("equity"), pl: g.has("pl") };
  }, [files]);
  const balances = trialBalance ? Math.abs(trialBalance.difference) < 0.005 : false;
  const missingGroups = Object.entries(groupsLoaded).filter(([, v]) => !v)
    .map(([k]) => ({ asset: "Assets", liability: "Liabilities & Equity", pl: "Profit & Loss" }[k]));

  // ---- step 1: files ------------------------------------------------
  async function addFiles(fileList) {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;
    setBusy("Reading workbooks…");
    const next = [...files];
    for (const file of incoming) {
      if (!/\.xlsx$/i.test(file.name)) {
        next.push({ name: file.name, group: "asset", error: "Not an .xlsx file" });
        continue;
      }
      const group = guessGroup(file.name);
      try {
        const buf = await file.arrayBuffer();
        // An Account List has no Transaction date column; route it aside.
        if (/account\s*list/i.test(file.name)) {
          const al = await parseAccountList(buf.slice(0), file.name);
          if (al.accounts.size > 0) {
            setAccountList(al.accounts);
            next.push({ name: file.name, isAccountList: true, count: al.accounts.size, group: null });
            setPlan(null);
            await new Promise(r => setTimeout(r, 0));
            continue;
          }
        }
        const parsed = await parseWorkbook(buf.slice(0), file.name, group);
        // Hold the buffer: ExcelJS consumes the File, and changing a
        // file's account group has to re-parse it.
        next.push({ name: file.name, group, buf, parsed, error: parsed.shape ? null : (parsed.warnings[0] || "Unrecognised file") });
      } catch (e) {
        pmError("PM-5001", { raw: e, context: "QuickBooks workbook parse: " + file.name });
        next.push({ name: file.name, group, error: String(e?.message || e).slice(0, 160) });
      }
      // Yield so the spinner paints between files — ExcelJS is synchronous
      // enough to freeze the tab on a 9,000-row workbook otherwise.
      await new Promise(r => setTimeout(r, 0));
    }
    setFiles(next);
    setBusy("");
    setPickerKey(k => k + 1); // reset the picker so the same file can be re-added
  }

  // Re-parse a file when its account group changes: the group decides
  // whether a Transaction Report's accounts are assets, liabilities or
  // equity, which in turn drives every account's type.
  async function changeGroup(idx, group) {
    const f = files[idx];
    if (!f?.buf) {
      setFiles(files.map((x, i) => (i === idx ? { ...x, group } : x)));
      return;
    }
    setBusy("Re-reading " + f.name + "…");
    await new Promise(r => setTimeout(r, 0));
    try {
      // ExcelJS detaches the ArrayBuffer it loads, so hand it a copy and
      // keep the original for any later group change.
      const parsed = await parseWorkbook(f.buf.slice(0), f.name, group);
      setFiles(files.map((x, i) => (i === idx ? { ...x, group, parsed } : x)));
      // The plan is derived from the parsed rows, so it is now stale.
      setPlan(null);
    } catch (e) {
      pmError("PM-5001", { raw: e, context: "QuickBooks re-parse for group change" });
    }
    setBusy("");
  }

  function removeFile(idx) { setFiles(files.filter((_, i) => i !== idx)); setPlan(null); }

  async function goToAccounts() {
    if (!allRows.length) { showToast("Add at least one readable QuickBooks export.", "error"); return; }
    setBusy("Building the mapping plan…");
    await new Promise(r => setTimeout(r, 0));
    setPlan(buildImportPlan({ rows: allRows, existingAccounts: accounts, accountList }));
    setBusy("");
    setStep(2);
  }

  // ---- step 2: accounts ---------------------------------------------
  function updateAccount(path, patch) {
    setPlan(p => ({ ...p, accounts: p.accounts.map(a => (a.path === path ? { ...a, ...patch } : a)) }));
  }

  const accountStats = useMemo(() => {
    if (!plan) return null;
    const s = { create: 0, map: 0, skip: 0, tenantAr: 0 };
    plan.accounts.forEach(a => { s[a.action] = (s[a.action] || 0) + 1; if (a.role === "tenant_ar") s.tenantAr++; });
    return s;
  }, [plan]);

  // ---- step 5: the actual import ------------------------------------
  async function runImport() {
    if (!guardSubmit("qbImport", companyId)) return;
    setStep(5);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      if (!token) { showToast("Session expired — sign in again.", "error"); return; }
      // The import rides on /api/encrypt as the qb_* actions — Vercel
      // counts each non-underscore api/*.js as a serverless function and
      // the project is at its 12-function cap, so the logic lives in
      // api/_qb-import-impl.js behind a route that already does exactly
      // the auth it needs.
      // Retry transient failures. An import is ~27 sequential requests
      // over a couple of minutes, so a single dropped connection would
      // otherwise abandon the run half-written. Retrying is safe because
      // every chunk is keyed on its journal-entry references: a chunk
      // that already landed re-runs as a no-op, and one that half-landed
      // is repaired.
      const call = async (payload, attempt = 0) => {
        let r, json;
        try {
          r = await fetch("/api/encrypt", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
            body: JSON.stringify({ companyId, ...payload }),
          });
          json = await r.json().catch(() => ({}));
        } catch (netErr) {
          // Network-level failure — no response at all.
          // Exponential backoff, and patient: a domestic connection can
          // drop for a minute at a time, and giving up strands the import
          // half-written. Every chunk is idempotent, so retrying costs
          // nothing but time.
          if (attempt < 6) {
            const wait = Math.min(30000, 2000 * Math.pow(2, attempt));
            setProgress(pr => pr ? { ...pr, note: `Connection interrupted — retrying in ${Math.round(wait/1000)}s (attempt ${attempt + 2} of 7)` } : pr);
            await new Promise(res => setTimeout(res, wait));
            return call(payload, attempt + 1);
          }
          throw new Error("Lost connection to the server after several attempts. Nothing is corrupted — reconnect and "
            + "run the import again; it resumes from where it stopped.");
        }
        if (!r.ok) {
          // 5xx is worth retrying; a 4xx is our own bad request and won't
          // get better by repeating it.
          if (r.status >= 500 && attempt < 6) {
            const wait = Math.min(30000, 2000 * Math.pow(2, attempt));
            setProgress(pr => pr ? { ...pr, note: `Server busy — retrying in ${Math.round(wait/1000)}s` } : pr);
            await new Promise(res => setTimeout(res, wait));
            return call(payload, attempt + 1);
          }
          throw new Error(json.error || `Import failed (${r.status})`);
        }
        return json;
      };

      // 1. Create every dimension the lines reference.
      setProgress({ phase: "Creating accounts, classes and entities…", done: 0, total: 1 });
      const creates = plan.accounts.filter(a => a.action === "create");
      const resolved = await call({
        action: "qb_resolve",
        accounts: creates.map(a => ({
          code: a.code, name: a.role === "tenant_ar" ? `AR - ${a.tenantName}` : a.leaf,
          type: a.type, subtype: a.subtype || null,
          tenantName: a.role === "tenant_ar" ? a.tenantName : null,
          description: `Imported from QuickBooks (${a.path})`,
        })),
        classes: plan.classes.map(c => ({ name: c.name })),
        properties: plan.properties.map(p => ({ address: p.address })),
        tenants: plan.tenants.map(t => ({ name: t.name, property: t.property })),
        vendors: plan.vendors.map(v => ({ name: v.name })),
      });

      // 2. Map every QB account path to the id its lines must carry.
      const accountIdByPath = {};
      for (const a of plan.accounts) {
        if (a.action === "skip") continue;
        accountIdByPath[a.path] = a.action === "map" ? a.targetAccountId : resolved.accountMap[a.code];
      }

      const entries = buildEntriesPayload({
        transactions: grouped.transactions,
        accountIdByPath,
        classIdByName: resolved.classMap || {},
        vendorIdByName: resolved.vendorMap || {},
        includeUnbalanced: options.includeUnbalanced,
      });

      if (entries.dropped && entries.dropped.length) {
        // Accounts left on "Skip" mean whole transactions cannot be
        // written. Never post the rest of such an entry — a half entry
        // unbalances the books while looking legitimate.
        const paths = [...new Set(entries.dropped.map(d => d.accountPath))];
        throw new Error(
          `${entries.dropped.length} transactions reference accounts that were skipped in mapping ` +
          `(${paths.slice(0, 3).join(", ")}${paths.length > 3 ? `, +${paths.length - 3} more` : ""}). ` +
          `Go back to Accounts and map or create them — importing would leave those entries one-sided.`);
      }

      // 3. Post in chunks. Every chunk is idempotent on its references,
      //    so a retry after a failure re-sends safely.
      let inserted = 0, skipped = 0, lines = 0;
      const startedAt = Date.now();
      const chunks = [];
      for (let i = 0; i < entries.length; i += CHUNK) chunks.push(entries.slice(i, i + CHUNK));
      for (let i = 0; i < chunks.length; i++) {
        setProgress({ phase: "Posting journal entries…", done: i, total: chunks.length,
                      startedAt: startedAt, entries: entries.length });
        const r = await call({ action: "qb_entries", entries: chunks[i], status: options.status });
        inserted += r.inserted; skipped += r.skipped; lines += r.lines;
      }

      setProgress({ phase: "Finalising…", done: chunks.length, total: chunks.length });
      const fin = await call({ action: "qb_finalize" });

      setResult({ inserted, skipped, lines, created: resolved.created, importedEntries: fin.importedEntries, balancesUpdated: fin.balancesUpdated });
      setProgress(null);
      showToast(`Imported ${inserted.toLocaleString()} journal entries.`, "success");
      if (onComplete) onComplete();
    } catch (e) {
      setProgress(null);
      pmError("PM-4002", { raw: e, context: "QuickBooks ledger import" });
      showToast("Import failed: " + String(e?.message || e).slice(0, 160), "error");
    } finally {
      guardRelease("qbImport", companyId);
    }
  }

  async function rollback() {
    if (!await showConfirm({ message: "Delete every journal entry this import created? Accounts, properties, tenants and vendors are kept." })) return;
    setBusy("Rolling back…");
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const r = await fetch("/api/encrypt", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ companyId, action: "qb_rollback" }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || "Rollback failed");
      showToast(`Rolled back ${json.deleted} journal entries.`, "success");
      setResult(null); setStep(1); setFiles([]); setPlan(null);
      if (onComplete) onComplete();
    } catch (e) {
      pmError("PM-4002", { raw: e, context: "QuickBooks import rollback" });
    }
    setBusy("");
  }

  // ---- render -------------------------------------------------------
  return (
  <div className="space-y-4">
    <div>
      <h2 className="text-lg font-semibold text-neutral-800">Import from QuickBooks</h2>
      <p className="text-xs text-neutral-500">Bring a QuickBooks Online general ledger into this company, transaction by transaction.</p>
    </div>

    {/* step bar */}
    <div className="flex items-center gap-2">
      {STEPS.map((s, i) => (
        <React.Fragment key={s.n}>
          <div className={`flex items-center gap-1.5 text-xs font-medium ${step === s.n ? "text-neutral-800" : step > s.n ? "text-success-600" : "text-neutral-300"}`}>
            <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${step === s.n ? "bg-neutral-800 text-white" : step > s.n ? "bg-success-100 text-success-700" : "bg-neutral-100"}`}>
              {step > s.n ? "✓" : s.n}
            </span>
            {s.label}
          </div>
          {i < STEPS.length - 1 && <div className={`h-px flex-1 ${step > s.n ? "bg-success-200" : "bg-neutral-200"}`} />}
        </React.Fragment>
      ))}
    </div>

    {busy && <div className="flex items-center gap-2 text-xs text-neutral-500"><Spinner /> {busy}</div>}

    {/* ── 1. FILES ────────────────────────────────────────────── */}
    {step === 1 && (
    <div className="bg-white rounded-xl border border-neutral-200 p-4 space-y-3">
      <div>
        <p className="text-sm font-medium text-neutral-700">Add your QuickBooks exports</p>
        <p className="text-xs text-neutral-500 mt-0.5">
          In QuickBooks: <strong>Reports → Transaction Report</strong> for assets, liabilities and equity, and
          <strong> Profit and Loss Detail</strong> for income and expenses. Export each as .xlsx over the full date range.
          Add one file per account group — assets, liabilities &amp; equity, and P&amp;L — so every side of each transaction is present.
          Also add <strong>Reports → Account List</strong> if you have it: it states every account's type, so nothing has to be guessed.
        </p>
      </div>
      <FileInput key={pickerKey} accept=".xlsx" multiple onChange={e => addFiles(e.target.files)} />

      {files.length > 0 && (
      <table className="w-full text-xs">
        <thead><tr className="text-neutral-400 text-left">
          <th className="py-1.5">FILE</th><th>DETECTED</th><th>CONTAINS</th><th className="text-right">ROWS</th><th></th>
        </tr></thead>
        <tbody>
          {files.map((f, i) => (
          <tr key={i} className="border-t border-neutral-100">
            <td className="py-1.5 pr-3 text-neutral-800">{f.name}</td>
            <td className="pr-3">
              {f.error
                ? <span className="text-danger-600">{f.error}</span>
                : f.isAccountList
                  ? <span className="text-success-700">Account List — account types</span>
                  : <span className="text-neutral-500">{f.parsed.shape === "pl-detail" ? "Profit & Loss Detail" : "Transaction Report"}</span>}
            </td>
            <td className="pr-3">
              {f.isAccountList ? <span className="text-neutral-400">—</span> :
              <Select value={f.group} size="sm" disabled={!f.parsed || f.parsed.shape === "pl-detail"}
                onChange={e => changeGroup(i, e.target.value)}>
                {QB_FILE_GROUPS.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
              </Select>}
            </td>
            <td className="text-right pr-3 font-mono text-neutral-700">{f.isAccountList ? f.count.toLocaleString() + " accounts" : (f.parsed ? f.parsed.rows.length.toLocaleString() : "—")}</td>
            <td className="text-right"><TextLink tone="danger" size="xs" onClick={() => removeFile(i)}>Remove</TextLink></td>
          </tr>
          ))}
        </tbody>
      </table>
      )}

      {files.some(f => f.parsed) && (
      <div className="flex flex-wrap gap-2 text-xs">
        {[["asset","Assets"],["liability","Liabilities & Equity"],["pl","Profit & Loss"]].map(([k,label]) => (
          <span key={k} className={`px-2 py-1 rounded-full ${groupsLoaded[k] ? "bg-success-50 text-success-700" : "bg-warn-50 text-warn-700"}`}>
            {groupsLoaded[k] ? "\u2713" : "\u2014"} {label}
          </span>
        ))}
      </div>
      )}

      {grouped && (
      <div className="text-xs text-neutral-600 bg-neutral-50 rounded-lg px-3 py-2">
        {grouped.totals.entries.toLocaleString()} transactions · {grouped.totals.lines.toLocaleString()} lines ·
        {" "}{grouped.totals.dateFrom} to {grouped.totals.dateTo} ·
        {" "}debits {formatCurrency(grouped.totals.debit)} / credits {formatCurrency(grouped.totals.credit)}
        {Math.abs(grouped.totals.difference) >= 0.005 && (
          <span className="text-warn-700"> · out of balance by {formatCurrency(grouped.totals.difference)}</span>
        )}
      </div>
      )}

      <div className="flex justify-end"><Btn onClick={goToAccounts} disabled={!allRows.length}>Continue</Btn></div>
    </div>
    )}

    {/* ── 2. ACCOUNTS ─────────────────────────────────────────── */}
    {step === 2 && plan && (
    <div className="bg-white rounded-xl border border-neutral-200 p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium text-neutral-700">{plan.accounts.length} accounts found</p>
        <p className="text-xs text-neutral-500">
          {accountStats.create} to create · {accountStats.map} mapped to existing · {accountStats.skip} skipped
          {accountStats.tenantAr > 0 && <> · {accountStats.tenantAr} tenant receivables</>}
        </p>
      </div>
      <p className="text-xs text-neutral-500">
        Type comes from the file each account was found in (and, for Profit &amp; Loss, from its section) — that part isn't
        guessed. <strong>Subtype is inferred from the account name</strong> and decides how the Balance Sheet groups it, so
        check anything that looks wrong; both are editable here. Tenant receivables are identified from the Customer column
        on each account's own transactions, with the evidence shown.
      </p>
      <div className="max-h-96 overflow-y-auto border border-neutral-100 rounded-lg">
      <table className="w-full text-xs">
        <thead className="bg-neutral-50 sticky top-0"><tr className="text-neutral-400 text-left">
          <th className="px-2 py-1.5">QUICKBOOKS ACCOUNT</th><th className="px-2">TYPE</th><th className="px-2">SUBTYPE</th>
          <th className="text-right">LINES</th><th className="text-right">NET</th><th className="px-2">ACTION</th><th className="px-2">TARGET</th>
        </tr></thead>
        <tbody>
          {plan.accounts.map(a => (
          <tr key={a.path} className="border-t border-neutral-100">
            <td className="px-2 py-1.5 text-neutral-800 max-w-xs truncate" title={a.path}>
              {a.path}
              {a.role === "tenant_ar" && (
                <span className="ml-1.5 text-[10px] bg-brand-50 text-brand-700 px-1.5 py-0.5 rounded-full"
                      title={a.roleReason || ""}>tenant AR</span>
              )}
              {a.roleReason && <div className="text-[10px] text-neutral-400 truncate" title={a.roleReason}>{a.roleReason}</div>}
            </td>
            <td className="px-2">
              <Select value={a.type} size="sm" onChange={e => updateAccount(a.path, { type: e.target.value, subtype: "" })}>
                {ACCOUNT_TYPE_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
              </Select>
            </td>
            <td className="px-2">
              <Select value={a.subtype || ""} size="sm" onChange={e => updateAccount(a.path, { subtype: e.target.value })}>
                <option value="">— none —</option>
                {(ACCOUNT_SUBTYPE_OPTIONS[a.type] || []).map(t => <option key={t} value={t}>{t}</option>)}
              </Select>
            </td>
            <td className="text-right font-mono text-neutral-500">{a.lineCount}</td>
            <td className="text-right font-mono text-neutral-700">{formatCurrency(a.net)}</td>
            <td className="px-2">
              <Select value={a.action} size="sm" onChange={e => updateAccount(a.path, { action: e.target.value })}>
                <option value="create">Create new</option>
                <option value="map">Map to existing</option>
                <option value="skip">Skip</option>
              </Select>
            </td>
            <td className="px-2 min-w-48">
              {a.action === "create" && <span className="text-neutral-400 font-mono">{a.code} {a.role === "tenant_ar" ? `AR - ${a.tenantName}` : a.leaf}</span>}
              {a.action === "map" && (
                <Select value={a.targetAccountId || ""} size="sm" onChange={e => updateAccount(a.path, { targetAccountId: e.target.value })}>
                  <option value="">Choose an account…</option>
                  {accounts.map(ex => <option key={ex.id} value={ex.id}>{ex.code} {ex.name}</option>)}
                </Select>
              )}
              {a.action === "map" && a.suggestion && (
                <div className="text-[10px] text-neutral-400 mt-0.5">{a.suggestion.reason}</div>
              )}
            </td>
          </tr>
          ))}
        </tbody>
      </table>
      </div>
      <div className="flex justify-between">
        <Btn variant="secondary" onClick={() => setStep(1)}>Back</Btn>
        <Btn onClick={() => setStep(3)}
          disabled={plan.accounts.some(a => a.action === "map" && !a.targetAccountId)}>Continue</Btn>
      </div>
    </div>
    )}

    {/* ── 3. ENTITIES ─────────────────────────────────────────── */}
    {step === 3 && plan && (
    <div className="bg-white rounded-xl border border-neutral-200 p-4 space-y-4">
      <p className="text-xs text-neutral-500">
        These come from the Property, Customer and Vendor columns in your exports. Properties become classes so every
        line carries per-property attribution; customers become tenants; vendors become vendor records.
      </p>
      {[
        ["Properties", plan.properties.map(p => p.address)],
        ["Tenants", plan.tenants.map(t => t.property ? `${t.name} — ${t.property}` : t.name)],
        ["Vendors", plan.vendors.map(v => v.name)],
      ].map(([label, items]) => (
        <div key={label}>
          <p className="text-sm font-medium text-neutral-700 mb-1">{label} <span className="text-neutral-400 font-normal">({items.length})</span></p>
          <div className="max-h-32 overflow-y-auto flex flex-wrap gap-1">
            {items.map((n, i) => <span key={i} className="text-[11px] bg-neutral-100 text-neutral-600 px-2 py-0.5 rounded-full">{n}</span>)}
          </div>
        </div>
      ))}
      <div className="flex justify-between">
        <Btn variant="secondary" onClick={() => setStep(2)}>Back</Btn>
        <Btn onClick={() => setStep(4)}>Continue</Btn>
      </div>
    </div>
    )}

    {/* ── 4. REVIEW ───────────────────────────────────────────── */}
    {step === 4 && plan && grouped && (
    <div className="bg-white rounded-xl border border-neutral-200 p-4 space-y-4">
      <div>
        <p className="text-sm font-medium text-neutral-700 mb-2">Projected trial balance</p>
        <table className="w-full text-xs">
          <thead><tr className="text-neutral-400 text-left">
            <th className="py-1">TYPE</th><th className="text-right">ACCOUNTS</th><th className="text-right">LINES</th>
            <th className="text-right">DEBIT</th><th className="text-right">CREDIT</th>
          </tr></thead>
          <tbody>
            {trialBalance.byType.map(t => (
            <tr key={t.type} className="border-t border-neutral-100">
              <td className="py-1 text-neutral-700">{t.type}</td>
              <td className="text-right font-mono text-neutral-500">{t.accounts}</td>
              <td className="text-right font-mono text-neutral-500">{t.lines}</td>
              <td className="text-right font-mono">{formatCurrency(t.debit)}</td>
              <td className="text-right font-mono">{formatCurrency(t.credit)}</td>
            </tr>
            ))}
            <tr className="border-t-2 border-neutral-300 font-semibold text-neutral-800">
              <td className="py-1" colSpan={3}>Total</td>
              <td className="text-right font-mono">{formatCurrency(trialBalance.debit)}</td>
              <td className="text-right font-mono">{formatCurrency(trialBalance.credit)}</td>
            </tr>
          </tbody>
        </table>
        <p className={`text-xs mt-1 ${Math.abs(trialBalance.difference) < 0.005 ? "text-success-700" : "text-warn-700"}`}>
          {Math.abs(trialBalance.difference) < 0.005
            ? "Debits equal credits — the ledger balances."
            : `Out of balance by ${formatCurrency(trialBalance.difference)}. A whole account group is probably missing from your exports.`}
        </p>
      </div>

      {grouped.unbalanced.length > 0 && (
      <div className="bg-warn-50 border border-warn-200 rounded-lg px-3 py-2 text-xs text-warn-800 space-y-1">
        <p className="font-medium">{grouped.unbalanced.length} transactions don't balance on their own
          {Math.abs(grouped.totals.unbalancedNet) < 0.005 && <> (they cancel out to zero overall)</>}.</p>
        <p>Each is missing a leg that isn't in the files you uploaded — so they are skipped. To include them, add the
          missing export <strong>to this same screen</strong> and import once with every file loaded together.</p>
        <label className="flex items-center gap-2 pt-1">
          <Checkbox checked={options.includeUnbalanced} onChange={e => setOptions({ ...options, includeUnbalanced: e.target.checked })} />
          <span>Import them anyway (they will post out of balance)</span>
        </label>
      </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        {[["Journal entries", options.includeUnbalanced ? grouped.totals.entries : grouped.totals.balancedEntries],
          ["Journal lines", grouped.totals.lines],
          ["Accounts created", plan.accounts.filter(a => a.action === "create").length],
          ["Classes / tenants / vendors", `${plan.classes.length} / ${plan.tenants.length} / ${plan.vendors.length}`]].map(([l, v]) => (
          <div key={l} className="bg-neutral-50 rounded-lg px-3 py-2">
            <div className="text-neutral-400">{l}</div>
            <div className="text-neutral-800 font-semibold">{typeof v === "number" ? v.toLocaleString() : v}</div>
          </div>
        ))}
      </div>

      <label className="flex items-center gap-2 text-xs text-neutral-600">
        <Checkbox checked={options.status === "posted"} onChange={e => setOptions({ ...options, status: e.target.checked ? "posted" : "draft" })} />
        <span>Post entries immediately (uncheck to import them as drafts)</span>
      </label>

      {!balances && (
      <div className="bg-danger-50 border border-danger-200 rounded-lg px-3 py-2 text-xs text-danger-700 space-y-1">
        <p className="font-medium">These files don't balance — {formatCurrency(Math.abs(trialBalance.difference))} of
          {trialBalance.difference > 0 ? " debits" : " credits"} have no matching side.</p>
        <p>
          A QuickBooks transaction is split across exports: the receivable side is in the assets report, the income side
          in the Profit &amp; Loss report. An imbalance this size means an export is missing
          {missingGroups.length > 0 && <> — nothing loaded for <strong>{missingGroups.join(" or ")}</strong></>}.
        </p>
        <p><strong>Add the missing file above and import once with all of them loaded.</strong> Importing now would
          create one-sided journal entries, and importing the rest afterwards cannot repair every case.</p>
      </div>
      )}

      <div className="flex justify-between items-center">
        <Btn variant="secondary" onClick={() => setStep(3)}>Back</Btn>
        <div className="flex items-center gap-3">
          {!balances && <span className="text-xs text-danger-600">Import blocked until the files balance</span>}
          <Btn onClick={runImport} disabled={!balances}>
            Import {(options.includeUnbalanced ? grouped.totals.entries : grouped.totals.balancedEntries).toLocaleString()} entries
          </Btn>
        </div>
      </div>
    </div>
    )}

    {/* ── 5. IMPORT / DONE ────────────────────────────────────── */}
    {step === 5 && (
    <div className="bg-white rounded-xl border border-neutral-200 p-4 space-y-3">
      {progress && (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-neutral-700"><Spinner /> {progress.phase}</div>
        {progress.total > 1 && (
        <>
          <div className="h-2 bg-neutral-100 rounded-full overflow-hidden">
            <div className="h-full bg-brand-600 transition-all" style={{ width: `${Math.round(100 * progress.done / progress.total)}%` }} />
          </div>
          <p className="text-xs text-neutral-500">
            Batch {progress.done} of {progress.total}
            {progress.done > 0 && progress.startedAt && (() => {
              const per = (Date.now() - progress.startedAt) / progress.done;
              const left = Math.round(per * (progress.total - progress.done) / 1000);
              return left > 0 ? <> · about {left < 90 ? `${left}s` : `${Math.round(left / 60)} min`} remaining</> : null;
            })()}
          </p>
          {progress.note && <p className="text-xs text-warn-700">{progress.note}</p>}
        </>
        )}
        <p className="text-xs text-neutral-400">Leave this tab open until it finishes. If it is interrupted, run the
          import again — anything already written is skipped.</p>
      </div>
      )}

      {result && (
      <div className="space-y-3">
        <p className="text-sm font-medium text-success-700">Import complete.</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          {[["Entries imported", result.inserted], ["Lines imported", result.lines],
            ["Already present, skipped", result.skipped], ["Accounts created", result.created?.accounts ?? 0]].map(([l, v]) => (
            <div key={l} className="bg-neutral-50 rounded-lg px-3 py-2">
              <div className="text-neutral-400">{l}</div>
              <div className="text-neutral-800 font-semibold">{safeNum(v).toLocaleString()}</div>
            </div>
          ))}
        </div>
        <p className="text-xs text-neutral-500">
          Check <strong>Reports → Trial Balance</strong> and <strong>Profit &amp; Loss</strong> before relying on the numbers.
          {result.balancesUpdated ? ` ${result.balancesUpdated} tenant balances were recalculated.` : ""}
        </p>
        <div className="flex gap-2">
          <Btn variant="secondary" onClick={() => { setStep(1); setFiles([]); setPlan(null); setResult(null); }}>Import more</Btn>
          <TextLink tone="danger" size="xs" onClick={rollback}>Undo this import</TextLink>
        </div>
      </div>
      )}

      {!progress && !result && (
      <div className="text-xs text-neutral-500">
        The import stopped before finishing. Nothing is lost — run it again and everything already written will be skipped.
        <div className="mt-2"><Btn variant="secondary" onClick={() => setStep(4)}>Back to review</Btn></div>
      </div>
      )}
    </div>
    )}
  </div>
  );
}

export default QuickBooksImport;
