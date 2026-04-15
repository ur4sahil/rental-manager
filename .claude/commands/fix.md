# Fix — Disciplined Problem Solving

Follow the mandatory problem-solving process for any bug fix or change. No shortcuts. No trial-and-error.

## Arguments
`/fix <description of the problem>`

## Process (NEVER skip any step)

### Step 1: Understand the problem
- Read logs, errors, symptoms
- State the problem clearly with evidence
- What EXACTLY is broken? What's the expected vs actual behavior?
- When did it start? What changed recently?

### Step 2: Understand the system
- Read the relevant code (not just the line that errors — the full function, its callers, its dependencies)
- Check memory for known constraints (Supabase limits, VPS resources, API rate limits, CDN auth tokens)
- Understand the data flow end-to-end: where does the data come from, how is it transformed, where does it go?

### Step 3: Verify assumptions
Before writing ANY code, test key assumptions:
- Does the function get called at all? (add a console.log or check network tab)
- Is the input what we expect? (log the actual values)
- Does the DB query return what we think? (run it in Supabase SQL editor)
- Is the error from our code or a dependency?

### Step 4: Identify root cause
- What is the ACTUAL cause, not just the symptom?
- Why does THIS input cause THIS error?
- Are there other places with the same pattern that could also be broken?

### Step 5: Plan the fix
Present to the user:
- **Problem:** One sentence describing the root cause
- **Why it happens:** Technical explanation
- **Option A:** [approach] — pros, cons, blast radius
- **Option B:** [approach] — pros, cons, blast radius
- **Recommendation:** Which option and why
- **Blast radius:** What else could be affected by this change?
- **Tests needed:** What tests verify the fix works?

### Step 6: Wait for approval
Do NOT code until the user confirms the approach. If they have questions, answer them. If they suggest a different approach, evaluate it honestly.

### Step 7: Implement
- ONE implementation. Not multiple attempts.
- Change ONLY what's needed. No drive-by refactors.
- If the fix touches financial logic, use cents-based math.
- If the fix touches queries, include company_id and escapeFilterValue where needed.
- If the fix touches file handling, validate MIME types.

### Step 8: Test end-to-end
- Run `npm run build` — must pass
- Run relevant test suite(s) — must pass
- Trace the full pipeline: input -> transform -> store -> display
- Check that the fix actually resolves the original symptom
- Check that nothing else broke (run full test suite if the change is broad)

### Step 9: Push
Only after confirming it works:
- `git add` the specific changed files
- Commit with a descriptive message explaining the WHY
- `git push origin main`

## Rules
- NEVER jump to coding without understanding the problem and system first
- NEVER push untested code
- NEVER iterate on production — get it right locally first
- If the first attempt fails, go back to Step 1, not Step 7
- ONE plan, ONE implementation, ONE test, ONE push
