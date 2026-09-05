// ═══════════════════════════════════════════════════════════════════════
// 82 — UX QUALITY & ACCESSIBILITY
//
// Everything else in this suite asks "does the feature work". This file
// asks "can a person actually use it": can a screen reader name the
// controls, can a keyboard reach them, does anything fall off a phone,
// and does the app admit it when the data never arrived.
//
// ── How this file decides what fails ──────────────────────────────────
// A permanently-red suite gets ignored, and an all-green one that
// asserts nothing is worse. So the split is deliberate:
//
//   HARD FAILURE  — rules the app satisfies today. If one starts firing
//                   that is a regression somebody just introduced.
//   RATCHET       — rules the app already violates (KNOWN_ISSUES below).
//                   Reported in full on every run; the test fails only
//                   when a page grows a NEW critical/serious rule, or
//                   when a structural one spreads past its ceiling.
//   FINDING       — behaviour that is bad but arguably deliberate, or a
//                   whole missing feature (a modal with no focus trap).
//                   Printed as `FINDING:` and attached to the report.
//                   Never fails the run. Grep `FINDING:` for the list.
//
// Findings recorded on 2026-09-04 against company `e2e-sandbox` are
// summarised at the bottom of this file.
// ═══════════════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const {
  gotoRoute,
  assertNoHorizontalOverflow,
  assertButtonsClickable,
  assertModalIsTopLayer,
} = require('./helpers');

// ── Finding plumbing ──────────────────────────────────────────────────
// Reported, never thrown. Printed inline so `--reporter=list` shows it,
// and annotated so it survives into the HTML report.
function finding(testInfo, where, text) {
  const line = `FINDING: [${where}] ${text}`;
  // eslint-disable-next-line no-console
  console.log('  ' + line);
  testInfo.annotations.push({ type: 'ux-finding', description: `[${where}] ${text}` });
}

// ── Axe configuration ─────────────────────────────────────────────────
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

// Rules the app is clean on today. Every one of these maps onto
// something the brief asked for — alt text, labelled inputs, named
// buttons, heading order — so a new violation is a real regression and
// fails the run outright.
const MUST_BE_CLEAN = new Set([
  // images have alt text
  'image-alt', 'input-image-alt', 'area-alt', 'object-alt', 'role-img-alt',
  'image-redundant-alt', 'svg-img-alt',
  // form inputs have labels
  'label', 'form-field-multiple-labels', 'aria-input-field-name',
  'aria-toggle-field-name',
  // buttons and links have accessible names
  'button-name', 'link-name', 'input-button-name', 'aria-command-name',
  // heading structure
  'heading-order', 'empty-heading',
  // ARIA that is actively wrong rather than merely absent
  'aria-allowed-attr', 'aria-allowed-role', 'aria-required-attr',
  'aria-required-children', 'aria-required-parent', 'aria-roles',
  'aria-valid-attr', 'aria-valid-attr-value', 'aria-hidden-body',
  'aria-hidden-focus', 'nested-interactive', 'duplicate-id-active',
  'duplicate-id-aria',
  // structure / language
  'html-has-lang', 'html-lang-valid', 'valid-lang', 'frame-title',
  'list', 'listitem', 'definition-list', 'dlitem',
  'td-headers-attr', 'th-has-data-cells', 'table-fake-caption',
  'meta-viewport',
]);

// Critical/serious rules each surface already fails. Ratchet, not
// amnesty: anything NOT on a surface's list fails that surface's test.
const KNOWN_ISSUES = {
  dashboard:    ['color-contrast', 'scrollable-region-focusable'],
  properties:   ['color-contrast', 'select-name'],
  tenants:      ['color-contrast', 'select-name'],
  payments:     ['color-contrast', 'label-title-only'],
  accounting:   ['color-contrast', 'scrollable-region-focusable'],
  acct_reports: ['color-contrast', 'scrollable-region-focusable'],
  modal:        ['color-contrast', 'scrollable-region-focusable'],
  palette:      ['color-contrast', 'scrollable-region-focusable'],
  shortcuts:    ['color-contrast', 'scrollable-region-focusable'],
};

// Structural known-issues are not data-dependent — a filter bar has a
// fixed number of <select>s no matter how many rows load — so they get
// a node ceiling. Contrast is left uncapped because its node count
// tracks how many records happen to be on screen.
const NODE_CEILING = {
  'select-name': 6,
  'label-title-only': 4,
  'scrollable-region-focusable': 4,
};

// Mid-flight fade-in animations make axe sample a half-transparent
// colour and report contrast failures that do not exist at rest. Freeze
// animation so the scan measures the settled page.
async function freezeAnimations(page) {
  await page.addStyleTag({
    content: `*,*::before,*::after{animation-duration:0s!important;
      animation-delay:0s!important;transition-duration:0s!important;
      transition-delay:0s!important;}`,
  });
  await page.waitForTimeout(400);
}

function summarise(violations) {
  const by = { critical: [], serious: [], moderate: [], minor: [] };
  for (const v of violations) (by[v.impact] || by.minor).push(v);
  return by;
}

function report(testInfo, surface, violations) {
  const by = summarise(violations);
  const lines = [`\n  ── axe: ${surface} ──`];
  for (const sev of ['critical', 'serious', 'moderate', 'minor']) {
    if (!by[sev].length) continue;
    lines.push(`  ${sev.toUpperCase()} (${by[sev].length} rule(s)):`);
    for (const v of by[sev]) {
      lines.push(`    • ${v.id} ×${v.nodes.length} — ${v.help}`);
      for (const n of v.nodes.slice(0, 3)) {
        lines.push(`        ${n.target.join(' ')}`);
        lines.push(`        ${(n.html || '').replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
  }
  if (lines.length === 1) lines.push('  no violations');
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
  testInfo.annotations.push({ type: 'axe', description: `${surface}: ` +
    violations.map(v => `${v.impact}/${v.id}×${v.nodes.length}`).join(', ') });
  return by;
}

// Shared assertion body for every axe scan.
function assertAxe(testInfo, surface, violations) {
  const by = report(testInfo, surface, violations);

  const regressions = violations
    .filter(v => MUST_BE_CLEAN.has(v.id))
    .map(v => `${v.id} ×${v.nodes.length} (${v.nodes[0].target.join(' ')})`);
  expect(regressions,
    `${surface}: rules this app is otherwise clean on started failing — ` +
    `alt text, input labels, button names or heading order regressed`).toEqual([]);

  const allowed = KNOWN_ISSUES[surface] || [];
  const unexpected = [...by.critical, ...by.serious]
    .filter(v => !allowed.includes(v.id))
    .map(v => `${v.impact}/${v.id} ×${v.nodes.length} — ${v.help} @ ${v.nodes[0].target.join(' ')}`);
  expect(unexpected,
    `${surface}: NEW critical/serious accessibility violations. Either fix ` +
    `them or add the rule id to KNOWN_ISSUES.${surface} with a reason`).toEqual([]);

  const spread = violations
    .filter(v => NODE_CEILING[v.id] && v.nodes.length > NODE_CEILING[v.id])
    .map(v => `${v.id}: ${v.nodes.length} nodes > ceiling ${NODE_CEILING[v.id]}`);
  expect(spread,
    `${surface}: a known structural violation spread to more elements`).toEqual([]);
}

// ═══════════════════════════════════════════════════════════════════════
// 1. ACCESSIBILITY — axe across the main pages
// ═══════════════════════════════════════════════════════════════════════
test.describe('Accessibility — axe scans', () => {
  const PAGES = ['dashboard', 'properties', 'tenants', 'payments', 'accounting', 'acct_reports'];

  for (const route of PAGES) {
    test(`${route} has no unreviewed critical or serious violations`, async ({ page }, testInfo) => {
      await gotoRoute(page, route);
      await page.waitForTimeout(2500);
      await freezeAnimations(page);
      const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      assertAxe(testInfo, route, violations);
    });
  }

  test('a modal is accessible to a screen reader', async ({ page }, testInfo) => {
    await gotoRoute(page, 'properties');
    // Timeline is read-only — it cannot mutate the sandbox — and it is
    // rendered by the shared <Modal> in components/shared.js, so what it
    // does here is what every modal in the app does.
    const trigger = page.locator('main button:visible:has-text("Timeline")').first();
    await trigger.waitFor({ timeout: 20000 });
    await trigger.click();
    const overlay = page.locator('div.fixed.inset-0').first();
    await overlay.waitFor({ state: 'visible', timeout: 10000 });
    await freezeAnimations(page);

    const { violations } = await new AxeBuilder({ page })
      .include('div.fixed.inset-0').withTags(AXE_TAGS).analyze();
    assertAxe(testInfo, 'modal', violations);

    // The shared Modal is a plain <div>: no role, no aria-modal, no
    // aria-labelledby. Assistive tech is told nothing about it. axe
    // cannot flag this (an unannounced div is legal HTML), so check it
    // directly and report it.
    const semantics = await overlay.evaluate(el => ({
      role: el.getAttribute('role'),
      ariaModal: el.getAttribute('aria-modal'),
      labelled: el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'),
    }));
    if (semantics.role !== 'dialog') {
      finding(testInfo, 'modal', 'shared <Modal> (src/components/shared.js:84) renders a bare ' +
        '<div class="fixed inset-0 z-[60]"> with no role="dialog", no aria-modal and no ' +
        'aria-labelledby — a screen reader never announces that a dialog opened. ' +
        `Got role=${semantics.role}, aria-modal=${semantics.ariaModal}, label=${semantics.labelled}. ` +
        'The command palette and shortcuts sheet do this correctly; the shared Modal does not.');
    }

    // Whatever else is wrong, it must at least be the top layer.
    await assertModalIsTopLayer(page, 'div.fixed.inset-0');
  });

  test('command palette and shortcuts sheet are accessible', async ({ page }, testInfo) => {
    await gotoRoute(page, 'dashboard');

    await page.keyboard.press('Meta+k');
    const palette = page.locator('[role="dialog"][aria-modal="true"]').first();
    await palette.waitFor({ state: 'visible', timeout: 10000 });
    await freezeAnimations(page);
    const pal = await new AxeBuilder({ page })
      .include('[role="dialog"]').withTags(AXE_TAGS).analyze();
    assertAxe(testInfo, 'palette', pal.violations);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    await page.keyboard.press('?');
    const sheet = page.locator('[role="dialog"][aria-label="Keyboard shortcuts"]');
    await sheet.waitFor({ state: 'visible', timeout: 10000 });
    await freezeAnimations(page);
    const sc = await new AxeBuilder({ page })
      .include('[aria-label="Keyboard shortcuts"]').withTags(AXE_TAGS).analyze();
    assertAxe(testInfo, 'shortcuts', sc.violations);
    await page.keyboard.press('Escape');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. KEYBOARD NAVIGATION
// ═══════════════════════════════════════════════════════════════════════
test.describe('Keyboard navigation', () => {
  test('tab order on a form-heavy page follows the visual order', async ({ page }, testInfo) => {
    // Properties carries the densest filter bar in the app: a search
    // box, three <select>s, three view toggles and the create button.
    await gotoRoute(page, 'properties');
    await page.waitForTimeout(1500);

    // A positive tabindex overrides document order for the WHOLE page
    // and is the single most common way tab order gets scrambled.
    const positive = await page.evaluate(() =>
      [...document.querySelectorAll('[tabindex]')]
        .filter(e => Number(e.getAttribute('tabindex')) > 0)
        .map(e => e.tagName + '[tabindex=' + e.getAttribute('tabindex') + ']'));
    expect(positive,
      'a positive tabindex re-orders the whole page and almost always ' +
      'produces a tab order that does not match what is on screen').toEqual([]);

    // Walk 25 stops and record where focus lands.
    await page.locator('main input[placeholder*="earch" i]').first().focus();
    const stops = [];
    for (let i = 0; i < 25; i++) {
      const stop = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a || a === document.body) return null;
        const r = a.getBoundingClientRect();
        return {
          tag: a.tagName,
          label: (a.innerText || a.placeholder || a.getAttribute('aria-label') || '')
            .split('\n').filter(Boolean).pop() || '',
          x: Math.round(r.left), y: Math.round(r.top),
          w: Math.round(r.width), h: Math.round(r.height),
          inMain: !!a.closest('main'),
          // Serialise position so DOM order can be compared without
          // shipping element handles back and forth.
          idx: (() => {
            const all = [...document.querySelectorAll('*')];
            return all.indexOf(a);
          })(),
        };
      });
      if (stop) stops.push(stop);
      await page.keyboard.press('Tab');
    }
    expect(stops.length,
      'tabbing from the search box should reach a run of focusable controls')
      .toBeGreaterThan(8);

    // Every stop must be a real, on-screen, non-zero-size target. A
    // focus stop you cannot see is a keyboard trap in slow motion.
    const invisible = stops.filter(s => s.w < 4 || s.h < 4);
    expect(invisible.map(s => `${s.tag} "${s.label}" ${s.w}x${s.h}`),
      'tab reached a zero-size element — a keyboard user would see focus vanish').toEqual([]);

    // Within <main>, tab order must follow DOM order. React portals and
    // absolutely-positioned toolbars are the usual way this breaks.
    const inMain = stops.filter(s => s.inMain);
    const outOfOrder = [];
    for (let i = 1; i < inMain.length; i++) {
      if (inMain[i].idx < inMain[i - 1].idx) {
        outOfOrder.push(`"${inMain[i - 1].label}" → "${inMain[i].label}"`);
      }
    }
    expect(outOfOrder,
      'tab order jumped backwards through the document inside <main>').toEqual([]);

    // Focus has to be visible. Report rather than fail: several controls
    // style focus with a border-colour change that this check cannot see.
    const noRing = await page.evaluate(() => {
      const out = [];
      for (const el of [...document.querySelectorAll('main button, main input, main select')].slice(0, 30)) {
        el.focus();
        const cs = getComputedStyle(el);
        const ring = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
        const shadow = cs.boxShadow && cs.boxShadow !== 'none';
        if (!ring && !shadow) out.push((el.innerText || el.placeholder || el.tagName).split('\n').pop().slice(0, 24));
      }
      return out;
    });
    if (noRing.length) {
      finding(testInfo, 'properties/keyboard',
        `${noRing.length} of the first 30 controls show no outline and no box-shadow when ` +
        `focused, so a keyboard user cannot tell where they are: ${noRing.slice(0, 8).join(', ')}. ` +
        'The app sets focus:outline-none on its form primitives and replaces it with a ' +
        'border-colour change only (focus:border-brand-300), which is a ~1.2:1 change.');
    }
  });

  test('command palette is fully keyboard-operable', async ({ page }, testInfo) => {
    await gotoRoute(page, 'dashboard');
    // Page identity, not full text: the dashboard's counters tick.
    const pageIdentity = () => page.locator('main').innerText()
      .then(t => t.split('\n').filter(Boolean).slice(0, 3).join(' / '));
    const before = await pageIdentity();

    // Opens from anywhere, with no pointer involved.
    await page.keyboard.press('Meta+k');
    const palette = page.locator('[role="dialog"][aria-modal="true"]').first();
    await expect(palette).toBeVisible({ timeout: 10000 });

    // The search box must take focus on its own — otherwise the first
    // thing a keyboard user types goes nowhere. CommandPalette.js:118
    // does this on a setTimeout, so sample where focus is the instant
    // the dialog paints, then wait for it to actually arrive.
    const immediate = await page.evaluate(() => ({
      tag: document.activeElement.tagName,
      inDialog: !!document.activeElement.closest('[role="dialog"]'),
    }));
    await expect
      .poll(() => page.evaluate(() => document.activeElement.tagName), { timeout: 3000 })
      .toBe('INPUT');
    const focused = await page.evaluate(() => ({
      inDialog: !!document.activeElement.closest('[role="dialog"]'),
      label: document.activeElement.getAttribute('aria-label'),
    }));
    expect(focused.inDialog, 'focus must be inside the palette, not left behind it').toBeTruthy();
    expect(focused.label, 'the focused control must be the palette search box')
      .toBe('Search pages and actions');

    if (!immediate.inDialog) {
      finding(testInfo, 'command palette',
        'the palette paints before it takes focus — CommandPalette.js:118 focuses the input ' +
        `on a 20ms setTimeout, so at the moment the dialog becomes visible focus is still on ` +
        `<${immediate.tag.toLowerCase()}> behind it. Anything typed in that window goes to the ` +
        'page underneath, and because the shortcuts handler only suppresses "?" when the event ' +
        'target is a field (KeyboardShortcuts.js:93), a "?" typed in that window opens the ' +
        'shortcuts sheet on top of the palette. Reproduced on every run of this spec.');
    }

    // Typing filters.
    await page.keyboard.type('reco');
    await page.waitForTimeout(500);
    const options = page.locator('[role="option"]');
    await expect(options.first()).toBeVisible({ timeout: 5000 });
    await expect(options.first()).toContainText(/Reconcile/i);

    // Arrows move the active option, and the move is exposed to
    // assistive tech rather than being a purely visual highlight.
    const activeIndex = () => page.evaluate(() =>
      [...document.querySelectorAll('[role="option"]')]
        .findIndex(o => o.getAttribute('aria-selected') === 'true'));
    const total = await options.count();
    expect(total, 'typing "reco" should return at least two commands').toBeGreaterThan(1);
    expect(await activeIndex(), 'first result should start selected').toBe(0);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);
    expect(await activeIndex(), 'ArrowDown must move the aria-selected option').toBe(1);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(200);
    expect(await activeIndex(), 'ArrowUp must move it back').toBe(0);

    // Escape closes without running anything.
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden({ timeout: 5000 });
    expect(await pageIdentity(),
      'Escape must dismiss the palette without navigating').toBe(before);

    // Enter runs the highlighted command.
    await page.keyboard.press('Meta+k');
    await expect(palette).toBeVisible({ timeout: 10000 });
    await expect
      .poll(() => page.evaluate(() => document.activeElement.tagName), { timeout: 3000 })
      .toBe('INPUT');
    await page.keyboard.type('reco');
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await expect(palette).toBeHidden({ timeout: 8000 });
    await page.waitForTimeout(4000);
    const after = await page.locator('body').innerText();
    expect(after.includes('Reconcile') || after.includes('Reconciliation'),
      'Enter on the highlighted result must actually navigate there').toBeTruthy();
  });

  test('shortcuts sheet opens with ? and closes with Escape', async ({ page }, testInfo) => {
    await gotoRoute(page, 'dashboard');
    const sheet = page.locator('[role="dialog"][aria-label="Keyboard shortcuts"]');

    await page.keyboard.press('?');
    await expect(sheet).toBeVisible({ timeout: 10000 });
    await expect(sheet).toContainText('Open the command palette');

    // The close control must be operable from the keyboard alone.
    const close = sheet.locator('button[aria-label="Close"]');
    await expect(close).toHaveCount(1);
    await close.focus();
    await page.keyboard.press('Enter');
    await expect(sheet).toBeHidden({ timeout: 5000 });

    // Escape must close it too.
    await page.keyboard.press('?');
    await expect(sheet).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden({ timeout: 5000 });

    // "?" must not fire while typing, or it would eat the character.
    await page.keyboard.press('Meta+k');
    const palette = page.locator('[role="dialog"][aria-modal="true"]').first();
    await expect(palette).toBeVisible({ timeout: 10000 });
    // Wait for the palette to actually take focus first — it does so on a
    // setTimeout, and typing into the gap sends the keystrokes to the page
    // behind (see the finding recorded in the palette test above).
    await expect
      .poll(() => page.evaluate(() => document.activeElement.tagName), { timeout: 3000 })
      .toBe('INPUT');
    await page.keyboard.type('a?b');
    await page.waitForTimeout(400);
    await expect(sheet, '"?" typed into a text field must not open the help sheet').toBeHidden();
    const typed = await page.locator('[role="dialog"] input').first().inputValue();
    expect(typed, 'the "?" keystroke must land in the field, not be swallowed').toContain('?');
    await page.keyboard.press('Escape');

    // Focus containment. The sheet declares aria-modal="true", which
    // promises the rest of the page is inert — but nothing keeps focus
    // inside it, so Tab walks straight out into the sidebar behind.
    await page.keyboard.press('?');
    await expect(sheet).toBeVisible({ timeout: 10000 });
    const trail = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      trail.push(await page.evaluate(() => {
        const a = document.activeElement;
        return {
          tag: a.tagName,
          label: (a.getAttribute('aria-label') || a.innerText || '').split('\n').filter(Boolean).pop() || '',
          inside: !!(a.closest && a.closest('[aria-label="Keyboard shortcuts"]')),
        };
      }));
    }
    const escaped = trail.filter(t => !t.inside);
    if (escaped.length) {
      finding(testInfo, 'shortcuts sheet',
        `aria-modal="true" is set but focus is not trapped: ${escaped.length} of 8 Tab presses ` +
        `left the dialog and landed on background chrome ` +
        `(${escaped.slice(0, 3).map(t => `${t.tag} "${t.label}"`).join(', ')}). ` +
        'A screen-reader user tabbing past the last item silently ends up in a page ' +
        'their software has been told is inert.');
    }
    await page.keyboard.press('Escape');
  });

  test('a modal traps focus, closes on Escape and restores focus', async ({ page }, testInfo) => {
    await gotoRoute(page, 'properties');
    const trigger = page.locator('main button:visible:has-text("Timeline")').first();
    await trigger.waitFor({ timeout: 20000 });
    await trigger.focus();
    const triggerId = await page.evaluate(() => {
      document.activeElement.setAttribute('data-ux-trigger', '1');
      return document.activeElement.outerHTML.slice(0, 60);
    });

    await trigger.click();
    const overlay = page.locator('div.fixed.inset-0').first();
    await expect(overlay).toBeVisible({ timeout: 10000 });

    // (a) does focus move into the dialog?
    const movedIn = await page.evaluate(() =>
      !!(document.activeElement && document.activeElement.closest('div.fixed.inset-0')));
    if (!movedIn) {
      finding(testInfo, 'modal focus',
        'opening a modal leaves focus on the trigger button behind the overlay. ' +
        'A keyboard user has to Tab through the whole page underneath before ' +
        'reaching the dialog content.');
    }

    // (b) is focus trapped?
    const trail = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      trail.push(await page.evaluate(() =>
        !!(document.activeElement && document.activeElement.closest('div.fixed.inset-0'))));
    }
    const leaked = trail.filter(t => !t).length;
    if (leaked) {
      finding(testInfo, 'modal focus',
        `no focus trap: ${leaked} of 8 Tab presses moved focus to page content behind the ` +
        'overlay, which is still fully tabbable while the modal is up.');
    }

    // (c) does Escape close it?
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    const escapeClosed = await overlay.isVisible().then(v => !v).catch(() => true);
    if (!escapeClosed) {
      finding(testInfo, 'modal focus',
        'Escape does not close the shared <Modal>. The only way out is the × button — ' +
        'src/components/shared.js:84 binds no keydown handler, unlike CommandPalette.js:140 ' +
        'and KeyboardShortcuts.js:132 which both handle Escape correctly.');
    }

    // HARD: however it closes, the close control must work from the
    // keyboard, and the modal must not be dismissable only by mouse.
    if (!escapeClosed) {
      const close = overlay.locator('button').filter({ hasText: 'close' }).first();
      await expect(close, 'a modal must expose a close control').toHaveCount(1);
      await close.focus();
      await page.keyboard.press('Enter');
    }
    await expect(overlay,
      'the modal must be closable using the keyboard alone').toBeHidden({ timeout: 5000 });

    // (d) is focus returned to whatever opened it?
    const restored = await page.evaluate(() =>
      !!(document.activeElement && document.activeElement.getAttribute
        && document.activeElement.getAttribute('data-ux-trigger') === '1'));
    if (!restored) {
      const landed = await page.evaluate(() => document.activeElement.tagName);
      finding(testInfo, 'modal focus',
        `closing the modal does not restore focus to the control that opened it ` +
        `(${triggerId.replace(/\s+/g, ' ')}); focus was dumped on <${landed.toLowerCase()}>, ` +
        'so the next Tab restarts from the top of the document.');
    }
  });

  test('no primary control is reachable by mouse but not by keyboard', async ({ page }, testInfo) => {
    await gotoRoute(page, 'tenants');
    await page.waitForTimeout(1500);

    // HARD: every visible <button> in main must be able to take focus.
    // A disabled-looking-but-enabled button that refuses focus is a
    // dead end for anyone not using a mouse.
    const unfocusable = await page.evaluate(() => {
      const bad = [];
      for (const b of [...document.querySelectorAll('main button')].slice(0, 60)) {
        const r = b.getBoundingClientRect();
        if (!r.width || !r.height || b.disabled) continue;
        b.focus();
        if (document.activeElement !== b) {
          bad.push((b.innerText || b.getAttribute('aria-label') || '?').split('\n').pop().slice(0, 30));
        }
      }
      return bad;
    });
    expect(unfocusable, 'visible, enabled buttons that cannot receive focus').toEqual([]);

    // HARD: anything wearing role="button" must be in the tab order.
    // That is the one case where the app has explicitly claimed a thing
    // is a button, so the keyboard contract is not optional.
    const roleButtonsNoTab = await page.evaluate(() =>
      [...document.querySelectorAll('[role="button"]')]
        .filter(e => !e.hasAttribute('tabindex') && !['BUTTON', 'A'].includes(e.tagName))
        .map(e => e.tagName + ' ' + (e.innerText || '').slice(0, 30)));
    expect(roleButtonsNoTab,
      'role="button" without a tabindex is announced as a button and then ' +
      'cannot be reached or activated by keyboard').toEqual([]);

    // FINDING: clickable <div>s. The tenant/property list is built from
    // cursor-pointer cards rather than buttons, so the primary way to
    // open a record is mouse-only.
    const mouseOnly = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('main *')) {
        if (el.matches('button,a[href],input,select,textarea,[tabindex],[role="button"]')) continue;
        if (getComputedStyle(el).cursor !== 'pointer') continue;
        if (el.closest('button,a[href],[tabindex],[role="button"]')) continue;
        if (el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 20) continue;
        // Pick the longest line so the sample reads as a record name
        // rather than the avatar initial that happens to come first.
        const lines = (el.innerText || '').split('\n').map(t => t.trim()).filter(Boolean);
        out.push(lines.sort((a, b) => b.length - a.length)[0] || el.tagName);
      }
      return out;
    });
    if (mouseOnly.length) {
      finding(testInfo, 'tenants',
        `${mouseOnly.length} clickable elements are plain <div>s with cursor:pointer and no ` +
        'tabindex, role or key handler — they cannot be focused or activated from the ' +
        'keyboard at all. These are the tenant record cards, i.e. the primary way into ' +
        `every tenant on the page (e.g. "${mouseOnly.slice(0, 3).join('", "')}"). ` +
        'The same pattern is used for the Properties cards.');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. RESPONSIVE — iPhone and iPad
// ═══════════════════════════════════════════════════════════════════════
test.describe('Responsive layout', () => {
  const VIEWPORTS = [
    { name: 'iPhone 390x844', width: 390, height: 844 },
    { name: 'iPad 834x1112', width: 834, height: 1112 },
  ];
  const PAGES = ['properties', 'tenants', 'payments', 'accounting', 'acct_journal'];

  // Tables that are already clipped with no way to scroll to the hidden
  // columns. Same ratchet as KNOWN_ISSUES above: reported in full every
  // run, but only a NEW clipped table fails the suite.
  const KNOWN_CLIPPED = new Set(['payments@iPhone 390x844']);

  for (const vp of VIEWPORTS) {
    test(`${vp.name}: nothing overflows, is clipped, or loses its scroll container`,
      async ({ page }, testInfo) => {
        // The sidebar collapses behind a hamburger below md, and
        // gotoRoute drives the sidebar. So navigate wide, then shrink —
        // which also exercises the reflow rather than a fresh render.
        for (const route of PAGES) {
          await page.setViewportSize({ width: 1280, height: 900 });
          await gotoRoute(page, route);
          await page.setViewportSize({ width: vp.width, height: vp.height });
          await page.waitForTimeout(1800);

          // HARD: the document itself must never scroll sideways.
          await assertNoHorizontalOverflow(page);

          // HARD: primary actions stay within reach.
          await assertButtonsClickable(page);

          const layout = await page.evaluate(() => {
            const vw = document.documentElement.clientWidth;
            const scrollerFor = (el) => {
              let a = el.parentElement;
              while (a && a !== document.body) {
                if (a.scrollWidth > a.clientWidth + 2 &&
                    /auto|scroll/.test(getComputedStyle(a).overflowX)) {
                  return a.className.toString().slice(0, 70);
                }
                a = a.parentElement;
              }
              return null;
            };
            // Tables either fit, or live inside something that scrolls.
            const clipperFor = (el) => {
              let a = el.parentElement;
              while (a && a !== document.body) {
                if (a.scrollWidth > a.clientWidth + 2 &&
                    getComputedStyle(a).overflowX === 'hidden') return a;
                a = a.parentElement;
              }
              return null;
            };
            const tables = [...document.querySelectorAll('table')].map(t => {
              const clip = clipperFor(t);
              return {
                w: Math.round(t.scrollWidth),
                fits: t.scrollWidth <= vw + 2,
                scroller: scrollerFor(t),
                clipper: clip ? clip.className.toString().slice(0, 70) : null,
                clipped: clip ? clip.clientWidth : null,
                ownScroller: (() => {
                  const p = t.parentElement;
                  return p && /auto|scroll/.test(getComputedStyle(p).overflowX)
                    ? p.className.toString().slice(0, 70) : null;
                })(),
              };
            });
            // Controls hanging off the right edge with nothing to
            // scroll them into view are simply unreachable.
            const stranded = [];
            for (const el of document.querySelectorAll('main button, main a[href], main input, main select')) {
              const r = el.getBoundingClientRect();
              if (!r.width || !r.height) continue;
              if (r.right <= vw + 2 && r.left >= -2) continue;
              stranded.push({
                label: (el.innerText || el.placeholder || el.getAttribute('aria-label') || '?')
                  .split('\n').filter(Boolean).pop().slice(0, 28),
                right: Math.round(r.right), vw,
                scroller: scrollerFor(el),
              });
            }
            return { vw, tables, stranded };
          });

          // A table wider than the phone must have SOMETHING that scrolls
          // it, or its right-hand columns are simply gone.
          const key = `${route}@${vp.name}`;
          const trapped = layout.tables.filter(t => !t.fits && !t.scroller);
          if (trapped.length && KNOWN_CLIPPED.has(key)) {
            for (const t of trapped) {
              finding(testInfo, key,
                `a ${t.w}px table is clipped to ${t.clipped}px by an ancestor with ` +
                `overflow-x:hidden (${t.clipper}) and NOTHING scrolls it — roughly ` +
                `${t.w - t.clipped}px of columns are unreachable on a phone. The table has ` +
                'no responsive treatment: it neither reflows into cards nor sits in an ' +
                'overflow-x-auto wrapper the way the Journal Entries and Chart of Accounts ' +
                'tables do.');
            }
          } else {
            // HARD for every table that is not on the known list.
            expect(trapped.map(t =>
              `table ${t.w}px wide at ${layout.vw}px with no scrollable ancestor`),
              `${route} @ ${vp.name}: a table is wider than the viewport and nothing ` +
              'scrolls it, so its right-hand columns cannot be reached at all')
              .toEqual([]);
          }

          // HARD: a control off the edge with no scroller is unreachable.
          const unreachable = layout.stranded
            .filter(s => !s.scroller)
            .map(s => `"${s.label}" ends at ${s.right}px (viewport ${s.vw}px)`);
          expect(unreachable,
            `${route} @ ${vp.name}: controls are clipped off-screen and cannot be scrolled to`)
            .toEqual([]);

          // FINDING: reachable, but only by scrolling the whole page
          // area sideways rather than a dedicated strip.
          for (const s of layout.stranded) {
            if (s.scroller && !/overflow-x/.test(s.scroller)) {
              finding(testInfo, `${route} @ ${vp.name}`,
                `"${s.label}" extends to ${s.right}px on a ${s.vw}px viewport and is only ` +
                `reachable by side-scrolling the whole content pane ("${s.scroller}"). ` +
                'The Tenants tab strip solves this with its own overflow-x-auto row; ' +
                'this one does not.');
            }
          }
          for (const t of layout.tables) {
            if (!t.fits && t.scroller && !t.ownScroller) {
              finding(testInfo, `${route} @ ${vp.name}`,
                `a ${t.w}px table scrolls via the page pane ("${t.scroller}") rather than its ` +
                'own overflow-x container, so side-scrolling drags the page header and ' +
                'filter bar out of view along with it.');
            }
          }
        }
      });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 4. ERROR, EMPTY AND LOADING STATES
// ═══════════════════════════════════════════════════════════════════════
test.describe('Error, empty and loading states', () => {
  test('a page whose data never arrives is not blank and does not spin forever',
    async ({ page }, testInfo) => {
      await gotoRoute(page, 'dashboard');
      // Kill every data call, then reload. This is the shape of a
      // dropped connection or an expired session.
      await page.route('**/rest/v1/**', r => r.abort());
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(20000);

      const body = await page.locator('body').innerText();
      // HARD: not a blank screen.
      expect(body.trim().length,
        'with the API down the app rendered nothing at all — a blank white page')
        .toBeGreaterThan(40);
      // HARD: not a spinner that never resolves.
      const spinners = await page.locator('.animate-spin').count();
      expect(spinners,
        'with the API down the app is still showing a spinner 20s later, so a user ' +
        'has no way to tell a slow load from a dead one').toBe(0);

      // FINDING: what it shows instead.
      const admits = /error|failed|unable|couldn'?t|try again|problem|offline|retry/i.test(body);
      if (!admits) {
        finding(testInfo, 'dashboard / API down',
          'when every REST call fails at boot the app silently falls through to the ' +
          `company-selection screen ("${body.replace(/\s+/g, ' ').slice(0, 90)}…") — no error, ` +
          'no retry, no mention that anything went wrong. A user with a flaky connection ' +
          'is told they belong to no companies.');
      }
    });

  test('a page whose data fails after load does not present the failure as real data',
    async ({ page }, testInfo) => {
      await gotoRoute(page, 'dashboard');
      await page.route('**/rest/v1/**', r => r.abort());
      await gotoRoute(page, 'properties').catch(() => {});
      await page.waitForTimeout(6000);

      const main = await page.locator('main').innerText();
      // HARD: it must not be blank, and must not still be spinning.
      expect(main.trim().length, 'navigating with the API down rendered an empty pane')
        .toBeGreaterThan(30);
      expect(await page.locator('.animate-spin').count(),
        'the page is still spinning 6s after every request was refused').toBe(0);

      const admits = /error|failed|unable|couldn'?t|try again|problem|offline|retry/i.test(
        await page.locator('body').innerText());
      const showsZeros = /\b0\b/.test(main);
      if (!admits && showsZeros) {
        finding(testInfo, 'properties / API down',
          'with every request refused the page renders its full chrome and reports ' +
          '"Active (0) … 0 Total … $0 Total Rent" as though those were the real figures. ' +
          'No toast, no banner, no distinction between "you have no properties" and ' +
          '"we could not ask". This is the same failure mode that hid the blank ' +
          'year-to-date card described in 70-all-routes-health.spec.js.');
      }
    });

  test('a list with no results shows an empty state rather than an empty box',
    async ({ page }, testInfo) => {
      // Filtering to nothing is the deterministic way to produce an
      // empty list without touching the data.
      const NONSENSE = 'zzzqqqxnotathing';

      // Tenants gets this right — assert it, so a regression is caught.
      await gotoRoute(page, 'tenants');
      const tSearch = page.locator('main input[placeholder*="earch" i]').first();
      await tSearch.fill(NONSENSE);
      await page.waitForTimeout(2500);
      const tenantsCount = await page.evaluate(() =>
        document.querySelectorAll('main [class*="rounded-3xl"][class*="cursor-pointer"]').length +
        document.querySelectorAll('main table tbody tr').length);
      expect(tenantsCount, 'the nonsense search should match no tenants').toBe(0);
      const tenantsText = await page.locator('main').innerText();
      expect(tenantsText,
        'Tenants must keep telling the user why the list is empty')
        .toMatch(/no tenants found/i);
      expect(tenantsText, 'and offer a way back out of the filter').toMatch(/clear filters/i);

      // Properties does not.
      await gotoRoute(page, 'properties');
      const pSearch = page.locator('main input[placeholder*="earch" i]').first();
      await pSearch.fill(NONSENSE);
      await page.waitForTimeout(2500);
      const propCount = await page.evaluate(() =>
        document.querySelectorAll('main [class*="rounded-3xl"][class*="cursor-pointer"]').length +
        document.querySelectorAll('main table tbody tr').length);
      // HARD: the filter has to actually filter.
      expect(propCount, 'the nonsense search should match no properties').toBe(0);
      const propText = await page.locator('main').innerText();
      if (!/no propert|nothing|no results|no match|clear filter/i.test(propText)) {
        finding(testInfo, 'properties',
          'a search matching nothing leaves an empty gap under the filter bar with no ' +
          'message at all — the stat tiles above it still read "41 Total", so the page ' +
          'looks broken rather than filtered. Tenants shows "No tenants found" plus a ' +
          '"Clear Filters" action in the same situation; Properties shows nothing.');
      }

      // A genuinely empty dataset, for the non-filtered case.
      await gotoRoute(page, 'evictions');
      await page.waitForTimeout(1500);
      const evText = await page.locator('main').innerText();
      const evCases = await page.evaluate(() =>
        document.querySelectorAll('main table tbody tr').length);
      if (evCases === 0) {
        expect(evText,
          'Evictions has no cases and must say so rather than render a blank panel')
          .toMatch(/no eviction cases/i);
      }
    });

  test('a slow first load shows a loading indicator rather than a blank area',
    async ({ page }) => {
      const company = process.env.E2E_COMPANY || 'sandbox-llc';
      await page.goto(`/?company=${encodeURIComponent(company)}`, { waitUntil: 'domcontentloaded' });

      const samples = [];
      let sawSpinner = false;
      let longestBlank = 0, blankRun = 0;
      for (let i = 0; i < 60; i++) {
        const s = await page.evaluate(() => ({
          spin: document.querySelectorAll('.animate-spin').length,
          len: (document.body.innerText || '').trim().length,
        })).catch(() => ({ spin: 0, len: 0 }));
        samples.push(s);
        if (s.spin > 0) sawSpinner = true;
        // "Blank" = nothing painted AND nothing spinning.
        if (s.len < 20 && s.spin === 0) { blankRun += 250; longestBlank = Math.max(longestBlank, blankRun); }
        else blankRun = 0;
        if (i > 6 && s.len > 400 && s.spin === 0) break;
        await page.waitForTimeout(250);
      }

      expect(sawSpinner,
        'the app painted no loading indicator at any point during a first load that ' +
        'takes seconds — the user stares at an empty page with no signal').toBeTruthy();
      expect(longestBlank,
        'there was a window with neither content nor a spinner on screen').toBeLessThanOrEqual(1500);
      expect(samples[samples.length - 1].len,
        'the app never finished loading').toBeGreaterThan(400);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// FINDINGS RECORDED 2026-09-04 (company e2e-sandbox, Chromium desktop)
//
// ACCESSIBILITY
//   critical  select-name — Properties (3) and Tenants (4) filter
//             <select>s have no label, no aria-label and no title. A
//             screen reader announces four unnamed combo boxes.
//   serious   color-contrast — every page. The recurring offenders are
//             text-neutral-400 (#94a3b8) body copy at 2.4-2.6:1, the
//             bg-warn-500 count badge (white on #f59e0b, 2.1:1) and the
//             collapsed sidebar child links (2.54:1). AA needs 4.5:1.
//   serious   label-title-only — Payments date filters are labelled by
//             title="From date"/"To date" only, which many screen
//             readers do not announce and no touch user ever sees.
//   serious   scrollable-region-focusable — the Dashboard and the
//             shortcuts sheet have scrollable panes that no keyboard
//             can scroll.
//   moderate  page-has-heading-one — no page has an <h1>.
//   moderate  region — content sits outside any landmark on every page.
//   minor     empty-table-header — Payments has a blank <th>.
//   CLEAN     images/alt, <label> association, button and link names,
//             heading order, ARIA validity, nested-interactive.
//
// KEYBOARD
//   - Shared <Modal> (shared.js:84): no role="dialog", no aria-modal,
//     no focus move on open, no focus trap, no Escape, no focus restore.
//     Only the × button closes it. The CommandPalette and the shortcuts
//     sheet get all of this right, so the pattern exists — it just is
//     not in the component every other modal uses.
//   - Shortcuts sheet: declares aria-modal="true" but does not trap
//     focus; Tab walks into the sidebar behind it.
//   - Tenant and Property record cards are cursor-pointer <div>s with
//     no tabindex or role — the primary way into every one of the 73
//     tenants on the page is mouse-only.
//   - Form primitives set focus:outline-none and replace the ring with
//     a border-colour change only (4 of the first 30 controls on
//     Properties show no focus indicator this check can see).
//   - The palette paints ~20ms before it takes focus
//     (CommandPalette.js:118 uses a setTimeout). Keystrokes in that
//     window go to the page behind, and a "?" there opens the shortcuts
//     sheet on top of the palette, because the "?" handler only
//     suppresses itself when the event target is a field.
//   - GOOD: once focused, the Cmd+K palette is completely
//     keyboard-driven — aria-selected tracks the arrows, Enter runs the
//     highlighted command, Escape closes without navigating, and a "?"
//     typed into the box lands as text.
//
// RESPONSIVE
//   - 390px Payments: the payments table is 579px wide inside a wrapper
//     with overflow-x:hidden and a 356px client width. ~223px of
//     columns are unreachable — no scroll, no reflow. This is the one
//     genuine responsive defect; it is on the KNOWN_CLIPPED ratchet so
//     any OTHER clipped table fails the suite outright.
//   - 390px Properties: the "Archived (0)" tab ends at 439px and is
//     reachable only by side-scrolling the whole content pane, because
//     the tab row has no overflow-x container of its own. The Tenants
//     tab strip does, and behaves correctly.
//   - No document-level horizontal overflow anywhere at 390 or 834, and
//     no off-screen unreachable controls at 834.
//
// ERROR / EMPTY / LOADING
//   - API down at boot: falls through to the company-selection screen.
//     No error, no retry — it looks like the user has no companies.
//   - API down after load: Properties renders "Active (0) … $0 Total
//     Rent" as if those were real figures. Nothing distinguishes "no
//     data" from "the request failed".
//   - Properties with a search that matches nothing: empty gap, no
//     message, stat tiles still showing the unfiltered totals.
//   - GOOD: Tenants ("No tenants found" + Clear Filters) and Evictions
//     ("No eviction cases…") both have proper empty states.
//   - GOOD: a spinner covers the whole ~5s first load.
// ═══════════════════════════════════════════════════════════════════════
