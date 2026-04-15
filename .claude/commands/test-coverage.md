# Test Coverage Analysis

Analyze the test suite against the codebase to identify gaps, missing tests, and coverage issues.

## Steps

### 1. Inventory all source modules
Read `src/components/` and `src/utils/`. For each file, extract all exported function names. Build a map: `{ file: [functionName, ...] }`.

### 2. Inventory all test files
Read `tests/`. For each test file:
- Count total assertions (search for `assert(` calls)
- List test group names (search for `console.log` section headers)
- Identify which source functions are tested (search for function names from step 1)

For E2E tests in `tests/e2e/`:
- Count test specs (search for `test(` or `it(` calls)
- Identify which pages/flows are covered

### 3. Cross-reference coverage
For each source module, report:
- Number of exported functions
- Number of those functions mentioned in test assertions
- Coverage percentage
- Which functions have ZERO test coverage

### 4. Identify critical gaps
Flag as **CRITICAL** any untested:
- Functions that write to the database (INSERT/UPDATE/DELETE)
- Functions that handle money (payments, balances, fees, distributions)
- Functions that handle authentication or authorization
- Functions in `utils/accounting.js` or `utils/company.js`

Flag as **HIGH** any untested:
- Functions with more than 50 lines of code
- Functions that call external APIs (Supabase RPCs, fetch calls)
- Functions that handle file uploads or encryption

### 5. Suggest new tests
For each untested critical function, generate a test stub:
- For unit-testable functions (pure logic): write the full test with assertions
- For DB-dependent functions: write a test that verifies the function exists and has key patterns (similar to our code-pattern tests)
- For E2E flows: suggest the user flow to test and what assertions to make

### 6. Check test quality
- Are there tests that only assert `true`? (false-positive tests)
- Are there tests that test implementation details instead of behavior?
- Do financial tests use boundary values (0, negative, very large numbers)?
- Do security tests use adversarial inputs?

### 7. Report
Output a coverage table:

| Module | Functions | Tested | Coverage | Critical Gaps |
|--------|-----------|--------|----------|---------------|

Then list the top 10 highest-priority missing tests with suggested implementations.

Finally show the total: `X/Y functions tested (Z%)` and `A/B critical functions tested (C%)`.
