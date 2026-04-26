// ═══════════════════════════════════════════════════════════════
// 68 — STRIPE PAYMENT — full end-to-end flow
// Logs in as the seeded tenant (clicktest-tenant@propmanager.com),
// opens Pay Rent, types into the Stripe Elements card iframe with
// the test card 4242 4242 4242 4242, confirms the payment, and
// asserts the success toast renders.
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, respondToConfirmModal } = require('./helpers');

const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';
const TENANT_EMAIL = 'clicktest-tenant@propmanager.com';
const TENANT_PASSWORD = process.env.CLICK_PORTAL_PASSWORD || 'ClickTest!2026';

test.describe('Stripe Payment — end-to-end', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, {
      companySlug: SMITH,
      email: TENANT_EMAIL,
      password: TENANT_PASSWORD,
      expectsPortal: true,
    });
    await page.waitForTimeout(2000);
  });

  test('tenant pays $100 via Stripe test card → success toast', async ({ page }) => {
    test.setTimeout(120000); // Stripe iframe loads + 3DS-bypass takes time

    // Capture network failures + console errors during the flow so we
    // can diagnose if anything 5xxs server-side.
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') {
      const t = m.text();
      if (!/favicon|manifest|sw\.js$/i.test(t)) errors.push('console: ' + t.slice(0, 200));
    }});
    page.on('response', resp => {
      const url = resp.url();
      if (resp.status() >= 400 && /\/api\/stripe/.test(url)) {
        errors.push('http ' + resp.status() + ' ' + url);
      }
    });

    // 1. Click the Pay Rent tab
    const payTab = page.locator('button').filter({ hasText: /Pay Rent/i }).first();
    await expect(payTab).toBeVisible({ timeout: 10000 });
    await payTab.click();
    await page.waitForTimeout(800);

    // 2. Enter $100 in the amount input
    const amountInput = page.locator('input[type="number"]').first();
    await expect(amountInput).toBeVisible({ timeout: 5000 });
    await amountInput.fill('100');

    // 3. Click "Continue to Pay $100" — server creates PaymentIntent,
    //    response includes client_secret, page swaps into Stripe Elements
    const continueBtn = page.locator('button').filter({ hasText: /Continue to Pay/ }).first();
    await expect(continueBtn).toBeVisible();
    await continueBtn.click();

    // 3b. Tenant's seeded balance is $0; paying $100 trips the
    // "exceeds balance — apply as credit?" confirm modal. Acknowledge
    // it so handleStripePayment continues to create-intent. If the
    // tenant has a real balance >= $100, the modal won't show and
    // this is a no-op.
    await page.waitForTimeout(500);
    await respondToConfirmModal(page, true);

    // 4. Wait for the Stripe iframe to mount. Stripe's PaymentElement
    //    renders one or more iframes named "__privateStripeFrame…".
    //    We wait for at least one with a card-number field inside.
    await page.waitForTimeout(2500); // give the create-intent fetch + Elements load time
    await expect(page.locator('iframe[name^="__privateStripeFrame"]').first()).toBeVisible({ timeout: 15000 });

    // 5. Inside the Stripe iframe: fill card / expiry / CVC / ZIP.
    //    With PaymentElement, all four inputs live in a single iframe.
    //    Stripe occasionally changes input attribute names but the
    //    accessible labels stay the same — target by getByLabel.
    const stripeFrame = page.frameLocator('iframe[name^="__privateStripeFrame"]').first();

    // getByLabel matches BOTH inputs and the decorative SVG icons that
    // share the label (e.g. CVC has both the input field and a card-
    // icon SVG aria-labelled "Credit or debit card CVC"). getByRole
    // textbox restricts to actual inputs.
    await stripeFrame.getByRole('textbox', { name: /Card number/i }).fill('4242 4242 4242 4242');
    await stripeFrame.getByRole('textbox', { name: /Expir|MM\s*\/\s*YY/i }).fill('12 / 34');
    await stripeFrame.getByRole('textbox', { name: /Security code|^CVC$/i }).fill('123');
    // ZIP appears for US cards
    const zipField = stripeFrame.getByRole('textbox', { name: /ZIP|Postal code/i });
    if (await zipField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await zipField.fill('12345');
    }

    // 6. Click the Pay button (the form's submit). It's outside the
    //    iframe — back in our DOM.
    const payBtn = page.locator('button[type="submit"]').filter({ hasText: /^Pay \$/ }).first();
    await expect(payBtn).toBeVisible();
    await payBtn.click();

    // 7. Wait for either the success toast OR a card-error display.
    //    Test card 4242... always succeeds in test mode unless 3DS is
    //    forced; should resolve in <8s.
    const successCard = page.locator('text=/Payment Successful/i').first();
    const errorBox = page.locator('text=/declined|failed|error/i').first();
    const result = await Promise.race([
      successCard.waitFor({ state: 'visible', timeout: 30000 }).then(() => 'success'),
      errorBox.waitFor({ state: 'visible', timeout: 30000 }).then(() => 'error'),
    ]).catch(() => 'timeout');

    if (result !== 'success') {
      console.log('--- Stripe payment did NOT succeed ---');
      console.log('result:', result);
      console.log('captured errors:');
      for (const e of errors) console.log('  ' + e);
      const bodyText = await page.locator('body').innerText().catch(() => '');
      console.log('body preview:', bodyText.slice(0, 500));
    }
    expect(result, 'payment should succeed with 4242 test card').toBe('success');
  });
});
