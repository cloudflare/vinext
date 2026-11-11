// Ported from next-intl: examples/example-app-router-playground/tests/locale-cookie-false.spec.ts
// https://github.com/amannn/next-intl/blob/main/examples/example-app-router-playground/tests/locale-cookie-false.spec.ts
// Runs against a Cloudflare production build of tests/fixtures/cf-next-intl with
// NEXT_PUBLIC_USE_CASE=locale-cookie-false.
import {expect, test as it} from '@playwright/test';

it('never sets a cookie', async ({page}) => {
  async function expectNoCookie() {
    expect(
      (await page.context().cookies()).find((cur) => cur.name === 'NEXT_LOCALE')
    ).toBeUndefined();
  }

  await page.goto('/');
  await expectNoCookie();

  await page.getByRole('link', {name: 'Switch to German'}).click();
  await expect(page).toHaveURL('/de');
  await expectNoCookie();
});
