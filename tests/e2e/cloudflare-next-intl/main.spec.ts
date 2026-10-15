// Ported from next-intl: examples/example-app-router-playground/tests/main.spec.ts
// https://github.com/amannn/next-intl/blob/main/examples/example-app-router-playground/tests/main.spec.ts
// Runs against a Cloudflare production build of tests/fixtures/cf-next-intl.
// Kept close to upstream formatting so it can be diffed against new releases.
import {BrowserContext, expect, test as it} from '@playwright/test';
import {assertLocaleCookieValue, getAlternateLinks} from './utils';

const describe = it.describe;

function getPageLoadTracker(
  context: BrowserContext,
  pathnameWithSearch: string
) {
  const state = {numPageLoads: 0};

  context.on('response', (response) => {
    const url = new URL(response.url());
    const curPathnameWithSearch = url.pathname + url.search;
    const contentType = response.headers()['content-type'] || '';

    if (
      curPathnameWithSearch === pathnameWithSearch &&
      contentType.includes('text/html')
    ) {
      state.numPageLoads++;
    }
  });

  return state;
}

it('handles unknown locales', async ({page}) => {
  const response = await page.goto('/unknown');
  expect(response?.status()).toBe(404);
  await expect(page).toHaveURL('/unknown');
  await expect(
    page.getByRole('heading', {name: 'This page was not found (404)'})
  ).toBeVisible();
});

it('handles pathnames that are not matched by the middleware', async ({
  page
}) => {
  const response = await page.goto('/unknown.txt');
  expect(response?.status()).toBe(404);
});

it('redirects to a matched locale at the root for non-default locales', async ({
  browser
}) => {
  const context = await browser.newContext({locale: 'de'});
  const page = await context.newPage();

  await page.goto('/');
  await expect(page).toHaveURL('/de');
  await expect(page.getByRole('heading', {name: 'Start'})).toBeVisible();
});

it('redirects to a matched locale for an invalid cased non-default locale', async ({
  browser
}) => {
  const context = await browser.newContext({locale: 'de'});
  const page = await context.newPage();

  await page.goto('/DE');
  await expect(page).toHaveURL('/de');
  await expect(page.getByRole('heading', {name: 'Start'})).toBeVisible();
});

it('redirects to a matched locale for an invalid cased non-default locale in a nested path', async ({
  browser
}) => {
  const context = await browser.newContext({locale: 'de'});
  const page = await context.newPage();

  await page.goto('/DE/verschachtelt');
  await expect(page).toHaveURL('/de/verschachtelt');
  await expect(page.getByRole('heading', {name: 'Verschachtelt'})).toBeVisible();
});

it('redirects to a matched locale for an invalid cased default locale', async ({
  browser
}) => {
  const context = await browser.newContext({locale: 'en'});
  const page = await context.newPage();

  await page.goto('/EN');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', {name: 'Home'})).toBeVisible();
});

it('redirects to a matched locale for an invalid cased default locale in a nested path', async ({
  browser
}) => {
  const context = await browser.newContext({locale: 'en'});
  const page = await context.newPage();

  await page.goto('/EN/nested');
  await expect(page).toHaveURL('/nested');
  await expect(page.getByRole('heading', {name: 'Nested'})).toBeVisible();
});

it('redirects a prefixed pathname for the default locale to the unprefixed version', async ({
  request
}) => {
  const response = await request.get('/en', {
    maxRedirects: 0
  });
  expect(response.status()).toBe(307);
  expect(response.headers().location).toEqual('/');
});

it('redirects a more specific locale to a more generic one', async ({
  browser
}) => {
  const context = await browser.newContext({locale: 'de-DE'});
  const page = await context.newPage();

  await page.goto('/');
  await expect(page).toHaveURL('/de');
  await expect(page.getByRole('heading', {name: 'Start'})).toBeVisible();
});

it('does not redirect on the root if the default locale is matched', async ({
  page
}) => {
  await page.goto('/');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', {name: 'Home'})).toBeVisible();
});

it('supports unprefixed routing for the default locale', async ({page}) => {
  await page.goto('/de/verschachtelt');
  await expect(page).toHaveURL('/de/verschachtelt');
  await expect(page.getByRole('heading', {name: 'Verschachtelt'})).toBeVisible();
});

it('supports prefixed routing for non-default locales', async ({page}) => {
  await page.goto('/nested');
  await expect(page).toHaveURL('/nested');
  await expect(page.getByRole('heading', {name: 'Nested'})).toBeVisible();
});

it('redirects unprefixed paths for non-default locales', async ({browser}) => {
  const context = await browser.newContext({locale: 'de'});
  const page = await context.newPage();

  await page.goto('/nested');
  await expect(page).toHaveURL('/de/verschachtelt');
  await expect(page.getByRole('heading', {name: 'Verschachtelt'})).toBeVisible();
});

it('prioritizes static routes over dynamic routes for the default locale', async ({
  page
}) => {
  await page.goto('/news/just-in');
  await expect(page).toHaveURL('/news/just-in');
  await expect(page.getByRole('heading', {name: 'Just In'})).toBeVisible();
});

it('prioritizes static routes over dynamic routes for non-default locales', async ({
  page
}) => {
  await page.goto('/de/neuigkeiten/aktuell');
  await expect(page).toHaveURL('/de/neuigkeiten/aktuell');
  await expect(
    page.getByRole('heading', {name: 'Gerade eingetroffen'})
  ).toBeVisible();
});

it('sets the `path` for the cookie', async ({page}) => {
  await page.goto('/de/client');

  // It's important that the cookie is set on the root path
  // https://www.rfc-editor.org/rfc/rfc6265#section-4.1.2.4
  await assertLocaleCookieValue(page, 'de', {path: '/'});
});

it('remembers the last locale', async ({page}) => {
  await page.goto('/de');

  // Wait for the cookie to be set on the client side
  await assertLocaleCookieValue(page, 'de');

  await page.goto('/');
  await expect(page).toHaveURL('/de');
});

it('sets the `lang` attribute on `html`', async ({page}) => {
  await page.goto('/en');
  await page.waitForSelector('html[lang="en"]');
});

it('can be used in the head', async ({page}) => {
  await page.goto('/en');
  await expect(page).toHaveTitle('next-intl example');

  await page.goto('/de');
  await expect(page).toHaveTitle('next-intl Beispiel');
});

it('can be used to localize the page', async ({page}) => {
  await page.goto('/en');
  await expect(page.locator('text=This is the home page.')).toBeVisible();

  await page.goto('/de');
  await expect(page.locator('text=Das ist die Startseite.')).toBeVisible();
});

it('can pass internationalized labels to a client component', async ({
  page
}) => {
  await page.goto('/en');
  const element = page.getByTestId('MessagesAsPropsCount');
  await expect(element).toHaveText(/Current count: 0/);
  await element.getByRole('button', {name: 'Increment'}).click();
  await expect(element).toHaveText(/Current count: 1/);
});

it('can use next-intl on the client side', async ({page}) => {
  await page.goto('/en');
  const element = page.getByTestId('MessagesOnClientCounter');
  await expect(element).toHaveText(/Current count: 0/);
  await element.getByRole('button', {name: 'Increment'}).click();
  await expect(element).toHaveText(/Current count: 1/);
});

it('can use rich text', async ({page}) => {
  await page.goto('/en');
  const element = page.getByTestId('RichText');
  expect(await element.innerHTML()).toBe(
    'This is a <b style="font-weight:bold">rich</b> text.'
  );
});

it('can use raw text', async ({page}) => {
  await page.goto('/en');
  const element = page.getByTestId('RawText');
  expect(await element.innerHTML()).toBe('This is a <b>rich</b> text.');
});

it('can use `getMessageFallback`', async ({page}) => {
  await page.goto('/en');
  const element = page.getByTestId('MissingMessage');
  expect(await element.innerHTML()).toBe(
    '`getMessageFallback` called for Index.missing'
  );
});

it('can use the core library', async ({page}) => {
  await page.goto('/en');
  const element = page.getByTestId('CoreLibrary');
  await expect(element).toHaveText('Relative time: in 1 day');
});

it('can use `Link` on the server', async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('link', {name: /^Home$/})).toHaveAttribute(
    'href',
    '/'
  );
  await expect(page.getByRole('link', {name: 'Nested page'})).toHaveAttribute(
    'href',
    '/nested'
  );
});

it('can use `Link` with an object as `href`', async ({page}) => {
  await page.goto('/');
  const link = page.getByRole('link', {name: 'Go to home with query param'});
  await expect(link).toHaveAttribute('href', '/?test=true');
  await link.click();
  await expect(page).toHaveURL('/?test=true');
});

it('can use `Link` to link to the root of another language', async ({page}) => {
  await page.goto('/');
  const link = page.getByRole('link', {name: 'Switch to German'});
  await expect(link).toHaveAttribute('href', '/de');
  await link.click();
  await expect(page).toHaveURL('/de');
  // vinext: let the `/de` page's Link prefetches settle first. next-intl's
  // middleware syncs `NEXT_LOCALE` on every request, so a `/de/*` prefetch
  // still in flight after the switch resets the cookie to `de` and races the
  // redirect to `/`. Real Next.js has the same race (it shows up with ~20ms of
  // added latency); it just usually wins on Node's faster responses.
  await page.waitForLoadState('networkidle');
  await page.getByRole('link', {name: 'Zu Englisch wechseln'}).click();
  await expect(page).toHaveURL('/');
});

it('uses client-side transitions when using link', async ({context, page}) => {
  const tracker = getPageLoadTracker(context, '/');

  await page.goto('/');
  expect(tracker.numPageLoads).toBe(1);

  await page.getByRole('link', {name: 'Nested page'}).click();
  await expect(page).toHaveURL('/nested');
  expect(tracker.numPageLoads).toBe(1);

  await page.getByRole('link', {name: 'Client page'}).click();
  await expect(page).toHaveURL('/client');
  expect(tracker.numPageLoads).toBe(1);

  await page.goBack();
  await expect(page).toHaveURL('/nested');
  expect(tracker.numPageLoads).toBe(1);

  await page.goBack();
  await expect(page).toHaveURL('/');
  expect(tracker.numPageLoads).toBe(1);
});

it('keeps the locale cookie updated when changing the locale and uses soft navigation (no reloads)', async ({
  context,
  page
}) => {
  const tracker = getPageLoadTracker(context, '/');

  await page.goto('/');
  await assertLocaleCookieValue(page, undefined);
  expect(tracker.numPageLoads).toBe(1);

  const linkDe = page.getByRole('link', {name: 'Switch to German'});
  await linkDe.hover();
  await assertLocaleCookieValue(page, undefined);
  await linkDe.click();

  await expect(page).toHaveURL('/de');
  await assertLocaleCookieValue(page, 'de');

  const linkEn = page.getByRole('link', {name: 'Zu Englisch wechseln'});
  await linkEn.hover();
  await assertLocaleCookieValue(page, 'de');
  await linkEn.click();

  await expect(page).toHaveURL('/');
  await assertLocaleCookieValue(page, 'en');

  // Currently, a root layout outside of the `[locale]`
  // folder is required for this to work.
  expect(tracker.numPageLoads).toBe(1);
});

it('can use `Link` in client components without using a provider', async ({
  page
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('link', {name: 'Link on client without provider'})
  ).toHaveAttribute('href', '/');

  await page.goto('/de');
  await expect(
    page.getByRole('link', {name: 'Link on client without provider'})
  ).toHaveAttribute('href', '/de');
});

it('can use `Link` on the client', async ({page}) => {
  await page.goto('/client');
  await expect(page.getByRole('link', {name: 'Go to home'})).toHaveAttribute(
    'href',
    '/'
  );

  await page.goto('/de/client');
  await expect(page.getByRole('link', {name: 'Go to home'})).toHaveAttribute(
    'href',
    '/de'
  );
});

it('prefixes as necessary with `Link`', async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('link', {name: /^Home$/})).toHaveAttribute(
    'href',
    '/'
  );
  await expect(page.getByRole('link', {name: 'Client page'})).toHaveAttribute(
    'href',
    '/client'
  );
  await expect(
    page.getByRole('link', {name: 'Switch to German'})
  ).toHaveAttribute('href', '/de');

  await page.goto('/en');
  await expect(page.getByRole('link', {name: /^Home$/})).toHaveAttribute(
    'href',
    '/'
  );
  await expect(page.getByRole('link', {name: 'Client page'})).toHaveAttribute(
    'href',
    '/client'
  );
  await expect(
    page.getByRole('link', {name: 'Switch to German'})
  ).toHaveAttribute('href', '/de');

  await page.goto('/de');
  await expect(page.getByRole('link', {name: /^Start$/})).toHaveAttribute(
    'href',
    '/de'
  );
  await expect(page.getByRole('link', {name: 'Client-Seite'})).toHaveAttribute(
    'href',
    '/de/client'
  );
  await expect(
    page.getByRole('link', {name: 'Zu Englisch wechseln'})
  ).toHaveAttribute('href', '/en');
});

it('supports a consistent `now` value across the server and client', async ({
  page
}) => {
  await page.goto('/en/client');

  const serverDate = await page.getByTestId('NowFromServer').textContent();
  const serverDateDelayed = await page
    .getByTestId('NowFromServerDelayed')
    .textContent();
  const clientDate = await page.getByTestId('NowFromClient').textContent();

  expect(serverDate).toBe(serverDateDelayed);
  expect(serverDate).toBe(clientDate);
});

it('can use `usePathname`', async ({page}) => {
  await page.goto('/client');
  await expect(page.getByTestId('UnlocalizedPathname')).toHaveText('/client');

  await page.goto('/en/client');
  await expect(page.getByTestId('UnlocalizedPathname')).toHaveText('/client');

  await page.goto('/de/client');
  await expect(page.getByTestId('UnlocalizedPathname')).toHaveText('/client');
});

it('can use `usePathname` to get internal pathnames', async ({page}) => {
  await page.goto('/de/verschachtelt');
  await expect(page.getByTestId('UnlocalizedPathname')).toHaveText('/nested');

  await page.goto('/en/nested');
  await expect(page.getByTestId('UnlocalizedPathname')).toHaveText('/nested');

  await page.goto('/ja//ネスト');
  await expect(page.getByTestId('UnlocalizedPathname')).toHaveText('/nested');
});

it('returns the correct value from `usePathname` in the initial render', async ({
  request
}) => {
  expect(await (await request.get('/client')).text()).toContain(
    '<p data-testid="UnlocalizedPathname">/client</p>'
  );
  expect(await (await request.get('/de/client')).text()).toContain(
    '<p data-testid="UnlocalizedPathname">/client</p>'
  );
});

it('can use `redirect` in Server Components', async ({page}) => {
  await page.goto('/redirect');
  await expect(page).toHaveURL('/client');

  await page.goto('/de/redirect');
  await expect(page).toHaveURL('/de/client');
});

it('can use `redirect` in Client Components', async ({page}) => {
  await page.goto('/client/redirect');
  await expect(page).toHaveURL('/client');

  await page.goto('/de/client/redirect');
  await expect(page).toHaveURL('/de/client');
});

it('can navigate between sibling pages that share a parent layout', async ({
  page
}) => {
  await page.goto('/nested');
  await page.getByRole('link', {name: 'Client page'}).click();
  await expect(page).toHaveURL('/client');
  await page.getByRole('link', {name: 'Nested page'}).click();
  await expect(page).toHaveURL('/nested');
});

it('prefixes routes as necessary with the router', async ({page}) => {
  await page.goto('/');
  await page.getByTestId('ClientRouter-link').click();
  await expect(page).toHaveURL('/nested');

  await page.goto('/en');
  await page.getByTestId('ClientRouter-link').click();
  await expect(page).toHaveURL('/nested');

  await page.goto('/de');
  await page.getByTestId('ClientRouter-link').click();
  await expect(page).toHaveURL('/de/verschachtelt');
});

it('can set `now` and `timeZone` at runtime', async ({page}) => {
  await page.setExtraHTTPHeaders({
    'x-now': '2020-01-01T00:00:00.000Z',
    'x-time-zone': 'Asia/Shanghai'
  });

  await page.goto('/en');
  const element = page.getByTestId('CurrentTime');
  await expect(element).toHaveText('Jan 1, 2020, 08:00 (Asia/Shanghai)');
});

it('automatically inherits a time zone and locale on the client side when using the provider in an RSC', async ({
  page
}) => {
  await page.goto('/client');
  await expect(page.getByTestId('TimeZone')).toHaveText('Europe/Vienna');
  await expect(page.getByTestId('Locale')).toHaveText('en');
});

it('keeps search params for directly matched pages', async ({page}) => {
  await page.goto('/de?param=true');
  await expect(page).toHaveURL('/de?param=true');
  await expect(page.getByTestId('SearchParams')).toHaveText(
    '{ "param": "true" }'
  );
});

it('keeps search params for rewrites', async ({page}) => {
  await page.goto('/?param=true');
  await expect(page).toHaveURL('/?param=true');
  await expect(page.getByTestId('SearchParams')).toHaveText(
    '{ "param": "true" }'
  );
});

it('keeps search params for redirects', async ({browser}) => {
  const context = await browser.newContext({locale: 'de-DE'});
  const page = await context.newPage();

  await page.goto('/?param=true');
  await expect(page).toHaveURL('/de?param=true');
  await expect(page.getByTestId('SearchParams')).toHaveText(
    '{ "param": "true" }'
  );
});

it('sets alternate links', async ({request}) => {
  async function getLinks(pathname: string) {
    return getAlternateLinks(await request.get(pathname));
  }

  for (const pathname of ['/', '/en', '/de']) {
    expect(await getLinks(pathname)).toEqual(
      expect.arrayContaining([
        '<http://localhost:3000/>; rel="alternate"; hreflang="en"',
        '<http://localhost:3000/de>; rel="alternate"; hreflang="de"',
        '<http://localhost:3000/spain>; rel="alternate"; hreflang="es"',
        '<http://localhost:3000/ja>; rel="alternate"; hreflang="ja"',
        '<http://localhost:3000/>; rel="alternate"; hreflang="x-default"'
      ])
    );
  }

  for (const pathname of ['/nested', '/en/nested', '/de/nested']) {
    expect(await getLinks(pathname)).toEqual(
      expect.arrayContaining([
        '<http://localhost:3000/nested>; rel="alternate"; hreflang="en"',
        '<http://localhost:3000/de/verschachtelt>; rel="alternate"; hreflang="de"',
        '<http://localhost:3000/spain/anidada>; rel="alternate"; hreflang="es"',
        '<http://localhost:3000/ja/%E3%83%8D%E3%82%B9%E3%83%88>; rel="alternate"; hreflang="ja"',
        '<http://localhost:3000/nested>; rel="alternate"; hreflang="x-default"'
      ])
    );
  }
});

it('can use rewrites to localize pathnames', async ({page}) => {
  await page.goto('/de/verschachtelt');
  await expect(page.getByRole('heading', {name: 'Verschachtelt'})).toBeVisible();

  // Dynamic params
  await page.goto('/en/news/3');
  await expect(page).toHaveURL('/news/3');
  await expect(page.getByRole('heading', {name: 'News article #3'})).toBeVisible();
  await page.goto('/de/neuigkeiten/3');
  await expect(page).toHaveURL('/de/neuigkeiten/3');
  await expect(page.getByRole('heading', {name: 'News-Artikel #3'})).toBeVisible();

  // Automatic redirects
  await page.goto('/de/nested');
  await expect(page).toHaveURL('/de/verschachtelt');
  await expect(page.getByRole('heading', {name: 'Verschachtelt'})).toBeVisible();
  await page.goto('/en/verschachtelt');
  await expect(page).toHaveURL('/nested');
  await expect(page.getByRole('heading', {name: 'Nested'})).toBeVisible();
  await page.goto('/en/neuigkeiten/3');
  await expect(page).toHaveURL('/news/3');
  await expect(page.getByRole('heading', {name: 'News article #3'})).toBeVisible();
});

it('replaces invalid cookie locales', async ({page}) => {
  await page.setExtraHTTPHeaders({
    cookie: 'NEXT_LOCALE=zh'
  });
  await page.goto('/');
  await assertLocaleCookieValue(page, 'en');
});

it('can localize route handlers', async ({request}) => {
  // Default
  {
    const response = await request.get('/api?name=world');
    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data).toEqual({message: 'Hello world!'});
  }

  // German
  {
    const response = await request.get('/de/api?name=Welt');
    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data).toEqual({message: 'Hallo Welt!'});
  }
});

it('can use the formatter', async ({page}) => {
  await page.goto('/en');
  await expect(page.getByTestId('CurrentTimeRelative')).toHaveText('now');
  await expect(page.getByTestId('Number')).toHaveText('€23,102.00');
});

it('populates metadata', async ({page}) => {
  await page.goto('/en');
  await expect(page).toHaveTitle('next-intl example');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    'This is an example of using next-intl in the `app` directory.'
  );
  await expect(page.locator('meta[name="currentYear"]')).toHaveAttribute(
    'content',
    // The fixture formats the year in its Europe/Vienna time zone (upstream
    // uses the runner's local year, which differs around New Year).
    new Intl.DateTimeFormat('en', {year: 'numeric', timeZone: 'Europe/Vienna'}).format(
      new Date()
    )
  );
  await expect(page.locator('meta[name="timeZone"]')).toHaveAttribute(
    'content',
    'Europe/Vienna'
  );
});

it('supports opengraph images for the default locale', async ({
  page,
  request
}) => {
  await page.goto('/');
  const ogImage = await page
    .locator('meta[property="og:image"]')
    .getAttribute('content');
  expect(ogImage).toBeTruthy();
  const ogImageUrl = new URL(ogImage!);
  expect(ogImageUrl.pathname).toBe('/en/opengraph-image');
  const result = await request.get(ogImageUrl.pathname);
  expect(result.ok()).toBe(true);
});

it('supports opengraph images for a locale with a custom prefix', async ({
  page,
  request
}) => {
  await page.goto('/spain');
  const ogImage = await page
    .locator('meta[property="og:image"]')
    .getAttribute('content');
  expect(ogImage).toBeTruthy();
  const ogImageUrl = new URL(ogImage!);
  expect(ogImageUrl.pathname).toBe('/es/opengraph-image');
  const result = await request.get(ogImageUrl.pathname);
  expect(result.ok()).toBe(true);
});

it('can use async APIs in async components', async ({page}) => {
  await page.goto('/');

  const element1 = page.getByTestId('AsyncComponent');
  await expect(element1.getByText('AsyncComponent')).toBeVisible();
  expect(await element1.innerHTML()).toContain('This is a <b>rich</b> text.');
  await expect(element1.getByText('Markup with <b>bold content</b>')).toBeVisible();

  await expect(
    page.getByTestId('AsyncComponentWithoutNamespace').getByText('AsyncComponent')
  ).toBeVisible();

  await expect(
    page.getByTestId('AsyncComponentWithNamespaceAndLocale').getByText('AsyncComponent')
  ).toBeVisible();

  await expect(
    page.getByTestId('AsyncComponentWithoutNamespaceAndLocale').getByText('AsyncComponent')
  ).toBeVisible();
});

it('supports custom prefixes', async ({page}) => {
  await page.goto('/spain');
  await expect(page).toHaveURL('/spain');
  await expect(page.getByRole('heading', {name: 'Inicio'})).toBeVisible();

  await page.goto('/spain/anidada');
  await expect(page).toHaveURL('/spain/anidada');
  await expect(page.getByRole('heading', {name: 'Anidada'})).toBeVisible();
});

it('can use `getPahname` to define a canonical link', async ({page}) => {
  async function getCanonicalPathname() {
    const href = await page
      .locator('link[rel="canonical"]')
      .getAttribute('href');
    return new URL(href!).pathname;
  }

  await page.goto('/news/3');
  await expect(getCanonicalPathname()).resolves.toBe('/news/3');

  await page.goto('/de/neuigkeiten/3');
  await expect(getCanonicalPathname()).resolves.toBe('/de/neuigkeiten/3');
});

it('can define custom cookie options', async ({request}) => {
  const response = await request.get('/');
  expect(response.headers()['set-cookie']).toContain('Max-Age=17280000');
});

it('can use `t.has` in a Server Component', async ({page}) => {
  await page.goto('/');
  await expect(page.getByTestId('HasTitle')).toHaveText('true');
});

it('can render mdx content', async ({page}) => {
  await page.goto('/about');
  await page.getByRole('heading', {name: 'About'}).waitFor();

  await page.goto('/de/about');
  await page.getByRole('heading', {name: 'Über uns'}).waitFor();
});

it('can switch the locale with `useRouter`', async ({page}) => {
  await page.goto('/client');
  await page.getByRole('button', {name: 'Switch to de'}).click();
  await expect(page).toHaveURL('/de/client');
  await page.getByRole('button', {name: 'Switch to en'}).click();
  await expect(page).toHaveURL('/client');
});

it('can use additional rewrites in the middleware', async ({browser}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.context().addCookies([
    {
      name: 'v2',
      value: 'true',
      url: 'http://localhost'
    }
  ]);

  await page.goto('/about');
  await page.getByRole('heading', {name: 'About v2'}).waitFor();

  await page.goto('/de/about');
  await page.getByRole('heading', {name: 'About v2'}).waitFor();

  await context.close();
});

// https://github.com/radix-ui/primitives/issues/3165
it.skip('provides a `Link` that works with Radix Primitives', async ({
  page
}) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Toggle dropdown'}).click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByText('Link to about')).toBeFocused();
});

describe('encoding of non-ASCII characters in URLs', () => {
  it('renders a page with encoded characters in the pathname', async ({
    page
  }) => {
    await page.goto('/ja/' + encodeURIComponent('ネスト'));
    await expect(page).toHaveURL('/ja/%E3%83%8D%E3%82%B9%E3%83%88');
    await expect(page.getByRole('heading', {name: 'ネステッド'})).toBeVisible();
  });

  it('renders a page with non-encoded characters in the pathname', async ({
    page
  }) => {
    await page.goto('/ja/ネスト');
    await expect(page).toHaveURL('/ja/%E3%83%8D%E3%82%B9%E3%83%88');
    await expect(page.getByRole('heading', {name: 'ネステッド'})).toBeVisible();
  });

  it('can use `Link` to go to an encoded pathname', async ({page}) => {
    await page.goto('/ja/client');
    const link = page.getByRole('link', {name: 'Go to nested'});
    await expect(link).toHaveAttribute(
      'href',
      '/ja/%E3%83%8D%E3%82%B9%E3%83%88'
    );
    await link.click();
    await expect(page).toHaveURL('/ja/%E3%83%8D%E3%82%B9%E3%83%88');
    await expect(page.getByRole('heading', {name: 'ネステッド'})).toBeVisible();
  });

  it('can use `useRouter` to go to an encoded pathname', async ({page}) => {
    await page.goto('/ja/client');
    await page
      .getByRole('button', {name: 'Go to nested (with router)'})
      .click();
    await expect(page).toHaveURL('/ja/%E3%83%8D%E3%82%B9%E3%83%88');
    await expect(page.getByRole('heading', {name: 'ネステッド'})).toBeVisible();
  });
});

describe('server actions', () => {
  it('can use `getTranslations` in server actions', async ({page}) => {
    await page.goto('/actions');
    await page.getByPlaceholder('Enter a task').press('Enter');
    await page.getByText('Please enter a task.').waitFor();

    await page.goto('/de/actions');
    await page.getByPlaceholder('Geben Sie eine Aufgabe ein').press('Enter');
    await page.getByText('Bitte geben sie eine Aufgabe ein.').waitFor();
  });
});

describe('handling of foreign characters', () => {
  it('handles encoded search params', async ({page}) => {
    await page.goto('/ja?param=テスト');
    await expect(page).toHaveURL('/ja?param=テスト');
    await expect(page.getByTestId('SearchParams')).toHaveText(
      '{ "param": "テスト" }'
    );
  });

  it('handles decoded search params', async ({page}) => {
    await page.goto('/ja?param=%E3%83%86%E3%82%B9%E3%83%88');
    await expect(page).toHaveURL('/ja?param=テスト');
    await expect(page.getByTestId('SearchParams')).toHaveText(
      '{ "param": "テスト" }'
    );
  });

  it('handles encoded localized pathnames', async ({page}) => {
    await page.goto('/ja/ネスト');
    await expect(page).toHaveURL('/ja/ネスト');
    await expect(page.getByRole('heading', {name: 'ネステッド'})).toBeVisible();
    await expect(page.getByTestId('UnlocalizedPathname')).toHaveText('/nested');
  });

  it('handles decoded localized pathnames', async ({page}) => {
    await page.goto('/ja/%E3%83%8D%E3%82%B9%E3%83%88');
    await expect(page).toHaveURL('/ja/ネスト');
    await expect(page.getByRole('heading', {name: 'ネステッド'})).toBeVisible();
    await expect(page.getByTestId('UnlocalizedPathname')).toHaveText('/nested');
  });
});

// vinext: not in upstream. The request config reads the locale from
// `next/root-params`, so the background regeneration of a stale page must see
// the request's `[locale]`. Without it, the request config calls `notFound()`,
// the regeneration fails, and the stale page is never replaced.
it('regenerates a stale static page for its locale', async ({request}) => {
  async function readPage() {
    const response = await request.get('/de/isr');
    const html = await response.text();
    return {
      status: response.status(),
      locale: html.match(/data-testid="isr-locale">([^<]*)</)?.[1],
      renderedAt: html.match(/data-testid="isr-rendered-at">(\d+)</)?.[1]
    };
  }

  const initial = await readPage();
  expect(initial).toMatchObject({status: 200, locale: 'de'});

  // The page revalidates after 1 second. A regenerated entry has a new render
  // time.
  await expect
    .poll(async () => (await readPage()).renderedAt, {timeout: 15_000})
    .not.toBe(initial.renderedAt);
  expect(await readPage()).toMatchObject({status: 200, locale: 'de'});
});
