import { expect, test } from '@playwright/test';

const isDevMode = !!process.env.TEST_ENV && process.env.TEST_ENV.includes('development');

test.describe('Subresource Integrity (SRI)', () => {
  test('page with client components loads correctly with SRI enabled', async ({ page }) => {
    // SRI is only relevant for production builds
    test.skip(isDevMode, 'SRI only applies to production builds');

    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('/sri-test');

    const heading = page.locator('#sri-test-heading');
    await expect(heading).toBeVisible();

    // Verify client-side interactivity works (scripts loaded correctly)
    const button = page.locator('#counter-button');
    await expect(button).toContainText('Count: 0');
    await button.click();
    await expect(button).toContainText('Count: 1');

    expect(consoleErrors.filter(e => e.includes('integrity'))).toHaveLength(0);
  });

  test('client-side navigation works with SRI enabled', async ({ page }) => {
    test.skip(isDevMode, 'SRI only applies to production builds');

    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('/sri-test');
    await expect(page.locator('#sri-test-heading')).toBeVisible();

    // Navigate to target page via client-side link
    await page.locator('#navigate-link').click();
    await expect(page.locator('#sri-target-heading')).toBeVisible();

    // Verify client-side interactivity on the target page
    const targetButton = page.locator('#target-button');
    await expect(targetButton).toContainText('Click me');
    await targetButton.click();
    await expect(targetButton).toContainText('Clicked!');

    // Navigate back
    await page.locator('#back-link').click();
    await expect(page.locator('#sri-test-heading')).toBeVisible();

    expect(consoleErrors.filter(e => e.includes('integrity'))).toHaveLength(0);
  });
});
