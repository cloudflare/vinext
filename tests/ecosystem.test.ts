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
import { readFileSync } from "node:fs";
import path from "node:path";

const FIXTURES_DIR = path.resolve(__dirname, "fixtures", "ecosystem");

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
    detached: process.platform !== "win32",
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
        reject(new Error(`Fixture "${name}" exited with code ${code}: ${output}`));
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
  if (!proc || proc.killed) {
    return;
  }

  if (process.platform === "win32") {
    try {
      proc.kill("SIGTERM");
    } catch {
      return;
    }
    return;
  }

  const pid = proc.pid;
  if (pid == null) {
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
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
  const fixtureRoot = path.join(FIXTURES_DIR, "nuqs");

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

  it("prebundles next/navigation.js imports against vinext shims", async () => {
    await fetchPage("/");

    const depsDir = path.join(fixtureRoot, "node_modules", ".vite", "deps");
    const metadata = JSON.parse(readFileSync(path.join(depsDir, "_metadata.json"), "utf8")) as {
      optimized?: Record<string, { file?: string }>;
    };
    const optimizedAdapterFile = metadata.optimized?.["nuqs/adapters/next/app"]?.file;

    expect(optimizedAdapterFile).toBeDefined();

    const optimizedAdapter = readFileSync(path.join(depsDir, optimizedAdapterFile!), "utf8");

    expect(optimizedAdapter).toMatch(/shims\/navigation\.js/);
    expect(optimizedAdapter).not.toContain("node_modules/.pnpm/next@");
  });
});

// ─── next-intl ───────────────────────────────────────────────────────────────
describe("next-intl", () => {
  let proc: ChildProcess | null = null;
  let fetchPage: (path: string) => Promise<{ html: string; status: number }>;

  beforeAll(async () => {
    const fixture = await startFixture("next-intl", 4403);
    proc = fixture.process;
    fetchPage = fixture.fetchPage;
  }, 30000);

  afterAll(() => killProcess(proc));

  it("renders English SSR content", async () => {
    const { html, status } = await fetchPage("/en");
    expect(status).toBe(200);
    expect(html).toContain('<html lang="en"');
    expect(html).toContain('data-testid="title"');
    expect(html).toContain("Hello World");
    expect(html).toContain("This page uses next-intl for internationalization.");
  });

  it("renders German SSR content", async () => {
    const { html, status } = await fetchPage("/de");
    expect(status).toBe(200);
    expect(html).toContain('<html lang="de"');
    expect(html).toContain('data-testid="title"');
    expect(html).toContain("Hallo Welt");
    expect(html).toContain("Diese Seite verwendet next-intl zur Internationalisierung.");
  });
});

// ─── better-auth ──────────────────────────────────────────────────────────────
describe("better-auth", () => {
  let proc: ChildProcess | null = null;
  let baseUrl: string;
  let fetchPage: (path: string) => Promise<{ html: string; status: number }>;

  /** Strip Set-Cookie attributes — keep only name=value pairs for Cookie header */
  function toCookieHeader(setCookies: string[]): string {
    return setCookies.map((c) => c.split(";")[0]).join("; ");
  }

  /** Sign up a user, return session cookies as a Cookie header string */
  async function signUpUser(email: string, password: string, name: string) {
    const res = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name }),
      signal: AbortSignal.timeout(10000),
    });
    return { res, cookieHeader: toCookieHeader(res.headers.getSetCookie()) };
  }

  function nextEmail(prefix: string) {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}@example.com`;
  }

  beforeAll(async () => {
    const fixture = await startFixture("better-auth", 4404);
    proc = fixture.process;
    baseUrl = fixture.baseUrl;
    fetchPage = fixture.fetchPage;
  }, 30000);

  afterAll(() => killProcess(proc));

  it("renders SSR content", async () => {
    const { html, status } = await fetchPage("/");
    expect(status).toBe(200);
    expect(html).toContain("better-auth test");
    expect(html).toContain('data-testid="ssr-content"');
  });

  it("renders client-side auth status component", async () => {
    const { html } = await fetchPage("/");
    // The AuthStatus client component should be SSR-rendered in its loading
    // or signed-out state
    expect(html).toMatch(/data-testid="auth-(loading|signed-out)"/);
  });

  it("auth API catch-all route responds to GET", async () => {
    // better-auth exposes GET /api/auth/get-session
    const res = await fetch(`${baseUrl}/api/auth/get-session`, {
      signal: AbortSignal.timeout(10000),
    });
    expect(res.status).toBe(200);
  });

  it("sign-up flow creates user and returns session", async () => {
    const email = nextEmail("signup-test");
    const { res } = await signUpUser(email, "password123456", "Signup Test");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.user).toBeDefined();
    expect(data.user.email).toBe(email);
    expect(data.user.name).toBe("Signup Test");
  });

  it("session is accessible after sign-in with cookie", async () => {
    // Create a user first (self-contained — no dependency on other tests)
    const email = nextEmail("signin-test");
    await signUpUser(email, "password123456", "Signin Test");

    // Sign in to get a session cookie
    const signinRes = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: "password123456",
      }),
      signal: AbortSignal.timeout(10000),
    });
    expect(signinRes.status).toBe(200);

    const cookieHeader = toCookieHeader(signinRes.headers.getSetCookie());

    // Fetch session using the cookie
    const sessionRes = await fetch(`${baseUrl}/api/auth/get-session`, {
      headers: { cookie: cookieHeader },
      signal: AbortSignal.timeout(10000),
    });
    expect(sessionRes.status).toBe(200);
    const session = await sessionRes.json();
    expect(session.user.email).toBe(email);
  });

  it("server component can access session via headers()", async () => {
    // Create and sign in a user (self-contained)
    const email = nextEmail("protected-test");
    await signUpUser(email, "password123456", "Protected Test");

    const signinRes = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: "password123456",
      }),
      signal: AbortSignal.timeout(10000),
    });
    const cookieHeader = toCookieHeader(signinRes.headers.getSetCookie());

    // Fetch the protected server component page with the session cookie.
    // This exercises: headers() shim -> auth.api.getSession() -> SSR render
    const res = await fetch(`${baseUrl}/protected`, {
      headers: { cookie: cookieHeader },
      signal: AbortSignal.timeout(15000),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="protected-heading"');
    expect(html).toContain(`Logged in as ${email}`);
  });
});

// ─── shadcn (radix-ui) ───────────────────────────────────────────────────────
describe("shadcn", () => {
  let proc: ChildProcess | null = null;
  let fetchPage: (path: string) => Promise<{ html: string; status: number }>;

  beforeAll(async () => {
    const fixture = await startFixture("shadcn", 4405);
    proc = fixture.process;
    fetchPage = fixture.fetchPage;
  }, 30000);

  afterAll(() => killProcess(proc));

  it("renders SSR content", async () => {
    const { html, status } = await fetchPage("/");
    expect(status).toBe(200);
    expect(html).toContain("shadcn test");
    expect(html).toContain('data-testid="ssr-content"');
    expect(html).toContain("Server-rendered content");
  });

  it("renders Button component with variants", async () => {
    const { html } = await fetchPage("/");
    expect(html).toContain('data-testid="default-button"');
    expect(html).toContain('data-testid="destructive-button"');
    expect(html).toContain('data-testid="outline-button"');
    expect(html).toContain('data-testid="secondary-button"');
    expect(html).toContain('data-testid="ghost-button"');
    expect(html).toContain('data-testid="link-button"');
  });

  it("renders Button as server component with @radix-ui/react-slot", async () => {
    const { html } = await fetchPage("/");
    // Button without "use client" renders directly as a <button> element
    // (not a client reference), proving @radix-ui/react-slot works in RSC
    expect(html).toContain("<button");
    expect(html).toContain("Default Button");
  });

  it("renders Dialog trigger from @radix-ui/react-dialog", async () => {
    const { html } = await fetchPage("/");
    expect(html).toContain('data-testid="dialog-trigger"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("Open Dialog");
  });

  it("renders DropdownMenu trigger from @radix-ui/react-dropdown-menu", async () => {
    const { html } = await fetchPage("/");
    expect(html).toContain('data-testid="dropdown-trigger"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("Open Menu");
  });
});

// ─── validator ──────────────────────────────────────────────────────────────

describe("validator", () => {
  let proc: ChildProcess | null = null;
  let fetchPage: (pathname: string) => Promise<{ html: string; status: number }>;

  beforeAll(async () => {
    const fixture = await startFixture("validator", 4405);
    proc = fixture.process;
    fetchPage = fixture.fetchPage;
  }, 30000);

  afterAll(() => killProcess(proc));

  it("can import and use validator/es/lib/isEmail.js in SSR", async () => {
    const { html, status } = await fetchPage("/");
    expect(status).toBe(200);
    expect(html).toContain("<h1>Validator Test</h1>");
    // React adds HTML comments for hydration markers, so check without whitespace sensitivity
    expect(html).toMatch(/Email:.*test@example\.com/);
    expect(html).toMatch(/Valid:.*true/);
  });
});
