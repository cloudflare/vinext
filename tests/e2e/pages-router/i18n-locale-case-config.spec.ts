import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";

// Unprefixed next.config.js rules are locale-aware, and Next.js detects the
// locale prefix case-insensitively (normalizeLocalePath). A mixed-case prefix
// such as /EN/ or /SV/ must therefore hit the same redirects, headers and
// rewrites as /en/ or /sv/ — otherwise changing the prefix casing serves the
// page while skipping the rules configured for it. Expected values were
// observed against real Next.js 16 with the same config.

const FIXTURE_DIR = `${process.cwd()}/tests/fixtures/pages-i18n-public-rewrite`;
const PORT = process.env.VINEXT_E2E_I18N_LOCALE_CASE_PORT ?? "4224";
const BASE_URL = `http://localhost:${PORT}`;

let server: ChildProcess;

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) {
      throw new Error(`i18n fixture server exited with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/en/about`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for i18n fixture server");
}

test.describe("i18n config rules with mixed-case locale prefixes", () => {
  test.beforeAll(async () => {
    server = spawn(
      `created_node_modules=0; if ! test -e node_modules && ! test -L node_modules; then ln -s ../pages-basic/node_modules node_modules; created_node_modules=1; fi; trap 'if test "$created_node_modules" = 1; then rm node_modules; fi' EXIT; npx vp dev --port ${PORT}`,
      {
        cwd: FIXTURE_DIR,
        // Own process group so afterAll can stop `vp dev`, not just the shell.
        detached: true,
        shell: true,
        stdio: "inherit",
      },
    );
    await waitForServer();
  });

  test.afterAll(async () => {
    if (server.pid) process.kill(-server.pid);
  });

  test("redirects() fires for mixed-case locale prefixes", async ({ request }) => {
    for (const [pathname, location] of [
      ["/locale-case-gated", "/about"],
      ["/en/locale-case-gated", "/about"],
      ["/EN/locale-case-gated", "/about"],
      ["/SV/locale-case-gated", "/SV/about"],
      ["/Sv/locale-case-gated", "/Sv/about"],
    ]) {
      const response = await request.get(`${BASE_URL}${pathname}`, { maxRedirects: 0 });
      expect(response.status(), pathname).toBe(307);
      expect(response.headers()["location"], pathname).toBe(location);
      expect(await response.text(), pathname).not.toContain("locale case gated content");
    }
  });

  test("redirects() with params after the locale segment fire for every locale", async ({
    request,
  }) => {
    for (const [pathname, location] of [
      ["/locale-param-gated/settings", "/about"],
      ["/en/locale-param-gated/settings", "/about"],
      ["/EN/locale-param-gated/settings", "/about"],
      ["/sv/locale-param-gated/settings", "/sv/about"],
      ["/SV/locale-param-gated/a/b", "/SV/about"],
      ["/nl/locale-param-gated/settings", "/nl/about"],
      ["/locale-param-gated", "/about"],
      ["/sv/locale-param-gated", "/sv/about"],
      ["/SV/locale-param-gated", "/SV/about"],
      // `locale: false` keeps the user-written `/:locale(en|sv)?` param as is.
      ["/locale-param-raw/x", "/about"],
      ["/en/locale-param-raw/x", "/about"],
      ["/sv/locale-param-raw/x", "/about"],
      ["/SV/locale-param-raw/x", "/about"],
      ["/sv/locale-param-raw", "/about"],
    ]) {
      const response = await request.get(`${BASE_URL}${pathname}`, { maxRedirects: 0 });
      expect(response.status(), pathname).toBe(307);
      expect(response.headers()["location"], pathname).toBe(location);
      expect(await response.text(), pathname).not.toContain("locale param");

      const authed = await request.get(`${BASE_URL}${pathname}`, {
        headers: { cookie: "session=1" },
        maxRedirects: 0,
      });
      expect(authed.status(), pathname).toBe(200);
    }

    // `nl` is outside the user-written alternation.
    const unmatched = await request.get(`${BASE_URL}/nl/locale-param-raw/x`, { maxRedirects: 0 });
    expect(unmatched.status()).toBe(200);
    expect(await unmatched.text()).toContain("locale param raw content");
  });

  test("headers() applies to mixed-case locale prefixes", async ({ request }) => {
    for (const pathname of ["/about", "/en/about", "/EN/about", "/SV/about", "/NL/about"]) {
      const response = await request.get(`${BASE_URL}${pathname}`, { maxRedirects: 0 });
      expect(response.status(), pathname).toBe(200);
      expect(response.headers()["x-locale-case-header"], pathname).toBe("about");
      expect(await response.text(), pathname).toContain("about page");
    }
  });

  test("headers() negative lookaheads skip the locale prefix and apply once", async ({
    request,
  }) => {
    // Next.js matches header rules only in their `/:nextInternalLocale(...)`
    // form against the default-locale-prefixed path, so the lookahead sees
    // `api/hello` rather than `sv/api/hello`, and `/about` matches once.
    // `/` becomes `/en`, which `/((?!api).*)` does not match. Expected values
    // were observed against real Next.js 16.2.7 with the same rule.
    const lookaheadHeaders = async (pathname: string) => {
      const response = await request.get(`${BASE_URL}${pathname}?locale-lookahead=1`, {
        maxRedirects: 0,
      });
      const values = (name: string) =>
        response
          .headersArray()
          .filter((header) => header.name.toLowerCase() === name)
          .map((header) => header.value);
      return {
        cookies: values("set-cookie").filter((value) => value.startsWith("locale-lookahead=")),
        header: response.headers()["x-locale-lookahead-header"],
        status: response.status(),
      };
    };

    for (const pathname of ["/about", "/en/about", "/sv/about", "/SV/about"]) {
      const { cookies, header, status } = await lookaheadHeaders(pathname);
      expect(status, pathname).toBe(200);
      expect(header, pathname).toBe("page");
      expect(cookies, pathname).toEqual(["locale-lookahead=1"]);
    }
    for (const pathname of ["/", "/api/hello", "/en/api/hello", "/sv/api/hello"]) {
      const { cookies, header } = await lookaheadHeaders(pathname);
      expect(header, pathname).toBeUndefined();
      expect(cookies, pathname).toEqual([]);
    }
  });

  test("rewrites() applies to mixed-case locale prefixes", async ({ request }) => {
    for (const pathname of [
      "/locale-case-rewrite",
      "/EN/locale-case-rewrite",
      "/SV/locale-case-rewrite",
    ]) {
      const response = await request.get(`${BASE_URL}${pathname}`, { maxRedirects: 0 });
      expect(response.status(), pathname).toBe(200);
      expect(await response.text(), pathname).toContain("about page");
    }
  });

  // Next.js's processRoutes keeps only the localized variants of a redirect or
  // rewrite, matched against the default-locale-prefixed path: the lookahead
  // sees `api/hello` for `/api/hello` and `/sv/api/hello`, and other paths
  // match once. Expected values were observed against real Next.js 16.2.7
  // with the same rules (which 404s locale-prefixed API paths; vinext serves
  // them, so only the absence of the redirect/rewrite is asserted there).
  test("redirects() negative lookaheads skip the locale prefix", async ({ request }) => {
    for (const [pathname, location] of [
      ["/after-control", "/about?lookahead-redirect=1"],
      ["/en/after-control", "/about?lookahead-redirect=1"],
      ["/sv/after-control", "/sv/about?lookahead-redirect=1"],
      ["/api/hello", undefined],
      ["/en/api/hello", undefined],
      ["/sv/api/hello", undefined],
    ]) {
      const response = await request.get(`${BASE_URL}${pathname}?lookahead-redirect=1`, {
        maxRedirects: 0,
      });
      expect(response.headers()["location"], pathname).toBe(location);
      if (location) expect(response.status(), pathname).toBe(307);
      else expect(await response.text(), pathname).not.toContain("about page");
    }
    const api = await request.get(`${BASE_URL}/api/hello?lookahead-redirect=1`);
    expect(await api.text()).toBe("hello from api");
  });

  test("rewrites() negative lookaheads skip the locale prefix", async ({ request }) => {
    for (const [pathname, body] of [
      ["/missing-page", "afterFiles page wins"],
      ["/en/missing-page", "afterFiles page wins"],
      ["/sv/missing-page", "afterFiles page wins"],
      ["/about", "about page"],
      ["/en/about", "about page"],
      ["/sv/about", "about page"],
      ["/api/hello", "hello from api"],
    ]) {
      const response = await request.get(`${BASE_URL}${pathname}?lookahead-rewrite=1`, {
        maxRedirects: 0,
      });
      expect(response.status(), pathname).toBe(200);
      expect(await response.text(), pathname).toContain(body);
    }
    for (const pathname of ["/en/api/hello", "/sv/api/hello"]) {
      const response = await request.get(`${BASE_URL}${pathname}?lookahead-rewrite=1`, {
        maxRedirects: 0,
      });
      expect(await response.text(), pathname).not.toContain("afterFiles page wins");
    }
  });

  // Observed against real Next.js 16.2.7, like the file-looking source below.
  test("rewrites() catch-alls do not match /_next paths", async ({ request }) => {
    const asset = await request.get(`${BASE_URL}/_next/static/missing.js?catch-all-rewrite=1`, {
      maxRedirects: 0,
    });
    expect(asset.status()).toBe(404);
    expect(await asset.text()).not.toContain("about page");

    const page = await request.get(`${BASE_URL}/sv/missing-page?catch-all-rewrite=1`, {
      maxRedirects: 0,
    });
    expect(page.status()).toBe(200);
    expect(await page.text()).toContain("about page");
  });

  test("rewrites() with a file-looking source match default-locale paths in dev", async ({
    request,
  }) => {
    for (const pathname of [
      "/locale-dotted.xml",
      "/en/locale-dotted.xml",
      "/sv/locale-dotted.xml",
    ]) {
      const response = await request.get(`${BASE_URL}${pathname}`, { maxRedirects: 0 });
      expect(response.status(), pathname).toBe(200);
      expect(await response.text(), pathname).toContain("about page");
    }
  });
});
