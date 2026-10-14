// Ported from next-intl: examples/example-app-router-playground/tests/base-path.spec.ts
// https://github.com/amannn/next-intl/blob/main/examples/example-app-router-playground/tests/base-path.spec.ts
// Runs against a Cloudflare production build of tests/fixtures/cf-next-intl with
// NEXT_PUBLIC_USE_CASE=base-path.
import {Locator, Page, expect, test as it} from '@playwright/test';
import {assertLocaleCookieValue} from './utils';

// vinext: rarely, a client navigation never commits and the old page stays up.
// That is an upstream React bug: a lazy Flight chunk's ping is dropped during
// render, so the root stays suspended until some other update arrives. It also
// reproduces on Next.js: https://github.com/react/react/issues/37805
// Clicking again schedules a new update, which makes React retry the stuck
// render. The retried navigation can get stuck the same way, so each navigation
// below keeps clicking until the URL changes instead of timing out. The URL only
// updates once the navigation commits, and next-intl derives the locale
// cookie's path from it.
async function navigate(page: Page, trigger: Locator, url: string) {
  await trigger.click();
  await expect(async () => {
    try {
      await expect(page).toHaveURL(url, {timeout: 3_000});
    } catch (error) {
      // The trigger is gone if the navigation committed in the meantime.
      await trigger.click({timeout: 1_000}).catch(() => {});
      throw error;
    }
  }).toPass();
}

it('updates the cookie correctly', async ({page}) => {
  await page.goto('/base/path');
  await assertLocaleCookieValue(page, undefined);

  await navigate(
    page,
    page.getByRole('button', {name: 'Go to nested page'}),
    '/base/path/nested'
  );
  await navigate(page, page.getByRole('link', {name: 'Home'}), '/base/path');
  await navigate(
    page,
    page.getByRole('link', {name: 'Switch to German'}),
    '/base/path/de'
  );

  await assertLocaleCookieValue(page, 'de', {path: '/base/path'});
  await navigate(
    page,
    page.getByRole('button', {name: 'Go to nested page'}),
    '/base/path/de/verschachtelt'
  );
  await navigate(page, page.getByRole('link', {name: 'Start'}), '/base/path/de');
  await navigate(
    page,
    page.getByRole('link', {name: 'Zu Englisch wechseln'}),
    '/base/path'
  );

  await assertLocaleCookieValue(page, 'en', {path: '/base/path'});
});

it('updates the cookie correctly when using the router', async ({page}) => {
  await page.goto('/base/path/client');
  await navigate(
    page,
    page.getByRole('button', {name: 'Switch to de'}),
    '/base/path/de/client'
  );

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
