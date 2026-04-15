# Extract Component

Extract a function or component from one file into its own module file. Handles all imports, exports, and build verification.

## Arguments
This command expects arguments in the format: `<function_name> from <source_file> to <target_file>`

Example: `/extract-component Dashboard from src/App.js to src/components/Dashboard.js`

## Steps

### 1. Locate the function
Read the source file. Find the function by name (`function FUNCNAME` or `const FUNCNAME =`). Determine its exact start line and end line (matching closing brace/bracket at the same indentation level).

### 2. Analyze dependencies
Scan the function body for:
- **React hooks**: useState, useEffect, useRef, etc. -> need React import
- **Supabase calls**: .from(), .rpc(), .storage -> need supabase import
- **UI components**: Input, Btn, Card, PageHeader, etc. -> need ../ui import
- **Utils**: safeNum, pmError, guardSubmit, logAudit, etc. -> need ../utils/* imports
- **Shared components**: Modal, Spinner, Badge, etc. -> need ./shared import
- **External libraries**: DOMPurify, ExcelJS -> need direct imports
- **Other local functions**: If the function calls another function defined in the same file, that dependency must either be extracted too or imported

### 3. Create the target file
Write the new file with:
- All necessary import statements (determined in step 2)
- The extracted function code, EXACTLY as-is, with `export` added
- Named export at the bottom if not already exported inline

### 4. Update the source file
- Remove the function definition from the source file
- Add an import statement at the top of the source file: `import { FUNCNAME } from "./path/to/target"`
- If other functions in the source file call the extracted function, they'll now get it via the import

### 5. Check for other importers
Search ALL files in `src/` for references to the function name. If any other file was importing it from the source file, update those imports to point to the new target file.

### 6. Build and verify
Run `npm run build`. If it fails:
- Read the error message
- Fix the issue (usually a missing import or export)
- Rebuild until it passes

### 7. Report
Show: what was extracted, from where, to where, how many lines, what imports were added, build status.

## Rules
- NEVER change any logic inside the extracted function
- NEVER rename any function, variable, or parameter
- Keep the dependency graph one-directional: utils -> components -> App.js (never backward)
- If a circular dependency would be created, use a setter/injection pattern (like setHelperPmError)
