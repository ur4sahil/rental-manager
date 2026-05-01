import React, { useState, useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import ExcelJS from "exceljs";
import * as Sentry from "@sentry/react";
import { supabase } from "./supabase";
import { Input, Textarea, Select, Btn, Card, PageHeader, FormField, TabBar, FilterPill, SectionTitle, EmptyState, IconBtn, BulkBar, AccountPicker, TextLink} from "./ui";
import { safeNum, parseLocalDate, formatLocalDate, shortId, CLASS_COLORS, ALLOWED_DOC_TYPES, ALLOWED_DOC_EXTENSIONS, pickColor, generateId, formatPersonName, buildNameFields, parseNameParts, isValidEmail, normalizeEmail, formatCurrency, getSignedUrl, formatPhoneInput, sanitizeFileName, exportToCSV, buildAddress, escapeHtml, escapeFilterValue, sanitizeForPrint, US_STATES, STATE_NAMES, statusColors, priorityColors, emailFilterValue, getWizardApplicableSteps, canReviewRequest } from "./utils/helpers";
import { PM_ERRORS, pmError, reportError, logErrorToSupabase, detectInfrastructureCode, setShowToastGlobal, setActiveErrorContext } from "./utils/errors";
import { guardSubmit, guardRelease, guarded, requireCompanyId } from "./utils/guards";
import { encryptCredential, decryptCredential } from "./utils/encryption";
import { AUDIT_ACTIONS, AUDIT_MODULES, logAudit } from "./utils/audit";
import { queueNotification } from "./utils/notifications";
import { companyQuery, companyInsert, companyUpsert, checkRPCHealth, runDataIntegrityChecks, loadCompanySettings, clearMembershipCache } from "./utils/company";
import { COMPANY_DEFAULTS } from "./config";
import { safeLedgerInsert, atomicPostJEAndLedger, postAccountingTransaction, checkPeriodLock, autoPostJournalEntry, checkAccrualExists, autoOwnerDistribution, getPropertyClassId, resolveAccountId, getOrCreateTenantAR, autoPostRentCharges, autoPostRecurringEntries, _classIdCache, _acctIdCache, _acctCodeToName, _tenantArCache, _zipCache, lookupZip } from "./utils/accounting";
import { ErrorBoundary, Badge, StatCard, Spinner, Modal, ToastContainer, ConfirmModal, PropertyDropdown, TenantSelect, PropertySelect, RecurringEntryModal, DocUploadModal, formatAllTenants, generatePaymentReceipt } from "./components/shared";
import PullToRefresh from "./components/PullToRefresh";

import { LandingPage } from "./components/LandingPage";
import { LoginPage } from "./components/LoginPage";
import { Dashboard } from "./components/Dashboard";
import { PropertySetupWizard, Properties } from "./components/Properties";
import Tenants from "./components/Tenants";
import { Payments, Autopay } from "./components/Payments";
import { Maintenance, Inspections, VendorManagement } from "./components/Maintenance";
import { Utilities } from "./components/Utilities";
import { Accounting, AcctBankReconciliation } from "./components/Accounting";
import { BankTransactions } from "./components/Banking";
import { Documents, DocumentBuilder } from "./components/Documents";
import { LeaseManagement, ESignatureModal } from "./components/Leases";
import { OwnerManagement, OwnerPortal, OwnerMaintenanceView } from "./components/Owners";
import { TenantPortal } from "./components/TenantPortal";
import { MoveOutWizard, EvictionWorkflow } from "./components/Lifecycle";
import { RoleManagement, AuditTrail, ArchivePage, ArchivedItems, ErrorLogDashboard, TasksAndApprovals, UserProfile, AdminPage } from "./components/Admin";
import { EmailNotifications } from "./components/Notifications";
import { Messages } from "./components/Messages";
import { CompanySelector, PendingRequestsPanel, PendingPMAssignments } from "./components/CompanySelector";
import { HOAPayments } from "./components/HOA";
import { Loans } from "./components/Loans";
import { InsuranceTracker } from "./components/Insurance";
import { TaxBills } from "./components/TaxBills";
import { LateFees } from "./components/LateFees";
import PublicSignPage from "./components/PublicSignPage";

// ============ SENTRY INITIALIZATION ============
Sentry.init({
  dsn: process.env.REACT_APP_SENTRY_DSN || "",
  environment: process.env.NODE_ENV || "development",
  enabled: process.env.NODE_ENV === "production" && !!process.env.REACT_APP_SENTRY_DSN,
  sampleRate: 1.0,
  tracesSampleRate: 0,
  beforeSend(event) {
    if (event.breadcrumbs) {
      event.breadcrumbs = event.breadcrumbs.map(b => ({
        ...b,
        message: b.message?.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+/g, "[email]")
      }));
    }
    return event;
  },
  ignoreErrors: [
    "ResizeObserver loop",
    "Non-Error promise rejection",
    "Load failed",
    "ChunkLoadError",
  ],
});
window.Sentry = Sentry;


// Global error tracking — captures unhandled errors and promise rejections
// Logs to audit_trail so production crashes are visible in the admin panel
(function initErrorTracking() {
  const errorLog = [];
  const MAX_ERRORS = 50; // prevent infinite loops from flooding
  function logError(source, message, stack) {
    if (errorLog.length >= MAX_ERRORS) return;
    errorLog.push({ source, message, time: new Date().toISOString() });
    // Attempt to log to audit_trail (best-effort, won't throw)
    try {
      const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
      const supabaseKey = process.env.REACT_APP_SUPABASE_ANON_KEY;
      if (supabaseUrl && supabaseKey) {
        fetch(`${supabaseUrl}/rest/v1/audit_trail`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": supabaseKey,
            "Authorization": `Bearer ${supabaseKey}`,
            "Prefer": "return=minimal",
          },
          body: JSON.stringify({
            action: "error",
            module: "frontend",
            details: `[${source}] ${message}`.slice(0, 500),
            user_email: "system",
            user_role: "system",
          }),
        }).catch(() => {}); // silently fail
      }
    } catch (_) { /* ignore */ }
    // Also log to console for local dev
    console.error(`[ErrorTracking/${source}]`, message, stack || "");
  }
  window.onerror = (msg, src, line, col, err) => {
    logError("window.onerror", `${msg} at ${src}:${line}:${col}`, err?.stack);
  };
  window.addEventListener("unhandledrejection", (e) => {
    const msg = e.reason?.message || e.reason || "Unknown promise rejection";
    logError("unhandledrejection", String(msg).slice(0, 500), e.reason?.stack);
  });
})();




// ============ TOAST NOTIFICATION SYSTEM ============
let _toastIdCounter = 0;

// ============ ROLE DEFINITIONS ============
// Accounting sub-page IDs — match ALL_NAV's accounting.children
// below. Listed once and spread into each role that has accounting
// access so they show up in the expanded sidebar.
const ACCT_SUB_PAGES = ["acct_opening","acct_coa","acct_journal","acct_recurring","acct_bankimport","acct_reconcile","acct_classes","acct_reports"];

const ROLES = {
  admin: { label: "Admin", color: "bg-brand-600", pages: ["dashboard","tasks","properties","tenants","payments","maintenance","utilities","hoa","loans","insurance","tax_bills","accounting",...ACCT_SUB_PAGES,"owners","notifications","messages","admin","documents","doc_builder","leases","autopay","inspections","vendors","moveout","evictions","latefees"] },
  // Manager sits between admin and the customizable staff roles. Can
  // review / approve requests submitted by staff who've been explicitly
  // assigned to them via manager_email. Can't administer the company
  // (no members page, no role edits).
  manager: { label: "Manager", color: "bg-brand-400", pages: ["dashboard","tasks","properties","tenants","payments","maintenance","utilities","hoa","tax_bills","accounting",...ACCT_SUB_PAGES,"notifications","messages","documents","doc_builder","leases","inspections","vendors","moveout","evictions"] },
  office_assistant: { label: "Office Assistant", color: "bg-info-500", pages: ["dashboard","tasks","properties","tenants","payments","maintenance","utilities","hoa","tax_bills","accounting",...ACCT_SUB_PAGES,"notifications","messages","admin","documents","doc_builder","leases","inspections","vendors","moveout","evictions"] },
  accountant: { label: "Accountant", color: "bg-positive-600", pages: ["dashboard","accounting",...ACCT_SUB_PAGES,"payments","utilities"] },
  maintenance: { label: "Maintenance", color: "bg-notice-500", pages: ["maintenance","vendors"] },
  // Tenant sees the portal split into per-tab sidebar items, mirroring
  // the staff sidebar UX. Each tenant_* page routes to the same
  // TenantPortal component with a different initialTab so the nav
  // feels like a real app instead of an in-page tab strip.
  tenant: { label: "Tenant", color: "bg-brand-50/300", pages: ["tenant_portal", "tenant_overview", "tenant_pay", "tenant_autopay", "tenant_ledger", "tenant_maintenance", "tenant_documents", "tenant_messages"] },
  owner: { label: "Owner", color: "bg-highlight-600", pages: ["owner_portal","loans"] },
};

const ALL_NAV = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "properties", label: "Properties", icon: "apartment", children: [
    { id: "maintenance", label: "Maintenance", icon: "build" },
    { id: "inspections", label: "Inspections", icon: "checklist" },
    { id: "utilities", label: "Utilities", icon: "bolt" },
    { id: "hoa", label: "HOA Payments", icon: "holiday_village" },
    { id: "loans", label: "Loans", icon: "account_balance_wallet" },
    { id: "insurance", label: "Insurance", icon: "verified_user" },
    { id: "tax_bills", label: "Tax Bills", icon: "receipt_long" },
  ]},
  { id: "tenants", label: "Tenants", icon: "people" },
  { id: "payments", label: "Payments", icon: "payments" },
  { id: "accounting", label: "Accounting", icon: "account_balance", children: [
    { id: "acct_opening",    label: "Opening Balances",  icon: "restart_alt" },
    { id: "acct_coa",        label: "Chart of Accounts", icon: "list_alt" },
    { id: "acct_journal",    label: "Journal Entries",   icon: "receipt_long" },
    { id: "acct_recurring",  label: "Recurring Entries", icon: "autorenew" },
    { id: "acct_bankimport", label: "Bank Transactions", icon: "credit_card" },
    { id: "acct_reconcile",  label: "Reconcile",         icon: "account_balance_wallet" },
    { id: "acct_classes",    label: "Class Tracking",    icon: "category" },
    { id: "acct_reports",    label: "Reports",           icon: "assessment" },
  ]},
  { id: "doc_builder", label: "Document Builder", icon: "description" },
  { id: "vendors", label: "Vendors", icon: "engineering" },
  { id: "tasks", label: "Tasks & Approvals", icon: "assignment" },
  { id: "owners", label: "Owners", icon: "person" },
  { id: "messages", label: "Messages", icon: "forum" },
  { id: "notifications", label: "Notifications", icon: "notifications_active" },
];

// Tenant-specific sidebar nav. Each item drives the same TenantPortal
// component but with a different initialTab — same pattern Accounting
// uses for its sub-pages. Order matches what tenants reach for most:
// see balance/lease (Overview), pay rent, manage autopay, audit the
// ledger, request maintenance, view docs, message the landlord.
const TENANT_NAV = [
  { id: "tenant_overview", label: "Overview", icon: "home" },
  { id: "tenant_pay", label: "Pay Rent", icon: "credit_card" },
  { id: "tenant_autopay", label: "Autopay", icon: "autorenew" },
  { id: "tenant_ledger", label: "Ledger", icon: "receipt_long" },
  { id: "tenant_maintenance", label: "Maintenance", icon: "build" },
  { id: "tenant_documents", label: "Documents", icon: "folder" },
  { id: "tenant_messages", label: "Messages", icon: "forum" },
];

// Flat list of all nav IDs including children (for settings UI and allowedPages)
const ALL_NAV_FLAT = ALL_NAV.flatMap(n => n.children ? [n, ...n.children] : [n]);
// Child page IDs that live under a parent in sidebar
const NAV_CHILD_IDS = new Set(ALL_NAV.flatMap(n => (n.children || []).map(c => c.id)));

const pageComponents = {
  dashboard: Dashboard,
  tasks: TasksAndApprovals,
  properties: Properties,
  tenants: Tenants,
  payments: Payments,
  maintenance: Maintenance,
  utilities: Utilities,
  accounting: Accounting,
  // Each Accounting sub-page routes to the same Accounting component
  // with a baked initialTab. The component watches the prop and
  // syncs activeTab on change so nav-clicks within the section don't
  // unmount/remount stale state. Sub-page IDs match the sidebar
  // children defined in ALL_NAV.
  acct_opening:    (p) => <Accounting {...p} initialTab="opening" />,
  acct_coa:        (p) => <Accounting {...p} initialTab="coa" />,
  acct_journal:    (p) => <Accounting {...p} initialTab="journal" />,
  acct_recurring:  (p) => <Accounting {...p} initialTab="recurring" />,
  acct_bankimport: (p) => <Accounting {...p} initialTab="bankimport" />,
  acct_reconcile:  (p) => <Accounting {...p} initialTab="reconcile" />,
  acct_classes:    (p) => <Accounting {...p} initialTab="classes" />,
  acct_reports:    (p) => <Accounting {...p} initialTab="reports" />,
  documents: Documents, // no sidebar entry, but accessible via "Upload Document" buttons in property/tenant views
  inspections: Inspections,
  hoa: HOAPayments,
  loans: Loans,
  insurance: InsuranceTracker,
  tax_bills: TaxBills,
  admin: AdminPage,
  leases: LeaseManagement,
  // LateFees is the per-tenant late-fee application page. Rule DEFAULTS
  // live on the Admin Settings tab, but the per-tenant apply flow needs
  // its own route (it was silently dropped from the map during an
  // earlier refactor — the component itself is still live). Hash
  // route #latefees now renders it again.
  latefees: LateFees,
  vendors: VendorManagement,
  owners: OwnerManagement,
  notifications: EmailNotifications,
  messages: Messages,
  moveout: MoveOutWizard,
  evictions: EvictionWorkflow,
  doc_builder: DocumentBuilder,
  tenant_portal: TenantPortal,
  // Tenant sidebar pages all route to TenantPortal with a baked
  // initialTab. activeTab inside TenantPortal syncs from the prop on
  // mount + on prop changes (useEffect), so clicking a sidebar item
  // swaps the tab without unmounting the whole component.
  tenant_overview:    (p) => <TenantPortal {...p} initialTab="overview" />,
  tenant_pay:         (p) => <TenantPortal {...p} initialTab="pay" />,
  tenant_autopay:     (p) => <TenantPortal {...p} initialTab="autopay" />,
  tenant_ledger:      (p) => <TenantPortal {...p} initialTab="history" />,
  tenant_maintenance: (p) => <TenantPortal {...p} initialTab="maintenance" />,
  tenant_documents:   (p) => <TenantPortal {...p} initialTab="documents" />,
  tenant_messages:    (p) => <TenantPortal {...p} initialTab="messages" />,
  owner_portal: OwnerPortal,
};

function SetPasswordScreen({ currentUser, onComplete, showToast }) {
  const [pw, setPw] = React.useState("");
  const [pw2, setPw2] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  async function handleSet() {
    if (pw.length < 8) { showToast("Password must be at least 8 characters.", "error"); return; }
    if (pw !== pw2) { showToast("Passwords do not match.", "error"); return; }
    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) { setSaving(false); pmError("PM-1009", { raw: error, context: "updateUser password set" }); return; }
    // Persist password_set_at so the auth router doesn't re-prompt on next
    // login. Upsert because tenants invited via magic link have a
    // company_members row but NO app_users row yet — UPDATE alone wouldn't
    // touch anything. We grab company_id from their first membership to
    // satisfy the (email, company_id) unique index.
    try {
      const email = currentUser?.email || "";
      const { data: mem } = await supabase.from("company_members")
        .select("company_id, role, user_name")
        .ilike("user_email", emailFilterValue(email))
        .limit(1)
        .maybeSingle();
      await supabase.from("app_users").upsert({
        email,
        company_id: mem?.company_id || null,
        role: mem?.role || "tenant",
        name: mem?.user_name || email.split("@")[0],
        password_set_at: new Date().toISOString(),
      }, { onConflict: "email,company_id" });
    } catch (_) { /* non-fatal — worst case the user is prompted once more */ }
    setSaving(false);
    showToast("Password set! You can now log in with email and password.", "success");
    onComplete();
  }
  return (
    <div className="min-h-dvh safe-y safe-x bg-gradient-to-br from-brand-50 to-white flex items-center justify-center p-4">
    <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-8 w-full max-w-sm text-center">
    <span className="material-icons-outlined text-4xl text-brand-500 mb-2">lock</span>
    <h2 className="text-xl font-bold text-neutral-800 mb-1">Set Your Password</h2>
    <p className="text-sm text-neutral-400 mb-6">Welcome, {currentUser?.email}. Create a password so you can log in anytime.</p>
    <div className="space-y-3 text-left">
    <div><label className="text-xs font-medium text-neutral-600 mb-1 block">New Password</label><Input type="password" placeholder="Min 8 characters" value={pw} onChange={e => setPw(e.target.value)} /></div>
    <div><label className="text-xs font-medium text-neutral-600 mb-1 block">Confirm Password</label><Input type="password" placeholder="Re-enter password" value={pw2} onChange={e => setPw2(e.target.value)} onKeyDown={e => e.key === "Enter" && handleSet()} /></div>
    </div>
    <Btn variant="primary" className="w-full mt-5" onClick={handleSet} disabled={saving}>{saving ? "Setting..." : "Set Password & Continue"}</Btn>
    <TextLink tone="neutral" size="xs" underline={false} onClick={onComplete} className="mt-3 block mx-auto">Skip for now</TextLink>
    </div>
    </div>
  );
}

function AppInner() {
  const [screen, setScreenRaw] = useState("loading");
  // Capture the very first hash the user landed on. Push notification
  // clicks open URLs like /#messages or /#payments to deep-link into
  // a module. The app's normal flow then transitions through
  // setScreen("login") / "companySelect", and EACH of those calls
  // `history.pushState(... "#" + screen)` which clobbers the
  // deep-link hash. By the time setScreen("app") fires post-login,
  // the URL hash is "#login" and the deep-link is gone — that's why
  // a /#messages push click was landing on Dashboard. Stash the
  // original hash on first mount and replay it post-auth.
  const initialDeepLink = (() => {
    const h = window.location.hash.replace("#", "");
    if (!h) return null;
    // Filter out values that are screen names, not pages, so we don't
    // bounce a user who reloaded mid-login back to the login screen.
    if (h === "login" || h === "companySelect" || h === "loading" || h === "app") return null;
    return h;
  })();
  const deepLinkRef = useRef(initialDeepLink);
  const [page, setPageRaw] = useState(() => initialDeepLink || "dashboard");

  const [pageAction, setPageAction] = useState(null);
  function setPage(p, action) { setPageAction(action || null); setPageRaw(p); window.history.pushState({ page: p, screen: "app" }, "", "#" + p); }
  function setScreen(s) { setScreenRaw(s); screenRef.current = s; if (s !== "app") window.history.pushState({ screen: s }, "", "#" + s); }
  // Mirror `screen` into a ref so the auth-state-change subscriber
  // (which closes over state values from its mount-time render) can
  // read the CURRENT screen when deciding whether to re-route. Without
  // this, a stale "loading" value lets Supabase's repeat SIGNED_IN
  // events (fired on tab-visibility restore) bounce the user back to
  // the company selector.
  const screenRef = useRef("loading");

  useEffect(() => {
  const onPop = (e) => { if (e.state?.page) setPageRaw(e.state.page); if (e.state?.screen) setScreenRaw(e.state.screen); };
  window.addEventListener("popstate", onPop);
  return () => window.removeEventListener("popstate", onPop);
  }, []);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [expandedNav, setExpandedNav] = useState(() => {
    const initial = new Set();
    // Auto-expand parents whose child is the current page OR when the
    // current page IS the parent itself — landing on the Accounting /
    // Properties dashboard should reveal their sub-pages in the sidebar
    // without the user having to find the chevron.
    ALL_NAV.forEach(n => {
      if (!n.children) return;
      if (n.id === page || n.children.some(c => c.id === page)) initial.add(n.id);
    });
    return initial;
  });
  // Keep parents auto-expanded as the user navigates between them.
  // Without this, expandedNav is set only at first mount; clicking
  // 'Accounting' from another module would render the parent active
  // but its children stay hidden behind the chevron until you click it.
  // The Set merge preserves any parent the user manually toggled open.
  useEffect(() => {
    setExpandedNav(prev => {
      const next = new Set(prev);
      ALL_NAV.forEach(n => {
        if (!n.children) return;
        if (n.id === page || n.children.some(c => c.id === page)) next.add(n.id);
      });
      return next;
    });
  }, [page]);
  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  // Unread inbound messages (sender_role='tenant', read_at IS NULL) for
  // the sidebar badge on the Messages nav item. Polled every 30s.
  const [unreadMessages, setUnreadMessages] = useState(0);
  // Count shown on the sidebar "Tasks & Approvals" nav item. Kept
  // approximate — adds pending counts across the three approval
  // tables plus in-progress/completed wizards (treated as 1 each
  // even though each can fan out to many individual skip tasks).
  // Refresh on focus + every 30s so the badge stays close to live
  // without hammering the DB.
  const [pendingTasksCount, setPendingTasksCount] = useState(0);
  const [toasts, setToasts] = useState([]);
  const [confirmConfig, setConfirmConfig] = useState(null);
  const confirmResolveRef = useRef(null);
  // Ref on the main scroll container so PullToRefresh can attach its
  // touch listeners to the element the user actually scrolls.
  const mainScrollRef = useRef(null);

  function showToast(message, type = "info", errorObj = null) {
  const id = ++_toastIdCounter;
  if (errorObj?.isError) {
    const duration = errorObj.severity === "critical" ? 10000 : errorObj.severity === "error" ? 6000 : 4000;
    setToasts(prev => [...prev, { id, type: errorObj.severity === "critical" ? "error" : errorObj.severity, isError: true, code: errorObj.code, message: errorObj.message, action: errorObj.action }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration);
  } else {
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }
  }
  setShowToastGlobal(showToast);
  function removeToast(id) { setToasts(prev => prev.filter(t => t.id !== id)); }

  // safeLedgerInsert is now top-level (accessible from all components)

  // postAccountingTransaction is now a top-level function (accessible from all components)

  function showConfirm(config) {
  return new Promise(resolve => {
  confirmResolveRef.current = resolve;
  setConfirmConfig(typeof config === "string" ? { message: config } : config);
  });
  }
  function handleConfirm() { confirmResolveRef.current?.(true); setConfirmConfig(null); }
  function handleCancel() { confirmResolveRef.current?.(false); setConfirmConfig(null); }
  const [currentUser, setCurrentUser] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [showUserProfile, setShowUserProfile] = useState(false);
  const [customAllowedPages, setCustomAllowedPages] = useState(null);
  // Company context
  const [activeCompany, setActiveCompany] = useState(null);
  const [companySettings, setCompanySettings] = useState({ ...COMPANY_DEFAULTS });

  // Browser back button support
  useEffect(() => {
  const handlePopState = (e) => {
  if (e.state?.page) {
  setPageRaw(e.state.page);
  } else if (e.state?.screen) {
  setScreenRaw(e.state.screen);
  } else {
  // No state — go to dashboard or landing
  if (screen === "app") setPageRaw("dashboard");
  }
  };
  window.addEventListener("popstate", handlePopState);
  return () => window.removeEventListener("popstate", handlePopState);
  }, [screen]);
  const [companyRole, setCompanyRole] = useState("");
  const [roleLoaded, setRoleLoaded] = useState(false);
  const [missingRPCs, setMissingRPCs] = useState([]);

  // Capture ?company= param once at startup (before any replaceState clears it)
  const [urlCompanyParam] = useState(() => new URLSearchParams(window.location.search).get("company"));

  useEffect(() => {
  // The Supabase user object does NOT carry amr (authentication methods
  // reference) — that's JWT-payload only. Relying on user.amr returned
  // false for every magic-link user, so nobody ever saw the
  // set-password prompt. We now rely on app_users.password_set_at as the
  // single source of truth: set on first successful password setup, and
  // backfilled for legacy users so they're not re-prompted.
  async function needsPasswordSetup(user) {
    if (!user?.email) return false;
    try {
      // The prompt exists purely for magic-link invitees: they land with a
      // session but no password of their own, and we want them to set one.
      // That state = an `app_users` row exists (created by the invite flow)
      // AND password_set_at is NULL.
      //   - No rows at all → user was onboarded through a path that didn't
      //     touch app_users (e.g., company creator, admin sign-up). They
      //     signed in using whatever credentials they already had, so
      //     there's nothing to set up.
      //   - At least one row with password_set_at populated → done.
      //   - All rows have password_set_at = null → prompt.
      const { data: rows } = await supabase.from("app_users")
        .select("password_set_at")
        .ilike("email", emailFilterValue(user.email))
        .limit(10);
      if (!rows || rows.length === 0) return false;
      return !rows.some(r => r.password_set_at);
    } catch (_) {
      // Transient fetch failure — err on the side of NOT interrupting the
      // user's normal flow. The next session will prompt if needed.
      return false;
    }
  }
  async function routeSignedIn(user) {
    setCurrentUser(user);
    const mustPrompt = await needsPasswordSetup(user);
    if (mustPrompt) { setScreen("set_password"); return; }
    setScreen("company_select");
    autoSelectCompany(user);
  }
  supabase.auth.getSession().then(({ data: { session } }) => {
  if (session) { routeSignedIn(session.user); }
  else { setScreen("landing"); }
  });
  const { data: { subscription: authSub } } = supabase.auth.onAuthStateChange((_event, session) => {
  if (session) {
    // Only route on fresh sign-in events; TOKEN_REFRESHED / USER_UPDATED
    // shouldn't reset the screen the user is currently on.
    //
    // Supabase also fires SIGNED_IN again when a tab regains focus
    // after the session is re-fetched — without this guard that
    // bounces an already-signed-in user back through the company
    // selector, wiping any in-flight form state. Skip the re-route if
    // we're already inside the app or on a post-landing screen.
    const onEntryScreen = screenRef.current === "loading" || screenRef.current === "landing" || screenRef.current === "login";
    if ((_event === "SIGNED_IN" || _event === "INITIAL_SESSION") && onEntryScreen) {
      routeSignedIn(session.user);
    } else {
      setCurrentUser(session.user);
    }
  } else {
  setCurrentUser(null);
  setUserRole(null);
  setActiveCompany(null);
  setScreen("landing");
  }
  });
  return () => { if (authSub) authSub.unsubscribe(); };
  }, []);

  // Inactivity timeout — auto-logout after 30 minutes of no user interaction
  useEffect(() => {
    if (!currentUser) return;
    const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
    let timer = setTimeout(handleIdleLogout, IDLE_TIMEOUT);
    function resetTimer() {
      clearTimeout(timer);
      timer = setTimeout(handleIdleLogout, IDLE_TIMEOUT);
    }
    function handleIdleLogout() {
      supabase.auth.signOut();
    }
    const events = ["mousedown", "keydown", "touchstart", "scroll"];
    events.forEach(e => window.addEventListener(e, resetTimer, { passive: true }));
    return () => {
      clearTimeout(timer);
      events.forEach(e => window.removeEventListener(e, resetTimer));
    };
  }, [currentUser]);

  // Auto-select company ONLY for tenant/owner roles — everyone else sees the company selector
  async function autoSelectCompany(user) {
  if (!user?.email) return;
  // Prefer UID-based lookup (faster, not email-dependent), fall back to email
  let memberships;
  if (user.id) {
  const { data: uidResult } = await supabase.from("company_members").select("company_id, role, status").eq("auth_user_id", user.id).eq("status", "active");
  if (uidResult && uidResult.length > 0) { memberships = uidResult; }
  }
  if (!memberships) {
  const { data: emailResult } = await supabase.from("company_members").select("company_id, role, status").ilike("user_email", emailFilterValue(user.email)).eq("status", "active");
  memberships = emailResult;
  }
  if (!memberships || memberships.length === 0) { setScreen("company_select"); return; }
  // Check for ?company=UUID in URL — auto-select that company if user is a member
  const urlCompanyId = urlCompanyParam || new URLSearchParams(window.location.search).get("company");
  if (urlCompanyId) {
  let match = memberships.find(m => m.company_id === urlCompanyId);
  // If not found in cached memberships, try a direct query (handles newly created companies)
  if (!match) {
  const { data: directMem } = await supabase.from("company_members").select("company_id, role, status").eq("company_id", urlCompanyId).ilike("user_email", emailFilterValue(user.email)).eq("status", "active").maybeSingle();
  if (directMem) match = directMem;
  }
  if (match) {
  const { data: company } = await supabase.from("companies").select("*").eq("id", urlCompanyId).maybeSingle();
  if (company) { window.history.replaceState({}, "", window.location.pathname); handleSelectCompany(company, match.role, user); return; }
  }
  }
  // Only tenants auto-select their company (skip selector)
  const tenantMembership = memberships.find(m => m.role === "tenant");
  if (tenantMembership) {
  const { data: company } = await supabase.from("companies").select("*").eq("id", tenantMembership.company_id).maybeSingle();
  if (company) { handleSelectCompany(company, tenantMembership.role, user); return; }
  }
  // Second-chance auto-select: if the user's last-visited company is
  // still an active membership, restore it on reload. Without this,
  // Ctrl-R on any module dumps the admin back to the Company Selector
  // and loses their current page — surprising for a browser refresh.
  try {
    const lastCompanyId = localStorage.getItem("lastCompanyId");
    if (lastCompanyId) {
      const lastMatch = memberships.find(m => m.company_id === lastCompanyId);
      if (lastMatch) {
        const { data: company } = await supabase.from("companies").select("*").eq("id", lastCompanyId).maybeSingle();
        if (company) { handleSelectCompany(company, lastMatch.role, user); return; }
      }
    }
  } catch (_e) { /* localStorage unavailable — fall through to selector */ }
  // Default: show selector (first login, multi-company, or stale lastCompanyId)
  setScreen("company_select");
  }

  async function ensureDefaultAccounts(cid) {
  const defaults = [
  { code: "1000", name: "Checking Account", type: "Asset", is_active: true },
  { code: "1100", name: "Accounts Receivable", type: "Asset", is_active: true },
  { code: "2100", name: "Security Deposits Held", type: "Liability", is_active: true },
  { code: "2200", name: "Owner Distributions Payable", type: "Liability", is_active: true },
  // Equity block — needed so the Opening Balances tab has a place to
  // post prior-system balances. 3000 is the clearing account used as
  // the plug on the opening JE; never rename or deactivate without
  // reviewing every opening-balance JE that references it.
  { code: "3000", name: "Opening Balance Equity", type: "Equity", is_active: true },
  { code: "3100", name: "Owner's Equity", type: "Equity", is_active: true },
  { code: "3200", name: "Retained Earnings", type: "Equity", is_active: true },
  { code: "4000", name: "Rental Income", type: "Revenue", is_active: true },
  { code: "4010", name: "Late Fee Income", type: "Revenue", is_active: true },
  { code: "4100", name: "Other Income", type: "Revenue", is_active: true },
  { code: "4200", name: "Management Fee Income", type: "Revenue", is_active: true },
  { code: "5300", name: "Repairs & Maintenance", type: "Expense", is_active: true },
  { code: "5400", name: "Utilities Expense", type: "Expense", is_active: true },
  ];
  const { data: existing } = await supabase.from("acct_accounts").select("id, code, name").eq("company_id", cid);
  const existingNames = new Set((existing || []).map(a => a.name));
  const missing = defaults.filter(a => !existingNames.has(a.name));
  if (missing.length === 0) return;
  const rows = missing.map(a => ({ ...a, company_id: cid, old_text_id: cid + "-" + a.code }));
  for (const row of rows) {
  const { error } = await supabase.from("acct_accounts").insert([row]);
  if (error) pmError("PM-4006", { raw: error, context: "ensureDefaultAccounts insert for " + row.code, silent: true });
  }
  delete _acctIdCache[cid];
  }

  function handleSelectCompany(company, role, explicitUser = null) {
  // `explicitUser` lets callers invoked right after setCurrentUser pass the
  // fresh auth user directly — avoids the race where component state
  // hasn't propagated by the time we compute the initial userProfile.
  const userForProfile = explicitUser || currentUser;
  // Clear previous company's cached data (including global caches)
  setNotifications([]);
  setUnreadCount(0);
  setMissingRPCs([]);
  // Clear global caches to prevent cross-company data leaks
  Object.keys(_classIdCache).forEach(k => delete _classIdCache[k]);
  Object.keys(_acctIdCache).forEach(k => delete _acctIdCache[k]);
  Object.keys(_tenantArCache).forEach(k => delete _tenantArCache[k]);
  // Reset window-level backfill flags
  window._propClassesSynced = false;
  window._tenantArBackfilled = false;
  window._jeRenumbered = false;
  window._classIdBackfilled = false;
  setActiveErrorContext(company.id, currentUser?.email || "", role || "");
  setActiveCompany(company);
  try { localStorage.setItem("lastCompanyId", company.id); } catch (_e) { pmError("PM-8006", { raw: _e, context: "save lastCompanyId to localStorage", silent: true }); }
  checkRPCHealth(company.id).then(m => setMissingRPCs(m)).catch(() => {});
  loadCompanySettings(company.id).then(s => {
    setCompanySettings(s);
    // Transient DB failure → we're rendering defaults that don't match
    // the stored config. Warn the user so they don't unknowingly save
    // default values over their real settings.
    if (s?._loadError) showToast("Couldn't load your company settings (" + s._loadError + "). Don't save the Settings tab until this refreshes.", "warning");
  }).catch(() => {});
  loadInboxNotifications(company.id);
  registerPushNotifications();
  // Auto-run daily notification check (rent reminders, lease expiry)
  autoNotificationCheck(company.id);
  // Ensure default chart of accounts exists BEFORE any accounting operations
  ensureDefaultAccounts(company.id).then(() => {
  if (role !== "tenant" && role !== "owner") {
  // Auto-post rent accruals (idempotent — skips already posted months)
  autoPostRentCharges(company.id).catch(e => pmError("PM-4008", { raw: e, context: "auto rent charges on login", silent: true }));
  // Auto-post recurring journal entries (idempotent — skips already posted months)
  autoPostRecurringEntries(company.id).catch(e => pmError("PM-4008", { raw: e, context: "auto recurring entries on login", silent: true }));
  }
  }).catch(e => pmError("PM-4006", { raw: e, context: "chart of accounts seed", silent: true }));
  setCompanyRole(role);
  setUserRole(role);
  setRoleLoaded(true);
  setUserProfile({ name: userForProfile?.email?.split("@")[0] || "User", email: userForProfile?.email, role: role });
  fetchUserRoleForCompany(userForProfile, company.id); // async — role + real name update via setState after fetch
  setScreen("app");
  // Prefer the deep-link captured on first mount (push-click hash)
  // over the current location.hash, which has been clobbered by
  // every setScreen() transition since landing. Falls back to the
  // current hash for in-session navigation, then dashboard.
  const deepLink = deepLinkRef.current;
  const hashPage = window.location.hash.replace("#", "");
  if (deepLink) {
    setPage(deepLink);
    deepLinkRef.current = null; // one-shot — don't replay on re-auth
  } else if (hashPage && hashPage !== "app" && hashPage !== "login" && hashPage !== "companySelect" && hashPage !== "loading") {
    setPageRaw(hashPage);
  } else {
    setPage("dashboard");
  }
  }

  async function fetchUserRoleForCompany(user, companyId) {
  if (!user?.email || !companyId) return;
  try {
  const { data } = await supabase.from("company_members").select("*").eq("company_id", companyId).ilike("user_email", emailFilterValue(user.email)).eq("status", "active").maybeSingle();
  // Backfill auth_user_id for UID-based lookups
  if (data && !data.auth_user_id && user.id) {
  const { error: uidErr } = await supabase.from("company_members").update({ auth_user_id: user.id }).eq("id", data.id);
  if (uidErr) pmError("PM-1009", { raw: uidErr, context: "auth_user_id backfill", silent: true });
  }
  if (data) {
  setUserRole(data.role);
  setCompanyRole(data.role);
  let displayName = data.user_name;
  // For tenants, prefer the name on the tenants table over company_members
  // — invites occasionally save user_name as the email prefix when the
  // inviter didn't type a display name.
  if (!displayName && data.role === "tenant") {
    try {
      const { data: trow } = await supabase.from("tenants").select("name").eq("company_id", companyId).ilike("email", emailFilterValue(user.email)).maybeSingle();
      if (trow?.name) displayName = trow.name;
    } catch (_) { /* fall through to email prefix */ }
  }
  setUserProfile({ name: displayName || user.email.split("@")[0], email: user.email, role: data.role });
  if (data.custom_pages) {
  try { const parsed = JSON.parse(data.custom_pages); if (Array.isArray(parsed)) setCustomAllowedPages(parsed); } catch { setCustomAllowedPages(null); }
  } else {
  setCustomAllowedPages(null);
  }
  }
  setRoleLoaded(true);
  } catch { setRoleLoaded(true); /* still mark loaded so UI doesn't hang */ }
  }

  function addNotification(icon, message, options = {}) {
  const n = { id: shortId(), icon, message, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), read: false };
  setNotifications(prev => [n, ...prev].slice(0, 50));
  setUnreadCount(prev => prev + 1);
  // Persist to DB for notification history
  if (activeCompany?.id) {
  supabase.from("notification_inbox").insert([{
  company_id: activeCompany.id,
  icon, message,
  recipient_email: options.recipient || userProfile?.email || "",
  notification_type: options.type || "general",
  read: false,
  }]).then(({ error }) => { if (error) pmError("PM-8006", { raw: error, context: "inbox write", silent: true }); });
  }
  }


  // Push Notification Registration. Strategy refined per Apple's
  // documented quirks (see WebKit Bugzilla 273063 + Apple's web push
  // docs):
  //   1. Don't auto-prompt for permission on every launch — that's
  //      what the Notifications page button is for. If the user
  //      previously granted, we respect existing state.
  //   2. On every launch, RECONCILE the browser's subscription with
  //      our DB. Three cases:
  //         (a) browser has a sub, DB matches → no-op
  //         (b) browser has a sub, DB has stale/different endpoint
  //             → upsert new endpoint to DB
  //         (c) browser has no sub but permission is granted → Apple
  //             quietly revoked it; resubscribe and update DB
  //   3. NEVER fire a silent self-test push — that's exactly what
  //      gets us revoked in the first place.
  async function registerPushNotifications() {
  try {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  const registration = await navigator.serviceWorker.register("/sw.js");
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    // Permission was never granted (or was denied) — don't auto-
    // prompt. The Notifications page hero card has the explicit
    // "Allow notifications" button users tap on first run.
    return;
  }
  const VAPID_PUBLIC_KEY = process.env.REACT_APP_VAPID_PUBLIC_KEY || "";
  if (!VAPID_PUBLIC_KEY) { pmError("PM-8006", { raw: { message: "VAPID key not configured" }, context: "push registration", silent: true }); return; }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = window.atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
  }

  let subscription = await registration.pushManager.getSubscription();

  // Reconcile against server. Three states drive different actions:
  //   (a) browser has sub + DB has matching sub → no-op
  //   (b) browser has sub + DB row missing → server-side admin
  //       deleted the row to force a refresh; the browser-cached
  //       endpoint may be the silently-revoked one. Unsubscribe
  //       and resubscribe to get a fresh APNS endpoint.
  //   (c) browser has sub + DB has different endpoint → just upsert
  //       (browser already rotated for some reason).
  //   (d) browser has no sub + permission granted → Apple revoked
  //       client-side; resubscribe.
  if (activeCompany?.id && currentUser?.email) {
    const { data: existingRow } = await supabase.from("push_subscriptions")
      .select("subscription, dead_marked_at").eq("company_id", activeCompany.id)
      .eq("user_email", currentUser.email).maybeSingle();
    const existingEndpoint = existingRow?.subscription?.endpoint;
    const dbHasRow = !!existingRow;
    const subAlreadyMarkedDead = !!existingRow?.dead_marked_at;

    const needFreshSubscribe = !subscription
      || (subscription && !dbHasRow)
      || subAlreadyMarkedDead;

    if (needFreshSubscribe) {
      // Force-rotate to a fresh APNS endpoint. unsubscribe() tells the
      // push service to forget the old endpoint; subscribe() then
      // mints a new one. Apple silent-revocation lives on the OLD
      // endpoint; the new one starts with a clean slate.
      if (subscription) {
        try { await subscription.unsubscribe(); } catch (_e) { /* harmless */ }
      }
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    if (subscription) {
      const subJson = JSON.parse(JSON.stringify(subscription));
      if (existingEndpoint !== subJson.endpoint || subAlreadyMarkedDead) {
        await supabase.from("push_subscriptions").upsert([{
          company_id: activeCompany.id,
          user_email: currentUser.email,
          subscription: subJson,
        }], { onConflict: "company_id,user_email" }).then(({ error }) => {
          if (error) pmError("PM-8006", { raw: error, context: "push subscription save", silent: true });
        });
        // Clear stale health flags so the new sub starts clean.
        await supabase.from("push_subscriptions")
          .update({ last_sw_received_at: null, last_dispatch_at: null, dead_marked_at: null })
          .eq("company_id", activeCompany.id)
          .eq("user_email", currentUser.email);
      }
    }
  }
  } catch (e) { pmError("PM-8006", { raw: e, context: "push registration", silent: true }); }
  }


  async function autoNotificationCheck(cid) {
  try {
  const lastCheck = sessionStorage.getItem("notifCheck_" + cid);
  const today = new Date().toDateString();
  if (lastCheck === today) return; // Already checked today
  sessionStorage.setItem("notifCheck_" + cid, today);

  // Check rent due reminders
  const { data: activeLeases } = await supabase.from("leases").select("id, tenant_name, property, rent_amount, payment_due_day, end_date")
  .eq("company_id", cid).eq("status", "active").limit(200);
  if (!activeLeases) return;

  const todayDate = new Date();
  let queued = 0;

  for (const lease of activeLeases) {
  // Rent due reminder (3 days before due date)
  const dueDay = Math.min(lease.payment_due_day || 1, 28);
  const nextDue = new Date(todayDate.getFullYear(), todayDate.getMonth(), dueDay);
  if (nextDue < todayDate) nextDue.setMonth(nextDue.getMonth() + 1);
  const daysUntil = Math.ceil((nextDue - todayDate) / 86400000);

  if (daysUntil <= 3 && daysUntil >= 0) {
  const { data: tenant } = await supabase.from("tenants").select("email").eq("company_id", cid).eq("name", lease.tenant_name).is("archived_at", null).maybeSingle();
  if (tenant?.email) {
  // Check duplicate
  const monthKey = nextDue.getFullYear() + "-" + String(nextDue.getMonth()+1).padStart(2,"0");
  // notification_queue.data is JSONB — `ilike` doesn't work on it
  // (Postgres errors silently with "operator does not exist:
  // jsonb ~~* unknown"). Match against the JSON properties directly.
  const { data: already } = await supabase.from("notification_queue").select("id")
  .eq("company_id", cid).eq("type", "rent_due")
  .eq("data->>tenant", lease.tenant_name)
  .eq("data->>month", monthKey).limit(1);
  if (!already?.length) {
  await queueNotification("rent_due", tenant.email, { tenant: lease.tenant_name, amount: lease.rent_amount, date: nextDue.toLocaleDateString(), property: lease.property, month: monthKey }, cid);
  queued++;
  }
  }
  }

  // Lease expiry warning (60 days before)
  if (lease.end_date) {
  const endDate = new Date(lease.end_date);
  const daysLeft = Math.ceil((endDate - todayDate) / 86400000);
  if (daysLeft <= (companySettings.lease_expiry_warning_days || 60) && daysLeft > 0) {
  const { data: tenant } = await supabase.from("tenants").select("email").eq("company_id", cid).eq("name", lease.tenant_name).is("archived_at", null).maybeSingle();
  if (tenant?.email) {
  // notification_queue.data is jsonb — ilike on jsonb returns 404 from
  // PostgREST (operator class mismatch) and was firing per-lease on
  // every dashboard load. Use the JSON arrow-extract operator so we
  // match against a specific key inside the JSON.
  const { data: already } = await supabase.from("notification_queue").select("id")
  .eq("company_id", cid).eq("type", "lease_expiry").eq("data->>leaseId", String(lease.id)).limit(1);
  if (!already?.length) {
  await queueNotification("lease_expiry", tenant.email, { tenant: lease.tenant_name, property: lease.property, date: lease.end_date, daysLeft, leaseId: lease.id }, cid);
  queued++;
  }
  }
  }
  }
  }

  // Auto notification check complete
  } catch (e) { pmError("PM-8006", { raw: e, context: "auto notification check", silent: true }); }
  }

  // Load persisted notifications on company select
  async function loadInboxNotifications(cid) {
  const { data } = await supabase.from("notification_inbox").select("*")
  .eq("company_id", cid)
  .or("recipient_email.ilike." + escapeFilterValue(currentUser?.email || "none") + ",recipient_email.is.null")
  .order("created_at", { ascending: false }).limit(50);
  if (data) {
  setNotifications(data.map(n => ({
  id: n.id, icon: n.icon, message: n.message,
  time: new Date(n.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  read: n.read, dbId: n.id,
  date: new Date(n.created_at).toLocaleDateString(),
  })));
  setUnreadCount(data.filter(n => !n.read).length);
  }
  }

  async function handleLogout() {
  await supabase.auth.signOut();
  clearMembershipCache();
  try { localStorage.removeItem("lastCompanyId"); } catch (_e) { pmError("PM-8006", { raw: _e, context: "remove lastCompanyId from localStorage", silent: true }); }
  _toastIdCounter = 0;
  setScreen("landing");
  setNotifications([]);
  setUnreadCount(0);
  setCurrentUser(null);
  setUserRole(null);
  setRoleLoaded(false);
  setCustomAllowedPages(null);
  setActiveCompany(null);
  }

  function switchCompany() {
  // Clear caches that are company-specific
  for (const key in _acctIdCache) delete _acctIdCache[key];
  if (typeof window !== "undefined") { delete window._propClassesSynced; }
  setActiveCompany(null);
  setCompanyRole("");
  setUserRole(null);
  setRoleLoaded(false);
  setCustomAllowedPages(null);
  setNotifications([]);
  setUnreadCount(0);
  setScreen("company_select");
  setPage("dashboard");
  }

  const [loginMode, setLoginMode] = useState("login");

  // Guard: never render app without a valid company — redirect to selector
  useEffect(() => {
  if (screen === "app" && !activeCompany?.id) {
  setScreen("company_select");
  }
  }, [screen, activeCompany]);

  // Poll unread message count for the sidebar badge. Only staff care
  // about this (tenants see messages directly in their portal tab), so
  // gate on role to skip the work for tenants/owners.
  useEffect(() => {
  if (!activeCompany?.id) { setUnreadMessages(0); return; }
  if (userRole === "tenant" || userRole === "owner") { setUnreadMessages(0); return; }
  let cancelled = false;
  async function poll() {
    const { count } = await supabase.from("messages")
      .select("id", { count: "exact", head: true })
      .eq("company_id", activeCompany.id)
      .is("read_at", null)
      .eq("sender_role", "tenant");
    if (!cancelled) setUnreadMessages(count || 0);
  }
  poll();
  const id = setInterval(poll, 30000);
  const onFocus = () => poll();
  window.addEventListener("focus", onFocus);
  return () => { cancelled = true; clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, [activeCompany?.id, userRole, page]);

  // Pending Tasks & Approvals badge. Mirrors the Tasks & Approvals
  // page formula exactly, including approver-routing:
  //   • approvals: property_change_requests + doc_exception_requests
  //     filtered by canReviewRequest(userRole, userEmail, approverEmail)
  //     — i.e. each user sees only rows routed to them (admins/owners
  //     still see everything). Team join requests are admin/owner only.
  //   • tenant tasks: pending_docs / balance>0 / lease-end ≤30d
  //   • wizard-skip tasks: one per unfilled applicable step
  // Tenant users don't see this nav item, so skip the work.
  useEffect(() => {
    if (!activeCompany?.id) { setPendingTasksCount(0); return; }
    if (userRole === "tenant") { setPendingTasksCount(0); return; }
    const myEmail = userProfile?.email || currentUser?.email || "";
    let cancelled = false;
    async function poll() {
      const cid = activeCompany.id;
      try {
        const [propReq, docExc, memReq, tenantsRes, wizards, propsRes] = await Promise.all([
          supabase.from("property_change_requests").select("id, approver_email").eq("company_id", cid).eq("status", "pending"),
          supabase.from("doc_exception_requests").select("id, approver_email").eq("company_id", cid).eq("status", "pending"),
          supabase.from("company_members").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "pending"),
          supabase.from("tenants").select("id, doc_status, balance, lease_end_date, move_out").eq("company_id", cid).is("archived_at", null),
          supabase.from("property_setup_wizard").select("property_address, status, completed_steps, skipped_approved_steps").eq("company_id", cid).in("status", ["in_progress", "completed"]),
          supabase.from("properties").select("address, status").eq("company_id", cid).is("archived_at", null),
        ]);
        const propReqCount = (propReq.data || []).filter(r => canReviewRequest({ userRole, userEmail: myEmail, approverEmail: r.approver_email })).length;
        const docExcCount = (docExc.data || []).filter(r => canReviewRequest({ userRole, userEmail: myEmail, approverEmail: r.approver_email })).length;
        const memReqCount = (userRole === "admin" || userRole === "owner") ? (memReq.count || 0) : 0;
        const tenantTasks = (tenantsRes.data || []).reduce((n, t) => {
          let c = 0;
          if (t.doc_status === "pending_docs") c++;
          if (Number(t.balance) > 0) c++;
          const end = t.lease_end_date || t.move_out;
          if (end) {
            const days = Math.ceil((new Date(end).getTime() - Date.now()) / 86400000);
            if (days > 0 && days <= 30) c++;
          }
          return n + c;
        }, 0);
        const propsByAddr = new Map((propsRes.data || []).map(p => [p.address, p]));
        let wizardSteps = 0;
        for (const w of (wizards.data || [])) {
          if (w.status === "dismissed") continue;
          const prop = propsByAddr.get(w.property_address);
          if (!prop) continue;
          const applicable = getWizardApplicableSteps({ propertyStatus: prop.status, userRole });
          const completed = new Set(w.completed_steps || []);
          const approved = new Set(w.skipped_approved_steps || []);
          for (const step of applicable) {
            if (step === "property_details") continue;
            if (completed.has(step) || approved.has(step)) continue;
            wizardSteps++;
          }
        }
        const total = propReqCount + docExcCount + memReqCount + tenantTasks + wizardSteps;
        if (!cancelled) setPendingTasksCount(total);
      } catch (_e) { /* silent — next poll retries */ }
    }
    poll();
    const id = setInterval(poll, 30000);
    const onFocus = () => poll();
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, [activeCompany?.id, userRole, page, userProfile?.email, currentUser?.email]);

  if (screen === "loading") return <><div className="flex items-center justify-center h-dvh safe-y bg-brand-50/30"><Spinner /></div><ToastContainer toasts={toasts} removeToast={removeToast} /><ConfirmModal config={confirmConfig} onConfirm={handleConfirm} onCancel={handleCancel} /></>;
  if (screen === "landing") return <><LandingPage onGetStarted={(mode) => { setLoginMode(mode); setScreen("login"); }} /><ToastContainer toasts={toasts} removeToast={removeToast} /><ConfirmModal config={confirmConfig} onConfirm={handleConfirm} onCancel={handleCancel} /></>;
  if (screen === "login") return <><LoginPage onLogin={() => {}} onBack={() => setScreen("landing")} initialMode={loginMode} /><ToastContainer toasts={toasts} removeToast={removeToast} /><ConfirmModal config={confirmConfig} onConfirm={handleConfirm} onCancel={handleCancel} /></>;
  if (screen === "set_password") return <><SetPasswordScreen currentUser={currentUser} onComplete={() => { setScreen("company_select"); autoSelectCompany(currentUser); }} showToast={showToast} /><ToastContainer toasts={toasts} removeToast={removeToast} /><ConfirmModal config={confirmConfig} onConfirm={handleConfirm} onCancel={handleCancel} /></>;
  if (screen === "company_select") return <><CompanySelector currentUser={currentUser} onSelectCompany={handleSelectCompany} onLogout={handleLogout} showToast={showToast} showConfirm={showConfirm} /><ToastContainer toasts={toasts} removeToast={removeToast} /><ConfirmModal config={confirmConfig} onConfirm={handleConfirm} onCancel={handleCancel} /></>;

  if (!activeCompany?.id || !roleLoaded) {
  return (
  <div className="flex items-center justify-center h-dvh safe-y bg-brand-50/30">
  <div className="text-center">
  <Spinner />
  <p className="text-sm text-neutral-400 mt-4">{!activeCompany?.id ? "Loading company..." : "Loading your access..."}</p>
  </div>
  </div>
  );
  }

  // Build nav based on confirmed role (roleLoaded is true at this point).
  // Tenants get a dedicated TENANT_NAV (Overview / Pay Rent / Autopay /
  // Ledger / Maintenance / Documents / Messages) instead of the staff
  // sidebar — same pattern, different list.
  const baseAllowedPages = customAllowedPages || ROLES[userRole]?.pages || ROLES[companyRole]?.pages || ["dashboard"];
  // Parent → children implicit access. If the user has the parent
  // ("accounting"), they implicitly have all child page IDs
  // (acct_opening, acct_coa, …) too. Without this, clicking a child
  // in the sidebar sets page to e.g. "acct_coa" but safePage filters
  // it out (falling back to the first allowed page) because the
  // child id isn't in the allowedPages list. Mirrors the sidebar
  // filter logic so what's shown matches what's reachable.
  const allowedPages = (() => {
    const set = new Set(baseAllowedPages);
    for (const n of ALL_NAV) {
      if (n.children && set.has(n.id)) {
        for (const c of n.children) set.add(c.id);
      }
    }
    return Array.from(set);
  })();
  const adminNav = userRole === "tenant"
    ? TENANT_NAV
    : ALL_NAV.filter(n => allowedPages.includes(n.id) || (n.children && n.children.some(c => allowedPages.includes(c.id)))).map(n => {
        if (!n.children) return n;
        // If the user has access to the parent (e.g. "accounting"),
        // grant access to all sub-pages by default. Some custom_pages
        // rows were saved before the sub-page list existed, so they
        // include only the parent — and without this fallback the
        // sidebar dropdown renders empty for those users.
        const parentAllowed = allowedPages.includes(n.id);
        const filteredChildren = n.children.filter(c => parentAllowed || allowedPages.includes(c.id));
        return { ...n, children: filteredChildren };
      });

  // Owner-admins (created their own company) get full app access
  // Only force owner_portal for owners invited into a PM's company
  const effectiveRole = userRole || companyRole || "office_assistant";
  const safePage = allowedPages.includes(page) ? page : allowedPages[0];
  // Tenants land on tenant_overview by default (sidebar nav drives the
  // rest). Legacy "tenant_portal" page hash still resolves to the
  // overview tab. Owners (non-admin in this company) still go to
  // owner_portal as a single page for now.
  const effectivePage = effectiveRole === "tenant"
    ? (page && page.startsWith("tenant_") && page !== "tenant_portal" ? page : "tenant_overview")
    : (effectiveRole === "owner" && companyRole !== "admin") ? "owner_portal" : safePage;
  const Page = pageComponents[effectivePage] || Dashboard;

  return (
  <div className="flex h-dvh safe-y safe-x bg-surface-muted font-inter overflow-hidden">
  {/* Sidebar */}
  <div className={`${sidebarOpen ? "flex" : "hidden"} md:flex flex-col w-56 bg-white/80 backdrop-blur-md border-r border-brand-50 z-50 fixed md:relative h-full safe-y`}>
  <div className="px-5 py-4 border-b border-brand-50">
  <div className="flex items-center gap-2">
  <div className="w-8 h-8 bg-brand-600 rounded-lg flex items-center justify-center shadow-lg shadow-brand-200">
  <span className="material-icons-outlined text-white text-sm">domain</span>
  </div>
  <span className="font-manrope font-extrabold text-lg tracking-tight text-brand-900">Housify</span>
  </div>
  {activeCompany && (
  <div className="flex items-center justify-between mt-2">
  <div className="flex items-center gap-1.5 min-w-0">
  <span className="w-5 h-5 rounded-lg bg-brand-100 flex items-center justify-center text-brand-700 text-xs font-bold shrink-0">{activeCompany.name[0]}</span>
  <span className="text-xs text-neutral-500 truncate font-medium">{activeCompany.name}</span>
  </div>
  {userRole !== "tenant" && <TextLink tone="neutral" size="xs" underline={false} onClick={() => { setSidebarOpen(false); switchCompany(); }}  title="Switch Company" className="shrink-0 ml-1"><span className="material-icons-outlined text-sm">swap_horiz</span></TextLink>}
  </div>
  )}
  </div>
  <nav className="flex-1 py-3 px-2 overflow-y-auto">
  {adminNav.map(n => {
  const childIds = (n.children || []).map(c => c.id);
  const isParentActive = page === n.id || childIds.includes(page);
  const isExpanded = expandedNav.has(n.id);
  return (
  <div key={n.id}>
  <div className={`flex items-center rounded-2xl mb-0.5 transition-all ${isParentActive ? "bg-brand-50 text-brand-700 font-semibold" : "text-neutral-500 hover:bg-brand-50/50 hover:text-neutral-700"}`}>
  <button onClick={() => { setPage(n.id); setSidebarOpen(false); }}
  className="flex-1 flex items-center gap-3 px-3 py-2.5 text-sm text-left">
  <span className="material-icons-outlined text-lg">{n.icon}</span><span className="flex-1">{n.label}</span>
  {n.id === "messages" && unreadMessages > 0 && (
  <span className="bg-danger-500 text-white rounded-full text-[10px] font-bold px-1.5 py-0.5 min-w-[18px] text-center">{unreadMessages > 9 ? "9+" : unreadMessages}</span>
  )}
  {n.id === "tasks" && pendingTasksCount > 0 && (
  <span className="bg-warn-500 text-white rounded-full text-[10px] font-bold px-1.5 py-0.5 min-w-[18px] text-center">{pendingTasksCount > 99 ? "99+" : pendingTasksCount}</span>
  )}
  </button>
  {n.children && <button onClick={(e) => { e.stopPropagation(); setExpandedNav(s => { const next = new Set(s); if (next.has(n.id)) next.delete(n.id); else next.add(n.id); return next; }); }}
  className="px-2 py-2.5 text-neutral-400 hover:text-neutral-700">
  <span className={`material-icons-outlined text-sm transition-transform ${isExpanded ? "rotate-180" : ""}`}>expand_more</span>
  </button>}
  </div>
  {n.children && isExpanded && n.children.map(c => (
  <button key={c.id} onClick={() => { setPage(c.id); setSidebarOpen(false); }}
  className={`w-full flex items-center gap-3 pl-9 pr-3 py-2 text-xs text-left transition-all rounded-xl mb-0.5 ${page === c.id ? "bg-brand-50 text-brand-700 font-semibold" : "text-neutral-400 hover:bg-brand-50/50 hover:text-neutral-600"}`}>
  <span className="material-icons-outlined text-base">{c.icon}</span>{c.label}
  </button>
  ))}
  </div>
  );
  })}
  </nav>
  </div>

  {/* Main Content */}
  <div className="flex-1 flex flex-col min-w-0">
  <header className="bg-white/80 backdrop-blur-md border-b border-brand-50 px-4 py-3 flex items-center gap-3 relative z-40">
  <button className="md:hidden text-neutral-400 hover:text-neutral-600 transition-colors" onClick={() => setSidebarOpen(!sidebarOpen)}><span className="material-icons-outlined">menu</span></button>
  {/* Active company name — more useful at a glance than the current
      page title (which is redundant with the selected sidebar item and
      the page's own H1). On small screens we truncate so long company
      names don't push the avatar + bell off-screen. Falls back to the
      page label if no company is active yet. */}
  <div className="flex-1 min-w-0 text-sm font-semibold text-neutral-700 truncate">
  {activeCompany?.name || (effectivePage || page).replace(/_/g, " ")}
  </div>
  <div className="relative">
  <button onClick={() => setShowUserMenu(!showUserMenu)} className={`flex items-center gap-2 px-2.5 py-1.5 rounded-2xl hover:bg-brand-50 transition-colors ${showUserMenu ? "bg-brand-50" : ""}`}>
  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold ${ROLES[userRole]?.color || "bg-brand-600"}`}>{userProfile?.name?.[0]?.toUpperCase() || "U"}</div>
  <span className="hidden md:inline text-xs font-semibold text-neutral-700">{userProfile?.name || currentUser?.email?.split("@")[0] || "User"}</span>
  <span className="material-icons-outlined text-sm text-neutral-400">expand_more</span>
  </button>
  {showUserMenu && <>
  {/* Header dropdown must sit above page-level gradients + backdrop-blur
      cards that establish their own stacking context (e.g. the tenant
      portal's purple banner was partially eclipsing the menu at z-40). */}
  <div className="fixed inset-0 z-[90]" onClick={() => setShowUserMenu(false)} />
  <div className="absolute right-0 top-full mt-1 bg-white border border-neutral-200 rounded-xl shadow-lg py-1 w-48 z-[95]">
    <button onClick={() => { setShowUserMenu(false); setShowUserProfile(true); }} className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-neutral-700 hover:bg-brand-50 text-left"><span className="material-icons-outlined text-base">person</span>Profile</button>
    {userRole !== "tenant" && <button onClick={() => { setShowUserMenu(false); switchCompany(); }} className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-neutral-700 hover:bg-brand-50 text-left"><span className="material-icons-outlined text-base">swap_horiz</span>Switch Company</button>}
    {userRole !== "tenant" && <button onClick={() => { setShowUserMenu(false); setPage("admin"); }} className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-neutral-700 hover:bg-brand-50 text-left"><span className="material-icons-outlined text-base">settings</span>Settings</button>}
    <div className="border-t border-neutral-100 my-1" />
    <button onClick={() => { setShowUserMenu(false); handleLogout(); }} className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-danger-500 hover:bg-danger-50 text-left"><span className="material-icons-outlined text-base">logout</span>Logout</button>
  </div>
  </>}
  </div>
  <div className="relative">
  <button onClick={() => {
  setShowNotifications(!showNotifications);
  // Mark all as read in DB
  if (!showNotifications && activeCompany?.id && unreadCount > 0) {
  supabase.from("notification_inbox").update({ read: true })
  .eq("company_id", activeCompany.id).eq("read", false)
  .ilike("recipient_email", currentUser?.email || "none")
  .then(() => {});
  setUnreadCount(0);
  setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  }
  }} className="relative w-10 h-10 rounded-full bg-brand-50 flex items-center justify-center text-brand-600 hover:bg-brand-100 transition-colors">
  <span className="material-icons-outlined">notifications</span>
  {unreadCount > 0 && (
  <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-danger-500 rounded-full ring-2 ring-white"></span>
  )}
  </button>
  {showNotifications && (
  <div className="absolute right-0 top-12 w-80 max-w-[calc(100vw-2rem)] bg-white rounded-3xl shadow-card border border-brand-50 z-50">
  <div className="px-4 py-3 border-b border-brand-50 flex justify-between items-center">
  <span className="font-manrope font-bold text-neutral-700 text-sm">Notifications</span>
  <div className="flex gap-2">
  <TextLink tone="brand" size="xs" onClick={() => { setPage("notifications"); setShowNotifications(false); }}>View All</TextLink>
  <TextLink tone="neutral" size="xs" underline={false} onClick={() => { setNotifications([]); setShowNotifications(false); }}>Clear</TextLink>
  </div>
  </div>
  <div className="max-h-72 overflow-y-auto">
  {notifications.length === 0 ? (
  <div className="px-4 py-6 text-center text-neutral-400 text-sm">No notifications yet</div>
  ) : (
  notifications.map((n, idx) => (
  <div key={n.id || n.dbId || `notif_${idx}`} className={"px-4 py-3 border-b border-brand-50/50 hover:bg-brand-50/30 flex items-start gap-2 transition-colors " + (!n.read ? "bg-brand-50/40" : "")}>
  <span className="text-lg">{String(n.icon || "\u{1F4CC}")}</span>
  <div className="flex-1">
  <div className="text-sm text-neutral-700">{String(n.message || "")}</div>
  <div className="text-xs text-neutral-400 mt-0.5">{String(n.time || "")}{n.date ? " \u00B7 " + String(n.date) : ""}</div>
  </div>
  </div>
  ))
  )}
  </div>
  </div>
  )}
  </div>
  </header>

  {/* overscroll-behavior-y: contain stops iOS Safari's rubber-band at
      the scroll container's edge instead of propagating it up the flex
      column — without this, pulling down on the dashboard dragged the
      header with it while the fixed sidebar stayed put, making them
      look desynced. PullToRefresh re-adds the "slide down to reload"
      gesture that PWAs lose in standalone mode. */}
  <PullToRefresh
    scrollRef={mainScrollRef}
    onRefresh={() => { window.location.reload(); }}
    className="flex-1 flex flex-col min-h-0"
  >
  {/*
    Messages-style pages need a flex-fill chain (no main-level scroll,
    no main-level padding) so the thread inside can have a properly
    bounded height. Without this, the messages container has nowhere
    to size against, the thread is unbounded, the composer falls off
    the bottom, and PullToRefresh intercepts thread scroll because
    isInsideNestedScroll requires scrollHeight > clientHeight (which
    a thread of unbounded height never satisfies).
    Mobile-only: on desktop the original scroll-with-padding layout
    still works correctly because the desktop messages container has
    a literal h-[calc(100dvh-180px)].
  */}
  {(() => {
    const isMessagesLikePage = effectivePage === "messages" || effectivePage === "tenant_messages";
    const mainCls = isMessagesLikePage
      ? "flex-1 flex flex-col min-h-0 overflow-hidden md:overflow-y-auto md:overscroll-contain md:p-6"
      : "flex-1 overflow-y-auto overscroll-contain p-4 md:p-6";
    return (
  <main ref={mainScrollRef} className={mainCls}>
  {missingRPCs.length > 0 && userRole === "admin" && (
  <div className="bg-warn-50 border border-warn-200 rounded-xl px-4 py-3 mb-4">
  <div className="text-sm font-semibold text-warn-800">{"\u26A0\uFE0F"} Missing Database Functions</div>
  <div className="text-xs text-warn-600 mt-1">The following RPCs need to be deployed: {missingRPCs.join(", ")}. Some features may not work until these are installed.</div>
  </div>
  )}
  {userRole === "admin" && activeCompany && <PendingRequestsPanel companyId={activeCompany.id} addNotification={addNotification} />}
  {userRole === "admin" && activeCompany && <PendingPMAssignments companyId={activeCompany.id} addNotification={addNotification} />}
  <ErrorBoundary key={effectivePage + "-" + activeCompany.id}>
  <Page
  key={activeCompany.id}
  addNotification={addNotification}
  notifications={notifications}
  setPage={setPage}
  initialAction={pageAction}
  currentUser={currentUser}
  userRole={userRole}
  userProfile={userProfile}
  companyId={activeCompany.id}
  activeCompany={activeCompany}
  showToast={showToast}
  showConfirm={showConfirm}
  companySettings={companySettings}
  setCompanySettings={setCompanySettings}
  />
  </ErrorBoundary>
  </main>
    );
  })()}
  </PullToRefresh>
  </div>

  {/* Mobile Bottom Nav */}
  {/* Bottom nav removed — mobile navigation via sidebar hamburger menu */}

  {sidebarOpen && <div className="fixed inset-0 bg-black/20 z-40 md:hidden" onClick={() => setSidebarOpen(false)} />}
  {showNotifications && <div className="fixed inset-0 z-30" onClick={() => setShowNotifications(false)} />}
  {showUserProfile && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
  <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">
  <UserProfile currentUser={currentUser} onBack={() => setShowUserProfile(false)} showToast={showToast} showConfirm={showConfirm} />
  </div>
  </div>
  )}
  <ToastContainer toasts={toasts} removeToast={removeToast} />
  <ConfirmModal config={confirmConfig} onConfirm={handleConfirm} onCancel={handleCancel} />
  </div>
  );
}

export default function App() {
  // Intercept the public signing route before any auth bootstrapping so anon
  // signers never trigger company/role lookups or landing redirects.
  const path = typeof window !== "undefined" ? window.location.pathname : "";
  if (path.startsWith("/sign/")) {
    const token = path.slice("/sign/".length).split(/[?#]/)[0];
    return <ErrorBoundary><PublicSignPage token={token} /></ErrorBoundary>;
  }
  return <ErrorBoundary><AppInner /></ErrorBoundary>;
}
