// Ported from next-intl: examples/example-app-router-playground/tests/domains.spec.ts
// https://github.com/amannn/next-intl/blob/main/examples/example-app-router-playground/tests/domains.spec.ts
// Runs against a Cloudflare production build of tests/fixtures/cf-next-intl with
// NEXT_PUBLIC_USE_CASE=domains.
import {chromium, expect, test as it} from '@playwright/test';
import {getPort} from './utils';

it('can use config based on the default locale on an unknown domain', async ({
  page
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', {name: 'Home'})).toBeVisible();
  await expect(page).toHaveURL('/');
  await page.getByRole('link', {name: 'Client page'}).click();
  await expect(page).toHaveURL('/client');

  await page.goto('/');
  await page.getByRole('link', {name: 'Switch to German'}).click();
  await expect(page).toHaveURL('/de');
});

it('can use a secondary locale unprefixed if the domain has specified it as the default locale', async () => {
  const browser = await chromium.launch({
    // Upstream maps only example.de, so the final click leaves for the real
    // example.com and stops at /en. Map example.com too so the fixture's
    // middleware handles the English domain.
    args: [
      `--host-resolver-rules=MAP example.de 127.0.0.1:${getPort()}, MAP example.com 127.0.0.1:${getPort()}`
    ]
  });

  const page = await browser.newPage();
  await page.route('**/*', (route) =>
    route.continue({
      headers: {
        'accept-language': 'de',
        'x-forwarded-port': '80' // (playwright default)
      }
    })
  );

  await page.goto('http://example.de');
  await expect(page).toHaveURL('http://example.de'); // (no redirect)
  await expect(page.getByRole('heading', {name: 'Start'})).toBeVisible();
  await page.getByRole('link', {name: 'Client-Seite'}).click();
  await expect(page).toHaveURL('http://example.de/client');
  await page.getByRole('link', {name: 'Start'}).click();
  await expect(page).toHaveURL('http://example.de');
  await page.getByRole('link', {name: 'Zu Englisch wechseln'}).click();
  // example.de/en redirects to example.com/en, which redirects to / because
  // `en` is the default locale of example.com.
  await expect(page).toHaveURL('http://example.com');
  await expect(page.getByRole('heading', {name: 'Home'})).toBeVisible();
});
