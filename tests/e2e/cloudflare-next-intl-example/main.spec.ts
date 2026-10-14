// Ported from next-intl: examples/example-app-router/tests/main.spec.ts
// https://github.com/amannn/next-intl/blob/v4.11.1/examples/example-app-router/tests/main.spec.ts
// Runs against a Cloudflare production build of tests/fixtures/cf-next-intl-example.
import {expect, test as it} from '@playwright/test';

it('handles i18n routing', async ({page}) => {
  await page.goto('/');
  await expect(page).toHaveURL('/en');

  // A cookie remembers the last locale
  await page.goto('/de');
  await page.goto('/');
  await expect(page).toHaveURL('/de');
  await page
    .getByRole('combobox', {name: 'Sprache ändern'})
    .selectOption({value: 'en'});

  await expect(page).toHaveURL('/en');
  await expect(page.getByRole('heading', {name: 'next-intl example'})).toBeVisible();
});

it('handles not found pages', async ({page}) => {
  await page.goto('/unknown');
  await expect(page.getByRole('heading', {name: 'Page not found'})).toBeVisible();

  await page.goto('/de/unknown');
  await expect(page.getByRole('heading', {name: 'Seite nicht gefunden'})).toBeVisible();
});

it("handles not found pages for routes that don't match the middleware", async ({
  page
}) => {
  await page.goto('/test.png');
  await expect(page.getByRole('heading', {name: 'This page could not be found.'})).toBeVisible();

  await page.goto('/api/hello');
  await expect(page.getByRole('heading', {name: 'This page could not be found.'})).toBeVisible();
});

it('sets caching headers', async ({request}) => {
  for (const [pathname, text] of [
    ['/en', 'This is a basic example'],
    ['/en/pathnames', 'The pathnames are internationalized too.'],
    ['/de', 'Dies ist ein Beispiel'],
    ['/de/pfadnamen', 'Auch die Pfadnamen sind internationalisiert.']
  ]) {
    // vinext: Next.js prerenders these pages at build time, so its first
    // request is already a cache hit. vinext stores them from their first
    // request instead, and that streamed miss is sent with `no-store` because
    // it can't yet know the render is static. The page is served from the
    // cache only if `setRequestLocale` made it static.
    await expect
      .poll(
        async () => (await request.get(pathname)).headers()['x-vinext-cache']
      )
      .toBe('HIT');
    const response = await request.get(pathname);
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toContain('s-maxage=31536000');
    expect(await response.text()).toContain(text);
  }
});

it('can be used to configure metadata', async ({page}) => {
  await page.goto('/en');
  await expect(page).toHaveTitle('next-intl example');

  await page.goto('/de');
  await expect(page).toHaveTitle('next-intl Beispiel');
});

it('can be used to localize the page', async ({page}) => {
  await page.goto('/en');
  await expect(page.getByRole('heading', {name: 'next-intl example'})).toBeVisible();

  await page.goto('/de');
  await expect(page.getByRole('heading', {name: 'next-intl Beispiel'})).toBeVisible();
});

it('sets a cookie when necessary', async ({page}) => {
  function getCookieValue() {
    return page.evaluate(() => document.cookie);
  }

  const response = await page.goto('/en');
  expect(await response?.headerValue('set-cookie')).toBe(null);

  await page
    .getByRole('combobox', {name: 'Change language'})
    .selectOption({value: 'de'});
  await expect(page).toHaveURL('/de');
  await expect.poll(getCookieValue).toBe('NEXT_LOCALE=de');

  await page
    .getByRole('combobox', {name: 'Sprache ändern'})
    .selectOption({value: 'en'});
  await expect(page).toHaveURL('/en');
  await expect.poll(getCookieValue).toBe('NEXT_LOCALE=en');

  // The Next.js Router cache kicks in here
  // https://nextjs.org/docs/app/building-your-application/caching#router-cache
  await page
    .getByRole('combobox', {name: 'Change language'})
    .selectOption({value: 'de'});
  await expect(page).toHaveURL('/de');
  await expect.poll(getCookieValue).toBe('NEXT_LOCALE=de');
});

it("sets a cookie when requesting a locale that doesn't match the `accept-language` header", async ({
  page
}) => {
  const response = await page.goto('/de');
  const value = await response?.headerValue('set-cookie');
  expect(value).toContain('NEXT_LOCALE=de;');
  expect(value).toContain('Path=/;');
  expect(value).toContain('SameSite=lax');
});

it('serves a robots.txt', async ({page}) => {
  const response = await page.goto('/robots.txt');
  const body = await response?.body();
  expect(body?.toString()).toEqual('User-Agent: *\nAllow: *\n');
});

it('provides a manifest', async ({page}) => {
  const response = await page.goto('/manifest.webmanifest');
  const body = await response!.json();
  expect(body).toEqual({
    name: 'next-intl example',
    start_url: '/',
    theme_color: '#101E33'
  });
});
