# Housify Code Split — Claude Code Specification

## MISSION

Split `src/App.js` (21,654 lines) into ~18 module files. Zero functionality changes. Zero new features. The app must behave identically before and after. Every import/export must be verified. Every function must end up in exactly one file.

## CRITICAL RULES

1. **Do NOT rewrite any logic.** Copy functions exactly as they are. The only changes allowed are: adding `import` statements, adding `export` keywords, and removing code that moved to another file.
2. **Do NOT rename any function, variable, or component.** Names stay identical.
3. **Do NOT change any props, state, or data flow.** The component tree stays identical.
4. **Build and test after EVERY file extraction.** Run `npm run build` after each file is created. If it fails, fix before moving to the next file.
5. **Keep `src/App.js` as the router.** It imports all page components and renders them via `pageComponents` map.
6. **Do NOT touch `src/ui.js` or `src/supabase.js`.** They are already correct.
7. **Do NOT modify `api/`, `public/`, `tests/`, or any config files.**

## FILE STRUCTURE (target)

```
src/
  App.js              → Thin router (~300 lines): imports, pageComponents map, AppInner, App export
  supabase.js         → (unchanged) Supabase client
  ui.js               → (unchanged) Reusable UI components
  utils/
    helpers.js         → Pure functions: safeNum, parseLocalDate, formatLocalDate, shortId, pickColor,
                         generateId, formatPersonName, buildNameFields, parseNameParts, formatCurrency,
                         formatPhoneInput, sanitizeFileName, exportToCSV, buildAddress, escapeHtml,
                         escapeFilterValue, sanitizeForPrint, isValidEmail, normalizeEmail,
                         US_STATES, STATE_NAMES, CLASS_COLORS, ALLOWED_DOC_TYPES, ALLOWED_DOC_EXTENSIONS,
                         statusColors, priorityColors
    errors.js          → PM_ERRORS, detectInfrastructureCode, logErrorToSupabase, pmError, reportError
    guards.js          → _submitGuards, guardSubmit, guardRelease, guarded, requireCompanyId
    encryption.js      → _MASTER_KEY, _deriveKey, encryptCredential, decryptCredential
    accounting.js      → safeLedgerInsert, atomicPostJEAndLedger, postAccountingTransaction,
                         checkPeriodLock, autoPostJournalEntry, checkAccrualExists,
                         autoOwnerDistribution, getPropertyClassId, resolveAccountId,
                         getOrCreateTenantAR, autoPostRentCharges, autoPostRecurringEntries,
                         _classIdCache, _acctIdCache, _acctCodeToName, _tenantArCache,
                         lookupZip, _zipCache
    audit.js           → AUDIT_ACTIONS, AUDIT_MODULES, logAudit
    notifications.js   → queueNotification
    company.js         → companyQuery, companyInsert, companyUpsert, checkRPCHealth,
                         runDataIntegrityChecks
  components/
    shared.js          → Badge, StatCard, Spinner, Modal, ToastContainer, ConfirmModal,
                         ErrorBoundary, PropertyDropdown, TenantSelect, PropertySelect,
                         RecurringEntryModal, DocUploadModal, formatAllTenants,
                         generatePaymentReceipt
    LandingPage.js     → LandingPage
    LoginPage.js       → LoginPage
    Dashboard.js       → Dashboard
    Properties.js      → Properties, PropertySetupWizard
    Tenants.js         → Tenants
    Payments.js        → Payments, Autopay
    Maintenance.js     → Maintenance, Inspections, VendorManagement
    Accounting.js      → Accounting, AcctChartOfAccounts, AcctJournalEntries, AcctClassTracking,
                         AcctReports, AcctBankReconciliation, AcctModal, AcctTypeBadge,
                         AcctStatusBadge, AccountLedgerView, RecurringJournalEntries,
                         getPLData, getBalanceSheetData, getPeriodDates, acctFmt,
                         calcAllBalances, nextAccountCode, validateJE, getClassReport,
                         buildBalanceIndex, balanceFromIndex, getAccountTypes, getAccountSubtypes,
                         csvParseText, csvDetectFormat, csvParseAmount, csvParseDate,
                         csvBuildFingerprint (and AcctBankImport if it exists)
    Banking.js         → BankTransactions (and any bank-related sub-components)
    Leases.js          → LeaseManagement, ESignatureModal
    Owners.js          → OwnerManagement, OwnerPortal, OwnerMaintenanceView
    TenantPortal.js    → TenantPortal
    Utilities.js       → Utilities
    Documents.js       → Documents, DocumentBuilder
    Notifications.js   → EmailNotifications
    Admin.js           → RoleManagement, AuditTrail, ArchivePage, ArchivedItems,
                         ErrorLogDashboard, TasksAndApprovals, UserProfile
    Lifecycle.js       → MoveOutWizard, EvictionWorkflow
    HOA.js             → HOAPayments
    Loans.js           → Loans
    Insurance.js       → InsuranceTracker
    LateFees.js        → LateFees
    CompanySelector.js → CompanySelector, PendingRequestsPanel, PendingPMAssignments
```

## EXECUTION ORDER

Extract files in this exact order. Each step must build successfully before proceeding.

### Phase 1: Utils (no React, no JSX — pure JS)

**Step 1: `src/utils/helpers.js`**
- Move all pure functions listed above (safeNum through sanitizeForPrint)
- Move all constants (US_STATES, STATE_NAMES, CLASS_COLORS, etc.)
- Export every function and constant as named exports
- In App.js: `import { safeNum, parseLocalDate, ... } from "./utils/helpers"`
- Run `npm run build` — fix any missing imports

**Step 2: `src/utils/errors.js`**
- Move PM_ERRORS, detectInfrastructureCode, logErrorToSupabase, pmError, reportError
- These import from: `supabase.js` (for logErrorToSupabase), `helpers.js` (if any)
- Export all as named exports
- Run `npm run build`

**Step 3: `src/utils/guards.js`**
- Move _submitGuards, guardSubmit, guardRelease, guarded, requireCompanyId
- Also move the setInterval cleanup timer
- Import pmError from `./errors`
- Run `npm run build`

**Step 4: `src/utils/encryption.js`**
- Move _MASTER_KEY, _deriveKey, encryptCredential, decryptCredential
- Pure crypto, no other imports needed
- Run `npm run build`

**Step 5: `src/utils/audit.js`**
- Move AUDIT_ACTIONS, AUDIT_MODULES, logAudit
- Imports: supabase, normalizeEmail from helpers, pmError from errors
- Run `npm run build`

**Step 6: `src/utils/notifications.js`**
- Move queueNotification
- Imports: supabase
- Run `npm run build`

**Step 7: `src/utils/company.js`**
- Move companyQuery, companyInsert, companyUpsert, checkRPCHealth, runDataIntegrityChecks
- Imports: supabase, pmError
- Run `npm run build`

**Step 8: `src/utils/accounting.js`**
- Move all accounting helpers: safeLedgerInsert, atomicPostJEAndLedger, postAccountingTransaction,
  checkPeriodLock, autoPostJournalEntry, checkAccrualExists, autoOwnerDistribution,
  getPropertyClassId, resolveAccountId, getOrCreateTenantAR, autoPostRentCharges,
  autoPostRecurringEntries, lookupZip
- Move caches: _classIdCache, _acctIdCache, _acctCodeToName, _tenantArCache, _zipCache
- Imports: supabase, safeNum, parseLocalDate, formatLocalDate, shortId from helpers,
  pmError from errors, logAudit from audit, queueNotification from notifications
- Run `npm run build`

### Phase 2: Shared Components

**Step 9: `src/components/shared.js`**
- Move: Badge, StatCard, Spinner, Modal, ToastContainer, ConfirmModal, ErrorBoundary,
  PropertyDropdown, TenantSelect, PropertySelect, RecurringEntryModal, DocUploadModal,
  formatAllTenants, generatePaymentReceipt
- Imports: React, supabase, helpers, errors, ui.js components as needed
- Run `npm run build`

### Phase 3: Page Components (one at a time, build after each)

Extract in this order (largest/most independent first):

**Step 10:** `src/components/Banking.js` — BankTransactions (2117 lines, self-contained)
**Step 11:** `src/components/Accounting.js` — All Acct* components + helpers (2956 lines)
**Step 12:** `src/components/Properties.js` — Properties + PropertySetupWizard (2939 lines)
**Step 13:** `src/components/Documents.js` — Documents + DocumentBuilder (1611 lines)
**Step 14:** `src/components/Tenants.js` — Tenants (1428 lines)
**Step 15:** `src/components/Leases.js` — LeaseManagement + ESignatureModal (776 lines)
**Step 16:** `src/components/TenantPortal.js` — TenantPortal (511 lines)
**Step 17:** `src/components/Owners.js` — OwnerManagement + OwnerPortal + OwnerMaintenanceView (726 lines)
**Step 18:** `src/components/Lifecycle.js` — MoveOutWizard + EvictionWorkflow (834 lines)
**Step 19:** `src/components/Maintenance.js` — Maintenance + Inspections + VendorManagement (943 lines)
**Step 20:** `src/components/Utilities.js` — Utilities (497 lines)
**Step 21:** `src/components/Admin.js` — RoleManagement, AuditTrail, ArchivePage, ArchivedItems, ErrorLogDashboard, TasksAndApprovals, UserProfile
**Step 22:** `src/components/Notifications.js` — EmailNotifications (321 lines)
**Step 23:** `src/components/CompanySelector.js` — CompanySelector + PendingRequestsPanel + PendingPMAssignments
**Step 24:** `src/components/Dashboard.js` — Dashboard
**Step 25:** `src/components/LoginPage.js` + `src/components/LandingPage.js`
**Step 26:** `src/components/Payments.js` — Payments + Autopay
**Step 27:** `src/components/HOA.js`, `src/components/Loans.js`, `src/components/Insurance.js`, `src/components/LateFees.js`

### Phase 4: Final App.js

**Step 28:** Clean up `src/App.js`
- Should contain ONLY:
  - Imports from all module files
  - `pageComponents` map
  - `AppInner` function (state management, routing, sidebar, header, bottom nav)
  - `App` wrapper with ErrorBoundary
  - `export default App`
- Target: ~300-400 lines
- Run `npm run build`
- Run full test suite: `cd tests && npm test`

## VERIFICATION CHECKLIST (after each step)

```bash
# 1. Build passes
npm run build

# 2. No duplicate exports (same function in two files)
grep -r "export.*function FUNCNAME" src/ | wc -l  # should be 1

# 3. No orphaned imports (importing from old location)
grep -r "from.*App" src/components/ src/utils/  # should be 0 (nothing imports from App.js)

# 4. App.js line count decreasing
wc -l src/App.js

# 5. Total line count stable (±5 lines for imports)
find src/ -name "*.js" | xargs wc -l | tail -1
```

## IMPORT PATTERN

Every extracted file follows this pattern:

```javascript
// src/components/Properties.js
import React, { useState, useEffect, useRef } from "react";
import { supabase } from "../supabase";
import { Btn, Card, Input, Select, FormField, TabBar, Badge as UIBadge, PageHeader, EmptyState } from "../ui";
import { safeNum, formatLocalDate, buildAddress, formatCurrency, shortId, ... } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { autoPostJournalEntry, getPropertyClassId } from "../utils/accounting";
import { queueNotification } from "../utils/notifications";
import { companyQuery } from "../utils/company";
import { Modal, Spinner, PropertySelect, Badge, StatCard } from "./shared";

export function Properties({ addNotification, showToast, showConfirm, ... }) {
  // ... exact same code ...
}

export function PropertySetupWizard({ ... }) {
  // ... exact same code ...
}
```

## KNOWN GOTCHAS

1. **`Badge` exists in BOTH `ui.js` AND `App.js`.** The App.js Badge is simpler and used internally. Import as `{ Badge as UIBadge }` from ui.js if needed, keep the local Badge in shared.js.
2. **`StatCard` exists in BOTH `ui.js` AND `App.js`.** Same pattern — the App.js version is the one used by page components.
3. **Circular dependency risk:** `accounting.js` helpers call `queueNotification`, and some components call both. Keep the dependency graph one-directional: helpers → utils → components (never backwards).
4. **The `supabase` import:** Every file that does DB queries needs `import { supabase } from "../supabase"` (or `"./supabase"` from utils/).
5. **React hooks:** Only files with React components need `import React, { useState, ... }`. Pure util files do NOT import React.
6. **`DOMPurify` and `ExcelJS`:** Only imported in files that use them (Documents.js, Accounting.js reports).
7. **`Sentry`:** Only in App.js (initialization) and errors.js (if it reports there).
8. **Accounting sub-components** (AcctReports, AcctChartOfAccounts, etc.) receive data via props from the parent `Accounting` component. They must stay in the same file or the parent must pass all data through.
9. **`showToast` and `showConfirm`:** These are defined in AppInner and passed as props. Every component that uses them must receive them as props — they cannot be imported.
10. **`pageComponents` map in App.js** must import every page component and map them by ID.

## ABORT CONDITIONS

Stop and ask for help if:
- `npm run build` fails and you cannot fix it within 3 attempts
- A function needs to be in two files simultaneously (circular dependency)
- You need to change any function's signature or behavior
- Line count changes by more than 50 lines (means logic was added or removed)
- Any test fails that was passing before

## SUCCESS CRITERIA

- [ ] `npm run build` succeeds with zero warnings related to the refactor
- [ ] `src/App.js` is under 500 lines
- [ ] Every extracted file has zero TODO comments added by the refactor
- [ ] `find src/ -name "*.js" | xargs wc -l | tail -1` shows ±50 of 21,654
- [ ] All 298 data-layer tests pass
- [ ] All 35 E2E tests pass
- [ ] The running app looks and behaves identically to before the refactor
