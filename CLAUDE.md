# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

- **Multi-file React SPA** — `src/App.js` (~800 lines, thin router) + 8 utils in `src/utils/` + 23 components in `src/components/`, bootstrapped with create-react-app (via CRACO)
- **Backend:** Supabase (PostgreSQL + Auth + Storage + RLS + RPCs)
- **Hosting:** Vercel — production `https://housify365.com`, test `https://test.housify365.com` (`staging` branch, separate Supabase project). Schema and data changes go to test first; see `ENVIRONMENTS.md`
- **Payments:** Stripe
- **Banking:** Teller.io (mTLS) — Vercel API routes in `/api/`, NOT Supabase Edge Functions
- **Styling:** Tailwind CSS v4 (via PostCSS)
- **Excel Export:** ExcelJS library for .xlsx with formulas, sections, formatting
- **Supabase client:** initialized in `src/supabase.js`, imported as `{ supabase }`

## Build & Dev Commands

```bash
npm start                # Dev server (localhost:3000)
npm run build            # Production build
git push origin staging  # ← DEFAULT. Deploys test.housify365.com (own DB, Sahil LLC only)
git push origin main     # PRODUCTION. Only after Sahil has reviewed on the test site.
npx supabase db push     # Push DB migrations
```

## Where work goes — read this before pushing anything

**`staging` is the default target for every change.** `main` auto-deploys to
housify365.com, which is Sahil's live books. The sequence is:

1. commit and `git push origin staging`
2. tell Sahil it is on `test.housify365.com`
3. he looks at it and says to ship it
4. `git push origin main` — and only then

This applies to database work too. Migrations go to the test project
(`vpeewlplgxthckpidhxo`) first and to production (`hoymytpyaudjvsgiiibn`) only
after the same approval. `scripts/clone-prod-to-test.sh` refreshes test data.

On 2026-09-04 twenty-two commits went straight to `main` in a single session,
including nine bug fixes Sahil never saw on the test site first — the day that
environment was built specifically to prevent exactly that. The fixes were
sound, but "the change was fine" is not the same as "the gate was honoured".
Push to `staging` and wait.

Do not `git checkout` another branch while subagents are editing the working
tree; the checkout aborts on their uncommitted files. Fast-forward the remote
instead: `git push origin main:staging`.

## Test Commands

Tests live in a **separate `tests/` directory** with its own `package.json` and `node_modules`. Always `cd tests/` first.

```bash
cd tests && npm test                                  # Run ALL tests (infra + schema + data + errors + bank + e2e)
cd tests && node data-layer.test.js                   # 298 data-layer tests
cd tests && node bank-transactions.test.js            # 147 bank/teller/export tests
cd tests && node class-integrity.test.js              # acct_classes PK / orphaning guards
cd tests && node shortcuts.test.js                    # keyboard shortcut registry + handlers
cd tests && npm run test:undef                        # undefined identifiers (no-undef + react/jsx-no-undef)
cd tests && npm run test:unit                         # every non-e2e suite — run this before pushing
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
- **Never put `id` in an `.upsert()` payload when `onConflict` names a different unique constraint** — PostgREST compiles it to `ON CONFLICT (...) DO UPDATE SET id = EXCLUDED.id`, which REWRITES the row's primary key and orphans every reference. This silently detached 13,947 journal lines from `acct_classes` on 2026-09-04. Let the column default supply the id. `acct_journal_lines.class_id` and `properties.class_id` now have FKs (`ON UPDATE CASCADE ON DELETE SET NULL`) so it cannot recur; `tests/class-integrity.test.js` guards it
- **Autopay/lease operations** — always scope by BOTH tenant name AND property to prevent same-name collisions
- **RLS: permissive policies are OR'd** — a strict policy does not restrict anything if a looser policy exists for the same command on the same table. `members_manage` correctly allowed only a PENDING self-insert, but `cm_insert` alongside it allowed any self-insert at any role, so anyone could make themselves admin of any company. When auditing, list every policy per (table, command) and read them as a disjunction; adding a tight policy next to a loose one changes nothing
- **Never use `current_user` for caller identity inside a `SECURITY DEFINER` function** — it evaluates to the function's OWNER, not the caller. A guard trigger written as SECURITY DEFINER read `current_user` as `postgres` and waved every request through while looking correct. Use SECURITY INVOKER when the function must know who is calling; keep SECURITY DEFINER only where it needs to bypass RLS. Under PostgREST, an INVOKER function sees `authenticated` for a browser request and `service_role` for the service key
- **An RLS policy that subqueries another RLS-protected table can recurse** — scoping `companies` to your own memberships made it mutually recursive with `company_members`' policy, which subqueries `companies`; every insert failed with "infinite recursion detected in policy". Route cross-table checks through a `SECURITY DEFINER` helper, which bypasses RLS and breaks the cycle. `get_user_company_ids()` and `is_company_creator()` exist for exactly this
- **Undefined identifiers are this repo's most expensive bug class** — a call inside a `try/catch` that swallows the `ReferenceError` fails silently forever. A missing `atomicPostJEAndLedger` import meant no wizard-onboarded tenant's deposit or first month's rent was ever posted, surfacing only as a generic PM-4002. `cd tests && npm run test:undef` (in `test:unit`, and in CI) sweeps for these. It checks **both** `no-undef` and `react/jsx-no-undef` — a bare `no-undef` run does not see JSX component references, which is how a missing `<UserProfile>` import white-screened the company picker undetected
- **`properties.address` is DERIVED**, not set directly — the `sync_addr_ins`/`sync_addr_upd` triggers compute it from `address_line_1/2`, `city`, `state`, `zip` via `compute_property_address()`. To change an address, update the components and call `rename_property_from_components()`, which cascades the new value to tenants, payments, leases, work orders, documents, utilities, journal entries, `acct_classes.name` and `property_setup_wizard`. `properties.short_name` is what reports display

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

## Domain & Email

- **Production domain:** `housify365.com` (DNS on Cloudflare, separate login from other Sigma domains)
- **vercel.json** has 308 redirects: `rental-manager-one.vercel.app/*` and `www.housify365.com/*` → `https://housify365.com/*`
- **CORS allowlist (`api/_cors.js`):** only `housify365.com` + `www.housify365.com` (preview origins still go via `CORS_EXTRA_ORIGINS` / `CORS_VERCEL_TEAM_SLUGS`)
- **Email sender:** `Housify <notifications@housify365.com>` for BOTH worker emails (Resend, via `EMAIL_FROM`) AND Supabase Auth emails (Custom SMTP → Resend in Supabase dashboard)
- **Resend free tier holds ONE domain** — `sigmahousingllc.com` was deleted to add `housify365.com`. To use a second domain, upgrade Resend
- **APP_URL env var** (Vercel production) = `https://housify365.com` — drives template links from the notification worker
- **Inbound mail:** Cloudflare Email Routing on root domain forwards `hello@`, `support@`, `info@`, `notifications@` → `housify365@gmail.com`. Catch-all is OFF. Resend outbound is isolated on `send.housify365.com` subdomain — root MX/SPF do not conflict. DMARC at `_dmarc.housify365.com` is `p=none` (monitor-only).

## Important Constraints

- All DB writes must include `company_id` — multi-tenant by design
- Do not run destructive database commands without explicit confirmation
- Any column holding a reference to another table needs a real FK — without one, nothing prevents silent orphaning
- Do not force push to main
- Use soft-delete/archive patterns, never hard-delete production data
- Always handle errors in async Supabase operations
- Teller API routes MUST be Vercel serverless functions (need mTLS), never Supabase Edge Functions
- New reports MUST include an `exportExcel` case with formulas, sections, and formatting

## Schema Baseline

`supabase/baseline/schema.sql` is the full production schema. The 158 migrations
**cannot rebuild the database** — none of the core tables is created by any of
them; they predate the migration chain, and the first already assumes `payments`
exists. `supabase db push` against an empty project fails. Rebuild from the
baseline instead (verified byte-for-byte identical to production across 4,083
objects). Regenerate it with `pg_dump --schema=public --schema-only --no-owner`
after schema changes reach production — and never with `--no-privileges`, or the
508 GRANTs to anon/authenticated/service_role are lost and PostgREST reads
nothing.
