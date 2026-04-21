# Add Module

Scaffold a new Housify page module with all required wiring.

## Arguments
`/add-module <ModuleName> [--nav-parent <parent_id>] [--role <roles>]`

Examples:
- `/add-module Appliances` — top-level nav item, available to admin + office_assistant
- `/add-module Appliances --nav-parent properties` — child of Properties in sidebar
- `/add-module Appliances --role admin,accountant` — only accessible to specific roles

## Steps

### 1. Create component file
Create `src/components/<ModuleName>.js` with:
```javascript
import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { Btn, PageHeader } from "../ui";
import { safeNum, formatLocalDate, formatCurrency, escapeFilterValue } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { Spinner } from "./shared";

export function <ModuleName>({ addNotification, userProfile, userRole, companyId, showToast, showConfirm }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState([]);

  useEffect(() => {
    // TODO: Fetch data
    setLoading(false);
  }, [companyId]);

  if (loading) return <Spinner />;

  return (
    <div>
      <PageHeader title="<ModuleName>" />
      {/* TODO: Build UI */}
    </div>
  );
}
```

### 2. Update App.js imports
Add import line after the existing component imports:
```javascript
import { <ModuleName> } from "./components/<ModuleName>";
```

### 3. Update pageComponents map
Add entry to the `pageComponents` object in App.js:
```javascript
<module_id>: <ModuleName>,
```

### 4. Update ALL_NAV
If `--nav-parent` specified, add as child of that parent. Otherwise add as top-level:
```javascript
{ id: "<module_id>", label: "<Module Name>", icon: "<material_icon>" }
```
Choose an appropriate Material Icons Outlined icon name.

### 5. Update ROLES
Add the module_id to the `pages` arrays in the ROLES constant for the specified roles (default: admin, office_assistant).

### 6. Create E2E test stub
Create `tests/e2e/XX-<module-name>.spec.js` with basic navigation + render test:
```javascript
const { test, expect } = require('@playwright/test');
const { login, navigateTo } = require('./helpers');

test.describe('<ModuleName>', () => {
  test.beforeEach(async ({ page }) => { await login(page); });
  
  test('navigates to <module_name> page', async ({ page }) => {
    await navigateTo(page, '<module_id>');
    await expect(page.locator('text=<ModuleName>')).toBeVisible();
  });
});
```

### 7. Update CLAUDE.md
Add the new module to the "App Modules" list.

### 8. Update refactor-validation tests
Add the new component file to the expected files list in `tests/refactor-validation.test.js`.

### 9. Build and verify
Run `npm run build`. Fix any issues.

### 10. Report
Show all files created/modified and next steps (what to implement in the component).
