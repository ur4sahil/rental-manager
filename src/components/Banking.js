import React, { useState, useEffect, useRef, useMemo } from "react";
import ExcelJS from "exceljs";
import { supabase } from "../supabase";
import { AccountPicker, Btn, Checkbox, Chip, FileInput, Input, Radio, Select, TextLink} from "../ui";
import { safeNum, formatLocalDate, formatCurrency, shortId } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { checkPeriodLock } from "../utils/accounting";
import { Spinner } from "./shared";

// --- Account type constants (kept local for backward compat) ---
const ACCOUNT_TYPES = ["Asset","Liability","Equity","Revenue","Cost of Goods Sold","Expense","Other Income","Other Expense"];

const nextAccountCode = (accounts, type) => {
  const ranges = { Asset:{s:1000,e:1999}, Liability:{s:2000,e:2999}, Equity:{s:3000,e:3999}, Revenue:{s:4000,e:4999}, "Cost of Goods Sold":{s:5000,e:5099}, Expense:{s:5000,e:6999}, "Other Income":{s:7000,e:7999}, "Other Expense":{s:8000,e:8999} };
  const r = ranges[type] || {s:9000,e:9999};
  const existing = accounts.map(a => parseInt(a.code || "0")).filter(n => !isNaN(n) && n >= r.s && n <= r.e);
  return String((existing.length > 0 ? Math.max(...existing) : r.s - 10) + 10);
};

// --- CSV Parsing Helpers ---
function csvParseText(csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };
  const parseRow = (line) => { const result=[]; let cur="",inQ=false; for(let i=0;i<line.length;i++){const ch=line[i]; if(ch==='"'){if(inQ&&line[i+1]==='"'){cur+='"';i++;}else inQ=!inQ;}else if(ch===","&&!inQ){result.push(cur.trim());cur="";}else cur+=ch;} result.push(cur.trim()); return result; };
  let hIdx=0; for(let i=0;i<Math.min(5,lines.length);i++){if(lines[i].includes(",")){hIdx=i;break;}}
  const headers = parseRow(lines[hIdx]).map(h=>h.replace(/^"|"$/g,"").trim());
  const rows=[]; for(let i=hIdx+1;i<lines.length;i++){const line=lines[i].trim();if(!line||line.startsWith("#"))continue;const vals=parseRow(line);if(vals.length<2)continue;const obj={};headers.forEach((h,idx)=>{obj[h]=(vals[idx]||"").replace(/^"|"$/g,"").trim();});rows.push(obj);}
  return {headers,rows};
}

const KNOWN_BANK_FORMATS = [
  { name: "Chase", headers: ["Details","Posting Date","Description","Amount","Type","Balance","Check or Slip #"], mapping: { date:"Posting Date", description:"Description", amount:"Amount", memo:"Details", check_number:"Check or Slip #" } },
  { name: "Bank of America", headers: ["Date","Description","Amount","Running Bal."], mapping: { date:"Date", description:"Description", amount:"Amount" } },
  { name: "Wells Fargo", headers: ["Date","Amount","*","Description"], mapping: { date:"Date", description:"Description", amount:"Amount" } },
  { name: "Citibank", headers: ["Status","Date","Description","Debit","Credit"], mapping: { date:"Date", description:"Description", debit:"Debit", credit:"Credit" } },
  { name: "Capital One", headers: ["Transaction Date","Posted Date","Card No.","Description","Category","Debit","Credit"], mapping: { date:"Transaction Date", description:"Description", debit:"Debit", credit:"Credit" } },
  { name: "US Bank", headers: ["Date","Transaction","Name","Memo","Amount"], mapping: { date:"Date", description:"Name", amount:"Amount", memo:"Memo" } },
];

function csvDetectFormat(headers) {
  const norm = headers.map(h=>h.toLowerCase().trim());
  for(const fmt of KNOWN_BANK_FORMATS){const fh=fmt.headers.map(h=>h.toLowerCase().trim());if(fh.filter(h=>h&&norm.includes(h)).length>=2)return fmt;}
  return null;
}

function csvParseAmount(rawAmt,rawDebit,rawCredit) {
  const clean=(s)=>{if(!s)return 0;s=String(s).trim().replace(/[$,\s]/g,"");const neg=s.startsWith("(")||s.startsWith("-");s=s.replace(/[()]/g,"").replace(/^-/,"");const v=parseFloat(s)||0;return neg?-v:v;};
  if(rawDebit!==undefined||rawCredit!==undefined){const d=clean(rawDebit),c=clean(rawCredit);if(c>0)return c;if(d>0)return -d;return 0;}
  return clean(rawAmt);
}

function csvParseDate(raw) {
  if(!raw)return "";raw=String(raw).trim();
  if(/^\d{4}-\d{2}-\d{2}/.test(raw))return raw.substring(0,10);
  const mdy=raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);if(mdy)return `${mdy[3]}-${mdy[1].padStart(2,"0")}-${mdy[2].padStart(2,"0")}`;
  const mdy2=raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);if(mdy2){const yr=parseInt(mdy2[3])>50?"19"+mdy2[3]:"20"+mdy2[3];return `${yr}-${mdy2[1].padStart(2,"0")}-${mdy2[2].padStart(2,"0")}`;}
  try{const d=new Date(raw);if(!isNaN(d))return d.toISOString().slice(0,10);}catch(_e){pmError("PM-8006",{raw:_e,context:"date parsing fallback",silent:true});}
  return raw;
}

// Normalize description so CSV and Teller fingerprints collide on the
// same real-world transaction. BofA's CSV masks IDs (ID:XXXXX29876),
// Teller returns unmasked (ID:8800429876); CSV drops enclosing
// quotes, Teller keeps them. Collapse all mask tokens to "x", strip
// long digit runs to "#", drop quotes/backslashes, collapse whitespace.
// Must match normDescription in api/teller-sync-transactions.js.
function csvNormDescription(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\\"']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}
function csvBuildFingerprint(feedId, date, direction, absAmount, description) {
  return `${feedId}|${date}|${direction}|${Math.round(absAmount * 100)}|${csvNormDescription(description)}`;
}

// --- Main Component ---
export function BankTransactions({ accounts, journalEntries, classes, tenants = [], vendors = [], companyId, showToast, showConfirm, userProfile, onRefreshAccounting }) {
  // State
  const [feeds, setFeeds] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("for_review");
  const [selectedFeed, setSelectedFeed] = useState("all");
  // Hide disconnected (status='inactive') AND unmapped (gl_account_id=null)
  // feeds by default — both are dead weight in the card row. A small
  // "Show hidden (N)" link reveals them when the user wants to map an
  // unmapped orphan or reactivate a disconnected feed.
  const [showHiddenFeeds, setShowHiddenFeeds] = useState(false);
  const [feedMenuOpen, setFeedMenuOpen] = useState(null);
  const [feedMenuPos, setFeedMenuPos] = useState({ top: 0, left: 0 });
  // GL-mapping modal (replaces the raw window.prompt that used to
  // ask the user to type an opaque UUID). Holds the feed we're
  // mapping and the id currently chosen in the AccountPicker.
  const [glMapModal, setGlMapModal] = useState(null); // { feedId, feedName } | null
  const [glMapValue, setGlMapValue] = useState("");
  // Sync-with-date picker. Opens on Sync / Retry Sync so the user can
  // backfill past Teller's default ~90-day window. Empty = Teller default.
  const [syncDateModal, setSyncDateModal] = useState(false);
  const [syncFromDate, setSyncFromDate] = useState("");
  // Connect-bank chooser. When the user already has a Teller enrollment
  // we offer "Reconnect [Bank]" (reuses enrollmentId — free) vs "Add
  // different bank" (consumes a new Teller slot). Without this every
  // click on Connect Bank created a duplicate enrollment.
  const [connectChooser, setConnectChooser] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [directionFilter, setDirectionFilter] = useState("all");
  const [txnPage, setTxnPage] = useState(0);
  const [txnPageSize, setTxnPageSize] = useState(50);
  // Date range window applied at the DB query level. Default 90 days keeps the
  // dataset small enough for client-side tab counts + search to be snappy.
  // Toggle "all" is available for audit / history workflows — capped at
  // TXN_FETCH_CAP and warned on truncation so users don't silently miss rows.
  const [dateRangeMode, setDateRangeMode] = useState("90d");
  const TXN_FETCH_CAP = 5000;
  const [txnTruncated, setTxnTruncated] = useState(false);
  const [totalTxnCount, setTotalTxnCount] = useState(0);
  const [selectedTxns, setSelectedTxns] = useState(new Set());
  const [expandedTxn, setExpandedTxn] = useState(null);
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [plaidConnecting, setPlaidConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [connections, setConnections] = useState([]);
  const EMPTY_CONDITION = { field: "description", operator: "contains", value: "", value2: "" };
  const EMPTY_LINE = { accountId: "", accountName: "", classId: "", percentage: null, amount: null };
  const [ruleForm, setRuleForm] = useState({
    name: "", conditions: [{ ...EMPTY_CONDITION }], condLogic: "all", condDirection: "all", bankAccountFeedId: "",
    ruleType: "assign", transactionType: "expense", actionPayee: "", actionMemo: "", excludeReason: "personal",
    split: false, splitBy: null, lines: [{ ...EMPTY_LINE }], autoAccept: false, priority: 100
  });
  const [showRuleDrawer, setShowRuleDrawer] = useState(false);
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [newAccountForm, setNewAccountForm] = useState({ name: "", type: "checking", masked_number: "", institution_name: "" });
  const [showNewBankAcct, setShowNewBankAcct] = useState(false);
  const [newBankAcctForm, setNewBankAcctForm] = useState({ code: "", name: "", type: "Expense" });
  // Post-connection setup modal
  const [postConnectModal, setPostConnectModal] = useState(null); // { accounts, connectionId, institutionName }
  const [postConnectMappings, setPostConnectMappings] = useState({}); // { feedId: glAccountId }
  const [postConnectSelected, setPostConnectSelected] = useState(new Set()); // which accounts user wants to connect
  const [postConnectRange, setPostConnectRange] = useState({ from: "", to: formatLocalDate(new Date()) });
  const [postConnectSyncing, setPostConnectSyncing] = useState(false);
  const [postConnectNewAcct, setPostConnectNewAcct] = useState(null); // feedId being created for

  async function createInlineBankAcct() {
    if (!newBankAcctForm.name.trim()) { showToast("Account name is required.", "error"); return; }
    const code = newBankAcctForm.code.trim() || nextAccountCode(accounts, newBankAcctForm.type);
    const { data: newAcct, error } = await supabase.from("acct_accounts").insert([{
      company_id: companyId, code, name: newBankAcctForm.name.trim(), type: newBankAcctForm.type,
      is_active: true, old_text_id: companyId + "-" + code
    }]).select("id, name").maybeSingle();
    if (error) { pmError("PM-4006", { raw: error, context: "create inline account from bank" }); return; }
    if (newAcct) setAddForm(f => ({ ...f, accountId: newAcct.id, accountName: newAcct.name }));
    showToast(`Account "${newBankAcctForm.name}" created.`, "success");
    setShowNewBankAcct(false);
    // Refresh accounts without resetting scroll — save and restore expanded txn
    const savedExpanded = expandedTxn;
    if (onRefreshAccounting) await onRefreshAccounting();
    // Restore expanded state and scroll back to the transaction row
    if (savedExpanded) {
      setExpandedTxn(savedExpanded);
      requestAnimationFrame(() => {
        const row = document.querySelector(`[data-txn-id="${savedExpanded}"]`);
        if (row) row.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    }
  }

  // Import wizard state
  const [wizStep, setWizStep] = useState(1);
  const [wizFile, setWizFile] = useState(null);
  const [wizFeedId, setWizFeedId] = useState("");
  const [wizParsed, setWizParsed] = useState(null);
  const [wizMapping, setWizMapping] = useState({ date:"",description:"",amount:"",debit:"",credit:"",memo:"",check_number:"",reference:"",payee:"" });
  const [wizPreview, setWizPreview] = useState([]);
  const [wizOptions, setWizOptions] = useState({ skipDuplicates: true, autoApplyRules: true, markForReview: true });
  const [wizResult, setWizResult] = useState(null);
  const [wizDetected, setWizDetected] = useState(null);
  const [wizInvertSign, setWizInvertSign] = useState(false);
  const fileRef = useRef();

  // Action panel state
  const [actionMode, setActionMode] = useState("add"); // add | match | transfer | split
  const [addForm, setAddForm] = useState({ accountId: "", accountName: "", memo: "", classId: "", entityType: "", entityId: "", entityName: "" });
  const [transferForm, setTransferForm] = useState({ accountId: "", accountName: "", memo: "" });
  const [splitLines, setSplitLines] = useState([{ accountId: "", accountName: "", amount: "", memo: "", classId: "" }, { accountId: "", accountName: "", amount: "", memo: "", classId: "" }]);
  const [matchCandidates, setMatchCandidates] = useState([]);
  const [matchLoading, setMatchLoading] = useState(false);

  // Per-account debit/credit totals from posted journal lines. Used by
  // the live reconciliation panel below to compute Books balance for
  // each linked GL account in O(N) once per render. Inlined rather
  // than imported from Accounting.js because Accounting imports this
  // file (line 13 there) — a back-import would create a circular
  // module reference.
  const balanceIndex = useMemo(() => {
    const idx = {};
    for (const je of journalEntries || []) {
      if (je.status !== "posted") continue;
      for (const l of (je.lines || [])) {
        if (!l.account_id) continue;
        if (!idx[l.account_id]) idx[l.account_id] = { debit: 0, credit: 0 };
        idx[l.account_id].debit += safeNum(l.debit);
        idx[l.account_id].credit += safeNum(l.credit);
      }
    }
    return idx;
  }, [journalEntries]);

  // True unfiltered pending-net + count per feed. The `transactions`
  // state is filtered by the date-range cutoff (default 90 days),
  // which makes pending look smaller than it actually is — and the
  // reconciliation math then doesn't tie out (Bank/Books are totals,
  // Pending was a 90-day slice). Fetch a real per-feed roll-up
  // separately and refresh whenever the date window or the feeds
  // list changes (post-sync).
  const [feedPending, setFeedPending] = useState({});
  useEffect(() => {
    let cancelled = false;
    async function loadPending() {
      if (!feeds.length) { setFeedPending({}); return; }
      const out = {};
      for (const feed of feeds) {
        const rows = [];
        let from = 0;
        while (true) {
          const { data: page } = await supabase.from("bank_feed_transaction")
            .select("id, amount, direction")
            .eq("bank_account_feed_id", feed.id)
            .eq("status", "for_review")
            .range(from, from + 999);
          if (!page?.length) break;
          rows.push(...page);
          if (page.length < 1000) break;
          from += 1000;
        }
        out[feed.id] = rows;
      }
      if (!cancelled) setFeedPending(out);
    }
    loadPending();
    return () => { cancelled = true; };
  }, [feeds, transactions.length]);

  // Live reconciliation: per-feed Bank vs Books vs Pending Under Review.
  // Returns null bankBal when neither Teller-synced nor a CSV with
  // running balance is available — the panel renders a hint in that
  // case instead of a misleading $0.
  const DEBIT_NORMAL_TYPES = ["Asset", "Cost of Goods Sold", "Expense", "Other Expense"];
  function computeFeedRecon(feed) {
    const acct = accounts.find(a => a.id === feed.gl_account_id);
    const isDebitNormal = !!(acct && DEBIT_NORMAL_TYPES.includes(acct.type));
    const entry = balanceIndex[feed.gl_account_id] || { debit: 0, credit: 0 };
    const bookBal = isDebitNormal ? entry.debit - entry.credit : entry.credit - entry.debit;

    // Pending net is signed to the bank's perspective. For asset
    // accounts (checking/savings): inflow adds, outflow subtracts.
    // For credit-card liabilities (credit-normal): outflow charge
    // increases the balance owed; inflow payment decreases it.
    // Source = feedPending[feed.id], the true unfiltered for_review
    // list (the one in `transactions` state is date-windowed and
    // would silently understate pending, breaking the math).
    const pendingTxns = feedPending[feed.id] || [];
    const pendingNet = pendingTxns.reduce((s, t) => {
      const abs = Math.abs(safeNum(t.amount));
      if (isDebitNormal) return s + (t.direction === "inflow" ? abs : -abs);
      return s + (t.direction === "outflow" ? abs : -abs);
    }, 0);

    let bankBal = feed.bank_balance_current;
    if (bankBal == null) {
      // CSV-only feed: fall back to the most recent imported row's
      // running balance if the importer captured it.
      const latest = transactions
        .filter(t => t.bank_account_feed_id === feed.id && t.balance_after != null)
        .sort((a, b) => (b.posted_date || "").localeCompare(a.posted_date || ""))[0];
      bankBal = latest ? safeNum(latest.balance_after) : null;
    }

    const diff = bankBal == null ? null : Math.round((bankBal - bookBal - pendingNet) * 100) / 100;
    const isReconciled = diff != null && Math.abs(diff) < 0.01;
    return { bankBal, bookBal, pendingNet, pendingCount: pendingTxns.length, diff, isReconciled };
  }

  // Fetch on mount + whenever date-range window changes (re-fetches txns)
  useEffect(() => { fetchAll(); /* eslint-disable-next-line */ }, [companyId]);
  useEffect(() => {
    // Skip the initial render — fetchAll() already ran from the mount effect.
    if (loading) return;
    fetchTransactions();
    /* eslint-disable-next-line */
  }, [dateRangeMode]);
  // Reset to page 1 whenever the effective result set changes. Without this,
  // selecting a different feed after paging to page 7 of the previous one
  // keeps you on page 7 (or clamps to last-page) — confusing. Same for tab
  // switches and filter/search changes.
  useEffect(() => { setTxnPage(0); }, [selectedFeed, activeTab, searchQuery, directionFilter, dateFrom, dateTo, txnPageSize]);
  // If the currently-selected feed is now hidden (user disconnected or
  // hid it), drop the selection back to "all" so the transactions table
  // doesn't silently filter against an invisible card.
  useEffect(() => {
    if (selectedFeed === "all" || showHiddenFeeds) return;
    const f = feeds.find(x => x.id === selectedFeed);
    if (f && (f.status === "inactive" || !f.gl_account_id)) setSelectedFeed("all");
  }, [feeds, selectedFeed, showHiddenFeeds]);

  // First-time mismatch alert per feed per session. Re-firing every
  // render would spam — the ref tracks which feeds we've already
  // warned about. Cleared on a hard reload (component remount).
  const warnedFeedIds = useRef(new Set());
  useEffect(() => {
    if (loading) return;
    for (const feed of feeds) {
      if (feed.status === "inactive" || !feed.gl_account_id) continue;
      const r = computeFeedRecon(feed);
      if (r.bankBal == null || r.isReconciled) continue;
      if (warnedFeedIds.current.has(feed.id)) continue;
      warnedFeedIds.current.add(feed.id);
      showToast(`Reconciliation mismatch on ${feed.account_name}: ${formatCurrency(r.diff)}. Check for missing or duplicate transactions.`, "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feeds, transactions, balanceIndex, loading]);

  // Minimum bank_feed_transaction column set. The full row has 33 columns;
  // only these are consumed by the UI (sort/filter/display/action). Dropped:
  // bank_import_batch_id, provider_transaction_id, balance_after,
  // fingerprint_hash, duplicate_group_key, excluded_at/by, accepted_at/by,
  // created_at, updated_at. If you add a new txn widget that reads a field
  // not listed here, add it.
  const TXN_COLS = "id, bank_account_feed_id, source_type, posted_date, amount, direction, bank_description_raw, bank_description_clean, memo, check_number, payee_raw, payee_normalized, reference_number, status, suggestion_status, exclusion_reason, matched_target_type, matched_target_id, posting_decision_id, journal_entry_id, raw_payload_json";

  function dateRangeCutoff() {
    if (dateRangeMode === "all") return null;
    const days = dateRangeMode === "30d" ? 30 : dateRangeMode === "90d" ? 90 : dateRangeMode === "6m" ? 183 : dateRangeMode === "1y" ? 365 : 90;
    return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  }

  async function fetchTransactions() {
    const cutoff = dateRangeCutoff();
    // `count: exact` gives us the true total so the UI can warn on truncation.
    let q = supabase.from("bank_feed_transaction")
      .select(TXN_COLS, { count: "exact" })
      .eq("company_id", companyId)
      .order("posted_date", { ascending: false })
      .limit(TXN_FETCH_CAP);
    if (cutoff) q = q.gte("posted_date", cutoff);
    const { data, count, error } = await q;
    if (error) {
      pmError("PM-5001", { raw: error, context: "fetch bank transactions", silent: true });
    }
    setTransactions(data || []);
    setTotalTxnCount(count || 0);
    // If the underlying match count exceeds the fetch cap, warn — prior code
    // silently capped at 500 and hid the rest.
    setTxnTruncated((count || 0) > (data?.length || 0));
  }

  // Quiet refresh — re-pulls data without flipping the global
  // `loading` flag (which would unmount the whole transactions UI,
  // including the search input). Use after accept/exclude/post
  // actions where the user is mid-flow and shouldn't see the
  // Spinner take over their screen.
  async function refreshData() {
    return fetchAll({ silent: true });
  }

  async function fetchAll(opts = {}) {
    if (!opts.silent) setLoading(true);
    const cutoff = dateRangeCutoff();
    let txnQ = supabase.from("bank_feed_transaction")
      .select(TXN_COLS, { count: "exact" })
      .eq("company_id", companyId)
      .order("posted_date", { ascending: false })
      .limit(TXN_FETCH_CAP);
    if (cutoff) txnQ = txnQ.gte("posted_date", cutoff);
    const [feedsRes, txnRes, rulesRes, connRes] = await Promise.all([
      // Show all feeds (active + inactive). Disconnected accounts
      // stay visible with a Reactivate affordance instead of vanishing.
      // bank_account_feed has no soft-delete column — status='inactive'
      // is the full deactivation state.
      supabase.from("bank_account_feed").select("*").eq("company_id", companyId).order("created_at"),
      txnQ,
      supabase.from("bank_transaction_rule").select("*").eq("company_id", companyId).order("priority"),
      supabase.from("bank_connection").select("*").eq("company_id", companyId).order("created_at"),
    ]);
    setFeeds(feedsRes.data || []);
    setTransactions(txnRes.data || []);
    setTotalTxnCount(txnRes.count || 0);
    setTxnTruncated((txnRes.count || 0) > (txnRes.data?.length || 0));
    const fetchedRules = rulesRes.data || [];
    // Auto-migrate V1 rules to V2 format on first load
    if (fetchedRules.some(r => r.condition_json && !r.condition_json.conditions)) {
      await migrateRulesToV2(fetchedRules);
      const { data: refreshed } = await supabase.from("bank_transaction_rule").select("*").eq("company_id", companyId).order("priority");
      setRules(refreshed || []);
    } else {
      setRules(fetchedRules);
    }
    setConnections(connRes.data || []);
    if (!opts.silent) setLoading(false);
  }

  // --- Create New Bank Account Feed ---
  const [creatingFeed, setCreatingFeed] = useState(false);
  async function createFeed() {
    if (!newAccountForm.name.trim()) { showToast("Account name is required.", "error"); return; }
    if (creatingFeed) return;
    // Check for duplicate
    const { data: existing } = await supabase.from("bank_account_feed").select("id").eq("company_id", companyId).ilike("account_name", newAccountForm.name.trim());
    if (existing?.length > 0) { showToast("A bank account with this name already exists.", "error"); return; }
    setCreatingFeed(true);
    try {
    // Create GL account in acct_accounts
    const code = newAccountForm.type === "credit_card" ? "2050" : newAccountForm.type === "savings" ? "1050" : "1000";
    const nextCode = code + "-" + shortId().slice(0, 3);
    const { data: glAcct, error: glErr } = await supabase.from("acct_accounts").insert([{
      company_id: companyId, code: nextCode, name: newAccountForm.name.trim(),
      type: newAccountForm.type === "credit_card" ? "Liability" : "Asset",
      subtype: newAccountForm.type === "credit_card" ? "Credit Card" : "Bank",
      is_active: true, old_text_id: companyId + "-" + nextCode
    }]).select("id").maybeSingle();
    if (glErr) { pmError("PM-5001", { raw: glErr, context: "creating GL account for bank feed" }); return; }
    // Create bank_account_feed
    const { data: newFeed, error: feedErr } = await supabase.from("bank_account_feed").insert([{
      company_id: companyId, gl_account_id: glAcct?.id, account_name: newAccountForm.name.trim(),
      masked_number: newAccountForm.masked_number, account_type: newAccountForm.type,
      institution_name: newAccountForm.institution_name, connection_type: "csv"
    }]).select("id").maybeSingle();
    if (feedErr) { pmError("PM-5002", { raw: feedErr, context: "creating bank account feed" }); return; }
    showToast("Bank account created.", "success");
    setShowNewAccount(false);
    setNewAccountForm({ name: "", type: "checking", masked_number: "", institution_name: "" });
    if (newFeed?.id) setWizFeedId(newFeed.id);
    fetchAll();
    if (onRefreshAccounting) onRefreshAccounting(); // Refresh parent's acctAccounts so BS/GL see the new bank account
    } finally { setCreatingFeed(false); }
  }

  // --- Teller Connect ---
  // Opens Teller Connect. Pass a reconnectEnrollmentId to open in
  // "update" mode against an existing enrollment — that re-authenticates
  // the same institution without consuming a new slot against the
  // Teller plan. Without it, Teller creates a fresh enrollment (a
  // second BofA connection counts twice toward plan limits).
  async function connectBank(reconnectEnrollmentId) {
    setPlaidConnecting(true);
    try {
      const tellerAppId = window.__TELLER_APP_ID || process.env.REACT_APP_TELLER_APP_ID || "";
      if (!tellerAppId) { showToast("Teller Application ID not configured. Set REACT_APP_TELLER_APP_ID.", "error"); return; }
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) { showToast("Not authenticated.", "error"); return; }
      // Load Teller Connect SDK
      if (!window.TellerConnect) {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://cdn.teller.io/connect/connect.js";
          script.onload = resolve; script.onerror = reject;
          document.head.appendChild(script);
        });
      }
      const setupOpts = {
        applicationId: tellerAppId,
        environment: "development",
        onSuccess: async (enrollment) => {
          showToast("Connecting accounts...", "success");
          const saveRes = await fetch("/api/teller-save-enrollment", {
            method: "POST",
            headers: { "Authorization": "Bearer " + session.access_token, "Content-Type": "application/json" },
            body: JSON.stringify({
              access_token: enrollment.accessToken,
              enrollment_id: enrollment.enrollment?.id || "",
              institution: enrollment.enrollment?.institution || {},
              company_id: companyId
            })
          });
          const saveData = await saveRes.json();
          if (!saveRes.ok || saveData.error || saveData.message === "Invalid JWT") {
            pmError("PM-5003", { raw: new Error(saveData.error || saveData.message || `HTTP ${saveRes.status}`), context: "saving Teller enrollment" });
          } else {
            // Show post-connection setup modal
            await fetchAll();
            const ninetyDaysAgo = new Date(); ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
            setPostConnectRange({ from: formatLocalDate(ninetyDaysAgo), to: formatLocalDate(new Date()) });
            // Build default mappings + select all accounts by default. Keyed
            // by plaid_account_id (Teller's stable account id) — new feeds
            // don't have a local bank_account_feed.id yet, so we can't use
            // the old key.
            const mappings = {};
            const selected = new Set();
            (saveData.accounts || []).forEach(a => {
              const k = a.plaid_account_id;
              if (!k) return;
              if (a.existing_gl_account_id) mappings[k] = a.existing_gl_account_id;
              selected.add(k);
            });
            setPostConnectMappings(mappings);
            setPostConnectSelected(selected);
            setPostConnectNewAcct(null);
            setPostConnectModal({ accounts: saveData.accounts || [], connectionId: saveData.connection_id, institutionName: enrollment.enrollment?.institution?.name || "Bank" });
          }
        },
        onExit: () => { /* user closed */ },
      };
      // Teller Connect opens in "update" mode when enrollmentId is set.
      if (reconnectEnrollmentId) setupOpts.enrollmentId = reconnectEnrollmentId;
      const tellerConnect = window.TellerConnect.setup(setupOpts);
      tellerConnect.open();
    } catch (e) { pmError("PM-5004", { raw: e, context: "connecting bank via Teller" }); }
    finally { setPlaidConnecting(false); }
  }

  async function syncTransactions(opts = {}) {
    setSyncing(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) { showToast("Not authenticated.", "error"); return; }
      const payload = { company_id: companyId };
      if (opts.from_date) payload.from_date = opts.from_date;
      if (opts.to_date) payload.to_date = opts.to_date;
      const res = await fetch("/api/teller-sync-transactions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + session.access_token, "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok || data.error) { showToast("Sync error: " + (data.error || `HTTP ${res.status}`), "error"); }
      else {
        // If from_date was provided, include the oldest txn Teller actually
        // returned per feed. Lets the user see whether Teller ran out of
        // history (bank retention) vs our pagination stopping early.
        let msg = `Synced: ${data.total_added} new transaction${data.total_added !== 1 ? "s" : ""}`;
        if (opts.from_date && Array.isArray(data.feed_stats) && data.feed_stats.length) {
          const summary = data.feed_stats
            .filter(f => (f.raw_count || 0) > 0)
            .map(f => `${String(f.feed_id).slice(0,4)}: ${f.raw_count} txns, oldest ${f.raw_oldest || "—"} (${f.pages_fetched}p)`)
            .join(" · ");
          if (summary) msg += " — " + summary;
        }
        showToast(msg, "success");
        // Also log full stats to console for easy copy/paste.
        if (Array.isArray(data.feed_stats)) console.log("[bank-sync] feed stats:", data.feed_stats);
        fetchAll();
      }
    } catch (e) { showToast("Sync failed: " + e.message, "error"); }
    finally { setSyncing(false); }
  }

  async function disconnectFeed(feedId) {
    const feed = feeds.find(f => f.id === feedId);
    if (!feed) return;
    if (!await showConfirm({ message: `Disconnect "${feed.account_name}"? Existing transactions will be kept but no new ones will sync.` })) return;
    const { error } = await supabase.from("bank_account_feed").update({ status: "inactive" }).eq("id", feedId).eq("company_id", companyId);
    if (error) { showToast("Error disconnecting feed: " + error.message, "error"); return; }
    // If no more active feeds for this connection, mark connection as disconnected
    if (feed.bank_connection_id) {
      const { data: remaining } = await supabase.from("bank_account_feed").select("id").eq("bank_connection_id", feed.bank_connection_id).eq("status", "active").eq("company_id", companyId);
      if (!remaining || remaining.length === 0) {
        await supabase.from("bank_connection").update({ connection_status: "disconnected" }).eq("id", feed.bank_connection_id).eq("company_id", companyId);
      }
    }
    if (selectedFeed === feedId) setSelectedFeed("all");
    showToast(`"${feed.account_name}" disconnected.`, "success");
    fetchAll();
  }

  async function reactivateFeed(feedId) {
    const feed = feeds.find(f => f.id === feedId);
    if (!feed) return;
    const { error } = await supabase.from("bank_account_feed").update({ status: "active" }).eq("id", feedId).eq("company_id", companyId);
    if (error) { showToast("Error reactivating feed: " + error.message, "error"); return; }
    // If the parent connection was flipped to 'disconnected' when this
    // was the last active feed, bring it back so sync is enabled again.
    if (feed.bank_connection_id) {
      await supabase.from("bank_connection").update({ connection_status: "active" }).eq("id", feed.bank_connection_id).eq("company_id", companyId).eq("connection_status", "disconnected");
    }
    showToast(`"${feed.account_name}" reactivated. Hit Sync to pull new transactions.`, "success");
    fetchAll();
  }

  async function updateFeedMapping(feedId, glAccountId) {
    const { error } = await supabase.from("bank_account_feed").update({ gl_account_id: glAccountId }).eq("id", feedId).eq("company_id", companyId);
    if (error) { showToast("Error updating mapping: " + error.message, "error"); return; }
    showToast("GL mapping updated.", "success");
    fetchAll();
  }

  // --- CSV Import Wizard ---
  function startImport() {
    setWizStep(1); setWizFile(null); setWizFeedId(feeds[0]?.id || ""); setWizParsed(null);
    setWizMapping({ date:"",description:"",amount:"",debit:"",credit:"",memo:"",check_number:"",reference:"",payee:"" });
    setWizPreview([]); setWizResult(null); setWizDetected(null); setWizInvertSign(false);
    setShowImportWizard(true);
  }

  function wizHandleUpload() {
    if (!wizFile) { showToast("Please select a CSV file.", "error"); return; }
    if (!wizFeedId) { showToast("Please select a bank account first.", "error"); return; }
    try {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const parsed = csvParseText(e.target.result);
          if (parsed.headers.length === 0) { showToast("Could not parse CSV — no headers found.", "error"); return; }
          const detected = csvDetectFormat(parsed.headers);
          const m = { date:"",description:"",amount:"",debit:"",credit:"",memo:"",check_number:"",reference:"",payee:"" };
          if (detected) { Object.entries(detected.mapping).forEach(([k,v])=>{m[k]=v;}); }
          else { parsed.headers.forEach(h=>{const hl=h.toLowerCase();if(!m.date&&hl.includes("date"))m.date=h;if(!m.description&&(hl.includes("desc")||hl.includes("name")||hl==="payee"))m.description=h;if(!m.amount&&(hl==="amount"||hl==="amt"))m.amount=h;if(!m.debit&&hl.includes("debit"))m.debit=h;if(!m.credit&&hl.includes("credit"))m.credit=h;if(!m.memo&&hl.includes("memo"))m.memo=h;if(!m.payee&&hl==="payee")m.payee=h;}); }
          setWizMapping(m);
          setWizParsed(parsed);
          setWizDetected(detected);
          setWizStep(3); // skip to mapping
        } catch (parseErr) {
          pmError("PM-5001", { raw: parseErr, context: "parsing CSV file " + wizFile?.name });
        }
      };
      reader.onerror = () => { pmError("PM-5001", { raw: { message: "FileReader error" }, context: "reading CSV file" }); };
      reader.readAsText(wizFile);
    } catch (err) {
      pmError("PM-5001", { raw: err, context: "CSV upload handler" });
    }
  }

  function wizBuildPreview() {
    if (!wizParsed) return;
    const rows = wizParsed.rows.map((row, idx) => {
      const rawAmt = wizMapping.amount ? row[wizMapping.amount] : undefined;
      const rawDb = wizMapping.debit ? row[wizMapping.debit] : undefined;
      const rawCr = wizMapping.credit ? row[wizMapping.credit] : undefined;
      let amount = csvParseAmount(rawAmt, rawDb, rawCr);
      if (wizInvertSign) amount = -amount;
      const date = csvParseDate(wizMapping.date ? row[wizMapping.date] : "");
      const desc = wizMapping.description ? row[wizMapping.description] : "(no description)";
      const memo = wizMapping.memo ? row[wizMapping.memo] : "";
      const payee = wizMapping.payee ? row[wizMapping.payee] : "";
      const checkNum = wizMapping.check_number ? row[wizMapping.check_number] : "";
      const ref = wizMapping.reference ? row[wizMapping.reference] : "";
      const direction = amount >= 0 ? "inflow" : "outflow";
      const fingerprint = csvBuildFingerprint(wizFeedId, date, direction, Math.abs(amount), desc);
      const valid = !!date && !isNaN(amount) && amount !== 0;
      return { idx, date, amount, direction, description: desc, memo, payee, checkNum, ref, fingerprint, valid, rawRow: row };
    });
    setWizPreview(rows);
    setWizStep(4);
  }

  async function wizExecuteImport() {
    if (!wizFeedId || wizPreview.length === 0) return;
    const validRows = wizPreview.filter(r => r.valid);
    if (validRows.length === 0) { showToast("No valid rows to import.", "error"); return; }

    // Create batch
    const { data: batch, error: batchErr } = await supabase.from("bank_import_batch").insert([{
      company_id: companyId, bank_account_feed_id: wizFeedId, source_type: "csv",
      original_filename: wizFile?.name || "import.csv", file_hash: shortId(),
      imported_by: userProfile?.email || "", row_count: validRows.length,
      mapping_json: wizMapping, status: "imported"
    }]).select("id").maybeSingle();
    if (batchErr) { showToast("Error creating import batch: " + batchErr.message, "error"); return; }
    const batchId = batch?.id;

    // Check existing fingerprints for dedup
    const { data: existingFps } = await supabase.from("bank_feed_transaction").select("fingerprint_hash")
      .eq("company_id", companyId).eq("bank_account_feed_id", wizFeedId);
    const existingSet = new Set((existingFps || []).map(f => f.fingerprint_hash));

    let imported = 0, skipped = 0, duplicates = 0;
    const batchInserts = [];

    for (const row of validRows) {
      if (wizOptions.skipDuplicates && existingSet.has(row.fingerprint)) {
        duplicates++;
        continue;
      }
      batchInserts.push({
        company_id: companyId, bank_account_feed_id: wizFeedId, bank_import_batch_id: batchId,
        source_type: "csv", posted_date: row.date, amount: Math.abs(row.amount),
        direction: row.direction, bank_description_raw: row.description,
        bank_description_clean: row.description, memo: row.memo || null,
        check_number: row.checkNum || null, payee_raw: row.payee || null,
        payee_normalized: row.payee || null, reference_number: row.ref || null,
        fingerprint_hash: row.fingerprint, status: "for_review",
        raw_payload_json: row.rawRow
      });
    }

    // Insert in batches of 50
    for (let i = 0; i < batchInserts.length; i += 50) {
      const chunk = batchInserts.slice(i, i + 50);
      const { error: insErr } = await supabase.from("bank_feed_transaction").insert(chunk);
      if (insErr) {
        // Handle individual duplicate conflicts gracefully
        for (const item of chunk) {
          const { error: singleErr } = await supabase.from("bank_feed_transaction").insert([item]);
          if (singleErr) { if (singleErr.message?.includes("unique")) duplicates++; else skipped++; }
          else imported++;
        }
      } else {
        imported += chunk.length;
      }
    }

    // Update batch stats
    await supabase.from("bank_import_batch").update({
      accepted_count: imported, skipped_count: skipped, duplicate_count: duplicates
    }).eq("id", batchId);

    // Apply rules to newly imported transactions
    let ruleApplied = 0;
    if (wizOptions.autoApplyRules && rules.length > 0 && imported > 0) {
      const { data: newTxns } = await supabase.from("bank_feed_transaction").select("id")
        .eq("company_id", companyId).eq("bank_import_batch_id", batchId).eq("status", "for_review");
      if (newTxns && newTxns.length > 0) {
        ruleApplied = await applyRulesToTransactions(newTxns.map(t => t.id));
      }
    }

    // Widen the date filter if we imported rows older than the current
    // fetch window. Otherwise the user sees "55 imported" but the
    // transactions don't show up in the list because the default
    // "Last 90 days" filter excludes them. Compute oldest imported
    // date and pick the smallest window that covers it.
    if (imported > 0 && batchInserts.length > 0) {
      const oldestImported = batchInserts.reduce((m, t) => (t.posted_date && (!m || t.posted_date < m) ? t.posted_date : m), "");
      const cutoff = dateRangeCutoff();
      const cutoffStr = cutoff || "0000-00-00";
      if (oldestImported && oldestImported < cutoffStr) {
        const daysBack = Math.ceil((new Date() - new Date(oldestImported)) / 86400000);
        const widened = daysBack <= 30 ? "30d" : daysBack <= 90 ? "90d" : daysBack <= 183 ? "6m" : daysBack <= 365 ? "1y" : "all";
        setDateRangeMode(widened);
        showToast(`Date filter widened to cover imported transactions (oldest: ${oldestImported}).`, "info");
      }
    }

    setWizResult({ imported, skipped, duplicates, total: validRows.length, ruleApplied });
    setWizStep(6);
    refreshData();
  }

  // --- Transaction Actions ---
  async function acceptTransaction(txn, accountId, accountName, memo, classId, entityType, entityId, entityName) {
    if (!guardSubmit("bankAccept", txn.id)) { showToast("Already processing this transaction.", "warning"); return; }
    try {
    if (!accountId) { showToast("Please select a category/account.", "error"); return; }
    if (await checkPeriodLock(companyId, txn.posted_date)) { showToast("This transaction date falls in a locked accounting period.", "error"); return; }
    // Verify transaction is still for_review (prevents double-post from concurrent tabs/clicks)
    const { data: freshTxn } = await supabase.from("bank_feed_transaction").select("status").eq("id", txn.id).eq("company_id", companyId).maybeSingle();
    if (!freshTxn || freshTxn.status !== "for_review") { showToast("This transaction has already been processed.", "warning"); refreshData(); return; }
    const feed = feeds.find(f => f.id === txn.bank_account_feed_id);
    if (!feed?.gl_account_id) { showToast("Bank account not linked to GL.", "error"); return; }
    const bankAcct = accounts.find(a => a.id === feed.gl_account_id);
    const abs = Math.abs(txn.amount);
    const isInflow = txn.direction === "inflow";

    // Build human-readable description: "Payee — Full Description"
    const bankDesc = memo || [txn.payee_normalized, txn.bank_description_raw || txn.bank_description_clean].filter(Boolean).join(" — ") || "Bank transaction";
    const lineMemo = txn.bank_description_raw || txn.bank_description_clean || "";

    // Create JE
    const lines = isInflow
      ? [{ account_id: feed.gl_account_id, account_name: bankAcct?.name || "Bank", debit: abs, credit: 0, class_id: classId || null, memo: lineMemo },
         { account_id: accountId, account_name: accountName, debit: 0, credit: abs, class_id: classId || null, memo: lineMemo }]
      : [{ account_id: accountId, account_name: accountName, debit: abs, credit: 0, class_id: classId || null, memo: lineMemo },
         { account_id: feed.gl_account_id, account_name: bankAcct?.name || "Bank", debit: 0, credit: abs, class_id: classId || null, memo: lineMemo }];

    // Get next JE number
    const { data: maxJE } = await supabase.from("acct_journal_entries").select("number").eq("company_id", companyId).order("number", { ascending: false }).limit(1).maybeSingle();
    let nextNum = 1;
    if (maxJE?.number) { const parsed = parseInt(maxJE.number.replace("JE-",""), 10); if (!isNaN(parsed)) nextNum = parsed + 1; }
    const jeNumber = `JE-${String(nextNum).padStart(4,"0")}`;

    // Resolve property from class if selected
    const classProperty = classId ? (classes.find(c => c.id === classId)?.name || "") : "";

    const { data: jeRow, error: jeErr } = await supabase.from("acct_journal_entries").insert([{
      company_id: companyId, number: jeNumber, date: txn.posted_date,
      description: bankDesc,
      // Per-txn reference. Was hard-coded "Bank Import" for every row,
      // which silently worked for the first categorization in a
      // company and then blocked every subsequent one via
      // idx_je_company_reference_unique ("duplicate key value"). The
      // XFER- and SPLIT- paths in this file already use the same
      // BANK-<txn.id> shape.
      reference: `BANK-${txn.id}`, property: classProperty, status: "posted"
    }]).select("id").maybeSingle();

    if (jeErr || !jeRow) { showToast("Error creating JE: " + (jeErr?.message || "no ID"), "error"); return; }

    // Validate UUIDs — some IDs may be integers from older data
    const isUUID = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    const safeUUID = (v) => (v && isUUID(String(v))) ? v : null;

    const { error: linesErr } = await supabase.from("acct_journal_lines").insert(lines.map(l => ({
      journal_entry_id: jeRow.id, company_id: companyId,
      account_id: l.account_id, account_name: l.account_name,
      debit: safeNum(l.debit), credit: safeNum(l.credit),
      class_id: safeUUID(l.class_id), memo: l.memo || "",
      entity_type: entityType || null, entity_id: safeUUID(entityId), entity_name: entityName || null,
      bank_feed_transaction_id: txn.id
    })));

    if (linesErr) {
      // Clean up orphaned JE header
      await supabase.from("acct_journal_entries").delete().eq("id", jeRow.id).eq("company_id", companyId);
      pmError("PM-4003", { raw: linesErr, context: "bank transaction JE lines insert" });
      return;
    }

    // Create posting decision record
    const { data: decision, error: decErr } = await supabase.from("bank_posting_decision").insert([{
      company_id: companyId, bank_feed_transaction_id: txn.id,
      decision_type: "add", payee: txn.payee_normalized || "", memo: memo || "",
      header_class_id: classId || null, status: "posted", created_by: userProfile?.email || ""
    }]).select("id").maybeSingle();
    if (decErr) { showToast("Error saving posting decision: " + decErr.message, "error"); return; }

    // Create decision line
    if (decision) {
      const { error: dlErr } = await supabase.from("bank_posting_decision_line").insert([{
        company_id: companyId, bank_posting_decision_id: decision.id,
        gl_account_id: accountId, gl_account_name: accountName,
        amount: abs, entry_side: isInflow ? "credit" : "debit", memo: memo || ""
      }]);
      if (dlErr) { showToast("Error saving decision line: " + dlErr.message, "error"); return; }
    }

    // Create link
    const { error: linkErr } = await supabase.from("bank_feed_transaction_link").insert([{
      company_id: companyId, bank_feed_transaction_id: txn.id,
      linked_object_type: "journal_entry", linked_object_id: jeRow.id,
      link_role: "created_from"
    }]);
    if (linkErr) { showToast("Error linking transaction: " + linkErr.message, "error"); return; }

    // Update transaction status
    await supabase.from("bank_feed_transaction").update({
      status: "categorized", accepted_at: new Date().toISOString(),
      accepted_by: userProfile?.email || "", journal_entry_id: jeRow.id,
      posting_decision_id: decision?.id
    }).eq("id", txn.id).eq("company_id", companyId);

    // Audit
    logAudit("create", "banking", `Accepted bank txn: ${txn.bank_description_clean} → ${accountName}`, txn.id, userProfile?.email, "", companyId);
    trackCategorizationPattern(txn, accountId, accountName, classId);

    showToast("Transaction categorized and posted.", "success");
    setExpandedTxn(null);
    setAddForm({ accountId: "", accountName: "", memo: "", classId: "", entityType: "", entityId: "", entityName: "" });
    refreshData();
    if (onRefreshAccounting) onRefreshAccounting();
    } finally { guardRelease("bankAccept", txn.id); }
  }

  async function excludeTransaction(txn, reason) {
    if (!guardSubmit("bankExclude", txn.id)) return;
    try {
    if (!reason) { showToast("Please select a reason.", "error"); return; }
    await supabase.from("bank_feed_transaction").update({
      status: "excluded", exclusion_reason: reason,
      excluded_at: new Date().toISOString(), excluded_by: userProfile?.email || ""
    }).eq("id", txn.id).eq("company_id", companyId);

    const { error: decErr } = await supabase.from("bank_posting_decision").insert([{
      company_id: companyId, bank_feed_transaction_id: txn.id,
      decision_type: "exclude", memo: reason, status: "posted",
      created_by: userProfile?.email || ""
    }]);
    if (decErr) { showToast("Error saving exclusion decision: " + decErr.message, "error"); return; }

    logAudit("update", "banking", `Excluded bank txn: ${txn.bank_description_clean} (${reason})`, txn.id, userProfile?.email, "", companyId);
    showToast("Transaction excluded.", "success");
    refreshData();
    } finally { guardRelease("bankExclude", txn.id); }
  }

  // --- Match: find existing JEs that could be this bank transaction ---
  async function findMatches(txn) {
    setMatchLoading(true);
    setMatchCandidates([]);
    const abs = Math.abs(txn.amount);
    const dateTolerance = 10; // days
    // Find JEs within date tolerance that have a line matching this amount on the bank account
    const { data: candidates } = await supabase.from("acct_journal_entries").select("*, lines:acct_journal_lines(*)")
      .eq("company_id", companyId).eq("status", "posted")
      .gte("date", (() => { const d = new Date(txn.posted_date); d.setDate(d.getDate() - dateTolerance); return d.toISOString().slice(0, 10); })())
      .lte("date", (() => { const d = new Date(txn.posted_date); d.setDate(d.getDate() + dateTolerance); return d.toISOString().slice(0, 10); })())
      .order("date", { ascending: false }).limit(50);
    // Check which JEs are already linked to a bank feed transaction
    const { data: existingLinks } = await supabase.from("bank_feed_transaction_link").select("linked_object_id")
      .eq("company_id", companyId).eq("linked_object_type", "journal_entry");
    const linkedJEIds = new Set((existingLinks || []).map(l => l.linked_object_id));
    // Score candidates
    const scored = (candidates || []).filter(je => !linkedJEIds.has(je.id)).map(je => {
      const jeTotal = (je.lines || []).reduce((s, l) => s + safeNum(l.debit), 0);
      const amountDiff = Math.abs(jeTotal - abs);
      const dateDiff = Math.abs(Math.round((new Date(je.date) - new Date(txn.posted_date)) / 86400000));
      let score = 0;
      if (amountDiff < 0.01) score += 50; // exact amount
      else if (amountDiff < 1) score += 30;
      if (dateDiff === 0) score += 30; // same day
      else if (dateDiff <= 3) score += 20;
      else if (dateDiff <= 7) score += 10;
      // Description similarity
      const jeDesc = (je.description || "").toLowerCase();
      const txnDesc = (txn.bank_description_clean || "").toLowerCase();
      if (jeDesc && txnDesc) {
        const words = txnDesc.split(/\s+/).filter(w => w.length > 3);
        const matchedWords = words.filter(w => jeDesc.includes(w));
        if (matchedWords.length > 0) score += Math.min(20, matchedWords.length * 5);
      }
      return { ...je, _score: score, _amountDiff: amountDiff, _dateDiff: dateDiff, _jeTotal: jeTotal };
    }).filter(c => c._score >= 20).sort((a, b) => b._score - a._score).slice(0, 10);
    setMatchCandidates(scored);
    setMatchLoading(false);
  }

  async function confirmMatch(txn, targetJE) {
    if (!guardSubmit("bankMatch", txn.id)) return;
    try {
    // Link bank transaction to existing JE without creating a new one
    const { error: linkErr } = await supabase.from("bank_feed_transaction_link").insert([{
      company_id: companyId, bank_feed_transaction_id: txn.id,
      linked_object_type: "journal_entry", linked_object_id: targetJE.id,
      link_role: "matched_to"
    }]);
    if (linkErr) { showToast("Error linking transaction: " + linkErr.message, "error"); return; }
    const { error: decErr } = await supabase.from("bank_posting_decision").insert([{
      company_id: companyId, bank_feed_transaction_id: txn.id,
      decision_type: "match", memo: `Matched to ${targetJE.number}`,
      status: "posted", created_by: userProfile?.email || ""
    }]);
    if (decErr) { showToast("Error saving match decision: " + decErr.message, "error"); return; }
    await supabase.from("bank_feed_transaction").update({
      status: "matched", accepted_at: new Date().toISOString(),
      accepted_by: userProfile?.email || "", journal_entry_id: targetJE.id,
      matched_target_type: "journal_entry", matched_target_id: targetJE.id
    }).eq("id", txn.id).eq("company_id", companyId);
    logAudit("update", "banking", `Matched bank txn to ${targetJE.number}: ${txn.bank_description_clean}`, txn.id, userProfile?.email, "", companyId);
    showToast(`Matched to ${targetJE.number}.`, "success");
    setExpandedTxn(null); setMatchCandidates([]);
    refreshData();
    if (onRefreshAccounting) onRefreshAccounting();
    } finally { guardRelease("bankMatch", txn.id); }
  }

  // --- Transfer: between balance sheet accounts ---
  async function acceptTransfer(txn, toAccountId, toAccountName, memo) {
    if (!guardSubmit("bankTransfer", txn.id)) return;
    try {
    if (!toAccountId) { showToast("Please select a transfer account.", "error"); return; }
    if (await checkPeriodLock(companyId, txn.posted_date)) { showToast("This transaction date falls in a locked accounting period.", "error"); return; }
    const feed = feeds.find(f => f.id === txn.bank_account_feed_id);
    if (!feed?.gl_account_id) { showToast("Bank account not linked to GL.", "error"); return; }
    if (toAccountId === feed.gl_account_id) { showToast("Cannot transfer to the same account.", "error"); return; }
    const bankAcct = accounts.find(a => a.id === feed.gl_account_id);
    const abs = Math.abs(txn.amount);
    const isInflow = txn.direction === "inflow";
    // Transfer: debit one BS account, credit the other (no P&L)
    const lines = isInflow
      ? [{ account_id: feed.gl_account_id, account_name: bankAcct?.name || "Bank", debit: abs, credit: 0, class_id: null, memo: memo || "Transfer" },
         { account_id: toAccountId, account_name: toAccountName, debit: 0, credit: abs, class_id: null, memo: memo || "Transfer" }]
      : [{ account_id: toAccountId, account_name: toAccountName, debit: abs, credit: 0, class_id: null, memo: memo || "Transfer" },
         { account_id: feed.gl_account_id, account_name: bankAcct?.name || "Bank", debit: 0, credit: abs, class_id: null, memo: memo || "Transfer" }];

    const { data: maxJE } = await supabase.from("acct_journal_entries").select("number").eq("company_id", companyId).order("number", { ascending: false }).limit(1).maybeSingle();
    let nextNum = 1; if (maxJE?.number) { const p = parseInt(maxJE.number.replace("JE-",""), 10); if (!isNaN(p)) nextNum = p + 1; }

    const { data: jeRow, error: jeErr } = await supabase.from("acct_journal_entries").insert([{
      company_id: companyId, number: `JE-${String(nextNum).padStart(4,"0")}`, date: txn.posted_date,
      description: memo || `Transfer — ${txn.bank_description_clean}`,
      reference: `XFER-${txn.id}`, property: "", status: "posted" // transfers don't have a class/property
    }]).select("id").maybeSingle();
    if (jeErr || !jeRow) { showToast("Error creating JE: " + (jeErr?.message || ""), "error"); return; }

    const { error: xlErr } = await supabase.from("acct_journal_lines").insert(lines.map(l => ({
      journal_entry_id: jeRow.id, company_id: companyId,
      account_id: l.account_id, account_name: l.account_name,
      debit: safeNum(l.debit), credit: safeNum(l.credit), class_id: null, memo: l.memo || "",
      bank_feed_transaction_id: txn.id
    })));
    if (xlErr) { showToast("Error saving transfer JE lines: " + xlErr.message, "error"); return; }

    const { error: xdErr } = await supabase.from("bank_posting_decision").insert([{
      company_id: companyId, bank_feed_transaction_id: txn.id,
      decision_type: "transfer", memo: memo || "", transfer_gl_account_id: toAccountId,
      status: "posted", created_by: userProfile?.email || ""
    }]);
    if (xdErr) { showToast("Error saving transfer decision: " + xdErr.message, "error"); return; }
    const { error: xkErr } = await supabase.from("bank_feed_transaction_link").insert([{
      company_id: companyId, bank_feed_transaction_id: txn.id,
      linked_object_type: "journal_entry", linked_object_id: jeRow.id, link_role: "created_from"
    }]);
    if (xkErr) { showToast("Error linking transfer: " + xkErr.message, "error"); return; }
    await supabase.from("bank_feed_transaction").update({
      status: "categorized", accepted_at: new Date().toISOString(),
      accepted_by: userProfile?.email || "", journal_entry_id: jeRow.id
    }).eq("id", txn.id).eq("company_id", companyId);
    logAudit("create", "banking", `Transfer: ${txn.bank_description_clean} → ${toAccountName}`, txn.id, userProfile?.email, "", companyId);
    showToast("Transfer posted.", "success");
    setExpandedTxn(null); setTransferForm({ accountId: "", accountName: "", memo: "" });
    refreshData();
    if (onRefreshAccounting) onRefreshAccounting();
    } finally { guardRelease("bankTransfer", txn.id); }
  }

  // --- Split: one bank txn → multiple GL lines ---
  async function acceptSplit(txn, lines) {
    if (!guardSubmit("bankSplit", txn.id)) return;
    try {
    if (await checkPeriodLock(companyId, txn.posted_date)) { showToast("This transaction date falls in a locked accounting period.", "error"); return; }
    const feed = feeds.find(f => f.id === txn.bank_account_feed_id);
    if (!feed?.gl_account_id) { showToast("Bank account not linked to GL.", "error"); return; }
    const validLines = lines.filter(l => l.accountId && safeNum(l.amount) > 0);
    if (validLines.length < 2) { showToast("Split requires at least 2 lines.", "error"); return; }
    const total = validLines.reduce((s, l) => s + safeNum(l.amount), 0);
    const abs = Math.abs(txn.amount);
    const splitTolerance = validLines.length > 2 ? 0.10 : 0.02;
    if (Math.abs(total - abs) > splitTolerance) { showToast(`Split total ($${total.toFixed(2)}) must equal transaction amount ($${abs.toFixed(2)}).`, "error"); return; }

    const bankAcct = accounts.find(a => a.id === feed.gl_account_id);
    const isInflow = txn.direction === "inflow";

    const { data: maxJE } = await supabase.from("acct_journal_entries").select("number").eq("company_id", companyId).order("number", { ascending: false }).limit(1).maybeSingle();
    let nextNum = 1; if (maxJE?.number) { const p = parseInt(maxJE.number.replace("JE-",""), 10); if (!isNaN(p)) nextNum = p + 1; }

    // Resolve property from first split line's class if available
    const splitClassId = lines.find(l => l.classId)?.classId;
    const splitProperty = splitClassId ? (classes.find(c => c.id === splitClassId)?.name || "") : "";

    const { data: jeRow, error: jeErr } = await supabase.from("acct_journal_entries").insert([{
      company_id: companyId, number: `JE-${String(nextNum).padStart(4,"0")}`, date: txn.posted_date,
      description: `Split — ${txn.bank_description_clean}`,
      reference: `SPLIT-${txn.id}`, property: splitProperty, status: "posted"
    }]).select("id").maybeSingle();
    if (jeErr || !jeRow) { pmError("PM-4002", { raw: jeErr, context: "create journal entry" }); return; }

    // Build JE lines: bank side + each split line
    const jeLines = [];
    // Bank side (single line for full amount)
    jeLines.push({
      journal_entry_id: jeRow.id, company_id: companyId,
      account_id: feed.gl_account_id, account_name: bankAcct?.name || "Bank",
      debit: isInflow ? abs : 0, credit: isInflow ? 0 : abs,
      class_id: null, memo: "Split transaction", bank_feed_transaction_id: txn.id
    });
    // Category lines
    for (const l of validLines) {
      jeLines.push({
        journal_entry_id: jeRow.id, company_id: companyId,
        account_id: l.accountId, account_name: l.accountName,
        debit: isInflow ? 0 : safeNum(l.amount), credit: isInflow ? safeNum(l.amount) : 0,
        class_id: l.classId || null, memo: l.memo || "", bank_feed_transaction_id: txn.id
      });
    }
    const { error: slErr } = await supabase.from("acct_journal_lines").insert(jeLines);
    if (slErr) { showToast("Error saving split JE lines: " + slErr.message, "error"); return; }

    // Decision + lines
    const { data: decision, error: sdErr } = await supabase.from("bank_posting_decision").insert([{
      company_id: companyId, bank_feed_transaction_id: txn.id,
      decision_type: "split", memo: `Split into ${validLines.length} lines`,
      status: "posted", created_by: userProfile?.email || ""
    }]).select("id").maybeSingle();
    if (sdErr) { showToast("Error saving split decision: " + sdErr.message, "error"); return; }
    if (decision) {
      const { error: sdlErr } = await supabase.from("bank_posting_decision_line").insert(validLines.map((l, i) => ({
        company_id: companyId, bank_posting_decision_id: decision.id,
        line_no: i + 1, gl_account_id: l.accountId, gl_account_name: l.accountName,
        amount: safeNum(l.amount), entry_side: isInflow ? "credit" : "debit",
        memo: l.memo || "", class_id: l.classId || null
      })));
      if (sdlErr) { showToast("Error saving split lines: " + sdlErr.message, "error"); return; }
    }

    const { error: skErr } = await supabase.from("bank_feed_transaction_link").insert([{
      company_id: companyId, bank_feed_transaction_id: txn.id,
      linked_object_type: "journal_entry", linked_object_id: jeRow.id, link_role: "created_from"
    }]);
    if (skErr) { showToast("Error linking split: " + skErr.message, "error"); return; }
    await supabase.from("bank_feed_transaction").update({
      status: "categorized", accepted_at: new Date().toISOString(),
      accepted_by: userProfile?.email || "", journal_entry_id: jeRow.id,
      posting_decision_id: decision?.id
    }).eq("id", txn.id).eq("company_id", companyId);
    logAudit("create", "banking", `Split: ${txn.bank_description_clean} → ${validLines.length} lines`, txn.id, userProfile?.email, "", companyId);
    showToast(`Split into ${validLines.length} lines and posted.`, "success");
    setExpandedTxn(null); setSplitLines([{ accountId: "", accountName: "", amount: "", memo: "", classId: "" }, { accountId: "", accountName: "", amount: "", memo: "", classId: "" }]);
    refreshData();
    if (onRefreshAccounting) onRefreshAccounting();
    } finally { guardRelease("bankSplit", txn.id); }
  }

  async function undoTransaction(txn) {
    if (!guardSubmit("bankUndo", txn.id)) return;
    try {
    if (txn.status === "locked") { showToast("Cannot undo a locked/reconciled transaction.", "error"); return; }
    if (await checkPeriodLock(companyId, txn.posted_date)) { showToast("This transaction is in a locked accounting period.", "error"); return; }
    if (!await showConfirm({ message: "Undo this transaction? The linked journal entry will be voided." })) return;

    // Void the linked JE if exists
    if (txn.journal_entry_id) {
      await supabase.from("acct_journal_entries").update({ status: "voided" }).eq("id", txn.journal_entry_id).eq("company_id", companyId);
    }

    // Reset transaction status
    await supabase.from("bank_feed_transaction").update({
      status: "for_review", accepted_at: null, accepted_by: null,
      excluded_at: null, excluded_by: null, exclusion_reason: null,
      journal_entry_id: null, posting_decision_id: null,
      matched_target_type: null, matched_target_id: null
    }).eq("id", txn.id).eq("company_id", companyId);

    // Mark decision as undone
    if (txn.posting_decision_id) {
      await supabase.from("bank_posting_decision").update({ status: "undone" }).eq("id", txn.posting_decision_id);
    }

    logAudit("update", "banking", `Undid bank txn: ${txn.bank_description_clean}`, txn.id, userProfile?.email, "", companyId);
    showToast("Transaction returned to For Review.", "success");
    refreshData();
    } finally { guardRelease("bankUndo", txn.id); }
  }

  // --- Rules Engine (V2 multi-condition + V1 fallback) ---
  function evaluateTextOp(op, text, val) {
    switch (op) {
      case "contains": return text.includes(val);
      case "does_not_contain": return !text.includes(val);
      case "is_exactly": return text === val;
      case "starts_with": return text.startsWith(val);
      case "ends_with": return text.endsWith(val);
      case "regex": try { return new RegExp(val, "i").test(text); } catch { return false; }
      default: return text.includes(val);
    }
  }
  function evaluateAmountOp(op, amt, val, val2) {
    const numVal = Number(val) || 0;
    const numVal2 = Number(val2) || 0;
    switch (op) {
      case "is_exactly": return Math.abs(amt - numVal) < 0.01;
      case "greater_than": return amt > numVal;
      case "less_than": return amt < numVal;
      case "between": return amt >= numVal && amt <= numVal2;
      default: return false;
    }
  }
  function evaluateSingleCondition(cond, descClean, descRaw, amt) {
    const field = cond.field || "description";
    const op = cond.operator || "contains";
    const val = (cond.value || "").toLowerCase();
    const val2 = (cond.value2 || "").toLowerCase();
    if (field === "description") return evaluateTextOp(op, descClean, val);
    if (field === "bank_text") return evaluateTextOp(op, descRaw, val);
    if (field === "amount") return evaluateAmountOp(op, amt, val, val2);
    return false;
  }
  function evaluateRules(txn, rulesList) {
    const descClean = (txn.bank_description_clean || "").toLowerCase();
    const descRaw = (txn.bank_description_raw || "").toLowerCase();
    const amt = Math.abs(safeNum(txn.amount));
    for (const rule of rulesList) {
      if (!rule.enabled) continue;
      const condJson = rule.condition_json || {};
      // V2 multi-condition format
      if (condJson.conditions) {
        if (condJson.direction && condJson.direction !== "all" && txn.direction !== condJson.direction) continue;
        if (rule.bank_account_feed_id && rule.bank_account_feed_id !== txn.bank_account_feed_id) continue;
        const logic = condJson.logic || "all";
        const conditions = condJson.conditions || [];
        if (conditions.length === 0) continue;
        const results = conditions.map(c => evaluateSingleCondition(c, descClean, descRaw, amt));
        const matched = logic === "all" ? results.every(r => r) : results.some(r => r);
        if (matched) return { rule, action: rule.action_json || {} };
        continue;
      }
      // V1 legacy fallback
      const desc = descClean || descRaw;
      let matched = false;
      const val = (condJson.value || "").toLowerCase();
      if (val) {
        switch (condJson.operator || "contains") {
          case "contains": matched = desc.includes(val); break;
          case "starts_with": matched = desc.startsWith(val); break;
          case "ends_with": matched = desc.endsWith(val); break;
          case "equals": matched = desc === val; break;
          case "regex": try { matched = new RegExp(condJson.value, "i").test(desc); } catch { matched = false; } break;
          default: matched = desc.includes(val);
        }
      } else { matched = true; }
      if (condJson.direction && condJson.direction !== "all" && txn.direction !== condJson.direction) matched = false;
      if (condJson.amount_min && amt < Number(condJson.amount_min)) matched = false;
      if (condJson.amount_max && amt > Number(condJson.amount_max)) matched = false;
      if (rule.bank_account_feed_id && rule.bank_account_feed_id !== txn.bank_account_feed_id) matched = false;
      if (matched) return { rule, action: rule.action_json || {} };
    }
    return null;
  }

  // rulesOverride lets callers (e.g., saveRule) pass a fresher rules
  // list than the React state, since state updates are async and a
  // newly-created rule won't be in `rules` immediately after the
  // insert returns.
  async function applyRulesToTransactions(txnIds, rulesOverride) {
    const sourceRules = rulesOverride || rules;
    const enabledRules = sourceRules.filter(r => r.enabled);
    if (enabledRules.length === 0) return 0;
    const { data: txns } = await supabase.from("bank_feed_transaction").select("*").in("id", txnIds).eq("status", "for_review");
    if (!txns || txns.length === 0) return 0;
    let applied = 0;
    for (const txn of txns) {
      const result = evaluateRules(txn, enabledRules);
      if (!result) continue;
      const { rule, action } = result;
      const actionType = action.type || "assign";

      // --- EXCLUDE RULES ---
      if (actionType === "exclude") {
        if (rule.auto_accept) {
          await excludeTransaction(txn, action.exclude_reason || "auto-rule");
        } else {
          await supabase.from("bank_feed_transaction").update({
            suggestion_status: "suggested_exclude",
            raw_payload_json: { ...(txn.raw_payload_json || {}), _suggestion: { type: "exclude", reason: action.exclude_reason || "auto-rule", ruleId: rule.id, ruleName: rule.name } }
          }).eq("id", txn.id).eq("company_id", companyId);
        }
        applied++;
        await incrementRuleStats(rule.id);
        continue;
      }

      // --- ASSIGN RULES (single or split) ---
      const lines = action.lines || [];
      const primaryLine = lines[0] || {};
      const isSplit = action.split && lines.length >= 2;

      await supabase.from("bank_feed_transaction").update({
        suggestion_status: "suggested_rule",
        raw_payload_json: { ...(txn.raw_payload_json || {}), _suggestion: {
          type: isSplit ? "split" : "assign",
          transactionType: action.transaction_type || "expense",
          accountId: primaryLine.account_id || "", accountName: primaryLine.account_name || "",
          classId: primaryLine.class_id || "", payee: action.payee || "", memo: action.memo || "",
          split: isSplit, splitBy: action.split_by || null, lines: lines,
          ruleId: rule.id, ruleName: rule.name
        }}
      }).eq("id", txn.id).eq("company_id", companyId);

      if (rule.auto_accept && primaryLine.account_id) {
        if (isSplit) {
          const abs = Math.abs(txn.amount);
          const splitLines = lines.map(l => ({
            accountId: l.account_id, accountName: l.account_name, classId: l.class_id || "",
            memo: action.memo || "",
            amount: action.split_by === "percentage" ? ((l.percentage / 100) * abs).toFixed(2) : String(l.amount || 0)
          }));
          await acceptSplit(txn, splitLines);
        } else if (action.transaction_type === "transfer") {
          await acceptTransfer(txn, primaryLine.account_id, primaryLine.account_name || "", action.memo || "");
        } else {
          await acceptTransaction(txn, primaryLine.account_id, primaryLine.account_name || "", action.memo || "", primaryLine.class_id || "");
        }
      }
      applied++;
      await incrementRuleStats(rule.id);
    }
    return applied;
  }

  function resetRuleForm() {
    setEditingRule(null);
    setRuleForm({
      name: "", conditions: [{ ...EMPTY_CONDITION }], condLogic: "all", condDirection: "all", bankAccountFeedId: "",
      ruleType: "assign", transactionType: "expense", actionPayee: "", actionMemo: "", excludeReason: "personal",
      split: false, splitBy: null, lines: [{ ...EMPTY_LINE }], autoAccept: false, priority: 100
    });
  }
  // Condition helpers
  function addCondition() {
    if (ruleForm.conditions.length >= 5) { showToast("Maximum 5 conditions per rule.", "warning"); return; }
    setRuleForm(f => ({ ...f, conditions: [...f.conditions, { ...EMPTY_CONDITION }] }));
  }
  function removeCondition(idx) {
    if (ruleForm.conditions.length <= 1) return;
    setRuleForm(f => ({ ...f, conditions: f.conditions.filter((_, i) => i !== idx) }));
  }
  function updateCondition(idx, field, value) {
    setRuleForm(f => ({ ...f, conditions: f.conditions.map((c, i) => i === idx ? { ...c, [field]: value } : c) }));
  }
  // Split line helpers
  function addSplitLine() {
    setRuleForm(f => ({ ...f, split: true, splitBy: f.splitBy || "percentage", lines: [...f.lines, { ...EMPTY_LINE }] }));
  }
  function removeSplitLine(idx) {
    setRuleForm(f => {
      const newLines = f.lines.filter((_, i) => i !== idx);
      return { ...f, lines: newLines, split: newLines.length >= 2, splitBy: newLines.length < 2 ? null : f.splitBy };
    });
  }
  function updateLine(idx, field, value) {
    setRuleForm(f => ({ ...f, lines: f.lines.map((l, i) => i === idx ? { ...l, [field]: value } : l) }));
  }
  async function saveRule() {
    if (!ruleForm.name.trim()) { showToast("Rule name is required.", "error"); return; }
    const validConditions = ruleForm.conditions.filter(c =>
      (c.field === "amount" && c.value) || ((c.field === "description" || c.field === "bank_text") && c.value.trim())
    );
    if (validConditions.length === 0) { showToast("At least one condition with a value is required.", "error"); return; }
    if (ruleForm.ruleType === "assign") {
      const validLines = ruleForm.lines.filter(l => l.accountId);
      if (validLines.length === 0) { showToast("At least one category/account is required.", "error"); return; }
      if (ruleForm.split && ruleForm.splitBy === "percentage") {
        const totalPct = validLines.reduce((s, l) => s + (Number(l.percentage) || 0), 0);
        if (Math.abs(totalPct - 100) > 0.01) { showToast(`Split percentages must add up to 100% (currently ${totalPct}%).`, "error"); return; }
      }
    }
    const conditionJson = {
      logic: ruleForm.condLogic, direction: ruleForm.condDirection,
      conditions: validConditions.map(c => {
        const obj = { field: c.field, operator: c.operator, value: c.value };
        if (c.operator === "between" && c.value2) obj.value2 = c.value2;
        return obj;
      })
    };
    let actionJson;
    if (ruleForm.ruleType === "exclude") {
      actionJson = { type: "exclude", exclude_reason: ruleForm.excludeReason || "personal" };
    } else {
      const validLines = ruleForm.lines.filter(l => l.accountId);
      actionJson = {
        type: "assign", transaction_type: ruleForm.transactionType || "expense",
        payee: ruleForm.actionPayee || "", memo: ruleForm.actionMemo || "",
        split: ruleForm.split && validLines.length >= 2, split_by: ruleForm.split ? ruleForm.splitBy : null,
        lines: validLines.map(l => ({
          account_id: l.accountId, account_name: l.accountName, class_id: l.classId || null,
          percentage: ruleForm.splitBy === "percentage" ? Number(l.percentage) || null : null,
          amount: ruleForm.splitBy === "amount" ? Number(l.amount) || null : null
        }))
      };
    }
    const payload = {
      name: ruleForm.name.trim(), priority: Number(ruleForm.priority) || 100,
      condition_json: conditionJson, action_json: actionJson,
      auto_accept: ruleForm.autoAccept, rule_type: ruleForm.ruleType,
      bank_account_feed_id: ruleForm.bankAccountFeedId || null
    };
    if (editingRule) {
      const { error } = await supabase.from("bank_transaction_rule").update(payload).eq("id", editingRule.id);
      if (error) { pmError("PM-5008", { raw: error, context: "update bank rule" }); return; }
      showToast("Rule updated.", "success");
    } else {
      const { error } = await supabase.from("bank_transaction_rule").insert([{ ...payload, company_id: companyId, enabled: true }]);
      if (error) { pmError("PM-5008", { raw: error, context: "create bank rule" }); return; }
      showToast("Rule created.", "success");
    }
    resetRuleForm();
    setShowRuleDrawer(false);

    // Run the saved rule against existing For-Review transactions so
    // backdated matches get the suggestion (or auto-accept) without
    // the user having to click "Re-apply all rules" manually. Without
    // this, a brand-new "Stanley" rule won't touch last year's
    // Stanley Zelle deposits — exact bug Sahil hit on 2026-04-30.
    // Pull a fresh rule list from the DB because React state doesn't
    // reflect the just-saved row inside the same function.
    try {
      const { data: freshRules } = await supabase.from("bank_transaction_rule")
        .select("*").eq("company_id", companyId).order("priority");
      const { data: forReviewIds } = await supabase.from("bank_feed_transaction")
        .select("id").eq("company_id", companyId).eq("status", "for_review");
      const ids = (forReviewIds || []).map(r => r.id);
      if (ids.length > 0) {
        const matched = await applyRulesToTransactions(ids, freshRules || []);
        if (matched > 0) showToast(`Rule applied to ${matched} existing transaction${matched === 1 ? "" : "s"}.`, "success");
      }
    } catch (e) { pmError("PM-5008", { raw: e, context: "auto-apply rule to existing for_review", silent: true }); }

    fetchAll();
  }

  async function deleteRule(ruleId) {
    if (!await showConfirm({ message: "Delete this rule?" })) return;
    if (!guardSubmit("deleteRule", ruleId)) return;
    try {
    const { error } = await supabase.from("bank_transaction_rule").delete().eq("id", ruleId).eq("company_id", companyId);
    if (error) { pmError("PM-5008", { raw: error, context: "delete bank rule" }); return; }
    showToast("Rule deleted.", "success");
    fetchAll();
    } finally { guardRelease("deleteRule", ruleId); }
  }

  async function toggleRule(rule) {
    const { error } = await supabase.from("bank_transaction_rule").update({ enabled: !rule.enabled }).eq("id", rule.id).eq("company_id", companyId);
    if (error) { pmError("PM-5008", { raw: error, context: "toggle bank rule" }); return; }
    fetchAll();
  }

  async function duplicateRule(rule) {
    const { error } = await supabase.from("bank_transaction_rule").insert([{
      company_id: companyId, name: rule.name + " (copy)", priority: (rule.priority || 100) + 1,
      enabled: false, condition_json: rule.condition_json, action_json: rule.action_json,
      auto_accept: rule.auto_accept, rule_type: rule.rule_type, bank_account_feed_id: rule.bank_account_feed_id
    }]);
    if (error) { pmError("PM-5008", { raw: error, context: "duplicate bank rule" }); return; }
    showToast("Rule duplicated (disabled). Edit it to enable.", "success");
    fetchAll();
  }

  async function incrementRuleStats(ruleId) {
    const { error: _statsErr } = await supabase.rpc("increment_rule_stats", { rule_id: ruleId });
    if (_statsErr) pmError("PM-5008", { raw: _statsErr, context: "increment bank rule stats", silent: true });
  }

  // Migrate V1 rules to V2 JSON format (runs once per company)
  async function migrateRulesToV2(rulesList) {
    for (const rule of rulesList) {
      const oldCond = rule.condition_json || {};
      if (oldCond.conditions) continue; // already V2
      const conditions = [];
      if (oldCond.value) {
        conditions.push({ field: oldCond.field || "description", operator: oldCond.operator || "contains", value: oldCond.value });
      }
      if (oldCond.amount_min && oldCond.amount_max) {
        conditions.push({ field: "amount", operator: "between", value: String(oldCond.amount_min), value2: String(oldCond.amount_max) });
      } else if (oldCond.amount_min) {
        conditions.push({ field: "amount", operator: "greater_than", value: String(oldCond.amount_min) });
      } else if (oldCond.amount_max) {
        conditions.push({ field: "amount", operator: "less_than", value: String(oldCond.amount_max) });
      }
      const newCond = { logic: "all", direction: oldCond.direction || "all", conditions: conditions.length > 0 ? conditions : [{ field: "description", operator: "contains", value: "" }] };
      const oldAction = rule.action_json || {};
      const newAction = {
        type: "assign", transaction_type: "expense", payee: oldAction.payee || "", memo: oldAction.memo || "",
        split: false, split_by: null,
        lines: [{ account_id: oldAction.account_id || "", account_name: oldAction.account_name || "", class_id: oldAction.class_id || "", percentage: null, amount: null }]
      };
      await supabase.from("bank_transaction_rule").update({ condition_json: newCond, action_json: newAction, rule_type: "assign" }).eq("id", rule.id).eq("company_id", companyId);
    }
  }

  function trackCategorizationPattern(txn, accountId, accountName, classId) {
    try {
      const key = `catPatterns_${companyId}`;
      const patterns = JSON.parse(localStorage.getItem(key) || "{}");
      const descKey = (txn.bank_description_clean || "").toLowerCase().replace(/\d+/g, "").replace(/\s+/g, " ").trim().split(" ").slice(0, 3).join("_");
      if (!descKey) return;
      if (!patterns[descKey]) patterns[descKey] = { count: 0, accountId: "", accountName: "", classId: "" };
      const p = patterns[descKey];
      if (p.accountId === accountId || !p.accountId) {
        p.count++; p.accountId = accountId; p.accountName = accountName; p.classId = classId; p.lastDesc = txn.bank_description_clean || "";
      } else {
        p.count = 1; p.accountId = accountId; p.accountName = accountName; p.classId = classId; p.lastDesc = txn.bank_description_clean || "";
      }
      localStorage.setItem(key, JSON.stringify(patterns));
      if (p.count === 2) {
        showToast(
          `You've categorized "${(p.lastDesc || "").slice(0, 30)}..." the same way twice. Open the Rules tab to create a rule!`,
          "info"
        );
      }
    } catch (_e) { pmError("PM-8006", { raw: _e, context: "bank categorization pattern learning", silent: true }); }
  }

  const RENTAL_RULE_PRESETS = [
    { name: "Mortgage / Loan Payments", conditions: [{ field: "description", operator: "contains", value: "mortgage" }], direction: "outflow", action: { type: "assign", transaction_type: "expense", lines: [{ accountName: "Mortgage Interest" }] }, description: "Auto-categorize mortgage payments" },
    { name: "Insurance Premiums", conditions: [{ field: "description", operator: "contains", value: "insurance" }], direction: "outflow", action: { type: "assign", transaction_type: "expense", lines: [{ accountName: "Insurance" }] }, description: "Property and liability insurance" },
    { name: "Utility Payments", conditions: [{ field: "description", operator: "contains", value: "dominion" }, { field: "description", operator: "contains", value: "energy" }], condLogic: "any", direction: "outflow", action: { type: "assign", transaction_type: "expense", lines: [{ accountName: "Utilities" }] }, description: "Electric, gas, water payments" },
    { name: "Tenant Rent Deposits", conditions: [{ field: "amount", operator: "greater_than", value: "500" }], direction: "inflow", action: { type: "assign", transaction_type: "deposit", lines: [{ accountName: "Rental Income" }] }, description: "Incoming rent payments" },
    { name: "Home Depot / Lowe's", conditions: [{ field: "description", operator: "contains", value: "home depot" }, { field: "description", operator: "contains", value: "lowes" }], condLogic: "any", direction: "outflow", action: { type: "assign", transaction_type: "expense", lines: [{ accountName: "Repairs & Maintenance" }] }, description: "Hardware store purchases for property repairs" },
    { name: "Personal / Non-Business", conditions: [{ field: "description", operator: "contains", value: "amazon" }, { field: "description", operator: "contains", value: "netflix" }, { field: "description", operator: "contains", value: "spotify" }], condLogic: "any", direction: "outflow", action: { type: "exclude", exclude_reason: "personal" }, description: "Exclude personal purchases" },
  ];

  function applyPreset(preset) {
    const matchedAcct = preset.action.lines?.[0]?.accountName ? accounts.find(a => a.name.toLowerCase().includes(preset.action.lines[0].accountName.toLowerCase())) : null;
    setRuleForm({
      name: preset.name,
      conditions: preset.conditions.map(c => ({ ...c, value2: "" })),
      condLogic: preset.condLogic || "all", condDirection: preset.direction || "all", bankAccountFeedId: "",
      ruleType: preset.action.type || "assign", transactionType: preset.action.transaction_type || "expense",
      actionPayee: "", actionMemo: "", excludeReason: preset.action.exclude_reason || "personal",
      split: false, splitBy: null,
      lines: [{ accountId: matchedAcct?.id || "", accountName: matchedAcct?.name || preset.action.lines?.[0]?.accountName || "", classId: "", percentage: null, amount: null }],
      autoAccept: false, priority: 100
    });
    setEditingRule(null);
    setShowRuleDrawer(true);
  }

  function createRuleFromTransaction(txn) {
    const desc = txn.bank_description_clean || txn.bank_description_raw || "";
    const sug = txn.raw_payload_json?._suggestion;
    const initialConditions = [];
    if (desc) {
      const cleanedDesc = desc.replace(/\d{4,}/g, "").replace(/[#*]/g, "").trim().split(/\s+/).slice(0, 4).join(" ");
      initialConditions.push({ field: "description", operator: "contains", value: cleanedDesc, value2: "" });
    }
    setRuleForm({
      name: desc.split(/\s+/).slice(0, 3).join(" "),
      conditions: initialConditions.length > 0 ? initialConditions : [{ ...EMPTY_CONDITION }],
      condLogic: "all", condDirection: txn.direction || "all", bankAccountFeedId: "",
      ruleType: "assign", transactionType: "expense",
      actionPayee: txn.payee_normalized || "", actionMemo: "",
      excludeReason: "personal", split: false, splitBy: null,
      lines: [{ accountId: sug?.accountId || addForm.accountId || "", accountName: sug?.accountName || addForm.accountName || "", classId: sug?.classId || addForm.classId || "", percentage: null, amount: null }],
      autoAccept: false, priority: 100
    });
    setEditingRule(null);
    setShowRuleDrawer(true);
  }

  function startEditRule(rule) {
    const c = rule.condition_json || {};
    const a = rule.action_json || {};
    setEditingRule(rule);
    // V2 format
    if (c.conditions) {
      const lines = (a.lines || []).map(l => ({
        accountId: l.account_id || "", accountName: l.account_name || "",
        classId: l.class_id || "", percentage: l.percentage, amount: l.amount
      }));
      setRuleForm({
        name: rule.name, conditions: c.conditions.map(cnd => ({ field: cnd.field || "description", operator: cnd.operator || "contains", value: cnd.value || "", value2: cnd.value2 || "" })),
        condLogic: c.logic || "all", condDirection: c.direction || "all",
        bankAccountFeedId: rule.bank_account_feed_id || "",
        ruleType: a.type || rule.rule_type || "assign", transactionType: a.transaction_type || "expense",
        actionPayee: a.payee || "", actionMemo: a.memo || "",
        excludeReason: a.exclude_reason || "personal",
        split: a.split || false, splitBy: a.split_by || null,
        lines: lines.length > 0 ? lines : [{ ...EMPTY_LINE }],
        autoAccept: rule.auto_accept || false, priority: rule.priority || 100
      });
    } else {
      // V1 legacy
      setRuleForm({
        name: rule.name,
        conditions: [{ field: c.field || "description", operator: c.operator || "contains", value: c.value || "", value2: "" }],
        condLogic: "all", condDirection: c.direction || "all", bankAccountFeedId: rule.bank_account_feed_id || "",
        ruleType: "assign", transactionType: "expense",
        actionPayee: a.payee || "", actionMemo: a.memo || "", excludeReason: "personal",
        split: false, splitBy: null,
        lines: [{ accountId: a.account_id || "", accountName: a.account_name || "", classId: a.class_id || "", percentage: null, amount: null }],
        autoAccept: rule.auto_accept || false, priority: rule.priority || 100
      });
    }
    setShowRuleDrawer(true);
  }

  // Bulk actions
  async function bulkAccept(accountId, accountName) {
    const selected = transactions.filter(t => selectedTxns.has(t.id) && t.status === "for_review");
    for (const txn of selected) {
      await acceptTransaction(txn, accountId, accountName, "", "");
    }
    setSelectedTxns(new Set());
  }

  async function bulkExclude(reason) {
    const selected = transactions.filter(t => selectedTxns.has(t.id) && t.status === "for_review");
    for (const txn of selected) {
      await excludeTransaction(txn, reason);
    }
    setSelectedTxns(new Set());
  }

  // --- Filtering ---
  const filtered = transactions.filter(t => {
    if (activeTab === "for_review" && t.status !== "for_review") return false;
    if (activeTab === "recognized" && !(t.status === "for_review" && (t.suggestion_status === "suggested_rule" || t.suggestion_status === "suggested_exclude"))) return false;
    if (activeTab === "categorized" && !["categorized", "matched", "posted"].includes(t.status)) return false;
    if (activeTab === "excluded" && t.status !== "excluded") return false;
    if (activeTab === "rules") return false; // Rules tab shows rules, not transactions
    if (selectedFeed !== "all" && t.bank_account_feed_id !== selectedFeed) return false;
    if (directionFilter !== "all" && t.direction !== directionFilter) return false;
    if (dateFrom && t.posted_date < dateFrom) return false;
    if (dateTo && t.posted_date > dateTo) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!(t.bank_description_clean || "").toLowerCase().includes(q) &&
          !(t.payee_normalized || "").toLowerCase().includes(q) &&
          !(t.memo || "").toLowerCase().includes(q) &&
          !String(t.amount).includes(q)) return false;
    }
    return true;
  });
  const txnTotalPages = Math.max(1, Math.ceil(filtered.length / txnPageSize));
  const safeTxnPage = Math.min(txnPage, txnTotalPages - 1);
  const paginatedTxns = filtered.slice(safeTxnPage * txnPageSize, (safeTxnPage + 1) * txnPageSize);

  // Excel export — uses the current `filtered` list so the download
  // matches exactly what's on screen (active tab, feed, direction,
  // date range, search), minus pagination.
  async function exportTransactionsExcel() {
    try {
      if (!filtered || filtered.length === 0) { showToast("No transactions match the current filter.", "info"); return; }
      const feedName = (id) => {
        const f = feeds.find(ff => ff.id === id);
        return f ? `${f.institution_name || ""} ${f.account_name || ""}${f.masked_number ? " (••••" + f.masked_number + ")" : ""}`.trim() : "";
      };
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Bank Transactions");
      ws.columns = [
        { header: "Date", key: "date", width: 12 },
        { header: "Feed", key: "feed", width: 36 },
        { header: "Source", key: "source", width: 10 },
        { header: "Description", key: "description", width: 50 },
        { header: "Payee", key: "payee", width: 24 },
        { header: "Check #", key: "check", width: 10 },
        { header: "Memo", key: "memo", width: 30 },
        { header: "Direction", key: "direction", width: 10 },
        { header: "Amount (signed)", key: "signed", width: 15 },
        { header: "Amount (abs)", key: "absAmount", width: 15 },
        { header: "Status", key: "status", width: 14 },
        { header: "Reference #", key: "reference", width: 18 },
      ];
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
      for (const t of filtered) {
        const abs = Math.abs(Number(t.amount) || 0);
        const signed = t.direction === "outflow" ? -abs : abs;
        ws.addRow({
          date: t.posted_date,
          feed: feedName(t.bank_account_feed_id),
          source: t.source_type || "",
          description: t.bank_description_clean || t.bank_description_raw || "",
          payee: t.payee_normalized || t.payee_raw || "",
          check: t.check_number || "",
          memo: t.memo || "",
          direction: t.direction || "",
          signed,
          absAmount: abs,
          status: t.status || "",
          reference: t.reference_number || "",
        });
      }
      ws.getColumn("signed").numFmt = '"$"#,##0.00;[Red]"-$"#,##0.00';
      ws.getColumn("absAmount").numFmt = '"$"#,##0.00';
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `bank-transactions-${activeTab}-${formatLocalDate(new Date())}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
      showToast(`Exported ${filtered.length} transaction${filtered.length !== 1 ? "s" : ""}.`, "success");
      logAudit("export", "banking", `Exported ${filtered.length} bank transactions (${activeTab})`, "", userProfile?.email, null, companyId);
    } catch (e) {
      pmError("PM-5005", { raw: e, context: "bank transactions Excel export" });
    }
  }

  const feedTxns = selectedFeed === "all" ? transactions : transactions.filter(t => t.bank_account_feed_id === selectedFeed);
  const counts = {
    for_review: feedTxns.filter(t => t.status === "for_review").length,
    recognized: feedTxns.filter(t => t.status === "for_review" && (t.suggestion_status === "suggested_rule" || t.suggestion_status === "suggested_exclude")).length,
    categorized: feedTxns.filter(t => ["categorized", "matched", "posted"].includes(t.status)).length,
    excluded: feedTxns.filter(t => t.status === "excluded").length,
  };

  if (loading) return <Spinner />;

  // --- RENDER ---
  return (
  <div className="space-y-4">
  {/* Header. On mobile the title block stacks above the action row so
      the buttons get the full width and don't pile into a vertical
      stack to the right of the subtitle. All buttons share size="sm"
      so they match height. */}
  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
    <div><h3 className="text-lg font-semibold text-neutral-900">Bank Transactions</h3><p className="text-sm text-neutral-400">Import, review, and categorize bank transactions</p></div>
    <div className="flex flex-wrap gap-2">
      {connections.some(c => c.connection_status === "active") && <Btn variant="success" size="sm" onClick={() => { setSyncFromDate(""); setSyncDateModal(true); }} disabled={syncing}>{syncing ? "Syncing..." : "Sync"}</Btn>}
      {activeTab !== "rules" && <Btn variant="dark" size="sm" icon="download" onClick={exportTransactionsExcel} disabled={filtered.length === 0}>Export</Btn>}
      <Btn variant="primary" size="sm" onClick={() => {
        // If there are existing Teller enrollments, let the user pick
        // reuse-vs-add-new before the SDK opens — otherwise Teller
        // always creates a fresh enrollment and the same BofA shows up
        // twice in the plan counter.
        const hasTellerEnrollment = connections.some(c => c.source_type === "teller" && c.plaid_item_id);
        if (hasTellerEnrollment) setConnectChooser(true);
        else connectBank();
      }} disabled={plaidConnecting} className="disabled:opacity-50"><span className="material-icons-outlined text-sm">link</span>{plaidConnecting ? "Connecting..." : "Connect Bank"}</Btn>
      <Btn variant="dark" size="sm" icon="upload_file" onClick={startImport}>Import CSV</Btn>
    </div>
  </div>

  {/* Connection Banners */}
  {connections.filter(c => c.connection_status === "needs_reauth").length > 0 && (
  <div className="bg-warn-50 border border-warn-200 rounded-xl p-3 flex items-center justify-between">
    <div className="text-sm text-warn-800"><strong>Action needed:</strong> {connections.filter(c => c.connection_status === "needs_reauth").length} bank connection(s) need re-authentication.</div>
    <Btn variant="warning-fill" size="sm" onClick={() => {
      // Re-auth the specific needs_reauth connection in update mode
      // so Teller doesn't mint a second enrollment for the same bank.
      const stuck = connections.find(c => c.connection_status === "needs_reauth" && c.plaid_item_id);
      connectBank(stuck?.plaid_item_id || undefined);
    }}>Fix Now</Btn>
  </div>
  )}
  {connections.filter(c => c.connection_status === "errored").length > 0 && (
  <div className="bg-warn-50 border border-warn-200 rounded-xl p-3 flex items-center justify-between">
    <div className="text-sm text-warn-800">
      <strong>Sync issue:</strong> {connections.filter(c => c.connection_status === "errored").map(c => {
        const msg = c.last_error_message || "Unknown error";
        if (msg.includes("gateway_timeout") || msg.includes("taking too long")) return `${c.institution_name || "Bank"}: The bank took too long to respond. Try syncing again.`;
        if (msg.includes("AUTH_FAILED")) return `${c.institution_name || "Bank"}: Re-authentication required. Click Connect Bank to reconnect.`;
        return `${c.institution_name || "Bank"}: ${msg.replace(/\{.*\}/g, "").trim() || "Temporary error. Try again."}`;
      }).join(" · ")}
    </div>
    <Btn variant="warning-fill" onClick={() => { setSyncFromDate(""); setSyncDateModal(true); }} className="shrink-0">Retry Sync</Btn>
  </div>
  )}

  {/* Account Cards */}
  {feeds.length > 0 && (() => {
    const isFeedHidden = (f) => f.status === "inactive" || !f.gl_account_id;
    const hiddenCount = feeds.filter(isFeedHidden).length;
    const visibleFeeds = showHiddenFeeds ? feeds : feeds.filter(f => !isFeedHidden(f));
    return (
  <div className="flex gap-3 overflow-x-auto pb-1 items-stretch">
    {visibleFeeds.map(feed => {
      // Pull the unfiltered for_review count from feedPending (the
      // same source the recon math uses). Previously this read from
      // the date-windowed `transactions` state which produced a count
      // that didn't match the panel's "(N txns)" — confusing UX.
      const reviewCount = (feedPending[feed.id] || []).length;
      const isSelected = selectedFeed === feed.id;
      const isMenuOpen = feedMenuOpen === feed.id;
      const isUnmapped = !feed.gl_account_id;
      const isInactive = feed.status === "inactive";
      return (
      <div key={feed.id} className="relative shrink-0">
      <button onClick={() => { setSelectedFeed(isSelected ? "all" : feed.id); setFeedMenuOpen(null); }}
        className={`rounded-xl border-2 p-3 min-w-48 text-left transition-all w-full ${isInactive ? "border-neutral-200 bg-neutral-50 opacity-60" : isUnmapped ? "border-warn-300 bg-warn-50/30" : isSelected ? "border-brand-600 bg-brand-50" : "border-neutral-200 bg-white hover:border-neutral-300"}`}>
        <div className="flex items-start justify-between">
          <div className="text-xs text-neutral-400 truncate">{feed.institution_name || feed.account_type}</div>
          <span onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setFeedMenuPos({ top: r.bottom + 4, left: r.right - 160 }); setFeedMenuOpen(isMenuOpen ? null : feed.id); }}
            className="text-neutral-300 hover:text-neutral-600 -mt-0.5 -mr-1 cursor-pointer">
            <span className="material-icons-outlined text-base">more_vert</span>
          </span>
        </div>
        <div className="font-semibold text-neutral-800 truncate">{feed.account_name}</div>
        {feed.masked_number && <div className="text-xs text-neutral-400">••••{feed.masked_number}</div>}
        {isInactive && <div className="text-xs text-neutral-500 mt-1 font-medium">Disconnected · won't sync</div>}
        {!isInactive && isUnmapped && <div className="text-xs text-warn-600 mt-1 font-medium">Not mapped to GL</div>}
        <div className="flex justify-between items-center mt-2">
          <span className={`text-xs px-1.5 py-0.5 rounded ${feed.connection_type === "teller" ? "bg-info-100 text-info-700" : feed.connection_type === "plaid" ? "bg-info-100 text-info-700" : "bg-neutral-100 text-neutral-500"}`}>{feed.connection_type === "teller" ? "Teller" : feed.connection_type === "plaid" ? "Plaid" : "CSV"}</span>
          {feed.last_synced_at && <span className="text-xs text-neutral-400">{new Date(feed.last_synced_at).toLocaleDateString()}</span>}
          {reviewCount > 0 && <span className="text-xs bg-warn-100 text-warn-700 px-1.5 py-0.5 rounded-full font-bold">{reviewCount}</span>}
        </div>
        {/* Per-card live reconciliation block. Replaces the page-level
            banner so all feeds show their reco status on the same
            screen. Compact 3-line layout: Bank/Books/Pending row, then
            either a green ✓ Reconciled chip or a red Mismatch row with
            the exact diff and formula. */}
        {(() => {
          const r = computeFeedRecon(feed);
          if (r.bankBal == null && r.bookBal === 0 && r.pendingNet === 0) return null; // empty feed
          const wrapCls = r.bankBal == null
            ? "border-neutral-200"
            : r.isReconciled ? "border-positive-200 bg-positive-50/30" : "border-danger-200 bg-danger-50/30";
          return (
            <div className={`mt-2 pt-2 border-t ${wrapCls} text-[11px] space-y-0.5`}>
              <div className="flex justify-between text-neutral-500">
                <span>Bank</span>
                <span className="font-mono text-neutral-800">{r.bankBal == null ? "—" : formatCurrency(r.bankBal)}</span>
              </div>
              <div className="flex justify-between text-neutral-500">
                <span>Books</span>
                <span className="font-mono text-neutral-800">{formatCurrency(r.bookBal)}</span>
              </div>
              <div className="flex justify-between text-neutral-500">
                <span>Pending ({r.pendingCount})</span>
                <span className="font-mono text-neutral-800">{formatCurrency(r.pendingNet)}</span>
              </div>
              <div className="flex justify-between items-center pt-1 border-t border-dashed border-neutral-200">
                {r.bankBal == null ? (
                  <span className="text-[10px] text-neutral-400 italic">Connect bank for reco</span>
                ) : r.isReconciled ? (
                  <span className="text-positive-700 font-semibold">✓ Reconciled</span>
                ) : (
                  <>
                    <span className="text-danger-700 font-semibold">⚠ Mismatch</span>
                    <span className="font-mono font-bold text-danger-700">{formatCurrency(r.diff)}</span>
                  </>
                )}
              </div>
            </div>
          );
        })()}
      </button>
      {isMenuOpen && <>
        <div className="fixed inset-0 z-30" onClick={() => setFeedMenuOpen(null)} />
        <div className="fixed z-40 bg-white border border-neutral-200 rounded-xl shadow-lg py-1 min-w-40" style={{ top: feedMenuPos.top, left: Math.max(8, feedMenuPos.left) }}>
          <button onClick={() => { setGlMapModal({ feedId: feed.id, feedName: feed.account_name || "Bank Account" }); setGlMapValue(feed.gl_account_id || ""); setFeedMenuOpen(null); }}
            className="w-full text-left px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50 flex items-center gap-2">
            <span className="material-icons-outlined text-sm">link</span>Change GL Mapping
          </button>
          {feed.status === "inactive" ? (
          <button onClick={() => { reactivateFeed(feed.id); setFeedMenuOpen(null); }}
            className="w-full text-left px-3 py-2 text-sm text-positive-600 hover:bg-positive-50 flex items-center gap-2">
            <span className="material-icons-outlined text-sm">link</span>Reactivate
          </button>
          ) : (
          <button onClick={() => { disconnectFeed(feed.id); setFeedMenuOpen(null); }}
            className="w-full text-left px-3 py-2 text-sm text-danger-600 hover:bg-danger-50 flex items-center gap-2">
            <span className="material-icons-outlined text-sm">link_off</span>Disconnect
          </button>
          )}
        </div>
      </>}
      </div>
      );
    })}
    <button onClick={() => setShowNewAccount(true)} className="shrink-0 rounded-xl border-2 border-dashed border-neutral-200 p-3 min-w-36 flex flex-col items-center justify-center gap-1 text-neutral-400 hover:border-neutral-400 hover:text-neutral-600">
      <span className="material-icons-outlined">add</span>
      <span className="text-xs">New Account</span>
    </button>
    {hiddenCount > 0 && (
    <button onClick={() => setShowHiddenFeeds(v => !v)}
      className="shrink-0 rounded-xl border border-neutral-200 px-3 min-w-32 flex flex-col items-center justify-center gap-1 text-neutral-500 hover:border-neutral-300 hover:text-neutral-700 bg-neutral-50">
      <span className="material-icons-outlined text-base">{showHiddenFeeds ? "visibility_off" : "visibility"}</span>
      <span className="text-xs font-medium">{showHiddenFeeds ? `Hide ${hiddenCount}` : `Show ${hiddenCount} hidden`}</span>
    </button>
    )}
  </div>
    );
  })()}

  {feeds.length === 0 && (
  <div className="bg-white rounded-xl border border-neutral-200 p-8 text-center">
    <div className="text-3xl mb-3">🏦</div>
    <h4 className="font-semibold text-neutral-800 mb-1">No bank accounts set up</h4>
    <p className="text-sm text-neutral-400 mb-4">Create a bank account to start importing transactions</p>
    <Btn variant="primary" onClick={() => setShowNewAccount(true)}>+ Add Bank Account</Btn>
  </div>
  )}

  {/* Live reconciliation moved inline to each account card above —
      every feed shows its Bank/Books/Pending/Diff in one screen. */}

  {/* Tabs */}
  {feeds.length > 0 && (<>
  <div className="flex gap-1 border-b border-neutral-200">
    {[["for_review", `For Review (${counts.for_review})`], ["recognized", `Recognized (${counts.recognized})`], ["categorized", `Categorized (${counts.categorized})`], ["excluded", `Excluded (${counts.excluded})`], ["rules", `Rules (${rules.length})`]].map(([id, label]) => (
    <button key={id} onClick={() => { setActiveTab(id); setSelectedTxns(new Set()); setTxnPage(0); }}
      className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${activeTab === id ? "border-brand-600 text-brand-700" : "border-transparent text-neutral-400 hover:text-neutral-600"}`}>{label}</button>
    ))}
  </div>

  {/* Rules Tab Content */}
  {activeTab === "rules" && (
  <div className="space-y-4">
    <div className="flex items-center justify-between">
      <p className="text-sm text-neutral-500">Rules run in priority order. First matching rule wins.</p>
      <Btn variant="accent-fill" size="sm" icon="add" onClick={() => { resetRuleForm(); setShowRuleDrawer(true); }}>New Rule</Btn>
    </div>
    <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-neutral-50 border-b border-neutral-200">
          <tr>
            <th className="px-3 py-2.5 w-12 text-center text-xs font-semibold text-neutral-500">#</th>
            <th className="px-3 py-2.5 text-left text-xs font-semibold text-neutral-500">RULE NAME</th>
            <th className="px-3 py-2.5 text-left text-xs font-semibold text-neutral-500">CONDITIONS</th>
            <th className="px-3 py-2.5 text-left text-xs font-semibold text-neutral-500">ACTION</th>
            <th className="px-3 py-2.5 text-center text-xs font-semibold text-neutral-500">MATCHED</th>
            <th className="px-3 py-2.5 text-center text-xs font-semibold text-neutral-500">STATUS</th>
            <th className="px-3 py-2.5 text-right text-xs font-semibold text-neutral-500">ACTIONS</th>
          </tr>
        </thead>
        <tbody>
          {rules.map(r => {
            const cond = r.condition_json || {};
            const act = r.action_json || {};
            const conditions = cond.conditions || [];
            const lines = act.lines || [];
            return (
            <tr key={r.id} className="border-b border-neutral-100 hover:bg-neutral-50">
              <td className="px-3 py-3 text-center"><span className="font-mono text-xs text-neutral-400">{r.priority}</span></td>
              <td className="px-3 py-3"><span className="font-semibold text-neutral-800">{r.name}</span>{r.auto_accept && <span className="ml-2 text-xs bg-warn-100 text-warn-700 px-1.5 py-0.5 rounded">auto-add</span>}</td>
              <td className="px-3 py-3 text-xs text-neutral-500 max-w-48">
                <span className="text-accent-600 font-medium">{(cond.logic || "all").toUpperCase()}</span>{" of: "}
                {conditions.map((c, i) => <span key={i}>{i > 0 && ", "}{c.field} {c.operator} "{c.value}"</span>)}
                {cond.direction !== "all" && <span className="ml-1">· {cond.direction}</span>}
              </td>
              <td className="px-3 py-3 text-xs">
                {act.type === "exclude" ? <span className="text-danger-600 font-medium">Exclude ({act.exclude_reason})</span>
                  : <span className="text-info-600">{lines.map(l => l.account_name).join(" + ") || "—"}{act.split && <span className="text-highlight-500 ml-1">(split)</span>}</span>}
              </td>
              <td className="px-3 py-3 text-center text-xs text-neutral-400">{r.apply_count || 0}</td>
              <td className="px-3 py-3 text-center">
                <Chip tone={r.enabled ? "success" : "neutral"} onClick={() => toggleRule(r)}>{r.enabled ? "On" : "Off"}</Chip>
              </td>
              <td className="px-3 py-3 text-right">
                <TextLink tone="brand" size="xs" onClick={() => startEditRule(r)} className="mr-2">Edit</TextLink>
                <TextLink tone="neutral" size="xs" onClick={() => duplicateRule(r)} className="mr-2">Copy</TextLink>
                <TextLink tone="danger" size="xs" underline={false} onClick={() => deleteRule(r.id)}>Delete</TextLink>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
      {rules.length === 0 && (
        <div className="py-8 text-center text-neutral-400">
          <div className="text-3xl mb-2">📋</div>
          <p className="font-medium">No rules yet</p>
          <p className="text-xs mt-1 mb-4">Rules auto-categorize imported transactions. Start with a template or create your own!</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-left max-w-3xl mx-auto">
            {RENTAL_RULE_PRESETS.map((preset, i) => (
              <button key={i} onClick={() => applyPreset(preset)} className="bg-white border border-accent-100 rounded-xl p-3 hover:border-accent-300 hover:shadow-sm transition-all text-left">
                <p className="text-sm font-semibold text-neutral-700">{preset.name}</p>
                <p className="text-xs text-neutral-400 mt-1">{preset.description}</p>
                <div className="flex gap-1 mt-2">
                  {preset.action.type === "exclude" ? <span className="text-xs bg-danger-100 text-danger-600 px-1.5 py-0.5 rounded">Exclude</span> : <span className="text-xs bg-accent-100 text-accent-600 px-1.5 py-0.5 rounded">Assign</span>}
                  <span className="text-xs bg-neutral-100 text-neutral-500 px-1.5 py-0.5 rounded">{preset.conditions.length} condition{preset.conditions.length > 1 ? "s" : ""}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
    {rules.length > 0 && counts.for_review > 0 && (
      <TextLink tone="accent" size="sm" onClick={async () => { const ids = transactions.filter(t => t.status === "for_review").map(t => t.id); const n = await applyRulesToTransactions(ids); showToast(`Rules applied to ${n} transaction(s).`, "success"); }}>Re-apply all rules to {counts.for_review} "For Review" transactions</TextLink>
    )}
  </div>
  )}

  {/* Filters (hidden on Rules tab) */}
  {activeTab !== "rules" && (
  <div className="flex items-center gap-2 flex-wrap">
    <Input placeholder="Search description, payee, amount..." value={searchQuery} onChange={e => { setSearchQuery(e.target.value); setTxnPage(0); }} className="w-64 !py-1.5 text-sm" />
    <Input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setTxnPage(0); }} className="w-32 !py-1.5 text-xs" />
    <Input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setTxnPage(0); }} className="w-32 !py-1.5 text-xs" />
    <Select value={directionFilter} onChange={e => { setDirectionFilter(e.target.value); setTxnPage(0); }} className="border border-brand-100 rounded-xl px-2 py-1.5 text-xs">
      <option value="all">All</option><option value="inflow">Money In</option><option value="outflow">Money Out</option>
    </Select>
    {/* Server-side date window — smaller datasets load faster. The
        dateFrom/dateTo inputs to the left further narrow the visible set
        client-side. */}
    <Select value={dateRangeMode} onChange={e => { setDateRangeMode(e.target.value); setTxnPage(0); }} className="border border-brand-100 rounded-xl px-2 py-1.5 text-xs" title="Fetch window">
      <option value="30d">Last 30 days</option>
      <option value="90d">Last 90 days</option>
      <option value="6m">Last 6 months</option>
      <option value="1y">Last 1 year</option>
      <option value="all">All time</option>
    </Select>
  </div>
  )}
  {activeTab !== "rules" && txnTruncated && (
    <div className="bg-warn-50 border border-warn-200 rounded-lg px-3 py-2 text-xs text-warn-700">
      Showing the most recent {transactions.length.toLocaleString()} of {totalTxnCount.toLocaleString()} transactions in this window. Narrow the date range or filters to see older activity.
    </div>
  )}

  {activeTab !== "rules" && (<>
  {/* Bulk Action Bar */}
  {selectedTxns.size > 0 && activeTab === "for_review" && (
  <div className="bg-brand-50 border border-brand-200 rounded-xl px-4 py-3 flex items-center justify-between">
    <span className="text-sm font-medium text-brand-800">{selectedTxns.size} selected</span>
    <div className="flex gap-2">
      <Btn variant="danger" size="sm" onClick={() => bulkExclude("duplicate")}>Exclude All</Btn>
      <TextLink tone="neutral" size="xs" underline={false} onClick={() => setSelectedTxns(new Set())} className="px-3 py-1.5 rounded-lg hover:bg-neutral-100">Deselect</TextLink>
    </div>
  </div>
  )}

  {/* Counter + Pagination */}
  <div className="flex items-center justify-between flex-wrap gap-2">
    <div className="text-xs text-neutral-500">{filtered.length} of {feedTxns.length} transactions{filtered.length !== feedTxns.length ? " (filtered)" : ""}</div>
    <div className="flex items-center gap-3">
      <label className="text-xs text-neutral-500 flex items-center gap-1.5">
        Per page
        <Select value={txnPageSize} onChange={e => setTxnPageSize(Number(e.target.value))} size="sm" className="w-20">
          <option value={25}>25</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
          <option value={250}>250</option>
        </Select>
      </label>
      {txnTotalPages > 1 && (
      <div className="flex items-center gap-2">
        <Btn variant="secondary" size="sm" onClick={() => setTxnPage(Math.max(0, safeTxnPage - 1))} disabled={safeTxnPage === 0}>← Prev</Btn>
        <span className="text-xs text-neutral-500">Page {safeTxnPage + 1} of {txnTotalPages}</span>
        <Btn variant="secondary" size="sm" onClick={() => setTxnPage(Math.min(txnTotalPages - 1, safeTxnPage + 1))} disabled={safeTxnPage >= txnTotalPages - 1}>Next →</Btn>
      </div>
      )}
    </div>
  </div>

  {/* Transaction Table */}
  <div className="bg-white rounded-xl border border-neutral-200 overflow-x-auto">
  <table className="w-full text-sm">
  <thead className="bg-neutral-50 border-b border-neutral-200">
    <tr>
      {activeTab === "for_review" && <th className="px-3 py-2.5 w-8"><Checkbox checked={selectedTxns.size === filtered.length && filtered.length > 0} onChange={e => { if (e.target.checked) setSelectedTxns(new Set(filtered.map(t => t.id))); else setSelectedTxns(new Set()); }} className="accent-brand-600" /></th>}
      <th className="px-3 py-2.5 text-left text-xs font-semibold text-neutral-500">DATE</th>
      <th className="px-3 py-2.5 text-left text-xs font-semibold text-neutral-500">DESCRIPTION</th>
      <th className="px-3 py-2.5 text-left text-xs font-semibold text-neutral-500">PAYEE</th>
      {activeTab === "categorized" && <th className="px-3 py-2.5 text-left text-xs font-semibold text-neutral-500">CATEGORY</th>}
      {activeTab === "excluded" && <th className="px-3 py-2.5 text-left text-xs font-semibold text-neutral-500">REASON</th>}
      <th className="px-3 py-2.5 text-right text-xs font-semibold text-neutral-500">AMOUNT</th>
      <th className="px-3 py-2.5 text-right text-xs font-semibold text-neutral-500">ACTION</th>
    </tr>
  </thead>
  <tbody>
  {paginatedTxns.map(txn => {
    const isExpanded = expandedTxn === txn.id;
    return (
    <React.Fragment key={txn.id}>
    <tr data-txn-id={txn.id} className={`border-b border-neutral-100 hover:bg-neutral-50 cursor-pointer ${isExpanded ? "bg-brand-50/50" : ""}`} onClick={() => setExpandedTxn(isExpanded ? null : txn.id)}>
      {activeTab === "for_review" && <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}><Checkbox checked={selectedTxns.has(txn.id)} onChange={e => { const s = new Set(selectedTxns); e.target.checked ? s.add(txn.id) : s.delete(txn.id); setSelectedTxns(s); }} className="accent-brand-600" /></td>}
      <td className="px-3 py-2.5 text-neutral-600 whitespace-nowrap">{txn.posted_date}</td>
      <td className="px-3 py-2.5 text-neutral-800 max-w-xs truncate">
        {txn.bank_description_clean || txn.bank_description_raw}
        {txn.suggestion_status === "suggested_rule" && (() => { const sug = txn.raw_payload_json?._suggestion; const sugType = sug?.type || "assign"; return <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${sugType === "split" ? "bg-highlight-100 text-highlight-600" : "bg-accent-100 text-accent-600"}`}>{sugType === "split" ? "Rule: Split" : "Rule"}</span>; })()}
        {txn.suggestion_status === "suggested_exclude" && <span className="ml-1.5 text-xs bg-danger-100 text-danger-600 px-1.5 py-0.5 rounded-full">Rule: Exclude</span>}
      </td>
      <td className="px-3 py-2.5 text-neutral-500 truncate max-w-32">{txn.payee_normalized || "—"}</td>
      {activeTab === "categorized" && <td className="px-3 py-2.5 text-xs"><span className="bg-success-100 text-success-700 px-2 py-0.5 rounded-full">Posted</span></td>}
      {activeTab === "excluded" && <td className="px-3 py-2.5 text-xs text-danger-600">{txn.exclusion_reason || "—"}</td>}
      <td className={`px-3 py-2.5 text-right font-mono font-semibold ${txn.direction === "inflow" ? "text-success-700" : "text-danger-600"}`}>{txn.direction === "inflow" ? "+" : "-"}${safeNum(txn.amount).toFixed(2)}</td>
      <td className="px-3 py-2.5 text-right whitespace-nowrap">
        {txn.status === "for_review" && <TextLink tone="brand" size="xs" underline={false} onClick={e => { e.stopPropagation(); if (isExpanded) { setExpandedTxn(null); } else { setExpandedTxn(txn.id); const sug = txn.raw_payload_json?._suggestion; if (sug?.type === "split" && sug.lines?.length >= 2) { setActionMode("split"); const abs = Math.abs(txn.amount); setSplitLines(sug.lines.map(l => ({ accountId: l.account_id || "", accountName: l.account_name || "", classId: l.class_id || "", memo: sug.memo || "", amount: sug.splitBy === "percentage" ? ((l.percentage / 100) * abs).toFixed(2) : String(l.amount || 0) }))); } else if (sug) { setActionMode("add"); setAddForm({ accountId: sug.accountId || "", accountName: sug.accountName || "", memo: sug.memo || "", classId: sug.classId || "" }); } else { setActionMode("add"); setAddForm({ accountId: "", accountName: "", memo: "", classId: "" }); } }}} className="font-semibold hover:underline">{txn.suggestion_status === "suggested_rule" || txn.suggestion_status === "suggested_exclude" ? "Review" : "Add"}</TextLink>}
        {["categorized", "matched", "posted"].includes(txn.status) && <TextLink tone="neutral" size="xs" onClick={e => { e.stopPropagation(); undoTransaction(txn); }}>Undo</TextLink>}
        {txn.status === "excluded" && <TextLink tone="info" size="xs" onClick={e => { e.stopPropagation(); undoTransaction(txn); }}>Restore</TextLink>}
      </td>
    </tr>
    {/* Inline Action Panel */}
    {isExpanded && txn.status === "for_review" && (
    <tr><td colSpan={7} className="px-4 py-3 bg-brand-50/30 border-b border-brand-100">
      {/* Action Tabs */}
      <div className="flex gap-1 mb-3 border-b border-brand-100 pb-2">
        {[["add","Add"],["match","Match"],["transfer","Transfer"],["split","Split"]].map(([id,label]) => (
          <button key={id} onClick={() => { setActionMode(id); if (id === "match") findMatches(txn); }}
            className={`px-3 py-1 text-xs font-medium rounded-lg ${actionMode === id ? "bg-brand-600 text-white" : "bg-white text-neutral-500 hover:bg-neutral-50 border border-neutral-200"}`}>{label}</button>
        ))}
        <button onClick={() => { const reason = prompt("Exclude reason: duplicate / personal / noise / error"); if (reason) excludeTransaction(txn, reason); }}
          className="px-3 py-1 text-xs text-danger-500 hover:bg-danger-50 rounded-lg ml-auto border border-danger-200">Exclude</button>
      </div>
      {/* Rule Suggestion Indicator */}
      {txn.raw_payload_json?._suggestion?.ruleName && (
        <div className="text-xs text-accent-600 mb-2 flex items-center gap-1"><span className="material-icons-outlined text-sm">auto_fix_high</span>Suggested by rule: <strong>{txn.raw_payload_json._suggestion.ruleName}</strong>
        {txn.suggestion_status === "suggested_exclude" && <span className="ml-2 text-danger-500">— This rule suggests excluding this transaction ({txn.raw_payload_json._suggestion.reason || "auto-rule"}). <TextLink tone="danger" size="xs" underline={false} onClick={() => excludeTransaction(txn, txn.raw_payload_json._suggestion.reason || "auto-rule")} className="font-semibold hover:underline ml-1">Confirm Exclude</TextLink></span>}
        </div>
      )}

      {/* ADD */}
      {actionMode === "add" && (
      <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 items-end">
        <div><label className="text-xs font-medium text-neutral-500 block mb-1">Category *</label>
          <AccountPicker value={addForm.accountId} onChange={v => { if (v === "__new__") { setShowNewBankAcct(true); return; } const a = accounts.find(a => a.id === v); setAddForm({...addForm, accountId: v, accountName: a?.name || ""}); }} accounts={accounts} accountTypes={ACCOUNT_TYPES} showNewOption placeholder="Search accounts..." /></div>
        <div><label className="text-xs font-medium text-neutral-500 block mb-1">Tenant/Vendor</label>
          <Select value={addForm.entityId ? `${addForm.entityType}:${addForm.entityId}` : ""} onChange={e => { if (!e.target.value) { setAddForm(f => ({...f, entityType: "", entityId: "", entityName: ""})); return; } const [type, id] = e.target.value.split(":"); const name = type === "customer" ? tenants.find(t => t.id === id)?.name : vendors.find(v => v.id === id)?.name; setAddForm(f => ({...f, entityType: type, entityId: id, entityName: name || ""})); }} className="w-full border border-brand-100 rounded-lg px-2 py-1.5 text-xs">
            <option value="">None</option><optgroup label="Tenants">{tenants.map(t => <option key={t.id} value={`customer:${t.id}`}>{t.name}</option>)}</optgroup><optgroup label="Vendors">{vendors.map(v => <option key={v.id} value={`vendor:${v.id}`}>{v.name}</option>)}</optgroup>
          </Select></div>
        <div><label className="text-xs font-medium text-neutral-500 block mb-1">Memo</label>
          <Input type="text" value={addForm.memo} onChange={e => setAddForm({...addForm, memo: e.target.value})} placeholder="Optional..." className="w-full border border-brand-100 rounded-lg px-2 py-1.5 text-xs" /></div>
        <div><label className="text-xs font-medium text-neutral-500 block mb-1">Class</label>
          <Select value={addForm.classId} onChange={e => setAddForm({...addForm, classId: e.target.value})} className="w-full border border-brand-100 rounded-lg px-2 py-1.5 text-xs">
            <option value="">No class</option>{classes.filter(c => c.is_active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select></div>
        <Btn variant="success-fill" onClick={() => acceptTransaction(txn, addForm.accountId, addForm.accountName, addForm.memo, addForm.classId, addForm.entityType, addForm.entityId, addForm.entityName)} disabled={!addForm.accountId} className="disabled:opacity-40">Add & Post</Btn>
      </div>
      )}
      {showNewBankAcct && (
      <div className="bg-brand-50 rounded-xl p-3 mt-2 border border-brand-200">
      <div className="text-xs font-semibold text-brand-700 mb-2">Create New Account</div>
      <div className="grid grid-cols-3 gap-2">
      <div><label className="text-xs text-neutral-500 block mb-1">Type *</label><Select value={newBankAcctForm.type} onChange={e => setNewBankAcctForm({...newBankAcctForm, type: e.target.value})} className="w-full border border-brand-100 rounded-lg px-2 py-1.5 text-xs">{ACCOUNT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</Select></div>
      <div><label className="text-xs text-neutral-500 block mb-1">Code</label><Input value={newBankAcctForm.code} onChange={e => setNewBankAcctForm({...newBankAcctForm, code: e.target.value})} placeholder="Auto" className="w-full border border-brand-100 rounded-lg px-2 py-1.5 text-xs" /></div>
      <div><label className="text-xs text-neutral-500 block mb-1">Name *</label><Input value={newBankAcctForm.name} onChange={e => setNewBankAcctForm({...newBankAcctForm, name: e.target.value})} placeholder="e.g. Office Supplies" className="w-full border border-brand-100 rounded-lg px-2 py-1.5 text-xs" /></div>
      </div>
      <div className="flex gap-2 mt-2"><Btn size="sm" onClick={createInlineBankAcct}>Create</Btn><Btn size="sm" variant="ghost" onClick={() => setShowNewBankAcct(false)}>Cancel</Btn></div>
      </div>
      )}

      {/* MATCH */}
      {actionMode === "match" && (
      <div>
        {matchLoading && <div className="text-xs text-neutral-400 py-4 text-center">Searching for matches...</div>}
        {!matchLoading && matchCandidates.length === 0 && <div className="text-xs text-neutral-400 py-4 text-center">No matching journal entries found within 10 days.</div>}
        {!matchLoading && matchCandidates.length > 0 && (
        <div className="space-y-2 max-h-48 overflow-y-auto">
          <p className="text-xs text-neutral-500 mb-1">{matchCandidates.length} potential match{matchCandidates.length !== 1 ? "es" : ""}</p>
          {matchCandidates.map(c => (
          <div key={c.id} className="flex items-center justify-between bg-white rounded-lg border border-neutral-200 px-3 py-2">
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-neutral-800 truncate">{c.number} — {c.description}</div>
              <div className="text-xs text-neutral-400">{c.date} · ${safeNum(c._jeTotal).toFixed(2)} · Score: {c._score}/100</div>
            </div>
            <Btn variant="primary" onClick={() => confirmMatch(txn, c)} className="shrink-0 ml-2">Match</Btn>
          </div>
          ))}
        </div>
        )}
      </div>
      )}

      {/* TRANSFER */}
      {actionMode === "transfer" && (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
        <div><label className="text-xs font-medium text-neutral-500 block mb-1">Transfer to Account *</label>
          <Select value={transferForm.accountId} onChange={e => { const a = accounts.find(a => a.id === e.target.value); setTransferForm({...transferForm, accountId: e.target.value, accountName: a?.name || ""}); }} className="w-full border border-brand-100 rounded-lg px-2 py-1.5 text-xs">
            <option value="">Select account...</option>{accounts.filter(a => a.is_active && (a.type === "Asset" || a.type === "Liability")).map(a => <option key={a.id} value={a.id}>{a.code || "•"} {a.name}</option>)}
          </Select></div>
        <div><label className="text-xs font-medium text-neutral-500 block mb-1">Memo</label>
          <Input type="text" value={transferForm.memo} onChange={e => setTransferForm({...transferForm, memo: e.target.value})} placeholder="e.g. Transfer to savings" className="w-full border border-brand-100 rounded-lg px-2 py-1.5 text-xs" /></div>
        <Btn variant="primary" onClick={() => acceptTransfer(txn, transferForm.accountId, transferForm.accountName, transferForm.memo)} disabled={!transferForm.accountId} className="disabled:opacity-40">Post Transfer</Btn>
      </div>
      )}

      {/* SPLIT */}
      {actionMode === "split" && (
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-neutral-500">Split into lines (total must equal ${Math.abs(txn.amount).toFixed(2)})</span>
          <TextLink tone="brand" size="xs" onClick={() => setSplitLines(prev => [...prev, { accountId: "", accountName: "", amount: "", memo: "", classId: "" }])}>+ Add Line</TextLink>
        </div>
        <div className="space-y-2">
          {splitLines.map((line, i) => (
          <div key={i} className="grid grid-cols-5 gap-2 items-end">
            <AccountPicker value={line.accountId} onChange={v => { const a = accounts.find(a => a.id === v); const l = [...splitLines]; l[i] = {...l[i], accountId: v, accountName: a?.name || ""}; setSplitLines(l); }} accounts={accounts} accountTypes={ACCOUNT_TYPES} placeholder="Account..." />
            <Input type="text" inputMode="decimal" value={line.amount} onChange={e => { const l = [...splitLines]; l[i] = {...l[i], amount: e.target.value.replace(/[^0-9.]/g, "")}; setSplitLines(l); }} placeholder="0.00" className="border border-brand-100 rounded-lg px-2 py-1.5 text-xs text-right font-mono" />
            <Input type="text" value={line.memo} onChange={e => { const l = [...splitLines]; l[i] = {...l[i], memo: e.target.value}; setSplitLines(l); }} placeholder="Memo..." className="border border-brand-100 rounded-lg px-2 py-1.5 text-xs" />
            <Select value={line.classId} onChange={e => { const l = [...splitLines]; l[i] = {...l[i], classId: e.target.value}; setSplitLines(l); }} className="border border-brand-100 rounded-lg px-2 py-1.5 text-xs">
              <option value="">Class</option>{classes.filter(c => c.is_active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            {splitLines.length > 2 && <TextLink tone="danger" size="xs" underline={false} onClick={() => setSplitLines(prev => prev.filter((_, j) => j !== i))}>✕</TextLink>}
          </div>
          ))}
        </div>
        <div className="flex items-center justify-between mt-2">
          <span className={`text-xs font-mono ${Math.abs(splitLines.reduce((s,l) => s + safeNum(l.amount), 0) - Math.abs(txn.amount)) < 0.01 ? "text-success-600" : "text-danger-500"}`}>
            Total: ${splitLines.reduce((s,l) => s + safeNum(l.amount), 0).toFixed(2)} / ${Math.abs(txn.amount).toFixed(2)}
          </span>
          <Btn variant="purple" size="sm" onClick={() => acceptSplit(txn, splitLines)} disabled={splitLines.filter(l => l.accountId && safeNum(l.amount) > 0).length < 2}>Post Split</Btn>
        </div>
      </div>
      )}

      {/* Transaction Details */}
      <div className="mt-2 text-xs text-neutral-400 border-t border-brand-100 pt-2">
        <span className="mr-3">Source: {txn.source_type?.toUpperCase() || "CSV"}</span>
        <span className="mr-3">Raw: {txn.bank_description_raw}</span>
        {txn.check_number && <span className="mr-3">Check #: {txn.check_number}</span>}
        {txn.reference_number && <span className="mr-3">Ref: {txn.reference_number}</span>}
        {txn.payee_raw && <span>Payee: {txn.payee_raw}</span>}
      </div>
      {/* Create Rule from Transaction */}
      <div className="mt-2 pt-2 border-t border-brand-100">
        <TextLink tone="accent" size="xs" onClick={() => createRuleFromTransaction(txn)} className="flex items-center gap-1">
          <span className="material-icons-outlined text-sm">auto_fix_high</span>Create a rule from this transaction
        </TextLink>
      </div>
    </td></tr>
    )}
    </React.Fragment>
    );
  })}
  {filtered.length === 0 && <tr><td colSpan={7} className="px-4 py-12 text-center text-neutral-400">No transactions in this tab</td></tr>}
  </tbody>
  </table>
  </div>
  {/* Bottom Pagination */}
  {txnTotalPages > 1 && (
  <div className="flex items-center justify-between">
    <div className="text-xs text-neutral-400">Showing {safeTxnPage * txnPageSize + 1}–{Math.min((safeTxnPage + 1) * txnPageSize, filtered.length)} of {filtered.length}</div>
    <div className="flex items-center gap-2">
      <Btn variant="secondary" size="sm" onClick={() => setTxnPage(Math.max(0, safeTxnPage - 1))} disabled={safeTxnPage === 0}>← Prev</Btn>
      <span className="text-xs text-neutral-500">Page {safeTxnPage + 1} of {txnTotalPages}</span>
      <Btn variant="secondary" size="sm" onClick={() => setTxnPage(Math.min(txnTotalPages - 1, safeTxnPage + 1))} disabled={safeTxnPage >= txnTotalPages - 1}>Next →</Btn>
    </div>
  </div>
  )}
  </>)}
  </>)}

  {/* New Account Modal */}
  {showNewAccount && (
  <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
  <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
    <h3 className="font-semibold text-neutral-800 mb-4">Add Bank Account</h3>
    <div className="space-y-3">
      <div><label className="text-xs font-medium text-neutral-500 block mb-1">Account Name *</label><Input value={newAccountForm.name} onChange={e => setNewAccountForm({...newAccountForm, name: e.target.value})} placeholder="e.g. Chase Checking" /></div>
      <div><label className="text-xs font-medium text-neutral-500 block mb-1">Account Type</label>
        <Select value={newAccountForm.type} onChange={e => setNewAccountForm({...newAccountForm, type: e.target.value})} className="w-full border border-brand-100 rounded-xl px-3 py-1.5 text-sm">
          <option value="checking">Checking</option><option value="savings">Savings</option><option value="credit_card">Credit Card</option><option value="loan">Loan</option><option value="other">Other</option>
        </Select>
      </div>
      <div><label className="text-xs font-medium text-neutral-500 block mb-1">Last 4 Digits</label><Input maxLength={4} value={newAccountForm.masked_number} onChange={e => setNewAccountForm({...newAccountForm, masked_number: e.target.value})} placeholder="1234" /></div>
      <div><label className="text-xs font-medium text-neutral-500 block mb-1">Institution</label><Input value={newAccountForm.institution_name} onChange={e => setNewAccountForm({...newAccountForm, institution_name: e.target.value})} placeholder="e.g. Chase, Bank of America" /></div>
    </div>
    <div className="flex gap-2 mt-4">
      <Btn onClick={createFeed} disabled={creatingFeed}>{creatingFeed ? "Creating..." : "Create"}</Btn>
      <TextLink tone="neutral" size="sm" underline={false} onClick={() => setShowNewAccount(false)} className="px-4 py-2">Cancel</TextLink>
    </div>
  </div>
  </div>
  )}

  {/* Import CSV Wizard Modal */}
  {showImportWizard && (
  <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
  <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
    <div className="p-6">
    <div className="flex items-center justify-between mb-4">
      <h3 className="font-semibold text-neutral-800">Import Bank Transactions</h3>
      <TextLink tone="neutral" size="xl" underline={false} onClick={() => setShowImportWizard(false)}>✕</TextLink>
    </div>

    {/* Step Bar */}
    <div className="flex items-center gap-0 mb-6">
    {[{n:1,l:"Account"},{n:2,l:"Upload"},{n:3,l:"Map"},{n:4,l:"Preview"},{n:5,l:"Options"},{n:6,l:"Done"}].map((s,i)=>(
      <div key={s.n} className="flex items-center flex-1">
      <div className="flex flex-col items-center gap-1">
        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 ${wizStep>s.n?"bg-success-500 border-success-500 text-white":wizStep===s.n?"bg-neutral-800 border-neutral-800 text-white":"bg-white border-neutral-200 text-neutral-400"}`}>{wizStep>s.n?"✓":s.n}</div>
        <span className={`text-xs ${wizStep===s.n?"text-neutral-800 font-medium":"text-neutral-400"}`}>{s.l}</span>
      </div>
      {i<5&&<div className={`flex-1 h-0.5 mb-4 mx-1 ${wizStep>s.n?"bg-success-400":"bg-neutral-200"}`}/>}
      </div>
    ))}
    </div>

    {/* Step 1: Select Account */}
    {wizStep === 1 && (
    <div className="space-y-4">
      <label className="text-sm font-medium text-neutral-700 block">Import into which account?</label>
      <Select value={wizFeedId} onChange={e => { if (e.target.value === "__new__") { setShowNewAccount(true); } else setWizFeedId(e.target.value); }} className="w-full border border-brand-100 rounded-xl px-3 py-1.5 text-sm">
        <option value="">Select bank account...</option>
        {feeds.map(f => <option key={f.id} value={f.id}>{f.account_name} ({f.account_type}){f.masked_number ? ` ••••${f.masked_number}` : ""}</option>)}
        <option value="__new__">+ Create New Account</option>
      </Select>
      <div className="flex justify-end"><Btn variant="dark" size="sm" onClick={() => { if (!wizFeedId) { showToast("Select an account.", "error"); return; } setWizStep(2); }} disabled={!wizFeedId}>Next →</Btn></div>
    </div>
    )}

    {/* Step 2: Upload CSV */}
    {wizStep === 2 && (
    <div className="space-y-4">
      <div onClick={() => fileRef.current?.click()} onDragOver={e => { e.preventDefault(); e.stopPropagation(); }} onDragEnter={e => { e.preventDefault(); e.stopPropagation(); }} onDrop={e => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer?.files?.[0]; if (f && (f.name.endsWith(".csv") || f.name.endsWith(".tsv") || f.name.endsWith(".txt"))) setWizFile(f); else if (f) showToast("Please drop a CSV, TSV, or TXT file.", "error"); }} className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center gap-3 cursor-pointer ${wizFile ? "border-success-300 bg-success-50/50" : "border-neutral-200 hover:border-neutral-400"}`}>
        <FileInput ref={fileRef} accept=".csv,.txt,.tsv" className="hidden" onChange={e => { if (e.target.files[0]) setWizFile(e.target.files[0]); }} />
        {wizFile ? <><p className="text-2xl">📄</p><p className="font-semibold text-success-800">{wizFile.name}</p><p className="text-xs text-success-600">{(wizFile.size/1024).toFixed(1)} KB</p></> : <><p className="text-2xl">📤</p><p className="font-semibold text-neutral-700">Drop CSV here or click to browse</p></>}
      </div>
      <div className="bg-info-50 border border-info-100 rounded-xl p-3 text-xs text-info-700"><strong>Supported:</strong> Chase, Bank of America, Wells Fargo, Citibank, Capital One, US Bank, and generic CSV</div>
      <div className="flex justify-between"><TextLink tone="neutral" size="sm" underline={false} onClick={() => setWizStep(1)}>← Back</TextLink><Btn variant="dark" size="sm" onClick={wizHandleUpload} disabled={!wizFile}>Parse & Continue →</Btn></div>
    </div>
    )}

    {/* Step 3: Map Columns */}
    {wizStep === 3 && wizParsed && (
    <div className="space-y-4">
      {wizDetected && <div className="text-xs bg-success-100 text-success-700 px-3 py-1.5 rounded-full inline-block">Auto-detected: {wizDetected.name}</div>}
      <div className="bg-neutral-50 rounded-xl p-3"><p className="text-xs text-neutral-400 mb-2">Headers found:</p><div className="flex flex-wrap gap-1.5">{wizParsed.headers.map(h => <span key={h} className="text-xs bg-white border border-neutral-200 text-neutral-700 px-2 py-0.5 rounded-lg font-mono">{h}</span>)}</div></div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {[{f:"date",l:"Date *"},{f:"description",l:"Description *"},{f:"amount",l:"Amount"},{f:"debit",l:"Debit"},{f:"credit",l:"Credit"},{f:"memo",l:"Memo"},{f:"payee",l:"Payee"},{f:"check_number",l:"Check #"},{f:"reference",l:"Reference"}].map(({f,l})=>(
        <div key={f}><label className="text-xs font-medium text-neutral-500">{l}</label><Select value={wizMapping[f]} onChange={e=>setWizMapping(m=>({...m,[f]:e.target.value}))} className="w-full border border-brand-100 rounded-lg px-2 py-1.5 text-xs mt-1"><option value="">— Not mapped —</option>{wizParsed.headers.map(h=><option key={h} value={h}>{h}</option>)}</Select></div>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={wizInvertSign} onChange={e => setWizInvertSign(e.target.checked)} className="accent-brand-600" /> Invert sign (negative = inflow)</label>
      {!(wizMapping.date && wizMapping.description && (wizMapping.amount || wizMapping.debit || wizMapping.credit)) && <p className="text-xs text-warn-600 bg-warn-50 rounded-lg px-3 py-2">Date, Description, and at least one amount column required</p>}
      <div className="flex justify-between"><TextLink tone="neutral" size="sm" underline={false} onClick={() => setWizStep(2)}>← Back</TextLink><Btn variant="dark" size="sm" onClick={wizBuildPreview} disabled={!(wizMapping.date && wizMapping.description && (wizMapping.amount || wizMapping.debit || wizMapping.credit))}>Preview →</Btn></div>
    </div>
    )}

    {/* Step 4: Preview */}
    {wizStep === 4 && (
    <div className="space-y-4">
      <div className="flex gap-3 text-sm">
        <div className="bg-success-50 text-success-700 px-3 py-1.5 rounded-lg"><strong>{wizPreview.filter(r=>r.valid).length}</strong> valid</div>
        <div className="bg-danger-50 text-danger-600 px-3 py-1.5 rounded-lg"><strong>{wizPreview.filter(r=>!r.valid).length}</strong> invalid</div>
        <div className="bg-info-50 text-info-600 px-3 py-1.5 rounded-lg"><strong>{wizPreview.length}</strong> total</div>
      </div>
      <div className="max-h-64 overflow-y-auto rounded-xl border border-neutral-200">
        <table className="w-full text-xs">
          <thead className="bg-neutral-50 sticky top-0"><tr><th className="px-3 py-2 text-left">Date</th><th className="px-3 py-2 text-left">Description</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2">Status</th></tr></thead>
          <tbody>{wizPreview.slice(0, 50).map((r, i) => (
            <tr key={i} className={`border-t ${r.valid ? "" : "bg-danger-50/50"}`}>
              <td className="px-3 py-1.5">{r.date || "—"}</td>
              <td className="px-3 py-1.5 truncate max-w-48">{r.description}</td>
              <td className={`px-3 py-1.5 text-right font-mono ${r.amount >= 0 ? "text-success-700" : "text-danger-600"}`}>{r.amount >= 0 ? "+" : ""}{r.amount.toFixed(2)}</td>
              <td className="px-3 py-1.5 text-center">{r.valid ? <span className="text-success-600">✓</span> : <span className="text-danger-500" title="Invalid date or amount">✗</span>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {wizPreview.length > 50 && <p className="text-xs text-neutral-400">Showing first 50 of {wizPreview.length} rows</p>}
      <div className="flex justify-between"><TextLink tone="neutral" size="sm" underline={false} onClick={() => setWizStep(3)}>← Back</TextLink><Btn variant="dark" size="sm" onClick={() => setWizStep(5)}>Continue →</Btn></div>
    </div>
    )}

    {/* Step 5: Import Options */}
    {wizStep === 5 && (
    <div className="space-y-4">
      <div className="space-y-3">
        <label className="flex items-center gap-3 bg-white rounded-xl border border-neutral-200 px-4 py-3 cursor-pointer">
          <Checkbox checked={wizOptions.skipDuplicates} onChange={e => setWizOptions({...wizOptions, skipDuplicates: e.target.checked})} className="accent-brand-600" />
          <div><span className="text-sm font-medium text-neutral-700">Skip duplicates automatically</span><p className="text-xs text-neutral-400">Transactions with matching fingerprints will be skipped</p></div>
        </label>
        <label className="flex items-center gap-3 bg-white rounded-xl border border-neutral-200 px-4 py-3 cursor-pointer">
          <Checkbox checked={wizOptions.autoApplyRules} onChange={e => setWizOptions({...wizOptions, autoApplyRules: e.target.checked})} className="accent-brand-600" />
          <div><span className="text-sm font-medium text-neutral-700">Auto-apply categorization rules</span><p className="text-xs text-neutral-400">Rules will suggest categories for matching transactions</p></div>
        </label>
        <label className="flex items-center gap-3 bg-white rounded-xl border border-neutral-200 px-4 py-3 cursor-pointer">
          <Checkbox checked={wizOptions.markForReview} onChange={e => setWizOptions({...wizOptions, markForReview: e.target.checked})} className="accent-brand-600" />
          <div><span className="text-sm font-medium text-neutral-700">Mark all as "For Review"</span><p className="text-xs text-neutral-400">Transactions require manual review before posting</p></div>
        </label>
      </div>
      <div className="bg-white rounded-xl border border-neutral-200 p-4">
        <div className="flex justify-between text-sm"><span className="text-neutral-400">Valid rows</span><span className="font-bold text-neutral-800">{wizPreview.filter(r=>r.valid).length}</span></div>
        <div className="flex justify-between text-sm mt-1"><span className="text-neutral-400">Will skip (invalid)</span><span className="text-danger-500">{wizPreview.filter(r=>!r.valid).length}</span></div>
      </div>
      <div className="flex justify-between"><TextLink tone="neutral" size="sm" underline={false} onClick={() => setWizStep(4)}>← Back</TextLink><Btn variant="success-fill" onClick={wizExecuteImport}>Import {wizPreview.filter(r=>r.valid).length} Transactions</Btn></div>
    </div>
    )}

    {/* Step 6: Done */}
    {wizStep === 6 && wizResult && (
    <div className="text-center py-8">
      <div className="w-16 h-16 bg-success-100 rounded-full flex items-center justify-center text-3xl mx-auto mb-4">✓</div>
      <h4 className="text-xl font-bold text-neutral-900 mb-2">Import Complete</h4>
      <div className="space-y-1 text-sm text-neutral-500 mb-6">
        <p><strong>{wizResult.imported}</strong> transactions imported</p>
        {wizResult.duplicates > 0 && <p>{wizResult.duplicates} duplicates skipped</p>}
        {wizResult.skipped > 0 && <p>{wizResult.skipped} rows skipped (errors)</p>}
        {wizResult.ruleApplied > 0 && <p className="text-accent-600">{wizResult.ruleApplied} auto-categorized by rules</p>}
      </div>
      <Btn variant="dark" size="md" onClick={() => { setShowImportWizard(false); setActiveTab("for_review"); }}>Review Transactions</Btn>
    </div>
    )}
    </div>
  </div>
  </div>
  )}


  {/* ========== RULE DRAWER (slide from right) ========== */}
  {showRuleDrawer && (
  <>
  <div className="fixed inset-0 bg-black/30 z-40" onClick={() => { setShowRuleDrawer(false); resetRuleForm(); }} />
  <div className="fixed right-0 top-0 h-full w-full max-w-lg bg-white shadow-2xl z-50 overflow-y-auto safe-y">
    <div className="sticky top-0 bg-white border-b border-neutral-200 px-5 py-4 flex items-center justify-between z-10">
      <h3 className="text-lg font-bold text-neutral-800">{editingRule ? "Edit Rule" : "Create New Rule"}</h3>
      <TextLink tone="neutral" size="xl" underline={false} onClick={() => { setShowRuleDrawer(false); resetRuleForm(); }}>✕</TextLink>
    </div>
    <div className="px-5 py-4 space-y-5">

      {/* Rule Name */}
      <div>
        <label className="text-xs font-medium text-neutral-500 uppercase tracking-widest block mb-1">Rule Name *</label>
        <Input type="text" value={ruleForm.name} onChange={e => setRuleForm({...ruleForm, name: e.target.value})} placeholder="e.g. Home Depot Supplies" className="w-full border border-accent-200 rounded-lg px-3 py-2 text-sm focus:border-accent-400 focus:outline-none" />
      </div>

      {/* Direction + Bank Account Scope */}
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="text-xs font-medium text-neutral-500 uppercase tracking-widest block mb-1">Apply to</label>
          <Select value={ruleForm.condDirection} onChange={e => setRuleForm({...ruleForm, condDirection: e.target.value})} className="w-full border border-accent-200 rounded-lg px-3 py-2 text-sm">
            <option value="all">All transactions</option><option value="outflow">Money out</option><option value="inflow">Money in</option>
          </Select>
        </div>
        <div className="flex-1">
          <label className="text-xs font-medium text-neutral-500 uppercase tracking-widest block mb-1">Bank Account</label>
          <Select value={ruleForm.bankAccountFeedId} onChange={e => setRuleForm({...ruleForm, bankAccountFeedId: e.target.value})} className="w-full border border-accent-200 rounded-lg px-3 py-2 text-sm">
            <option value="">All bank accounts</option>{feeds.map(f => <option key={f.id} value={f.id}>{f.account_name}</option>)}
          </Select>
        </div>
      </div>

      {/* Conditions */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <label className="text-xs font-medium text-neutral-500 uppercase tracking-widest">When transaction meets</label>
          <Select value={ruleForm.condLogic} onChange={e => setRuleForm({...ruleForm, condLogic: e.target.value})} className="border border-accent-200 rounded-lg px-2 py-1 text-xs font-semibold text-accent-700">
            <option value="all">ALL</option><option value="any">ANY</option>
          </Select>
          <span className="text-xs text-neutral-400">conditions:</span>
        </div>
        {ruleForm.conditions.map((cond, idx) => {
          const isAmount = cond.field === "amount";
          const textOps = [["contains","Contains"],["does_not_contain","Doesn't contain"],["is_exactly","Is exactly"],["starts_with","Starts with"],["ends_with","Ends with"],["regex","Regex"]];
          const amtOps = [["is_exactly","Is exactly"],["greater_than","Greater than"],["less_than","Less than"],["between","Between"]];
          const ops = isAmount ? amtOps : textOps;
          return (
          <div key={idx} className="flex items-center gap-2 mb-2">
            <Select value={cond.field} onChange={e => { updateCondition(idx, "field", e.target.value); updateCondition(idx, "operator", e.target.value === "amount" ? "greater_than" : "contains"); }} className="border border-accent-200 rounded-lg px-2 py-1.5 text-xs min-w-[120px]">
              <option value="description">Description</option><option value="bank_text">Bank text</option><option value="amount">Amount</option>
            </Select>
            <Select value={cond.operator} onChange={e => updateCondition(idx, "operator", e.target.value)} className="border border-accent-200 rounded-lg px-2 py-1.5 text-xs min-w-[130px]">
              {ops.map(([v,l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
            <Input type={isAmount ? "number" : "text"} value={cond.value} onChange={e => updateCondition(idx, "value", e.target.value)} placeholder={isAmount ? "0.00" : "Enter text..."} className="flex-1 border border-accent-200 rounded-lg px-2 py-1.5 text-xs" />
            {cond.operator === "between" && <>
              <span className="text-xs text-neutral-400">and</span>
              <Input type="number" value={cond.value2 || ""} onChange={e => updateCondition(idx, "value2", e.target.value)} placeholder="0.00" className="w-24 border border-accent-200 rounded-lg px-2 py-1.5 text-xs" />
            </>}
            {ruleForm.conditions.length > 1 && <TextLink tone="danger" size="sm" underline={false} onClick={() => removeCondition(idx)} className="shrink-0">✕</TextLink>}
          </div>
          );
        })}
        {ruleForm.conditions.length < 5 && (
          <TextLink tone="accent" size="xs" onClick={addCondition} className="flex items-center gap-1"><span className="material-icons-outlined text-sm">add</span>Add a condition</TextLink>
        )}
      </div>

      {/* Divider: Then */}
      <div className="flex items-center gap-2"><div className="flex-1 border-t border-neutral-200" /><span className="text-xs font-semibold text-neutral-400 uppercase">Then</span><div className="flex-1 border-t border-neutral-200" /></div>

      {/* Assign vs Exclude */}
      <div className="flex gap-4">
        <label className="flex items-center gap-2 text-sm cursor-pointer"><Radio name="ruleType" checked={ruleForm.ruleType === "assign"} onChange={() => setRuleForm({...ruleForm, ruleType: "assign"})} className="accent-accent-600" /><span className="font-medium text-neutral-700">Assign</span></label>
        <label className="flex items-center gap-2 text-sm cursor-pointer"><Radio name="ruleType" checked={ruleForm.ruleType === "exclude"} onChange={() => setRuleForm({...ruleForm, ruleType: "exclude"})} className="accent-accent-600" /><span className="font-medium text-neutral-700">Exclude</span></label>
      </div>

      {/* Assign Fields */}
      {ruleForm.ruleType === "assign" && (<>
        <div>
          <label className="text-xs font-medium text-neutral-500 uppercase tracking-widest block mb-1">Transaction Type</label>
          <Select value={ruleForm.transactionType} onChange={e => setRuleForm({...ruleForm, transactionType: e.target.value})} className="w-full border border-accent-200 rounded-lg px-3 py-2 text-sm">
            <option value="expense">Expense</option><option value="deposit">Deposit</option><option value="transfer">Transfer</option><option value="check">Check</option>
          </Select>
        </div>

        {/* Category Lines (split support) */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-medium text-neutral-500 uppercase tracking-widest">Category *</label>
            {!ruleForm.split && <TextLink tone="accent" size="xs" onClick={addSplitLine}>+ Add a split</TextLink>}
          </div>
          {ruleForm.split && ruleForm.lines.length >= 2 && (
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs text-neutral-400">Split by:</span>
              <Select value={ruleForm.splitBy || "percentage"} onChange={e => setRuleForm({...ruleForm, splitBy: e.target.value})} className="border border-accent-200 rounded-lg px-2 py-1 text-xs">
                <option value="percentage">Percentage</option><option value="amount">Amount</option>
              </Select>
            </div>
          )}
          {ruleForm.lines.map((line, idx) => (
          <div key={idx} className="flex items-center gap-2 mb-2">
            <AccountPicker value={line.accountId} onChange={v => { if (v === "__new__") { setShowNewBankAcct(true); return; } const a = accounts.find(a => a.id === v); updateLine(idx, "accountId", v); updateLine(idx, "accountName", a?.name || ""); }} accounts={accounts} accountTypes={ACCOUNT_TYPES} showNewOption placeholder="Search accounts..." className="flex-1" />
            {ruleForm.split && ruleForm.splitBy === "percentage" && (
              <Input type="number" value={line.percentage ?? ""} onChange={e => updateLine(idx, "percentage", e.target.value)} placeholder="%" className="w-20 border border-accent-200 rounded-lg px-2 py-1.5 text-xs text-right" />
            )}
            {ruleForm.split && ruleForm.splitBy === "amount" && (
              <Input type="number" value={line.amount ?? ""} onChange={e => updateLine(idx, "amount", e.target.value)} placeholder="$" className="w-24 border border-accent-200 rounded-lg px-2 py-1.5 text-xs text-right" />
            )}
            <Select value={line.classId} onChange={e => updateLine(idx, "classId", e.target.value)} className="w-36 border border-accent-200 rounded-lg px-2 py-1.5 text-xs">
              <option value="">No class</option>{classes.filter(c => c.is_active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            {ruleForm.lines.length > 1 && <TextLink tone="danger" size="sm" underline={false} onClick={() => removeSplitLine(idx)} className="shrink-0">✕</TextLink>}
          </div>
          ))}
          {ruleForm.split && ruleForm.lines.length < 5 && (
            <TextLink tone="accent" size="xs" onClick={addSplitLine}>+ Add line</TextLink>
          )}
          {ruleForm.split && ruleForm.splitBy === "percentage" && (
            <div className={`text-xs mt-1 ${Math.abs(ruleForm.lines.reduce((s, l) => s + (Number(l.percentage) || 0), 0) - 100) < 0.01 ? "text-success-600" : "text-danger-500"}`}>
              Total: {ruleForm.lines.reduce((s, l) => s + (Number(l.percentage) || 0), 0)}%
            </div>
          )}
        </div>
        {showNewBankAcct && (
        <div className="bg-brand-50 rounded-xl p-3 mt-2 border border-brand-200">
        <div className="text-xs font-semibold text-brand-700 mb-2">Create New Account</div>
        <div className="grid grid-cols-3 gap-2">
        <div><label className="text-xs text-neutral-500 block mb-1">Type *</label><Select value={newBankAcctForm.type} onChange={e => setNewBankAcctForm({...newBankAcctForm, type: e.target.value})} className="w-full border border-brand-100 rounded-lg px-2 py-1.5 text-xs">{ACCOUNT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</Select></div>
        <div><label className="text-xs text-neutral-500 block mb-1">Code</label><Input value={newBankAcctForm.code} onChange={e => setNewBankAcctForm({...newBankAcctForm, code: e.target.value})} placeholder="Auto" className="w-full border border-brand-100 rounded-lg px-2 py-1.5 text-xs" /></div>
        <div><label className="text-xs text-neutral-500 block mb-1">Name *</label><Input value={newBankAcctForm.name} onChange={e => setNewBankAcctForm({...newBankAcctForm, name: e.target.value})} placeholder="e.g. Office Supplies" className="w-full border border-brand-100 rounded-lg px-2 py-1.5 text-xs" /></div>
        </div>
        <div className="flex gap-2 mt-2"><Btn size="sm" onClick={createInlineBankAcct}>Create</Btn><Btn size="sm" variant="ghost" onClick={() => setShowNewBankAcct(false)}>Cancel</Btn></div>
        </div>
        )}

        {/* Payee + Memo */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-neutral-500 uppercase tracking-widest block mb-1">Payee</label>
            <Input type="text" value={ruleForm.actionPayee} onChange={e => setRuleForm({...ruleForm, actionPayee: e.target.value})} placeholder="Optional" className="w-full border border-accent-200 rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs font-medium text-neutral-500 uppercase tracking-widest block mb-1">Memo</label>
            <Input type="text" value={ruleForm.actionMemo} onChange={e => setRuleForm({...ruleForm, actionMemo: e.target.value})} placeholder="Optional" className="w-full border border-accent-200 rounded-lg px-3 py-2 text-sm" />
          </div>
        </div>
      </>)}

      {/* Exclude Fields */}
      {ruleForm.ruleType === "exclude" && (
        <div>
          <label className="text-xs font-medium text-neutral-500 uppercase tracking-widest block mb-1">Exclude Reason</label>
          <Select value={ruleForm.excludeReason} onChange={e => setRuleForm({...ruleForm, excludeReason: e.target.value})} className="w-full border border-accent-200 rounded-lg px-3 py-2 text-sm">
            <option value="personal">Personal</option><option value="duplicate">Duplicate</option><option value="noise">Noise</option><option value="other">Other</option>
          </Select>
        </div>
      )}

      {/* How to apply */}
      <div>
        <div className="flex items-center gap-2 mb-2"><div className="flex-1 border-t border-neutral-200" /><span className="text-xs font-semibold text-neutral-400 uppercase">How to apply</span><div className="flex-1 border-t border-neutral-200" /></div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm cursor-pointer"><Radio name="autoAccept" checked={!ruleForm.autoAccept} onChange={() => setRuleForm({...ruleForm, autoAccept: false})} className="accent-accent-600" /><span className="text-neutral-700">Auto-categorize, then I'll review manually</span></label>
          <label className="flex items-center gap-2 text-sm cursor-pointer"><Radio name="autoAccept" checked={ruleForm.autoAccept} onChange={() => setRuleForm({...ruleForm, autoAccept: true})} className="accent-accent-600" /><span className="text-neutral-700">Auto-add (skip review entirely)</span></label>
        </div>
      </div>

      {/* Priority */}
      <div>
        <label className="text-xs font-medium text-neutral-500 uppercase tracking-widest block mb-1">Priority (lower = runs first)</label>
        <Input type="number" value={ruleForm.priority} onChange={e => setRuleForm({...ruleForm, priority: e.target.value})} min="1" max="999" className="w-24 border border-accent-200 rounded-lg px-3 py-2 text-sm" />
      </div>

      {/* Actions */}
      <div className="flex gap-3 pt-2 border-t border-neutral-200">
        <Btn variant="accent-fill" size="md" onClick={saveRule}>{editingRule ? "Update Rule" : "Save Rule"}</Btn>
        <TextLink tone="neutral" size="sm" underline={false} onClick={() => { setShowRuleDrawer(false); resetRuleForm(); }} className="px-4 py-2.5 hover:text-neutral-700">Cancel</TextLink>
      </div>
    </div>
  </div>
  </>
  )}

  {/* Post-Connection Setup Modal */}
  {postConnectModal && (() => {
    const selectedAccts = postConnectModal.accounts.filter(a => postConnectSelected.has(a.plaid_account_id));
    const allMapped = selectedAccts.length > 0 && selectedAccts.every(acct => postConnectMappings[acct.plaid_account_id]);
    return (
  <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
    <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
      <div className="p-6">
        <div className="flex items-center gap-3 mb-1">
          <span className="text-2xl">🏦</span>
          <h3 className="text-lg font-bold text-neutral-800">Bank Connected</h3>
        </div>
        <p className="text-sm text-neutral-500 mb-5">{postConnectModal.institutionName} — {postConnectModal.accounts.length} account{postConnectModal.accounts.length !== 1 ? "s" : ""} found</p>

        {/* Connected Accounts + GL Mapping */}
        <div className="mb-5">
          <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wide block mb-2">Select Accounts to Connect</label>
          <p className="text-xs text-neutral-400 mb-3">Check the accounts you want, then map each to a GL account.</p>
          <div className="space-y-3">
            {postConnectModal.accounts.map(acct => {
              const key = acct.plaid_account_id;
              const isChecked = postConnectSelected.has(key);
              const isMapped = !!postConnectMappings[key];
              const isCreating = postConnectNewAcct === key;
              return (
            <div key={key} className={`rounded-xl p-3 border transition-all ${!isChecked ? "bg-neutral-50 border-neutral-100 opacity-60" : isMapped ? "bg-neutral-50 border-neutral-200" : "bg-warn-50/30 border-warn-300"}`}>
              <div className="flex items-center gap-3 mb-2">
                <Checkbox checked={isChecked} onChange={() => {
                  setPostConnectSelected(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
                }} className="accent-brand-600 w-4 h-4 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm text-neutral-800 truncate">{acct.name || "Bank Account"}</div>
                  <div className="text-xs text-neutral-400">{acct.type}{acct.mask ? ` · ••••${acct.mask}` : ""}</div>
                </div>
                {acct.is_existing && <span className="text-xs bg-success-100 text-success-700 px-2 py-0.5 rounded-full shrink-0">Reconnected</span>}
              </div>
              {isChecked && (
              <div className="ml-7">
                <label className="text-xs text-neutral-500 block mb-1">GL Account {!isMapped && <span className="text-danger-500 font-semibold">*Required</span>}</label>
                <AccountPicker
                  value={postConnectMappings[key] || ""}
                  onChange={v => {
                    if (v === "__new__") { setPostConnectNewAcct(key); setNewBankAcctForm({ code: "", name: acct.name || "", type: acct.suggested_gl_type || "Asset" }); return; }
                    setPostConnectMappings(prev => ({ ...prev, [key]: v }));
                    setPostConnectNewAcct(null);
                  }}
                  accounts={accounts}
                  accountTypes={ACCOUNT_TYPES}
                  showNewOption
                  placeholder="Select or create GL account..."
                />
                {isCreating && (
                <div className="bg-brand-50 rounded-xl p-3 mt-2 border border-brand-200">
                  <div className="text-xs font-semibold text-brand-700 mb-2">Create New Account</div>
                  <div className="grid grid-cols-3 gap-2">
                    <div><label className="text-xs text-neutral-500 block mb-1">Type *</label><Select value={newBankAcctForm.type} onChange={e => setNewBankAcctForm(f => ({...f, type: e.target.value}))} className="w-full border border-brand-100 rounded-lg px-2 py-1.5 text-xs">{ACCOUNT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</Select></div>
                    <div><label className="text-xs text-neutral-500 block mb-1">Code</label><Input value={newBankAcctForm.code} onChange={e => setNewBankAcctForm(f => ({...f, code: e.target.value}))} placeholder="Auto" className="w-full border border-brand-100 rounded-lg px-2 py-1.5 text-xs" /></div>
                    <div><label className="text-xs text-neutral-500 block mb-1">Name *</label><Input value={newBankAcctForm.name} onChange={e => setNewBankAcctForm(f => ({...f, name: e.target.value}))} placeholder="e.g. Business Checking" className="w-full border border-brand-100 rounded-lg px-2 py-1.5 text-xs" /></div>
                  </div>
                  <div className="flex gap-2 mt-2">
                    <Btn size="sm" onClick={async () => {
                      if (!newBankAcctForm.name.trim()) { showToast("Account name is required.", "error"); return; }
                      const code = newBankAcctForm.code.trim() || nextAccountCode(accounts, newBankAcctForm.type);
                      const { data: newAcct, error } = await supabase.from("acct_accounts").insert({ company_id: companyId, code, name: newBankAcctForm.name.trim(), type: newBankAcctForm.type, subtype: newBankAcctForm.type === "Asset" ? "Bank" : newBankAcctForm.type === "Liability" ? "Credit Card" : "", is_active: true, old_text_id: companyId + "-" + code }).select("id").single();
                      if (error) { pmError("PM-4006", { raw: error, context: "create bank GL account" }); return; }
                      showToast(`Account "${newBankAcctForm.name}" created.`, "success");
                      // Must refresh the parent's accounts list, not fetchAll()
                      // — AccountPicker reads `accounts` as a prop, and
                      // nextAccountCode() scans it to pick the next code.
                      // Stale accounts caused two bugs: blank picker after
                      // create (couldn't find new id), and 409 duplicate-
                      // code on the second account (same code re-picked).
                      if (onRefreshAccounting) await onRefreshAccounting();
                      setPostConnectMappings(prev => ({ ...prev, [key]: newAcct.id }));
                      setPostConnectNewAcct(null);
                    }}>Create</Btn>
                    <Btn size="sm" variant="ghost" onClick={() => setPostConnectNewAcct(null)}>Cancel</Btn>
                  </div>
                </div>
                )}
              </div>
              )}
            </div>
              );
            })}
          </div>
        </div>

        {/* Date Range Picker */}
        <div className="mb-5">
          <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wide block mb-2">Import Transactions</label>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-neutral-500 block mb-1">From</label>
              <Input type="date" value={postConnectRange.from} onChange={e => setPostConnectRange(prev => ({ ...prev, from: e.target.value }))} className="w-40" />
            </div>
            <div>
              <label className="text-xs text-neutral-500 block mb-1">To</label>
              <Input type="date" value={postConnectRange.to} onChange={e => setPostConnectRange(prev => ({ ...prev, to: e.target.value }))} className="w-40" />
            </div>
          </div>
          <div className="flex gap-2 mt-2">
            {[30, 60, 90, 180, 365].map(days => {
              const d = new Date(); d.setDate(d.getDate() - days);
              return <Btn key={days} variant="slate" size="xs" onClick={() => setPostConnectRange({ from: formatLocalDate(d), to: formatLocalDate(new Date()) })}>{days}d</Btn>;
            })}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-3 border-t border-neutral-200">
          <Btn onClick={async () => {
            if (!allMapped) { showToast("Please map all selected accounts to a GL account before importing.", "error"); return; }
            if (selectedAccts.length === 0) { showToast("Please select at least one account.", "error"); return; }
            setPostConnectSyncing(true);
            try {
              // Save mappings. NEW accounts (no existing_feed_id) get a
              // bank_account_feed row inserted now — deferred from
              // /api/teller-save-enrollment so that canceling leaves no
              // orphans. EXISTING accounts (reconnect) get their gl_account_id
              // updated in place.
              for (const acct of selectedAccts) {
                const glId = postConnectMappings[acct.plaid_account_id];
                if (!glId) continue;
                if (acct.existing_feed_id) {
                  await supabase.from("bank_account_feed").update({ gl_account_id: glId, status: "active" })
                    .eq("id", acct.existing_feed_id).eq("company_id", companyId);
                } else {
                  await supabase.from("bank_account_feed").insert({
                    company_id: companyId,
                    gl_account_id: glId,
                    bank_connection_id: postConnectModal.connectionId,
                    account_name: acct.name || "Bank Account",
                    masked_number: acct.mask || "",
                    account_type: acct.type,
                    institution_name: acct.institution_name || postConnectModal.institutionName || "",
                    connection_type: "teller",
                    plaid_account_id: acct.plaid_account_id,
                    bank_balance_current: acct.balance,
                    status: "active",
                  });
                }
              }
              // For unselected EXISTING feeds, deactivate. Unselected new
              // accounts have no row — nothing to do.
              const unselectedExisting = postConnectModal.accounts.filter(a => !postConnectSelected.has(a.plaid_account_id) && a.existing_feed_id);
              for (const acct of unselectedExisting) {
                await supabase.from("bank_account_feed").update({ status: "inactive" }).eq("id", acct.existing_feed_id).eq("company_id", companyId);
              }
              // Sync transactions with date range
              const { data: { session } } = await supabase.auth.getSession();
              if (!session?.access_token) { showToast("Not authenticated.", "error"); return; }
              const res = await fetch("/api/teller-sync-transactions", {
                method: "POST",
                headers: { "Authorization": "Bearer " + session.access_token, "Content-Type": "application/json" },
                body: JSON.stringify({ company_id: companyId, from_date: postConnectRange.from, to_date: postConnectRange.to })
              });
              const data = await res.json();
              if (!res.ok || data.error) { showToast("Sync error: " + (data.error || `HTTP ${res.status}`), "error"); }
              else { showToast(`Imported ${data.total_added} transaction${data.total_added !== 1 ? "s" : ""} from ${postConnectModal.institutionName}`, "success"); }
              fetchAll();
            } catch (e) { showToast("Sync failed: " + e.message, "error"); }
            finally { setPostConnectSyncing(false); setPostConnectModal(null); }
          }} disabled={postConnectSyncing || !postConnectRange.from || !allMapped || selectedAccts.length === 0}>
            {postConnectSyncing ? "Importing..." : allMapped ? "Import Transactions" : "Map All Accounts First"}
          </Btn>
          <Btn variant="ghost" onClick={() => { setPostConnectModal(null); fetchAll(); }}>Skip for Now</Btn>
        </div>
      </div>
    </div>
  </div>
    );
  })()}

  {/* Connect Bank chooser — shown when the user already has a Teller */}
  {/* enrollment. Reusing reconnects the same bank (free); adding new  */}
  {/* consumes another Teller plan slot. */}
  {connectChooser && (
  <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
    <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
      <div className="flex items-center gap-3 mb-1">
        <span className="text-2xl">🔗</span>
        <h3 className="text-lg font-bold text-neutral-800">Connect Bank</h3>
      </div>
      <p className="text-sm text-neutral-500 mb-4">You already have Teller connections. Reconnecting an existing one is free; adding a different bank consumes another Teller enrollment slot.</p>
      <div className="space-y-2">
        {connections.filter(c => c.source_type === "teller" && c.plaid_item_id).map(c => (
          <button key={c.id} onClick={() => { setConnectChooser(false); connectBank(c.plaid_item_id); }}
            className="w-full text-left bg-neutral-50 hover:bg-brand-50 border border-neutral-200 hover:border-brand-300 rounded-lg px-3 py-2 transition-colors">
            <div className="flex items-center gap-3">
              <span className="material-icons-outlined text-brand-600">refresh</span>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm text-neutral-800 truncate">Reconnect {c.institution_name || "Bank"}</div>
                <div className="text-xs text-neutral-400">Re-authenticate the existing enrollment · no new plan slot</div>
              </div>
            </div>
          </button>
        ))}
        <button onClick={() => { setConnectChooser(false); connectBank(); }}
          className="w-full text-left bg-neutral-50 hover:bg-brand-50 border border-neutral-200 hover:border-brand-300 rounded-lg px-3 py-2 transition-colors">
          <div className="flex items-center gap-3">
            <span className="material-icons-outlined text-neutral-500">add</span>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm text-neutral-800">Add a different bank</div>
              <div className="text-xs text-neutral-400">Consumes a new Teller enrollment slot</div>
            </div>
          </div>
        </button>
      </div>
      <div className="flex gap-3 pt-4 mt-4 border-t border-neutral-200">
        <Btn variant="ghost" onClick={() => setConnectChooser(false)}>Cancel</Btn>
      </div>
    </div>
  </div>
  )}

  {/* Sync-with-date modal. Teller's default /transactions response is */}
  {/* usually ~90 days; the API route now paginates via ?from_id when a */}
  {/* from_date is supplied, so typing an older date actually pulls  */}
  {/* history. Empty = Teller default window. */}
  {syncDateModal && (
  <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
    <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
      <div className="flex items-center gap-3 mb-1">
        <span className="text-2xl">🔄</span>
        <h3 className="text-lg font-bold text-neutral-800">Sync Bank Transactions</h3>
      </div>
      <p className="text-sm text-neutral-500 mb-4">Pull from a specific date, or leave blank for Teller's default (~90 days).</p>
      <label className="text-xs text-neutral-500 block mb-1">From Date</label>
      <Input type="date" value={syncFromDate} onChange={e => setSyncFromDate(e.target.value)} className="w-full" />
      <div className="flex gap-2 mt-2 flex-wrap">
        {[30, 60, 90, 180, 365, 730].map(days => {
          const d = new Date(); d.setDate(d.getDate() - days);
          return <Btn key={days} variant="slate" size="xs" onClick={() => setSyncFromDate(formatLocalDate(d))}>{days}d</Btn>;
        })}
        <Btn variant="slate" size="xs" onClick={() => setSyncFromDate("")}>Default</Btn>
      </div>
      <div className="flex gap-3 pt-4 mt-4 border-t border-neutral-200">
        <Btn disabled={syncing} onClick={async () => {
          setSyncDateModal(false);
          await syncTransactions(syncFromDate ? { from_date: syncFromDate } : {});
        }}>{syncing ? "Syncing..." : "Sync"}</Btn>
        <Btn variant="ghost" onClick={() => setSyncDateModal(false)}>Cancel</Btn>
      </div>
    </div>
  </div>
  )}

  {/* Change GL Mapping modal — replaces the native prompt() that used */}
  {/* to ask for a raw UUID. Uses AccountPicker so the user searches by */}
  {/* account name/code like everywhere else in the app. */}
  {glMapModal && (
  <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
    <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
      <div className="flex items-center gap-3 mb-1">
        <span className="text-2xl">🔗</span>
        <h3 className="text-lg font-bold text-neutral-800">Map to GL Account</h3>
      </div>
      <p className="text-sm text-neutral-500 mb-4">{glMapModal.feedName}</p>
      <label className="text-xs text-neutral-500 block mb-1">GL Account</label>
      <AccountPicker
        value={glMapValue}
        onChange={v => setGlMapValue(v)}
        accounts={accounts}
        accountTypes={ACCOUNT_TYPES}
        placeholder="Select GL account..."
      />
      <div className="flex gap-3 pt-4 mt-4 border-t border-neutral-200">
        <Btn disabled={!glMapValue} onClick={async () => {
          await updateFeedMapping(glMapModal.feedId, glMapValue);
          setGlMapModal(null); setGlMapValue("");
        }}>Save Mapping</Btn>
        <Btn variant="ghost" onClick={() => { setGlMapModal(null); setGlMapValue(""); }}>Cancel</Btn>
      </div>
    </div>
  </div>
  )}

  </div>
  );
}
