# Security Audit

Run a comprehensive security scan of the PropManager codebase. Analyze all files in `src/` for vulnerabilities.

## Checks to perform

### 1. Multi-Tenant Isolation
For each critical table (properties, tenants, payments, leases, work_orders, documents, acct_journal_entries, ledger_entries, owner_distributions, owner_statements, acct_accounts, acct_journal_lines, autopay_schedules, recurring_journal_entries), scan ALL `.from("TABLE")` calls across `src/`. Capture the full chain up to the next `;`. Flag any query that does a SELECT, INSERT, UPDATE, or DELETE without `company_id` in the chain or payload. Exclude: Supabase Storage calls (.upload, .createSignedUrl, .getPublicUrl), .rpc() calls, companyQuery/companyInsert/companyUpsert wrappers, .insert([entry]) where entry is a parameter known to carry company_id.

Report: table name, file:line, the violating query snippet.

### 2. PostgREST Injection
- Find all `.or()` calls with string concatenation (`+`) that don't use `escapeFilterValue()`
- Find all `.ilike("field", "%" + variable + "%")` patterns without `escapeFilterValue()`
- Find all `.ilike()` in UPDATE/DELETE chains without `escapeFilterValue()`
- Verify `escapeFilterValue` is imported in every file that has write-operation `.ilike()` or `%`-concatenated `.ilike()`

### 3. XSS Prevention
- Every `dangerouslySetInnerHTML` must trace to DOMPurify.sanitize (directly, via sanitizeTemplateHtml, or via renderMergedBody)
- No unsafe `innerHTML =` assignments (allow: clearing with `""`, DOMPurify-sanitized, hardcoded HTML literals)
- No `eval()` calls
- DOMPurify imported in every file using dangerouslySetInnerHTML

### 4. File Upload Validation
- MIME type whitelist exists (no `text/html` or `text/javascript` allowed)
- Magic bytes validation exists
- File size limits enforced
- `sanitizeFileName()` used for all upload paths
- Avatar uploads validate MIME type

### 5. Authentication & Session
- Inactivity timeout exists
- Auth state listener (onAuthStateChange) present
- Session check on mount (getSession)
- No hardcoded API keys, passwords, or secrets in source (search for common patterns: `sk_live`, `password =`, `secret =`, `apikey =` with literal values)

### 6. Financial Safety
- All financial calculations in DB operations use `safeNum()` not raw `Number()`
- All autopay disable operations scope by property (not just tenant name)
- Recurring entry duplicate guard exists (unique index + SELECT check)
- Journal entry orphan cleanup exists with void fallback
- Proration uses cents-based math

## Output Format
Report findings grouped by severity (CRITICAL / HIGH / MEDIUM / LOW). For each finding, show:
- File path and line number
- Code snippet (truncated to 150 chars)
- What's wrong and how to fix it

If no issues found, report "All clear" for that category.

At the end, show a summary table: category, findings count, severity.
