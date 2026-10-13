// Ported from next-intl: examples/example-app-router-playground/tests/base-path.spec.ts
// https://github.com/amannn/next-intl/blob/main/examples/example-app-router-playground/tests/base-path.spec.ts
// Runs against a Cloudflare production build of tests/fixtures/cf-next-intl with
// NEXT_PUBLIC_USE_CASE=base-path.
import {expect, test as it} from '@playwright/test';
import {assertLocaleCookieValue} from './utils';

// Rarely, the client navigation back to Home never commits and the
// "Switch to German" wait times out. That is an upstream React bug where a
// lazy Flight chunk's ping is dropped and the root stays suspended; it also
// reproduces on Next.js: https://github.com/react/react/issues/37805
it('updates the cookie correctly', async ({page}) => {
  await page.goto('/base/path');
  await assertLocaleCookieValue(page, undefined);

  await page.getByRole('button', {name: 'Go to nested page'}).click();
  await expect(page).toHaveURL('/base/path/nested');
  await page.getByRole('link', {name: 'Home'}).click();
  await page.getByRole('link', {name: 'Switch to German'}).click();

  await expect(page).toHaveURL('/base/path/de');
  await assertLocaleCookieValue(page, 'de', {path: '/base/path'});
  await page.getByRole('button', {name: 'Go to nested page'}).click();
  await expect(page).toHaveURL('/base/path/de/verschachtelt');
  await page.getByRole('link', {name: 'Start'}).click();
  await page.getByRole('link', {name: 'Zu Englisch wechseln'}).click();

  await expect(page).toHaveURL('/base/path');
  await assertLocaleCookieValue(page, 'en', {path: '/base/path'});
});

it('updates the cookie correctly when using the router', async ({page}) => {
  await page.goto('/base/path/client');
  await page.getByRole('button', {name: 'Switch to de'}).click();

  await expect(page).toHaveURL('/base/path/de/client');
  await assertLocaleCookieValue(page, 'de', {path: '/base/path'});
});

it('omits a base path from usePathname', async ({page}) => {
  await page.goto('/base/path/client');
  await expect(page.getByTestId('UnlocalizedPathname')).toHaveText('/client');
});

it('returns the correct canonical URL when using getPathname', async ({
  page
}) => {
  async function getCanonicalPathname() {
    const href = await page
      .locator('link[rel="canonical"]')
      .getAttribute('href');
    return new URL(href!).pathname;
  }

  await page.goto('/base/path/news/1');
  await expect(getCanonicalPathname()).resolves.toBe('/base/path/news/1');

  await page.goto('/base/path/de/neuigkeiten/1');
  await expect(getCanonicalPathname()).resolves.toBe(
    '/base/path/de/neuigkeiten/1'
  );
});
