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

  test("headers() applies to mixed-case locale prefixes", async ({ request }) => {
    for (const pathname of ["/about", "/en/about", "/EN/about", "/SV/about", "/NL/about"]) {
      const response = await request.get(`${BASE_URL}${pathname}`, { maxRedirects: 0 });
      expect(response.status(), pathname).toBe(200);
      expect(response.headers()["x-locale-case-header"], pathname).toBe("about");
      expect(await response.text(), pathname).toContain("about page");
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
});
