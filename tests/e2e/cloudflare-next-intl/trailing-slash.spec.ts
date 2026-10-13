// Ported from next-intl: examples/example-app-router-playground/tests/trailing-slash.spec.ts
// https://github.com/amannn/next-intl/blob/main/examples/example-app-router-playground/tests/trailing-slash.spec.ts
// Runs against a Cloudflare production build of tests/fixtures/cf-next-intl with
// NEXT_PUBLIC_USE_CASE=trailing-slash.
import {expect, test as it} from '@playwright/test';
import {getAlternateLinks} from './utils';

it('redirects to a locale prefix correctly', async ({request}) => {
  const response = await request.get('/', {
    maxRedirects: 0,
    headers: {
      'Accept-Language': 'de'
    }
  });
  expect(response.status()).toBe(307);
  expect(response.headers().location).toBe('/de/');
});

it('redirects a localized pathname correctly', async ({request}) => {
  const response = await request.get('/de/nested/', {maxRedirects: 0});
  expect(response.status()).toBe(307);
  expect(response.headers().location).toBe('/de/verschachtelt/');
});

it('redirects a page with a missing trailing slash', async ({request}) => {
  expect((await request.get('/de', {maxRedirects: 0})).headers().location).toBe(
    '/de/'
  );
  expect(
    (await request.get('/de/client', {maxRedirects: 0})).headers().location
  ).toBe('/de/client/');
});

it('renders page content', async ({page}) => {
  await page.goto('/');
  await page.getByRole('heading', {name: 'Home'}).waitFor();

  await page.goto('/de/');
  await page.getByRole('heading', {name: 'Start'}).waitFor();
});

it('renders links correctly', async ({page}) => {
  await page.goto('/de/');
  await expect(page.getByRole('link', {name: 'Client-Seite'})).toHaveAttribute(
    'href',
    '/de/client/'
  );
  await expect(
    page.getByRole('link', {name: 'Verschachtelte Seite'})
  ).toHaveAttribute('href', '/de/verschachtelt/');
});

it('returns alternate links correctly', async ({request}) => {
  async function getLinks(pathname: string) {
    return getAlternateLinks(await request.get(pathname));
  }

  for (const pathname of ['/', '/en', '/de']) {
    expect(await getLinks(pathname)).toEqual(
      expect.arrayContaining([
        '<http://localhost:3000/>; rel="alternate"; hreflang="en"',
        '<http://localhost:3000/de/>; rel="alternate"; hreflang="de"',
        '<http://localhost:3000/spain/>; rel="alternate"; hreflang="es"',
        '<http://localhost:3000/ja/>; rel="alternate"; hreflang="ja"',
        '<http://localhost:3000/>; rel="alternate"; hreflang="x-default"'
      ])
    );
  }

  for (const pathname of ['/nested', '/en/nested', '/de/nested']) {
    expect(await getLinks(pathname)).toEqual(
      expect.arrayContaining([
        '<http://localhost:3000/nested/>; rel="alternate"; hreflang="en"',
        '<http://localhost:3000/de/verschachtelt/>; rel="alternate"; hreflang="de"',
        '<http://localhost:3000/spain/anidada/>; rel="alternate"; hreflang="es"',
        '<http://localhost:3000/ja/%E3%83%8D%E3%82%B9%E3%83%88/>; rel="alternate"; hreflang="ja"',
        '<http://localhost:3000/nested/>; rel="alternate"; hreflang="x-default"'
      ])
    );
  }
});

it('can handle dynamic params', async ({page}) => {
  await page.goto('/news/3');
  await page.getByRole('heading', {name: 'News article #3'}).waitFor();

  await page.goto('/de/neuigkeiten/3');
  await page.getByRole('heading', {name: 'News-Artikel #3'}).waitFor();
});
