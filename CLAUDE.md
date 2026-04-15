# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

- **Multi-file React SPA** — `src/App.js` (~800 lines, thin router) + 8 utils in `src/utils/` + 23 components in `src/components/`, bootstrapped with create-react-app (via CRACO)
- **Backend:** Supabase (PostgreSQL + Auth + Storage + RLS + RPCs)
- **Hosting:** Vercel (https://rental-manager-one.vercel.app)
- **Payments:** Stripe
- **Banking:** Teller.io (mTLS) — Vercel API routes in `/api/`, NOT Supabase Edge Functions
- **Styling:** Tailwind CSS v4 (via PostCSS)
- **Excel Export:** ExcelJS library for .xlsx with formulas, sections, formatting
- **Supabase client:** initialized in `src/supabase.js`, imported as `{ supabase }`

## Build & Dev Commands

```bash
npm start              # Dev server (localhost:3000)
npm run build          # Production build
vercel --prod          # Deploy to production
npx supabase db push   # Push DB migrations
```

## Test Commands

Tests live in a **separate `tests/` directory** with its own `package.json` and `node_modules`. Always `cd tests/` first.

```bash
cd tests && npm test                                  # Run ALL tests (infra + schema + data + errors + bank + e2e)
cd tests && node data-layer.test.js                   # 298 data-layer tests
cd tests && node bank-transactions.test.js            # 147 bank/teller/export tests
cd tests && node error-management.test.js             # 41 error management tests
cd tests && npx playwright test                       # 35 E2E browser specs (headless)
cd tests && npx playwright test --headed              # E2E with visible browser
cd tests && npx playwright test e2e/35-bank-management.spec.js  # Bank management E2E only
cd tests && npx playwright show-report                # View HTML test report
```

Tests use `dotenv` to load Supabase credentials from `tests/.env` (not committed — do not share).

**Test conventions:**
- Unit tests: custom `assert()` function, no framework, direct Supabase queries
- E2E tests: Playwright, shared `helpers.js` (login, navigateTo, goToPage)
- New bank/accounting features MUST add tests to `bank-transactions.test.js` and/or E2E specs

## File Structure

```
src/
  App.js              → Thin router (~800 lines): imports, Sentry, ROLES, NAV, pageComponents, AppInner
  supabase.js         → Supabase client
  ui.js               → Reusable UI primitives (Btn, Card, Input, etc.)
  utils/
    helpers.js         → Pure functions: safeNum, formatLocalDate, formatCurrency, escapeFilterValue, etc.
    errors.js          → PM_ERRORS catalog, pmError(), reportError(), logErrorToSupabase()
    guards.js          → guardSubmit/Release, requireCompanyId
    encryption.js      → AES-256-GCM credential encryption
    accounting.js      → safeLedgerInsert, autoPostJournalEntry, resolveAccountId, recurring entries
    audit.js           → logAudit with sanitization
    notifications.js   → queueNotification (email + push)
    company.js         → companyQuery/Insert/Upsert, RPC health check, data integrity checks
  components/
    shared.js          → Badge, StatCard, Spinner, Modal, ToastContainer, ConfirmModal, DocUploadModal, etc.
    Accounting.js      → Accounting + all Acct* sub-components + report helpers + CSV import
    Banking.js         → BankTransactions
    Properties.js      → Properties + PropertySetupWizard
    Tenants.js         → Tenants
    (+ 18 more page components: Dashboard, Payments, Maintenance, Documents, etc.)
```

## Security Patterns

- **`escapeFilterValue(val)`** — MUST be used for all `.or()`, `.ilike()`, `.like()` calls with user/dynamic input
- **`tenant_id` over `tenant.name`** — always prefer ID-based queries to prevent cross-tenant data leaks
- **File uploads** — MIME type whitelist + magic bytes validation + size limit. Only `text/plain` and `text/csv` allowed for text types
- **DOMPurify** — all `dangerouslySetInnerHTML` content goes through `DOMPurify.sanitize()` via `sanitizeTemplateHtml()`
- **DB unique index** — `idx_je_company_reference_unique` on `(company_id, reference)` prevents double-posting
- **Autopay/lease operations** — always scope by BOTH tenant name AND property to prevent same-name collisions

## Key Code Patterns

- **Company-scoped queries:** Use `companyQuery()`, `companyInsert()`, `companyUpsert()` helpers instead of raw `supabase.from()` — they auto-inject `company_id`
- **`requireCompanyId()`** — fail-closed guard; throws if companyId missing
- **`safeNum(val)`** — wraps `Number()` to return 0 instead of NaN
- **`parseLocalDate(str)` / `formatLocalDate(date)`** — parse "YYYY-MM-DD" as local date (avoids UTC timezone day-shift)
- **`logAudit(action, module, details, recordId, userEmail, userRole, companyId)`** — logs every action to `audit_trail` table
- **`autoPostJournalEntry({...})`** — all modules auto-post double-entry DR/CR journal entries to GL; uses RPC `create_journal_entry` with client-side fallback
- **`safeLedgerInsert()` / `safeWrite()`** — DB write wrappers that log errors instead of silently failing
- **Smart AR Settlement:** payments auto-detect and settle accruals
- **Case-insensitive email matching:** always use `.ilike()` not `.eq()` for email lookups

## Database Tables (Supabase)

properties, tenants, payments, work_orders, vendors, owners,
acct_accounts, acct_journal_entries, acct_journal_lines, journal_entries,
leases, lease_templates, lease_signatures, utilities, documents,
audit_trail, app_users, autopay_schedules, late_fee_rules,
owner_statements, owner_distributions, vendor_invoices,
notification_templates, ledger_entries

## Accounting Accounts (acct_accounts)

1000 Checking, 1100 AR, 2100 Security Deposits, 2200 Owner Dist,
4000 Rental Income, 4010 Late Fees, 4100 Other Income,
4200 Mgmt Fee Income, 5300 Repairs, 5400 Utilities

## App Modules (17 + portals)

Dashboard, Properties, Tenants, Payments, Maintenance, Utilities,
Accounting, Documents, Inspections, Autopay, Late Fees, Audit Trail,
Leases, Vendors, Owners, Notifications, Team & Roles
Plus: Tenant Portal (6 tabs), Owner Portal (4 tabs)

## Vercel API Routes (`/api/`)

- `api/teller-save-enrollment.js` — saves Teller enrollment, fetches accounts via mTLS, creates GL accounts + bank feeds
- `api/teller-sync-transactions.js` — syncs transactions with dedup, supports CRON and manual sync
- **Why Vercel, not Supabase Edge Functions:** Deno Deploy doesn't support `Deno.createHttpClient` for mTLS certificates. Node.js `https.request` does.
- **Env vars required:** `SUPABASE_SERVICE_ROLE_KEY`, `TELLER_CERT_B64`, `TELLER_KEY_B64`

## Banking Tables

bank_connection, bank_account_feed, bank_feed_transaction,
bank_rules, bank_rule_conditions, plaid_sync_event

## CSP Notes (vercel.json)

Teller Connect requires: `script-src cdn.teller.io`, `connect-src api.teller.io wss://teller.io wss://*.teller.io`, `frame-src cdn.teller.io teller.io *.teller.io`

## Important Constraints

- All DB writes must include `company_id` — multi-tenant by design
- Do not run destructive database commands without explicit confirmation
- Do not force push to main
- Use soft-delete/archive patterns, never hard-delete production data
- Always handle errors in async Supabase operations
- Teller API routes MUST be Vercel serverless functions (need mTLS), never Supabase Edge Functions
- New reports MUST include an `exportExcel` case with formulas, sections, and formatting
