/**
 * Ecosystem integration tests — verifies popular third-party libraries
 * work correctly with vinext.
 *
 * Uses subprocess-based testing: starts Vite dev server as a child process,
 * waits for it to be ready, makes HTTP requests, and asserts SSR output.
 * This approach is necessary because the RSC module runner in programmatic
 * createServer() bypasses Vite's resolveId for `next` package resolution.
 *
 * Run with: npx vitest run tests/ecosystem.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const FIXTURES_DIR = path.resolve(__dirname, "..", "fixtures", "ecosystem");

/**
 * Start a Vite dev server as a child process and wait for it to be ready.
 */
async function startFixture(
  name: string,
  port: number,
): Promise<{
  process: ChildProcess;
  baseUrl: string;
  fetchPage: (pathname: string) => Promise<{ html: string; status: number }>;
}> {
  const root = path.join(FIXTURES_DIR, name);
  const baseUrl = `http://localhost:${port}`;

  const proc = spawn("npx", ["vite", "--port", String(port), "--strictPort"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  // Wait for the server to be ready
  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Fixture "${name}" did not start within 30s`));
    }, 30000);

    let output = "";
    const onData = (data: Buffer) => {
      output += data.toString();
      if (output.includes("ready in") || output.includes("Local:")) {
        clearTimeout(timeoutId);
        resolve();
      }
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
    proc.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeoutId);
        reject(
          new Error(`Fixture "${name}" exited with code ${code}: ${output}`),
        );
      }
    });
  });

  // Give the server a moment to be fully ready for requests
  await new Promise((r) => setTimeout(r, 500));

  async function fetchPage(pathname: string) {
    const res = await fetch(`${baseUrl}${pathname}`, {
      signal: AbortSignal.timeout(10000),
    });
    const html = await res.text();
    return { html, status: res.status };
  }

  return { process: proc, baseUrl, fetchPage };
}

function killProcess(proc: ChildProcess | null) {
  if (proc && !proc.killed) {
    proc.kill("SIGTERM");
  }
}

// ─── next-themes ──────────────────────────────────────────────────────────────
describe("next-themes", () => {
  let proc: ChildProcess | null = null;
  let fetchPage: (path: string) => Promise<{ html: string; status: number }>;

  beforeAll(async () => {
    const fixture = await startFixture("next-themes", 4400);
    proc = fixture.process;
    fetchPage = fixture.fetchPage;
  }, 30000);

  afterAll(() => killProcess(proc));

  it("renders SSR content", async () => {
    const { html, status } = await fetchPage("/");
    expect(status).toBe(200);
    expect(html).toContain("next-themes test");
    expect(html).toContain('data-testid="ssr-content"');
    expect(html).toContain("Server-rendered content");
  });

  it("injects theme detection script", async () => {
    const { html } = await fetchPage("/");
    expect(html).toContain("prefers-color-scheme");
    expect(html).toContain("localStorage");
  });

  it("sets html lang attribute", async () => {
    const { html } = await fetchPage("/");
    expect(html).toContain('<html lang="en"');
  });

  it("renders theme toggle buttons", async () => {
    const { html } = await fetchPage("/");
    expect(html).toContain('data-testid="theme-loading"');
  });
});

// ─── next-view-transitions ────────────────────────────────────────────────────
describe("next-view-transitions", () => {
  let proc: ChildProcess | null = null;
  let fetchPage: (path: string) => Promise<{ html: string; status: number }>;

  beforeAll(async () => {
    const fixture = await startFixture("next-view-transitions", 4401);
    proc = fixture.process;
    fetchPage = fixture.fetchPage;
  }, 30000);

  afterAll(() => killProcess(proc));

  it("renders home page with view transition styles", async () => {
    const { html, status } = await fetchPage("/");
    expect(status).toBe(200);
    expect(html).toContain("Home Page");
    expect(html).toContain("view-transition-name:title");
  });

  it("renders Link component from next-view-transitions", async () => {
    const { html } = await fetchPage("/");
    expect(html).toContain('data-testid="about-link"');
    expect(html).toContain('href="/about"');
  });

  it("renders about page", async () => {
    const { html, status } = await fetchPage("/about");
    expect(status).toBe(200);
    expect(html).toContain("About Page");
    expect(html).toContain("view-transition-name:title");
  });

  it("renders navigation links", async () => {
    const { html } = await fetchPage("/");
    expect(html).toContain('<a href="/">Home</a>');
    expect(html).toContain('<a href="/about">About</a>');
  });
});

// ─── nuqs ─────────────────────────────────────────────────────────────────────
describe("nuqs", () => {
  let proc: ChildProcess | null = null;
  let fetchPage: (path: string) => Promise<{ html: string; status: number }>;

  beforeAll(async () => {
    const fixture = await startFixture("nuqs", 4402);
    proc = fixture.process;
    fetchPage = fixture.fetchPage;
  }, 30000);

  afterAll(() => killProcess(proc));

  it("renders SSR content", async () => {
    const { html, status } = await fetchPage("/");
    expect(status).toBe(200);
    expect(html).toContain("nuqs test");
    expect(html).toContain('data-testid="ssr-content"');
  });

  it("renders search input with default value", async () => {
    const { html } = await fetchPage("/");
    expect(html).toContain('data-testid="search-input"');
    expect(html).toContain('placeholder="Type a query..."');
  });

  it("renders default query state", async () => {
    const { html } = await fetchPage("/");
    expect(html).toContain("(empty)");
    expect(html).toContain("Page:");
  });

  it("renders pagination buttons", async () => {
    const { html } = await fetchPage("/");
    expect(html).toContain('data-testid="prev-page"');
    expect(html).toContain('data-testid="next-page"');
  });
});
