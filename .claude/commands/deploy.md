# PropManager Deploy

Full verification pipeline before deploying to production. Aborts on any failure.

## Pipeline

### Step 1: Build
Run `npm run build`. If it fails, show the error and STOP. Do not proceed.

### Step 2: Run all test suites
Run each test file in `tests/` sequentially:
```
node tests/infra.test.js
node tests/data-layer.test.js
node tests/supabase-schema.test.js
node tests/error-management.test.js
node tests/bank-transactions.test.js
node tests/refactor-validation.test.js
node tests/financial-integrity.test.js
node tests/security-adversarial.test.js
```
For each: capture pass/fail count. If ANY test fails, show which tests failed and STOP. Do not proceed.

### Step 3: Check working tree
Run `git status`. If there are:
- Unstaged changes: show them and ask if they should be included
- Untracked files in `src/`: warn that they won't be deployed
- If clean: proceed

### Step 4: Check for pending migrations
Check if `supabase/migrations/` has any files not yet pushed:
- Run `npx supabase db push --dry-run` if available, or check migration status
- If there are pending migrations, list them and ask if they should be pushed first

### Step 5: Commit
If there are staged/unstaged changes:
- Show a diff summary
- Generate a descriptive commit message based on the changes
- Commit with the message

### Step 6: Push
Run `git push origin main`. Vercel auto-deploys on push.

### Step 7: Report
Show deployment summary:
```
Build:      PASS
Tests:      X/Y passed (Z%)
Migrations: N pending (pushed/skipped)
Commit:     <hash> <message>
Deploy:     Pushed to main — Vercel auto-deploying
URL:        https://rental-manager-one.vercel.app
```

## Abort Conditions
- Build fails -> STOP
- Any test fails -> STOP (show failures)
- User cancels at any prompt -> STOP
- Git push fails -> STOP (show error)

## Rules
- NEVER skip tests
- NEVER force push
- NEVER push with failing tests
- Always show test results before committing
- If security-adversarial tests have failures, warn prominently even if they're known issues
