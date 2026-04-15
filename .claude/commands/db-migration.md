# DB Migration

Generate and deploy a Supabase database migration with conflict handling and safety checks.

## Arguments
`/db-migration <description>`

Examples:
- `/db-migration add unique index on company_id + reference for journal entries`
- `/db-migration add column property_id to tenants table`
- `/db-migration create RPC for atomic payment posting`

## Steps

### 1. Determine migration number
Read `supabase/migrations/` directory, find the highest numbered file, increment by 1.
Format: `YYYYMMNN_description.sql` where YYYYMM is current year-month and NN is sequential.

### 2. Analyze the request
Based on the description, determine:
- What SQL DDL/DML is needed
- What existing data could conflict (e.g., duplicate keys for new unique indexes, null values for new NOT NULL columns)
- What dependent queries in the codebase need updating

### 3. Pre-check for conflicts
Before writing the migration, use the Supabase SQL editor pattern to check for conflicts:
- For new UNIQUE indexes: query for existing duplicates that would block creation
- For new NOT NULL columns: check for existing null values
- For column renames: grep codebase for old column name usage
- For table drops: grep for all references

### 4. Write migration with conflict handling
Create the migration file in `supabase/migrations/` with:
- Comment header explaining what it does and why
- Step 1: Clean up conflicting data (e.g., void duplicates, backfill nulls)
- Step 2: Apply the DDL change
- Step 3: Verify (optional assertion queries)

Always use:
- `IF NOT EXISTS` for CREATE INDEX/TABLE
- `IF EXISTS` for DROP operations
- Transaction-safe operations where possible
- Explicit `WHERE` clauses for UPDATE cleanup (never update all rows blindly)

### 5. Show migration to user
Display the full SQL and explain:
- What data cleanup will happen
- What the DDL change does
- What the blast radius is (which queries/features are affected)
- Whether it's reversible

### 6. Deploy
After user confirms, run: `npx supabase db push`
If it fails:
- Read the error
- Check for remaining data conflicts
- Adjust the migration
- Retry

### 7. Update codebase
If the migration changes schema (new column, renamed column, new RPC):
- Update affected queries in `src/`
- Update test assertions if schema tests check for this
- Run `npm run build` to verify

### 8. Report
Show: migration file path, SQL executed, rows affected by cleanup, deployment status.

## Safety Rules
- NEVER drop tables or columns without explicit user confirmation
- ALWAYS handle existing data before adding constraints
- ALWAYS use IF NOT EXISTS / IF EXISTS
- NEVER run migrations that could lock tables for extended periods on production data
- For large table modifications (>100K rows), suggest running during off-hours
