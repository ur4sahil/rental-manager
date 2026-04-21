# PropManager — Bug Report

**Date**: 2026-04-20
**Scope**: Full-codebase static review of `src/utils/`, `src/components/`, `api/` (≈ 25 kLOC) plus a live browser pass of the production app (login → dashboard). The browser MCP connection dropped repeatedly, so the remaining coverage was done via code review — which catches more concrete bugs per minute than clicking ever will at this scale.
**Environment**: `main @ 3597b62`, production URL `https://rental-manager-one.vercel.app`.
**Auth used**: `admin@propmanager.com` → Sandbox LLC.

Severity key:

- **Critical** — silent money / data corruption, cross-tenant data leak, auth bypass, or financial misstatement.
- **High** — flow breaks, wrong data shown, or guard can be defeated.
- **Medium** — user-visible wrong behavior without data loss.
- **Low** — UX, perf, minor hardening, or latent edge case.

Every finding has `file:line`, a description of the mechanism, a concrete repro, and a suggested fix. Line numbers are against the tip commit above.

---

## Critical

### C-1 · `5300` bare code is posted as "Bad Debt Expense" / "Legal & Eviction Costs" but the DB account is "Repairs & Maintenance"

`src/utils/accounting.js:315` maps `5300 → "Repairs & Maintenance"` in `_acctCodeToName`. `resolveAccountId("5300", …)` returns the UUID of that account regardless of the `account_name` string in the JE line.

Callsites posting **to the same UUID** but labeling the line differently:

- `src/components/Tenants.js:283` — "Bad Debt Expense" on tenant deletion AR write-off.
- `src/components/Lifecycle.js:97` — "Bad Debt Expense" on move-out write-off.
- `src/components/Lifecycle.js:541` — "Legal & Eviction Costs" on eviction expense.

Reports join JE lines to `acct_accounts` on `account_id` and show the account's stored name — so all three flows appear as **Repairs & Maintenance** on the P&L. R&M is inflated; there is no visibility into bad debt or eviction costs.

**Repro**: delete a tenant with a non-zero balance → check `acct_journal_lines.account_id` → it points to "Repairs & Maintenance". Pull P&L → the write-off shows under R&M, not Bad Debt Expense.

**Fix**: either (a) add codes `5500 Bad Debt Expense` and `5610 Legal & Eviction` to `_acctCodeToName` and use those codes at the callsites, or (b) look up the account by *name* when a specific semantic account is required. Never trust that the `account_name` string in the JE line will surface on reports.

---

### C-2 · Archiving one tenant terminates *every* active lease at a multi-unit property

`src/components/Tenants.js:273`:

```js
await supabase.from("leases").update({ status: "terminated", archived_at: new Date().toISOString() })
  .eq("company_id", companyId).eq("status", "active")
  .or(`tenant_name.ilike.%${escapeFilterValue(name)}%,property.eq.${escapeFilterValue(tenantProperty)}`);
```

The `.or(...)` is structured as "name matches **OR** property matches" — so archiving Unit 1B's tenant terminates every other active lease at that address. The companion property update on line 269 also clears `tenant_2` … `tenant_5` and flips `status='vacant'`, further damaging the other units.

**Repro**: stand up two tenants at the same address, archive one, check the other's lease — it will be `status='terminated'`, and the property's other tenants will be wiped.

**Fix**: change the `or` to an `and` — the intent is "this tenant's name AND this property". Better: look up the tenant's `id` and scope with `.eq("tenant_id", …).eq("property", …)`.

---

### C-3 · `checkAccrualExists` uses `%` as wildcard inside `.or()` — smart AR settlement + owner distribution are both silently broken

`src/utils/accounting.js:196`:

```js
.or(`reference.like.RENT-AUTO-%${escapeFilterValue(month)}%,reference.like.ACCR-${escapeFilterValue(month)}%`)
```

In Supabase JS client's `.or()` string syntax, the wildcard for `like/ilike` is `*`, not `%`. `%` is passed through as a literal percent. PostgreSQL LIKE then looks for a literal `%` in the column and finds nothing. So `checkAccrualExists` always returns false.

Downstream:

- `src/components/Payments.js:230` → `runNow` always posts payments as DR Checking / CR Rental Income (direct revenue), never "settling AR". AR accrual rows are never cleared.
- `src/utils/accounting.js:222` → `autoOwnerDistribution` returns early ("No accrual to reclassify"), so management fee + owner-distribution-payable JEs are **never posted** from the autopay path. Owner statements silently under-report.

**Repro**: enable autopay for a tenant, post an AR accrual via a recurring JE, run the autopay. Check `acct_journal_lines` — the payment credits `4000 Rental Income` directly; no AR settlement JE; no `ODIST-…` journal entry.

**Fix**: replace `%…%` with `*…*` in every `.or()` `like/ilike` pattern. Same bug in `src/components/Payments.js:30` and `src/components/Tenants.js:273`.

---

### C-4 · Tenant rename updates unrelated tenants with the same old name

`src/components/Tenants.js:189-197`:

```js
supabase.from("payments").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName),
supabase.from("leases").update({ tenant_name: form.name }).eq("company_id", companyId).eq("tenant_name", oldName),
// … seven more tables …
```

None of these updates scope by `property` or `tenant_id`. If two tenants in the company share a name (e.g., two "John Smith"s at different properties), renaming one renames *all* their records — payments, leases, work orders, documents, autopay, ledger, messages, eviction cases, and the Properties grid tenant fields. This violates the explicit rule in `CLAUDE.md`: *"Autopay/lease operations — always scope by BOTH tenant name AND property."*

**Repro**: seed two tenants with identical names, rename one → the other's records are rewritten too.

**Fix**: add `.eq("property", oldProperty)` (and use `tenant_id` instead of name where the column exists) on every one of these nine updates.

---

### C-5 · `safeLedgerInsert` races on concurrent writes for the same tenant

`src/utils/accounting.js:22` fetches the latest running balance, then inserts. Two concurrent payments A=$50 and B=$30 both read `prevBal=$100`, both compute balances off $100, and the loser's balance is wrong (it assumes the winner's payment hadn't happened).

This is already hedged by `atomicPostJEAndLedger` → RPC `post_je_and_ledger`, but the RPC fallback calls `safeLedgerInsert` directly (line 98 via `postAccountingTransaction`) — so the race lives on any flow whose RPC failed over to the client path.

**Repro**: race two `runNow` clicks for the same tenant with network throttling → second ledger entry shows a balance inconsistent with the sum.

**Fix**: compute the balance server-side inside `post_je_and_ledger` (it already has to); stop having the client compute it. Or wrap the read + insert in an advisory lock per `tenant_id`.

---

### C-6 · `safeLedgerInsert` scopes by tenant *name* when `tenant_id` is missing

`src/utils/accounting.js:18` — if `entry.tenant_id` is not set, it falls back to `.ilike("tenant", entry.tenant)` for the "previous balance" lookup. Two same-named tenants across properties both see each other's running balance mixed in.

This violates `CLAUDE.md`'s explicit pattern: *"`tenant_id` over `tenant.name` — always prefer ID-based queries to prevent cross-tenant data leaks."*

**Fix**: require `tenant_id` on every `safeLedgerInsert` call; error (don't fall back) if missing.

---

### C-7 · Company "hard delete" for an empty company orphans ~15 tables of data

`src/components/CompanySelector.js:231-261` deletes `company_members`, `app_users`, `acct_accounts`, `acct_classes`, `notification_settings`, then `companies`. It does not touch: `acct_journal_entries`, `acct_journal_lines`, `ledger_entries`, `documents`, `work_orders`, `bank_connection`, `bank_account_feed`, `bank_feed_transaction`, `audit_trail`, `error_log`, `notification_queue`, `leases`, `lease_templates`, `owners`, `vendors`, `utilities`, `hoa_payments`, `property_insurance`, `property_loans`, `property_tax_bills`, `property_licenses`, `late_fee_rules`, `autopay_schedules`, `recurring_journal_entries`, `messages`, `eviction_cases`, `plaid_sync_event`, `bank_rules`, `tenant_invite_codes`.

The "empty" check only counts properties/tenants/payments (line 234-239), so a company that has **zero** of those but does have an old Teller bank_connection (encrypted token!) or audit rows is considered empty and hard-deleted. The related rows persist forever as orphans. CLAUDE.md says *"Use soft-delete/archive patterns, never hard-delete production data"* — and the hard-delete path is wired to a button labeled "Delete" next to every company on the selector, with no multi-step gating.

**Repro**: create a company, connect Teller, immediately click Delete before uploading a property → Teller encrypted token row stays in `bank_connection`, `bank_feed_transaction` persists, audit rows persist, all referencing a non-existent company.

**Fix**: remove the hard-delete path entirely — only archive. If a hard delete is truly wanted, it should be admin-only, protected by a 24-hour grace window, and must `DELETE` every table in a DB-side `RETURNING`-checked function, not nine clientside calls.

---

### C-8 · Orphaned auth account if tenant invite redemption fails after signup

`src/components/LoginPage.js:100-120` creates the Supabase auth user first, then redeems the invite. If `redeem_invite_code` returns `success: false` (already used, expired, or anything), the auth user is already created — they can sign in but have no tenant membership, no company link, and no way to self-recover. The comment at line 91 claims the opposite ("prevents orphaned auth accounts"); the code actually creates them.

**Repro**: two people race-redeem the same invite code; the loser ends up with a zombie auth account that fails every subsequent UI check.

**Fix**: call `redeem_invite_code` *before* `auth.signUp`, or wrap signup + redemption in a single `SECURITY DEFINER` RPC that rolls back on failure.

---

### C-9 · Write-path errors silently succeed — `rpc().catch(…)` never fires

`src/utils/accounting.js:504` and `src/components/Tenants.js:288`:

```js
supabase.rpc("update_tenant_balance", { … }).catch(e => pmError("PM-6002", { raw: e, context: "…", silent: true }));
```

Supabase's JS client does not reject on business errors — it resolves with `{ data, error }`. `.catch` only fires on network failure. So RPC errors (e.g. RLS denial, missing rows, constraint violations) are silently lost on both paths. Balance-change failures become invisible.

**Repro**: disable RLS on `update_tenant_balance` or seed a bad tenant UUID; run autopay or a recurring JE — console stays clean, Sentry stays clean, balance drifts.

**Fix**: await and inspect `{ error }`:

```js
const { error } = await supabase.rpc("update_tenant_balance", …);
if (error) pmError("PM-6002", { raw: error, … });
```

Same pattern on `src/components/Accounting.js:1124` (`.then(() => {}).catch(…)` on an `update()`).

---

### C-10 · `autoPostRecurringEntries` picks an arbitrary lease when the property has multiple active leases

`src/utils/accounting.js:448`:

```js
const { data: lease } = await supabase.from("leases")
  .select("start_date, end_date")
  .eq("company_id", cid).eq("property", entry.property).eq("status", "active").maybeSingle();
```

`maybeSingle()` throws if more than one active lease matches. For a multi-unit property, every recurring JE blows up or silently returns null — proration is then never applied. When only *one* active lease exists but it isn't the tenant on the recurring template, proration applies to the wrong tenant's dates.

**Fix**: scope by the recurring entry's `tenant_id` (and/or `tenant_name`) in addition to `property`, and use `.limit(1)` rather than `maybeSingle`.

---

### C-11 · `autoOwnerDistribution` applies a default **10% management fee** when the owner's pct is null

`src/utils/accounting.js:223`:

```js
const feePct = safeNum(owner.management_fee_pct || 10);
```

A null or 0 management fee on an owner row silently becomes 10%. Owners who opted out of a management fee (self-managed properties) will have 10% of rent debited to `4200 Management Fee Income` and only 90% credited to `2200 Owner Distributions Payable` without any opt-in.

**Fix**: use `safeNum(owner.management_fee_pct)` and skip the distribution (or error) if `null`; never fall back to a hard-coded 10%.

---

### C-12 · Proration in the Properties wizard resets `last_posted_date` for every lease at that property

`src/components/Properties.js:814`:

```js
await supabase.from("recurring_journal_entries")
  .update({ last_posted_date: tenantForm.lease_start })
  .eq("company_id", companyId).eq("property", addr).eq("status", "active").is("archived_at", null);
```

No scoping by tenant. At a multi-unit property, adding Tenant B (Feb 15) resets `last_posted_date` on Tenant A's already-posted recurring entry → the next cron pass starts Tenant A's monthly rent from Feb 15 instead of March 1, skipping February.

**Fix**: add `.eq("tenant_id", tenantId)` — every recurring JE should be tenant-scoped anyway.

---

### C-13 · On WO completion, any cost is posted as CR `1000 Checking Account`

`src/components/Maintenance.js:159-160`:

```js
{ account_id: "5300", account_name: "Repairs & Maintenance", debit: amt, … },
{ account_id: "1000", account_name: "Checking Account", debit: 0, credit: amt, … },
```

There's no way for the PM to tell the system the WO was paid on a credit card, via owner reimbursement, or on account with the vendor. Every completed WO debits Checking regardless. For vendor-on-account flows this is wrong; for any non-cash payment this is wrong.

**Fix**: introduce a payment-method picker when completing a WO (or post AP-on-account by default and let the PM mark it paid later via bank recon).

---

### C-14 · CORS `isAllowedOrigin` whitelists every `*.vercel.app` subdomain

`api/_cors.js:14`:

```js
if (u.hostname.endsWith(".vercel.app")) return true;
```

Any attacker who can deploy a public preview to vercel.app (free tier is trivial to get) can make credentialled cross-origin requests to the production API on behalf of a logged-in admin visiting their page. Token extraction isn't blocked by CORS itself, but CSRF-style write operations via `POST /api/invite-user`, `POST /api/teller-save-enrollment`, etc. can be staged by tricking the admin into visiting the attacker's preview URL.

**Fix**: whitelist only the explicit preview URL patterns owned by this project — e.g. `rental-manager-<branch>-<orgslug>.vercel.app` — or gate by `Origin` plus a custom CSRF token issued from the app.

---

## High

### H-1 · `hasAllRequiredTenantDocs` matches by substring — "life insurance" fulfills "Renters Insurance"

`src/utils/helpers.js:118-126` declares:

```js
{ label: "Government-Issued ID", match: ["id", "government"] },
{ label: "Renters Insurance",    match: ["insurance"] },
{ label: "Proof of Utility Transfer", match: ["utility"] },
```

and asks `name.includes(keyword)`. Substring matching is far too loose:

- A doc named `video.pdf` contains `"id"` → satisfies Government-Issued ID.
- A doc named `life_insurance_beneficiaries.pdf` satisfies Renters Insurance.
- A doc named `utility_receipt.pdf` satisfies Proof of Utility Transfer.

Tenants are flipped to `doc_status='complete'` on false positives, masking actual compliance gaps.

**Fix**: require explicit `doc.type` values (e.g. an enum `id_drivers_license | id_passport`) set at upload time; don't derive compliance from filename substrings. As a minimum, bump to word-boundary regex anchored to specific types.

---

### H-2 · `recomputeTenantDocStatus` scopes docs by tenant name, not `tenant_id`

`src/utils/helpers.js:137, 145`:

```js
.ilike("name", tenantName)     // line 137
.ilike("tenant", tenantName)   // line 145
```

Two tenants with similar names across properties will see each other's doc uploads count toward their own requirements. One tenant uploading an ID can flip the *other* tenant to `complete`.

**Fix**: accept `tenant_id` as the first arg and use `.eq("id", tenantId)` / `.eq("tenant_id", tenantId)`.

---

### H-3 · Autopay `runNow` tenant lookup is case-sensitive; `nextDue` ignores `frequency`

`src/components/Payments.js`:

- Line 215: `.eq("name", s.tenant)` — case-sensitive. If the tenant was created as `"Alice Johnson"` and the autopay schedule still has the old casing `"alice johnson"`, `tenantRow` is null → duplicate guard falls back to name+property lookups, deterministic JE reference degrades, owner-dist path breaks.
- Line 265-280 `nextDue()` is hard-coded to monthly math. Line 315 exposes `weekly` and `biweekly` as frequency options. A weekly or biweekly schedule shows the wrong "Next due" date and its cron cadence is never honored (because `runNow` doesn't inspect `frequency` either).

**Fix**: use `.ilike("name", escapeFilterValue(s.tenant))` for the lookup; implement `nextDue` for all three frequencies (and stop offering `weekly`/`biweekly` until a weekly cron exists).

---

### H-4 · Autopay day-of-month dropdown caps at 28

`src/components/Payments.js:309`:

```js
Array.from({ length: 28 }, (_, i) => i + 1)
```

Owners whose rent is due on the 30th or end-of-month can't express that. Falling back to the 28th loses two days of accrual every month for them.

**Fix**: allow 1-31 and let the existing `nextDue` clamp logic (line 270, 276) handle short months.

---

### H-5 · `autoPostJournalEntry` retry loop only re-rolls JE numbers, not duplicate `reference`

`src/utils/accounting.js:154-163` retries up to 3× on *any* error whose message contains `"unique"`. Two unique indexes exist: `acct_journal_entries.number` and `idx_je_company_reference_unique` on `(company_id, reference)`. A collision on `reference` (the actual dedup key) will loop and burn 3 retries producing fresh JE numbers, but since `reference` doesn't change, every retry fails again — and the function ultimately returns `null` (caller ignores). The sequential attempts don't help, and we swallow a 3x write overhead.

**Fix**: differentiate duplicate-on-number (retry by incrementing `attempt`) from duplicate-on-reference (fail fast — the dedup guard has fired). Inspect `jeErr.details` / constraint name.

---

### H-6 · `autoPostJournalEntry` number generation is race-prone

`src/utils/accounting.js:155-157` reads "latest JE by created_at" client-side, then inserts. Two near-simultaneous callers both read `JE-0041`, both try `JE-0042` — winner succeeds, loser gets `unique` error on number, retries with `JE-0043`. Under sustained concurrency, JE numbers skip. Non-sequential JE numbers are a red flag in audit.

**Fix**: replace with a Postgres sequence or an RPC that allocates the next number atomically.

---

### H-7 · PM-9006 integrity sweep is blind to name-keyed ledger entries

`src/utils/company.js:95` and `api/integrity-check.js:93-101` compute the "real ledger total" by summing `ledger_entries.amount` where `tenant_id = t.id`. Historical rows that only have `tenant` (name) populated are excluded. So `tenant.balance` — which *did* track name-keyed charges — legitimately diverges from the id-scoped sum, and every affected tenant is reported as PM-9006 critical. The dashboard "unbalanced" alert becomes noise; real mismatches are lost in the crowd.

**Fix**: union the id-scoped and name-scoped sums, or backfill `tenant_id` on all historic ledger rows once and then exclude `null` confidently.

---

### H-8 · Multi-credential encryption migration silently destroys one of the two credentials per row

`api/migrate-encryption.js:145-185` acknowledges the issue in a long comment, but the observable effect is that every HOA/Utility/Insurance/Loan row that had a username *and* password under the legacy scheme ends up with one field decryptable and the other replaced with `""`. The user is not notified. The next time they look at the utility account, they see a blank username and no way to know it was wiped.

**Fix**: add a `encryption_iv_fields` JSONB column (one IV per field) and migrate legacy rows into it; never blank-out ciphertext silently. Surface a "credentials need re-entry" banner per row.

---

### H-9 · Teller `raw_payload_json` stores full Teller transaction payload

`api/teller-sync-transactions.js:212`:

```js
raw_payload_json: txn,
```

`txn` from Teller contains counterparty name, ACH details, routing numbers (sometimes), and merchant category. If RLS on `bank_feed_transaction` is not tightly scoped (e.g., company members with `role=tenant` can read), that's sensitive bank data leaked to the wrong actors. Even scoped per company, this is more PII than needed and is never purged.

**Fix**: whitelist the fields you want persisted (`id`, `date`, `amount`, `description`, `counterparty.name`) and drop the raw dump. Periodic redaction job for legacy rows.

---

### H-10 · `inviteUserByEmail` already-registered fallback calls `generateLink` but never emails it

`api/invite-user.js:112-116`:

```js
const { error: linkErr } = await admin.auth.admin.generateLink({
  type: "magiclink",
  email,
});
```

`admin.auth.admin.generateLink` *returns* an action link; it only triggers an email when the Supabase Auth project has `Email Templates → Magic Link → Custom SMTP` wired AND the template type matches. It does **not** send a message by default. The comment at line 106 claims "the project's email template for type=magiclink delivers it"; verify against Supabase configuration. If the template isn't wired (common on bootstrapped projects), every admin invite to an already-registered user produces a success toast and the user never receives anything.

**Fix**: call `resetPasswordForEmail` (which is always delivered) or explicitly `mail.send` the returned `properties.action_link`.

---

### H-11 · `decryptCredential` returns `"••••••"` on failure

`src/utils/encryption.js:64`. Any UI field that uses the return value as a value/default will now persist a literal `"••••••"` on save — wiping the real encrypted credential.

**Fix**: return `null` / throw, and have the UI show a sentinel badge instead of rendering the placeholder into an `<input>`.

---

### H-12 · `encryptCredential` returns `{ encrypted: "", iv: "", salt: "" }` on failure

`src/utils/encryption.js:39, 50`. If the encryption API is unreachable (or master key misconfigured), callers silently persist a row with empty ciphertext. Looks successful to the user; is completely broken.

**Fix**: throw; let callers display a toast and abort the save.

---

### H-13 · `/api/encrypt` grants decrypt to any active company member regardless of role

`api/encrypt.js:149-156`. A `role=tenant` user, if they also appear in `company_members` with `status=active`, can POST `/api/encrypt` with `action=decrypt` and recover any credential stored for their company — Teller access tokens, utility passwords, HOA credentials. The UI doesn't surface these to tenants, but the API itself doesn't enforce a role gate.

**Fix**: restrict `action=decrypt` to `role ∈ {admin, owner, pm}`, and consider the same for `action=encrypt`.

---

### H-14 · Teller Connect + save path leaks Teller API bodies to the client

`api/teller-save-enrollment.js:168`:

```js
return res.status(400).json({ error: "Teller API error: " + accountsRes.body });
```

Forwards the raw Teller response body to the browser. That body can include institution-side error codes, rate-limit diagnostics, and (rarely) routing/account details in unhappy paths. Same pattern in `api/teller-sync-transactions.js:167`.

**Fix**: log the body server-side; return a generic `"Bank connection failed — please try again"` to the client.

---

### H-15 · Fredericksburg / Falls Church / Manassas Park / Manassas City fiscal-year tax bills are generated in the wrong calendar year

`src/utils/taxes.js:38` and `api/tax-bill-reminders.js:70` treat `tax_year` as a calendar year. For fiscal-year jurisdictions (Fredericksburg, Falls Church, Manassas Park, Manassas City), the 1st-half Dec 5 belongs to the *next* fiscal year's cycle. With `tax_year=2026` and schedule `[{month:12, day:5}, {month:6, day:5}]`, the generator emits `due_date=2026-12-05` for the 1st half — but FY2027's 1st-half is actually Dec 5, 2026, which means the entry conflates FY2026 and FY2027. Owners paying bills by the label see duplicate or missing installments.

**Fix**: per-schedule: track whether it's calendar or fiscal; for fiscal, post `tax_year=FY` with 1st-half due on `Dec 5, FY-1`.

---

### H-16 · Payments.js:41-42 derives payment method from description substring

`src/components/Payments.js:41-42`:

```js
if ((je.description || "").toLowerCase().includes("ach")) method = "ACH";
else if ((je.description || "").toLowerCase().includes("check")) method = "Check";
```

`"ACH checking acct payment"` → method=ACH (first match), then `"Check from ACH-favored customer"` → method=ACH (because "ach" hits first). Fragile. Better to store `method` on the JE lines directly.

---

### H-17 · Property wizard matches existing JEs using description substring

`src/components/Properties.js:771-772`:

```js
const hasRentJE = (existingJEs || [])
  .some(je => je.description?.toLowerCase().includes(tNameLower)
           && je.description?.toLowerCase().includes("rent"));
```

If a custom JE exists with description "Renter complaint resolved — Alice", the tenant-rename/wizard path believes rent was already posted for Alice and skips posting the real rent. Inverse false-negatives are just as bad.

**Fix**: look up by `reference` (deterministic, structured) — `RENT-…`, `PRORENT-…`, `DEP-…` — rather than by description.

---

### H-18 · `companyInsert`/`companyUpsert` don't verify caller's membership

`src/utils/company.js:12-23` injects `company_id` on write but relies entirely on RLS to enforce "caller must be a member". If RLS on any table is accidentally `USING (true)` for a grant, the helper cheerfully writes to any company the caller provides. Defense-in-depth would demand an additional client-side check (which the help already has on some paths via `requireCompanyId`, but not for membership).

**Fix**: add an optional `requireRole` parameter that does an in-client membership check as a second line of defense; in an admin panel we shouldn't rely on RLS being perfect.

---

### H-19 · `owner distribution` path posts the `owner_distributions` row even when JE post fails

`src/components/Owners.js:212-221`:

```js
const distResult = await atomicPostJEAndLedger({ …, requireJE: false });
if (!distResult.jeId) showToast("Warning: Distribution GL entry failed — please post manually in Accounting.", "error");

// unconditionally continues →
await supabase.from("owner_distributions").insert(…);
```

The record is persisted on `owner_distributions` even if the GL didn't post. Next statement run sees a distribution that isn't in the GL and can't reconcile.

**Fix**: roll back / skip the dist insert on `!jeId` — or invert the order (insert dist, post JE, delete dist on JE fail, like `autoOwnerDistribution` already does in `utils/accounting.js:268-271`).

---

### H-20 · `CompanySelector` empty-company check ignores work orders, documents, leases, accounts, etc.

`src/components/CompanySelector.js:234-240`. See C-7 for the broader orphaning consequence. The pre-delete check counts only properties, tenants, and payments. A user who has only ever uploaded a lease or recorded a work order will hit the "PERMANENTLY DELETE" dialog and vaporize all the other data.

---

## Medium

### M-1 · Dashboard currency formatting is inconsistent

Live browser pass: `Revenue (ACCTG) $999.00`, `Net Income $999` (no decimals, no comma). Different code paths emit currency in different ways. `formatCurrency` already exists in `src/utils/helpers.js:74` and should be the one source of truth; clearly some Dashboard tiles render `$` + raw number directly.

### M-2 · Header logo changes mid-flow

Landing page shows a building-block icon beside "PropManager"; login page swaps it to the 🎍 emoji. Minor, but it's the very first inconsistency a new user sees.

### M-3 · "Lease Expirations" panel on Dashboard rendered empty with no empty-state message

Live browser pass. Either no upcoming expirations exist (in which case show "No upcoming lease expirations in the next 90 days"), or the query is wrong and nothing rendered. Either way, users see a labeled-but-blank card.

### M-4 · `escapeFilterValue` over-escapes characters that aren't PostgREST/SQL wildcards

`src/utils/helpers.js:188` escapes `[%_,.*()\\]`. Periods and parentheses aren't special in SQL `LIKE`; commas and parens aren't special in the value half of a `.ilike()` call (only in `.or()` separators). `"Ave."` ends up as `"Ave\\."` in the client, which PostgREST URL-encodes; PostgreSQL LIKE treats `\` as the default escape char so `Ave\.` matches the literal `.` only. Mostly harmless, but it *does* break the occasional legit match on values containing parentheses (e.g. "Smith (executor)") if those calls are on `.or()` boundaries.

### M-5 · `ilike("email", user.email)` treats `_` in the email as a wildcard

Widespread — `App.js:202, 348, 418, 428, 521, 864`, `CompanySelector.js:34, 75, 204`, `TenantPortal.js:41, 118, 166`, `Owners.js:506`, `invite-user.js:81`, `teller-save-enrollment.js:107`, etc. A user registered with email `john_a@x.com` and another `johnaa@x.com` match the same `.ilike("email", "john_a@x.com")` query because `_` is a SQL LIKE wildcard. Not exploitable by an attacker who can't register arbitrary emails, but is a real collision source on membership/profile lookups.

**Fix**: use `.ilike("email", escapeFilterValue(email))` or swap to a case-insensitive `eq` via `normalizeEmail(email)` on both sides.

### M-6 · `logAudit` silently drops unknown actions/modules

`src/utils/audit.js:24-25`. When a dev passes an unrecognized action like `"purge"`, no audit row is written. There's a `PM-8007` reported but most devs won't see it. Consider letting unknown actions through and annotating `action_unknown: true` so the audit trail never loses a real event.

### M-7 · `reportError` notifies the reporter as the recipient, not an admin

`src/utils/errors.js:214`:

```js
recipient_email: (_currentUserEmail || "anonymous").toLowerCase(),
```

The comment on lines 205-208 says "notifications go to admin recipients" but the row we insert targets the reporter themselves. Queue consumer will happily email the user their own report.

**Fix**: resolve the admin list for the company (`company_members` with `role=admin`) and insert one row per admin.

### M-8 · `runDataIntegrityChecks` PM-9002 check is case-sensitive on tenant name

`src/utils/company.js:84`. Lease rows whose `tenant_name` is stored with different casing than `tenants.name` report a false positive "has no active lease".

### M-9 · Company-settings default leak if DB fetch fails

`src/utils/company.js:154`. Fetch error → returns `COMPANY_DEFAULTS`. User flips a setting, the UI shows the default, saves the default back. Silent config drift on transient DB errors. Better to show a load failure.

### M-10 · Work order photo upload lacks magic-byte validation

`src/components/Maintenance.js:201-202` checks MIME + extension. CLAUDE.md commits to magic-byte validation, but none is performed for work-order photos. An attacker with an admin's session could upload a renamed PDF/HTML with `image/jpeg` MIME and stash it in the maintenance-photos bucket.

### M-11 · `Math.round(rentBase * feePct / 100)` in late fees rounds to whole dollars

`src/components/LateFees.js:94`. $1250 × 5.1% = $63.75 → rounded to $64. Accounting should preserve cents.

**Fix**: `Math.round(rentBase * feePct / 100 * 100) / 100`.

### M-12 · Recurring-entry proration rounds to whole dollars

`src/utils/accounting.js:460, 467, 473`. Same pattern as M-11. A $1237/mo lease prorated 29/30 days → `Math.round(1237 * 29/30) = 1196` instead of $1195.87. Compounds over time.

### M-13 · `autoOwnerDistribution` reference string can exceed typical varchar widths

`src/utils/accounting.js:239`:

```js
const ref = `ODIST-${owner.id}-${tenantSlug}-${refDate}-${paymentCents}`;
```

`owner.id` (UUID, 36 chars) + `ODIST-` + `tenantSlug` (≤32) + date (8) + cents (≤10) = up to ~90 chars. If `acct_journal_entries.reference` is `varchar(50)`, the insert fails. Depending on schema this may or may not be live.

**Fix**: hash the components (`sha256(…).slice(0, 16)`) and store a predictable shorter ref.

### M-14 · Tenants.js `dupCheck` and `ilike(name)` never wrap with `%` — it's an exact case-insensitive match, not a search

`src/components/Tenants.js:113, 142, 409, 465, 472`. These calls behave as `lower(name) = lower(value)`. Functionally OK, but a future dev reading "ilike" expects substring matching — misleading.

### M-15 · `deleteAccount` doesn't delete the Supabase auth user

`src/components/Admin.js:1229-1243`. "Delete my account" only flips `app_users.status = 'deleted'` and removes memberships, then signs out. The Auth user stays alive, can still log in, and any UI that doesn't re-check `app_users.status` grants access.

**Fix**: call `admin.auth.admin.deleteUser(user.id)` from a server route that verifies the session.

### M-16 · `teller-cron-health` returns every company's connection status when authed with `CRON_SECRET`

`api/teller-cron-health.js:77-96`. A leaked cron secret yields a global list of `company_id` + sync state + `last_error_message`. Not a direct compromise but a helpful pre-attack inventory.

### M-17 · `checkRPCHealth` invokes admin RPCs with `{}` at every page load

`src/utils/company.js:35-46`. `archive_property({})` and `update_tenant_balance({})` get called as no-op probes. If the RPC has side effects on missing args (unlikely but possible), this fires them. At minimum it's noisy in the DB logs. Probe by `pg_get_functiondef` or a dedicated `health_check()` RPC that returns the list.

### M-18 · Every empty-credential row is a "successful" encrypt

See H-12. Also affects the save path in `/api/teller-save-enrollment.js` — `access_token` is required by schema and validated, but an empty-return `encrypt()` would produce a row with `access_token_encrypted=""`. `accounts` fetch would fail, saving partial state.

### M-19 · `TenantPortal` useEffect depends on `currentUser` but not `companyId`

`src/components/TenantPortal.js:94`. Changing the active company without re-mounting the component skips the refetch, showing stale ledger to the tenant.

### M-20 · Autopay `fetchData` filters overdue by `payments.status='unpaid'` but there is no UI to set status=unpaid

`src/components/LateFees.js:26`. The overdue list is sourced from `payments` with `status='unpaid'`. Every non-portal flow I can see creates `payments` with `status='paid'`. Unless there's a back-office path I missed, the "overdue" panel is permanently empty and the Late Fees page never has anything to act on.

### M-21 · Currency parsing in CSV import loses sign on `"-(100)"`

`src/components/Accounting.js:2728`. `startsWith("-")` OR `startsWith("(")` sets `neg=true`; then strips *both* `-` and `()`; returns `-v`. A value `"-(100)"` goes `neg=true` → strip `-` → strip `()` → `-100`. That's actually "negative of negative" which should be positive. Edge-case input; fix with one canonical negative marker.

### M-22 · `runNow` records payment with the stale `tenant` name on the row

`src/components/Payments.js:226`. Even if the autopay schedule references an old tenant name, we insert a fresh `payments` row with `tenant: s.tenant` (schedule's name). If the tenant was renamed via the flow in C-4, the schedule still has the old name and the payment row carries it forward.

### M-23 · Native `prompt()` / `confirm()` used for destructive flows

Multiple places: `Maintenance.js:113, 117`, `Banking.js:1405, 1620`, `Documents.js:1355-1386`, `LoginPage.js:68`, `TaxBills.js:121`. Native prompt/confirm is not styled, is blocked in some embedded contexts, and provides no way to show helper text / validation inline.

### M-24 · `maybeSingle()` used on potentially-multi-row queries

- `src/components/TenantPortal.js:88` — autopay schedules — a tenant could have more than one row.
- `src/components/Payments.js:213-218` — tenant lookup by `(name, company, property)`; fine today but could throw if the renaming bug (C-4) produced duplicates.

### M-25 · `fetchAll` / `fetchData` in many components swallow errors in a catch-all

`src/components/LateFees.js:49-53` `catch { setRules([]); setTenants([]); setFlagged([]); }`. No `pmError` call — so DB failures make the page look empty and silent. Every fetchAll path should run raw errors through `pmError` with the right code.

---

## Low

### L-1 · `shortId` slice is a no-op

`src/utils/helpers.js:23` — generates 12 hex chars, slices `0,12` (no-op). Cosmetic.

### L-2 · `escapeHtml` doesn't escape backticks

`src/utils/helpers.js:184`. In general-HTML output that's fine; if the string ever flows into a template literal interpolation on the server, it could be a vector. Unlikely.

### L-3 · `guardSubmit` collision: `save:foo` vs `save`+`foo`

`src/utils/guards.js:3` — both produce `"save:foo"` as the guard key. Fix by using a separator that can't appear in keys (e.g. `\u0000`).

### L-4 · `guardSubmit` periodic cleanup is a no-op

`src/utils/guards.js:14`. The check `!_submitGuards[k]` is never true because guards are set to `true`. Harmless because `setTimeout` cleanup inside `guardSubmit` already clears entries.

### L-5 · `detectInfrastructureCode` relies on string matching over raw error messages

`src/utils/errors.js:103-113`. Error messages from Supabase / Postgres change between versions; when they do, our classifier silently misroutes to `PM-8006`. Consider classifying by `.code` (Postgres SQLSTATE) where available.

### L-6 · `logErrorToSupabase` is fire-and-forget inside `pmError`

`src/utils/errors.js:179`. A slow error-log write blocks the event loop briefly but doesn't affect UX. Acceptable.

### L-7 · `isAllowedOrigin` falls back to PROD_ORIGIN on disallowed request

`api/_cors.js:26`. Wastes bytes on preflight but doesn't actually open a hole. Could just omit the header when disallowed.

### L-8 · Auth token compares in cron routes aren't constant-time

`api/expire-invites.js:23`, `api/integrity-check.js:127`, `api/teller-sync-transactions.js:97`, `api/tax-bill-reminders.js:141`, `api/license-expiry-reminders.js:50`, `api/migrate-encryption.js:208`, `api/teller-cron-health.js:18`. Classic timing-attack vector for shared secrets. Use `crypto.timingSafeEqual`.

### L-9 · Company selector "Delete" has no guard against double-click between `Promise.all` count and the `delete`

`src/components/CompanySelector.js:234-258`. A user spamming the button races the count against a concurrent tenant create. The `deleting` state guard (line 232) helps for the same tab.

### L-10 · `lookupZip` has no timeout on `fetch`

`src/utils/accounting.js:524`. Zippopotam.us outages would hang the wizard. Wrap with AbortController + 5s timeout.

### L-11 · `parseFloat` / `parseInt` without radix

`src/components/Accounting.js:425, 2737, 2884`. Defensive programming; strings are already regex-shaped here. Low risk.

### L-12 · Large in-memory scans in Teller sync dedup

`api/teller-sync-transactions.js:176-181`. Pulls every fingerprint for the feed into memory each sync. Fine at seed; at 10k txns per feed this grows.

### L-13 · `shouldEmit` dedup silences log writes but still surfaces toasts

`src/utils/errors.js:159-165`. During a noisy render loop, the user still sees toast after toast (60s window applies only to Sentry + error_log). Consider muting the toast too if we're going to silence the log.

### L-14 · `_acctIdCache` has no invalidation across company switches

`src/utils/accounting.js:314`. Cache is scoped per `cid` so cross-company pollution isn't possible, but an account rename *within* the same company doesn't propagate until a hard reload.

### L-15 · Trying every legacy key on every decrypt

`api/encrypt.js:178-184`. Three candidates tried for each decrypt. At volume this compounds; cache the winning key per `companyId`.

### L-16 · `_submitGuards` setTimeout cleanup never fires if the tab is backgrounded / throttled

Modern browsers throttle timers in hidden tabs. A `guardSubmit` taken in a backgrounded tab persists until the tab is focused and the 30s timer gets to fire. In practice callers already release explicitly; the 30s is an eventual-consistency escape hatch.

---

## UI observations from the live browser pass

(Limited to login → dashboard before the browser MCP connection gave out.)

1. **Landing → login branding drift** (M-2).
2. **`Open` opens a new tab** rather than navigating within the same tab — combined with the fact that navigating directly to `#dashboard` without an active company bounces back to `#company_select`, the UX feels like "the back button loses my company" on any flow that opens a fresh tab.
3. **Company selector "Delete" is a plain red link** next to "Open", same size as every other row element. The confirm dialog *is* present (see C-7 for why it's still dangerous), but the affordance is an invitation for misclicks. At minimum move Delete into a kebab menu.
4. **Dashboard tiles**:
   - `Revenue (ACCTG)` and `Expenses (ACCTG)` render with `.00` cents;
   - `Net Income` renders without cents or thousands separators (M-1).
5. **"Tasks & Approvals" pill** shows `45 pending tasks` directly on the dashboard with a large yellow affordance — a clear value proposition, but I couldn't verify the count was correct without walking into that page.
6. **"Messages" sidebar item** shows a red `1` badge; that's consistent with CLAUDE.md's claim that the Messages module was recently enabled.
7. **Sidebar hierarchy** surfaces `Properties ▾` as the only expandable. Everything else (Payments, Accounting, Documents, Vendors, Tasks & Approvals, Owners, Messages, Notifications) is top-level. Modules documented in CLAUDE.md that did *not* appear directly in the sidebar: Maintenance, Utilities, Leases, Autopay, Late Fees, Audit Trail, HOA, Insurance, Loans, Tax Bills, Inspections. Presumably those are nested somewhere — worth verifying that discovery isn't blocked for PMs who don't know where to look.

---

## Suggested triage order

1. **C-3, C-4, C-12** — same-property / same-name data bleed. These actively corrupt multi-tenant portfolios and can't be recovered from client-side. Ship DB-layer fixes immediately.
2. **C-1** — bad-debt / eviction misclassification. Accounting output is wrong today; tax-time embarrassment.
3. **C-7, C-8** — destructive button paths that orphan or strand data.
4. **C-5, C-6, C-10, C-13** — money-path correctness. All will bite in audit.
5. **C-14** — CORS blast radius.
6. **H-10, H-12, H-13, H-14** — credential & bank-path hardening.
7. Everything else.

## What I couldn't cover

- Full click-through of every modal, empty state, and error path (the browser MCP session kept dropping; covered login + dashboard only).
- DB schema (RLS policies, constraints, indexes) — I can read `src/` but haven't read `supabase/migrations`. Many of the "HIGH" findings become "CRITICAL" or "LOW" once you check what the DB actually enforces.
- E2E test suite in `tests/` — worth running `cd tests && npm test` and treating any failing bank or accounting test as an implicit bug already flagged here.
- The newly-added Messages module — I only grep'd it, didn't read end-to-end.
- PDF / Lease e-sign flow rendering in a browser with a real token (no signing link on hand).

If you want a follow-up pass, the two highest-leverage next steps are:

1. Run the E2E suite headed (`cd tests && npx playwright test --headed`) and correlate failures to the findings above.
2. Read `supabase/migrations` to confirm which of the `HIGH` findings are already masked by DB-side constraints.
