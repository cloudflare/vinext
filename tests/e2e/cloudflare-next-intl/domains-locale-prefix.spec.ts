// Ported from next-intl: examples/example-app-router-playground/tests/domains-locale-prefix.spec.ts
// https://github.com/amannn/next-intl/blob/main/examples/example-app-router-playground/tests/domains-locale-prefix.spec.ts
// Runs against a Cloudflare production build of tests/fixtures/cf-next-intl with
// NEXT_PUBLIC_USE_CASE=domains-locale-prefix.
import {
  type Browser,
  type Response,
  chromium,
  expect,
  test as it
} from '@playwright/test';
import {getPort} from './utils';

function getAlternateLinks(response: Response) {
  return response
    .headers()
    .link.split(', ')
    .map((cur) => cur.replace(/0\.0\.0\.0/g, 'localhost'))
    .map((cur) => cur.replace(/localhost:\d{4}/g, 'localhost:3000'));
}

function createBrowser(...domains: string[]) {
  return chromium.launch({
    args: [
      '--host-resolver-rules=' +
        domains
          .map((domain) => 'MAP ' + domain + ' 127.0.0.1:' + getPort())
          .join(',')
    ]
  });
}

function createPage(browser: Browser, acceptLanguage: string) {
  return browser.newPage().then(async (page) => {
    await page.route('**/*', (route) =>
      route.continue({
        headers: {
          'accept-language': acceptLanguage,
          'x-forwarded-port': '80'
        }
      })
    );
    return page;
  });
}

it.describe('never.example.com (localePrefix: never)', () => {
  let browser: Browser;

  it.beforeAll(async () => {
    browser = await createBrowser('never.example.com');
  });

  it.afterAll(async () => {
    await browser.close();
  });

  it('serves pages without locale prefix', async () => {
    const page = await createPage(browser, 'nl');

    await page.goto('http://never.example.com');
    await expect(page).toHaveURL('http://never.example.com');
    await expect(page.getByRole('heading', {name: 'Home'})).toBeVisible();

    await page.getByRole('link', {name: 'Client pagina'}).click();
    await expect(page).toHaveURL('http://never.example.com/client');

    await page.close();
  });

  it('handles localized pathnames without prefix', async () => {
    const page = await createPage(browser, 'nl');

    await page.goto('http://never.example.com/genest');
    await expect(page).toHaveURL('http://never.example.com/genest');
    await expect(page.getByRole('heading', {name: 'Genest'})).toBeVisible();

    await page.close();
  });

  it('generates Link hrefs without locale prefix', async () => {
    const page = await createPage(browser, 'nl');

    await page.goto('http://never.example.com');
    await expect(
      page.getByRole('link', {name: 'Home', exact: true})
    ).toHaveAttribute('href', '/');
    await expect(
      page.getByRole('link', {name: 'Client pagina'})
    ).toHaveAttribute('href', '/client');
    await expect(
      page.getByRole('link', {name: 'Geneste pagina'})
    ).toHaveAttribute('href', '/genest');

    await page.close();
  });

  it('removes a superfluous locale prefix', async () => {
    const page = await createPage(browser, 'nl');

    await page.goto('http://never.example.com/nl');
    await expect(page).toHaveURL('http://never.example.com');

    await page.goto('http://never.example.com/nl/genest');
    await expect(page).toHaveURL('http://never.example.com/genest');

    await page.close();
  });

  it('removes a superfluous locale prefix and preserves query strings', async () => {
    const page = await createPage(browser, 'nl');

    await page.goto('http://never.example.com/nl?foo=bar');
    await expect(page).toHaveURL('http://never.example.com?foo=bar');

    await page.goto('http://never.example.com/nl/genest?a=1&b=2');
    await expect(page).toHaveURL('http://never.example.com/genest?a=1&b=2');

    await page.close();
  });

  it('returns unlocalized pathname from usePathname', async () => {
    const page = await createPage(browser, 'nl');

    await page.goto('http://never.example.com/client');
    await expect(page.getByTestId('UnlocalizedPathname')).toHaveText('/client');

    await page.goto('http://never.example.com/genest');
    await expect(page.getByTestId('UnlocalizedPathname')).toHaveText('/nested');

    await page.close();
  });

  it('does not set alternate links header', async () => {
    const page = await createPage(browser, 'nl');

    const response = await page.goto('http://never.example.com');
    expect(response!.headers().link ?? '').not.toContain('hreflang');

    const response2 = await page.goto('http://never.example.com/genest');
    expect(response2!.headers().link ?? '').not.toContain('hreflang');

    await page.close();
  });

  it('handles requests for unsupported locales', async () => {
    const page = await createPage(browser, 'en');

    // never.example.com only supports nl — requesting with accept-language: en
    // should still serve content (falls back to domain default locale nl)
    await page.goto('http://never.example.com');
    await expect(page).toHaveURL('http://never.example.com');
    await expect(page.getByRole('heading', {name: 'Home'})).toBeVisible();

    await page.close();
  });
});

it.describe('always.example.com (localePrefix: always)', () => {
  let browser: Browser;

  it.beforeAll(async () => {
    browser = await createBrowser('always.example.com');
  });

  it.afterAll(async () => {
    await browser.close();
  });

  it('redirects to add locale prefix', async () => {
    const page = await createPage(browser, 'de');

    await page.goto('http://always.example.com');
    await expect(page).toHaveURL('http://always.example.com/de');
    await expect(page.getByRole('heading', {name: 'Start'})).toBeVisible();

    await page.close();
  });

  it('serves non-default locale with prefix', async () => {
    const page = await createPage(browser, 'de');

    await page.goto('http://always.example.com/de');
    await page.getByRole('link', {name: 'Zu Englisch wechseln'}).click();
    await expect(page).toHaveURL('http://always.example.com/en');
    await expect(page.getByRole('heading', {name: 'Home'})).toBeVisible();

    await page.close();
  });

  it('handles localized pathnames with prefix', async () => {
    const page = await createPage(browser, 'de');

    await page.goto('http://always.example.com/de/verschachtelt');
    await expect(page).toHaveURL('http://always.example.com/de/verschachtelt');
    await expect(
      page.getByRole('heading', {name: 'Verschachtelt'})
    ).toBeVisible();

    await page.goto('http://always.example.com/en/nested');
    await expect(page).toHaveURL('http://always.example.com/en/nested');
    await expect(page.getByRole('heading', {name: 'Nested'})).toBeVisible();

    await page.close();
  });

  it('generates Link hrefs with locale prefix', async () => {
    const page = await createPage(browser, 'de');

    await page.goto('http://always.example.com');
    await expect(page.getByRole('link', {name: 'Start'})).toHaveAttribute(
      'href',
      '/de'
    );
    await expect(
      page.getByRole('link', {name: 'Client-Seite'})
    ).toHaveAttribute('href', '/de/client');
    await expect(
      page.getByRole('link', {name: 'Verschachtelte Seite'})
    ).toHaveAttribute('href', '/de/verschachtelt');

    // Switch to non-default locale
    await page.getByRole('link', {name: 'Zu Englisch wechseln'}).click();
    await expect(page).toHaveURL('http://always.example.com/en');
    await expect(
      page.getByRole('link', {name: 'Home', exact: true})
    ).toHaveAttribute('href', '/en');
    await expect(page.getByRole('link', {name: 'Nested page'})).toHaveAttribute(
      'href',
      '/en/nested'
    );

    await page.close();
  });

  it('redirects to add prefix when missing', async () => {
    const page = await createPage(browser, 'de');

    await page.goto('http://always.example.com');
    await expect(page).toHaveURL('http://always.example.com/de');

    await page.goto('http://always.example.com/verschachtelt');
    await expect(page).toHaveURL('http://always.example.com/de/verschachtelt');

    await page.close();
  });

  it('preserves query strings on redirect', async () => {
    const page = await createPage(browser, 'de');

    await page.goto('http://always.example.com?foo=bar');
    await expect(page).toHaveURL('http://always.example.com/de?foo=bar');

    await page.close();
  });

  it('returns unlocalized pathname from usePathname', async () => {
    const page = await createPage(browser, 'de');

    await page.goto('http://always.example.com/de/client');
    await expect(page.getByTestId('UnlocalizedPathname')).toHaveText('/client');

    await page.goto('http://always.example.com/de/verschachtelt');
    await expect(page.getByTestId('UnlocalizedPathname')).toHaveText('/nested');

    await page.goto('http://always.example.com/en/nested');
    await expect(page.getByTestId('UnlocalizedPathname')).toHaveText('/nested');

    await page.close();
  });

  it('sets alternate links with locale prefixes', async () => {
    const page = await createPage(browser, 'de');

    const response = await page.goto('http://always.example.com');
    const links = getAlternateLinks(response!);
    expect(links).toContain(
      '<http://always.example.com/de>; rel="alternate"; hreflang="de"'
    );
    expect(links).toContain(
      '<http://always.example.com/en>; rel="alternate"; hreflang="en"'
    );

    await page.close();
  });

  it('sets alternate links for localized pathnames', async () => {
    const page = await createPage(browser, 'de');

    const response = await page.goto(
      'http://always.example.com/de/verschachtelt'
    );
    const links = getAlternateLinks(response!);
    expect(links).toContain(
      '<http://always.example.com/de/verschachtelt>; rel="alternate"; hreflang="de"'
    );
    expect(links).toContain(
      '<http://always.example.com/en/nested>; rel="alternate"; hreflang="en"'
    );

    await page.close();
  });
});

it.describe('as-needed.example.com (localePrefix: as-needed)', () => {
  let browser: Browser;

  it.beforeAll(async () => {
    browser = await createBrowser('as-needed.example.com');
  });

  it.afterAll(async () => {
    await browser.close();
  });

  it('serves default locale without prefix', async () => {
    const page = await createPage(browser, 'ja');

    await page.goto('http://as-needed.example.com');
    await expect(page).toHaveURL('http://as-needed.example.com');
    await expect(page.getByRole('heading', {name: 'Home (ja)'})).toBeVisible();

    await page.close();
  });

  it('serves non-default locale with custom prefix', async () => {
    const page = await createPage(browser, 'ja');

    await page.goto('http://as-needed.example.com');
    await page.getByRole('link', {name: 'Switch to Spanish'}).click();
    await expect(page).toHaveURL('http://as-needed.example.com/spain');
    await expect(page.getByRole('heading', {name: 'Inicio'})).toBeVisible();

    await page.close();
  });

  it('handles localized pathnames', async () => {
    const page = await createPage(browser, 'ja');

    await page.goto('http://as-needed.example.com/ネスト');
    await expect(page).toHaveURL('http://as-needed.example.com/ネスト');
    await expect(page.getByRole('heading', {name: 'ネステッド'})).toBeVisible();

    await page.goto('http://as-needed.example.com/spain/anidada');
    await expect(page).toHaveURL('http://as-needed.example.com/spain/anidada');
    await expect(page.getByRole('heading', {name: 'Anidada'})).toBeVisible();

    await page.close();
  });

  it('generates Link hrefs respecting prefix rules', async () => {
    const page = await createPage(browser, 'ja');

    await page.goto('http://as-needed.example.com');

    // Default locale links — no prefix
    await expect(
      page.getByRole('link', {name: '家', exact: true})
    ).toHaveAttribute('href', '/');
    await expect(
      page.getByRole('link', {name: 'ネストされたページ'})
    ).toHaveAttribute('href', '/%E3%83%8D%E3%82%B9%E3%83%88');

    // Switch to non-default locale — custom prefix
    await page.getByRole('link', {name: 'Switch to Spanish'}).click();
    await expect(page).toHaveURL('http://as-needed.example.com/spain');
    await expect(page.getByRole('link', {name: 'Inicio'})).toHaveAttribute(
      'href',
      '/spain'
    );
    await expect(
      page.getByRole('link', {name: 'Página anidada'})
    ).toHaveAttribute('href', '/spain/anidada');

    await page.close();
  });

  it('redirects default locale prefix away', async () => {
    const page = await createPage(browser, 'ja');

    await page.goto('http://as-needed.example.com/ja');
    await expect(page).toHaveURL('http://as-needed.example.com');

    await page.close();
  });

  it('redirects non-default locale to add prefix', async () => {
    const page = await createPage(browser, 'es');

    await page.goto('http://as-needed.example.com');
    await expect(page).toHaveURL('http://as-needed.example.com/spain');

    await page.close();
  });

  it('preserves query strings on redirect', async () => {
    const page = await createPage(browser, 'ja');

    await page.goto('http://as-needed.example.com/ja?foo=bar');
    await expect(page).toHaveURL('http://as-needed.example.com?foo=bar');

    await page.close();
  });

  it('returns unlocalized pathname from usePathname', async () => {
    const page = await createPage(browser, 'ja');

    await page.goto('http://as-needed.example.com/client');
    await expect(page.getByTestId('UnlocalizedPathname')).toHaveText('/client');

    await page.goto('http://as-needed.example.com/ネスト');
    await expect(page.getByTestId('UnlocalizedPathname')).toHaveText('/nested');

    await page.goto('http://as-needed.example.com/spain/client');
    await expect(page.getByTestId('UnlocalizedPathname')).toHaveText('/client');

    await page.goto('http://as-needed.example.com/spain/anidada');
    await expect(page.getByTestId('UnlocalizedPathname')).toHaveText('/nested');

    await page.close();
  });

  it('sets alternate links respecting prefix rules', async () => {
    const page = await createPage(browser, 'ja');

    const response = await page.goto('http://as-needed.example.com');
    const links = getAlternateLinks(response!);
    expect(links).toContain(
      '<http://as-needed.example.com/>; rel="alternate"; hreflang="ja"'
    );
    expect(links).toContain(
      '<http://as-needed.example.com/spain>; rel="alternate"; hreflang="es"'
    );

    await page.close();
  });

  it('sets alternate links for localized pathnames', async () => {
    const page = await createPage(browser, 'ja');

    const response = await page.goto('http://as-needed.example.com/ネスト');
    const links = getAlternateLinks(response!);
    expect(links).toContain(
      '<http://as-needed.example.com/%E3%83%8D%E3%82%B9%E3%83%88>; rel="alternate"; hreflang="ja"'
    );
    expect(links).toContain(
      '<http://as-needed.example.com/spain/anidada>; rel="alternate"; hreflang="es"'
    );

    await page.close();
  });

  it('handles custom prefix for navigation and nested pages', async () => {
    const page = await createPage(browser, 'es');

    await page.goto('http://as-needed.example.com');
    await expect(page).toHaveURL('http://as-needed.example.com/spain');
    await expect(page.getByRole('heading', {name: 'Inicio'})).toBeVisible();

    await page.getByRole('link', {name: 'Página anidada'}).click();
    await expect(page).toHaveURL('http://as-needed.example.com/spain/anidada');
    await expect(page.getByRole('heading', {name: 'Anidada'})).toBeVisible();

    await expect(page.getByRole('link', {name: 'Inicio'})).toHaveAttribute(
      'href',
      '/spain'
    );

    await page.close();
  });
});

it.describe('cross-domain navigation', () => {
  let browser: Browser;

  it.beforeAll(async () => {
    browser = await createBrowser(
      'never.example.com',
      'always.example.com',
      'as-needed.example.com'
    );
  });

  it.afterAll(async () => {
    await browser.close();
  });

  it('navigates between domains with different localePrefix modes', async () => {
    const page = await createPage(browser, 'nl');

    await page.goto('http://never.example.com');
    await expect(page).toHaveURL('http://never.example.com');
    await expect(page.getByRole('heading', {name: 'Home'})).toBeVisible();

    // Switch accept-language for always domain
    await page.route('**/*', (route) =>
      route.continue({
        headers: {
          'accept-language': 'de',
          'x-forwarded-port': '80'
        }
      })
    );
    await page.goto('http://always.example.com');
    await expect(page).toHaveURL('http://always.example.com/de');
    await expect(page.getByRole('heading', {name: 'Start'})).toBeVisible();

    // Switch accept-language for as-needed domain
    await page.route('**/*', (route) =>
      route.continue({
        headers: {
          'accept-language': 'ja',
          'x-forwarded-port': '80'
        }
      })
    );
    await page.goto('http://as-needed.example.com');
    await expect(page).toHaveURL('http://as-needed.example.com');
    await expect(page.getByRole('heading', {name: 'Home (ja)'})).toBeVisible();

    await page.close();
  });
});
